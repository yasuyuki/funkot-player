//! funkot-player: drives funkot-core's auto-DJ engine from a Tauri app.
//!
//! Still minimal: no library UI. The playback queue (`queue.rs`) is wired to
//! the engine, and its contents survive a restart via `store.rs`.

mod queue;
mod store;

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use funkot_core::engine::{
    prepare_tracks_parallel, Engine, EngineEvent, NavAction, PreparedTrack,
};
use funkot_core::EngineOptions;

use queue::{DrainPolicy, HostSource, QueueEdit, SharedQueue};

/// Global handle to the running engine's playback controls.
///
/// Notification-button JNI callbacks (`onNativeControl`) do not go through
/// Tauri, so they cannot reach a `tauri::State`; this is set once, from the
/// audio thread, before the `Engine` moves into the cpal callback closure.
struct Playback {
    paused: Arc<AtomicBool>,
    nav_tx: SyncSender<NavAction>,
    /// Shared with the cpal callback so Tauri commands can install / clear an
    /// audition `Engine` without touching the main one.
    render: Arc<Mutex<RenderState>>,
    sample_rate: u32,
}

static PLAYBACK: OnceLock<Playback> = OnceLock::new();

/// The data dir `resolve_dirs` resolved, for the handful of save paths that
/// have no `tauri::AppHandle` to resolve it themselves: `flip_paused`
/// (shared with the Android notification's JNI callback), `events_thread`,
/// and the loader's `on_reserved` observer inside `audio_thread`. Everything
/// else still calls `resolve_dirs(app)` directly and ignores this.
///
/// Set from `start_impl` right after it resolves `data`, and again from
/// `run()`'s `setup` (before `start_impl` ever runs, for the startup
/// preload) — `OnceLock` makes the second `set` a harmless no-op. A command
/// that runs before either has (there should be none, but nothing enforces
/// it) finds this empty and just skips saving; see `persist_session`.
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Live copy of `settings.json`'s `allow_non_funkot`. Folder drain reads this
/// on the loader thread; `set_allow_non_funkot` updates it without restart.
static ALLOW_NON_FUNKOT: AtomicBool = AtomicBool::new(false);

/// True while an audition `Engine` is installed in [`RenderState::audition`].
/// `events_thread` uses this only to drop stale audition-tagged events after
/// resume; origin itself comes from the event payload's `audition` flag.
static AUDITIONING: AtomicBool = AtomicBool::new(false);

/// True from mute-for-audition until `install_audition` finishes (or prepare
/// fails). Covers the gap where the main queue is silenced but [`AUDITIONING`]
/// is still false — pause transport must stay rejected in that window too.
static AUDITION_PREPARING: AtomicBool = AtomicBool::new(false);

/// Volatile audition session (no persistence). `pair` survives `resume_autodj`
/// so 「もう一度聴く」 can re-run after returning to the main engine.
/// `parked_*` snapshot [`NOW`] across an audition so resume restores the
/// main-engine titles (audition events otherwise overwrite them).
struct AuditionSession {
    pair: Option<(PathBuf, PathBuf)>,
    parked_now: Option<PathBuf>,
    parked_previous: Option<PathBuf>,
    parked_in_progress: Option<(PathBuf, PathBuf, Origin, u64)>,
    /// [`NowTracker::now_started_frames`] at park time. `MAIN_FRAMES` freezes
    /// for the whole audition (it only advances for the main engine), so
    /// restoring this on resume is what makes `position_secs` pick up again
    /// from where the listener left off instead of jumping or going stale.
    parked_now_started_frames: Option<u64>,
}

static AUDITION_SESSION: Mutex<AuditionSession> = Mutex::new(AuditionSession {
    pair: None,
    parked_now: None,
    parked_previous: None,
    parked_in_progress: None,
    parked_now_started_frames: None,
});

/// What the transport is doing, as the audio thread sees it. The webview polls
/// this rather than guessing from which commands it has sent, so the
/// notification's buttons and a stalled engine both show up in the UI.
///
/// Independent of `PLAYBACK`: `start()` needs to record `Starting` before the
/// audio thread exists to set `PLAYBACK`, so this cannot live inside it.
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum Phase {
    Idle = 0,
    Starting = 1,
    Playing = 2,
    Paused = 3,
    Stalled = 4,
    Failed = 5,
    /// The audio callback has stopped running (or the stream reported an
    /// error). `audio_thread` closes the stream and retries reopen until the
    /// device returns; see `CallbackWatch`. Distinct from `Stalled`, which
    /// means the callback is alive but has nothing prepared to play — here
    /// nothing is calling `render` at all any more.
    Disconnected = 6,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Starting => "starting",
            Phase::Playing => "playing",
            Phase::Paused => "paused",
            Phase::Stalled => "stalled",
            Phase::Failed => "failed",
            Phase::Disconnected => "disconnected",
        }
    }

    /// Unknown values fall back to `Idle` rather than panicking: this only
    /// ever decodes what `set_phase` itself wrote, but a `static` outliving a
    /// future refactor that adds a variant should not be able to crash a
    /// running app over a stale encoding.
    fn from_u8(v: u8) -> Phase {
        match v {
            1 => Phase::Starting,
            2 => Phase::Playing,
            3 => Phase::Paused,
            4 => Phase::Stalled,
            5 => Phase::Failed,
            6 => Phase::Disconnected,
            _ => Phase::Idle,
        }
    }
}

static PHASE: AtomicU8 = AtomicU8::new(Phase::Idle as u8);

fn set_phase(p: Phase) {
    PHASE.store(p as u8, Ordering::Relaxed);
}

fn get_phase() -> Phase {
    Phase::from_u8(PHASE.load(Ordering::Relaxed))
}

/// Flips a `Playback`'s paused flag and reports the new state. Shared between
/// `toggle_pause` (in-app button) and `onNativeControl` action 0 (the
/// notification's play/pause) so the two cannot drift on what pausing or
/// resuming does to `PHASE` — they used to duplicate this and disagree.
///
/// Pausing writes `Phase::Paused` here immediately — except when already
/// `Disconnected`: the flag still flips (so reconnect resumes paused), but
/// overwriting `PHASE` would briefly show `paused` in the UI until
/// `audio_thread`'s ~1s watchdog writes `Disconnected` back.
///
/// Resuming writes nothing to `PHASE`. If the callback is alive it publishes
/// `Playing`, `Starting`, or `Stalled` itself within about one buffer
/// (~21ms), and if it is not, `audio_thread`'s watchdog (`CallbackWatch`)
/// catches that within a few seconds and sets `Phase::Disconnected` (then
/// retries reopen). Writing `Playing` here would assert something nobody has
/// confirmed yet.
///
/// Also records the new state into `SESSION` and persists it — this is the
/// one place both `toggle_pause` (in-app) and the notification's JNI
/// callback flip pause, so it is the one place that needs to.
fn flip_paused(paused: &AtomicBool) -> bool {
    // fetch_xor(true) returns the *previous* value; the new state is its negation.
    let now_paused = !paused.fetch_xor(true, Ordering::Relaxed);
    if now_paused && get_phase() != Phase::Disconnected {
        set_phase(Phase::Paused);
    }
    {
        let mut session = SESSION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        session.paused = now_paused;
    }
    persist_session();
    now_paused
}

/// Pause/play transport is refused while auditioning or preparing an
/// audition — only 〔再開〕 returns. Pure so the guard is unit-testable
/// without `PLAYBACK` / Android JNI.
fn ensure_pause_allowed(auditioning: bool, preparing: bool) -> Result<(), String> {
    if auditioning || preparing {
        Err("audition in progress".into())
    } else {
        Ok(())
    }
}

/// Pack paused + phase for the Android `onNativeControl` JNI return value.
/// bit0 = paused; bits 1.. = `Phase as u8`. Must stay in lockstep with Kotlin.
#[cfg_attr(not(any(test, target_os = "android")), allow(dead_code))]
fn pack_native_control_state(paused: bool, phase: Phase) -> i32 {
    ((phase as i32) << 1) | (paused as i32)
}

/// Where the app keeps music, the analysis cache, and its own data, as
/// absolute paths.
///
/// All three directories exist by the time this is returned.
#[derive(serde::Serialize, Clone, Debug)]
struct AppDirs {
    /// Drop tracks here. On Android this is the app's external files dir, which
    /// shows up over MTP so a PC can copy into it.
    music_dir: String,
    /// `EngineOptions::cache_dir`. Must be absolute: the default in funkot-core
    /// is the relative `"funkot-cache"`.
    cache_dir: String,
    /// The queue and the hand-corrected bar counts (see `store`). Held apart
    /// from `cache_dir` because deleting the cache is a documented repair for
    /// bad analysis, and it must not take the listener's own work with it.
    data_dir: String,
    /// The `settings.json` value that produced `music_dir`, if any was set.
    /// `None` on a fresh install, after `reset_music_dir`, or always on
    /// Android (`music_dir_configurable` is `false` there). Distinct from
    /// `music_dir` itself: this is what the UI shows as "currently
    /// configured", which stays the listener's choice even when it could not
    /// be used this launch (see `music_dir_unavailable`).
    music_dir_custom: Option<String>,
    /// `true` when `music_dir_custom` was set but unusable this launch (could
    /// not be read), so `music_dir` fell back to the default. `settings.json`
    /// is left untouched in that case — see `resolve_music_dir`.
    music_dir_unavailable: bool,
    /// Whether `set_music_dir`/`reset_music_dir` can do anything on this
    /// platform. `true` on desktop, `false` on Android.
    music_dir_configurable: bool,
}

/// Ask Android for the app's own directories.
///
/// The paths are predictable (`/storage/emulated/0/Android/data/<pkg>/files/...`)
/// but hard-coding them does not work: a directory created from outside the app
/// — over adb or MTP — is owned by `shell:ext_data_rw`, and the app then cannot
/// even list it (`Permission denied`). `getExternalFilesDir` creates it with the
/// right ownership, so the app has to be the one to ask.
#[cfg(target_os = "android")]
fn platform_dirs() -> Result<AppDirs, String> {
    use jni::objects::{JObject, JString};
    use jni::{Env, JavaVM};

    fn absolute_path<'j>(env: &mut Env<'j>, file: &JObject<'j>) -> jni::errors::Result<String> {
        let obj = env
            .call_method(
                file,
                jni::jni_str!("getAbsolutePath"),
                jni::jni_sig!("()Ljava/lang/String;"),
                &[],
            )?
            .l()?;
        let s = unsafe { JString::from_raw(env, obj.into_raw()) };
        // Bound to a local on purpose: the MUTF8Chars view borrows `s`, and
        // returning the expression directly drops them in the wrong order.
        let path = String::from(s.mutf8_chars(env)?);
        Ok(path)
    }

    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) };
    let raw_context = ctx.context() as jni::sys::jobject;

    let (music, files): (String, String) = vm
        .attach_current_thread(|env: &mut Env<'_>| -> jni::errors::Result<(String, String)> {
            let context = unsafe { JObject::from_raw(env, raw_context) };

            let music_kind = env
                .get_static_field(
                    jni::jni_str!("android/os/Environment"),
                    jni::jni_str!("DIRECTORY_MUSIC"),
                    jni::jni_sig!("Ljava/lang/String;"),
                )?
                .l()?;
            let music_file = env
                .call_method(
                    &context,
                    jni::jni_str!("getExternalFilesDir"),
                    jni::jni_sig!("(Ljava/lang/String;)Ljava/io/File;"),
                    &[(&music_kind).into()],
                )?
                .l()?;
            // Null when external storage is unavailable (unmounted, or shared
            // storage still locked on a freshly booted device).
            if music_file.is_null() {
                return Err(jni::errors::Error::NullPtr("getExternalFilesDir"));
            }

            let files_file = env
                .call_method(
                    &context,
                    jni::jni_str!("getFilesDir"),
                    jni::jni_sig!("()Ljava/io/File;"),
                    &[],
                )?
                .l()?;

            Ok((
                absolute_path(env, &music_file)?,
                absolute_path(env, &files_file)?,
            ))
        })
        .map_err(|e: jni::errors::Error| format!("cannot resolve Android app dirs: {e}"))?;

    // Both are internal: the cache is derived data and the app's own data is
    // nobody else's business, and keeping them out of the MTP-visible folder
    // means a PC only ever sees the music.
    let data = PathBuf::from(&files);
    let cache = data.join("funkot-cache");
    ensure_dirs(&PathBuf::from(&music), &cache, &data)?;
    Ok(AppDirs {
        music_dir: music,
        cache_dir: cache.to_string_lossy().into_owned(),
        data_dir: files,
        music_dir_custom: None,
        music_dir_unavailable: false,
        music_dir_configurable: false,
    })
}

/// Desktop: everything under the per-app data directory Tauri resolves for
/// us, except `music_dir`, which the listener can redirect via
/// `set_music_dir` (`settings.json`, see `store::Settings`).
#[cfg(not(target_os = "android"))]
fn platform_dirs(app: &tauri::AppHandle) -> Result<AppDirs, String> {
    use tauri::Manager;

    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    let default_music = base.join("Music");
    let cache = base.join("funkot-cache");
    let configured = store::load_settings(&base).music_dir;
    let (music, unavailable) = resolve_music_dir(configured.as_deref(), &default_music, |p| {
        std::fs::read_dir(p).is_ok()
    });
    if unavailable {
        log::warn!(
            "configured music dir {} is not readable, falling back to {}",
            configured.as_deref().unwrap_or(Path::new("")).display(),
            default_music.display()
        );
    }
    ensure_dirs(&music, &cache, &base)?;
    Ok(AppDirs {
        music_dir: music.to_string_lossy().into_owned(),
        cache_dir: cache.to_string_lossy().into_owned(),
        data_dir: base.to_string_lossy().into_owned(),
        music_dir_custom: configured.map(|p| p.to_string_lossy().into_owned()),
        music_dir_unavailable: unavailable,
        music_dir_configurable: true,
    })
}

/// The music folder a launch should use: `configured` when it is readable,
/// `default_music` otherwise (including when nothing was ever configured).
/// The second element of the pair is whether a *configured* path was
/// rejected as unreadable — never `true` when `configured` is `None`, since
/// "nothing configured" is not an unavailable configuration, just an absent
/// one.
///
/// `readable` is injected so this stays testable without touching the
/// filesystem (same pattern as `store::restored_pending`'s `exists`).
///
/// Never returns `configured` unchecked: `ensure_dirs`'s `create_dir_all`
/// must only ever see the default path or a path that `read_dir` just
/// confirmed it can already list — never an unverified user-chosen path.
///
/// Android's `platform_dirs` never calls this (its `AppDirs` is built by
/// hand — see its `#[cfg]` split), so this would otherwise be dead code
/// there.
#[cfg_attr(target_os = "android", allow(dead_code))]
fn resolve_music_dir(
    configured: Option<&Path>,
    default_music: &Path,
    readable: impl Fn(&Path) -> bool,
) -> (PathBuf, bool) {
    match configured {
        None => (default_music.to_path_buf(), false),
        Some(p) if readable(p) => (p.to_path_buf(), false),
        Some(_) => (default_music.to_path_buf(), true),
    }
}

/// Rejects a candidate music folder without touching the filesystem: not an
/// absolute path, or a folder that would itself contain the app's own data
/// dir (which would put `settings.json`/`queue.json`/the analysis cache
/// inside the folder the library scanner walks). Filesystem-backed checks
/// (exists / is a directory / is readable) live in `set_music_dir` itself —
/// see its doc comment.
///
/// Android does not call `set_music_dir`'s real body (see its `#[cfg]`
/// split), so this would otherwise be dead code there.
#[cfg_attr(target_os = "android", allow(dead_code))]
fn check_music_dir_shape(candidate: &Path, data_dir: &Path) -> Result<(), &'static str> {
    if !candidate.is_absolute() {
        return Err("not_absolute");
    }
    if data_dir.starts_with(candidate) {
        return Err("contains_app_data");
    }
    Ok(())
}

#[cfg(test)]
mod music_dir_tests {
    use super::*;

    #[test]
    fn resolve_music_dir_unset_uses_default() {
        let default_music = Path::new("/data/Music");
        let (music, unavailable) = resolve_music_dir(None, default_music, |_| true);
        assert_eq!(music, default_music);
        assert!(!unavailable);
    }

    #[test]
    fn resolve_music_dir_uses_configured_when_readable() {
        let configured = Path::new("/elsewhere/MyMusic");
        let default_music = Path::new("/data/Music");
        let (music, unavailable) = resolve_music_dir(Some(configured), default_music, |_| true);
        assert_eq!(music, configured);
        assert!(!unavailable);
    }

    #[test]
    fn resolve_music_dir_falls_back_to_default_when_unreadable() {
        let configured = Path::new("/gone/MyMusic");
        let default_music = Path::new("/data/Music");
        let (music, unavailable) = resolve_music_dir(Some(configured), default_music, |_| false);
        assert_eq!(music, default_music);
        assert!(unavailable);
    }

    #[test]
    fn check_music_dir_shape_rejects_a_relative_path() {
        let data_dir = Path::new("/data/app");
        assert_eq!(
            check_music_dir_shape(Path::new("relative/Music"), data_dir),
            Err("not_absolute")
        );
    }

    #[test]
    fn check_music_dir_shape_rejects_a_parent_of_data_dir() {
        let data_dir = Path::new("/data/app");
        assert_eq!(
            check_music_dir_shape(Path::new("/data"), data_dir),
            Err("contains_app_data")
        );
    }

    #[test]
    fn check_music_dir_shape_accepts_a_sibling_of_data_dir() {
        let data_dir = Path::new("/data/app");
        assert_eq!(
            check_music_dir_shape(Path::new("/data/Music"), data_dir),
            Ok(())
        );
    }

    /// The default music dir (`data_dir.join("Music")`) must never be
    /// rejected: `platform_dirs` runs it through the exact same shape check
    /// as a user's choice by construction, so a false rejection here would
    /// break every fresh install.
    #[test]
    fn check_music_dir_shape_accepts_the_default_music_dir() {
        let data_dir = Path::new("/data/app");
        assert_eq!(check_music_dir_shape(&data_dir.join("Music"), data_dir), Ok(()));
    }

    #[test]
    fn check_music_dir_shape_rejects_when_candidate_equals_data_dir() {
        let data_dir = Path::new("/data/app");
        assert_eq!(
            check_music_dir_shape(data_dir, data_dir),
            Err("contains_app_data")
        );
    }

    /// Pins which path `resolve_music_dir` actually probes: only ever the
    /// configured one, never the default. A `readable` that ignored its
    /// argument (e.g. `|_| true`) would pass every other test in this module
    /// even if the real predicate call site were wrong.
    #[test]
    fn resolve_music_dir_probes_only_the_configured_path() {
        let configured = Path::new("/elsewhere/MyMusic");
        let default_music = Path::new("/data/Music");
        let probed = std::cell::Cell::new(Vec::new());
        let (_, _) = resolve_music_dir(Some(configured), default_music, |p| {
            let mut seen = probed.take();
            seen.push(p.to_path_buf());
            probed.set(seen);
            true
        });
        assert_eq!(probed.into_inner(), vec![configured.to_path_buf()]);
    }
}

/// Runs `store::migrate_from` once per process rather than once per call.
/// Only the first caller can find anything to move; the rest would race it and
/// log a failure for a rename whose source another thread just consumed.
static MIGRATED: std::sync::Once = std::sync::Once::new();

fn ensure_dirs(
    music: &std::path::Path,
    cache: &std::path::Path,
    data: &std::path::Path,
) -> Result<(), String> {
    for dir in [music, cache, data] {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    // Rescue the queue and the manual bars from where older builds put them.
    // Hooked in here because every path into the app resolves its directories
    // through this function, so there is no launch that can skip it.
    MIGRATED.call_once(|| store::migrate_from(cache, data));
    Ok(())
}

/// Resolve the app's directories, hiding the platform split from callers.
fn resolve_dirs(#[allow(unused)] app: &tauri::AppHandle) -> Result<AppDirs, String> {
    #[cfg(target_os = "android")]
    let dirs = platform_dirs();
    #[cfg(not(target_os = "android"))]
    let dirs = platform_dirs(app);
    dirs
}

#[tauri::command(async)]
fn app_dirs(app: tauri::AppHandle) -> Result<AppDirs, String> {
    let dirs = resolve_dirs(&app);
    if let Ok(d) = &dirs {
        log::info!("music: {} / cache: {} / data: {}", d.music_dir, d.cache_dir, d.data_dir);
    }
    dirs
}

/// Resolve (and create) the Music folder, open it on desktop, and return its
/// absolute path.
///
/// Desktop only in practice: the Android music folder sits under
/// `Android/data`, which no file manager can reach since Android 11 (both
/// `ACTION_VIEW` and `ACTION_OPEN_DOCUMENT_TREE` are refused there), so the
/// UI hides the menu item and shows the path in the log panel instead. The
/// Android arm is left as a path-returning no-op rather than an error: it
/// stays honest if something else ever calls it, and the folder is created
/// by `ensure_dirs` on every launch regardless.
#[tauri::command(async)]
fn open_music_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dirs = resolve_dirs(&app)?;
    let music = PathBuf::from(&dirs.music_dir);
    std::fs::create_dir_all(&music)
        .map_err(|e| format!("cannot create {}: {e}", music.display()))?;

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&music)
            .spawn()
            .map_err(|e| format!("cannot open Music folder: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&music)
            .spawn()
            .map_err(|e| format!("cannot open Music folder: {e}"))?;
    }
    #[cfg(all(
        not(target_os = "windows"),
        not(target_os = "android"),
        not(target_os = "macos")
    ))]
    {
        std::process::Command::new("xdg-open")
            .arg(&music)
            .spawn()
            .map_err(|e| format!("cannot open Music folder (xdg-open): {e}"))?;
    }

    Ok(dirs.music_dir)
}

/// Outcome of [`set_music_dir`] / [`reset_music_dir`].
#[derive(serde::Serialize, Clone, Debug)]
struct SetMusicDirResult {
    /// Whether the listener actually picked (or cleared) a folder. `false`
    /// on a cancelled dialog, or a `reset_music_dir` call when nothing was
    /// configured.
    changed: bool,
    /// The resolved directories after this call — the same as before the
    /// call when `changed` is `false`.
    dirs: AppDirs,
    /// `true` when `changed` and the audio thread has already started this
    /// launch (`AppState::started`): the running `Engine` keeps scanning the
    /// old folder until the app restarts.
    restart_required: bool,
}

/// Opens a native folder-picker and, if the listener confirms a folder,
/// validates it and saves it to `settings.json` (`store::Settings`),
/// applying it to every command from here on (except the already-running
/// automatic selection — see [`SetMusicDirResult::restart_required`]).
///
/// Does not move, copy, or delete anything: the previous folder's files stay
/// exactly where they are, and the analysis cache / hand corrections are
/// keyed by content hash, so they carry over automatically for any file that
/// is also present under the new folder.
///
/// Errors are one of `"not_absolute"` / `"not_found"` / `"not_a_directory"`
/// / `"not_readable"` / `"contains_app_data"` / `"unsupported_platform"`
/// (Android has no folder-picker backend, so it always returns the last
/// one). `src/lib/tauri.ts` and `OverflowMenu.svelte` match on these exact
/// strings — keep this contract in sync on all three, the same as
/// `reorder`/`dequeue`'s error codes.
///
/// Always `async`: `blocking_pick_folder` must never run on the main thread.
#[tauri::command(async)]
fn set_music_dir(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<SetMusicDirResult, String> {
    #[cfg(target_os = "android")]
    {
        let _ = (&app, &state);
        return Err("unsupported_platform".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        use tauri::Manager;
        use tauri_plugin_dialog::DialogExt;

        let dirs = resolve_dirs(&app)?;

        let mut b = app
            .dialog()
            .file()
            .set_title("音楽フォルダを選ぶ")
            .set_directory(&dirs.music_dir);
        if let Some(w) = app.get_webview_window("main") {
            b = b.set_parent(&w);
        }
        let picked = b.blocking_pick_folder();

        let Some(fp) = picked else {
            return Ok(SetMusicDirResult {
                changed: false,
                dirs,
                restart_required: false,
            });
        };
        let path = fp.into_path().map_err(|_| "not_absolute".to_string())?;

        check_music_dir_shape(&path, Path::new(&dirs.data_dir))?;
        match std::fs::metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err("not_found".into()),
            Err(_) => return Err("not_readable".into()),
            Ok(m) if !m.is_dir() => return Err("not_a_directory".into()),
            Ok(_) => {}
        }
        if std::fs::read_dir(&path).is_err() {
            return Err("not_readable".into());
        }

        let data = Path::new(&dirs.data_dir);
        let mut settings = store::load_settings(data);
        settings.music_dir = Some(path);
        store::save_settings(data, &settings)
            .map_err(|e| format!("cannot save settings: {e}"))?;

        let dirs = resolve_dirs(&app)?;
        let restart_required = *state.started.lock().unwrap();
        Ok(SetMusicDirResult {
            changed: true,
            dirs,
            restart_required,
        })
    }
}

/// Clears whatever folder `set_music_dir` configured, reverting to the
/// default `Music` folder. A no-op (`changed: false`) when nothing was
/// configured. Same `"unsupported_platform"` behaviour on Android as
/// [`set_music_dir`]; see its doc comment for the shared error contract.
#[tauri::command(async)]
fn reset_music_dir(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<SetMusicDirResult, String> {
    #[cfg(target_os = "android")]
    {
        let _ = (&app, &state);
        return Err("unsupported_platform".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        let dirs = resolve_dirs(&app)?;
        let data = Path::new(&dirs.data_dir);
        let mut settings = store::load_settings(data);
        let changed = settings.music_dir.is_some();
        if changed {
            settings.music_dir = None;
            store::save_settings(data, &settings)
                .map_err(|e| format!("cannot save settings: {e}"))?;
        }
        let dirs = resolve_dirs(&app)?;
        let restart_required = changed && *state.started.lock().unwrap();
        Ok(SetMusicDirResult {
            changed,
            dirs,
            restart_required,
        })
    }
}

/// Outcome of [`share_feedback`]: Android opened a chooser, or desktop wrote a path.
#[derive(serde::Serialize, Clone, Debug)]
struct ShareFeedbackResult {
    /// `"shared"` (Android chooser opened) or `"saved"` (desktop path written).
    mode: String,
    /// Absolute path of the staged ZIP.
    path: String,
}

/// Stage `library.json` + `flags.json` + `meta.json` into a dated feedback ZIP and share it.
///
/// Android: write under `getCacheDir()/funkot-export/` (FileProvider
/// `<cache-path>`), then open `ACTION_SEND` via [`feedback_share`].
/// Desktop: write under `cache_dir/funkot-export/` and return the path for a toast.
///
/// Does not move or delete anything under `data_dir`.
#[tauri::command(async)]
fn share_feedback(app: tauri::AppHandle) -> Result<ShareFeedbackResult, String> {
    let dirs = resolve_dirs(&app)?;

    #[cfg(target_os = "android")]
    let staging_root = android_cache_dir()?;
    #[cfg(not(target_os = "android"))]
    let staging_root = PathBuf::from(&dirs.cache_dir);

    let staging_dir = staging_root.join("funkot-export");
    let sent_at = store::utc_rfc3339_now();
    let filename_stamp = store::feedback_filename_stamp(&sent_at);
    let zip_path = staging_dir.join(format!("funkot-feedback-{filename_stamp}.zip"));

    #[cfg(target_os = "android")]
    let device_model = android_device_model();
    #[cfg(not(target_os = "android"))]
    let device_model = "desktop".to_string();

    let meta = store::FeedbackMeta {
        version_name: env!("FUNKOT_VERSION_NAME").into(),
        version_code: env!("FUNKOT_VERSION_CODE").parse().unwrap_or(1),
        funkot_core_git: env!("FUNKOT_CORE_GIT").into(),
        device_model,
        sent_at,
    };

    {
        let _saving = SAVE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        store::write_feedback_zip(Path::new(&dirs.data_dir), &zip_path, &meta)
            .map_err(|e| format!("cannot write feedback zip: {e}"))?;
    }

    let path = zip_path.to_string_lossy().into_owned();

    #[cfg(target_os = "android")]
    {
        feedback_share(&path)?;
        Ok(ShareFeedbackResult {
            mode: "shared".into(),
            path,
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(ShareFeedbackResult {
            mode: "saved".into(),
            path,
        })
    }
}

/// Outcome of [`take_pending_import`].
#[derive(serde::Serialize, Clone, Debug, Default)]
struct ImportResult {
    /// Files copied into `music_dir`.
    tracks: u32,
    /// Staged files whose extension `is_supported_track` does not recognise.
    skipped: u32,
    /// Staged files that passed `classify_import` but whose copy into
    /// `music_dir` failed (`copy_atomic`), plus URIs that failed even
    /// earlier, during staging itself (`Import.kt`'s `onIntent` — see
    /// `Import.takeFailed`), before a file ever reached this walk.
    failed: u32,
    /// `true` when `Import.kt` is still copying a file into the staging
    /// dir. `Import.onIntent`'s copy runs on a background thread and this
    /// command can easily win the race against it — a multi-MB share is
    /// still copying by the time the cold-start `take_pending_import` call
    /// runs. Without this, that call sees an empty (or partial) staging dir
    /// and never retries: the app is already foregrounded by then, so the
    /// `visibilitychange` path never fires again either, and the share is
    /// silently lost. The frontend polls again shortly while this is `true`
    /// (see `doTakePendingImport` in `state.svelte.ts`). Always `false` on
    /// desktop.
    in_flight: bool,
}

/// The receiving half of [`share_feedback`]'s ZIP-out path: walks files
/// `Import.kt` staged from the system share sheet (`getCacheDir()/
/// funkot-import/`, filled by `Import.onIntent` — see `AndroidManifest.xml`'s
/// `ACTION_SEND` / `ACTION_SEND_MULTIPLE` intent filters) into `music_dir`.
///
/// Desktop is always a no-op: nothing ever stages anything there, since
/// those intent filters only exist on Android.
///
/// The staging directory's actual contents are the source of truth here —
/// there is deliberately no separate in-process queue of what was staged
/// (an earlier version of this command had one; it could both drop a file
/// that finished copying in the gap between a status check and the drain,
/// and permanently strand one if the process died between the copy
/// finishing and the next drain, since the queue does not survive a
/// restart but the file on disk does).
///
/// Every staged file this walk actually looks at (i.e. not a `.part` still
/// being written) is removed regardless of outcome — copied, skipped for an
/// unsupported extension, or a failed copy — so `funkot-import/` never
/// accumulates leftovers across calls.
#[tauri::command(async)]
fn take_pending_import(app: tauri::AppHandle) -> Result<ImportResult, String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        Ok(ImportResult::default())
    }
    #[cfg(target_os = "android")]
    {
        let dirs = resolve_dirs(&app)?;
        let music_dir = Path::new(&dirs.music_dir);

        // Read before the walk below, never after: `Import.kt` only ever
        // creates a `<name>.part` file while a copy thread owns it, and
        // renames it to its final name once the copy finishes. If a copy
        // finishes *after* this read but the `<name>.part` -> `<name>` rename
        // still lands inside the `read_dir` snapshot below, this being read
        // first means it is still `true`, so the frontend retries and picks
        // the file up on the next call. Reading it after the walk instead
        // would let that same file slip through as `in_flight: false` with
        // nothing telling the frontend to look again.
        let in_flight = android_import_has_in_flight()?;

        let staging_dir = android_cache_dir()?.join("funkot-import");

        // Must be read after `in_flight` above, never before: an increment
        // of `Import`'s `failed` counter always completes, inside the copy
        // thread's loop, before that thread's `finally` decrements
        // `inFlight`. So once `in_flight` reads `false`, every failure from
        // that run is already reflected here. Reading this first instead
        // risks a failure landing in between the two reads: `in_flight`
        // would then still report `false` (nothing tells the frontend to
        // poll again) while the failure that just happened is lost.
        //
        // Read after `android_cache_dir()?` above (rather than right after
        // `in_flight`) so that if that call fails, this destructive read
        // (see `Import.takeFailed`'s doc comment) never happens and the
        // failure count survives to be picked up on the next poll instead
        // of being reset and lost. A later `read_dir` I/O error below can
        // still lose an already-taken count, but that path returns `Err`
        // and surfaces to the frontend as `lastError`, unlike a silently
        // dropped toast.
        let failed = android_import_take_failed()?;

        let mut result = ImportResult {
            in_flight,
            failed,
            ..ImportResult::default()
        };
        let entries = match std::fs::read_dir(&staging_dir) {
            Ok(entries) => entries,
            // Nothing has ever been shared yet — not an error.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(result),
            Err(e) => return Err(format!("cannot read {}: {e}", staging_dir.display())),
        };

        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("part") {
                // A `.part` file only exists while `Import.onIntent`'s copy
                // thread owns it (see `copy_atomic`'s Kotlin counterpart).
                // `in_flight` was read above, before this snapshot, so `false`
                // here means no such thread was running even before this walk
                // started -- this one was abandoned (most likely the process
                // died mid-copy) and will never be finished or claimed.
                if !in_flight {
                    let _ = std::fs::remove_file(&path);
                }
                continue;
            }
            match classify_import(&path, music_dir, |p| p.exists()) {
                ImportDecision::Skip => result.skipped += 1,
                ImportDecision::CopyTo(dest) => match copy_atomic(&path, &dest) {
                    Ok(()) => result.tracks += 1,
                    Err(e) => {
                        result.failed += 1;
                        log::warn!(
                            "cannot import {} to {}: {e}",
                            path.display(),
                            dest.display()
                        );
                    }
                },
            }
            if let Err(e) = std::fs::remove_file(&path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("cannot remove staged import {}: {e}", path.display());
                }
            }
        }
        Ok(result)
    }
}

/// Serialises writes under `data_dir` (`queue.json`, `flags.json`, and
/// `session.json`).
///
/// The mutating commands run on Tauri's blocking threadpool, so two of them
/// really do overlap — tapping ✕ on one row and ↑ on another in quick
/// succession is enough. Each takes its snapshot *inside* this lock, so the
/// last write is always the latest state; without it the two snapshots can
/// reach `fs::write` in the opposite order and leave the file a revision
/// behind, or interleave inside the truncate-then-write and leave it torn.
///
/// Process-wide (not on `AppState`) so Android notification JNI can share the
/// same lock without a Tauri handle.
///
/// Lock order (fixed, never reversed): `SAVE_LOCK` → [`SESSION`] → queue
/// (`src-tauri/src/queue.rs`) → render. `persist_session` is the only place
/// `SAVE_LOCK` and `SESSION` nest; see its doc comment.
static SAVE_LOCK: Mutex<()> = Mutex::new(());

/// Key last written by `flag_last_transition`, for a single-shot undo.
static LAST_FLAG_UNDO: Mutex<Option<String>> = Mutex::new(None);

/// Dismiss key last written by `dismiss_flags`, for a single-shot undo.
static LAST_DISMISS_UNDO: Mutex<Option<String>> = Mutex::new(None);

/// What the next launch will restore (see `store::Session`). Mutated by its
/// three save sites directly (each takes only this mutex, the same pattern
/// `reorder`/`dequeue` use for `queue` — see `persist_queue`), then handed to
/// `persist_session` to write out. Touch it under `SAVE_LOCK` only from
/// inside `persist_session` itself; nothing else may nest the two, in either
/// order (see `SAVE_LOCK`'s doc comment).
static SESSION: Mutex<store::Session> = Mutex::new(store::Session::new());

/// Save `SESSION`'s current value under [`DATA_DIR`]. Best-effort: no
/// `DATA_DIR` yet (nothing has resolved it this launch) or a write failure
/// is `log::warn!`-only, never propagated — the caller's command or event
/// must not fail or block on this.
///
/// Read `SESSION` fresh under `SAVE_LOCK` rather than taking a value from the
/// caller, for the same reason `persist_queue` re-reads `queue` instead of
/// trusting a captured snapshot: two save sites can race (e.g. `flip_paused`
/// racing an `on_reserved` push), and re-reading under the lock means
/// whichever finishes last always writes the true latest state.
fn persist_session() {
    let Some(dir) = DATA_DIR.get() else {
        log::warn!("persist_session: DATA_DIR not resolved yet");
        return;
    };
    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let session = SESSION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    if let Err(e) = store::save_session(dir, &session) {
        log::warn!("save_session({}): {e}", dir.display());
    }
}

/// Where the audio thread reports back to the UI. `cpal::Stream` is not `Send`
/// on every platform, so it never leaves the thread that created it.
struct AppState {
    log_rx: Mutex<Option<Receiver<String>>>,
    lines: Mutex<Vec<String>>,
    started: Mutex<bool>,
    queue: SharedQueue,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            log_rx: Mutex::new(None),
            lines: Mutex::new(Vec::new()),
            started: Mutex::new(false),
            queue: queue::new_shared_queue(),
        }
    }
}

/// Turns "was this callback's output bit-exact silence?" into a UI phase.
///
/// The engine fills the buffer with zeros while it waits for the loader
/// (see funkot-core engine.rs `render`), and skips the mix bus at bit-exact
/// silence, so a whole silent buffer is the one signal a host gets that
/// playback has starved.
///
/// It is not a *proof* of one: a track with a real digital-silence break
/// decodes to bit-exact zeros too, and nothing downstream of the decoder
/// necessarily disturbs them. Hence [`STALL_AFTER`] rather than reacting to
/// the first quiet buffer — the stall this exists to report runs for minutes,
/// so waiting a couple of seconds costs nothing and keeps a produced silence
/// from being announced as a fault.
///
/// Deliberately does no logging of its own: this runs inside the cpal
/// callback, and `log` formats a string and writes to the logd socket, which
/// is exactly the kind of unbounded work that turns a reported stall into a
/// reported stall *plus* a dropout. The audio thread watches [`PHASE`] from
/// its idle loop instead and logs the edges from there.
struct StallWatch {
    silent_frames: u64,
    stall_after_frames: u64,
    /// Whether a non-silent buffer has ever been seen. Distinguishes "still
    /// warming up for the first track" (`Starting`) from "was playing, went
    /// quiet" (`Stalled`) — both look like silence to the counter alone.
    started: bool,
}

/// How long the output has to stay bit-exact silent before it is called a
/// stall. See [`StallWatch`] for why this is not simply "one buffer".
const STALL_AFTER: std::time::Duration = std::time::Duration::from_secs(2);

impl StallWatch {
    fn new(sample_rate: u32) -> Self {
        Self {
            silent_frames: 0,
            stall_after_frames: STALL_AFTER.as_secs() * u64::from(sample_rate),
            started: false,
        }
    }

    /// Feed one callback's frame count and whether its buffer was bit-exact
    /// silence; returns the phase the UI should show for it.
    fn observe(&mut self, frames: u64, silent: bool) -> Phase {
        if !silent {
            self.silent_frames = 0;
            self.started = true;
            return Phase::Playing;
        }

        self.silent_frames += frames;
        if !self.started {
            return Phase::Starting;
        }
        if self.silent_frames >= self.stall_after_frames {
            return Phase::Stalled;
        }
        Phase::Playing
    }

    /// Drop whatever silence has accumulated so far without touching
    /// `started`. Used when pausing: the buffers written while paused are
    /// deliberate silence, not starvation, and must not count toward a stall
    /// that fires the moment playback resumes.
    fn reset_silence(&mut self) {
        self.silent_frames = 0;
    }
}

/// How long [`CALLBACK_TICKS`] can go unmoved before the callback is declared
/// dead. At the engine's 1026-frame buffer and 48 kHz, the callback runs
/// about 47 times a second, so a full second of no movement is already well
/// past anything a live stream should ever do; three gives scheduling jitter
/// room without meaningfully delaying the report.
const STUCK_SECS_BEFORE_LOST: u32 = 3;

/// Turns "is the cpal data callback still being invoked at all" into a UI
/// phase decision.
///
/// This exists for exactly the failure `StallWatch` cannot see: when the
/// output device disconnects (e.g. a Bluetooth speaker drops), cpal's AAudio
/// host on Android stops calling the data callback — not "produces silence",
/// *stops running*. `StallWatch` lives inside that same callback, so it cannot
/// report anything once the callback itself is gone; only an outside observer
/// comparing [`CALLBACK_TICKS`] against its own clock can notice. `audio_thread`
/// then drops the stream and retries reopen.
///
/// Like `StallWatch`, this is a pure state machine with no channel, lock, or
/// clock of its own, so it can be driven and tested without any of those —
/// the caller (`audio_thread`'s idle loop) supplies both the current tick
/// count and its own once-a-second cadence.
struct CallbackWatch {
    last_ticks: u64,
    stuck_secs: u32,
}

impl CallbackWatch {
    fn new(ticks: u64) -> Self {
        Self { last_ticks: ticks, stuck_secs: 0 }
    }

    /// Call once a second with the current value of [`CALLBACK_TICKS`] and
    /// whether the stream's error callback has fired since the last stream
    /// (re)start. Returns whether the callback should be reported lost.
    ///
    /// `error_seen` alone never reports a loss: if `ticks` is still moving the
    /// stream is plainly still alive (cpal can call the error callback for
    /// conditions it recovers from on its own), and a false "disconnected"
    /// would be worse than staying silent about a hiccup that already passed.
    /// It only shortens how long a genuine stall has to run before it is
    /// reported, from `STUCK_SECS_BEFORE_LOST` seconds down to one.
    fn observe(&mut self, ticks: u64, error_seen: bool) -> bool {
        if ticks != self.last_ticks {
            self.last_ticks = ticks;
            self.stuck_secs = 0;
            return false;
        }
        self.stuck_secs += 1;
        error_seen || self.stuck_secs >= STUCK_SECS_BEFORE_LOST
    }
}

#[cfg(test)]
mod cb_watch_tests {
    use super::*;

    #[test]
    fn moving_ticks_never_report_lost() {
        let mut w = CallbackWatch::new(0);
        for t in 1..=10 {
            assert!(!w.observe(t, false));
        }
    }

    #[test]
    fn stuck_under_the_threshold_is_not_lost() {
        let mut w = CallbackWatch::new(5);
        assert!(!w.observe(5, false));
        assert!(!w.observe(5, false));
    }

    #[test]
    fn stuck_for_the_full_threshold_is_lost() {
        let mut w = CallbackWatch::new(5);
        assert!(!w.observe(5, false)); // 1
        assert!(!w.observe(5, false)); // 2
        assert!(w.observe(5, false)); // 3: STUCK_SECS_BEFORE_LOST reached
    }

    #[test]
    fn recovering_after_stuck_resets_and_reports_alive() {
        let mut w = CallbackWatch::new(5);
        assert!(!w.observe(5, false));
        assert!(!w.observe(5, false));
        assert!(w.observe(5, false));
        // Ticks move again: self-recovers, no latching.
        assert!(!w.observe(6, false));
        // And the stuck counter really was reset, not just skipped this once.
        assert!(!w.observe(6, false));
        assert!(!w.observe(6, false));
    }

    #[test]
    fn error_seen_with_stuck_ticks_reports_lost_on_the_first_observation() {
        let mut w = CallbackWatch::new(5);
        assert!(w.observe(5, true));
    }

    #[test]
    fn error_seen_with_moving_ticks_is_not_lost() {
        let mut w = CallbackWatch::new(5);
        assert!(!w.observe(6, true));
    }
}

#[cfg(test)]
mod stall_watch_tests {
    use super::*;

    /// A 2 Hz "sample rate", so `STALL_AFTER` works out to 4 frames and the
    /// assertions below can count them by hand.
    fn watch() -> StallWatch {
        let w = StallWatch::new(2);
        assert_eq!(w.stall_after_frames, 4, "tests below assume a 4-frame threshold");
        w
    }

    #[test]
    fn starting_until_the_first_sound() {
        let mut w = watch();
        assert!(w.observe(4, true) == Phase::Starting);
        assert!(w.observe(4, true) == Phase::Starting);
    }

    #[test]
    fn playing_once_sound_arrives() {
        let mut w = watch();
        w.observe(4, true);
        assert!(w.observe(4, false) == Phase::Playing);
    }

    #[test]
    fn stalls_after_enough_silence_once_started() {
        let mut w = watch();
        w.observe(4, false); // started
        assert!(w.observe(3, true) == Phase::Playing); // under the threshold
        assert!(w.observe(1, true) == Phase::Stalled); // crossed 4 frames
        assert!(w.observe(100, true) == Phase::Stalled); // stays stalled
    }

    #[test]
    fn recovers_to_playing_once_sound_returns() {
        let mut w = watch();
        w.observe(4, false);
        w.observe(4, true);
        assert!(w.observe(1, true) == Phase::Stalled);
        assert!(w.observe(4, false) == Phase::Playing);
    }

    /// Pausing writes silence deliberately. Without the reset, a long pause
    /// would bank enough silent frames to report a stall on the very first
    /// buffer after resuming — while the engine is in fact fine.
    #[test]
    fn pausing_does_not_bank_silence_toward_a_stall() {
        let mut w = watch();
        w.observe(4, false); // started
        for _ in 0..10 {
            w.reset_silence(); // what the callback does on every paused buffer
        }
        assert!(w.observe(3, true) == Phase::Playing);
    }

    #[test]
    fn phase_survives_the_round_trip_through_the_atomic() {
        for p in [
            Phase::Idle,
            Phase::Starting,
            Phase::Playing,
            Phase::Paused,
            Phase::Stalled,
            Phase::Failed,
            Phase::Disconnected,
        ] {
            assert!(Phase::from_u8(p as u8) == p, "{} did not round-trip", p.as_str());
        }
    }
}

#[cfg(test)]
mod flip_paused_tests {
    use super::*;
    use std::sync::Mutex;

    /// `PHASE` is process-global; these tests must not interleave with each other
    /// under cargo's default multi-threaded runner.
    static PHASE_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn pause_while_disconnected_keeps_phase() {
        let _guard = PHASE_LOCK.lock().unwrap();
        set_phase(Phase::Disconnected);
        let paused = AtomicBool::new(false);
        assert!(flip_paused(&paused));
        assert!(paused.load(Ordering::Relaxed));
        assert!(get_phase() == Phase::Disconnected);
        set_phase(Phase::Idle);
    }

    #[test]
    fn pause_while_playing_sets_paused_phase() {
        let _guard = PHASE_LOCK.lock().unwrap();
        set_phase(Phase::Playing);
        let paused = AtomicBool::new(false);
        assert!(flip_paused(&paused));
        assert!(paused.load(Ordering::Relaxed));
        assert!(get_phase() == Phase::Paused);
        set_phase(Phase::Idle);
    }

    #[test]
    fn pack_native_control_state_encodes_paused_and_phase() {
        // Pure encoder; does not touch `PHASE`.
        assert!(
            pack_native_control_state(true, Phase::Disconnected)
                == ((Phase::Disconnected as i32) << 1) | 1
        );
        assert!(
            pack_native_control_state(false, Phase::Playing) == (Phase::Playing as i32) << 1
        );
    }

    #[test]
    fn pause_rejected_while_auditioning() {
        assert!(ensure_pause_allowed(true, false).is_err());
        assert!(ensure_pause_allowed(false, true).is_err());
        assert!(ensure_pause_allowed(true, true).is_err());
        assert!(ensure_pause_allowed(false, false).is_ok());
    }
}

/// Who started a transition. Only distinguishes "should this feed the ⚑
/// flag work (S5)" — a listener's own skip, or an edit-tab audition mix, is
/// not a mixing judgement worth reviewing, so it must not be confused for one.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Origin {
    Automatic,
    Manual,
    Audition,
}

/// What crosses the audio thread's event channel. `EngineEvent` is
/// everything the engine itself reports; `TransitionEnded` is synthesized by
/// the cpal callback (see its comment) because the engine has no event of
/// its own for "the overlap just finished".
///
/// `audition` is stamped at send time from whether the callback was rendering
/// the audition engine — receivers must not re-read [`AUDITIONING`], or a
/// late event after `resume_autodj` would be mis-attributed.
enum PlaybackEvent {
    Engine { event: EngineEvent, audition: bool },
    TransitionEnded { audition: bool },
}

/// A transition that has finished, kept only long enough to answer "what did
/// the ⚑ flag work (S5) need to know about the last mix".
struct CompletedTransition {
    from: PathBuf,
    to: PathBuf,
    origin: Origin,
    at: Instant,
}

/// Folds the engine's `TrackStarted`/`TransitionStarted` events (plus the
/// synthesized `TransitionEnded`) into "what is playing now". Kept free of
/// channels and mutexes so it can be tested as a plain state machine — the
/// only clock it reads is the `Instant` stamped on a completed transition,
/// which no test asserts on.
///
/// The display switch happens on transition *end*, not start: a transition
/// overlaps two tracks for tens of seconds at 180 BPM, and switching at the
/// start would show the wrong title/notification for most of that overlap.
struct NowTracker {
    now: Option<PathBuf>,
    previous: Option<PathBuf>,
    in_progress: Option<(PathBuf, PathBuf, Origin, u64)>,
    /// The last transition worth flagging — i.e. not a listener-triggered
    /// skip and not a same-track restart. See `on_transition_ended`.
    last_transition: Option<CompletedTransition>,
    /// `MAIN_FRAMES` at the moment `now` most recently started being audible.
    /// Read by `player_state` (together with the live `MAIN_FRAMES` value) to
    /// derive `PlayerState::position_secs`.
    ///
    /// Invariant: every place that changes `now` changes this too, by the
    /// same rule — see each method below. There is no path that moves `now`
    /// without also moving this; a stale stamp here would silently misreport
    /// how far into the track playback actually is.
    now_started_frames: Option<u64>,
}

impl NowTracker {
    const fn new() -> Self {
        Self {
            now: None,
            previous: None,
            in_progress: None,
            last_transition: None,
            now_started_frames: None,
        }
    }

    /// Records the transition as in-progress; `now` does not change until it
    /// completes (see the struct doc comment) — except when one is already
    /// in progress, in which case that one is folded into `now`/`previous`
    /// right here instead.
    ///
    /// A transition already being in progress means a nav interrupted it: the
    /// engine's `begin_transition_to` calls `abort_active_transition()` and
    /// starts the new transition within the same `render()` call (nav is
    /// drained frame by frame inside `render`, so an interruption always
    /// completes inside one buffer). That means `on_transition_ended`'s
    /// buffer-boundary edge — `transition_frames_into()` going from `Some` to
    /// `None` — can *never* fire for the interrupted transition; it stays
    /// `Some` straight through into the new one. Waiting for it here would
    /// leave `now` on the pre-interruption track for as long as the second
    /// transition takes to finish, which is exactly the "wrong title for
    /// tens of seconds" problem switching on transition-end exists to avoid.
    ///
    /// The interrupted transition is not recorded as `last_transition`: the
    /// listener never heard it through to the end, so it is not a mixing
    /// decision worth flagging.
    ///
    /// `at_frames` is `MAIN_FRAMES` at the moment this transition started —
    /// the frame the incoming `to` began being mixed in. It only becomes
    /// `now_started_frames` if this call folds an *interrupted* transition
    /// into `now`/`previous` right here (whose own stamp, not `at_frames`,
    /// is what applies — the interrupted one is what is actually playing);
    /// `at_frames` itself is stashed in `in_progress` for `on_transition_ended`
    /// (or a later interrupt) to use once *this* transition resolves.
    fn on_transition_started(&mut self, from: PathBuf, to: PathBuf, origin: Origin, at_frames: u64) {
        if let Some((old_from, old_to, _, stamp)) = self.in_progress.take() {
            self.previous = Some(old_from);
            self.now = Some(old_to);
            self.now_started_frames = Some(stamp);
        }
        self.in_progress = Some((from, to, origin, at_frames));
    }

    /// The engine pushes `TransitionStarted` then `TrackStarted` for the
    /// track it just began mixing in, so a `TrackStarted` that arrives while
    /// a transition is in progress is that same entry announcing itself —
    /// not a new track playing solo. Only a `TrackStarted` with nothing in
    /// progress (the first track, or a track that started without a
    /// transition) should move `now` — and, in lockstep, `now_started_frames`.
    fn on_track_started(&mut self, path: PathBuf, at_frames: u64) {
        if self.in_progress.is_none() {
            self.now = Some(path);
            self.now_started_frames = Some(at_frames);
        }
    }

    /// Applies the completed transition and returns `(from, to, origin)` for
    /// the caller to log, regardless of whether it also went into
    /// `last_transition`. A no-op (returns `None`) if nothing was in
    /// progress. An interrupted transition never reaches here at all — see
    /// `on_transition_started`, which folds it into `now`/`previous` itself
    /// the moment the interruption is observed — so by the time this runs,
    /// `in_progress`, if present, always describes the transition that is
    /// actually ending.
    fn on_transition_ended(&mut self) -> Option<(PathBuf, PathBuf, Origin)> {
        let (from, to, origin, stamp) = self.in_progress.take()?;
        self.previous = Some(from.clone());
        self.now = Some(to.clone());
        self.now_started_frames = Some(stamp);
        // A listener's own skip (Manual) and a same-track restart (from ==
        // to) both still switch the displayed title above, but neither is a
        // mixing decision worth flagging: the operator picked it themselves.
        if origin == Origin::Automatic && from != to {
            self.last_transition = Some(CompletedTransition {
                from: from.clone(),
                to: to.clone(),
                origin,
                at: Instant::now(),
            });
        }
        Some((from, to, origin))
    }
}

#[cfg(test)]
mod now_tracker_tests {
    use super::*;

    fn p(name: &str) -> PathBuf {
        PathBuf::from(name)
    }

    #[test]
    fn first_track_started_sets_now_and_leaves_previous_none() {
        let mut t = NowTracker::new();
        t.on_track_started(p("a.wav"), 100);
        assert_eq!(t.now, Some(p("a.wav")));
        assert_eq!(t.previous, None);
        assert_eq!(t.now_started_frames, Some(100), "now_started_frames must land on the stamp TrackStarted was reported at");
    }

    #[test]
    fn transition_started_alone_does_not_move_now_until_it_ends() {
        let mut t = NowTracker::new();
        t.on_track_started(p("a.wav"), 100);
        t.on_transition_started(p("a.wav"), p("b.wav"), Origin::Automatic, 200);
        assert_eq!(t.now, Some(p("a.wav")), "TransitionStarted alone must not switch now");
        assert_eq!(t.now_started_frames, Some(100), "nor its stamp");
        t.on_transition_ended();
        assert_eq!(t.now, Some(p("b.wav")));
        assert_eq!(t.previous, Some(p("a.wav")));
        assert_eq!(t.now_started_frames, Some(200), "TransitionEnded promotes now_started_frames to this transition's own stamp");
    }

    #[test]
    fn track_started_mid_transition_does_not_jump_ahead_of_transition_ended() {
        let mut t = NowTracker::new();
        t.on_track_started(p("a.wav"), 100);
        t.on_transition_started(p("a.wav"), p("b.wav"), Origin::Automatic, 200);
        // The engine announces the entry it just mixed in with its own
        // TrackStarted; that must not be mistaken for a standalone track.
        t.on_track_started(p("b.wav"), 250);
        assert_eq!(t.now, Some(p("a.wav")));
    }

    /// Regression test for a nav interrupting a transition already in
    /// progress (e.g. ⏭ pressed while an automatic mix is underway).
    /// `on_transition_ended` can never fire for the interrupted A→B — see
    /// `on_transition_started`'s doc comment — so this must fold it into
    /// `now`/`previous` itself, immediately, when B→C starts. Without this,
    /// `now` would stay on A until the *second* transition finishes.
    #[test]
    fn a_transition_started_while_one_is_in_progress_folds_the_interrupted_one_in() {
        let mut t = NowTracker::new();
        t.on_track_started(p("a.wav"), 100);
        t.on_transition_started(p("a.wav"), p("b.wav"), Origin::Automatic, 200);
        t.on_transition_started(p("b.wav"), p("c.wav"), Origin::Automatic, 300);
        assert_eq!(t.now, Some(p("b.wav")), "the interrupted transition's destination is what is actually playing");
        assert_eq!(t.previous, Some(p("a.wav")));
        assert_eq!(t.now_started_frames, Some(200), "now_started_frames must promote to the interrupted transition's own stamp, not the one that interrupted it");
        // The listener never heard A→B through to the end, so it must not
        // become a ⚑ candidate.
        assert!(t.last_transition.is_none());
    }

    /// Continuation of the above: once the second transition (the one that
    /// did the interrupting) itself completes normally, it is recorded like
    /// any other automatic transition.
    #[test]
    fn the_transition_that_did_the_interrupting_is_recorded_normally_once_it_ends() {
        let mut t = NowTracker::new();
        t.on_track_started(p("a.wav"), 100);
        t.on_transition_started(p("a.wav"), p("b.wav"), Origin::Automatic, 200);
        t.on_transition_started(p("b.wav"), p("c.wav"), Origin::Automatic, 300);
        t.on_transition_ended();
        assert_eq!(t.now, Some(p("c.wav")));
        assert_eq!(t.previous, Some(p("b.wav")));
        assert_eq!(t.now_started_frames, Some(300));
        let last = t.last_transition.as_ref().expect("B->C should be recorded");
        assert_eq!(last.from, p("b.wav"));
        assert_eq!(last.to, p("c.wav"));
    }

    #[test]
    fn automatic_transition_is_recorded_as_the_last_completed_transition() {
        let mut t = NowTracker::new();
        t.on_track_started(p("a.wav"), 100);
        t.on_transition_started(p("a.wav"), p("b.wav"), Origin::Automatic, 200);
        t.on_transition_ended();
        let last = t.last_transition.as_ref().expect("automatic transition should be recorded");
        assert_eq!(last.from, p("a.wav"));
        assert_eq!(last.to, p("b.wav"));
        assert_eq!(last.origin, Origin::Automatic);
    }

    #[test]
    fn manual_transition_is_not_recorded_as_the_last_automatic_transition() {
        let mut t = NowTracker::new();
        t.on_track_started(p("a.wav"), 100);
        t.on_transition_started(p("a.wav"), p("b.wav"), Origin::Manual, 200);
        t.on_transition_ended();
        assert!(t.last_transition.is_none());
        // The title switch still happens; only the flag-worthy record does not.
        assert_eq!(t.now, Some(p("b.wav")));
    }

    #[test]
    fn audition_transition_is_not_recorded_as_the_last_automatic_transition() {
        let mut t = NowTracker::new();
        t.on_track_started(p("a.wav"), 100);
        t.on_transition_started(p("a.wav"), p("b.wav"), Origin::Audition, 200);
        t.on_transition_ended();
        assert!(t.last_transition.is_none());
        assert_eq!(t.now, Some(p("b.wav")));
    }

    #[test]
    fn restart_current_is_not_recorded_as_the_last_automatic_transition() {
        let mut t = NowTracker::new();
        t.on_track_started(p("a.wav"), 100);
        t.on_transition_started(p("a.wav"), p("a.wav"), Origin::Automatic, 200);
        t.on_transition_ended();
        assert!(t.last_transition.is_none());
        assert_eq!(t.now, Some(p("a.wav")));
    }

    #[test]
    fn transition_ended_without_one_in_progress_is_a_no_op() {
        let mut t = NowTracker::new();
        t.on_track_started(p("a.wav"), 100);
        let before_now = t.now.clone();
        let before_previous = t.previous.clone();
        assert!(t.on_transition_ended().is_none());
        assert_eq!(t.now, before_now);
        assert_eq!(t.previous, before_previous);
        assert!(t.last_transition.is_none());
    }
}

/// Shared "what is playing now" state. Written only by `events_thread` (the
/// dedicated drain thread, never the cpal callback — see `audio_thread`) and
/// read by `player_state`.
static NOW: Mutex<NowTracker> = Mutex::new(NowTracker::new());

/// Count of `PlaybackEvent`s the cpal callback could not hand to
/// `events_thread` because the channel (capacity 64) was full. Bumped with
/// `fetch_add` only — no logging — for the same reason `StallWatch` does not
/// log from inside the callback either. `audio_thread`'s idle loop reports
/// increases from here once a second; capacity 64 should never fill under
/// normal use, so any increase means a transition edge — and therefore a
/// potential ⚑ flag — was lost and is worth a warning.
static EVENTS_DROPPED: AtomicU64 = AtomicU64::new(0);

/// Incremented by one, with `fetch_add` only, at the very top of the cpal
/// data callback — before even the `paused` early return, since a paused
/// callback is still being invoked and that is exactly the fact this exists
/// to prove. `audio_thread`'s idle loop compares this against its own clock
/// (see `CallbackWatch`) to notice the one failure `StallWatch` cannot see
/// from inside the callback: the callback not running at all any more.
static CALLBACK_TICKS: AtomicU64 = AtomicU64::new(0);

/// Frames of the *main* engine rendered so far, bumped by one `fetch_add` in
/// the cpal callback right after `render`, guarded so it only counts buffers
/// the main engine produced (never the audition one). This — not the wall
/// clock — is the only correct basis for "how far into the current track has
/// playback gotten":
///
/// - paused buffers never reach the increment (the callback early-returns
///   before it), so a pause freezes this exactly when it should;
/// - while an audition `Engine` is installed the callback renders *it*
///   instead of the main engine (the main playhead is meant to freeze during
///   an audition — see `RenderState`), so this must not move either;
/// - a lost/reopening output device stops the callback from being invoked at
///   all, so this stays put through a disconnect too.
///
/// `player_state` reads this (via `events_thread`'s stamp, see
/// `NowTracker::now_started_frames`) to derive `PlayerState::position_secs`.
static MAIN_FRAMES: AtomicU64 = AtomicU64::new(0);

/// Mirrors `Engine::next_track_path().is_some()` for the *main* engine,
/// published from the same `if !audition` branch as `MAIN_FRAMES` above (and
/// for the same reason: this must reflect the main engine, not whichever
/// engine an audition happens to be rendering). `reorder`/`dequeue` read this
/// to decide whether the reserved slot has anything to revoke before
/// bothering to take the render lock, and `queue_state` reads it for
/// `QueueSnapshot::reserved_swappable`.
///
/// Freezes at whatever value it last held while an audition engine is
/// installed, since the branch that updates it does not run then — that is
/// fine here, because both readers already gate on `AUDITIONING` /
/// `AUDITION_PREPARING` separately and must not trust this value in that
/// window anyway.
///
/// Published with a plain atomic, not behind `render`'s `Mutex`: nothing in
/// the cpal callback may take a lock (see `render.try_lock()` above), so this
/// has to be readable by other threads without the callback ever blocking on
/// them, and writable by the callback without it ever blocking on a reader.
/// `player_state`'s 2 Hz poll landing on a lock the callback also wants is
/// exactly the failure mode this avoids — see the module-level warning on
/// `RenderState` and `open_output_stream`'s `try_lock`.
static NEXT_PREPARED: AtomicBool = AtomicBool::new(false);

/// Analysis worker yields while this is true: set at Start (`Phase::Starting`),
/// cleared in the cpal callback once the main engine's next slot is filled
/// (`NEXT_PREPARED`). Atomic-only so the callback never takes a lock.
static YIELD_FOR_LOADER: AtomicBool = AtomicBool::new(false);

/// Mirrors `Engine::frames_until_transition()` for the main engine, same
/// publish site and same audition-freezes caveat as `NEXT_PREPARED` above.
/// `u64::MAX` is the sentinel for "unknown" (covers both `Engine`'s own
/// `None` — no active deck — and the period before the callback has run even
/// once): readers must treat it as "no answer", not as a real frame count.
static FRAMES_UNTIL_TRANSITION: AtomicU64 = AtomicU64::new(u64::MAX);

/// Set by the cpal error callback; cleared by `audio_thread` when it drops a
/// lost stream before reopen. Read by `CallbackWatch` to let a genuine stream
/// error shorten how long a stall has to run before it is reported — see its
/// doc comment for why this alone never triggers a report.
static STREAM_ERROR_SEEN: AtomicBool = AtomicBool::new(false);

/// How long to wait after closing a lost stream (or a failed reopen) before
/// trying `open_output_stream` again. No retry cap — stay in `Disconnected`
/// until the device comes back.
const REOPEN_COOLDOWN: Duration = Duration::from_secs(2);

/// State owned by the audio callback across stream reopen. Held in
/// `Arc<Mutex<_>>` so `audio_thread` can drop and rebuild the cpal stream
/// without rebuilding the `Engine`. The main `engine` stays put while
/// `audition` is `Some` so the main playhead freezes (not rendered).
struct RenderState {
    engine: Engine,
    audition: Option<Engine>,
    stall: StallWatch,
    /// Edge-detects the end of a transition from `Engine::transition_frames_into`
    /// at buffer boundaries; see `PlaybackEvent::TransitionEnded` in the
    /// callback below. Tracks whichever engine the callback is rendering.
    was_in_transition: bool,
}

/// UNIX-epoch milliseconds of the last nav this app itself requested via
/// [`request_skip_next`], or `0` for "none pending". Lets `events_thread`
/// tell a listener's own skip apart from a `TransitionStarted` the engine
/// raised on its own, without the audio thread having to carry that
/// knowledge across the event channel itself.
static NAV_REQUESTED_MS: AtomicU64 = AtomicU64::new(0);

/// How long a nav mark in [`NAV_REQUESTED_MS`] stays valid. Not a real
/// deadline — a safety valve: `begin_nav` silently drops `TransitionToNext`
/// whenever `next_track` is `None` (see funkot-core `engine.rs`), and that is
/// not some rare edge case — it is true for a stretch after *every*
/// transition starts, until the loader has the following track ready again.
/// Tap skip during that window and the mark is never consumed by a matching
/// `TransitionStarted`; without an expiry it would stick around and mislabel
/// some later, unrelated automatic transition as manual. A false Manual only
/// keeps that automatic transition out of `last_transition` (the ⚑
/// candidate) — it does not affect what is displayed as playing.
const NAV_MARK_TTL: Duration = Duration::from_secs(10);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Ask the engine to transition to the next track, marking the request so
/// `events_thread` can attribute the resulting `TransitionStarted` to this
/// app rather than to the engine's own automatic mixing. Both places that can
/// ask for a skip — the `skip_next` command and the notification's
/// `onNativeControl` action 1 — go through this so the mark is never set in
/// one place and missed in the other.
fn request_skip_next() -> Result<(), String> {
    if AUDITIONING.load(Ordering::Relaxed) {
        return Err("skip is disabled while auditioning".into());
    }
    let playback = PLAYBACK.get().ok_or("not playing")?;
    NAV_REQUESTED_MS.store(now_ms(), Ordering::Relaxed);
    // A full channel (capacity 8) just means a nav is already queued; that is
    // normal under repeated taps and not an error worth surfacing.
    let _ = playback.nav_tx.try_send(NavAction::TransitionToNext);
    Ok(())
}

/// Whether a nav marked at `marked_ms` (`0` for "no mark") is still fresh
/// enough at `now_ms` to explain a `TransitionStarted` arriving now. Split out
/// from `resolve_nav_origin` as a pure function purely so the TTL arithmetic
/// can be unit-tested without going through the statics.
fn nav_origin(marked_ms: u64, now_ms: u64) -> Origin {
    if marked_ms != 0 && now_ms.saturating_sub(marked_ms) <= NAV_MARK_TTL.as_millis() as u64 {
        Origin::Manual
    } else {
        Origin::Automatic
    }
}

fn origin_label(origin: Origin) -> &'static str {
    match origin {
        Origin::Automatic => "automatic",
        Origin::Manual => "manual",
        Origin::Audition => "audition",
    }
}

#[cfg(test)]
mod nav_origin_tests {
    use super::*;

    #[test]
    fn no_mark_is_automatic() {
        assert_eq!(nav_origin(0, 1_000), Origin::Automatic);
    }

    #[test]
    fn a_mark_within_the_ttl_is_manual() {
        assert_eq!(nav_origin(1_000, 6_000), Origin::Manual);
    }

    #[test]
    fn a_mark_past_the_ttl_is_automatic() {
        let ttl_ms = NAV_MARK_TTL.as_millis() as u64;
        assert_eq!(nav_origin(1_000, 1_000 + ttl_ms + 1), Origin::Automatic);
    }

    #[test]
    fn a_mark_exactly_at_the_ttl_boundary_is_still_manual() {
        let ttl_ms = NAV_MARK_TTL.as_millis() as u64;
        assert_eq!(nav_origin(1_000, 1_000 + ttl_ms), Origin::Manual);
    }
}

/// Consumes the current nav mark (if any and still fresh) and reports what
/// origin the transition it is being asked about should be attributed to.
/// Consuming rather than peeking is what keeps a second, unrelated
/// `TransitionStarted` shortly after a skip from also being blamed on it.
fn resolve_nav_origin() -> Origin {
    let marked = NAV_REQUESTED_MS.swap(0, Ordering::Relaxed);
    nav_origin(marked, now_ms())
}

/// Basename only: title fallback in [`session_metadata_for`] when tags are
/// missing. Not used for anything that needs to identify a track uniquely —
/// use [`path_str`] for that.
fn file_name_str(path: &Path) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("?")
        .to_string()
}

/// UI-facing key for a track. Must stay in sync with `TrackRow::path` /
/// `QueueSnapshot`'s `to_string_lossy().into_owned()`, since the frontend
/// treats the two as the same map key.
fn path_str(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Raw embedded tags cached per path (probe once; sync/pause must not reopen).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct CachedTags {
    title: Option<String>,
    artist: Option<String>,
}

static TAG_CACHE: LazyLock<Mutex<HashMap<PathBuf, CachedTags>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Resolve MediaSession title/artist from optional `now` path + cached tags.
///
/// Blank (whitespace-only) tags are treated as absent. When `now` is set but
/// title is missing, falls back to [`file_name_str`]; artist falls back to `""`.
fn session_metadata_for(now: Option<&Path>, tags: &CachedTags) -> (String, String) {
    let Some(path) = now else {
        return ("funkot-player".to_string(), String::new());
    };
    let title = tags
        .title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| file_name_str(path));
    let artist = tags
        .artist
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_default();
    (title, artist)
}

fn probe_tags_inner(path: &Path) -> Result<CachedTags, String> {
    let (title, artist) = store::probe_audio_tags(path)?;
    Ok(CachedTags { title, artist })
}

/// Path-keyed tag cache. Successful probes (including "no tags") are stored;
/// I/O / probe errors are not, so a transient open failure can retry.
fn cached_tags_for(path: &Path) -> CachedTags {
    {
        let cache = TAG_CACHE.lock().unwrap();
        if let Some(tags) = cache.get(path) {
            return tags.clone();
        }
    }
    match probe_tags_inner(path) {
        Ok(tags) => {
            TAG_CACHE
                .lock()
                .unwrap()
                .insert(path.to_path_buf(), tags.clone());
            tags
        }
        Err(err) => {
            log::debug!("tag probe failed for {}: {err}", path.display());
            CachedTags::default()
        }
    }
}

/// Last resolved `(now path, title, artist)` so `currentTitle` / `currentArtist`
/// JNI see one consistent snapshot even when Kotlin calls them back-to-back.
static LAST_SESSION_META: Mutex<(Option<PathBuf>, String, String)> =
    Mutex::new((None, String::new(), String::new()));

/// Current MediaSession title/artist from `NOW.now` (+ path-cached tags).
fn session_metadata() -> (String, String) {
    let now = NOW.lock().unwrap().now.clone();
    {
        let last = LAST_SESSION_META.lock().unwrap();
        if last.0 == now {
            return (last.1.clone(), last.2.clone());
        }
    }
    let meta = match now.as_ref() {
        None => session_metadata_for(None, &CachedTags::default()),
        Some(path) => {
            let tags = cached_tags_for(path);
            session_metadata_for(Some(path.as_path()), &tags)
        }
    };
    *LAST_SESSION_META.lock().unwrap() = (now, meta.0.clone(), meta.1.clone());
    meta
}

/// Used by the Android `currentTitle` JNI entry; desktop builds only exercise
/// [`session_metadata_for`] in unit tests.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn notification_title() -> String {
    session_metadata().0
}

/// Used by the Android `currentArtist` JNI entry.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn notification_artist() -> String {
    session_metadata().1
}

#[cfg(test)]
mod session_metadata_tests {
    use super::*;

    #[test]
    fn tagged_title_and_artist() {
        let tags = CachedTags {
            title: Some("My Title".into()),
            artist: Some("The Artist".into()),
        };
        assert_eq!(
            session_metadata_for(Some(Path::new("/music/track.flac")), &tags),
            ("My Title".into(), "The Artist".into())
        );
    }

    #[test]
    fn missing_title_falls_back_to_file_name() {
        let tags = CachedTags {
            title: None,
            artist: Some("The Artist".into()),
        };
        assert_eq!(
            session_metadata_for(Some(Path::new("/music/track.wav")), &tags),
            ("track.wav".into(), "The Artist".into())
        );
    }

    #[test]
    fn without_now_falls_back() {
        let tags = CachedTags {
            title: Some("ignored".into()),
            artist: Some("ignored".into()),
        };
        assert_eq!(
            session_metadata_for(None, &tags),
            ("funkot-player".into(), String::new())
        );
    }

    #[test]
    fn blank_tags_treated_as_absent() {
        let tags = CachedTags {
            title: Some("   ".into()),
            artist: Some("\t".into()),
        };
        assert_eq!(
            session_metadata_for(Some(Path::new("/music/track.wav")), &tags),
            ("track.wav".into(), String::new())
        );
    }

    /// S2 regression: no tags → file name title, empty artist.
    #[test]
    fn untagged_uses_file_name() {
        assert_eq!(
            session_metadata_for(Some(Path::new("/music/track.wav")), &CachedTags::default()),
            ("track.wav".into(), String::new())
        );
    }
}

/// Drains the audio thread's event channel and folds it into [`NOW`]. Its own
/// thread rather than the UI's 500ms poll (`player_state`): Android suspends
/// the WebView's JS timers once the screen turns off, which is exactly the
/// "still playing, screen off" case this app exists for, so draining from
/// there would let events pile up past the channel's capacity instead of
/// just arriving late.
/// Drop audition-tagged events that arrive after [`resume_autodj`] cleared
/// [`AUDITIONING`]. Pure so the stale-after-resume rule is unit-testable.
fn is_stale_audition_event(audition: bool, auditioning: bool) -> bool {
    audition && !auditioning
}

/// Lock [`NOW`], unless this event is a stale audition event.
///
/// The [`AUDITIONING`] read has to happen *under* the `NOW` lock rather than
/// before it: `resume_autodj` clears the flag and restores parked titles while
/// holding this same lock, so a check made outside can pass, block on the
/// lock, and write the audition's titles over the restored ones.
fn lock_now_unless_stale(audition: bool) -> Option<std::sync::MutexGuard<'static, NowTracker>> {
    let now = NOW.lock().unwrap();
    if is_stale_audition_event(audition, AUDITIONING.load(Ordering::Relaxed)) {
        return None;
    }
    Some(now)
}

/// Drops everything in `SESSION.in_flight` before `now` and persists the
/// result. `now` is `NowTracker::now` right after a change — i.e. what just
/// became the actively-playing track — so this is "forget everything that
/// finished playing before it", leaving `now` itself (still playing, or at
/// least still owed to the listener if this is a reserved-but-not-started
/// entry) and anything reserved after it in place.
///
/// A no-op, on purpose, when `now` is `None` or is not found in `in_flight`:
/// `None` means nothing changed worth retiring over, and "not found" can
/// happen (the very first `TrackStarted` of a run races `on_reserved`'s own
/// push over the loader thread and the events thread — either can land
/// first) without meaning anything is wrong, so guessing at a retirement
/// here would risk dropping an entry that is still genuinely in flight.
///
/// Must never be called for an audition event (`audition == true`): an
/// audition's `now` is a title swapped into the same [`NOW`] tracker for the
/// audition's own two tracks (see `install_audition`/`resume_autodj`), not
/// anything that ever went through `HostSource`/`in_flight` — retiring
/// against it would either no-op (the common case) or, on an unlucky path
/// collision, discard real main-queue session state for a track the
/// audition never actually played to completion.
fn retire_in_flight_up_to(now: Option<&Path>) {
    let Some(now) = now else {
        return;
    };
    {
        let mut session = SESSION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(pos) = session.in_flight.iter().position(|p| p.as_path() == now) else {
            return;
        };
        session.in_flight.drain(..pos);
    }
    persist_session();
}

fn events_thread(rx: Receiver<PlaybackEvent>) {
    for ev in rx {
        match ev {
            PlaybackEvent::Engine {
                event: EngineEvent::TransitionStarted { from, to },
                audition,
            } => {
                // Origin from the send-time tag, not `AUDITIONING` — a delayed
                // audition event after resume must not look automatic/manual.
                let origin = if audition {
                    Origin::Audition
                } else {
                    resolve_nav_origin()
                };
                // Read `MAIN_FRAMES` here, on this thread, rather than
                // stamping it in the cpal callback and carrying it over the
                // channel: this keeps the callback's event payload and
                // `EngineEvent` itself untouched, at the cost of up to one
                // buffer + one channel hop (a few ms) of staleness. Position
                // is displayed to the second, so that is not observable.
                let at_frames = MAIN_FRAMES.load(Ordering::Relaxed);
                // Only an interrupt fold moves `now`; a plain TransitionStarted
                // leaves it alone, so sync only when the title would change.
                let (changed, now_path) = {
                    let Some(mut tracker) = lock_now_unless_stale(audition) else {
                        continue;
                    };
                    let before = tracker.now.clone();
                    tracker.on_transition_started(from, to, origin, at_frames);
                    (tracker.now != before, tracker.now.clone())
                };
                if changed {
                    service_sync_state();
                }
                // Never for an audition event — see `retire_in_flight_up_to`.
                if changed && !audition {
                    retire_in_flight_up_to(now_path.as_deref());
                }
            }
            PlaybackEvent::Engine {
                event: EngineEvent::TrackStarted { path, .. },
                audition,
            } => {
                // See the `MAIN_FRAMES` comment on the TransitionStarted arm
                // above — same reasoning applies here.
                let at_frames = MAIN_FRAMES.load(Ordering::Relaxed);
                let (changed, now_path) = {
                    let Some(mut tracker) = lock_now_unless_stale(audition) else {
                        continue;
                    };
                    let before = tracker.now.clone();
                    tracker.on_track_started(path, at_frames);
                    (tracker.now != before, tracker.now.clone())
                };
                if changed {
                    service_sync_state();
                }
                if changed && !audition {
                    retire_in_flight_up_to(now_path.as_deref());
                }
            }
            PlaybackEvent::Engine {
                event: EngineEvent::TrackFailed { path, message },
                ..
            } => {
                log::warn!("track failed: {} ({message})", path.display());
            }
            PlaybackEvent::Engine {
                event: EngineEvent::Finished,
                ..
            } => {
                log::info!("engine reports finished");
            }
            PlaybackEvent::TransitionEnded { audition } => {
                let (completed, changed, now_path) = {
                    let Some(mut tracker) = lock_now_unless_stale(audition) else {
                        continue;
                    };
                    let before = tracker.now.clone();
                    let completed = tracker.on_transition_ended();
                    let changed = tracker.now != before;
                    (completed, changed, tracker.now.clone())
                };
                if let Some((from, to, origin)) = completed {
                    log::info!(
                        "transition: {} -> {} ({})",
                        from.display(),
                        to.display(),
                        origin_label(origin)
                    );
                }
                if changed {
                    service_sync_state();
                }
                if changed && !audition {
                    retire_in_flight_up_to(now_path.as_deref());
                }
            }
        }
    }
}

#[cfg(test)]
mod stale_audition_event_tests {
    use super::*;

    #[test]
    fn audition_events_while_auditioning_are_kept() {
        assert!(!is_stale_audition_event(true, true));
    }

    #[test]
    fn audition_events_after_resume_are_dropped() {
        assert!(is_stale_audition_event(true, false));
    }

    #[test]
    fn main_engine_events_are_never_stale() {
        assert!(!is_stale_audition_event(false, false));
        assert!(!is_stale_audition_event(false, true));
    }
}

/// Open (or reopen) the default output device at the engine's sample rate.
///
/// Looks up `default_output_device` every call so a reconnect after Bluetooth
/// drop can see the device again. Uses `sample_rate` from Engine creation
/// (not the device's current default) and stereo / `BufferSize::Default`.
/// Sample format is f32, matching the first open.
fn open_output_stream(
    sample_rate: u32,
    render: Arc<Mutex<RenderState>>,
    paused: Arc<AtomicBool>,
    event_tx: SyncSender<PlaybackEvent>,
    err_log: Sender<String>,
) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| "no default output device".to_string())?;
    let supported = device
        .default_output_config()
        .map_err(|e| format!("default_output_config: {e}"))?;
    if supported.channels() != 2 {
        return Err(format!(
            "engine renders interleaved stereo; device wants {} ch",
            supported.channels()
        ));
    }
    let config = cpal::StreamConfig {
        channels: 2,
        sample_rate,
        buffer_size: cpal::BufferSize::Default,
    };
    let stream = device
        .build_output_stream(
            config,
            move |out: &mut [f32], _: &cpal::OutputCallbackInfo| {
                // First thing, unconditionally: this is the proof the callback is
                // still alive at all, including while paused. See
                // `CALLBACK_TICKS` and `CallbackWatch`.
                CALLBACK_TICKS.fetch_add(1, Ordering::Relaxed);
                // try_lock: never block the realtime callback on the audio
                // thread's reopen / drop path (same idea as funkot-cli ClipPlayer).
                let Ok(mut state) = render.try_lock() else {
                    out.fill(0.0);
                    return;
                };
                if paused.load(Ordering::Relaxed) {
                    out.fill(0.0);
                    state.stall.reset_silence();
                    set_phase(Phase::Paused);
                    return;
                }
                // Audition, when present, owns the callback; main is not
                // rendered so its playhead stays frozen until resume. Scoped
                // so the engine borrow ends before `stall` / `was_in_transition`.
                // Stamp `audition` at send time from this buffer's engine choice.
                let audition = state.audition.is_some();
                let (events, in_transition) = {
                    let engine = match state.audition.as_mut() {
                        Some(aud) => aud,
                        None => &mut state.engine,
                    };
                    let frames = engine.render(out);
                    let written = frames * 2;
                    if written < out.len() {
                        out[written..].fill(0.0);
                    }
                    // Only the main engine advances the playhead `player_state`
                    // reports as `position_secs` — see `MAIN_FRAMES`'s doc
                    // comment for why this must not run in the audition branch.
                    if !audition {
                        MAIN_FRAMES.fetch_add(frames as u64, Ordering::Relaxed);
                        // See `NEXT_PREPARED` / `FRAMES_UNTIL_TRANSITION`'s
                        // doc comments: atomic publish only, no lock, since
                        // this callback must never block on one.
                        let next_ready = engine.next_track_path().is_some();
                        NEXT_PREPARED.store(next_ready, Ordering::Relaxed);
                        if next_ready {
                            // First next-slot fill ends the Start→loader yield
                            // window; analysis may resume. Atomic only.
                            YIELD_FOR_LOADER.store(false, Ordering::Relaxed);
                        }
                        FRAMES_UNTIL_TRANSITION.store(
                            engine.frames_until_transition().unwrap_or(u64::MAX),
                            Ordering::Relaxed,
                        );
                    }
                    // The returned `Vec` drops here, on the audio thread, which
                    // frees it here too — not just allocates it here.
                    // `pending_events` already grows and gets collected on every
                    // transition, so neither the allocation nor this free is
                    // new work this adds; it is the engine's existing cost, and
                    // it happens only a few times per transition (a few times a
                    // minute at most), which is judged cheap enough for the
                    // callback.
                    let events = engine.poll_events();
                    // Edge-detects the end of a transition from
                    // `Engine::transition_frames_into` at buffer boundaries,
                    // since the engine has no event of its own for "the overlap
                    // just finished" (see `PlaybackEvent::TransitionEnded`). A
                    // nav that arrives *during* a transition makes the engine
                    // abort and immediately start a new one within the same
                    // `render` call, so this still reads `Some` afterwards and
                    // the edge for the interrupted transition is never seen
                    // here — only a second `TransitionStarted` arrives, with no
                    // `TransitionEnded` in between. That is a deliberate
                    // consequence of only sampling at buffer boundaries;
                    // `NowTracker::on_transition_started` is what actually
                    // copes with it, by folding the interrupted transition into
                    // the display the moment the second one starts rather than
                    // waiting for an end edge that will never come.
                    let in_transition = engine.transition_frames_into().is_some();
                    (events, in_transition)
                };
                // Bit-exact silence is the one signal a host gets that the
                // engine had nothing prepared for this buffer; see `StallWatch`.
                let silent = out.iter().all(|s| *s == 0.0);
                let total_frames = (out.len() / 2) as u64;
                let phase = state.stall.observe(total_frames, silent);
                set_phase(phase);

                for ev in events {
                    if event_tx
                        .try_send(PlaybackEvent::Engine {
                            event: ev,
                            audition,
                        })
                        .is_err()
                    {
                        EVENTS_DROPPED.fetch_add(1, Ordering::Relaxed);
                    }
                }
                if state.was_in_transition && !in_transition {
                    if event_tx
                        .try_send(PlaybackEvent::TransitionEnded { audition })
                        .is_err()
                    {
                        EVENTS_DROPPED.fetch_add(1, Ordering::Relaxed);
                    }
                }
                state.was_in_transition = in_transition;
            },
            move |e| {
                let m = format!("stream error: {e}");
                log::error!("{m}");
                let _ = err_log.send(m);
                STREAM_ERROR_SEEN.store(true, Ordering::Relaxed);
            },
            None,
        )
        .map_err(|e| format!("build_output_stream: {e}"))?;
    stream
        .play()
        .map_err(|e| format!("stream.play: {e}"))?;
    Ok(stream)
}

fn audio_thread(
    paths: Vec<PathBuf>,
    cache_dir: PathBuf,
    data_dir: PathBuf,
    log: Sender<String>,
    queue: SharedQueue,
    initial_paused: bool,
    // Where `DrainPolicy::ContinueFolder` resumes folder cycling — see
    // `store::restored_folder_pos`. Computed by `start_impl` (before `paths`
    // moves in here) rather than here, since the restored session's
    // `in_flight` it depends on lives there.
    folder_pos: usize,
) {
    macro_rules! say {
        ($($a:tt)*) => {{ let m = format!($($a)*); log::info!("{m}"); let _ = log.send(m); }};
    }

    let host = cpal::default_host();
    say!("host: {:?}", host.id());

    let device = match host.default_output_device() {
        Some(d) => d,
        None => {
            say!("FAIL: no default output device");
            set_phase(Phase::Failed);
            return;
        }
    };
    // cpal 0.18: Device is Display; there is no name() -> Result any more.
    say!("device: {device}");

    let supported = match device.default_output_config() {
        Ok(c) => c,
        Err(e) => {
            say!("FAIL: default_output_config: {e}");
            set_phase(Phase::Failed);
            return;
        }
    };
    // cpal 0.18: SampleRate/ChannelCount are plain u32/u16 aliases, not newtypes.
    say!(
        "config: {} ch, {} Hz, {:?}",
        supported.channels(),
        supported.sample_rate(),
        supported.sample_format()
    );

    if supported.channels() != 2 {
        say!("FAIL: engine renders interleaved stereo; device wants {} ch", supported.channels());
        set_phase(Phase::Failed);
        return;
    }

    // Fixed for the life of this Engine; reopen uses the same rate even if the
    // device's default sample rate has changed in the meantime.
    let sample_rate = supported.sample_rate();

    let mut options = EngineOptions::default();
    options.output_sample_rate = sample_rate;
    // Kept apart from `options.cache_dir` (which takes ownership below): the
    // C-3 loader-status log needs to hash and look up the cache itself, on
    // this same thread, to say whether the track `HostSource::next` just
    // reserved was already analyzed.
    let cache_dir_for_log = cache_dir.clone();
    options.cache_dir = cache_dir;

    // `options.loop_playlist` is not set here: `Engine::new_with_source`
    // never reads it (only `Engine::new`'s internal `PlaylistSource` does).
    // Looping once the host-managed queue drains is instead the job of
    // `DrainPolicy::ContinueFolder`, passed to `HostSource` below.
    //
    // Playing a track is the one way the pending queue shrinks without a
    // command running, so the source persists it too. Doing it here rather
    // than from `queue_state` is what makes it survive backgrounding: that
    // command only runs while the webview is polling, and the whole point of
    // this app is to keep playing with the screen off.
    let queue_dir = data_dir.clone();
    let cache_dir_for_skip = cache_dir_for_log.clone();
    let data_dir_for_skip = data_dir;
    // Cloned before `queue` moves into `HostSource::new` below: the
    // `on_pending_consumed` closure needs its own handle so it can re-read
    // the queue under `SAVE_LOCK` (see the closure body).
    let queue_for_save = Arc::clone(&queue);
    let source = HostSource::new(
        queue,
        DrainPolicy::ContinueFolder {
            tracks: paths,
            pos: folder_pos,
        },
    )
        .skip_folder_entry(Box::new(move |path| {
            if ALLOW_NON_FUNKOT.load(Ordering::Relaxed) {
                return false;
            }
            gated_non_funkot(path, &cache_dir_for_skip, &data_dir_for_skip)
        }))
        .on_pending_consumed(Box::new(move |_pending| {
            // Ignore the slice this observer is handed — it is a snapshot
            // `HostSource::next` took *after releasing the queue lock*
            // (see its own doc comment), so by the time this closure runs
            // it can already be stale. This observer only needs the fact
            // that a pop happened; it re-reads the queue itself, under
            // `SAVE_LOCK`, so the value it writes is exactly as fresh as
            // what a command's `persist_queue` would write, not whatever
            // `pending` happened to look like at pop time.
            //
            // That staleness is not hypothetical: `reorder`/`dequeue` can
            // now revoke `reserved` and hand it back to `pending` (see
            // `queue::edit_displayed`), which frees the loader permit this
            // very `next()` call was waiting on. So a command can run,
            // read+write the queue, and finish *before* this closure gets
            // around to taking `SAVE_LOCK` with the older slice it captured
            // at pop time — e.g. loader pops leaving `[b, c]`, the listener
            // deletes `b` (command writes `[c]`), and only then does this
            // closure take `SAVE_LOCK` and (if it still wrote `[b, c]`)
            // resurrect the just-deleted `b`. Re-reading under the lock
            // instead of trusting the captured slice is what rules that
            // out: whichever of this closure or a command's `persist_queue`
            // takes `SAVE_LOCK` second simply re-reads the queue fresh and
            // overwrites the file with the (correct) latest state.
            let _saving = SAVE_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let pending: VecDeque<PathBuf> = queue::snapshot(&queue_for_save).into_iter().collect();
            if let Err(e) = store::save_queue(&queue_dir, &pending) {
                log::warn!("save_queue({}): {e}", queue_dir.display());
            }
        }))
        .on_reserved(Box::new(move |path| {
            let analysis = funkot_core::cache::content_hash(path)
                .ok()
                .and_then(|h| analyzed_cache_entry(&cache_dir_for_log, &h))
                .is_some();
            let analysis = if analysis {
                "cached"
            } else {
                "missing"
            };
            log::info!(
                "loader: preparing {} (analysis: {analysis})",
                path.display()
            );
            // Record this as in-flight the moment it leaves `pending` (or
            // the folder-drain fallback), so a process death before it ever
            // finishes playing does not lose it — see `store::Session` and
            // `store::restored_pending`. Uses `DATA_DIR` (not `queue_dir`,
            // moved into the `on_pending_consumed` closure above and no
            // longer available here) — `start_impl` sets it before spawning
            // this thread, so it is always populated by the time the loader
            // makes its first call.
            {
                let mut session = SESSION
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                session.in_flight.push(path.to_path_buf());
            }
            persist_session();
        }));
    let mut engine = match Engine::new_with_source(options, Box::new(source)) {
        Ok(e) => e,
        Err(e) => {
            say!("FAIL: Engine::new_with_source: {e}");
            set_phase(Phase::Failed);
            return;
        }
    };
    // Never block in the audio callback.
    engine.set_realtime(true);
    say!("engine created");

    // Grab the nav sender before `engine` moves into `RenderState`, and publish
    // it with `render` / `paused` for Tauri commands and the notification's
    // JNI callback. Cold-start audition sets `initial_paused` so the main
    // engine never becomes audible before the audition engine is installed.
    let paused = Arc::new(AtomicBool::new(initial_paused));
    let nav_tx = engine.nav_sender();
    let render = Arc::new(Mutex::new(RenderState {
        engine,
        audition: None,
        stall: StallWatch::new(sample_rate),
        was_in_transition: false,
    }));
    let _ = PLAYBACK.set(Playback {
        paused: Arc::clone(&paused),
        nav_tx,
        render: Arc::clone(&render),
        sample_rate,
    });

    // Bounded, and drained on its own thread rather than by the caller of
    // `player_state` — see `events_thread`. 64 is generous for a channel
    // that only ever carries a handful of events per transition; a full
    // channel is reported via `EVENTS_DROPPED`, not blocked on, because this
    // sender lives in the cpal callback.
    //
    // `try_send` itself never blocks, but it is not lock-free either:
    // `events_thread` spends nearly all its time parked in `recv()`, and
    // waking a parked receiver is std's job, done by briefly taking an
    // internal `Mutex<Waker>` inside `sync_channel`. Uncontended (nothing
    // else is fighting over that mutex), that is a cheap userland
    // lock/unlock, and it only happens a few times per transition — a few
    // times a minute at most — which is judged cheap enough for this
    // callback. It is not the same "touches no lock at all" guarantee the
    // rest of the callback holds to; it is a bet that this particular,
    // rare, uncontended lock is fine.
    let (event_tx, event_rx) = mpsc::sync_channel::<PlaybackEvent>(64);
    if let Err(e) = std::thread::Builder::new()
        .name("funkot-events".into())
        .spawn(move || events_thread(event_rx))
    {
        log::warn!("spawn funkot-events: {e}");
    }

    let mut stream: Option<cpal::Stream> = match open_output_stream(
        sample_rate,
        Arc::clone(&render),
        Arc::clone(&paused),
        event_tx.clone(),
        log.clone(),
    ) {
        Ok(s) => Some(s),
        Err(e) => {
            say!("FAIL: {e}");
            set_phase(Phase::Failed);
            return;
        }
    };
    say!("PLAYING");

    // Hold the stream alive — it dies with this thread — and, while we are
    // here anyway, keep a log of when the output went quiet. `StallWatch`
    // works this out inside the cpal callback but must not do the logging
    // there; this thread has nothing else to do and can block freely.
    //
    // The pair of lines this writes is what identifies a stall after the
    // fact: read together with the "loader: preparing X (analysis: …)" line
    // above it, logcat says both that playback starved and what the loader
    // was busy with at the time.
    //
    // When the callback is lost, this loop drops the stream, clears
    // `STREAM_ERROR_SEEN`, and retries `open_output_stream` after
    // `REOPEN_COOLDOWN` until the device returns. Engine / queue / playhead
    // stay in `RenderState`.
    let mut stalled_since: Option<Instant> = None;
    // Last value seen from `EVENTS_DROPPED`, so the warning below reports
    // only the increase since the last check rather than the running total
    // every second.
    let mut events_dropped_seen = 0u64;
    // See `CallbackWatch`. Seeded from the current tick count rather than 0
    // so the first `observe` a second from now compares against a callback
    // that has actually had a chance to run, not a spurious jump from 0.
    // Recreated after each successful reopen.
    let mut cb_watch = CallbackWatch::new(CALLBACK_TICKS.load(Ordering::Relaxed));
    // Whether the last watchdog check already reported the callback lost, so
    // the log line below fires once, on the alive-to-lost edge, and not every
    // second the callback stays lost.
    let mut reported_lost = false;
    let mut retry_after: Option<Instant> = None;
    loop {
        // A second's granularity on a gap that runs for minutes. Kept coarse
        // on purpose: this thread lives for the whole listening session, and
        // the rest of the app goes out of its way not to wake a phone up for
        // no reason.
        std::thread::sleep(Duration::from_secs(1));

        // No open stream: stay Disconnected and retry reopen on the cooldown.
        // Do not set `Failed` — that is for the initial setup path only.
        if stream.is_none() {
            set_phase(Phase::Disconnected);
            let ready = retry_after
                .map(|t| Instant::now() >= t)
                .unwrap_or(true);
            if ready {
                // Reset silence *before* `play()` so the first buffers of the
                // new stream cannot observe a stale `silent_frames` count.
                // Safe: no callback is running while `stream` is `None`.
                if let Ok(mut state) = render.lock() {
                    state.stall.reset_silence();
                }
                match open_output_stream(
                    sample_rate,
                    Arc::clone(&render),
                    Arc::clone(&paused),
                    event_tx.clone(),
                    log.clone(),
                ) {
                    Ok(s) => {
                        cb_watch =
                            CallbackWatch::new(CALLBACK_TICKS.load(Ordering::Relaxed));
                        stream = Some(s);
                        reported_lost = false;
                        retry_after = None;
                        say!("output device reopened");
                    }
                    Err(e) => {
                        log::warn!("output device reopen failed: {e}");
                        retry_after = Some(Instant::now() + REOPEN_COOLDOWN);
                    }
                }
            }
            let dropped = EVENTS_DROPPED.load(Ordering::Relaxed);
            if dropped > events_dropped_seen {
                log::warn!(
                    "dropped {} playback event(s): the events channel (capacity 64) is full",
                    dropped - events_dropped_seen
                );
                events_dropped_seen = dropped;
            }
            continue;
        }

        // The callback check comes first because it decides how to read PHASE
        // below: once the callback is gone, PHASE is whatever this loop last
        // wrote, not a report from the engine.
        let lost = cb_watch.observe(
            CALLBACK_TICKS.load(Ordering::Relaxed),
            STREAM_ERROR_SEEN.load(Ordering::Relaxed),
        );
        // Skipped entirely while the callback is lost. `Disconnected` is not
        // `Stalled`, so leaving this to run would read the phase this loop
        // itself just wrote as "no longer stalled" and log a resume that never
        // happened — directly on top of the disconnect it is meant to help
        // diagnose.
        if !lost {
            match (get_phase() == Phase::Stalled, stalled_since) {
                (true, None) => {
                    log::warn!("output has gone silent: the engine has no prepared track ready");
                    stalled_since = Some(Instant::now());
                }
                (false, Some(since)) => {
                    log::info!("output resumed after {:.1}s of silence", since.elapsed().as_secs_f64());
                    stalled_since = None;
                }
                _ => {}
            }
        }
        // Capacity 64 should never fill under normal use; an increase here
        // means a transition edge — and therefore a potential ⚑ flag — was
        // lost, which is worth knowing about even though nothing can be done
        // about it after the fact.
        let dropped = EVENTS_DROPPED.load(Ordering::Relaxed);
        if dropped > events_dropped_seen {
            log::warn!(
                "dropped {} playback event(s): the events channel (capacity 64) is full",
                dropped - events_dropped_seen
            );
            events_dropped_seen = dropped;
        }
        // Callback gone (or error while stuck): close the stream and retry
        // reopen after cooldown. PHASE stays `Disconnected` until the data
        // callback's `set_phase` overwrites it — this loop must not write
        // `Playing` on a successful reopen.
        if lost {
            set_phase(Phase::Disconnected);
            if !reported_lost {
                log::error!(
                    "output device disconnected: closing stream and retrying reopen"
                );
                reported_lost = true;
            }
            // Drop *before* clearing the flag: stream drop joins cpal's worker
            // so the error callback finishes first.
            drop(stream.take());
            STREAM_ERROR_SEEN.store(false, Ordering::Relaxed);
            // Do not carry a pre-disconnect stall across reopen — otherwise the
            // next non-stalled buffer logs a silence duration that includes the
            // time the device was gone.
            stalled_since = None;
            retry_after = Some(Instant::now() + REOPEN_COOLDOWN);
        } else {
            reported_lost = false;
        }
    }
}

/// Whether `path` has one of the extensions the engine can decode.
fn is_supported_track(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|e| matches!(e.to_ascii_lowercase().as_str(),
            "wav" | "mp3" | "flac" | "m4a" | "ogg"))
        .unwrap_or(false)
}

/// What `take_pending_import` should do with one candidate path found in the
/// staging dir (`getCacheDir()/funkot-import/`).
#[cfg_attr(not(any(test, target_os = "android")), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
enum ImportDecision {
    /// `is_supported_track` does not recognise the extension — count towards
    /// `ImportResult::skipped`, do not copy.
    Skip,
    /// Copy the candidate to this path under `music_dir` (already resolved
    /// past any name collision).
    CopyTo(PathBuf),
}

/// Decides what to do with one path found in the staging dir, without
/// touching the filesystem beyond the injected `exists` check (same pattern
/// as `resolve_music_dir`'s `readable`).
///
/// Only `candidate`'s file name is used to build the destination — even if it
/// carries directory separators or `..` segments (defense in depth:
/// `Import.kt` already sanitises the display name it copies into the
/// cache-staged file, but this must not trust that unconditionally) — so the
/// result can never leave `music_dir`. A `candidate` with no file name at all
/// (e.g. `..` or `/`) is treated as unsupported.
///
/// Strips any leading dots from the stem before building the destination
/// name: `scan_tracks_into` skips dot-prefixed entries unconditionally, but
/// `is_supported_track` does not reject a dot-prefixed name (`.hidden.mp3`
/// still has a recognised `mp3` extension) — without this, such a file would
/// report as imported (`ImportResult::tracks`) and then never appear in the
/// library. If stripping leaves nothing before the extension, the candidate
/// is treated as unsupported.
///
/// On a name collision, appends a `" (2)"`, `" (3)"`, … suffix before the
/// extension, same convention as most desktop file managers, and never
/// overwrites an existing file.
#[cfg_attr(not(any(test, target_os = "android")), allow(dead_code))]
fn classify_import(
    candidate: &Path,
    music_dir: &Path,
    exists: impl Fn(&Path) -> bool,
) -> ImportDecision {
    if !is_supported_track(candidate) {
        return ImportDecision::Skip;
    }
    let Some(file_name) = candidate.file_name().and_then(|n| n.to_str()) else {
        return ImportDecision::Skip;
    };
    // Both `unwrap_or_default` fallbacks are unreachable in practice:
    // `is_supported_track` above only returns `true` once `Path::extension`
    // already did, and `Path::file_stem` returns `None` under the exact same
    // condition `extension` does (a name that is only a leading dot, e.g.
    // `.mp3`) — so once `is_supported_track` holds, both are `Some`. Kept as
    // fallbacks rather than an `unwrap`/`expect` purely to avoid a panic if
    // that invariant is ever wrong.
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    let ext = Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    let visible_stem = stem.trim_start_matches('.');
    if visible_stem.is_empty() {
        return ImportDecision::Skip;
    }
    let mut n: u32 = 1;
    loop {
        let name = if n == 1 {
            format!("{visible_stem}.{ext}")
        } else {
            format!("{visible_stem} ({n}).{ext}")
        };
        let dest = music_dir.join(&name);
        if !exists(&dest) {
            return ImportDecision::CopyTo(dest);
        }
        n += 1;
    }
}

/// Copies `src` into `music_dir` at `dest` atomically, through injected
/// `copy` / `rename` / `remove_tmp` operations so the failure path (the temp
/// file cleaned up, not left behind) is testable without touching the
/// filesystem — same pattern as `classify_import`'s `exists`. The real
/// [`copy_atomic`] is this wired to `std::fs`.
///
/// The temp file lives in `dest`'s own parent (i.e. inside `music_dir`), not
/// the staging dir: `fs::rename` is only atomic within one filesystem, and
/// `music_dir` (external storage) and the staging dir (`getCacheDir()`,
/// internal storage) are different mounts on Android.
#[cfg_attr(not(any(test, target_os = "android")), allow(dead_code))]
fn copy_atomic_with(
    src: &Path,
    dest: &Path,
    copy: impl FnOnce(&Path, &Path) -> std::io::Result<u64>,
    rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
    remove_tmp: impl FnOnce(&Path),
) -> std::io::Result<()> {
    let Some(parent) = dest.parent() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "dest has no parent",
        ));
    };
    let tmp = parent.join(".funkot-import.part");
    let result = copy(src, &tmp).and_then(|_bytes| rename(&tmp, dest));
    if result.is_err() {
        remove_tmp(&tmp);
    }
    result
}

/// Copies `src` into `music_dir` at `dest`. See [`copy_atomic_with`] for why
/// this goes through a temp file rather than `fs::copy` straight to `dest`:
/// a `fs::copy` that fails partway (or a concurrent `refresh_library` walk)
/// must never see a truncated file directly at `dest`, which
/// `scan_tracks_into` would otherwise pick up as a broken track to analyse,
/// or the library-list dedup keys off half-written bytes.
#[cfg(target_os = "android")]
fn copy_atomic(src: &Path, dest: &Path) -> std::io::Result<()> {
    // Wrapped in closures rather than passed as `std::fs::copy` /
    // `std::fs::rename` directly: a bare generic fn item only monomorphizes
    // to one concrete lifetime, which fails `copy_atomic_with`'s `for<'a>
    // FnOnce(&'a Path, ...)` bound ("implementation of `FnOnce` is not
    // general enough"); a closure lets inference produce the higher-ranked
    // signature instead.
    copy_atomic_with(
        src,
        dest,
        |from, to| std::fs::copy(from, to),
        |from, to| std::fs::rename(from, to),
        |tmp| {
            let _ = std::fs::remove_file(tmp);
        },
    )
}

#[cfg(test)]
mod import_tests {
    use super::*;

    #[test]
    fn classify_import_skips_an_unsupported_extension() {
        let music_dir = Path::new("/music");
        let decision = classify_import(Path::new("/cache/photo.jpg"), music_dir, |_| false);
        assert_eq!(decision, ImportDecision::Skip);
    }

    #[test]
    fn classify_import_avoids_overwriting_an_existing_file() {
        let music_dir = Path::new("/music");
        let decision = classify_import(Path::new("/cache/song.mp3"), music_dir, |p| {
            p == Path::new("/music/song.mp3")
        });
        assert_eq!(
            decision,
            ImportDecision::CopyTo(PathBuf::from("/music/song (2).mp3"))
        );
    }

    /// A second collision (both the plain name and the first `(2)` suffix
    /// already taken) must keep counting up rather than overwrite either.
    #[test]
    fn classify_import_keeps_counting_up_past_the_first_collision() {
        let music_dir = Path::new("/music");
        let decision = classify_import(Path::new("/cache/song.mp3"), music_dir, |p| {
            p == Path::new("/music/song.mp3") || p == Path::new("/music/song (2).mp3")
        });
        assert_eq!(
            decision,
            ImportDecision::CopyTo(PathBuf::from("/music/song (3).mp3"))
        );
    }

    /// The destination must never leave `music_dir`, even if the candidate
    /// path carries directory separators or `..` segments — only the file
    /// name is ever used to build it.
    #[test]
    fn classify_import_keeps_the_destination_inside_music_dir() {
        let music_dir = Path::new("/music");
        let decision = classify_import(Path::new("../../etc/song.mp3"), music_dir, |_| false);
        assert_eq!(
            decision,
            ImportDecision::CopyTo(PathBuf::from("/music/song.mp3"))
        );
    }

    /// `.hidden.mp3` must lose its leading dot in `music_dir`, or
    /// `scan_tracks_into` would silently hide the "imported" file forever.
    #[test]
    fn classify_import_strips_a_leading_dot() {
        let music_dir = Path::new("/music");
        let decision = classify_import(Path::new("/cache/.hidden.mp3"), music_dir, |_| false);
        assert_eq!(
            decision,
            ImportDecision::CopyTo(PathBuf::from("/music/hidden.mp3"))
        );
    }

    /// Extension matching is case-insensitive (`is_supported_track`), and the
    /// destination keeps the candidate's original casing.
    #[test]
    fn classify_import_accepts_an_uppercase_extension() {
        let music_dir = Path::new("/music");
        let decision = classify_import(Path::new("/cache/SONG.MP3"), music_dir, |_| false);
        assert_eq!(
            decision,
            ImportDecision::CopyTo(PathBuf::from("/music/SONG.MP3"))
        );
    }

    /// `.mp3` alone is a dotfile with no extension by `Path::extension`'s own
    /// rule (a name that is only a leading dot never has one) — must not be
    /// mistaken for a bare "mp3" file.
    #[test]
    fn classify_import_skips_a_bare_dotfile_extension() {
        let music_dir = Path::new("/music");
        let decision = classify_import(Path::new("/cache/.mp3"), music_dir, |_| false);
        assert_eq!(decision, ImportDecision::Skip);
    }

    /// Paths with no file name at all must not panic and must be treated as
    /// unsupported.
    #[test]
    fn classify_import_skips_paths_with_no_file_name() {
        let music_dir = Path::new("/music");
        assert_eq!(
            classify_import(Path::new("/"), music_dir, |_| false),
            ImportDecision::Skip
        );
        assert_eq!(
            classify_import(Path::new(".."), music_dir, |_| false),
            ImportDecision::Skip
        );
    }

    #[test]
    fn copy_atomic_with_removes_the_temp_file_on_copy_failure() {
        let removed = std::cell::Cell::new(None);
        let result = copy_atomic_with(
            Path::new("/staging/song.mp3"),
            Path::new("/music/song.mp3"),
            |_from, _to| {
                Err(std::io::Error::new(std::io::ErrorKind::Other, "boom"))
            },
            |_from, _to| Ok(()),
            |tmp| removed.set(Some(tmp.to_path_buf())),
        );
        assert!(result.is_err());
        assert_eq!(
            removed.into_inner(),
            Some(PathBuf::from("/music/.funkot-import.part"))
        );
    }

    #[test]
    fn copy_atomic_with_removes_the_temp_file_on_rename_failure() {
        let removed = std::cell::Cell::new(None);
        let result = copy_atomic_with(
            Path::new("/staging/song.mp3"),
            Path::new("/music/song.mp3"),
            |_from, _to| Ok(0),
            |_from, _to| Err(std::io::Error::new(std::io::ErrorKind::Other, "boom")),
            |tmp| removed.set(Some(tmp.to_path_buf())),
        );
        assert!(result.is_err());
        assert_eq!(
            removed.into_inner(),
            Some(PathBuf::from("/music/.funkot-import.part"))
        );
    }

    #[test]
    fn copy_atomic_with_leaves_the_temp_file_alone_on_success() {
        let removed = std::cell::Cell::new(false);
        let result = copy_atomic_with(
            Path::new("/staging/song.mp3"),
            Path::new("/music/song.mp3"),
            |_from, _to| Ok(0),
            |_from, _to| Ok(()),
            |_tmp| removed.set(true),
        );
        assert!(result.is_ok());
        assert!(!removed.get());
    }
}

/// Recursively walk `dir` for supported track files, sorted.
///
/// Symlinks (file or directory) are never followed — `DirEntry::file_type()`
/// reports the link itself rather than its target, so this is a plain
/// membership check rather than a stat of whatever the link points at. That
/// sidesteps having to detect symlink cycles, at the cost of not following
/// tracks or subfolders reached only via a link.
///
/// Dot-prefixed names (files and directories alike) are skipped, since
/// Android's MTP / thumbnail bookkeeping directories can end up inside the
/// Music folder.
///
/// The top-level `dir` itself must be readable, or this fails outright. A
/// subdirectory discovered during the walk that fails to read is instead
/// logged and skipped, so one broken subfolder cannot take the whole library
/// down with it.
fn scan_tracks(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    scan_tracks_into(entries, &mut paths);
    paths.sort();
    Ok(paths)
}

/// Walk one already-opened directory's entries into `paths`, recursing into
/// subdirectories. Read failures on a subdirectory are logged and skipped
/// rather than propagated — see [`scan_tracks`].
fn scan_tracks_into(entries: std::fs::ReadDir, paths: &mut Vec<PathBuf>) {
    for entry in entries.filter_map(|e| e.ok()) {
        let is_dotted = entry
            .file_name()
            .to_str()
            .map(|s| s.starts_with('.'))
            .unwrap_or(false);
        if is_dotted {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            match std::fs::read_dir(&path) {
                Ok(sub_entries) => scan_tracks_into(sub_entries, paths),
                Err(e) => log::warn!("cannot read {}: {e}", path.display()),
            }
        } else if file_type.is_file() && is_supported_track(&path) {
            paths.push(path);
        }
    }
}

/// `start_impl`'s "the audio thread is already up" error. Named because
/// `audition_transition` singles it out to fall through on, so it must not be
/// spelled out at both ends.
const ALREADY_STARTED: &str = "already started";

/// Start the main audio thread. `initial_paused` is for cold-start audition:
/// PLAYBACK is published paused so the main engine never becomes audible
/// before an audition engine is installed.
///
/// Restores both `pending` and `SESSION` from the previous run every time
/// this is called — including on a cold-start audition. That used to be
/// gated behind a `load_persisted_queue` argument, to keep cold-start
/// audition's pending queue empty while the loader served folder tracks
/// (`on_pending_consumed` only runs when something was actually taken from
/// `pending`, so leaving it empty kept `queue.json` untouched). That gate is
/// gone now: `store::restored_pending` folds `session.in_flight` in ahead of
/// `queue.json`'s own contents, so whatever the loader pops — pending or
/// folder-drain alike — is recorded via `on_reserved` and survives a crash
/// either way, and there is no longer a reason to suppress the restore.
/// Injection still happens exactly once, here, before the loader thread
/// starts pulling — not later from `resume_autodj`, which would still reorder
/// whatever the loader had already taken from the folder.
///
/// Idempotent by construction: `replace_pending` overwrites rather than
/// appends, so a caller that runs this twice back-to-back (the startup
/// preload in `run()`'s `setup`, then this same restore again) just
/// re-applies the same restored list, not a duplicate of it.
fn start_impl(
    music_dir: &str,
    cache_dir: &str,
    app: &tauri::AppHandle,
    state: &AppState,
    initial_paused: bool,
) -> Result<String, String> {
    let mut started = state.started.lock().unwrap();
    if *started {
        return Err(ALREADY_STARTED.into());
    }

    let dir = PathBuf::from(music_dir);
    let paths: Vec<PathBuf> = scan_tracks(&dir)?;

    if paths.len() < 2 {
        // Early error: nothing has been set up yet, so the phase is left at
        // whatever it already was (Idle, on a fresh launch).
        return Err(format!("need >= 2 tracks in {}, found {}", dir.display(), paths.len()));
    }

    let (tx, rx) = mpsc::channel();
    *state.log_rx.lock().unwrap() = Some(rx);
    let found = format!("{} tracks", paths.len());
    let cache = PathBuf::from(cache_dir);
    // Resolved here rather than taken as an argument: the webview passes the
    // music and cache paths because it displays them, but the data dir is
    // internal and it has no business naming it.
    let data = PathBuf::from(resolve_dirs(app)?.data_dir);
    // Published for the save paths that have no `AppHandle` of their own —
    // see `DATA_DIR`'s doc comment. Also set from `run()`'s `setup`, but that
    // runs first only when it succeeds (best-effort; Android's JNI context
    // may not be ready that early), so this is not redundant.
    let _ = DATA_DIR.set(data.clone());
    {
        let settings = store::load_settings(&data);
        ALLOW_NON_FUNKOT.store(settings.allow_non_funkot, Ordering::Relaxed);
    }

    // Restore whatever was still mid-flight or pending from a previous run
    // before the engine starts pulling from the queue. `in_flight` (tracks
    // `HostSource::next` had already popped but not finished playing) goes
    // first, then `queue.json`'s own contents — see `store::restored_pending`
    // for why order and de-duplication both matter here. `replace_pending`
    // overwrites rather than appends: anything queued in this process since
    // launch was already mirrored into `queue.json` by the command that
    // queued it, so appending would duplicate every entry queued before
    // start was pressed.
    let session = store::load_session(&data);
    let saved = store::load_queue(&data).unwrap_or_else(|e| {
        log::warn!("load_queue({}): {e}", data.display());
        Vec::new()
    });
    let restored = store::restored_pending(&session.in_flight, &saved, |p| p.exists());
    queue::replace_pending(&state.queue, restored);
    // Mirror the restored queue to `queue.json` *before* clearing
    // `SESSION.in_flight` below, not after: from here until that clear,
    // `queue.json` still doesn't list the tracks that were `in_flight` (they
    // only exist in memory now), while `session.json` still does. No save
    // site can currently race in and `persist_session()` during this window —
    // every path that reaches `flip_paused` (`toggle_pause`, the JNI
    // callback) requires `PLAYBACK.get()` to be `Some`, and `PLAYBACK.set` only
    // happens inside `audio_thread`, which is spawned after this function's
    // restore runs and while `state.started`'s guard is still held — but
    // fixing the order this way costs nothing either way, and it is the
    // difference between "no known window" and "silently reintroduced" the
    // next time a save site is added here. Writing `queue.json` first means
    // every track restored this run is always findable on disk in at least
    // one of the two files, however the process dies; on the next restore,
    // `restored_pending`'s own de-duplication absorbs a track landing in
    // both.
    persist_queue(app, state);
    // `in_flight` has now been folded back into `pending` above, so the
    // in-memory session starts this run with none still outstanding;
    // `on_reserved` repopulates it as the loader takes tracks back out.
    // Start means "play": do not carry over a previous run's pause. In-process
    // pause still goes through `flip_paused` → SESSION as before.
    {
        let mut s = SESSION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        s.in_flight = Vec::new();
        s.paused = false;
    }
    persist_session();
    // Where `DrainPolicy::ContinueFolder` resumes folder cycling — see
    // `store::restored_folder_pos`. Computed here, before `paths` moves into
    // `audio_thread` below, from `in_flight`'s *last* entry (the most
    // recently reserved track, whichever queue it came from).
    let folder_pos =
        store::restored_folder_pos(&paths, session.in_flight.last().map(PathBuf::as_path));
    let queue = Arc::clone(&state.queue);

    // Set before the audio thread starts: any in-flight analysis worker
    // (from `refresh_library`) holds off while the phase says `Starting`.
    set_phase(Phase::Starting);
    // Prefer playback/loader over background decode until the first next
    // slot is prepared (cleared in the cpal callback via `NEXT_PREPARED`).
    YIELD_FOR_LOADER.store(true, Ordering::Relaxed);

    // Use the caller's `initial_paused` only (normal Start: false; cold
    // audition: true). Do not OR in disk `session.paused` — Start is a play
    // intent, and cold audition mute is already expressed by the caller flag.
    if let Err(e) = std::thread::Builder::new()
        .name("funkot-audio".into())
        .spawn(move || audio_thread(paths, cache, data, tx, queue, initial_paused, folder_pos))
    {
        set_phase(Phase::Idle);
        YIELD_FOR_LOADER.store(false, Ordering::Relaxed);
        return Err(format!("spawn audio thread: {e}"));
    }

    service_set_running(true);

    *started = true;
    Ok(found)
}

#[tauri::command(async)]
fn start(
    music_dir: String,
    cache_dir: String,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    start_impl(&music_dir, &cache_dir, &app, &state, false)
}

/// How long cold-start audition waits for the audio thread to publish PLAYBACK.
const PLAYBACK_READY_TIMEOUT: Duration = Duration::from_secs(30);

fn wait_for_playback() -> Result<&'static Playback, String> {
    let deadline = Instant::now() + PLAYBACK_READY_TIMEOUT;
    loop {
        if let Some(p) = PLAYBACK.get() {
            return Ok(p);
        }
        if Instant::now() >= deadline {
            return Err("timed out waiting for playback to become ready".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Fast-forward a non-realtime audition engine to ~8 bars before A's outro.
fn fast_forward_audition(engine: &mut Engine, from: &PreparedTrack, bar_frames: f64) {
    let preroll = (8.0 * bar_frames).round() as u64;
    let target = from.outro_start_out.saturating_sub(preroll);
    let start_ph = from.first_downbeat_out.min(target);
    let mut remaining = target.saturating_sub(start_ph);
    let mut buf = vec![0.0f32; 65_536 * 2];
    while remaining > 0 {
        let chunk_frames = remaining.min(65_536) as usize;
        let written = engine.render(&mut buf[..chunk_frames * 2]);
        let _ = engine.poll_events();
        if written == 0 {
            break;
        }
        remaining = remaining.saturating_sub(written as u64);
    }
}

/// Build a two-track audition engine at `sample_rate`, fast-forwarded to the mix.
fn build_audition_engine(
    from_path: &Path,
    to_path: &Path,
    cache_dir: &Path,
    sample_rate: u32,
) -> Result<Engine, String> {
    let mut options = EngineOptions::default();
    options.output_sample_rate = sample_rate;
    options.cache_dir = cache_dir.to_path_buf();

    let paths = vec![from_path.to_path_buf(), to_path.to_path_buf()];
    let prepared = prepare_tracks_parallel(&options, &paths, 0)
        .map_err(|e| format!("prepare audition tracks: {e}"))?;
    if prepared.len() != 2 {
        return Err(format!(
            "expected 2 prepared tracks, got {}",
            prepared.len()
        ));
    }
    let from = prepared[0].clone();
    let bar_frames = options.bar_frames();

    let mut engine = Engine::from_prepared(options, prepared)
        .map_err(|e| format!("audition Engine::from_prepared: {e}"))?;
    engine.set_realtime(false);
    fast_forward_audition(&mut engine, &from, bar_frames);
    engine.set_realtime(true);
    Ok(engine)
}

fn install_audition(engine: Engine) -> Result<(), String> {
    let playback = PLAYBACK.get().ok_or("not playing")?;
    let first_install = !AUDITIONING.load(Ordering::Relaxed);
    // Park main-engine display only on the first install of a session. A
    // second install (「もう一度聴く」 while still auditioning) must not
    // snapshot the audition titles as if they were the main engine's.
    // Lock order: NOW before AUDITION_SESSION (never reverse).
    if first_install {
        let mut now = NOW.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut session = AUDITION_SESSION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        session.parked_now = now.now.clone();
        session.parked_previous = now.previous.clone();
        session.parked_in_progress = now.in_progress.clone();
        session.parked_now_started_frames = now.now_started_frames;
        now.in_progress = None;
    }
    // Raise the flag before the engine goes in: the callback can run the moment
    // the render lock is released, and `events_thread` drops audition-tagged
    // events while the flag is down.
    AUDITIONING.store(true, Ordering::Relaxed);
    let in_transition = engine.transition_frames_into().is_some();
    // Take any previous audition engine under the render lock, then drop it
    // after unlock so Engine teardown does not hold the realtime mutex.
    let previous = {
        let mut state = playback
            .render
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = state.audition.take();
        state.audition = Some(engine);
        state.was_in_transition = in_transition;
        state.stall.reset_silence();
        previous
    };
    drop(previous);
    playback.paused.store(false, Ordering::Relaxed);
    Ok(())
}

#[tauri::command(async)]
fn audition_transition(
    from_path: String,
    to_path: String,
    music_dir: String,
    cache_dir: String,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let from = PathBuf::from(&from_path);
    let to = PathBuf::from(&to_path);
    if !from.is_file() {
        return Err(format!("from track not found: {from_path}"));
    }
    if !to.is_file() {
        return Err(format!("to track not found: {to_path}"));
    }

    let cold_start = PLAYBACK.get().is_none();
    if cold_start {
        // Cold audition: paused main engine, restored pending/session same as
        // a normal `start` — `start_impl` no longer special-cases this (see
        // its doc comment for why suppressing the restore is not needed any
        // more). Another start can win the race — the ▶ button, or a second
        // audition press — because PLAYBACK is published only after the
        // engine is built, so `is_none()` stays true for seconds after
        // `start`. Waiting for that thread is right; failing here would leave
        // the button dead with no explanation. Pause the main engine as soon
        // as PLAYBACK is up, before `build_audition_engine` (which can take
        // seconds); otherwise a winning ▶ leaves `paused=false` and queue
        // audio leaks until `install_audition`.
        match start_impl(&music_dir, &cache_dir, &app, &state, true) {
            Ok(_) => {}
            Err(e) if e == ALREADY_STARTED => {}
            Err(e) => return Err(e),
        }
        wait_for_playback()?;
    }
    let playback = PLAYBACK.get().ok_or("not playing")?;
    // Mute + block pause for the whole prepare window (AUDITIONING is still
    // false until install). Pair goes in early so the UI banner can show.
    AUDITION_PREPARING.store(true, Ordering::Relaxed);
    playback.paused.store(true, Ordering::Relaxed);
    {
        let mut session = AUDITION_SESSION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        session.pair = Some((from.clone(), to.clone()));
    }
    let sample_rate = playback.sample_rate;

    let engine = match build_audition_engine(&from, &to, Path::new(&cache_dir), sample_rate) {
        Ok(engine) => engine,
        Err(e) => {
            AUDITION_PREPARING.store(false, Ordering::Relaxed);
            // Unmute whatever is installed — main queue, or the previous
            // audition when 「もう一度聴く」 prepare fails.
            playback.paused.store(false, Ordering::Relaxed);
            return Err(e);
        }
    };
    match install_audition(engine) {
        Ok(()) => {
            AUDITION_PREPARING.store(false, Ordering::Relaxed);
            Ok(())
        }
        Err(e) => {
            AUDITION_PREPARING.store(false, Ordering::Relaxed);
            playback.paused.store(false, Ordering::Relaxed);
            Err(e)
        }
    }
}

#[tauri::command]
fn resume_autodj() -> Result<(), String> {
    // Prepare still owns the session: NOW is not parked yet, and the in-flight
    // `audition_transition` would install after we returned. Refuse until
    // `AUDITION_PREPARING` clears.
    if AUDITION_PREPARING.load(Ordering::Relaxed) {
        return Err("audition still preparing".into());
    }
    let playback = PLAYBACK.get().ok_or("not playing")?;
    // Pause before teardown: `install_audition` leaves main unmuted, so taking
    // audition first lets main render TrackStarted into NOW; cold-start then
    // overwrites with None parked_now. Brief mute of audition audio is OK.
    playback.paused.store(true, Ordering::Relaxed);
    // Clear AUDITIONING and restore parked under the NOW lock together so a
    // queued audition TrackStarted cannot rewrite titles after restore
    // (`lock_now_unless_stale` re-checks the flag while holding NOW). Do this
    // before audition.take(). Lock order: NOW before AUDITION_SESSION.
    {
        let mut now = NOW.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        AUDITIONING.store(false, Ordering::Relaxed);
        let mut session = AUDITION_SESSION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        now.now = session.parked_now.take();
        now.previous = session.parked_previous.take();
        now.in_progress = session.parked_in_progress.take();
        now.now_started_frames = session.parked_now_started_frames.take();
    }
    // Take the audition engine under the render lock; drop it after unlock.
    let previous = {
        let mut state = playback
            .render
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = state.audition.take();
        state.was_in_transition = state.engine.transition_frames_into().is_some();
        state.stall.reset_silence();
        previous
    };
    drop(previous);
    service_sync_state();
    // Spec: resume returns to auto-DJ — including cold-start where main was
    // only ever paused under audition. `start_impl` already restored pending
    // and `SESSION` once, before the loader started pulling from either; do
    // not `load_queue` / `replace_pending` again here — the loader may
    // already have taken folder tracks in the meantime, and injecting pending
    // now would reorder them (same reasoning as `start_impl`'s doc comment).
    playback.paused.store(false, Ordering::Relaxed);
    // Unlike `install_audition`'s unmute or `audition_transition`'s
    // prepare-time mute/failure-unmute, this is the one place a `paused`
    // write here reflects the *listener's* intent: the main transport is
    // actually returning to playing, not just being muted/unmuted around a
    // volatile (never-persisted) `AUDITION_SESSION`. Mirror it into
    // `SESSION` so a restart does not come back paused just because the
    // listener last left via an audition.
    {
        let mut session = SESSION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        session.paused = false;
    }
    persist_session();
    Ok(())
}

#[tauri::command(async)]
fn audition_again(
    music_dir: String,
    cache_dir: String,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let (from, to) = {
        let session = AUDITION_SESSION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        session
            .pair
            .clone()
            .ok_or_else(|| "no audition pair to replay".to_string())?
    };
    audition_transition(
        from.to_string_lossy().into_owned(),
        to.to_string_lossy().into_owned(),
        music_dir,
        cache_dir,
        app,
        state,
    )
}

/// Drain whatever the audio thread has said so far.
#[tauri::command]
fn poll_log(state: tauri::State<AppState>) -> Vec<String> {
    let mut lines = state.lines.lock().unwrap();
    if let Some(rx) = state.log_rx.lock().unwrap().as_ref() {
        while let Ok(line) = rx.try_recv() {
            lines.push(line);
        }
    }
    lines.clone()
}

/// Flip the paused flag. Returns the new state.
#[tauri::command]
fn toggle_pause() -> Result<bool, String> {
    ensure_pause_allowed(
        AUDITIONING.load(Ordering::Relaxed),
        AUDITION_PREPARING.load(Ordering::Relaxed),
    )?;
    let playback = PLAYBACK.get().ok_or("not playing")?;
    let now_paused = flip_paused(&playback.paused);
    service_sync_state();
    Ok(now_paused)
}

/// Ask the engine to transition to the next track.
#[tauri::command]
fn skip_next() -> Result<(), String> {
    request_skip_next()
}

#[tauri::command]
fn is_paused() -> bool {
    PLAYBACK
        .get()
        .map(|p| p.paused.load(Ordering::Relaxed))
        .unwrap_or(false)
}

/// One completed transition, for display. See `NowTracker::last_transition`
/// for why this is only ever the last *automatic* one.
#[derive(serde::Serialize, Clone)]
struct TransitionInfo {
    /// Absolute path, same format as `TrackRow::path`.
    from: String,
    /// Absolute path, same format as `TrackRow::path`.
    to: String,
    automatic: bool,
    seconds_ago: f64,
}

/// What the UI paints. Cheap enough to poll twice a second.
#[derive(serde::Serialize, Clone)]
struct PlayerState {
    phase: &'static str,
    paused: bool,
    /// Absolute path, same format as `TrackRow::path`.
    now_playing: Option<String>,
    /// Absolute path, same format as `TrackRow::path`.
    previous: Option<String>,
    last_transition: Option<TransitionInfo>,
    auditioning: bool,
    audition_from: Option<String>,
    audition_to: Option<String>,
    /// Seconds the current track has been audible, from `MAIN_FRAMES`.
    ///
    /// This is *not* the position within the source file: the engine enters
    /// the next track partway into its intro (the entry offset) and leaves
    /// during its outro fade rather than at the very end, so this drifts
    /// from a file-relative position by roughly that entry offset and never
    /// reaches `duration_secs` at 100%. There is no seek in this app, so
    /// second-level precision is enough and this approximation is judged
    /// good enough to bar-chart.
    position_secs: Option<f64>,
    /// The current track's length *as played* — i.e. after the engine's
    /// tempo stretch (see `played_duration_secs`), not the raw file length.
    /// The raw (tag/analysis-cache) length would run 10-40% longer or
    /// shorter than what is actually heard, at which point `position_secs`
    /// would overtake it well before the track actually ends.
    duration_secs: Option<f64>,
}

fn audition_display_title(path: &Path) -> String {
    let tags = cached_tags_for(path);
    session_metadata_for(Some(path), &tags).0
}

/// How long `analysis`'s track plays for after the engine's tempo stretch,
/// mirroring the speed derivation in `funkot_core::engine::finish_prepare`
/// (`finish_prepare` is private to that crate, so this is a from-scratch
/// reimplementation of its formula, not a call into it — keep the two in
/// sync by hand if that formula ever changes).
///
/// `None` when `analysis.sample_rate` is `0` (an incomplete/stripped cache
/// entry — see `analyzed_cache_entry`), the only input that can make the
/// division undefined.
fn played_duration_secs(analysis: &funkot_core::TrackAnalysis) -> Option<f64> {
    if analysis.sample_rate == 0 {
        return None;
    }
    let source_secs = analysis.total_frames as f64 / analysis.sample_rate as f64;
    // Same fallback `finish_prepare` uses: an unmeasured/invalid intro BPM
    // stretches to the nominal tempo rather than dividing by something
    // useless.
    let intro_bpm = if analysis.intro_bpm.is_finite() && analysis.intro_bpm > 0.0 {
        analysis.intro_bpm
    } else {
        funkot_core::NOMINAL_BPM
    };
    // `EngineOptions::default()` is correct here because `audio_thread` only
    // ever overrides `output_sample_rate` and `cache_dir` from the default
    // (see `audio_thread`), never `rate` — so `target_bpm()` always matches
    // what the running engine actually stretches every track to. If a
    // future change makes the engine's rate configurable, this must read
    // that same value or `duration_secs` will silently drift from what is
    // actually heard.
    let speed = EngineOptions::default().target_bpm() / intro_bpm;
    Some(source_secs / speed)
}

#[cfg(test)]
mod played_duration_secs_tests {
    use super::*;

    fn analysis(sample_rate: u32, total_frames: u64, intro_bpm: f64) -> funkot_core::TrackAnalysis {
        funkot_core::TrackAnalysis {
            version: 0,
            file_name: "t.wav".into(),
            sample_rate,
            total_frames,
            intro_bpm,
            outro_bpm: intro_bpm,
            first_downbeat: 0,
            outro_start: 0,
            intro_bars: 0,
            track_bars: 0,
            outro_bars: 0,
            outro_structure_bars: 0,
            bars_estimated_low_confidence: false,
            intro_bars_low_confidence: false,
            outro_bars_low_confidence: false,
            intro_bars_manual: false,
            outro_bars_manual: false,
            outro_structure_bars_manual: false,
            needs_reanalysis: false,
            is_funkot: true,
            rms_dbfs: -14.0,
            gain_db: 0.0,
        }
    }

    #[test]
    fn sample_rate_zero_is_none() {
        assert_eq!(played_duration_secs(&analysis(0, 48_000, 180.0)), None);
    }

    #[test]
    fn scales_by_target_over_intro_bpm() {
        // 200s of source at 48kHz, intro at nominal 180 BPM: target is
        // 180 * 1.10 = 198, so speed = 198/180 = 1.1 and played length is
        // 200 / 1.1 ≈ 181.818s.
        let a = analysis(48_000, 48_000 * 200, 180.0);
        let got = played_duration_secs(&a).unwrap();
        assert!((got - 200.0 / 1.1).abs() < 1e-6, "got {got}");
    }

    #[test]
    fn non_finite_intro_bpm_falls_back_to_nominal() {
        let mut a = analysis(48_000, 48_000 * 200, f64::NAN);
        let with_nan = played_duration_secs(&a).unwrap();
        a.intro_bpm = funkot_core::NOMINAL_BPM;
        let with_nominal = played_duration_secs(&a).unwrap();
        assert_eq!(with_nan, with_nominal);
    }

    #[test]
    fn non_positive_intro_bpm_falls_back_to_nominal() {
        let mut a = analysis(48_000, 48_000 * 200, 0.0);
        let with_zero = played_duration_secs(&a).unwrap();
        a.intro_bpm = funkot_core::NOMINAL_BPM;
        let with_nominal = played_duration_secs(&a).unwrap();
        assert_eq!(with_zero, with_nominal);
    }
}

/// Last computed played-duration, keyed by the track it belongs to.
/// `player_state` is polled at 2 Hz and this costs a content hash (256 KiB of
/// I/O) plus a cache JSON read, so it must not run per poll. A `None` result
/// is memoised too — an unanalysed track would otherwise re-hash twice a
/// second forever.
static PLAYED_DURATION: Mutex<Option<(PathBuf, Option<f64>)>> = Mutex::new(None);

/// `played_duration_secs` for `now` (its *full* path — `NOW` holds full
/// paths, and `PlayerState::now_playing` is now a full path too), memoised
/// in `PLAYED_DURATION` so repeated polls of the
/// same track cost nothing after the first. Only a track change pays for the
/// content hash + cache read (and, on Android, the JNI round trip inside
/// `resolve_dirs` that a per-poll call would otherwise incur).
///
/// Neither `PLAYED_DURATION` nor (per the caller) `NOW` is held across this
/// function's own I/O.
fn played_duration_for(app: &tauri::AppHandle, now: &Path) -> Option<f64> {
    {
        let memo = PLAYED_DURATION.lock().unwrap();
        if let Some((path, secs)) = memo.as_ref() {
            if path == now {
                return *secs;
            }
        }
    }
    let dirs = resolve_dirs(app).ok()?;
    let cache_dir = PathBuf::from(dirs.cache_dir);
    let secs = funkot_core::cache::content_hash(now)
        .ok()
        .and_then(|h| analyzed_cache_entry(&cache_dir, &h))
        .and_then(|a| played_duration_secs(&a));
    *PLAYED_DURATION.lock().unwrap() = Some((now.to_path_buf(), secs));
    secs
}

#[tauri::command]
fn player_state(app: tauri::AppHandle) -> PlayerState {
    // Never hold NOW and AUDITION_SESSION together; never hold either across
    // the tag-probe I/O in `audition_display_title` or the cache I/O in
    // `played_duration_for`.
    let (now_playing, previous, last_transition, now_started_frames) = {
        let now = NOW.lock().unwrap();
        (
            now.now.clone(),
            now.previous.clone(),
            now.last_transition.as_ref().map(|t| TransitionInfo {
                from: path_str(&t.from),
                to: path_str(&t.to),
                automatic: t.origin == Origin::Automatic,
                seconds_ago: t.at.elapsed().as_secs_f64(),
            }),
            now.now_started_frames,
        )
    };
    let pair = {
        let session = AUDITION_SESSION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        session.pair.clone()
    };
    let (audition_from, audition_to) = match pair.as_ref() {
        Some((from, to)) => (
            Some(audition_display_title(from)),
            Some(audition_display_title(to)),
        ),
        None => (None, None),
    };
    let auditioning =
        AUDITIONING.load(Ordering::Relaxed) || AUDITION_PREPARING.load(Ordering::Relaxed);
    // While auditioning, `NOW` is parked and `now_playing` below is the
    // pre-audition main track — its position/duration would just be stale
    // (frozen at park time) if shown here, so withhold both rather than
    // paint a bar that looks live but is not moving for a reason the UI
    // cannot explain.
    let (position_secs, duration_secs) = if auditioning {
        (None, None)
    } else {
        match (now_playing.as_ref(), now_started_frames) {
            (Some(path), Some(started)) => {
                let position = PLAYBACK.get().and_then(|p| {
                    if p.sample_rate == 0 {
                        return None;
                    }
                    let frames = MAIN_FRAMES.load(Ordering::Relaxed);
                    Some(frames.saturating_sub(started) as f64 / p.sample_rate as f64)
                });
                let duration = played_duration_for(&app, path);
                (position, duration)
            }
            _ => (None, None),
        }
    };
    PlayerState {
        phase: get_phase().as_str(),
        paused: is_paused(),
        now_playing: now_playing.as_deref().map(path_str),
        previous: previous.as_deref().map(path_str),
        last_transition,
        auditioning,
        audition_from,
        audition_to,
        position_secs,
        duration_secs,
    }
}

/// Result of recording the last automatic transition as a bad mix.
#[derive(serde::Serialize, Clone)]
struct FlagResult {
    from_title: String,
    to_title: String,
    count: u32,
}

/// Record `NowTracker::last_transition` into `flags.json`. Playback is
/// untouched: no nav, pause, or engine call.
///
/// `record_undo` is true for the in-app button (toast 取消). The notification
/// path passes false so a background ⚑ cannot steal the toast's undo target.
fn flag_last_transition_impl(data_dir: &Path, record_undo: bool) -> Result<FlagResult, String> {
    let (from, to) = {
        let now = NOW.lock().unwrap();
        let t = now
            .last_transition
            .as_ref()
            .ok_or_else(|| "no transition to flag".to_string())?;
        (t.from.clone(), t.to.clone())
    };

    let from_hash = funkot_core::cache::content_hash(&from)
        .map_err(|e| format!("cannot hash {}: {e}", from.display()))?;
    let to_hash = funkot_core::cache::content_hash(&to)
        .map_err(|e| format!("cannot hash {}: {e}", to.display()))?;

    let from_title = {
        let tags = cached_tags_for(&from);
        session_metadata_for(Some(from.as_path()), &tags).0
    };
    let to_title = {
        let tags = cached_tags_for(&to);
        session_metadata_for(Some(to.as_path()), &tags).0
    };

    let key = store::flag_key(&from_hash, &to_hash);

    // Unlike `set_bars` (warn-and-succeed), a failed write here must not
    // advertise success: the toast offers undo, and undoing a count that
    // never landed on disk would silently drop an older flag.
    let count = {
        let _saving = SAVE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut flags = store::load_flags(data_dir);
        let entry = flags.entry(key.clone()).or_insert(store::TransitionFlag {
            count: 0,
            last_flagged_ms: 0,
        });
        entry.count = entry.count.saturating_add(1);
        entry.last_flagged_ms = now_ms();
        let count = entry.count;
        store::save_flags(data_dir, &flags).map_err(|e| format!("cannot persist flags: {e}"))?;
        // Re-flagging clears dismiss hides for this pair's two list rows.
        let mut dismissed = store::load_dismissed(data_dir);
        dismissed.remove(&store::dismiss_key(&from_hash, "outgoing"));
        dismissed.remove(&store::dismiss_key(&to_hash, "incoming"));
        store::save_dismissed(data_dir, &dismissed)
            .map_err(|e| format!("cannot persist dismissed: {e}"))?;
        if record_undo {
            *LAST_FLAG_UNDO
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(key);
        }
        count
    };

    Ok(FlagResult {
        from_title,
        to_title,
        count,
    })
}

#[tauri::command(async)]
fn flag_last_transition(app: tauri::AppHandle) -> Result<FlagResult, String> {
    let dirs = resolve_dirs(&app)?;
    flag_last_transition_impl(Path::new(&dirs.data_dir), true)
}

/// List flagged transitions aggregated by track × role for the edit tab.
///
/// Loads `flags.json` under `SAVE_LOCK`, scans `music_dir` for hash→meta
/// (title / artist / low-confidence), then returns [`store::aggregate_flags`].
/// Does not start analysis or mutate flags.
#[tauri::command(async)]
fn list_flagged_tracks(app: tauri::AppHandle) -> Result<Vec<store::FlaggedTrackRow>, String> {
    let dirs = resolve_dirs(&app)?;
    let data_dir = PathBuf::from(&dirs.data_dir);
    let music_dir = PathBuf::from(&dirs.music_dir);
    let cache_dir = PathBuf::from(&dirs.cache_dir);

    let (flags, dismissed) = {
        let _saving = SAVE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (store::load_flags(&data_dir), store::load_dismissed(&data_dir))
    };

    let paths: Vec<PathBuf> = scan_tracks(&music_dir)?;
    let overrides = store::load_overrides(&data_dir);

    let mut meta_by_hash = std::collections::BTreeMap::new();
    for path in &paths {
        let Ok(hash) = funkot_core::cache::content_hash(path) else {
            continue;
        };
        // Same path/bars/manual/analyzed sources as the library table.
        let row = track_row(path, &cache_dir, &overrides, Some(&hash), None);
        meta_by_hash.insert(
            hash,
            store::FlagTrackMeta {
                title: row.title,
                artist: row.artist,
                intro_low_confidence: row.intro_low_confidence,
                outro_low_confidence: row.outro_low_confidence,
                path: Some(row.path),
                intro_bars: row.intro_bars,
                outro_structure_bars: row.outro_structure_bars,
                outro_bars: row.outro_bars,
                intro_manual: row.intro_manual,
                outro_manual: row.outro_manual,
                analyzed: row.analyzed,
            },
        );
    }

    Ok(store::aggregate_flags(&flags, &meta_by_hash, &dismissed))
}

/// Hide one track×role row from the flagged list (`outgoing` / `incoming`).
///
/// Writes `dismissed.json` only — `flags.json` is unchanged. Returns `1` when
/// a new dismiss key was recorded (and arms undo); `0` when already dismissed
/// or `role` is not a known value (undo slot left alone).
#[tauri::command(async)]
fn dismiss_flags(
    app: tauri::AppHandle,
    track_hash: String,
    role: String,
) -> Result<u32, String> {
    let dirs = resolve_dirs(&app)?;
    let data_dir = PathBuf::from(&dirs.data_dir);

    if role != "outgoing" && role != "incoming" {
        return Ok(0);
    }

    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut dismissed = store::load_dismissed(&data_dir);
    let key = store::dismiss_key(&track_hash, &role);
    if !dismissed.insert(key.clone()) {
        // Already dismissed — do not clobber a previous toast's undo target.
        return Ok(0);
    }
    store::save_dismissed(&data_dir, &dismissed)
        .map_err(|e| format!("cannot persist dismissed: {e}"))?;
    *LAST_DISMISS_UNDO
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(key);
    Ok(1)
}

/// Restore the dismiss key last written by [`dismiss_flags`] (single-shot).
#[tauri::command(async)]
fn undo_last_dismiss(app: tauri::AppHandle) -> Result<(), String> {
    let dirs = resolve_dirs(&app)?;
    let data_dir = PathBuf::from(&dirs.data_dir);

    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let key = {
        let slot = LAST_DISMISS_UNDO
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        slot.clone().ok_or_else(|| "nothing to undo".to_string())?
    };

    let mut dismissed = store::load_dismissed(&data_dir);
    dismissed.remove(&key);
    store::save_dismissed(&data_dir, &dismissed)
        .map_err(|e| format!("cannot persist dismissed: {e}"))?;
    *LAST_DISMISS_UNDO
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    Ok(())
}

/// Undo the most recent `flag_last_transition` (single-shot).
#[tauri::command(async)]
fn undo_last_flag(app: tauri::AppHandle) -> Result<(), String> {
    let dirs = resolve_dirs(&app)?;
    let data_dir = PathBuf::from(&dirs.data_dir);

    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let key = {
        let slot = LAST_FLAG_UNDO
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        slot.clone().ok_or_else(|| "nothing to undo".to_string())?
    };

    let mut flags = store::load_flags(&data_dir);
    match flags.get(&key).map(|e| e.count) {
        Some(0 | 1) => {
            flags.remove(&key);
        }
        Some(_) => {
            flags.get_mut(&key).expect("key present").count -= 1;
        }
        None => {}
    }
    store::save_flags(&data_dir, &flags).map_err(|e| format!("cannot persist flags: {e}"))?;
    // Only consume the undo token after the write lands, so a failed save
    // leaves the toast's 取消 usable.
    *LAST_FLAG_UNDO
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    Ok(())
}

/// The minimum time-until-transition (`QueueSnapshot::transition_in_secs`)
/// `reorder`/`dequeue` accept an edit that revokes `reserved` for. Below
/// this, `QueueSnapshot::reserved_swappable` is `false` and the UI disables
/// the operation rather than let the listener hit a doomed `"too_late"`.
///
/// Revoking `reserved` makes the loader decode and time-stretch its
/// replacement from scratch; measured at ~8s for a full stretch on a Pixel 8
/// Pro debug APK (`[profile.dev.package."*"] opt-level = 2`; see
/// `funkot-autodj-for-ui`'s AGENTS.md, "モバイル (Android) ビルド" section).
/// 30s leaves headroom for a longer track. Erring low just costs some
/// editable seconds — `edit_displayed` still refuses the edit safely if the
/// deadline is missed. Erring high is worse: the engine can reach its outro
/// with nothing prepared, and the resulting wait for the replacement can
/// leave the mix without the next track's intro to layer under it (a
/// listener hears the outro run out solo).
const SWAP_DEADLINE_SECS: f64 = 30.0;

/// Snapshot of the playback queue, for the UI.
#[derive(serde::Serialize, Clone)]
struct QueueSnapshot {
    /// Reserved = already handed to the engine to play next.
    reserved: Option<String>,
    /// Waiting queue; its head is "reserved's successor".
    pending: Vec<String>,
    /// Whether `reorder`/`dequeue` would currently accept an edit that
    /// reaches into the `reserved` slot (`Move`/`Remove` at displayed index
    /// `0`, or `Move { to: 0, .. }`). `false` while: nothing is reserved; an
    /// audition is running or still preparing (the main engine's runway is
    /// frozen then — see `NEXT_PREPARED`/`FRAMES_UNTIL_TRANSITION`); the
    /// loader hasn't finished preparing `reserved`'s eventual replacement yet
    /// (`NEXT_PREPARED` false right after a transition — revoking now would
    /// have nothing to give back, and whatever the loader is mid-preparing
    /// would land moments later as an unwanted substitute); or
    /// `transition_in_secs` has dropped to or below `SWAP_DEADLINE_SECS`.
    reserved_swappable: bool,
    /// Whether the engine has actually finished preparing `reserved` for
    /// playback. `false` right after a transition or right after `reserved`
    /// is replaced (decode/time-stretch is still running) — the UI shows
    /// "準備中" during that window.
    ///
    /// Distinct from `reserved_swappable`: that one is "would an edit be
    /// accepted right now", which also folds in the swap deadline. This one
    /// is only about preparation having completed.
    ///
    /// Also distinct in how it behaves during audition/pause: `NEXT_PREPARED`
    /// (see its doc comment) freezes at whatever it last held while auditioning
    /// or paused, since the branch that updates it does not run then. Reporting
    /// that frozen value verbatim here would leave "準備中" stuck on screen for
    /// the whole audition/pause, so this field reads as prepared (`true`) in
    /// both states instead.
    reserved_prepared: bool,
    /// Seconds until the active track's automatic transition may begin, or
    /// `null` when unknown: stopped, auditioning/preparing an audition, or no
    /// active deck yet.
    transition_in_secs: Option<f64>,
}

/// Save the queue's current pending contents to `queue.json`. Failure is
/// logged, not propagated: the in-memory queue mutation already succeeded,
/// and losing the on-disk mirror is not worth failing the caller's command
/// over.
fn persist_queue(app: &tauri::AppHandle, state: &AppState) {
    let data_dir = match resolve_dirs(app) {
        Ok(d) => PathBuf::from(d.data_dir),
        Err(e) => {
            log::warn!("save_queue: cannot resolve data dir: {e}");
            return;
        }
    };
    // Snapshot and write under one lock, so concurrent commands cannot write
    // out of order; see `SAVE_LOCK`. Poisoning is not a concern: nothing under
    // this guard can panic in a way that leaves shared state half-updated, so
    // recovering the guard is better than taking the app down over a stale
    // mirror.
    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let pending: VecDeque<PathBuf> = queue::snapshot(&state.queue).into_iter().collect();
    if let Err(e) = store::save_queue(&data_dir, &pending) {
        log::warn!("save_queue({}): {e}", data_dir.display());
    }
}

/// Append `path` to the tail of the pending queue. Returns the pending
/// queue's length after the insert.
///
/// Rejects with `"non_funkot"` when the track is analysed, effectively
/// non-Funkot, and `allow_non_funkot` is false. Unanalysed tracks always
/// pass. Tracks already in the queue are never removed by this gate.
#[tauri::command(async)]
fn enqueue(path: String, app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<usize, String> {
    let dirs = resolve_dirs(&app)?;
    let path_buf = PathBuf::from(&path);
    if !ALLOW_NON_FUNKOT.load(Ordering::Relaxed)
        && gated_non_funkot(
            &path_buf,
            Path::new(&dirs.cache_dir),
            Path::new(&dirs.data_dir),
        )
    {
        return Err("non_funkot".into());
    }
    let len = queue::enqueue(&state.queue, path_buf);
    persist_queue(&app, &state);
    Ok(len)
}

/// Current `allow_non_funkot` setting (also mirrors [`ALLOW_NON_FUNKOT`]).
#[tauri::command(async)]
fn get_allow_non_funkot(app: tauri::AppHandle) -> Result<bool, String> {
    let dirs = resolve_dirs(&app)?;
    let allow = store::load_settings(Path::new(&dirs.data_dir)).allow_non_funkot;
    ALLOW_NON_FUNKOT.store(allow, Ordering::Relaxed);
    Ok(allow)
}

/// Persist `allow_non_funkot` and update the live atomic used by folder drain.
#[tauri::command(async)]
fn set_allow_non_funkot(app: tauri::AppHandle, allow: bool) -> Result<bool, String> {
    let dirs = resolve_dirs(&app)?;
    let data = Path::new(&dirs.data_dir);
    let mut settings = store::load_settings(data);
    settings.allow_non_funkot = allow;
    store::save_settings(data, &settings)
        .map_err(|e| format!("cannot save settings: {e}"))?;
    ALLOW_NON_FUNKOT.store(allow, Ordering::Relaxed);
    Ok(allow)
}

/// `queue::edit_displayed`'s `revoke` argument for the main engine: hands
/// back `Engine::next_track_path`'s track, or `None` if there is nothing left
/// to take back.
///
/// Holds `playback.render`'s lock only long enough to call
/// `Engine::revoke_next` — a few microseconds. The discarded
/// `PreparedTrack`'s actual teardown happens on a separate thread
/// (`retire_prepared`, funkot-core `engine.rs`), specifically so this call
/// does not have to wait on it. This is the same lock the cpal callback
/// takes with `try_lock` (`open_output_stream`), so — exactly as with
/// `install_audition`/`resume_autodj` swapping the audition engine in and
/// out — it is possible, if unlikely, for one audio buffer to lose that race
/// and render silence.
///
/// Returns `None` (which `edit_displayed` turns into `EditError::TooLate`)
/// if the main engine has not started yet, or if an audition engine is
/// currently installed: `RenderState::audition` is what the callback is
/// actually rendering then, so the main engine's `next_track` cannot
/// meaningfully be revoked out from under it.
///
/// Re-checks `AUDITIONING`/`AUDITION_PREPARING` here, after taking the render
/// lock, rather than trusting `reorder`/`dequeue`'s own entry check: those
/// flags and `RenderState::audition` do not flip atomically together.
/// `install_audition` sets `AUDITIONING` *before* it takes the render lock to
/// install the engine, so a caller that got past the entry check could still
/// find `state.audition` empty here and revoke anyway — a harmless but
/// unintended extra re-decode. The reverse order is also possible in
/// principle (an audition engine landing in `RenderState` a moment before
/// its flag is set), so both the flags and `state.audition.is_some()` are
/// checked, and either one alone is enough to refuse.
fn revoke_reserved() -> Option<PathBuf> {
    let playback = PLAYBACK.get()?;
    let mut state = playback
        .render
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if state.audition.is_some()
        || AUDITIONING.load(Ordering::Relaxed)
        || AUDITION_PREPARING.load(Ordering::Relaxed)
    {
        return None;
    }
    let path = state.engine.revoke_next();
    if path.is_some() {
        NEXT_PREPARED.store(false, Ordering::Relaxed);
    }
    path
}

/// Move an item within the *displayed* queue list (`[reserved?] ++ pending`;
/// index `0` is `reserved` when present — matches `QueueSnapshot` and
/// `queue::QueueEdit`'s doc comment). `expect` must be the path currently
/// shown at `from`, so a caller acting on a stale view is rejected instead of
/// moving whatever now happens to be there.
///
/// Errors are one of `queue::EditError::as_str`'s codes (`"too_late"` /
/// `"stale"` / `"out_of_range"`), or `"auditioning"` while an audition is
/// running or still preparing. `src/lib/tauri.ts` and `src/lib/state.svelte.ts`
/// match on these exact strings to choose a Japanese toast message — keep
/// this contract in sync on both sides; changing one without the other fails
/// silently (an unrecognised code just falls through to a generic message).
#[tauri::command(async)]
fn reorder(
    from: usize,
    to: usize,
    expect: String,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    if AUDITIONING.load(Ordering::Relaxed) || AUDITION_PREPARING.load(Ordering::Relaxed) {
        return Err("auditioning".into());
    }
    // `revoke_reserved`'s return value, captured here so it can be applied to
    // `SESSION.in_flight` after `edit_displayed` returns and both the queue
    // and render locks it was called under are released — see
    // `store::retire_revoked`'s doc comment for why this matters (otherwise a
    // restart brings the reordered-away track right back).
    let mut revoked: Option<PathBuf> = None;
    queue::edit_displayed(
        &state.queue,
        QueueEdit::Move { from, to },
        Path::new(&expect),
        || {
            let path = revoke_reserved();
            revoked = path.clone();
            path
        },
    )
    .map_err(|e| e.as_str().to_string())?;
    if let Some(path) = revoked {
        {
            let mut session = SESSION
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            store::retire_revoked(&mut session.in_flight, &path);
        }
        persist_session();
    }
    persist_queue(&app, &state);
    Ok(())
}

/// Remove the item at displayed index `index` (see `reorder`'s doc comment
/// for what "displayed" means and the error-code contract with the
/// frontend). `expect` must be the path currently shown there.
///
/// Returns the removed path on success — `edit_displayed` only succeeds once
/// it has confirmed the path at `index` equals `expect`, so `expect` itself
/// is that path.
#[tauri::command(async)]
fn dequeue(
    index: usize,
    expect: String,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    if AUDITIONING.load(Ordering::Relaxed) || AUDITION_PREPARING.load(Ordering::Relaxed) {
        return Err("auditioning".into());
    }
    // See `reorder`'s matching comment: `revoke_reserved`'s result is applied
    // to `SESSION.in_flight` only after `edit_displayed` returns, once the
    // queue/render locks it ran under are released.
    let mut revoked: Option<PathBuf> = None;
    queue::edit_displayed(
        &state.queue,
        QueueEdit::Remove { index },
        Path::new(&expect),
        || {
            let path = revoke_reserved();
            revoked = path.clone();
            path
        },
    )
    .map_err(|e| e.as_str().to_string())?;
    if let Some(path) = revoked {
        {
            let mut session = SESSION
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            store::retire_revoked(&mut session.in_flight, &path);
        }
        persist_session();
    }
    persist_queue(&app, &state);
    Ok(expect)
}

/// Current queue contents, for the UI to render.
#[tauri::command]
fn queue_state(state: tauri::State<AppState>) -> Result<QueueSnapshot, String> {
    let (reserved, pending) = queue::state_snapshot(&state.queue);
    let auditioning =
        AUDITIONING.load(Ordering::Relaxed) || AUDITION_PREPARING.load(Ordering::Relaxed);
    let frames = FRAMES_UNTIL_TRANSITION.load(Ordering::Relaxed);
    let transition_in_secs = if auditioning || frames == u64::MAX {
        None
    } else {
        // Same guard as `played_duration_secs`: a `0` sample rate would turn
        // this into `inf`, which `reserved_swappable`'s `> SWAP_DEADLINE_SECS`
        // check below would then read as "plenty of runway".
        PLAYBACK.get().and_then(|p| {
            if p.sample_rate == 0 {
                return None;
            }
            Some(frames as f64 / p.sample_rate as f64)
        })
    };
    let reserved_swappable = reserved.is_some()
        && !auditioning
        && NEXT_PREPARED.load(Ordering::Relaxed)
        && transition_in_secs.is_some_and(|s| s > SWAP_DEADLINE_SECS);
    // Not `reserved_swappable`-derived on purpose: that flag is deliberately
    // `false` during an audition (edits must not reach into `reserved` then),
    // but `reserved_prepared` reads as prepared during an audition/pause so
    // the "準備中" badge does not stay stuck on screen for their whole
    // duration — see the field's doc comment.
    let paused = PLAYBACK
        .get()
        .is_some_and(|p| p.paused.load(Ordering::Relaxed));
    let reserved_prepared = reserved.is_some()
        && (auditioning || paused || NEXT_PREPARED.load(Ordering::Relaxed));
    Ok(QueueSnapshot {
        reserved: reserved.map(|p| p.to_string_lossy().into_owned()),
        pending: pending
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        reserved_swappable,
        reserved_prepared,
        transition_in_secs,
    })
}

/// One row of the library listing: a track plus whatever the analysis cache
/// already knows about it.
#[derive(serde::Serialize, Clone)]
struct TrackRow {
    /// Absolute path. Used as the UI's key.
    path: String,
    /// Tag TITLE, or file name when absent (same resolution as session metadata).
    title: String,
    /// Tag ARTIST, or `""` when absent.
    artist: String,
    /// Rounded seconds from analysis `total_frames` / `sample_rate`, if analyzed.
    duration_secs: Option<u32>,
    /// Whether a cached analysis exists. If false, the bar fields are null.
    analyzed: bool,
    /// Effective Funkot flag (`override.funkot` ?? analysis). Unanalysed rows
    /// are `true` so the library does not grey them; the enqueue gate still
    /// lets unanalysed tracks through separately.
    is_funkot: bool,
    intro_bars: Option<u32>,
    /// The structural outro boundary — where the track collapses. This is the
    /// number the UI shows and edits.
    outro_structure_bars: Option<u32>,
    /// The mix trigger the engine derives from the boundary. Read-only, shown
    /// only so the effect of an edit is visible.
    outro_bars: Option<u32>,
    intro_manual: bool,
    outro_manual: bool,
    intro_low_confidence: bool,
    outro_low_confidence: bool,
}

/// Guards against starting a second analysis worker while one is running.
static ANALYZING: AtomicBool = AtomicBool::new(false);

/// The cache entry for `path`, but only if it is *complete* -- present and
/// with `needs_reanalysis` clear. `cache::load` alone is not enough: a kept
/// entry with a stripped auto side (see `cache::purge_auto`) still loads, but
/// the loader thread would have to run a fresh analysis on it before playback
/// could use it, which is exactly the synchronous-analysis stall this exists
/// to keep out of the audio path. Centralised so the library listing
/// (`track_row`), `refresh_library`'s pending pick, and the loader-status log in
/// `audio_thread` cannot drift on what "still needs analysis" means.
///
/// `hash` is the caller's already-resolved content hash — this never opens the
/// audio file. A missing / incomplete cache entry reads the same as "not cached".
fn analyzed_cache_entry(
    cache_dir: &std::path::Path,
    hash: &str,
) -> Option<funkot_core::TrackAnalysis> {
    funkot_core::cache::load(cache_dir, hash).filter(|a| !a.needs_reanalysis)
}

/// `true` when the track is analysed and effectively non-Funkot — the gate
/// condition shared by enqueue reject and folder-drain skip. Unanalysed
/// tracks are never gated. Does not consult `allow_non_funkot` (caller does).
fn gated_non_funkot(
    path: &std::path::Path,
    cache_dir: &std::path::Path,
    data_dir: &std::path::Path,
) -> bool {
    // Read-only use of the index: never save here. Persist is `refresh_library`
    // only — otherwise folder-drain / enqueue races with refresh and can
    // overwrite a pruned index with a stale map.
    let mut index = store::load_hash_index(data_dir);
    let Ok(hash) = store::resolve_content_hash(path, &mut index) else {
        return false;
    };
    let Some(a) = analyzed_cache_entry(cache_dir, &hash) else {
        return false;
    };
    let override_funkot = store::load_overrides(data_dir)
        .get(&hash)
        .and_then(|o| o.funkot);
    !store::effective_is_funkot(a.is_funkot, override_funkot)
}

/// Build one `TrackRow` from whatever `analyzed_cache_entry` returns for `hash`.
///
/// `hash` is resolved once by the caller (`resolve_content_hash` /
/// `resolve_library_file` / `content_hash`) so this path never content-hashes
/// the file again.
///
/// `tags: Some` uses the caller's tags (library refresh after hash-index
/// resolve). `tags: None` falls back to [`cached_tags_for`] (analysis worker
/// and other call sites).
fn track_row(
    path: &std::path::Path,
    cache_dir: &std::path::Path,
    overrides: &store::Overrides,
    hash: Option<&str>,
    tags: Option<CachedTags>,
) -> TrackRow {
    let tags = match tags {
        Some(t) => t,
        None => cached_tags_for(path),
    };
    let (title, artist) = session_metadata_for(Some(path), &tags);
    match hash.and_then(|h| analyzed_cache_entry(cache_dir, h).map(|a| (h, a))) {
        Some((hash, a)) => {
            let override_funkot = overrides.get(hash).and_then(|o| o.funkot);
            TrackRow {
                path: path.to_string_lossy().into_owned(),
                title,
                artist,
                duration_secs: if a.sample_rate == 0 {
                    None
                } else {
                    Some(((a.total_frames as f64) / (a.sample_rate as f64)).round() as u32)
                },
                analyzed: true,
                is_funkot: store::effective_is_funkot(a.is_funkot, override_funkot),
                intro_bars: Some(a.intro_bars),
                outro_structure_bars: Some(a.outro_structure_bars),
                outro_bars: Some(a.outro_bars),
                intro_manual: a.intro_bars_manual,
                outro_manual: a.outro_structure_bars_manual || a.outro_bars_manual,
                intro_low_confidence: a.intro_bars_low_confidence,
                outro_low_confidence: a.outro_bars_low_confidence,
            }
        }
        None => TrackRow {
            path: path.to_string_lossy().into_owned(),
            title,
            artist,
            duration_secs: None,
            analyzed: false,
            is_funkot: true,
            intro_bars: None,
            outro_structure_bars: None,
            outro_bars: None,
            intro_manual: false,
            outro_manual: false,
            intro_low_confidence: false,
            outro_low_confidence: false,
        },
    }
}

#[cfg(test)]
mod cache_state_tests {
    use super::*;

    /// Fresh temp dir per test, cleaned up on drop. Same shape as the one in
    /// `store`'s tests; not shared because neither module should have to
    /// export test scaffolding to the other.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "funkot-player-cache-test-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A file to hash plus a plausible analysis of it. The contents are never
    /// decoded — only `content_hash` reads them — so any bytes will do.
    fn track_with_analysis(dir: &Path) -> (PathBuf, funkot_core::TrackAnalysis) {
        let track = dir.join("track.wav");
        std::fs::write(&track, vec![0u8; 4096]).unwrap();
        let buffer = funkot_core::decode::AudioBuffer {
            sample_rate: 48_000,
            frames: 48_000 * 200,
            samples: Vec::new(),
        };
        (track, funkot_core::cache::provisional(&buffer, "track.wav"))
    }

    fn store_for(track: &Path, cache_dir: &Path, analysis: &funkot_core::TrackAnalysis) {
        let hash = funkot_core::cache::content_hash(track).unwrap();
        funkot_core::cache::store(cache_dir, &hash, analysis).unwrap();
    }

    #[test]
    fn no_cache_entry_reads_as_unanalyzed() {
        let dir = TempDir::new("none");
        let (track, _) = track_with_analysis(&dir.0);
        let hash = funkot_core::cache::content_hash(&track).unwrap();
        assert!(analyzed_cache_entry(&dir.0, &hash).is_none());
        assert!(!track_row(&track, &dir.0, &store::Overrides::new(), Some(&hash), None).analyzed);
    }

    #[test]
    fn a_complete_entry_reads_as_analyzed() {
        let dir = TempDir::new("complete");
        let (track, analysis) = track_with_analysis(&dir.0);
        store_for(&track, &dir.0, &analysis);
        let hash = funkot_core::cache::content_hash(&track).unwrap();

        assert!(analyzed_cache_entry(&dir.0, &hash).is_some());
        let row = track_row(&track, &dir.0, &store::Overrides::new(), Some(&hash), None);
        assert!(row.analyzed);
        assert_eq!(row.intro_bars, Some(analysis.intro_bars));
        // Tagless fixture: title falls back to file name, artist empty;
        // duration comes from provisional frames / sample_rate (200s).
        assert_eq!(row.title, file_name_str(&track));
        assert_eq!(row.artist, "");
        assert_eq!(row.duration_secs, Some(200));
        assert_eq!(row.is_funkot, analysis.is_funkot);
    }

    /// The regression this whole change turns on. An entry that loads but has
    /// `needs_reanalysis` set is one the engine's loader will re-analyse *on
    /// its own thread, mid-playback* — so the library must not call it
    /// analyzed, or the background worker skips it and the listener gets the
    /// silence instead.
    #[test]
    fn an_entry_needing_reanalysis_reads_as_unanalyzed() {
        let dir = TempDir::new("stale");
        let (track, mut analysis) = track_with_analysis(&dir.0);
        analysis.needs_reanalysis = true;
        store_for(&track, &dir.0, &analysis);
        let hash = funkot_core::cache::content_hash(&track).unwrap();

        assert!(analyzed_cache_entry(&dir.0, &hash).is_none());
        let row = track_row(&track, &dir.0, &store::Overrides::new(), Some(&hash), None);
        assert!(!row.analyzed);
        // And the numbers are withheld too: showing bars the engine is about
        // to recompute invites hand-correcting a value that is on its way out.
        assert_eq!(row.intro_bars, None);
        assert_eq!(row.outro_structure_bars, None);
        assert!(row.is_funkot);
    }

    #[test]
    fn a_missing_hash_reads_as_unanalyzed_rather_than_erroring() {
        let dir = TempDir::new("missing-hash");
        let track = dir.0.join("nope.wav");
        assert!(analyzed_cache_entry(&dir.0, "deadbeef").is_none());
        assert!(!track_row(&track, &dir.0, &store::Overrides::new(), None, None).analyzed);
    }

    /// `track_row` must honour the hash the caller already resolved — no second
    /// `content_hash` — so an override keyed by that hash is applied.
    #[test]
    fn track_row_uses_passed_hash_for_override_without_rehash() {
        let cache = TempDir::new("row-hash-cache");
        let (track, mut analysis) = track_with_analysis(&cache.0);
        analysis.is_funkot = false;
        store_for(&track, &cache.0, &analysis);
        let hash = funkot_core::cache::content_hash(&track).unwrap();

        let mut overrides = store::Overrides::new();
        overrides.insert(
            hash.clone(),
            store::BarOverride {
                funkot: Some(true),
                ..Default::default()
            },
        );
        let row = track_row(&track, &cache.0, &overrides, Some(&hash), None);
        assert!(row.analyzed);
        assert!(row.is_funkot);
    }

    /// `tags: Some` must be used as-is — no `cached_tags_for` / file open.
    /// A missing path would fail probe; passed tags still win.
    #[test]
    fn track_row_uses_passed_tags_without_probe() {
        let dir = TempDir::new("row-tags");
        let track = dir.0.join("does-not-exist.wav");
        let tags = CachedTags {
            title: Some("From Index".into()),
            artist: Some("Cached Artist".into()),
        };
        let row = track_row(
            &track,
            &dir.0,
            &store::Overrides::new(),
            None,
            Some(tags),
        );
        assert_eq!(row.title, "From Index");
        assert_eq!(row.artist, "Cached Artist");
        assert!(!row.analyzed);
    }

    #[test]
    fn gated_non_funkot_skips_only_analysed_non_funkot() {
        let cache = TempDir::new("gate-cache");
        let data = TempDir::new("gate-data");
        let (track, mut analysis) = track_with_analysis(&cache.0);
        analysis.is_funkot = false;
        store_for(&track, &cache.0, &analysis);

        assert!(gated_non_funkot(&track, &cache.0, &data.0));
        assert!(!gated_non_funkot(
            &cache.0.join("missing.wav"),
            &cache.0,
            &data.0
        ));

        let hash = funkot_core::cache::content_hash(&track).unwrap();
        let mut overrides = store::Overrides::new();
        overrides.insert(
            hash,
            store::BarOverride {
                funkot: Some(true),
                ..Default::default()
            },
        );
        store::save_overrides(&data.0, &overrides).unwrap();
        assert!(!gated_non_funkot(&track, &cache.0, &data.0));
    }

    /// Cancel/undo with `mark_manual = false` must clear the touched side's
    /// manual flag and drop its `library.json` override (the bug where `*`
    /// survived after values reverted).
    #[test]
    fn set_bars_mark_manual_false_clears_flag_and_override() {
        let cache = TempDir::new("set-bars-cache");
        let data = TempDir::new("set-bars-data");
        let (track, analysis) = track_with_analysis(&cache.0);
        assert!(!analysis.intro_bars_manual);
        store_for(&track, &cache.0, &analysis);
        let baseline = analysis.intro_bars;

        let pinned = set_bars_impl(
            &cache.0,
            &data.0,
            &track,
            Some(baseline + 8),
            None,
            true,
        )
        .unwrap();
        assert!(pinned.intro_manual);
        assert_eq!(pinned.intro_bars, Some(baseline + 8));
        let hash = funkot_core::cache::content_hash(&track).unwrap();
        let overrides = store::load_overrides(&data.0);
        assert_eq!(
            overrides.get(&hash).and_then(|e| e.intro_bars),
            Some(baseline + 8)
        );

        let restored = set_bars_impl(
            &cache.0,
            &data.0,
            &track,
            Some(baseline),
            None,
            false,
        )
        .unwrap();
        assert!(!restored.intro_manual);
        assert_eq!(restored.intro_bars, Some(baseline));
        let overrides = store::load_overrides(&data.0);
        assert!(!overrides.contains_key(&hash));
    }

    /// Confirm / normal chip edit keeps pinning manual and writing library.json.
    #[test]
    fn set_bars_mark_manual_true_keeps_override() {
        let cache = TempDir::new("set-bars-keep-cache");
        let data = TempDir::new("set-bars-keep-data");
        let (track, analysis) = track_with_analysis(&cache.0);
        store_for(&track, &cache.0, &analysis);

        let row = set_bars_impl(
            &cache.0,
            &data.0,
            &track,
            Some(analysis.intro_bars + 4),
            None,
            true,
        )
        .unwrap();
        assert!(row.intro_manual);
        let hash = funkot_core::cache::content_hash(&track).unwrap();
        assert_eq!(
            store::load_overrides(&data.0)
                .get(&hash)
                .and_then(|e| e.intro_bars),
            Some(analysis.intro_bars + 4)
        );
    }

    /// `path_str` is what `PlayerState` now uses to identify a track; it must
    /// agree with `TrackRow::path` or the frontend's map-key lookups break.
    #[test]
    fn path_str_matches_track_row_path() {
        let cache = TempDir::new("path-str-cache");
        let (track, _) = track_with_analysis(&cache.0);
        let hash = funkot_core::cache::content_hash(&track).unwrap();
        assert_eq!(
            path_str(&track),
            track_row(&track, &cache.0, &store::Overrides::new(), Some(&hash), None).path
        );
    }
}

#[cfg(test)]
mod scan_tracks_tests {
    use super::*;

    /// Fresh temp dir per test, cleaned up on drop. Same shape as the one in
    /// `cache_state_tests`; not shared for the same reason given there.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "funkot-player-scan-tracks-test-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"x").unwrap();
    }

    #[test]
    fn finds_tracks_in_nested_subdirectories() {
        let dir = TempDir::new("nested");
        touch(&dir.0.join("top.wav"));
        touch(&dir.0.join("a").join("mid.mp3"));
        touch(&dir.0.join("a").join("b").join("deep.flac"));

        let found = scan_tracks(&dir.0).unwrap();
        assert_eq!(
            found,
            vec![
                dir.0.join("a").join("b").join("deep.flac"),
                dir.0.join("a").join("mid.mp3"),
                dir.0.join("top.wav"),
            ]
        );
    }

    #[test]
    fn ignores_dot_prefixed_directories() {
        let dir = TempDir::new("dot-dir");
        touch(&dir.0.join(".hidden").join("track.wav"));
        touch(&dir.0.join("visible.wav"));

        let found = scan_tracks(&dir.0).unwrap();
        assert_eq!(found, vec![dir.0.join("visible.wav")]);
    }

    #[test]
    fn ignores_dot_prefixed_files() {
        let dir = TempDir::new("dot-file");
        touch(&dir.0.join(".track.wav"));
        touch(&dir.0.join("track.wav"));

        let found = scan_tracks(&dir.0).unwrap();
        assert_eq!(found, vec![dir.0.join("track.wav")]);
    }

    #[test]
    fn ignores_unsupported_extensions() {
        let dir = TempDir::new("unsupported");
        touch(&dir.0.join("notes.txt"));
        touch(&dir.0.join("track.wav"));

        let found = scan_tracks(&dir.0).unwrap();
        assert_eq!(found, vec![dir.0.join("track.wav")]);
    }

    #[test]
    fn result_is_sorted() {
        let dir = TempDir::new("sorted");
        touch(&dir.0.join("z.wav"));
        touch(&dir.0.join("m.wav"));
        touch(&dir.0.join("a.wav"));

        let found = scan_tracks(&dir.0).unwrap();
        let mut expected = found.clone();
        expected.sort();
        assert_eq!(found, expected);
        assert_eq!(
            found,
            vec![
                dir.0.join("a.wav"),
                dir.0.join("m.wav"),
                dir.0.join("z.wav"),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinked_directories() {
        let dir = TempDir::new("symlink");
        let real = TempDir::new("symlink-target");
        touch(&real.0.join("outside.wav"));
        touch(&dir.0.join("inside.wav"));

        std::os::unix::fs::symlink(&real.0, dir.0.join("linked")).unwrap();

        let found = scan_tracks(&dir.0).unwrap();
        assert_eq!(found, vec![dir.0.join("inside.wav")]);
    }

    /// Recursive scanning can surface the same file name in different
    /// subfolders; both must survive as distinct entries, and only their
    /// full paths (not `file_name_str`) tell them apart — this is the
    /// reasoning behind keying `PlayerState` on `path_str` rather than the
    /// file name.
    #[test]
    fn same_basename_in_different_subdirs_both_survive() {
        let dir = TempDir::new("same-basename");
        touch(&dir.0.join("a").join("01.mp3"));
        touch(&dir.0.join("b").join("01.mp3"));

        let found = scan_tracks(&dir.0).unwrap();
        assert_eq!(
            found,
            vec![dir.0.join("a").join("01.mp3"), dir.0.join("b").join("01.mp3"),]
        );
        assert_eq!(
            file_name_str(&found[0]),
            file_name_str(&found[1]),
            "file names collide, which is exactly why PlayerState must key on path_str instead"
        );
    }
}

/// Kick off a background analysis worker for a caller-supplied list of tracks
/// that still need analysis. `refresh_library` builds this list from `track_row`
/// so each file is content-hashed only once.
fn analyze_these(
    app: &tauri::AppHandle,
    pending: Vec<PathBuf>,
    cache_dir: &Path,
    data_dir: &Path,
) {
    if pending.is_empty() {
        return;
    }
    log::info!("{} track(s) need analysis", pending.len());
    let overrides = store::load_overrides(data_dir);
    spawn_analysis_worker(app.clone(), pending, cache_dir.to_path_buf(), overrides);
}

/// Progress payload for the `library-scan` event.
///
/// Emitted while `refresh_library` walks the music folder and content-hashes
/// each track — especially useful over SMB where hashing can take a long time
/// and the UI would otherwise keep showing the previous library with no feedback.
#[derive(serde::Serialize, Clone)]
struct LibraryScanProgress {
    /// `"walking"` while collecting paths; `"hashing"` while building rows.
    phase: String,
    found: usize,
    done: usize,
}

/// Scan `music_dir` (recursively, subfolders included) for supported tracks
/// and report what the analysis cache already knows about each.
///
/// When `kick_analysis` is true, starts a background analysis worker for any
/// unanalyzed tracks (startup / manual 再スキャン). When false, returns the
/// listing only — used after `analysis-done` so permanent analysis failures
/// (e.g. silent files) cannot re-queue forever via refresh → analyze → done.
#[tauri::command(async)]
fn refresh_library(app: tauri::AppHandle, kick_analysis: bool) -> Result<Vec<TrackRow>, String> {
    use tauri::Emitter;

    let dirs = resolve_dirs(&app)?;
    let music_dir = PathBuf::from(&dirs.music_dir);
    let cache_dir = PathBuf::from(&dirs.cache_dir);
    let data_dir = PathBuf::from(&dirs.data_dir);

    let _ = app.emit(
        "library-scan",
        LibraryScanProgress {
            phase: "walking".into(),
            found: 0,
            done: 0,
        },
    );

    let paths: Vec<PathBuf> = scan_tracks(&music_dir)?;
    let overrides = store::load_overrides(&data_dir);
    let mut hash_index = store::load_hash_index(&data_dir);
    let found = paths.len();

    let _ = app.emit(
        "library-scan",
        LibraryScanProgress {
            phase: "hashing".into(),
            found,
            done: 0,
        },
    );

    // Explicit loop (not `.map`) so we can emit progress after each resolve.
    let mut rows: Vec<TrackRow> = Vec::with_capacity(found);
    let mut seen_paths = std::collections::BTreeSet::new();
    for path in &paths {
        let path_key = path.to_string_lossy().into_owned();
        seen_paths.insert(path_key.clone());
        let (hash, tags) = match store::resolve_library_file(path, &mut hash_index) {
            Ok(resolved) => {
                let tags = CachedTags {
                    title: resolved.title,
                    artist: resolved.artist,
                };
                // Seed TAG_CACHE from the index whenever tags are known so
                // later cached_tags_for callers (MediaSession, analysis rows)
                // neither re-open on hit nor keep stale tags after a re-probe.
                if hash_index
                    .get(&path_key)
                    .is_some_and(|e| e.tags_cached)
                {
                    TAG_CACHE
                        .lock()
                        .unwrap()
                        .insert(path.to_path_buf(), tags.clone());
                }
                (Some(resolved.hash), Some(tags))
            }
            Err(_) => (None, None),
        };
        rows.push(track_row(
            path,
            &cache_dir,
            &overrides,
            hash.as_deref(),
            tags,
        ));
        let _ = app.emit(
            "library-scan",
            LibraryScanProgress {
                phase: "hashing".into(),
                found,
                done: rows.len(),
            },
        );
    }

    hash_index.retain(|path, _| seen_paths.contains(path));
    if let Err(e) = store::save_hash_index(&data_dir, &hash_index) {
        log::warn!("cannot save hash-index.json: {e}");
    }

    if kick_analysis {
        // Reuse what `track_row` already worked out so we do not hash every
        // file a second time: `analyzed` is exactly
        // `analyzed_cache_entry(...).is_some()`.
        let pending: Vec<PathBuf> = paths
            .iter()
            .zip(&rows)
            .filter(|(_, row)| !row.analyzed)
            .map(|(path, _)| path.clone())
            .collect();
        analyze_these(&app, pending, &cache_dir, &data_dir);
    }

    Ok(rows)
}

/// Push stored corrections into the engine's analysis cache for one track.
///
/// Only the sides present in `o` are written; the rest stay whatever the
/// analyzer decided. Run after every fresh analysis — the analyzer has just
/// overwritten the entry, and a `CACHE_VERSION` bump discards it entirely, so
/// this is what makes a correction outlive an engine update.
fn apply_override(
    cache_dir: &std::path::Path,
    hash: &str,
    o: &store::BarOverride,
) -> Result<(), String> {
    if let Some(n) = o.intro_bars {
        funkot_core::cache::set_manual_bars(cache_dir, hash, Some(n), None)
            .map_err(|e| format!("cannot set intro bars: {e}"))?;
    }
    if let Some(n) = o.outro_structure_bars {
        funkot_core::cache::set_manual_structure_bars(cache_dir, hash, n)
            .map_err(|e| format!("cannot set outro bars: {e}"))?;
    }
    Ok(())
}

/// Hand-edit one track's intro bars and/or outro boundary.
///
/// The outro number is the *structural* boundary — where the track collapses,
/// which is what a listener can actually judge. The engine re-derives the mix
/// trigger from it, so the transition keeps finishing exactly where the outro
/// begins; pinning the trigger directly would break that relation.
///
/// Sides left as `null` are not touched, so the UI can send one cell at a time.
///
/// `mark_manual` defaults to `true` (confirm / normal chip edit). Pass `false`
/// when reverting a cancel/undo so the `*_manual` flags and `library.json`
/// overrides for the touched side are cleared instead of re-pinned.
#[tauri::command(async)]
fn set_bars(
    app: tauri::AppHandle,
    path: String,
    intro_bars: Option<u32>,
    outro_structure_bars: Option<u32>,
    mark_manual: Option<bool>,
) -> Result<TrackRow, String> {
    let dirs = resolve_dirs(&app)?;
    let cache_dir = PathBuf::from(&dirs.cache_dir);
    let data_dir = PathBuf::from(&dirs.data_dir);
    set_bars_impl(
        &cache_dir,
        &data_dir,
        Path::new(&path),
        intro_bars,
        outro_structure_bars,
        mark_manual.unwrap_or(true),
    )
}

/// Core of [`set_bars`], split out so unit tests can drive cache + library.json
/// without an `AppHandle`.
fn set_bars_impl(
    cache_dir: &std::path::Path,
    data_dir: &std::path::Path,
    track: &std::path::Path,
    intro_bars: Option<u32>,
    outro_structure_bars: Option<u32>,
    mark_manual: bool,
) -> Result<TrackRow, String> {
    let hash = funkot_core::cache::content_hash(track)
        .map_err(|e| format!("cannot hash {}: {e}", track.display()))?;

    let edit = store::BarOverride {
        intro_bars,
        outro_structure_bars,
        funkot: None,
    };
    // The cache write comes first: if the track has no analysis yet there is
    // nothing to edit, and storing the override anyway would leave the app
    // claiming a correction the user cannot see taking effect.
    apply_override(cache_dir, &hash, &edit)?;

    if !mark_manual {
        // `set_manual_*` always pins `*_manual = true`. For cancel/undo we still
        // want its value/derive logic, then clear the touched side's flag.
        let mut analysis = funkot_core::cache::load(cache_dir, &hash)
            .ok_or_else(|| format!("no cache entry after override for hash '{hash}'"))?;
        if intro_bars.is_some() {
            analysis.intro_bars_manual = false;
        }
        if outro_structure_bars.is_some() {
            analysis.outro_structure_bars_manual = false;
        }
        funkot_core::cache::store(cache_dir, &hash, &analysis)
            .map_err(|e| format!("cannot clear manual flags: {e}"))?;
    }

    let mut overrides = store::load_overrides(data_dir);
    if mark_manual {
        let entry = overrides.entry(hash.clone()).or_default();
        if let Some(n) = intro_bars {
            entry.intro_bars = Some(n);
        }
        if let Some(n) = outro_structure_bars {
            entry.outro_structure_bars = Some(n);
        }
    } else if let Some(entry) = overrides.get_mut(&hash) {
        // Revert: drop the touched side's override; remove the hash entry when
        // both sides are empty. No entry → nothing to do.
        if intro_bars.is_some() {
            entry.intro_bars = None;
        }
        if outro_structure_bars.is_some() {
            entry.outro_structure_bars = None;
        }
        if entry.intro_bars.is_none()
            && entry.outro_structure_bars.is_none()
            && entry.funkot.is_none()
        {
            overrides.remove(&hash);
        }
    }
    // Warn-only, as with the queue: the edit already took effect for playback,
    // so failing the command here would misreport what happened. What is lost
    // is only the ability to re-apply it after a future reanalysis.
    if let Err(e) = store::save_overrides(data_dir, &overrides) {
        log::warn!("cannot persist manual bars: {e}");
    }

    Ok(track_row(track, cache_dir, &overrides, Some(&hash), None))
}

/// Progress payload for the `analysis-progress` event.
///
/// Carries the row the analysis just produced (post `reapply_overrides`) so
/// the webview can splice it into its table in place instead of calling
/// `refresh_library` on every event -- see C-4: that command re-walks the
/// music folder and re-reads the cache for every track, which is wasted work
/// for an update that only ever touches the one track just analyzed.
#[derive(serde::Serialize, Clone)]
struct AnalysisProgress {
    done: usize,
    total: usize,
    name: String,
    row: TrackRow,
}

/// Re-apply this track's stored corrections onto a just-written cache entry.
///
/// Skips hashing entirely when nothing is stored, so the common case (no
/// corrections yet) costs nothing on top of the analysis run.
fn reapply_overrides(path: &std::path::Path, cache_dir: &std::path::Path, o: &store::Overrides) {
    if o.is_empty() {
        return;
    }
    let Ok(hash) = funkot_core::cache::content_hash(path) else {
        return;
    };
    let Some(entry) = o.get(&hash) else {
        return;
    };
    if let Err(e) = apply_override(cache_dir, &hash, entry) {
        log::warn!("cannot re-apply manual bars for {}: {e}", path.display());
    }
}

/// Longest the analysis worker will hold off waiting for playback to get
/// going. Only a bound on a phase that should never stick: if the first track
/// somehow never produces sound, analysing the rest of the folder is still
/// better than analysing nothing.
const STARTUP_WAIT: std::time::Duration = std::time::Duration::from_secs(60);

/// Block while Start / loader work should own decode CPU and disk.
///
/// Called by the analysis worker before each track, not once at thread entry:
/// a worker started while Idle (refresh-before-start) would otherwise keep
/// decoding other files after Start flips the phase to `Starting`, and steal
/// CPU/disk from the loader. Mid-decode of the current file is not cancelled;
/// yielding happens before the next track.
///
/// Waits while any of:
/// - `Phase::Starting` — first non-silent buffer not yet reached
/// - `Phase::Stalled` — silence; stop competing so the loader can recover
/// - `Phase::Playing` and `YIELD_FOR_LOADER` — after first sound, still cover
///   first-track Upgrade and the first next-slot prepare (`get_or_analyze` on
///   cache miss). Cleared when the cpal callback sees `next_track_path()`.
///
/// The engine's loader analyses a track itself when the cache has no complete
/// entry for it (`funkot-core` `cache::get_or_analyze`, reached from
/// `prepare_track` and from the first track's Upgrade). That analysis is what
/// this worker exists to do ahead of time — but overlapping it on Start is
/// how a press of start turns into a wait for silence.
///
/// If the next slot never fills while still Playing (drain empty, prepare
/// stuck, …), `YIELD_FOR_LOADER` stays true and each subsequent track wait
/// can re-arm up to `STARTUP_WAIT`. Idle / Paused / Failed / Disconnected
/// (or Playing with the flag cleared) does not wait — the plain
/// press-scan-before-start case.
fn wait_out_startup() {
    let until = std::time::Instant::now() + STARTUP_WAIT;
    while std::time::Instant::now() < until {
        let phase = get_phase();
        let hold = matches!(phase, Phase::Starting | Phase::Stalled)
            || (phase == Phase::Playing && YIELD_FOR_LOADER.load(Ordering::Relaxed));
        if !hold {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

/// Spawn the single background analysis thread, if one is not already running.
///
/// Deliberately serial, not parallelised across tracks: this runs on a phone,
/// and analysing more than one file at a time would mean more heat and battery
/// drain for no benefit the user can perceive (the worker already runs
/// unattended in the background).
fn spawn_analysis_worker(
    app: tauri::AppHandle,
    paths: Vec<PathBuf>,
    cache_dir: PathBuf,
    overrides: store::Overrides,
) {
    if ANALYZING.swap(true, Ordering::SeqCst) {
        // Already running; refresh_library's caller will see progress events
        // from the run already in flight.
        return;
    }

    std::thread::Builder::new()
        .name("funkot-analysis".into())
        .spawn(move || {
            use tauri::Emitter;

            let total = paths.len();
            for (i, path) in paths.iter().enumerate() {
                // Yield before starting the next track so Start's
                // `prepare_first_live` is not fighting an in-flight library
                // decode. See `wait_out_startup`.
                wait_out_startup();

                let name = file_name_str(path);

                // Re-checked here, not just when the list was built: the
                // engine's loader analyses whatever it prepares, so by the
                // time this worker reaches a track the loader may already
                // have done it. `fill_missing` would notice too, but only
                // after a full decode — and it is the decode, tens of MB and
                // seconds of CPU, that is worth not repeating on a phone.
                let hash = funkot_core::cache::content_hash(path).ok();
                if hash
                    .as_deref()
                    .and_then(|h| analyzed_cache_entry(&cache_dir, h))
                    .is_some()
                {
                    log::info!(
                        "analysis: {} was done elsewhere, skipping",
                        path.display()
                    );
                    let _ = app.emit(
                        "analysis-progress",
                        AnalysisProgress {
                            done: i + 1,
                            total,
                            name,
                            row: track_row(path, &cache_dir, &overrides, hash.as_deref(), None),
                        },
                    );
                    continue;
                }

                match funkot_core::decode::decode_file(path) {
                    Ok(buffer) => {
                        if let Err(e) = funkot_core::cache::fill_missing(path, &cache_dir, &buffer) {
                            log::warn!("analysis failed for {}: {e}", path.display());
                        } else {
                            reapply_overrides(path, &cache_dir, &overrides);
                        }
                        // `buffer` drops here, before the next track is decoded,
                        // so only one track's worth of samples (tens of MB) is
                        // ever resident at once.
                    }
                    Err(e) => {
                        log::warn!("decode failed for {}: {e}", path.display());
                    }
                }

                // Built after `reapply_overrides` so a successful run's row
                // reflects the corrected numbers, not the analyzer's raw ones.
                let row = track_row(path, &cache_dir, &overrides, hash.as_deref(), None);
                let _ = app.emit(
                    "analysis-progress",
                    AnalysisProgress {
                        done: i + 1,
                        total,
                        name,
                        row,
                    },
                );
            }

            ANALYZING.store(false, Ordering::SeqCst);
            let _ = app.emit("analysis-done", ());
        })
        .expect("spawn analysis thread");
}

/// Publish the Android `Context` to `ndk-context`.
///
/// Tauri v2 never does this: it ships its own Kotlin `Activity` instead of going
/// through `android-activity`, and nothing in tauri/wry/tao touches `ndk-context`.
/// cpal's AAudio host calls `ndk_context::android_context()` from
/// `AudioManager::get_mixer_bursts()` while *building* a stream, and that function
/// **panics** instead of returning an error — so it cannot be tolerated, only
/// prevented. The AAudio stream itself opens fine without it; only the JNI-backed
/// buffer sizing needs the context.
///
/// `JNI_OnLoad` is the one hook we get for free: the loader calls it on
/// `System.loadLibrary`, and neither tao, wry nor tauri defines it.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn JNI_OnLoad(
    vm: *mut std::ffi::c_void,
    _reserved: *mut std::ffi::c_void,
) -> jni::sys::jint {
    use jni::{errors::Result as JResult, Env, JavaVM};

    let java_vm = unsafe { JavaVM::from_raw(vm.cast()) };
    let result: JResult<()> = java_vm.attach_current_thread(|env: &mut Env<'_>| {
        let class = env.find_class(jni::jni_str!("android/app/ActivityThread"))?;
        let app = env
            .call_static_method(
                &class,
                jni::jni_str!("currentApplication"),
                jni::jni_sig!("()Landroid/app/Application;"),
                &[],
            )?
            .l()?;
        // Leaked on purpose: the context must outlive every audio stream.
        let context = env.new_global_ref(&app)?.into_raw();
        unsafe { ndk_context::initialize_android_context(vm, context.cast()) };
        Ok(())
    });
    if let Err(e) = result {
        // android_logger is not up yet; this lands in the RustStdoutStderr tag.
        eprintln!("JNI_OnLoad: failed to initialise ndk-context: {e}");
    }
    jni::sys::JNI_VERSION_1_6
}

/// Start or stop the `PlaybackService` foreground service.
///
/// The service plays no audio itself — the cpal stream on the audio thread
/// already does that — its only job is keeping the process foreground-
/// privileged (so the system stops muting it once backgrounded) and showing a
/// notification. Failure here must not be fatal: playback continues either
/// way, just without a notification.
#[cfg(target_os = "android")]
fn service_call(method: &str) {
    use jni::objects::{JClassLoader, JObject};
    use jni::refs::LoaderContext;
    use jni::strings::JNIString;
    use jni::{errors::Result as JResult, Env, JavaVM};

    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) };
    let raw_context = ctx.context() as jni::sys::jobject;

    let result: JResult<()> = vm.attach_current_thread(|env: &mut Env<'_>| {
        let context = unsafe { JObject::from_raw(env, raw_context) };
        // `env.find_class` walks the calling thread's classloader, and this
        // command runs on Tauri's blocking-task thread pool (since `start`
        // became `#[tauri::command(async)]`), not the JVM's main thread that
        // `System.loadLibrary` attached originally. A thread JNI attaches on
        // the fly gets the *system* classloader, which cannot see app classes
        // like `PlaybackService` — so `find_class` fails there even though it
        // works fine for e.g. `toggle_pause`, which stays on the UI thread.
        // Route through the app `Context`'s own classloader instead, which is
        // thread-independent.
        //
        // It has to be `Context.getClassLoader()`, the instance method. Asking
        // the context object for its *class* and then that class's loader gives
        // the loader of `android.app.Application` — a framework class, so that
        // is the boot classloader, which cannot see app classes either.
        let loader = env
            .call_method(
                &context,
                jni::jni_str!("getClassLoader"),
                jni::jni_sig!("()Ljava/lang/ClassLoader;"),
                &[],
            )?
            .l()?;
        let loader = env.cast_local::<JClassLoader>(loader)?;
        let class = LoaderContext::Loader(&loader).load_class(
            env,
            jni::jni_str!("jp.hatsuboshi.funkotplayer.PlaybackService"),
            true,
        )?;
        env.call_static_method(
            &class,
            JNIString::new(method),
            jni::jni_sig!("(Landroid/content/Context;)V"),
            &[(&context).into()],
        )?;
        Ok(())
    });
    if let Err(e) = result {
        log::error!("PlaybackService.{method}: {e}");
    }
}

#[cfg(not(target_os = "android"))]
fn service_call(_method: &str) {}

fn service_set_running(running: bool) {
    service_call(if running { "startFrom" } else { "stopFrom" });
}

/// Nudge the service to re-read the paused flag.
///
/// The notification and the in-app buttons are two views of one flag; without
/// this, pausing from the app leaves the notification showing the old label
/// until something else touches it.
fn service_sync_state() {
    service_call("syncFrom");
}

/// `android.os.Build.MODEL` (device marketing name).
#[cfg(target_os = "android")]
fn android_device_model() -> String {
    use jni::objects::JString;
    use jni::{Env, JavaVM};

    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) };

    vm.attach_current_thread(|env: &mut Env<'_>| -> jni::errors::Result<String> {
        let model_obj = env
            .get_static_field(
                jni::jni_str!("android/os/Build"),
                jni::jni_str!("MODEL"),
                jni::jni_sig!("Ljava/lang/String;"),
            )?
            .l()?;
        if model_obj.is_null() {
            return Err(jni::errors::Error::NullPtr("Build.MODEL"));
        }
        let s = unsafe { JString::from_raw(env, model_obj.into_raw()) };
        // Bound to a local on purpose: the MUTF8Chars view borrows `s`, and
        // returning the expression directly drops them in the wrong order
        // (same as `android_cache_dir` / `platform_dirs`).
        let model = String::from(s.mutf8_chars(env)?);
        Ok(model)
    })
    .unwrap_or_else(|_| "android".into())
}

/// `Context.getCacheDir()` absolute path (FileProvider `<cache-path>` root).
///
/// Distinct from [`AppDirs::cache_dir`] (`filesDir/funkot-cache`), which is
/// outside the provider paths in `file_paths.xml`.
#[cfg(target_os = "android")]
fn android_cache_dir() -> Result<PathBuf, String> {
    use jni::objects::{JObject, JString};
    use jni::{Env, JavaVM};

    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) };
    let raw_context = ctx.context() as jni::sys::jobject;

    let path: String = vm
        .attach_current_thread(|env: &mut Env<'_>| -> jni::errors::Result<String> {
            let context = unsafe { JObject::from_raw(env, raw_context) };
            let cache_file = env
                .call_method(
                    &context,
                    jni::jni_str!("getCacheDir"),
                    jni::jni_sig!("()Ljava/io/File;"),
                    &[],
                )?
                .l()?;
            if cache_file.is_null() {
                return Err(jni::errors::Error::NullPtr("getCacheDir"));
            }
            let obj = env
                .call_method(
                    &cache_file,
                    jni::jni_str!("getAbsolutePath"),
                    jni::jni_sig!("()Ljava/lang/String;"),
                    &[],
                )?
                .l()?;
            let s = unsafe { JString::from_raw(env, obj.into_raw()) };
            // Bound to a local on purpose: the MUTF8Chars view borrows `s`, and
            // returning the expression directly drops them in the wrong order
            // (same as `platform_dirs` / `absolute_path`).
            let path = String::from(s.mutf8_chars(env)?);
            Ok(path)
        })
        .map_err(|e: jni::errors::Error| format!("cannot resolve getCacheDir: {e}"))?;
    Ok(PathBuf::from(path))
}

/// Open the system share sheet for a staged ZIP via `FeedbackShare.shareFrom`.
///
/// Same classloader routing as [`service_call`]: this runs on Tauri's blocking
/// pool, so the system classloader cannot see app classes.
#[cfg(target_os = "android")]
fn feedback_share(absolute_path: &str) -> Result<(), String> {
    use jni::objects::{JClassLoader, JObject};
    use jni::refs::LoaderContext;
    use jni::strings::JNIString;
    use jni::{errors::Result as JResult, Env, JavaVM};

    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) };
    let raw_context = ctx.context() as jni::sys::jobject;

    let result: JResult<()> = vm.attach_current_thread(|env: &mut Env<'_>| {
        let context = unsafe { JObject::from_raw(env, raw_context) };
        let loader = env
            .call_method(
                &context,
                jni::jni_str!("getClassLoader"),
                jni::jni_sig!("()Ljava/lang/ClassLoader;"),
                &[],
            )?
            .l()?;
        let loader = env.cast_local::<JClassLoader>(loader)?;
        let class = LoaderContext::Loader(&loader).load_class(
            env,
            jni::jni_str!("jp.hatsuboshi.funkotplayer.FeedbackShare"),
            true,
        )?;
        let path = env.new_string(absolute_path)?;
        env.call_static_method(
            &class,
            JNIString::new("shareFrom"),
            jni::jni_sig!("(Landroid/content/Context;Ljava/lang/String;)V"),
            &[(&context).into(), (&path).into()],
        )?;
        Ok(())
    });
    result.map_err(|e| format!("FeedbackShare.shareFrom: {e}"))
}

/// `Import.hasInFlight()` — whether an `Import.onIntent` copy thread is still
/// running. See [`ImportResult::in_flight`]'s doc comment for why
/// `take_pending_import` needs this at all, and its own call site for why the
/// order relative to its staging-dir walk matters.
///
/// Same classloader routing as [`feedback_share`] / [`service_call`]: this
/// runs on Tauri's blocking pool, so the system classloader cannot see app
/// classes.
#[cfg(target_os = "android")]
fn android_import_has_in_flight() -> Result<bool, String> {
    use jni::objects::{JClassLoader, JObject};
    use jni::refs::LoaderContext;
    use jni::strings::JNIString;
    use jni::{errors::Result as JResult, Env, JavaVM};

    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) };
    let raw_context = ctx.context() as jni::sys::jobject;

    let result: JResult<bool> = vm.attach_current_thread(|env: &mut Env<'_>| {
        let context = unsafe { JObject::from_raw(env, raw_context) };
        let loader = env
            .call_method(
                &context,
                jni::jni_str!("getClassLoader"),
                jni::jni_sig!("()Ljava/lang/ClassLoader;"),
                &[],
            )?
            .l()?;
        let loader = env.cast_local::<JClassLoader>(loader)?;
        let class = LoaderContext::Loader(&loader).load_class(
            env,
            jni::jni_str!("jp.hatsuboshi.funkotplayer.Import"),
            true,
        )?;
        env.call_static_method(
            &class,
            JNIString::new("hasInFlight"),
            jni::jni_sig!("()Z"),
            &[],
        )?
        .z()
    });
    result.map_err(|e| format!("Import.hasInFlight: {e}"))
}

/// `Import.takeFailed()` — number of URIs that failed to stage since the
/// last call (a destructive read: the Kotlin side resets its counter to
/// zero). Must be called *after* [`android_import_has_in_flight`] on each
/// poll — see [`ImportResult::failed`]'s doc comment and this function's own
/// call site in `take_pending_import` for why that order matters.
///
/// Same classloader routing as [`android_import_has_in_flight`].
#[cfg(target_os = "android")]
fn android_import_take_failed() -> Result<u32, String> {
    use jni::objects::{JClassLoader, JObject};
    use jni::refs::LoaderContext;
    use jni::strings::JNIString;
    use jni::{errors::Result as JResult, Env, JavaVM};

    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) };
    let raw_context = ctx.context() as jni::sys::jobject;

    let result: JResult<i32> = vm.attach_current_thread(|env: &mut Env<'_>| {
        let context = unsafe { JObject::from_raw(env, raw_context) };
        let loader = env
            .call_method(
                &context,
                jni::jni_str!("getClassLoader"),
                jni::jni_sig!("()Ljava/lang/ClassLoader;"),
                &[],
            )?
            .l()?;
        let loader = env.cast_local::<JClassLoader>(loader)?;
        let class = LoaderContext::Loader(&loader).load_class(
            env,
            jni::jni_str!("jp.hatsuboshi.funkotplayer.Import"),
            true,
        )?;
        env.call_static_method(
            &class,
            JNIString::new("takeFailed"),
            jni::jni_sig!("()I"),
            &[],
        )?
        .i()
    });
    result
        .map(|n| n as u32)
        .map_err(|e| format!("Import.takeFailed: {e}"))
}

/// Outcome of the most recent notification ⚑ (`CONTROL_FLAG` = 3).
#[cfg(target_os = "android")]
static LAST_FLAG_OK: AtomicBool = AtomicBool::new(false);

/// Called from `PlaybackService`'s notification actions. `action` is
/// 0 = toggle play/pause, 1 = skip to next track, 2 = query only,
/// 3 = flag last automatic transition (no playback change).
#[cfg(target_os = "android")]
#[no_mangle]
/// Returns packed `paused` + `phase` *after* the action so Kotlin can keep
/// MediaSession / notification in step (see `pack_native_control_state`).
pub extern "C" fn Java_jp_hatsuboshi_funkotplayer_PlaybackService_onNativeControl(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    action: i32,
) -> jni::sys::jint {
    // Flagging only needs `NOW` + `data_dir`; it must not depend on the audio
    // thread having published `PLAYBACK` yet (and must still set LAST_FLAG_OK).
    if action == 3 {
        // Do not touch LAST_FLAG_UNDO — the in-app toast's 取消 must keep
        // pointing at whatever the listener himself flagged.
        let ok = match platform_dirs() {
            Ok(dirs) => flag_last_transition_impl(Path::new(&dirs.data_dir), false).is_ok(),
            Err(_) => false,
        };
        LAST_FLAG_OK.store(ok, Ordering::Relaxed);
        let paused = PLAYBACK
            .get()
            .map(|p| p.paused.load(Ordering::Relaxed))
            .unwrap_or(false);
        return pack_native_control_state(paused, get_phase());
    }

    let Some(playback) = PLAYBACK.get() else {
        return pack_native_control_state(false, get_phase());
    };
    match action {
        0 => {
            // Audition transport is 〔再開〕 only — do not flip shared paused.
            if ensure_pause_allowed(
                AUDITIONING.load(Ordering::Relaxed),
                AUDITION_PREPARING.load(Ordering::Relaxed),
            )
            .is_ok()
            {
                flip_paused(&playback.paused);
            }
        }
        1 => {
            let _ = request_skip_next();
        }
        // 2 = query only, used when the app's own buttons changed the flag.
        _ => {}
    }
    pack_native_control_state(playback.paused.load(Ordering::Relaxed), get_phase())
}

/// Whether the last notification ⚑ (`onNativeControl(3)`) persisted successfully.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_jp_hatsuboshi_funkotplayer_PlaybackService_lastFlagOk(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
) -> jni::sys::jboolean {
    LAST_FLAG_OK.load(Ordering::Relaxed) as jni::sys::jboolean
}

/// Current notification / MediaSession title (embedded tag or file name).
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_jp_hatsuboshi_funkotplayer_PlaybackService_currentTitle<'local>(
    mut env: jni::EnvUnowned<'local>,
    _class: jni::objects::JClass<'local>,
) -> jni::sys::jstring {
    let title = notification_title();
    env.with_env(|env| {
        Ok::<_, jni::errors::Error>(env.new_string(&title)?.into_raw())
    })
    .resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

/// Current MediaSession artist (embedded tag, or empty when absent).
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_jp_hatsuboshi_funkotplayer_PlaybackService_currentArtist<'local>(
    mut env: jni::EnvUnowned<'local>,
    _class: jni::objects::JClass<'local>,
) -> jni::sys::jstring {
    let artist = notification_artist();
    env.with_env(|env| {
        Ok::<_, jni::errors::Error>(env.new_string(&artist)?.into_raw())
    })
    .resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "android")]
    android_logger::init_once(
        android_logger::Config::default()
            .with_max_level(log::LevelFilter::Info)
            .with_tag("funkot"),
    );
    #[cfg(not(target_os = "android"))]
    env_logger::init();

    let builder = tauri::Builder::default().manage(AppState::default());
    // Desktop-only folder-picker for `set_music_dir`. Rust calls it directly
    // (no `invoke` from the webview), so no `capabilities/default.json`
    // permission is needed. Not registered on Android: `set_music_dir`'s
    // Android branch never calls it (see its `#[cfg]` split), and no
    // folder-picker backend exists there anyway.
    #[cfg(not(target_os = "android"))]
    let builder = builder.plugin(tauri_plugin_dialog::init());
    builder
        .setup(|app| {
            // Preload the queue tab before ▶ is pressed: `start_impl` is
            // otherwise the only place `queue.json` / `session.json` get
            // read, so without this the queue screen shows nothing until
            // the listener starts playback at least once. Whatever this
            // restores here, `start_impl` restores again — identically,
            // and idempotently (see its doc comment) — so this is a pure
            // head start, not a second source of truth.
            //
            // Best-effort end to end: on Android, the JNI context
            // `platform_dirs` needs may not be ready this early in the
            // app's lifecycle. Any failure here is `log::warn!`-only; this
            // must never stop the app from launching, and `start_impl`
            // still does the same restore later regardless, so nothing
            // about playback depends on this succeeding.
            use tauri::Manager;
            let handle = app.handle().clone();
            match resolve_dirs(&handle) {
                Ok(dirs) => {
                    let data = PathBuf::from(dirs.data_dir);
                    let _ = DATA_DIR.set(data.clone());
                    let session = store::load_session(&data);
                    let settings = store::load_settings(&data);
                    ALLOW_NON_FUNKOT.store(settings.allow_non_funkot, Ordering::Relaxed);
                    let saved = store::load_queue(&data).unwrap_or_else(|e| {
                        log::warn!("setup: load_queue({}): {e}", data.display());
                        Vec::new()
                    });
                    let restored =
                        store::restored_pending(&session.in_flight, &saved, |p| p.exists());
                    let state = app.state::<AppState>();
                    queue::replace_pending(&state.queue, restored);
                }
                Err(e) => {
                    log::warn!("setup: cannot resolve dirs, queue preload skipped: {e}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_dirs,
            open_music_dir,
            set_music_dir,
            reset_music_dir,
            start,
            poll_log,
            toggle_pause,
            skip_next,
            is_paused,
            player_state,
            audition_transition,
            resume_autodj,
            audition_again,
            flag_last_transition,
            undo_last_flag,
            list_flagged_tracks,
            dismiss_flags,
            undo_last_dismiss,
            refresh_library,
            set_bars,
            enqueue,
            reorder,
            dequeue,
            queue_state,
            get_allow_non_funkot,
            set_allow_non_funkot,
            share_feedback,
            take_pending_import
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
