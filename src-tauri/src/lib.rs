
mod queue;
mod queue_progress;
mod transport_fade;
mod store;
mod store_cache;
mod track_tags;
mod audio_metadata;
mod tag_service;
mod playlists;
mod playlist_progress;
mod playlist_service;
mod engine_observation;
mod playback_diagnostics;
mod navigation_capture;
#[cfg(all(target_os = "windows", any(test, feature = "verified-capture")))]
mod verified_capture_control;
mod playback_recovery;
mod playback_state;
#[cfg(test)]
mod playlist_engine_contract_tests;
#[cfg(test)]
mod manual_plan_log_tests;
#[cfg(test)]
mod library_scan_tests;
#[cfg(any(target_os = "windows", test))]
mod current_track_http;

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use funkot_core::engine::{
    prepare_tracks_parallel, Engine, EngineEvent, NavAction, PreparedTrack,
};
use funkot_core::EngineOptions;

use queue::{DrainPolicy, HostSource, QueueItem, QueueOrigin, SharedQueue};

struct Playback {
    paused: Arc<AtomicBool>,
    nav_tx: SyncSender<NavAction>,
    render: Arc<Mutex<RenderState>>,
    observation: Arc<engine_observation::EngineObservation>,
    sample_rate: u32,
}

impl Playback {
    fn publish_engine_observation(&self, engine: &Engine) {
        self.observation.publish(engine.current_index(), engine.is_finished());
    }

    fn resume_finished_engine(&self) {
        let mut render = self.render.lock().unwrap_or_else(|e| e.into_inner());
        if render.engine.is_finished() { render.engine.resume(); }
        self.publish_engine_observation(&render.engine);
    }
}

static PLAYBACK: OnceLock<Playback> = OnceLock::new();

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

static ALLOW_NON_FUNKOT: AtomicBool = AtomicBool::new(true);

/// Whether Android's foreground playback service has been started for this
/// process. Settings-only actions must not call `syncFrom` before playback:
/// `startForegroundService` would otherwise create a ghost notification.
static SERVICE_RUNNING: AtomicBool = AtomicBool::new(false);

static LOCALE_TAG: Mutex<String> = Mutex::new(String::new());

static HISTORY_REVISION: AtomicU64 = AtomicU64::new(0);

const LABELING_HEAD_SECS: f64 = 20.0;

const LABELING_AVAILABLE: bool = !cfg!(target_os = "android");

fn effective_labeling_mode(setting: bool) -> bool {
    setting && LABELING_AVAILABLE
}

#[cfg(test)]
mod labeling_mode_tests {
    use super::*;

    #[test]
    fn labeling_mode_is_desktop_only() {
        assert!(!effective_labeling_mode(false));
        #[cfg(not(target_os = "android"))]
        assert!(effective_labeling_mode(true));
        #[cfg(target_os = "android")]
        assert!(!effective_labeling_mode(true));
        assert_eq!(effective_labeling_mode(true), LABELING_AVAILABLE);
    }
}

static FOLDER_POS: AtomicUsize = AtomicUsize::new(0);

static FOLDER_LEN: AtomicUsize = AtomicUsize::new(0);

static AUDITIONING: AtomicBool = AtomicBool::new(false);

static AUDITION_PREPARING: AtomicBool = AtomicBool::new(false);

static AUDITION_LOCK: Mutex<()> = Mutex::new(());

fn try_audition_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    match AUDITION_LOCK.try_lock() {
        Ok(guard) => Ok(guard),
        Err(std::sync::TryLockError::Poisoned(poisoned)) => Ok(poisoned.into_inner()),
        Err(std::sync::TryLockError::WouldBlock) => Err("audition in progress".into()),
    }
}

struct AuditionSession {
    pair: Option<(PathBuf, PathBuf)>,
    parked_now: Option<PathBuf>,
    parked_previous: Option<PathBuf>,
    parked_in_progress: Option<(PathBuf, PathBuf, Origin, u64, u64)>,
    parked_now_started_frames: Option<u64>,
    parked_now_entry_frame_out: u64,
}

static AUDITION_SESSION: Mutex<AuditionSession> = Mutex::new(AuditionSession {
    pair: None,
    parked_now: None,
    parked_previous: None,
    parked_in_progress: None,
    parked_now_started_frames: None,
    parked_now_entry_frame_out: 0,
});

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum Phase {
    Idle = 0,
    Starting = 1,
    Playing = 2,
    Paused = 3,
    Stalled = 4,
    Failed = 5,
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

fn record_pause_change(paused: &AtomicBool, now_paused: bool) {
    if now_paused && get_phase() != Phase::Disconnected {
        set_phase(Phase::Paused);
    }
    persist_pause_state(paused);
}

fn persist_pause_state(paused: &AtomicBool) {
    {
        let mut session = SESSION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        session.paused = paused.load(Ordering::Relaxed);
    }
    persist_session();
}

fn resume_finished_engine_before_play() {
    if let Some(playback) = PLAYBACK.get() {
        playback.resume_finished_engine();
    }
}

fn flip_paused(paused: &AtomicBool) -> bool {
    if paused.load(Ordering::Relaxed) {
        resume_finished_engine_before_play();
    }
    let now_paused = !paused.fetch_xor(true, Ordering::Relaxed);
    record_pause_change(paused, now_paused);
    now_paused
}

#[cfg(any(target_os = "android", test))]
fn set_paused(paused: &AtomicBool, desired: bool) -> bool {
    let prior = paused.load(Ordering::Relaxed);
    if prior == desired {
        return false;
    }
    if prior && !desired {
        resume_finished_engine_before_play();
    }
    let previous = paused.swap(desired, Ordering::Relaxed);
    if previous == desired {
        return false;
    }
    record_pause_change(paused, desired);
    true
}

fn ensure_pause_allowed(auditioning: bool, preparing: bool) -> Result<(), String> {
    if auditioning || preparing {
        Err("audition in progress".into())
    } else {
        Ok(())
    }
}

#[cfg_attr(not(any(test, target_os = "android")), allow(dead_code))]
fn pack_native_control_state(paused: bool, phase: Phase) -> i32 {
    ((phase as i32) << 1) | (paused as i32)
}

/// Whether the notification's transport still has a playback session behind
/// it (`playbackAlive` in Kotlin).
///
/// While paused, `PlaybackService` leaves the foreground but keeps its
/// notification, so that notification can outlive both the service and the
/// process: Android keeps it posted for the package, and its `PendingIntent`s
/// then start a *fresh* process where nothing is playing. Kotlin asks this
/// before acting on such a start (and before re-posting from `onDestroy`) so
/// a stale notification retires itself instead of offering transport controls
/// with nothing behind them.
///
/// `Failed` counts as dead — the audio thread gave up — while `Disconnected`
/// does not: `audio_thread` is still retrying the output device.
#[cfg_attr(not(any(test, target_os = "android")), allow(dead_code))]
fn playback_session_alive(has_playback: bool, phase: Phase) -> bool {
    match phase {
        Phase::Idle | Phase::Failed => false,
        Phase::Starting => true,
        _ => has_playback,
    }
}

#[derive(serde::Serialize, Clone, Debug)]
struct AppDirs {
    music_dir: String,
    cache_dir: String,
    data_dir: String,
    music_dir_custom: Option<String>,
    music_dir_unavailable: bool,
    music_dir_needed: bool,
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

    let data = PathBuf::from(&files);
    let cache = data.join("funkot-cache");
    ensure_dirs(Some(Path::new(&music)), &cache, &data)?;
    Ok(AppDirs {
        music_dir: music,
        cache_dir: cache.to_string_lossy().into_owned(),
        data_dir: files,
        music_dir_custom: None,
        music_dir_unavailable: false,
        music_dir_needed: false,
        music_dir_configurable: false,
    })
}

#[cfg(not(target_os = "android"))]
fn platform_dirs(app: &tauri::AppHandle) -> Result<AppDirs, String> {
    use tauri::Manager;

    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    let cache = base.join("funkot-cache");
    ensure_dirs(None, &cache, &base)?;
    let configured = store::load_settings(&base).music_dir;
    let (music, unavailable, needed) = resolve_music_dir(configured.as_deref(), |p| {
        std::fs::read_dir(p).is_ok()
    });
    if unavailable {
        log::warn!(
            "configured music dir {} is not readable; music_dir_needed until a usable folder is chosen",
            configured.as_deref().unwrap_or(Path::new("")).display()
        );
    }
    ensure_dirs(music.as_deref(), &cache, &base)?;
    Ok(AppDirs {
        music_dir: music
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        cache_dir: cache.to_string_lossy().into_owned(),
        data_dir: base.to_string_lossy().into_owned(),
        music_dir_custom: configured.map(|p| p.to_string_lossy().into_owned()),
        music_dir_unavailable: unavailable,
        music_dir_needed: needed,
        music_dir_configurable: true,
    })
}

#[cfg_attr(target_os = "android", allow(dead_code))]
fn resolve_music_dir(
    configured: Option<&Path>,
    readable: impl Fn(&Path) -> bool,
) -> (Option<PathBuf>, bool, bool) {
    match configured {
        None => (None, false, true),
        Some(p) if readable(p) => (Some(p.to_path_buf()), false, false),
        Some(_) => (None, true, true),
    }
}

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

#[cfg(not(target_os = "android"))]
fn inspect_picked_music_dir(path: &Path, data_dir: &Path) -> Result<(), &'static str> {
    check_music_dir_shape(path, data_dir)?;
    match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err("not_found"),
        Err(_) => Err("not_readable"),
        Ok(meta) if !meta.is_dir() => Err("not_a_directory"),
        Ok(_) => {
            if std::fs::read_dir(path).is_err() {
                Err("not_readable")
            } else {
                Ok(())
            }
        }
    }
}

#[cfg(not(target_os = "android"))]
fn store_picked_music_dir(data_dir: &Path, path: &Path) -> Result<(), String> {
    let _index = INDEX_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut settings = store::load_settings(data_dir);
    let path_changed = settings.music_dir.as_deref() != Some(path);
    settings.music_dir = Some(path.to_path_buf());
    if path_changed {
        settings.arrivals_baseline_done = false;
    }
    store::save_settings(data_dir, &settings).map_err(|e| format!("cannot save settings: {e}"))
}

#[cfg(test)]
mod music_dir_tests {
    use super::*;

    #[test]
    fn resolve_music_dir_unset_is_needed() {
        let (music, unavailable, needed) = resolve_music_dir(None, |_| true);
        assert!(music.is_none());
        assert!(!unavailable);
        assert!(needed);
    }

    #[test]
    fn resolve_music_dir_uses_configured_when_readable() {
        let configured = Path::new("/elsewhere/MyMusic");
        let (music, unavailable, needed) =
            resolve_music_dir(Some(configured), |_| true);
        assert_eq!(music.as_deref(), Some(configured));
        assert!(!unavailable);
        assert!(!needed);
    }

    #[test]
    fn resolve_music_dir_unreadable_is_needed() {
        let configured = Path::new("/gone/MyMusic");
        let (music, unavailable, needed) =
            resolve_music_dir(Some(configured), |_| false);
        assert!(music.is_none());
        assert!(unavailable);
        assert!(needed);
    }

    fn shape_data_dir() -> PathBuf {
        std::env::current_dir().unwrap().join("shape-fixture").join("app")
    }

    #[test]
    fn check_music_dir_shape_rejects_a_relative_path() {
        let data_dir = shape_data_dir();
        assert_eq!(
            check_music_dir_shape(Path::new("relative/Music"), &data_dir),
            Err("not_absolute")
        );
    }

    #[test]
    fn check_music_dir_shape_rejects_a_parent_of_data_dir() {
        let data_dir = shape_data_dir();
        assert_eq!(
            check_music_dir_shape(data_dir.parent().unwrap(), &data_dir),
            Err("contains_app_data")
        );
    }

    #[test]
    fn check_music_dir_shape_accepts_a_sibling_of_data_dir() {
        let data_dir = shape_data_dir();
        assert_eq!(
            check_music_dir_shape(&data_dir.with_file_name("Music"), &data_dir),
            Ok(())
        );
    }

    #[test]
    fn check_music_dir_shape_accepts_the_default_music_dir() {
        let data_dir = shape_data_dir();
        assert_eq!(check_music_dir_shape(&data_dir.join("Music"), &data_dir), Ok(()));
    }

    #[test]
    fn check_music_dir_shape_rejects_when_candidate_equals_data_dir() {
        let data_dir = shape_data_dir();
        assert_eq!(
            check_music_dir_shape(&data_dir, &data_dir),
            Err("contains_app_data")
        );
    }

    #[test]
    fn resolve_music_dir_probes_only_the_configured_path() {
        let configured = Path::new("/elsewhere/MyMusic");
        let probed = std::cell::Cell::new(Vec::new());
        let (_, _, _) = resolve_music_dir(Some(configured), |p| {
            let mut seen = probed.take();
            seen.push(p.to_path_buf());
            probed.set(seen);
            true
        });
        assert_eq!(probed.into_inner(), vec![configured.to_path_buf()]);
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn inspect_picked_music_dir_rejects_a_missing_folder() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("missing");
        let data = root.path().join("data");
        assert_eq!(
            inspect_picked_music_dir(&missing, &data),
            Err("not_found")
        );
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn inspect_picked_music_dir_rejects_a_file() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("track.mp3");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(
            inspect_picked_music_dir(&file, &root.path().join("data")),
            Err("not_a_directory")
        );
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn inspect_picked_music_dir_accepts_a_readable_directory() {
        let root = tempfile::tempdir().unwrap();
        let music = root.path().join("Music");
        std::fs::create_dir(&music).unwrap();
        assert_eq!(
            inspect_picked_music_dir(&music, &root.path().join("data")),
            Ok(())
        );
    }

    #[cfg(all(unix, not(target_os = "android")))]
    #[test]
    fn inspect_picked_music_dir_follows_whether_this_process_can_list_the_directory() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let music = root.path().join("Music");
        std::fs::create_dir(&music).unwrap();
        std::fs::set_permissions(&music, std::fs::Permissions::from_mode(0o000)).unwrap();
        let readable = std::fs::read_dir(&music).is_ok();
        let result = inspect_picked_music_dir(&music, &root.path().join("data"));
        std::fs::set_permissions(&music, std::fs::Permissions::from_mode(0o700)).unwrap();
        if readable {
            assert_eq!(result, Ok(()));
        } else {
            assert_eq!(result, Err("not_readable"));
        }
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn store_picked_music_dir_clears_the_baseline_when_the_folder_changes() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        store::save_settings(
            root.path(),
            &store::Settings {
                music_dir: Some(first),
                arrivals_baseline_done: true,
                ..store::Settings::default()
            },
        )
        .unwrap();
        store_picked_music_dir(root.path(), &second).unwrap();
        let loaded = store::load_settings(root.path());
        assert_eq!(loaded.music_dir.as_deref(), Some(second.as_path()));
        assert!(!loaded.arrivals_baseline_done);
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn store_picked_music_dir_keeps_the_baseline_for_the_same_folder() {
        let root = tempfile::tempdir().unwrap();
        let music = root.path().join("Music");
        std::fs::create_dir(&music).unwrap();
        store::save_settings(
            root.path(),
            &store::Settings {
                music_dir: Some(music.clone()),
                arrivals_baseline_done: true,
                ..store::Settings::default()
            },
        )
        .unwrap();
        store_picked_music_dir(root.path(), &music).unwrap();
        let loaded = store::load_settings(root.path());
        assert_eq!(loaded.music_dir.as_deref(), Some(music.as_path()));
        assert!(loaded.arrivals_baseline_done);
    }
}

static MIGRATED: std::sync::Once = std::sync::Once::new();

fn ensure_dirs(
    music: Option<&std::path::Path>,
    cache: &std::path::Path,
    data: &std::path::Path,
) -> Result<(), String> {
    if let Some(music) = music {
        std::fs::create_dir_all(music)
            .map_err(|e| format!("cannot create {}: {e}", music.display()))?;
    }
    for dir in [cache, data] {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    MIGRATED.call_once(|| store::migrate_from(cache, data));
    Ok(())
}

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
    if dirs.music_dir_needed {
        return Err("music_dir_needed".into());
    }
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

#[derive(serde::Serialize, Clone, Debug)]
struct SetMusicDirResult {
    changed: bool,
    dirs: AppDirs,
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
/// `title` is the dialog's window title, passed in already translated. The
/// UI's message catalogue is the only place any of these words live, so this
/// layer takes the string rather than holding a second, unreachable copy of
/// it per language.
///
/// Always `async`: `FileDialog::pick_folder` blocks, so it must never run
/// on the main thread.
#[tauri::command(async)]
fn set_music_dir(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    title: String,
) -> Result<SetMusicDirResult, String> {
    #[cfg(target_os = "android")]
    {
        let _ = (&app, &state, &title);
        return Err("unsupported_platform".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        use tauri::Manager;

        let dirs = resolve_dirs(&app)?;

        let mut dialog = rfd::FileDialog::new().set_title(&title);
        if !dirs.music_dir.is_empty() {
            dialog = dialog.set_directory(&dirs.music_dir);
        }
        if let Some(window) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        let Some(path) = dialog.pick_folder() else {
            return Ok(SetMusicDirResult {
                changed: false,
                dirs,
                restart_required: false,
            });
        };
        let data = Path::new(&dirs.data_dir);
        inspect_picked_music_dir(&path, data)?;
        store_picked_music_dir(data, &path)?;

        let dirs = resolve_dirs(&app)?;
        let restart_required = *state.started.lock().unwrap();
        Ok(SetMusicDirResult {
            changed: true,
            dirs,
            restart_required,
        })
    }
}

#[derive(serde::Serialize, Clone, Debug)]
struct ShareFeedbackResult {
    mode: String,
    path: String,
}

#[tauri::command(async)]
fn share_feedback(app: tauri::AppHandle, title: String) -> Result<ShareFeedbackResult, String> {
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
        feedback_share(&path, &title)?;
        Ok(ShareFeedbackResult {
            mode: "shared".into(),
            path,
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = title;
        Ok(ShareFeedbackResult {
            mode: "saved".into(),
            path,
        })
    }
}

#[derive(serde::Serialize, Clone, Debug, Default)]
struct ImportResult {
    tracks: u32,
    skipped: u32,
    failed: u32,
    in_flight: bool,
}

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

        let in_flight = android_import_has_in_flight()?;

        let staging_dir = android_cache_dir()?.join("funkot-import");

        let failed = android_import_take_failed()?;

        let mut result = ImportResult {
            in_flight,
            failed,
            ..ImportResult::default()
        };
        let entries = match std::fs::read_dir(&staging_dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(result),
            Err(e) => return Err(format!("cannot read {}: {e}", staging_dir.display())),
        };

        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("part") {
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

static INDEX_LOCK: Mutex<()> = Mutex::new(());

static SAVE_LOCK: Mutex<()> = Mutex::new(());

static LAST_FLAG_UNDO: Mutex<Option<String>> = Mutex::new(None);

static LAST_DISMISS_UNDO: Mutex<Option<String>> = Mutex::new(None);

#[derive(Debug, Clone, PartialEq, Eq)]
struct FolderLabelUndo {
    hash: String,
    label: Option<store::TrackLabel>,
    funkot: Option<bool>,
}

static LAST_FOLDER_LABEL_UNDO: Mutex<Option<Vec<FolderLabelUndo>>> = Mutex::new(None);

static SESSION: Mutex<store::Session> = Mutex::new(store::Session::new());

static MANUAL_PRIORITY_REQUEST: AtomicU64 = AtomicU64::new(0);

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

struct StallWatch {
    silent_frames: u64,
    stall_after_frames: u64,
    started: bool,
}

const STALL_AFTER: std::time::Duration = std::time::Duration::from_secs(2);

impl StallWatch {
    fn new(sample_rate: u32) -> Self {
        Self {
            silent_frames: 0,
            stall_after_frames: STALL_AFTER.as_secs() * u64::from(sample_rate),
            started: false,
        }
    }

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

    fn reset_silence(&mut self) {
        self.silent_frames = 0;
    }
}

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
        assert!(!w.observe(5, false));
        assert!(!w.observe(5, false));
        assert!(w.observe(5, false));
    }

    #[test]
    fn recovering_after_stuck_resets_and_reports_alive() {
        let mut w = CallbackWatch::new(5);
        assert!(!w.observe(5, false));
        assert!(!w.observe(5, false));
        assert!(w.observe(5, false));
        assert!(!w.observe(6, false));
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
        w.observe(4, false);
        assert!(w.observe(3, true) == Phase::Playing);
        assert!(w.observe(1, true) == Phase::Stalled);
        assert!(w.observe(100, true) == Phase::Stalled);
    }

    #[test]
    fn recovers_to_playing_once_sound_returns() {
        let mut w = watch();
        w.observe(4, false);
        w.observe(4, true);
        assert!(w.observe(1, true) == Phase::Stalled);
        assert!(w.observe(4, false) == Phase::Playing);
    }

    #[test]
    fn pausing_does_not_bank_silence_toward_a_stall() {
        let mut w = watch();
        w.observe(4, false);
        for _ in 0..10 {
            w.reset_silence();
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
    fn set_pause_and_play_are_idempotent() {
        let _guard = PHASE_LOCK.lock().unwrap();
        set_phase(Phase::Playing);
        let paused = AtomicBool::new(false);
        assert!(set_paused(&paused, true));
        assert!(paused.load(Ordering::Relaxed));
        assert!(!set_paused(&paused, true));
        assert!(set_paused(&paused, false));
        assert!(!paused.load(Ordering::Relaxed));
        assert!(!set_paused(&paused, false));
        set_phase(Phase::Idle);
    }

    #[test]
    fn toggle_remains_compatible_with_set_pause() {
        let _guard = PHASE_LOCK.lock().unwrap();
        set_phase(Phase::Playing);
        let paused = AtomicBool::new(false);
        assert!(flip_paused(&paused));
        assert!(!set_paused(&paused, true));
        assert!(!flip_paused(&paused));
        assert!(!set_paused(&paused, false));
        set_phase(Phase::Idle);
    }

    #[test]
    fn set_pause_while_disconnected_keeps_phase() {
        let _guard = PHASE_LOCK.lock().unwrap();
        set_phase(Phase::Disconnected);
        let paused = AtomicBool::new(false);
        assert!(set_paused(&paused, true));
        assert!(paused.load(Ordering::Relaxed));
        assert!(get_phase() == Phase::Disconnected);
        set_phase(Phase::Idle);
    }

    #[test]
    fn finished_pause_is_mirrored_to_session() {
        let _guard = PHASE_LOCK.lock().unwrap();
        let paused = AtomicBool::new(false);
        set_phase(Phase::Playing);
        persist_pause_state(&paused);
        assert!(!SESSION.lock().unwrap().paused);

        paused.store(true, Ordering::Relaxed);
        set_phase(Phase::Paused);
        persist_pause_state(&paused);
        assert!(SESSION.lock().unwrap().paused);
        assert!(get_phase() == Phase::Paused);
        set_phase(Phase::Idle);
    }

    #[test]
    fn delayed_finished_mirror_preserves_newer_play_and_phase() {
        let _guard = PHASE_LOCK.lock().unwrap();
        let paused = AtomicBool::new(true);
        persist_pause_state(&paused);
        assert!(SESSION.lock().unwrap().paused);

        paused.store(false, Ordering::Relaxed);
        set_phase(Phase::Playing);
        persist_pause_state(&paused);
        assert!(!SESSION.lock().unwrap().paused);
        assert!(!paused.load(Ordering::Relaxed));
        assert!(get_phase() == Phase::Playing);

        paused.store(true, Ordering::Relaxed);
        set_phase(Phase::Disconnected);
        persist_pause_state(&paused);
        assert!(SESSION.lock().unwrap().paused);
        assert!(get_phase() == Phase::Disconnected);
        set_phase(Phase::Idle);
    }

    #[test]
    fn pack_native_control_state_encodes_paused_and_phase() {
        assert!(
            pack_native_control_state(true, Phase::Disconnected)
                == ((Phase::Disconnected as i32) << 1) | 1
        );
        assert!(
            pack_native_control_state(false, Phase::Playing) == (Phase::Playing as i32) << 1
        );
    }

    #[test]
    fn stale_notification_has_no_live_playback_session() {
        assert!(!playback_session_alive(false, Phase::Idle));
        assert!(!playback_session_alive(false, Phase::Playing));
        assert!(playback_session_alive(false, Phase::Starting));
        assert!(!playback_session_alive(true, Phase::Failed));
        assert!(playback_session_alive(true, Phase::Paused));
        assert!(playback_session_alive(true, Phase::Disconnected));
        assert!(playback_session_alive(true, Phase::Playing));
    }

    #[test]
    fn pause_rejected_while_auditioning() {
        assert!(ensure_pause_allowed(true, false).is_err());
        assert!(ensure_pause_allowed(false, true).is_err());
        assert!(ensure_pause_allowed(true, true).is_err());
        assert!(ensure_pause_allowed(false, false).is_ok());
    }

    #[test]
    fn failed_audition_prepare_restores_the_listeners_pause() {
        for before in [true, false] {
            let paused = AtomicBool::new(before);
            let built = prepare_audition(
                &paused,
                || {
                    assert!(paused.load(Ordering::Relaxed), "queue muted while preparing");
                    Err::<(), _>("prepare audition tracks: unreadable".to_string())
                },
                |_| Ok(()),
            );
            assert!(built.is_err());
            assert_eq!(paused.load(Ordering::Relaxed), before, "failed build");
            let installed = prepare_audition(&paused, || Ok(()), |_| Err("not playing".to_string()));
            assert!(installed.is_err());
            assert_eq!(paused.load(Ordering::Relaxed), before, "failed install");
        }
    }

    #[test]
    fn overlapping_audition_work_refuses_resume_and_pause() {
        let _in_flight = AUDITION_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(resume_autodj(), Err("audition in progress".to_string()));
        assert_eq!(toggle_pause(), Err("audition in progress".to_string()));
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Origin {
    Automatic,
    Manual,
    Audition,
}

enum PlaybackEvent {
    Engine { event: EngineEvent, audition: bool },
    TransitionEnded { audition: bool },
}

struct CompletedTransition {
    from: PathBuf,
    to: PathBuf,
    origin: Origin,
    at: Instant,
}

struct NowTracker {
    now: Option<PathBuf>,
    previous: Option<PathBuf>,
    in_progress: Option<(PathBuf, PathBuf, Origin, u64, u64)>,
    last_transition: Option<CompletedTransition>,
    now_started_frames: Option<u64>,
    now_entry_frame_out: u64,
}

impl NowTracker {
    const fn new() -> Self {
        Self {
            now: None,
            previous: None,
            in_progress: None,
            last_transition: None,
            now_started_frames: None,
            now_entry_frame_out: 0,
        }
    }

    fn on_transition_started(&mut self, from: PathBuf, to: PathBuf, origin: Origin, at_frames: u64, entry_frame_out: u64) {
        if let Some((old_from, old_to, _, stamp, entry)) = self.in_progress.take() {
            self.previous = Some(old_from);
            self.now = Some(old_to);
            self.now_started_frames = Some(stamp);
            self.now_entry_frame_out = entry;
        }
        self.in_progress = Some((from, to, origin, at_frames, entry_frame_out));
    }

    fn on_track_started(&mut self, path: PathBuf, at_frames: u64, entry_frame_out: u64) {
        if self.in_progress.is_none() {
            self.now = Some(path);
            self.now_started_frames = Some(at_frames);
            self.now_entry_frame_out = entry_frame_out;
        }
    }

    fn on_transition_ended(&mut self) -> Option<(PathBuf, PathBuf, Origin)> {
        let (from, to, origin, stamp, entry) = self.in_progress.take()?;
        self.previous = Some(from.clone());
        self.now = Some(to.clone());
        self.now_started_frames = Some(stamp);
        self.now_entry_frame_out = entry;
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
        t.on_track_started(p("a.wav"), 100, 0);
        assert_eq!(t.now, Some(p("a.wav")));
        assert_eq!(t.previous, None);
        assert_eq!(t.now_started_frames, Some(100), "now_started_frames must land on the stamp TrackStarted was reported at");
    }

    #[test]
    fn transition_started_alone_does_not_move_now_until_it_ends() {
        let mut t = NowTracker::new();
        t.on_track_started(p("a.wav"), 100, 0);
        t.on_transition_started(p("a.wav"), p("b.wav"), Origin::Automatic, 200, 0);
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
        t.on_track_started(p("a.wav"), 100, 0);
        t.on_transition_started(p("a.wav"), p("b.wav"), Origin::Automatic, 200, 0);
        t.on_track_started(p("b.wav"), 250, 0);
        assert_eq!(t.now, Some(p("a.wav")));
    }

    #[test]
    fn a_transition_started_while_one_is_in_progress_folds_the_interrupted_one_in() {
        let mut t = NowTracker::new();
        t.on_track_started(p("a.wav"), 100, 0);
        t.on_transition_started(p("a.wav"), p("b.wav"), Origin::Automatic, 200, 0);
        t.on_transition_started(p("b.wav"), p("c.wav"), Origin::Automatic, 300, 0);
        assert_eq!(t.now, Some(p("b.wav")), "the interrupted transition's destination is what is actually playing");
        assert_eq!(t.previous, Some(p("a.wav")));
        assert_eq!(t.now_started_frames, Some(200), "now_started_frames must promote to the interrupted transition's own stamp, not the one that interrupted it");
        assert!(t.last_transition.is_none());
    }

    #[test]
    fn the_transition_that_did_the_interrupting_is_recorded_normally_once_it_ends() {
        let mut t = NowTracker::new();
        t.on_track_started(p("a.wav"), 100, 0);
        t.on_transition_started(p("a.wav"), p("b.wav"), Origin::Automatic, 200, 0);
        t.on_transition_started(p("b.wav"), p("c.wav"), Origin::Automatic, 300, 0);
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
        t.on_track_started(p("a.wav"), 100, 0);
        t.on_transition_started(p("a.wav"), p("b.wav"), Origin::Automatic, 200, 0);
        t.on_transition_ended();
        let last = t.last_transition.as_ref().expect("automatic transition should be recorded");
        assert_eq!(last.from, p("a.wav"));
        assert_eq!(last.to, p("b.wav"));
        assert_eq!(last.origin, Origin::Automatic);
    }

    #[test]
    fn manual_transition_is_not_recorded_as_the_last_automatic_transition() {
        let mut t = NowTracker::new();
        t.on_track_started(p("a.wav"), 100, 0);
        t.on_transition_started(p("a.wav"), p("b.wav"), Origin::Manual, 200, 0);
        t.on_transition_ended();
        assert!(t.last_transition.is_none());
        assert_eq!(t.now, Some(p("b.wav")));
    }

    #[test]
    fn audition_transition_is_not_recorded_as_the_last_automatic_transition() {
        let mut t = NowTracker::new();
        t.on_track_started(p("a.wav"), 100, 0);
        t.on_transition_started(p("a.wav"), p("b.wav"), Origin::Audition, 200, 0);
        t.on_transition_ended();
        assert!(t.last_transition.is_none());
        assert_eq!(t.now, Some(p("b.wav")));
    }

    #[test]
    fn restart_current_is_not_recorded_as_the_last_automatic_transition() {
        let mut t = NowTracker::new();
        t.on_track_started(p("a.wav"), 100, 0);
        t.on_transition_started(p("a.wav"), p("a.wav"), Origin::Automatic, 200, 0);
        t.on_transition_ended();
        assert!(t.last_transition.is_none());
        assert_eq!(t.now, Some(p("a.wav")));
    }

    #[test]
    fn incoming_position_includes_skipped_intro_at_pause_and_natural_end() {
        for sample_rate in [44_100u32, 48_000] {
            // Issue #44: a 120s source at 180 BPM stretches to 109.09s.
            // The incoming 32-bar intro is entered 16 bars in, after the
            // first downbeat. Audible elapsed alone ended near 1:29/1:49.
            let full = (120.0 / 1.1 * sample_rate as f64).round() as u64;
            let entry = (16.0 * 4.0 * 60.0 / 198.0 * sample_rate as f64).round() as u64
                + sample_rate as u64 / 12;
            let start = sample_rate as u64 * 500;
            let mut t = NowTracker::new();
            t.on_track_started(p("a.wav"), 0, 11);
            t.on_transition_started(p("a.wav"), p("b.wav"), Origin::Automatic, start, entry);
            t.on_track_started(p("b.wav"), start + 192, entry);
            assert_eq!(t.now_entry_frame_out, 11);
            t.on_transition_ended();
            let position = |frames| track_position_secs(
                frames, t.now_started_frames.unwrap(), t.now_entry_frame_out, sample_rate,
            ).unwrap();
            let paused_at = start + sample_rate as u64 * 30;
            assert_eq!(position(paused_at), 30.0 + entry as f64 / sample_rate as f64);
            assert_eq!(position(start + full - entry), full as f64 / sample_rate as f64);
            assert_eq!(position(start + full - entry).floor() as u64, 109);
            assert_eq!(((full - entry) as f64 / sample_rate as f64).floor() as u64, 89);
        }
        assert_eq!(track_position_secs(50, 100, 7, 0), None);
        assert_eq!(track_position_secs(50, 100, 7, 10), Some(0.7));
    }

    #[test]
    fn entry_offsets_follow_interrupts_and_same_path_restarts() {
        let mut t = NowTracker::new();
        t.on_track_started(p("a.wav"), 100, 10);
        t.on_transition_started(p("a.wav"), p("b.wav"), Origin::Automatic, 200, 2000);
        t.on_transition_started(p("b.wav"), p("c.wav"), Origin::Manual, 300, 3000);
        assert_eq!((t.now_started_frames, t.now_entry_frame_out), (Some(200), 2000));
        t.on_transition_ended();
        assert_eq!((t.now_started_frames, t.now_entry_frame_out), (Some(300), 3000));
        t.on_transition_started(p("c.wav"), p("c.wav"), Origin::Manual, 400, 20);
        t.on_transition_ended();
        assert_eq!((t.now_started_frames, t.now_entry_frame_out), (Some(400), 20));
        t.on_track_started(p("b.wav"), 500, 30);
        assert_eq!((t.now_started_frames, t.now_entry_frame_out), (Some(500), 30));
    }

    #[test]
    fn transition_ended_without_one_in_progress_is_a_no_op() {
        let mut t = NowTracker::new();
        t.on_track_started(p("a.wav"), 100, 0);
        let before_now = t.now.clone();
        let before_previous = t.previous.clone();
        assert!(t.on_transition_ended().is_none());
        assert_eq!(t.now, before_now);
        assert_eq!(t.previous, before_previous);
        assert!(t.last_transition.is_none());
    }
}

static NOW: Mutex<NowTracker> = Mutex::new(NowTracker::new());

static EVENTS_DROPPED: AtomicU64 = AtomicU64::new(0);

static CALLBACK_TICKS: AtomicU64 = AtomicU64::new(0);

static MAIN_FRAMES: AtomicU64 = AtomicU64::new(0);

static NEXT_PREPARED: AtomicBool = AtomicBool::new(false);

static YIELD_FOR_LOADER: AtomicBool = AtomicBool::new(false);

static FRAMES_UNTIL_TRANSITION: AtomicU64 = AtomicU64::new(u64::MAX);

static STREAM_ERROR_SEEN: AtomicBool = AtomicBool::new(false);

const REOPEN_COOLDOWN: Duration = Duration::from_secs(2);

struct RenderState {
    engine: Engine,
    audition: Option<Engine>,
    stall: StallWatch,
    was_in_transition: bool,
}

static NAV_REQUESTED_MS: AtomicU64 = AtomicU64::new(0);

const NAV_MARK_TTL: Duration = Duration::from_secs(10);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn request_skip_next() -> Result<(), String> {
    navigation_capture::request_next();
    if AUDITIONING.load(Ordering::Relaxed) {
        return Err("skip is disabled while auditioning".into());
    }
    let playback = PLAYBACK.get().ok_or("not playing")?;
    let _request = MANUAL_NEXT_REQUEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if manual_next_owns_analysis(
        MANUAL_NEXT_PENDING.load(Ordering::Acquire),
        MANUAL_NEXT_IN_FLIGHT.load(Ordering::Acquire)) {
        return Ok(());
    }
    let current = playback.observation.read()
        .or_else(|| playback.observation.read())
        .and_then(|snapshot| snapshot.current)
        .ok_or("current track not ready")?;
    MANUAL_NEXT_EXPECTED_INDEX.store(current, Ordering::Release);
    MANUAL_NEXT_PENDING.store(true, Ordering::Release);
    drop(_request);
    if next_dispatch_ready() && dispatch_manual_next(playback)? {
        return Ok(());
    }
    std::thread::Builder::new()
        .name("funkot-next-wait".into())
        .spawn(|| {
            while MANUAL_NEXT_PENDING.load(Ordering::Acquire) {
                if matches!(get_phase(), Phase::Idle | Phase::Failed | Phase::Disconnected) {
                    MANUAL_NEXT_PENDING.store(false, Ordering::Release);
                    break;
                }
                if next_dispatch_ready() {
                    if let Some(playback) = PLAYBACK.get() {
                        match dispatch_manual_next(playback) {
                            Ok(true) => break,
                            Ok(false) => {},
                            Err(error) => {
                                log::warn!("manual Next dispatch failed: {error}");
                                MANUAL_NEXT_PENDING.store(false, Ordering::Release);
                                break;
                            }
                        }
                    } else {
                        MANUAL_NEXT_PENDING.store(false, Ordering::Release);
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        })
        .map_err(|e| {
            MANUAL_NEXT_PENDING.store(false, Ordering::Release);
            e.to_string()
        })?;
    Ok(())
}

fn manual_next_owns_analysis(pending: bool, in_flight: bool) -> bool {
    pending || in_flight
}

fn manual_next_completed(expected: usize, current: Option<usize>, finished: bool) -> bool {
    finished || current != Some(expected)
}

fn next_dispatch_ready() -> bool {
    NEXT_PREPARED.load(Ordering::Acquire)
        && !LIBRARY_ANALYSIS_BUSY.load(Ordering::Acquire)
}

fn dispatch_manual_next(playback: &Playback) -> Result<bool, String> {
    use std::sync::mpsc::TrySendError;
    if !MANUAL_NEXT_PENDING.load(Ordering::Acquire) { return Ok(false); }
    let expected = MANUAL_NEXT_EXPECTED_INDEX.load(Ordering::Acquire);
    let Some(snapshot) = playback.observation.read() else { return Ok(false); };
    if snapshot.current != Some(expected) || snapshot.finished {
        MANUAL_NEXT_PENDING.store(false, Ordering::Release);
        return Ok(false);
    }
    NAV_REQUESTED_MS.store(now_ms(), Ordering::Relaxed);
    MANUAL_NEXT_IN_FLIGHT.store(true, Ordering::Release);
    match playback.nav_tx.try_send(NavAction::TransitionToNext) {
        Ok(()) => {
            MANUAL_NEXT_PENDING.store(false, Ordering::Release);
            Ok(true)
        }
        Err(error) => {
            MANUAL_NEXT_IN_FLIGHT.store(false, Ordering::Release);
            NAV_REQUESTED_MS.store(0, Ordering::Relaxed);
            match error {
                TrySendError::Full(_) => Ok(false),
                TrySendError::Disconnected(_) => {
                    MANUAL_NEXT_PENDING.store(false, Ordering::Release);
                    Err("navigation channel disconnected".into())
                }
            }
        }
    }
}

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
    fn current_index_releases_next_without_a_transition_event() {
        assert!(!manual_next_completed(7, Some(7), false));
        assert!(manual_next_completed(7, Some(8), false));
        assert!(manual_next_completed(7, None, true));
    }

    #[test]
    fn analysis_yields_for_a_sent_next_even_after_attribution_mark_expires() {
        let ttl_ms = NAV_MARK_TTL.as_millis() as u64;
        assert_eq!(nav_origin(1_000, 1_000 + ttl_ms + 1), Origin::Automatic);
        assert!(manual_next_owns_analysis(false, true));
        assert!(manual_next_owns_analysis(true, false));
        assert!(!manual_next_owns_analysis(false, false));
    }

    #[test]
    fn a_mark_exactly_at_the_ttl_boundary_is_still_manual() {
        let ttl_ms = NAV_MARK_TTL.as_millis() as u64;
        assert_eq!(nav_origin(1_000, 1_000 + ttl_ms), Origin::Manual);
    }
}

fn resolve_nav_origin() -> Origin {
    let marked = NAV_REQUESTED_MS.swap(0, Ordering::Relaxed);
    nav_origin(marked, now_ms())
}

fn file_name_str(path: &Path) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("?")
        .to_string()
}

fn path_str(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct CachedTags {
    title: Option<String>,
    artist: Option<String>,
}

static TAG_CACHE: LazyLock<Mutex<HashMap<PathBuf, CachedTags>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

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

static LAST_SESSION_META: Mutex<(Option<PathBuf>, String, String)> =
    Mutex::new((None, String::new(), String::new()));

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

#[cfg(any(target_os = "windows", test))]
fn current_track_http_snapshot() -> current_track_http::CurrentTrackSnapshot {
    let (path, auditioning) = {
        let now = NOW.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        (now.now.clone(), AUDITIONING.load(Ordering::Relaxed) || AUDITION_PREPARING.load(Ordering::Relaxed))
    };
    let Some(path) = path else { return current_track_http::CurrentTrackSnapshot::empty(); };
    if auditioning { return current_track_http::CurrentTrackSnapshot::empty(); }
    let tags = cached_tags_for(&path);
    let metadata = session_metadata_for(Some(path.as_path()), &tags);
    let now = NOW.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if now.now.as_ref() != Some(&path) {
        return current_track_http::CurrentTrackSnapshot::empty();
    }
    current_track_http::CurrentTrackSnapshot::from_state(
        Some(metadata),
        get_phase() == Phase::Playing,
        is_paused(),
        AUDITIONING.load(Ordering::Relaxed) || AUDITION_PREPARING.load(Ordering::Relaxed),
    )
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn notification_title() -> String {
    session_metadata().0
}

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

    #[test]
    fn untagged_uses_file_name() {
        assert_eq!(
            session_metadata_for(Some(Path::new("/music/track.wav")), &CachedTags::default()),
            ("track.wav".into(), String::new())
        );
    }
}

fn is_stale_audition_event(audition: bool, auditioning: bool) -> bool {
    audition && !auditioning
}

fn lock_now_unless_stale(audition: bool) -> Option<std::sync::MutexGuard<'static, NowTracker>> {
    let now = NOW.lock().unwrap();
    if is_stale_audition_event(audition, AUDITIONING.load(Ordering::Relaxed)) {
        return None;
    }
    Some(now)
}

fn retire_started_in_flight(item: &QueueItem) {
    {
        let mut session = SESSION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        store::retire_revoked(&mut session.in_flight, item);
    }
    persist_session();
}

fn record_heard(path: &Path, origin: Option<QueueOrigin>) {
    let Some(data_dir) = DATA_DIR.get() else {
        log::warn!("record_heard: DATA_DIR not resolved yet");
        return;
    };
    let hash = match store_cache::content_hash(data_dir, path) {
        Ok(h) => h,
        Err(e) => {
            log::warn!("record_heard: cannot hash {}: {e}", path.display());
            return;
        }
    };
    let at_ms = now_ms();
    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let entry = store::PlayLogEntry {
        at_ms,
        hash: hash.clone(),
        origin,
    };
    if let Err(e) = store::append_play_log(data_dir, &entry) {
        log::warn!("cannot append play log: {e}");
    } else if store::play_log_needs_compaction(data_dir, store::PLAY_LOG_COMPACT_BYTES) {
        if let Err(e) = store::compact_play_log(data_dir, store::PLAY_LOG_MAX_ENTRIES) {
            log::warn!("cannot compact play log: {e}");
        }
    }
    let mut history = store::load_history(data_dir);
    store::record_play(&mut history, &hash, at_ms);
    match store::save_history(data_dir, &history) {
        Ok(()) => {
            HISTORY_REVISION.fetch_add(1, Ordering::Relaxed);
        }
        Err(e) => {
            log::warn!("cannot persist history: {e}");
        }
    }
}

fn log_manual_plan(render: &Mutex<RenderState>) {
    let plan = {
        let render = render.lock().unwrap_or_else(|e| e.into_inner());
        render.engine.last_manual_plan_diagnostic()
    };
    if let Some(plan) = plan {
        log::info!("manual next plan: reason={}, simple={}, entry={}, start={}",
            plan.reason, plan.simple, plan.entry, plan.start);
    } else {
        log::info!("manual next plan: no local plan (head-only or direct navigation)");
    }
}

fn events_thread(rx: Receiver<PlaybackEvent>) {
    for ev in rx {
        match ev {
            PlaybackEvent::Engine {
                event: EngineEvent::TransitionStarted { from, to, entry_frame_out },
                audition,
            } => {
                let origin = if audition {
                    Origin::Audition
                } else {
                    resolve_nav_origin()
                };
                let at_frames = MAIN_FRAMES.load(Ordering::Relaxed);
                if origin == Origin::Manual {
                    if let Some(playback) = PLAYBACK.get() {
                        log_manual_plan(&playback.render);
                    }
                }
                let (changed, now_path) = {
                    let Some(mut tracker) = lock_now_unless_stale(audition) else {
                        continue;
                    };
                    let before = tracker.now.clone();
                    tracker.on_transition_started(from, to, origin, at_frames, entry_frame_out);
                    (tracker.now != before, tracker.now.clone())
                };
                if changed {
                    service_sync_state();
                }
                if changed && !audition {
                    let origin = playlist_service::current_queue_origin();
                    if let Some(ref p) = now_path {
                        record_heard(p, origin);
                    }
                }
            }
            PlaybackEvent::Engine {
                event: EngineEvent::TrackStarted { index, path, entry_frame_out },
                audition,
            } => {
                let started_origin = if audition { None } else { playlist_service::started(index) };
                let at_frames = MAIN_FRAMES.load(Ordering::Relaxed);
                let (changed, now_path) = {
                    let Some(mut tracker) = lock_now_unless_stale(audition) else {
                        continue;
                    };
                    let before = tracker.now.clone();
                    tracker.on_track_started(path, at_frames, entry_frame_out);
                    (tracker.now != before, tracker.now.clone())
                };
                if changed {
                    service_sync_state();
                }
                if changed && !audition {
                    let origin = started_origin;
                    if let Some(ref p) = now_path {
                        record_heard(p, origin);
                    }
                }
            }
            PlaybackEvent::Engine {
                event: EngineEvent::TrackFailed { index, path, message },
                audition,
            } => {
                if !audition { playlist_service::failed(index, &message); }
                log::warn!("track failed: {} ({message})", path.display());
            }
            PlaybackEvent::Engine {
                event: EngineEvent::Finished,
                audition,
            } => {
                if !audition {
                    playlist_service::finished();
                    if let Some(playback) = PLAYBACK.get() {
                        persist_pause_state(&playback.paused);
                    }
                    service_sync_state();
                }
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
                let heard = completed.is_some() && !audition;
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
                let origin = if heard { playlist_service::current_queue_origin() } else { None };
                if heard {
                    if let Some(ref p) = now_path {
                        record_heard(p, origin);
                    }
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

fn log_playback_diagnostics(sample_rate: u32, snapshot: playback_diagnostics::DiagnosticsSnapshot) {
    if let Some(upgrade) = snapshot.upgrade {
        log::info!(
            "playback diagnostics: sample_rate={sample_rate} render_lock_misses={} render_lock_missed_frames={} preview_wait_frames={} preview_upgrades={} playlist_index={} playhead={} preview_frames={} main_callback_frame={}",
            snapshot.render_lock_misses,
            snapshot.render_lock_missed_frames,
            snapshot.preview_wait_frames,
            upgrade.count,
            upgrade.playlist_index,
            upgrade.playhead,
            upgrade.preview_frames,
            upgrade.main_callback_frame,
        );
    } else {
        log::info!(
            "playback diagnostics: sample_rate={sample_rate} render_lock_misses={} render_lock_missed_frames={} preview_wait_frames={} preview_upgrades=0",
            snapshot.render_lock_misses,
            snapshot.render_lock_missed_frames,
            snapshot.preview_wait_frames,
        );
    }
}

fn open_output_stream(
    sample_rate: u32,
    render: Arc<Mutex<RenderState>>,
    paused: Arc<AtomicBool>,
    event_tx: SyncSender<PlaybackEvent>,
    observation: Arc<engine_observation::EngineObservation>,
    diagnostics: Arc<playback_diagnostics::PlaybackDiagnostics>,
    err_log: Sender<String>,
    capture: Option<navigation_capture::CaptureSink>,
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
    if let Some(capture) = &capture {
        let endpoint_id = device
            .id()
            .map_err(|e| format!("output device id: {e}"))?
            .id()
            .to_owned();
        capture
            .open_output_stream(endpoint_id, sample_rate)
            .map_err(|e| format!("navigation capture output-stream receipt: {e}"))?;
    }
    let mut transport_fade = transport_fade::TransportFade::new(sample_rate);
    let mut core_diagnostics = playback_diagnostics::CoreDiagnosticsPublisher::new(&diagnostics);
    let mut first_live_preparation_captured = false;
    let stream = device
        .build_output_stream(
            config,
            move |out: &mut [f32], info: &cpal::OutputCallbackInfo| {
                let sequence = CALLBACK_TICKS.fetch_add(1, Ordering::Relaxed) + 1;
                let output_frames = (out.len() / 2) as u64;
                let timestamp = capture.as_ref().map(|_| info.timestamp());
                let record_capture = |engine_start, engine_end, paused, audition, render_lock_miss, trace_dropped| {
                    if let (Some(capture), Some(timestamp)) = (&capture, &timestamp) {
                        capture.record(navigation_capture::CallbackRecord {
                            sequence, callback_qpc_100ns: (timestamp.callback.as_nanos() / 100) as u64,
                            playback_qpc_100ns: (timestamp.playback.as_nanos() / 100) as u64,
                            output_frames, engine_start, engine_end,
                            paused, audition, render_lock_miss, trace_dropped,
                        });
                    }
                };
                if navigation_capture::gate_output(capture.as_ref(), out) {
                    record_capture(None, None, true, false, false, 0);
                    return;
                }
                let Ok(mut state) = render.try_lock() else {
                    record_capture(None, None, paused.load(Ordering::Relaxed), false, true, 0);
                    diagnostics.record_render_lock_miss((out.len() / 2) as u64);
                    navigation_capture::silence_device_output(out);
                    return;
                };
                let requested_pause = paused.load(Ordering::Relaxed);
                if requested_pause && transport_fade.is_silent() {
                    let frame = state.engine.render_frame();
                    record_capture(Some(frame), Some(frame), true, state.audition.is_some(), false, state.engine.navigation_trace_dropped() as u64);
                    navigation_capture::silence_device_output(out);
                    state.stall.reset_silence();
                    set_phase(Phase::Paused);
                    return;
                }
                let audition = state.audition.is_some();
                let engine_start = state.engine.render_frame();
                let (events, in_transition, render_diagnostics, rendered_silence) = {
                    let engine = match state.audition.as_mut() {
                        Some(aud) => aud,
                        None => &mut state.engine,
                    };
                    let frames = transport_fade.render(out, requested_pause, |out| engine.render(out));
                    let rendered_silence = navigation_capture::finalize_rendered_output(capture.as_ref(), out);
                    if !audition {
                        MAIN_FRAMES.fetch_add(frames as u64, Ordering::Relaxed);
                        let next_ready = engine.next_track_path().is_some();
                        NEXT_PREPARED.store(next_ready, Ordering::Relaxed);
                        let finished = engine.is_finished();
                        YIELD_FOR_LOADER.store(!next_ready && !finished, Ordering::Relaxed);
                        let expected = MANUAL_NEXT_EXPECTED_INDEX.load(Ordering::Acquire);
                        if manual_next_completed(expected, engine.current_index(), finished) {
                            MANUAL_NEXT_PENDING.store(false, Ordering::Release);
                            MANUAL_NEXT_IN_FLIGHT.store(false, Ordering::Release);
                        }
                        FRAMES_UNTIL_TRANSITION.store(
                            engine.frames_until_transition().unwrap_or(u64::MAX),
                            Ordering::Relaxed,
                        );
                    }
                    let events = engine.poll_events();
                    if !audition {
                        if let Some(capture) = &capture {
                            for event in &events {
                                if let EngineEvent::TrackStarted { index, entry_frame_out, .. } = event {
                                    capture.source_started(*index, *entry_frame_out, engine_start);
                                }
                            }
                        }
                    }
                    let in_transition = engine.transition_frames_into().is_some();
                    let render_diagnostics = (!audition).then(|| engine.render_diagnostics());
                    (events, in_transition, render_diagnostics, rendered_silence)
                };
                if let Some(render_diagnostics) = render_diagnostics {
                    if let Some(snapshot) = core_diagnostics.observe(render_diagnostics, || MAIN_FRAMES.load(Ordering::Relaxed), &diagnostics) {
                        if let Some(capture) = &capture {
                            capture.preview_upgrade(snapshot, sequence);
                        }
                    }
                }
                if !audition && !first_live_preparation_captured {
                    if let Some(capture) = &capture {
                        if let Some(observation) = state.engine.first_live_replay_observation() {
                            capture.first_live_preparation(observation, sequence);
                            first_live_preparation_captured = true;
                        }
                    }
                }
                record_capture(Some(engine_start), Some(state.engine.render_frame()), requested_pause,
                    audition, false, state.engine.navigation_trace_dropped() as u64);
                if !audition {
                    observation.publish(state.engine.current_index(), state.engine.is_finished());
                }
                let silent = rendered_silence;
                let total_frames = (out.len() / 2) as u64;
                let phase = if !audition && state.engine.is_finished() {
                    paused.store(true, Ordering::Relaxed);
                    transport_fade.silence();
                    Phase::Paused
                } else if requested_pause {
                    state.stall.reset_silence();
                    Phase::Paused
                } else { state.stall.observe(total_frames, silent) };
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
    folder_pos: usize,
    labeling_mode: bool,
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
    say!("device: {device}");

    let supported = match device.default_output_config() {
        Ok(c) => c,
        Err(e) => {
            say!("FAIL: default_output_config: {e}");
            set_phase(Phase::Failed);
            return;
        }
    };
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

    let sample_rate = supported.sample_rate();

    let mut options = EngineOptions::default();
    options.output_sample_rate = sample_rate;
    let cache_dir_for_log = cache_dir.clone();
    let playlist_cache = cache_dir_for_log.clone();
    options.cache_dir = cache_dir;
    options.head_only_secs = labeling_mode.then_some(LABELING_HEAD_SECS);

    let queue_dir = data_dir.clone();
    let queue_for_save = Arc::clone(&queue);
    let queue_for_priority = Arc::clone(&queue);
    let queue_for_reserved = Arc::clone(&queue);
    let reserved_dir = data_dir.clone();
    let folder_gate_cache = cache_dir_for_log.clone();
    let folder_gate_data = data_dir.clone();
    let capture_inputs: Vec<PathBuf> = if std::env::var_os("FUNKOT_NAVIGATION_CAPTURE_DIR").is_some() {
        paths.iter().cloned().chain(queue::snapshot(&queue).into_iter().map(|item| item.path))
            .collect::<std::collections::BTreeSet<_>>().into_iter().collect()
    } else { Vec::new() };
    let source = HostSource::new(
        queue,
        DrainPolicy::ContinueFolder {
            tracks: paths,
            pos: folder_pos,
        },
    )
        .skip_folder_entry(Box::new(move |path| {
            admit_playback_path(
                path,
                &folder_gate_cache,
                &folder_gate_data,
                ALLOW_NON_FUNKOT.load(Ordering::Relaxed),
            ) == PlaybackAdmission::Rejected
        }))
        .on_pending_consumed(Box::new(move |_pending| {
            let _saving = SAVE_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let pending: VecDeque<QueueItem> = queue::snapshot(&queue_for_save).into_iter().collect();
            if let Err(e) = store::save_queue(&queue_dir, &pending) {
                log::warn!("save_queue({}): {e}", queue_dir.display());
            }
        }))
        .on_reserved(Box::new(move |item| {
            let analysis = funkot_core::cache::content_hash(&item.path)
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
                item.path.display()
            );
            let _saving = SAVE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut session = SESSION.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if queue::reserved_item(&queue_for_reserved)
                .is_some_and(|reserved| reserved.entry_id == item.entry_id)
            {
                session.in_flight.push(item.clone());
                if let Err(e) = store::save_session(&reserved_dir, &session) {
                    log::warn!("save_session({}): {e}", reserved_dir.display());
                }
            }
        }))
        .on_folder_pos(Box::new(|pos| {
            FOLDER_POS.store(pos, Ordering::Relaxed);
        }));
    let source_owner = playlist_service::get(&data_dir, &playlist_cache, &queue_for_priority);
    let source = playlist_service::configure(&source_owner, source);
    let capture_options = options.clone();
    let mut engine = match Engine::new_with_source(options, Box::new(source)) {
        Ok(e) => e,
        Err(e) => {
            say!("FAIL: Engine::new_with_source: {e}");
            set_phase(Phase::Failed);
            return;
        }
    };
    engine.set_realtime(true);
    let capture = match navigation_capture::start(&mut engine, &capture_options, &capture_inputs) {
        Ok(capture) => capture,
        Err(error) => {
            say!("FAIL: navigation capture preflight: {error}");
            set_phase(Phase::Failed);
            return;
        }
    };
    say!("engine created");

    let paused = Arc::new(AtomicBool::new(initial_paused));
    let nav_tx = engine.nav_sender();
    let observation = Arc::new(engine_observation::EngineObservation::new(engine.current_index(), engine.is_finished()));
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
        observation: Arc::clone(&observation),
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
    let diagnostics = Arc::new(playback_diagnostics::PlaybackDiagnostics::new());
    let mut diagnostics_seen = playback_diagnostics::DiagnosticsSnapshot {
        render_lock_misses: 0,
        render_lock_missed_frames: 0,
        preview_wait_frames: 0,
        upgrade: None,
    };
    log_playback_diagnostics(sample_rate, diagnostics_seen);
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
        Arc::clone(&observation),
        Arc::clone(&diagnostics),
        log.clone(),
        capture.clone(),
    ) {
        Ok(s) => Some(s),
        Err(e) => {
            say!("FAIL: {e}");
            set_phase(Phase::Failed);
            return;
        }
    };
    say!("PLAYING");

    let mut stalled_since: Option<Instant> = None;
    let mut events_dropped_seen = 0u64;
    let mut cb_watch = CallbackWatch::new(CALLBACK_TICKS.load(Ordering::Relaxed));
    let mut reported_lost = false;
    let mut retry_after: Option<Instant> = None;
    loop {
        std::thread::sleep(Duration::from_secs(1));

        let request = MANUAL_PRIORITY_REQUEST.load(Ordering::Acquire);
        if request != 0 && try_prioritize_manual(&queue_for_priority, request) {
            let _saving = SAVE_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let pending: VecDeque<QueueItem> =
                queue::snapshot(&queue_for_priority).into_iter().collect();
            if let Err(e) = store::save_queue(&data_dir, &pending) {
                log::warn!("save_queue({}): {e}", data_dir.display());
            }
            drop(_saving);
            persist_session();
        }

        if let Some(snapshot) = diagnostics.read() {
            if snapshot != diagnostics_seen {
                log_playback_diagnostics(sample_rate, snapshot);
                diagnostics_seen = snapshot;
            }
        }

        if stream.is_none() {
            set_phase(Phase::Disconnected);
            let ready = retry_after
                .map(|t| Instant::now() >= t)
                .unwrap_or(true);
            if ready {
                if let Ok(mut state) = render.lock() {
                    state.stall.reset_silence();
                }
                match open_output_stream(
                    sample_rate,
                    Arc::clone(&render),
                    Arc::clone(&paused),
                    event_tx.clone(),
                    Arc::clone(&observation),
                    Arc::clone(&diagnostics),
                    log.clone(),
                    capture.clone(),
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

        let lost = cb_watch.observe(
            CALLBACK_TICKS.load(Ordering::Relaxed),
            STREAM_ERROR_SEEN.load(Ordering::Relaxed),
        );
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
        let dropped = EVENTS_DROPPED.load(Ordering::Relaxed);
        if dropped > events_dropped_seen {
            log::warn!(
                "dropped {} playback event(s): the events channel (capacity 64) is full",
                dropped - events_dropped_seen
            );
            events_dropped_seen = dropped;
        }
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
            stalled_since = None;
            retry_after = Some(Instant::now() + REOPEN_COOLDOWN);
        } else {
            reported_lost = false;
        }
    }
}

fn is_supported_track(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|e| matches!(e.to_ascii_lowercase().as_str(),
            "wav" | "mp3" | "flac" | "m4a" | "ogg"))
        .unwrap_or(false)
}

#[cfg_attr(not(any(test, target_os = "android")), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
enum ImportDecision {
    Skip,
    CopyTo(PathBuf),
}

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

/// The temp file lives in `dest`'s own parent, not the staging dir:
/// `fs::rename` is only atomic within one filesystem, and `music_dir`
/// (external storage) and the staging dir (`getCacheDir()`, internal
/// storage) are different mounts on Android.
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

    #[test]
    fn classify_import_keeps_the_destination_inside_music_dir() {
        let music_dir = Path::new("/music");
        let decision = classify_import(Path::new("../../etc/song.mp3"), music_dir, |_| false);
        assert_eq!(
            decision,
            ImportDecision::CopyTo(PathBuf::from("/music/song.mp3"))
        );
    }

    #[test]
    fn classify_import_strips_a_leading_dot() {
        let music_dir = Path::new("/music");
        let decision = classify_import(Path::new("/cache/.hidden.mp3"), music_dir, |_| false);
        assert_eq!(
            decision,
            ImportDecision::CopyTo(PathBuf::from("/music/hidden.mp3"))
        );
    }

    #[test]
    fn classify_import_accepts_an_uppercase_extension() {
        let music_dir = Path::new("/music");
        let decision = classify_import(Path::new("/cache/SONG.MP3"), music_dir, |_| false);
        assert_eq!(
            decision,
            ImportDecision::CopyTo(PathBuf::from("/music/SONG.MP3"))
        );
    }

    #[test]
    fn classify_import_skips_a_bare_dotfile_extension() {
        let music_dir = Path::new("/music");
        let decision = classify_import(Path::new("/cache/.mp3"), music_dir, |_| false);
        assert_eq!(decision, ImportDecision::Skip);
    }

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

/// Symlinks are never followed: `DirEntry::file_type()` reports the link
/// itself rather than its target, so symlink cycles cannot occur.
fn scan_tracks(dir: &Path) -> Result<(Vec<PathBuf>, bool), String> {
    let mut paths = Vec::new();
    let mut complete = true;
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    scan_tracks_into(entries, &mut paths, &mut complete);
    paths.sort();
    Ok((paths, complete))
}

fn scan_tracks_into(
    entries: std::fs::ReadDir,
    paths: &mut Vec<PathBuf>,
    complete: &mut bool,
) {
    for entry_result in entries {
        let entry = match entry_result {
            Ok(e) => e,
            Err(_) => {
                *complete = false;
                continue;
            }
        };
        let is_dotted = entry
            .file_name()
            .to_str()
            .map(|s| s.starts_with('.'))
            .unwrap_or(false);
        if is_dotted {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => {
                *complete = false;
                continue;
            }
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            match std::fs::read_dir(&path) {
                Ok(sub_entries) => scan_tracks_into(sub_entries, paths, complete),
                Err(e) => {
                    log::warn!("cannot read {}: {e}", path.display());
                    *complete = false;
                }
            }
        } else if file_type.is_file() && is_supported_track(&path) {
            paths.push(path);
        }
    }
}

const ALREADY_STARTED: &str = "already started";

fn ensure_tracks_available(paths: &[PathBuf], dir: &Path) -> Result<(), String> {
    if paths.is_empty() {
        return Err(format!("need >= 1 track in {}, found 0", dir.display()));
    }
    Ok(())
}

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

    if resolve_dirs(app)?.music_dir_needed {
        return Err("music_dir_needed".into());
    }

    let dir = PathBuf::from(music_dir);
    let (paths, _complete): (Vec<PathBuf>, bool) = scan_tracks(&dir)?;

    if !playlist_service::existing().is_some_and(|s| s.lock().unwrap_or_else(|e|e.into_inner()).has_playlist()) {
        ensure_tracks_available(&paths, &dir)?;
    }

    let (tx, rx) = mpsc::channel();
    *state.log_rx.lock().unwrap() = Some(rx);
    let found = format!("{} tracks", paths.len());
    let cache = PathBuf::from(cache_dir);
    let data = PathBuf::from(resolve_dirs(app)?.data_dir);
    let _ = DATA_DIR.set(data.clone());
    let _prestart = playlist_service::lock_prestart_queue();
    let source_owner = playlist_service::get(&data, &cache, &state.queue);
    let restored = source_owner.lock().unwrap_or_else(|e| e.into_inner())
        .restore_saved_queue().map_err(|error| error.message)?;
    drop(_prestart);
    ALLOW_NON_FUNKOT.store(restored.settings.allow_non_funkot, Ordering::Relaxed);
    let labeling_mode = effective_labeling_mode(restored.settings.labeling_mode);
    let session = restored.session;
    let folder_pos = restored.folder_pos.unwrap_or_else(||
        store::restored_folder_pos(
            &paths,
            session
                .in_flight
                .iter()
                .rev()
                .find(|item| item.origin == QueueOrigin::Automatic)
                .map(|item| item.path.as_path()),
        ));
    let queue = Arc::clone(&state.queue);

    set_phase(Phase::Starting);
    YIELD_FOR_LOADER.store(true, Ordering::Relaxed);

    FOLDER_LEN.store(paths.len(), Ordering::Relaxed);
    FOLDER_POS.store(folder_pos, Ordering::Relaxed);
    if let Err(e) = std::thread::Builder::new()
        .name("funkot-audio".into())
        .spawn(move || {
            audio_thread(paths, cache, data, tx, queue, initial_paused, folder_pos, labeling_mode)
        })
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
    if first_install {
        let mut now = NOW.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut session = AUDITION_SESSION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        session.parked_now = now.now.clone();
        session.parked_previous = now.previous.clone();
        session.parked_in_progress = now.in_progress.clone();
        session.parked_now_started_frames = now.now_started_frames;
        session.parked_now_entry_frame_out = now.now_entry_frame_out;
        now.in_progress = None;
    }
    AUDITIONING.store(true, Ordering::Relaxed);
    let in_transition = engine.transition_frames_into().is_some();
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
    let _audition = try_audition_lock()?;

    let cold_start = PLAYBACK.get().is_none();
    if cold_start {
        match start_impl(&music_dir, &cache_dir, &app, &state, true) {
            Ok(_) => {}
            Err(e) if e == ALREADY_STARTED => {}
            Err(e) => return Err(e),
        }
        wait_for_playback()?;
    }
    let playback = PLAYBACK.get().ok_or("not playing")?;
    {
        let mut session = AUDITION_SESSION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        session.pair = Some((from.clone(), to.clone()));
    }
    let sample_rate = playback.sample_rate;
    prepare_audition(
        &playback.paused,
        || build_audition_engine(&from, &to, Path::new(&cache_dir), sample_rate),
        install_audition,
    )
}

fn prepare_audition<E>(
    paused: &AtomicBool,
    build: impl FnOnce() -> Result<E, String>,
    install: impl FnOnce(E) -> Result<(), String>,
) -> Result<(), String> {
    AUDITION_PREPARING.store(true, Ordering::Relaxed);
    let before = paused.swap(true, Ordering::Relaxed);
    let result = build().and_then(install);
    if result.is_err() {
        paused.store(before, Ordering::Relaxed);
    }
    AUDITION_PREPARING.store(false, Ordering::Relaxed);
    result
}

#[tauri::command]
fn resume_autodj() -> Result<(), String> {
    let _audition = try_audition_lock()?;
    let playback = PLAYBACK.get().ok_or("not playing")?;
    playback.paused.store(true, Ordering::Relaxed);
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
        now.now_entry_frame_out = session.parked_now_entry_frame_out;
    }
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
    playback.paused.store(false, Ordering::Relaxed);
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

#[tauri::command]
fn toggle_pause() -> Result<bool, String> {
    let _audition = try_audition_lock()?;
    ensure_pause_allowed(
        AUDITIONING.load(Ordering::Relaxed),
        AUDITION_PREPARING.load(Ordering::Relaxed),
    )?;
    let playback = PLAYBACK.get().ok_or("not playing")?;
    let now_paused = flip_paused(&playback.paused);
    service_sync_state();
    Ok(now_paused)
}

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

#[derive(serde::Serialize, Clone)]
struct TransitionInfo {
    from: String,
    to: String,
    automatic: bool,
    seconds_ago: f64,
}

#[derive(serde::Serialize, Clone)]
struct PlayerState {
    phase: &'static str,
    paused: bool,
    now_playing: Option<String>,
    previous: Option<String>,
    last_transition: Option<TransitionInfo>,
    auditioning: bool,
    audition_from: Option<String>,
    audition_to: Option<String>,
    position_secs: Option<f64>,
    duration_secs: Option<f64>,
    history_revision: u64,
    playback_started_frames: Option<u64>,
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
            classify_scores: None,
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

static PLAYED_DURATION: Mutex<Option<(PathBuf, Option<f64>)>> = Mutex::new(None);

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

fn track_position_secs(rendered: u64, started: u64, entry: u64, sample_rate: u32) -> Option<f64> {
    if sample_rate == 0 { return None; }
    Some((entry as f64 + rendered.saturating_sub(started) as f64) / sample_rate as f64)
}

#[tauri::command]
fn player_state(app: tauri::AppHandle) -> PlayerState {
    let (now_playing, previous, last_transition, now_started_frames, now_entry_frame_out) = {
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
            now.now_entry_frame_out,
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
    let (position_secs, duration_secs) = if auditioning {
        (None, None)
    } else {
        match (now_playing.as_ref(), now_started_frames) {
            (Some(path), Some(started)) => {
                let position = PLAYBACK.get().and_then(|p| {
                    track_position_secs(
                        MAIN_FRAMES.load(Ordering::Relaxed), started,
                        now_entry_frame_out, p.sample_rate,
                    )
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
        history_revision: HISTORY_REVISION.load(Ordering::Relaxed),
        playback_started_frames: now_started_frames,
    }
}

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

    let paths: Vec<PathBuf> = if dirs.music_dir_needed {
        Vec::new()
    } else {
        scan_tracks(&music_dir)?.0
    };
    let overrides = store::load_overrides(&data_dir);
    let labels = store::load_labels(&data_dir);
    let history = store::load_history(&data_dir);

    let mut meta_by_hash = std::collections::BTreeMap::new();
    for path in &paths {
        let Ok(hash) = funkot_core::cache::content_hash(path) else {
            continue;
        };
        let row = track_row(
            path,
            &cache_dir,
            &overrides,
            &labels,
            &history,
            Some(&hash),
            None,
        );
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
        return Ok(0);
    }
    store::save_dismissed(&data_dir, &dismissed)
        .map_err(|e| format!("cannot persist dismissed: {e}"))?;
    *LAST_DISMISS_UNDO
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(key);
    Ok(1)
}

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
    *LAST_FLAG_UNDO
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    Ok(())
}

const SWAP_DEADLINE_SECS: f64 = 30.0;

fn manual_priority_swap_safe(
    auditioning: bool,
    prepared: bool,
    frames_until_transition: u64,
    sample_rate: u32,
) -> bool {
    !auditioning
        && prepared
        && sample_rate != 0
        && frames_until_transition != u64::MAX
        && frames_until_transition as f64 / sample_rate as f64 > SWAP_DEADLINE_SECS
}

#[cfg(test)]
mod manual_priority_tests {
    use super::*;

    #[test]
    fn prepared_automatic_is_swappable_with_safe_runway() {
        assert!(manual_priority_swap_safe(false, true, 31_000, 1_000));
    }

    #[test]
    fn preparing_automatic_waits_for_a_later_retry() {
        assert!(!manual_priority_swap_safe(false, false, 31_000, 1_000));
    }

    #[test]
    fn automatic_at_the_deadline_is_kept_for_one_track() {
        assert!(!manual_priority_swap_safe(false, true, 30_000, 1_000));
    }

    #[test]
    fn stale_watchdog_cannot_clear_a_newer_manual_request() {
        let request = AtomicU64::new(1);
        request.store(2, Ordering::Release);
        clear_request_if_current(&request, 1);
        assert_eq!(request.load(Ordering::Acquire), 2);
        clear_request_if_current(&request, 2);
        assert_eq!(request.load(Ordering::Acquire), 0);
    }
}

#[derive(serde::Serialize, Clone)]
struct QueueSnapshot {
    source: playlist_service::SourceTarget,
    playlist: Option<playlist_service::Details>,
    catalog_revision: u64,
    playlist_store_status: String,
    reserved: Option<QueueItem>,
    pending: Vec<QueueItem>,
    in_flight: Vec<QueueItem>,
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
    transition_in_secs: Option<f64>,
    folder_pos: usize,
    folder_len: usize,
}

#[tauri::command(async)]
fn get_allow_non_funkot(app: tauri::AppHandle) -> Result<bool, String> {
    let dirs = resolve_dirs(&app)?;
    let _saving = SAVE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let allow = store::load_settings(Path::new(&dirs.data_dir)).allow_non_funkot;
    ALLOW_NON_FUNKOT.store(allow, Ordering::Relaxed);
    Ok(allow)
}

#[tauri::command(async)]
fn set_allow_non_funkot(
    app: tauri::AppHandle,
    allow: bool,
    state: tauri::State<AppState>,
) -> Result<bool, String> {
    let _prestart = playlist_service::lock_prestart_queue();
    let dirs = resolve_dirs(&app)?;
    let data = Path::new(&dirs.data_dir);
    let service = playlist_service::existing().unwrap_or_else(|| {
        playlist_service::get(data, Path::new(&dirs.cache_dir), &state.queue)
    });
    playlist_service::reconfigure_admission(&service, allow, PLAYBACK.get(), |settings| {
        settings.allow_non_funkot = allow;
        Ok(())
    }).map_err(|error| error.message)?;
    Ok(allow)
}

#[tauri::command(async)]
fn get_labeling_mode(app: tauri::AppHandle) -> Result<bool, String> {
    let dirs = resolve_dirs(&app)?;
    Ok(store::load_settings(Path::new(&dirs.data_dir)).labeling_mode)
}

#[tauri::command(async)]
fn set_labeling_mode(app: tauri::AppHandle, on: bool) -> Result<bool, String> {
    let dirs = resolve_dirs(&app)?;
    let data = Path::new(&dirs.data_dir);
    with_settings_rmw(data, |settings| {
        settings.labeling_mode = on;
    })?;
    Ok(on)
}

#[tauri::command(async)]
fn get_locale(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let dirs = resolve_dirs(&app)?;
    let locale = store::load_settings(Path::new(&dirs.data_dir)).locale;
    *LOCALE_TAG.lock().unwrap() = locale.clone().unwrap_or_default();
    Ok(locale)
}

#[tauri::command(async)]
fn set_locale(app: tauri::AppHandle, locale: String) -> Result<String, String> {
    let dirs = resolve_dirs(&app)?;
    let data = Path::new(&dirs.data_dir);
    let saved = with_settings_rmw_then(
        data,
        |settings| {
            settings.locale = Some(locale.clone());
        },
        |_| {
            *LOCALE_TAG.lock().unwrap() = locale.clone();
            locale.clone()
        },
    )?;
    service_sync_state();
    Ok(saved)
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn notification_locale_tag() -> String {
    LOCALE_TAG.lock().unwrap().clone()
}

fn with_settings_rmw(
    data: &Path,
    mutate: impl FnOnce(&mut store::Settings),
) -> Result<(), String> {
    with_settings_rmw_then(data, mutate, |_| ())
}

fn with_settings_rmw_then<R>(
    data: &Path,
    mutate: impl FnOnce(&mut store::Settings),
    after_save: impl FnOnce(&store::Settings) -> R,
) -> Result<R, String> {
    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut settings = store::load_settings(data);
    mutate(&mut settings);
    store::save_settings(data, &settings)
        .map_err(|e| format!("cannot save settings: {e}"))?;
    Ok(after_save(&settings))
}

fn revoke_reserved_for_manual_priority() -> Option<PathBuf> {
    let playback = PLAYBACK.get()?;
    let mut state = playback
        .render
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let auditioning = state.audition.is_some()
        || AUDITIONING.load(Ordering::Relaxed)
        || AUDITION_PREPARING.load(Ordering::Relaxed);
    let prepared = state.engine.next_track_path().is_some();
    let frames = state.engine.frames_until_transition().unwrap_or(u64::MAX);
    if !manual_priority_swap_safe(auditioning, prepared, frames, playback.sample_rate) {
        return None;
    }
    let path = state.engine.revoke_next();
    if path.is_some() {
        NEXT_PREPARED.store(false, Ordering::Relaxed);
    }
    path
}

fn clear_request_if_current(cell: &AtomicU64, request: u64) {
    let _ = cell.compare_exchange(
        request,
        0,
        Ordering::AcqRel,
        Ordering::Acquire,
    );
}

fn clear_manual_priority_request(request: u64) {
    clear_request_if_current(&MANUAL_PRIORITY_REQUEST, request);
}

fn try_prioritize_manual(queue: &SharedQueue, request: u64) -> bool {
    if !queue::manual_priority_needed(queue) {
        clear_manual_priority_request(request);
        return false;
    }
    let auditioning =
        AUDITIONING.load(Ordering::Relaxed) || AUDITION_PREPARING.load(Ordering::Relaxed);
    let prepared = NEXT_PREPARED.load(Ordering::Relaxed);
    if auditioning || !prepared {
        return false;
    }
    let frames = FRAMES_UNTIL_TRANSITION.load(Ordering::Relaxed);
    let safe = PLAYBACK.get().is_some_and(|playback| {
        manual_priority_swap_safe(auditioning, prepared, frames, playback.sample_rate)
    });
    if !safe {
        clear_manual_priority_request(request);
        return false;
    }

    let Some(revoked) = queue::prioritize_manual(queue, revoke_reserved_for_manual_priority) else {
        return false;
    };
    {
        let mut session = SESSION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        store::retire_revoked(&mut session.in_flight, &revoked);
    }
    clear_manual_priority_request(request);
    true
}

#[tauri::command(async)]
fn queue_state(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<QueueSnapshot, String> {
    let _prestart = playlist_service::lock_prestart_queue();
    let service = match playlist_service::existing() {
        Some(service) => service,
        None => { let dirs = resolve_dirs(&app)?;
            playlist_service::get(Path::new(&dirs.data_dir), Path::new(&dirs.cache_dir), &state.queue) }
    };
    let mut owner = service.lock().unwrap_or_else(|e|e.into_inner());
    owner.reconcile();
    let source = owner.target();
    let catalog_revision = source.revision;
    let playlist_store_status = owner.store_status();
    let playlist = owner.active().map(|id|owner.details(id, false)).transpose().map_err(|e| e.code)?;
    let (reserved, pending, in_flight) = if playlist.is_some() { (None, vec![], vec![]) } else { owner.normal_view() };
    drop(owner);
    let auditioning =
        AUDITIONING.load(Ordering::Relaxed) || AUDITION_PREPARING.load(Ordering::Relaxed);
    let frames = FRAMES_UNTIL_TRANSITION.load(Ordering::Relaxed);
    let transition_in_secs = if auditioning || frames == u64::MAX {
        None
    } else {
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
    let paused = PLAYBACK
        .get()
        .is_some_and(|p| p.paused.load(Ordering::Relaxed));
    let reserved_prepared = reserved.is_some()
        && (auditioning || paused || NEXT_PREPARED.load(Ordering::Relaxed));
    Ok(QueueSnapshot {
        source,
        playlist,
        catalog_revision,
        playlist_store_status,
        reserved,
        pending,
        in_flight,
        reserved_swappable,
        reserved_prepared,
        transition_in_secs,
        folder_pos: FOLDER_POS.load(Ordering::Relaxed),
        folder_len: FOLDER_LEN.load(Ordering::Relaxed),
    })
}

#[derive(serde::Serialize, Clone)]
struct TrackRow {
    content_hash: Option<String>,
    path: String,
    title: String,
    artist: String,
    duration_secs: Option<u32>,
    analyzed: bool,
    is_funkot: bool,
    label: Option<bool>,
    intro_bars: Option<u32>,
    outro_structure_bars: Option<u32>,
    outro_bars: Option<u32>,
    intro_manual: bool,
    outro_manual: bool,
    intro_low_confidence: bool,
    outro_low_confidence: bool,
    played_at_ms: Option<u64>,
    added_order: Option<u64>,
}

#[derive(serde::Serialize, Clone)]
struct LabelStats {
    labeled: usize,
    total: usize,
    funkot: usize,
    not_funkot: usize,
}

static ANALYZING: AtomicBool = AtomicBool::new(false);
static LIBRARY_ANALYSIS_BUSY: AtomicBool = AtomicBool::new(false);
static MANUAL_NEXT_PENDING: AtomicBool = AtomicBool::new(false);
static MANUAL_NEXT_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
static MANUAL_NEXT_EXPECTED_INDEX: AtomicUsize = AtomicUsize::new(0);
static MANUAL_NEXT_REQUEST_LOCK: Mutex<()> = Mutex::new(());

fn analyzed_cache_entry(
    cache_dir: &std::path::Path,
    hash: &str,
) -> Option<funkot_core::TrackAnalysis> {
    funkot_core::cache::load(cache_dir, hash).filter(|a| !a.needs_reanalysis)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PlaybackAdmission {
    Accepted,
    Rejected,
    Unavailable,
}

pub(crate) fn admit_playback_path(
    path: &std::path::Path,
    cache_dir: &std::path::Path,
    data_dir: &std::path::Path,
    allow_non_funkot: bool,
) -> PlaybackAdmission {
    if allow_non_funkot {
        return PlaybackAdmission::Accepted;
    }
    let Ok(hash) = funkot_core::cache::content_hash(path) else {
        return PlaybackAdmission::Unavailable;
    };
    if analyzed_cache_entry(cache_dir, &hash).is_none() {
        let Ok(buffer) = funkot_core::decode::decode_file(path) else {
            return PlaybackAdmission::Unavailable;
        };
        if funkot_core::cache::fill_missing(path, cache_dir, &buffer).is_err() {
            return PlaybackAdmission::Unavailable;
        }
        reapply_overrides(path, cache_dir, data_dir);
    }
    let Some(analysis) = analyzed_cache_entry(cache_dir, &hash) else {
        return PlaybackAdmission::Unavailable;
    };
    let override_funkot = store::load_overrides(data_dir)
        .get(&hash)
        .and_then(|override_| override_.funkot);
    if store::effective_is_funkot(analysis.is_funkot, override_funkot) {
        PlaybackAdmission::Accepted
    } else {
        PlaybackAdmission::Rejected
    }
}
fn gated_non_funkot(
    path: &std::path::Path,
    cache_dir: &std::path::Path,
    data_dir: &std::path::Path,
) -> bool {
    let Ok(hash) = store_cache::content_hash(data_dir, path) else { return false; };
    let Some(analysis) = analyzed_cache_entry(cache_dir, &hash) else { return false; };
    let override_funkot = store::load_overrides(data_dir).get(&hash).and_then(|entry| entry.funkot);
    !store::effective_is_funkot(analysis.is_funkot, override_funkot)
}

#[cfg(test)]
fn apply_non_funkot_gate(
    paths: Vec<PathBuf>,
    cache_dir: &std::path::Path,
    data_dir: &std::path::Path,
    allow: bool,
) -> Vec<PathBuf> {
    if allow {
        return paths;
    }
    paths
        .into_iter()
        .filter(|p| !gated_non_funkot(p, cache_dir, data_dir))
        .collect()
}

fn gated_non_funkot_from_index(
    path: &std::path::Path,
    cache_dir: &std::path::Path,
    index: &store::HashIndex,
    overrides: &store::Overrides,
) -> bool {
    let Some(entry) = index.get(path.to_string_lossy().as_ref()) else {
        return false;
    };
    let Some(a) = analyzed_cache_entry(cache_dir, &entry.hash) else {
        return false;
    };
    let override_funkot = overrides.get(&entry.hash).and_then(|o| o.funkot);
    !store::effective_is_funkot(a.is_funkot, override_funkot)
}

#[cfg(test)]
fn apply_non_funkot_gate_from_index(
    paths: Vec<PathBuf>,
    cache_dir: &std::path::Path,
    data_dir: &std::path::Path,
    allow: bool,
) -> Vec<PathBuf> {
    if allow {
        return paths;
    }
    let index = store::load_hash_index(data_dir).index;
    let overrides = store::load_overrides(data_dir);
    paths
        .into_iter()
        .filter(|p| !gated_non_funkot_from_index(p, cache_dir, &index, &overrides))
        .collect()
}

fn preload_queue_tab(app: &tauri::AppHandle, data: PathBuf, cache_dir: &Path) {
    use tauri::Manager;
    let _ = DATA_DIR.set(data.clone());
    let state = app.state::<AppState>();
    let _prestart = playlist_service::lock_prestart_queue();
    let service = playlist_service::get(&data, cache_dir, &state.queue);
    let restored = match service.lock().unwrap_or_else(|e| e.into_inner()).restore_saved_queue() {
        Ok(restored) => restored,
        Err(error) => {
            log::warn!("setup: cannot safely recover saved playback state: {}", error.message);
            return;
        }
    };
    drop(_prestart);
    ALLOW_NON_FUNKOT.store(restored.settings.allow_non_funkot, Ordering::Relaxed);
    *LOCALE_TAG.lock().unwrap() = restored.settings.locale.unwrap_or_default();

}

fn track_row(
    path: &std::path::Path,
    cache_dir: &std::path::Path,
    overrides: &store::Overrides,
    labels: &store::Labels,
    history: &store::History,
    hash: Option<&str>,
    tags: Option<CachedTags>,
) -> TrackRow {
    let tags = match tags {
        Some(t) => t,
        None => cached_tags_for(path),
    };
    let (title, artist) = session_metadata_for(Some(path), &tags);
    let label = hash.and_then(|h| labels.get(h).map(|l| l.verdict));
    let played_at_ms = hash.and_then(|h| history.get(h).map(|r| r.last_played_ms));
    match hash.and_then(|h| analyzed_cache_entry(cache_dir, h).map(|a| (h, a))) {
        Some((hash, a)) => {
            let override_funkot = overrides.get(hash).and_then(|o| o.funkot);
            TrackRow {
                content_hash: Some(hash.to_owned()),
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
                label,
                intro_bars: Some(a.intro_bars),
                outro_structure_bars: Some(a.outro_structure_bars),
                outro_bars: Some(a.outro_bars),
                intro_manual: a.intro_bars_manual,
                outro_manual: a.outro_structure_bars_manual || a.outro_bars_manual,
                intro_low_confidence: a.intro_bars_low_confidence,
                outro_low_confidence: a.outro_bars_low_confidence,
                played_at_ms,
                added_order: None,
            }
        }
        None => TrackRow {
            content_hash: hash.map(str::to_owned),
            path: path.to_string_lossy().into_owned(),
            title,
            artist,
            duration_secs: None,
            analyzed: false,
            is_funkot: true,
            label,
            intro_bars: None,
            outro_structure_bars: None,
            outro_bars: None,
            intro_manual: false,
            outro_manual: false,
            intro_low_confidence: false,
            outro_low_confidence: false,
            played_at_ms,
            added_order: None,
        },
    }
}

#[cfg(test)]
mod cache_state_tests {
    use super::*;
    use funkot_core::engine::TrackSource;

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

    fn track_with_analysis(dir: &Path) -> (PathBuf, funkot_core::TrackAnalysis) {
        let track = dir.join("track.wav");
        std::fs::write(&track, vec![0u8; 4096]).unwrap();
        let buffer = funkot_core::decode::AudioBuffer {
            sample_rate: 48_000,
            frames: 48_000 * 200,
            samples: Vec::new(),
        };
        let mut analysis = funkot_core::cache::provisional(&buffer, "track.wav");
        analysis.needs_reanalysis = false;
        (track, analysis)
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
        assert!(!track_row(
            &track,
            &dir.0,
            &store::Overrides::new(),
            &store::Labels::new(),
            &store::History::new(),
            Some(&hash),
            None
        )
        .analyzed);
    }

    #[test]
    fn a_complete_entry_reads_as_analyzed() {
        let dir = TempDir::new("complete");
        let (track, analysis) = track_with_analysis(&dir.0);
        store_for(&track, &dir.0, &analysis);
        let hash = funkot_core::cache::content_hash(&track).unwrap();

        assert!(analyzed_cache_entry(&dir.0, &hash).is_some());
        let row = track_row(
            &track,
            &dir.0,
            &store::Overrides::new(),
            &store::Labels::new(),
            &store::History::new(),
            Some(&hash),
            None,
        );
        assert!(row.analyzed);
        assert_eq!(row.intro_bars, Some(analysis.intro_bars));
        assert_eq!(row.title, file_name_str(&track));
        assert_eq!(row.artist, "");
        assert_eq!(row.duration_secs, Some(200));
        assert_eq!(row.is_funkot, analysis.is_funkot);
    }

    #[test]
    fn an_entry_needing_reanalysis_reads_as_unanalyzed() {
        let dir = TempDir::new("stale");
        let (track, mut analysis) = track_with_analysis(&dir.0);
        analysis.needs_reanalysis = true;
        store_for(&track, &dir.0, &analysis);
        let hash = funkot_core::cache::content_hash(&track).unwrap();

        assert!(analyzed_cache_entry(&dir.0, &hash).is_none());
        let row = track_row(
            &track,
            &dir.0,
            &store::Overrides::new(),
            &store::Labels::new(),
            &store::History::new(),
            Some(&hash),
            None,
        );
        assert!(!row.analyzed);
        assert_eq!(row.intro_bars, None);
        assert_eq!(row.outro_structure_bars, None);
        assert!(row.is_funkot);
    }

    #[test]
    fn a_missing_hash_reads_as_unanalyzed_rather_than_erroring() {
        let dir = TempDir::new("missing-hash");
        let track = dir.0.join("nope.wav");
        assert!(analyzed_cache_entry(&dir.0, "deadbeef").is_none());
        assert!(!track_row(
            &track,
            &dir.0,
            &store::Overrides::new(),
            &store::Labels::new(),
            &store::History::new(),
            None,
            None
        )
        .analyzed);
    }

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
        let row = track_row(
            &track,
            &cache.0,
            &overrides,
            &store::Labels::new(),
            &store::History::new(),
            Some(&hash),
            None,
        );
        assert!(row.analyzed);
        assert!(row.is_funkot);
    }

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
            &store::Labels::new(),
            &store::History::new(),
            None,
            Some(tags),
        );
        assert_eq!(row.title, "From Index");
        assert_eq!(row.artist, "Cached Artist");
        assert!(!row.analyzed);
    }

    #[test]
    fn track_row_maps_history_last_played_ms_to_played_at_ms() {
        let dir = TempDir::new("row-history");
        let (track, _) = track_with_analysis(&dir.0);
        let hash = funkot_core::cache::content_hash(&track).unwrap();

        let row_absent = track_row(
            &track,
            &dir.0,
            &store::Overrides::new(),
            &store::Labels::new(),
            &store::History::new(),
            Some(&hash),
            None,
        );
        assert_eq!(row_absent.played_at_ms, None);

        let mut history = store::History::new();
        history.insert(
            hash.clone(),
            store::PlayRecord {
                count: 2,
                last_played_ms: 1_700_000_000_123,
            },
        );
        let row_present = track_row(
            &track,
            &dir.0,
            &store::Overrides::new(),
            &store::Labels::new(),
            &history,
            Some(&hash),
            None,
        );
        assert_eq!(row_present.played_at_ms, Some(1_700_000_000_123));
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

    #[test]
    fn apply_non_funkot_gate_keeps_analysed_non_funkot_when_allow() {
        let cache = TempDir::new("gate-pending-allow-cache");
        let data = TempDir::new("gate-pending-allow-data");
        let (track, mut analysis) = track_with_analysis(&cache.0);
        analysis.is_funkot = false;
        store_for(&track, &cache.0, &analysis);

        let out = apply_non_funkot_gate(vec![track.clone()], &cache.0, &data.0, true);
        assert_eq!(out, vec![track]);
    }

    #[test]
    fn apply_non_funkot_gate_drops_analysed_non_funkot_keeps_unanalysed() {
        let cache = TempDir::new("gate-pending-deny-cache");
        let data = TempDir::new("gate-pending-deny-data");
        let (non_funkot, mut analysis) = track_with_analysis(&cache.0);
        analysis.is_funkot = false;
        store_for(&non_funkot, &cache.0, &analysis);

        let unanalysed = cache.0.join("unanalysed.wav");
        std::fs::write(&unanalysed, vec![1u8; 4096]).unwrap();

        let out = apply_non_funkot_gate(
            vec![non_funkot.clone(), unanalysed.clone()],
            &cache.0,
            &data.0,
            false,
        );
        assert_eq!(out, vec![unanalysed]);
    }

    #[test]
    fn apply_non_funkot_gate_honours_override_funkot_true() {
        let cache = TempDir::new("gate-pending-override-cache");
        let data = TempDir::new("gate-pending-override-data");
        let (track, mut analysis) = track_with_analysis(&cache.0);
        analysis.is_funkot = false;
        store_for(&track, &cache.0, &analysis);

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

        let out = apply_non_funkot_gate(vec![track.clone()], &cache.0, &data.0, false);
        assert_eq!(out, vec![track]);
    }

    #[test]
    fn apply_non_funkot_gate_from_index_drops_without_file_on_disk() {
        let cache = TempDir::new("gate-index-no-file-cache");
        let data = TempDir::new("gate-index-no-file-data");
        let (track, mut analysis) = track_with_analysis(&cache.0);
        analysis.is_funkot = false;
        store_for(&track, &cache.0, &analysis);
        let hash = funkot_core::cache::content_hash(&track).unwrap();
        let mut index = store::HashIndex::new();
        index.insert(
            track.to_string_lossy().into_owned(),
            store::HashIndexEntry {
                metadata_version: 0,
                embedded_metadata: None,
                metadata_error: None,
                mtime_ms: 0,
                len: 0,
                hash,
                tags_cached: false,
                title: None,
                artist: None,
                first_seen: None,
                added_order: None,
            },
        );
        store::save_hash_index(&data.0, &index).unwrap();
        std::fs::remove_file(&track).unwrap();
        assert!(!track.exists());

        let out = apply_non_funkot_gate_from_index(vec![track.clone()], &cache.0, &data.0, false);
        assert!(out.is_empty());
    }

    #[test]
    fn apply_non_funkot_gate_from_index_keeps_path_absent_from_index() {
        let cache = TempDir::new("gate-index-miss-cache");
        let data = TempDir::new("gate-index-miss-data");
        let missing = cache.0.join("not-in-index.wav");

        let out = apply_non_funkot_gate_from_index(vec![missing.clone()], &cache.0, &data.0, false);
        assert_eq!(out, vec![missing]);
    }

    #[test]
    fn apply_non_funkot_gate_from_index_keeps_analysed_non_funkot_when_allow() {
        let cache = TempDir::new("gate-index-allow-cache");
        let data = TempDir::new("gate-index-allow-data");
        let (track, mut analysis) = track_with_analysis(&cache.0);
        analysis.is_funkot = false;
        store_for(&track, &cache.0, &analysis);
        let hash = funkot_core::cache::content_hash(&track).unwrap();
        let mut index = store::HashIndex::new();
        index.insert(
            track.to_string_lossy().into_owned(),
            store::HashIndexEntry {
                metadata_version: 0,
                embedded_metadata: None,
                metadata_error: None,
                mtime_ms: 0,
                len: 0,
                hash,
                tags_cached: false,
                title: None,
                artist: None,
                first_seen: None,
                added_order: None,
            },
        );
        store::save_hash_index(&data.0, &index).unwrap();

        let out = apply_non_funkot_gate_from_index(vec![track.clone()], &cache.0, &data.0, true);
        assert_eq!(out, vec![track]);
    }

    #[test]
    fn adopted_core_reanalyzes_v14_without_losing_player_manual_edits_or_undo() {
        let cache = TempDir::new("v14-player-cache");
        let data = TempDir::new("v14-player-data");
        let (track, mut old) = track_with_analysis(&cache.0);
        let hash = funkot_core::cache::content_hash(&track).unwrap();
        let cache_file = cache.0.join(format!("{hash}.json"));
        old.version = 14;
        old.intro_bars = 8;
        old.outro_structure_bars = 8;
        std::fs::write(&cache_file, serde_json::to_vec(&old).unwrap()).unwrap();
        assert!(analyzed_cache_entry(&cache.0, &hash).is_none());
        set_bars_impl(&cache.0, &data.0, &track, Some(8), Some(8), true).unwrap();
        let sample_rate = 8_000;
        let frames = sample_rate * 64;
        let mut samples = vec![0.0f32; frames * 2];
        for beat in 0..192 {
            let start = (beat as f64 * sample_rate as f64 / 3.0).round() as usize;
            for offset in 0..(sample_rate * 80 / 1000).min(frames - start) {
                let time = offset as f64 / sample_rate as f64;
                let value = (0.8 * (-time / 0.03).exp()
                    * (2.0 * std::f64::consts::PI * 60.0 * time).sin()) as f32;
                samples[(start + offset) * 2] = value;
                samples[(start + offset) * 2 + 1] = value;
            }
        }
        let buffer = funkot_core::decode::AudioBuffer {
            sample_rate: sample_rate as u32, frames: frames as u64, samples,
        };
        let fresh = funkot_core::cache::get_or_analyze(&track, &cache.0, &buffer).unwrap();
        assert_eq!(fresh.version, 15);
        assert_eq!((fresh.intro_bars, fresh.outro_structure_bars, fresh.outro_bars), (8, 8, 24));
        std::fs::remove_file(&cache_file).unwrap();
        let rebuilt = funkot_core::cache::get_or_analyze(&track, &cache.0, &buffer).unwrap();
        assert!(!rebuilt.intro_bars_manual && !rebuilt.outro_structure_bars_manual);
        reapply_overrides(&track, &cache.0, &data.0);
        let restarted = funkot_core::cache::load(&cache.0, &hash).unwrap();
        assert!(restarted.intro_bars_manual && restarted.outro_structure_bars_manual);
        assert!(!restarted.outro_bars_manual);
        assert_eq!((restarted.intro_bars, restarted.outro_structure_bars, restarted.outro_bars), (8, 8, 24));
        assert_eq!(store::load_overrides(&data.0).get(&hash).unwrap().intro_bars, Some(8));
        set_bars_impl(&cache.0, &data.0, &track, Some(16), Some(16), false).unwrap();
        funkot_core::cache::purge_auto(&cache.0).unwrap();
        let automatic = funkot_core::cache::get_or_analyze(&track, &cache.0, &buffer).unwrap();
        reapply_overrides(&track, &cache.0, &data.0);
        let restarted = funkot_core::cache::load(&cache.0, &hash).unwrap();
        assert!(!restarted.intro_bars_manual && !restarted.outro_structure_bars_manual
            && !restarted.outro_bars_manual);
        assert!(automatic.intro_bars >= 16 && automatic.outro_structure_bars >= 16);
        assert!(!store::load_overrides(&data.0).contains_key(&hash));
    }

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

    #[test]
    fn set_bars_mark_manual_true_persists_across_reloads() {
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
        let reloaded = funkot_core::cache::load(&cache.0, &hash)
            .expect("manual edit must persist in the cache entry");
        assert_eq!(reloaded.intro_bars, analysis.intro_bars + 4);
        assert!(reloaded.intro_bars_manual);
    }

    #[test]
    fn reapply_overrides_does_not_resurrect_a_worker_start_override_after_undo() {
        let cache = TempDir::new("reapply-undo-cache");
        let data = TempDir::new("reapply-undo-data");
        let (track, analysis) = track_with_analysis(&cache.0);
        store_for(&track, &cache.0, &analysis);

        set_bars_impl(
            &cache.0,
            &data.0,
            &track,
            Some(analysis.intro_bars + 4),
            None,
            true,
        )
        .unwrap();
        let _worker_start_snapshot = store::load_overrides(&data.0);
        set_bars_impl(
            &cache.0,
            &data.0,
            &track,
            Some(analysis.intro_bars),
            None,
            false,
        )
        .unwrap();

        store_for(&track, &cache.0, &analysis);
        reapply_overrides(&track, &cache.0, &data.0);

        let hash = funkot_core::cache::content_hash(&track).unwrap();
        let reloaded = funkot_core::cache::load(&cache.0, &hash).unwrap();
        assert_eq!(reloaded.intro_bars, analysis.intro_bars);
        assert!(!reloaded.intro_bars_manual);
        assert!(!store::load_overrides(&data.0).contains_key(&hash));
    }

    #[test]
    fn reapply_overrides_uses_the_latest_manual_edit_after_worker_start() {
        let cache = TempDir::new("reapply-latest-cache");
        let data = TempDir::new("reapply-latest-data");
        let (track, analysis) = track_with_analysis(&cache.0);
        store_for(&track, &cache.0, &analysis);

        set_bars_impl(
            &cache.0,
            &data.0,
            &track,
            Some(analysis.intro_bars + 4),
            None,
            true,
        )
        .unwrap();
        let _worker_start_snapshot = store::load_overrides(&data.0);
        let current_intro = analysis.intro_bars + 12;
        set_bars_impl(
            &cache.0,
            &data.0,
            &track,
            Some(current_intro),
            None,
            true,
        )
        .unwrap();

        store_for(&track, &cache.0, &analysis);
        reapply_overrides(&track, &cache.0, &data.0);

        let hash = funkot_core::cache::content_hash(&track).unwrap();
        let reloaded = funkot_core::cache::load(&cache.0, &hash).unwrap();
        assert_eq!(reloaded.intro_bars, current_intro);
        assert!(reloaded.intro_bars_manual);
        assert_eq!(
            store::load_overrides(&data.0)
                .get(&hash)
                .and_then(|entry| entry.intro_bars),
            Some(current_intro)
        );
    }

    #[test]
    fn path_str_matches_track_row_path() {
        let cache = TempDir::new("path-str-cache");
        let (track, _) = track_with_analysis(&cache.0);
        let hash = funkot_core::cache::content_hash(&track).unwrap();
        assert_eq!(
            path_str(&track),
            track_row(
                &track,
                &cache.0,
                &store::Overrides::new(),
                &store::Labels::new(),
                &store::History::new(),
                Some(&hash),
                None,
            )
            .path
        );
    }

    #[test]
    fn set_label_impl_true_writes_labels_and_mirrors_override() {
        let cache = TempDir::new("label-true-cache");
        let data = TempDir::new("label-true-data");
        let (track, analysis) = track_with_analysis(&cache.0);
        store_for(&track, &cache.0, &analysis);

        let row = set_label_impl(&cache.0, &data.0, &track, Some(true)).unwrap();
        assert_eq!(row.label, Some(true));

        let hash = funkot_core::cache::content_hash(&track).unwrap();
        let labels = store::load_labels(&data.0);
        let entry = labels.get(&hash).expect("label present");
        assert!(entry.verdict);
        assert!(entry.labeled_at_ms > 0);
        assert_eq!(
            store::load_overrides(&data.0)
                .get(&hash)
                .and_then(|o| o.funkot),
            Some(true)
        );
    }

    #[test]
    fn set_label_impl_false_is_distinct_from_unlabeled() {
        let cache = TempDir::new("label-false-cache");
        let data = TempDir::new("label-false-data");
        let (track, analysis) = track_with_analysis(&cache.0);
        store_for(&track, &cache.0, &analysis);

        set_label_impl(&cache.0, &data.0, &track, Some(false)).unwrap();
        let hash = funkot_core::cache::content_hash(&track).unwrap();
        let labels = store::load_labels(&data.0);
        assert_eq!(labels.get(&hash).map(|l| l.verdict), Some(false));
        assert!(!labels.contains_key("never-labeled"));
    }

    #[test]
    fn set_label_impl_none_clears_label_and_removes_empty_override() {
        let cache = TempDir::new("label-clear-cache");
        let data = TempDir::new("label-clear-data");
        let (track, analysis) = track_with_analysis(&cache.0);
        store_for(&track, &cache.0, &analysis);

        set_label_impl(&cache.0, &data.0, &track, Some(true)).unwrap();
        let row = set_label_impl(&cache.0, &data.0, &track, None).unwrap();
        assert_eq!(row.label, None);

        let hash = funkot_core::cache::content_hash(&track).unwrap();
        assert!(!store::load_labels(&data.0).contains_key(&hash));
        assert!(!store::load_overrides(&data.0).contains_key(&hash));
    }

    #[test]
    fn set_label_impl_none_keeps_override_when_intro_bars_remain() {
        let cache = TempDir::new("label-keep-intro-cache");
        let data = TempDir::new("label-keep-intro-data");
        let (track, analysis) = track_with_analysis(&cache.0);
        store_for(&track, &cache.0, &analysis);
        let hash = funkot_core::cache::content_hash(&track).unwrap();

        let mut overrides = store::Overrides::new();
        overrides.insert(
            hash.clone(),
            store::BarOverride {
                intro_bars: Some(8),
                ..Default::default()
            },
        );
        store::save_overrides(&data.0, &overrides).unwrap();

        set_label_impl(&cache.0, &data.0, &track, Some(false)).unwrap();
        set_label_impl(&cache.0, &data.0, &track, None).unwrap();

        let entry = store::load_overrides(&data.0)
            .get(&hash)
            .cloned()
            .expect("override entry kept");
        assert_eq!(entry.intro_bars, Some(8));
        assert_eq!(entry.funkot, None);
        assert!(!store::load_labels(&data.0).contains_key(&hash));
    }

    #[test]
    fn clear_labels_impl_empties_labels_and_keeps_history_and_play_log() {
        let data = TempDir::new("clear-labels-data");
        let mut labels = store::Labels::new();
        labels.insert(
            "hash-a".into(),
            store::TrackLabel {
                verdict: true,
                labeled_at_ms: 1,
            },
        );
        store::save_labels(&data.0, &labels).unwrap();
        let mut history = store::History::new();
        history.insert(
            "hash-a".into(),
            store::PlayRecord {
                count: 3,
                last_played_ms: 99,
            },
        );
        store::save_history(&data.0, &history).unwrap();
        store::append_play_log(
            &data.0,
            &store::PlayLogEntry {
                at_ms: 99,
                hash: "hash-a".into(),
                origin: None,
            },
        )
        .unwrap();

        clear_labels_impl(&data.0).unwrap();

        assert!(store::load_labels(&data.0).is_empty());
        assert!(!store::load_history(&data.0).is_empty());
        assert_eq!(store::load_play_log(&data.0).len(), 1);
    }

    #[test]
    fn clear_labels_impl_keeps_intro_bars() {
        let data = TempDir::new("clear-lh-keep-intro");
        let mut overrides = store::Overrides::new();
        overrides.insert(
            "hash-b".into(),
            store::BarOverride {
                intro_bars: Some(8),
                funkot: Some(false),
                ..Default::default()
            },
        );
        store::save_overrides(&data.0, &overrides).unwrap();

        clear_labels_impl(&data.0).unwrap();

        let entry = store::load_overrides(&data.0)
            .get("hash-b")
            .cloned()
            .expect("override kept");
        assert_eq!(entry.intro_bars, Some(8));
        assert_eq!(entry.funkot, None);
    }

    #[test]
    fn clear_labels_impl_removes_funkot_only_override() {
        let data = TempDir::new("clear-lh-funkot-only");
        let mut overrides = store::Overrides::new();
        overrides.insert(
            "hash-c".into(),
            store::BarOverride {
                funkot: Some(false),
                ..Default::default()
            },
        );
        store::save_overrides(&data.0, &overrides).unwrap();

        clear_labels_impl(&data.0).unwrap();

        assert!(!store::load_overrides(&data.0).contains_key("hash-c"));
    }

    #[test]
    fn clear_play_log_impl_clears_log_keeps_labels_and_history() {
        let data = TempDir::new("clear-playlog-data");
        let mut labels = store::Labels::new();
        labels.insert(
            "hash-a".into(),
            store::TrackLabel {
                verdict: true,
                labeled_at_ms: 1,
            },
        );
        store::save_labels(&data.0, &labels).unwrap();
        let mut history = store::History::new();
        history.insert(
            "hash-a".into(),
            store::PlayRecord {
                count: 3,
                last_played_ms: 99,
            },
        );
        store::save_history(&data.0, &history).unwrap();
        store::append_play_log(
            &data.0,
            &store::PlayLogEntry {
                at_ms: 99,
                hash: "hash-a".into(),
                origin: None,
            },
        )
        .unwrap();

        clear_play_log_impl(&data.0).unwrap();

        assert!(store::load_play_log(&data.0).is_empty());
        assert!(!store::load_labels(&data.0).is_empty());
        assert!(!store::load_history(&data.0).is_empty());
    }

    fn arrivals_entry(hash: &str, first_seen: Option<&str>) -> store::HashIndexEntry {
        store::HashIndexEntry {
            metadata_version: 0,
            embedded_metadata: None,
            metadata_error: None,
            mtime_ms: 0,
            len: 0,
            hash: hash.into(),
            tags_cached: false,
            title: None,
            artist: None,
            first_seen: first_seen.map(str::to_string),
            added_order: None,
        }
    }

    #[test]
    fn clear_play_counts_folds_played_keeps_unplayed_stamp_and_keeps_play_log() {
        let data = TempDir::new("clear-lh-fold-ab");
        let mut index = store::HashIndex::new();
        index.insert(
            "/music/a.flac".into(),
            arrivals_entry("hash-a", Some("2026-01-01T00:00:00Z")),
        );
        index.insert(
            "/music/b.flac".into(),
            arrivals_entry("hash-b", Some("2026-01-02T00:00:00Z")),
        );
        store::save_hash_index(&data.0, &index).unwrap();
        let mut history = store::History::new();
        history.insert(
            "hash-a".into(),
            store::PlayRecord {
                count: 1,
                last_played_ms: 1,
            },
        );
        store::save_history(&data.0, &history).unwrap();
        store::append_play_log(
            &data.0,
            &store::PlayLogEntry {
                at_ms: 1,
                hash: "hash-a".into(),
                origin: None,
            },
        )
        .unwrap();

        clear_play_counts_impl(&data.0).unwrap();

        let loaded = store::load_hash_index(&data.0).index;
        assert!(loaded["/music/a.flac"].first_seen.is_none());
        assert_eq!(
            loaded["/music/b.flac"].first_seen.as_deref(),
            Some("2026-01-02T00:00:00Z")
        );
        assert!(store::load_history(&data.0).is_empty());
        assert_eq!(store::load_play_log(&data.0).len(), 1);

        let settings = store::Settings {
            arrivals_baseline_done: true,
            ..Default::default()
        };
        store::save_settings(&data.0, &settings).unwrap();
        let after = list_new_arrivals_impl(&data.0).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].path, "/music/b.flac");
    }

    #[test]
    fn clear_play_counts_keeps_history_when_index_save_fails() {
        let data = TempDir::new("clear-lh-index-fail");
        let mut index = store::HashIndex::new();
        index.insert(
            "/music/a.flac".into(),
            arrivals_entry("hash-a", Some("2026-01-01T00:00:00Z")),
        );
        store::save_hash_index(&data.0, &index).unwrap();
        let mut history = store::History::new();
        history.insert(
            "hash-a".into(),
            store::PlayRecord {
                count: 1,
                last_played_ms: 1,
            },
        );
        store::save_history(&data.0, &history).unwrap();

        let err = clear_play_counts_with_index_save(
            &data.0,
            |_dir, _idx| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "injected index save failure",
                ))
            },
            &HISTORY_REVISION,
        )
        .unwrap_err();
        assert!(err.contains("hash-index"), "{err}");
        assert!(store::load_history(&data.0).contains_key("hash-a"));
        assert_eq!(
            store::load_hash_index(&data.0).index["/music/a.flac"]
                .first_seen
                .as_deref(),
            Some("2026-01-01T00:00:00Z")
        );
    }

    #[test]
    fn clear_play_counts_bumps_history_revision_on_success() {
        let data = TempDir::new("clear-lh-rev");
        let revision = AtomicU64::new(7);
        clear_play_counts_with_index_save(&data.0, store::save_hash_index, &revision)
            .unwrap();
        assert_eq!(revision.load(Ordering::Relaxed), 8);
    }

    #[test]
    fn clear_track_play_count_clears_only_target_track_and_folds_arrival() {
        let data = TempDir::new("clear-track-count");
        let mut index = store::HashIndex::new();
        index.insert(
            "/music/a.flac".into(),
            arrivals_entry("hash-a", Some("2026-01-01T00:00:00Z")),
        );
        index.insert(
            "/music/b.flac".into(),
            arrivals_entry("hash-b", Some("2026-01-02T00:00:00Z")),
        );
        store::save_hash_index(&data.0, &index).unwrap();

        let mut history = store::History::new();
        history.insert(
            "hash-a".into(),
            store::PlayRecord {
                count: 5,
                last_played_ms: 10,
            },
        );
        history.insert(
            "hash-b".into(),
            store::PlayRecord {
                count: 3,
                last_played_ms: 20,
            },
        );
        store::save_history(&data.0, &history).unwrap();

        store::append_play_log(
            &data.0,
            &store::PlayLogEntry {
                at_ms: 10,
                hash: "hash-a".into(),
                origin: None,
            },
        )
        .unwrap();

        clear_track_play_count_impl(&data.0, "hash-a").unwrap();

        let loaded_history = store::load_history(&data.0);
        assert!(!loaded_history.contains_key("hash-a"));
        assert_eq!(loaded_history["hash-b"].count, 3);

        let loaded_index = store::load_hash_index(&data.0).index;
        assert!(loaded_index["/music/a.flac"].first_seen.is_none());
        assert_eq!(
            loaded_index["/music/b.flac"].first_seen.as_deref(),
            Some("2026-01-02T00:00:00Z")
        );

        assert_eq!(store::load_play_log(&data.0).len(), 1);
    }

    #[test]
    fn remove_play_log_entry_removes_only_target_row_keeps_history() {
        let data = TempDir::new("remove-log-entry");
        store::append_play_log(
            &data.0,
            &store::PlayLogEntry {
                at_ms: 100,
                hash: "hash-a".into(),
                origin: None,
            },
        )
        .unwrap();
        store::append_play_log(
            &data.0,
            &store::PlayLogEntry {
                at_ms: 200,
                hash: "hash-a".into(),
                origin: None,
            },
        )
        .unwrap();

        let mut history = store::History::new();
        history.insert(
            "hash-a".into(),
            store::PlayRecord {
                count: 2,
                last_played_ms: 200,
            },
        );
        store::save_history(&data.0, &history).unwrap();

        remove_play_log_entry_impl(&data.0, 100).unwrap();

        let log = store::load_play_log(&data.0);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].at_ms, 200);

        assert_eq!(store::load_history(&data.0)["hash-a"].count, 2);
    }

    #[test]
    fn list_new_arrivals_impl_folds_and_returns_unplayed() {
        let data = TempDir::new("list-arrivals");
        store::save_settings(
            &data.0,
            &store::Settings {
                arrivals_baseline_done: true,
                ..Default::default()
            },
        )
        .unwrap();
        let mut index = store::HashIndex::new();
        index.insert(
            "/music/a.flac".into(),
            arrivals_entry("hash-a", Some("2026-01-02T00:00:00Z")),
        );
        index.insert(
            "/music/b.flac".into(),
            arrivals_entry("hash-b", Some("2026-01-01T00:00:00Z")),
        );
        store::save_hash_index(&data.0, &index).unwrap();
        let mut history = store::History::new();
        history.insert(
            "hash-a".into(),
            store::PlayRecord {
                count: 1,
                last_played_ms: 1,
            },
        );
        store::save_history(&data.0, &history).unwrap();

        let got = list_new_arrivals_impl(&data.0).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].path, "/music/b.flac");
        assert!(
            store::load_hash_index(&data.0).index["/music/a.flac"]
                .first_seen
                .is_none()
        );
    }

    #[test]
    fn list_new_arrivals_impl_errs_when_index_missing() {
        let data = TempDir::new("list-arrivals-missing");
        store::save_settings(
            &data.0,
            &store::Settings {
                arrivals_baseline_done: true,
                ..Default::default()
            },
        )
        .unwrap();
        let err = list_new_arrivals_impl(&data.0).unwrap_err();
        assert!(
            err.contains("arrivals_index_unavailable"),
            "{err}"
        );
    }

    #[test]
    fn list_new_arrivals_impl_errs_when_baseline_not_done() {
        let data = TempDir::new("list-arrivals-no-baseline");
        store::save_settings(
            &data.0,
            &store::Settings {
                arrivals_baseline_done: false,
                ..Default::default()
            },
        )
        .unwrap();
        let mut index = store::HashIndex::new();
        index.insert(
            "/music/a.flac".into(),
            arrivals_entry("hash-a", Some("2026-01-01T00:00:00Z")),
        );
        store::save_hash_index(&data.0, &index).unwrap();

        let err = list_new_arrivals_impl(&data.0).unwrap_err();
        assert!(
            err.contains("arrivals_index_unavailable"),
            "{err}"
        );
    }

    #[test]
    fn list_new_arrivals_impl_ok_empty_when_no_stamps() {
        let data = TempDir::new("list-arrivals-empty");
        store::save_settings(
            &data.0,
            &store::Settings {
                arrivals_baseline_done: true,
                ..Default::default()
            },
        )
        .unwrap();
        let mut index = store::HashIndex::new();
        index.insert(
            "/music/a.flac".into(),
            arrivals_entry("hash-a", None),
        );
        store::save_hash_index(&data.0, &index).unwrap();

        let got = list_new_arrivals_impl(&data.0).unwrap();
        assert!(got.is_empty());
    }

    #[test]
    fn queue_new_arrivals_with_orders_and_releases_save_lock() {
        let data = TempDir::new("queue-arrivals-order-data");
        let cache = TempDir::new("queue-arrivals-order-cache");
        store::save_settings(
            &data.0,
            &store::Settings {
                arrivals_baseline_done: true,
                ..Default::default()
            },
        )
        .unwrap();
        let mut index = store::HashIndex::new();
        index.insert(
            "/music/z.flac".into(),
            arrivals_entry("hz", Some("2026-01-01T00:00:00Z")),
        );
        index.insert(
            "/music/a.flac".into(),
            arrivals_entry("ha", Some("2026-01-01T00:00:00Z")),
        );
        index.insert(
            "/music/m.flac".into(),
            arrivals_entry("hm", Some("2026-01-02T00:00:00Z")),
        );
        index.insert(
            "/music/r.flac".into(),
            arrivals_entry("hr", Some("2026-01-01T00:00:00Z")),
        );
        store::save_hash_index(&data.0, &index).unwrap();

        let q = queue::new_shared_queue();
        queue::enqueue(&q, PathBuf::from("/music/r.flac"));
        queue::enqueue(&q, PathBuf::from("/music/old.flac"));
        let mut source = queue::HostSource::new(
            Arc::clone(&q),
            queue::DrainPolicy::ContinueFolder {
                tracks: Vec::new(),
                pos: 0,
            },
        );
        assert_eq!(
            source.next(),
            Some((0, PathBuf::from("/music/r.flac")))
        );

        let in_flight = vec![QueueItem::manual(PathBuf::from("/music/z.flac"))];
        let added = queue_new_arrivals_with(&data.0, &cache.0, &q, true, &in_flight).unwrap();
        assert_eq!(added, 2);

        let (reserved, pending) = queue::state_snapshot(&q);
        assert_eq!(reserved, None);
        assert_eq!(
            queue::reserved_track(&q),
            Some(PathBuf::from("/music/r.flac"))
        );
        assert_eq!(
            pending.iter().map(|item| item.path.clone()).collect::<Vec<_>>(),
            vec![
                PathBuf::from("/music/r.flac"),
                PathBuf::from("/music/old.flac"),
                PathBuf::from("/music/a.flac"),
                PathBuf::from("/music/m.flac"),
            ]
        );
        assert_eq!(
            queue_new_arrivals_with(&data.0, &cache.0, &q, true, &in_flight).unwrap(),
            0
        );
    }

    #[test]
    fn enqueue_many_with_keeps_the_given_order_after_the_manual_block() {
        let data = TempDir::new("enqueue-many-order-data");
        let cache = TempDir::new("enqueue-many-order-cache");
        let q = queue::new_shared_queue();
        queue::enqueue(&q, PathBuf::from("/music/already.flac"));

        let result = enqueue_many_with(
            &data.0,
            &cache.0,
            &q,
            true,
            &[],
            &[
                "/music/c.flac".to_string(),
                "/music/a.flac".to_string(),
                "/music/b.flac".to_string(),
            ],
        );

        assert_eq!(
            result,
            EnqueueManyResult {
                added: 3,
                rejected: 0,
                skipped: 0,
            }
        );
        assert_eq!(
            queue::snapshot(&q),
            vec![
                PathBuf::from("/music/already.flac"),
                PathBuf::from("/music/c.flac"),
                PathBuf::from("/music/a.flac"),
                PathBuf::from("/music/b.flac"),
            ]
        );
    }

    #[test]
    fn enqueue_many_with_counts_already_queued_as_skipped() {
        let data = TempDir::new("enqueue-many-skip-data");
        let cache = TempDir::new("enqueue-many-skip-cache");
        let q = queue::new_shared_queue();
        queue::enqueue(&q, PathBuf::from("/music/a.flac"));
        let in_flight = vec![QueueItem::manual(PathBuf::from("/music/b.flac"))];

        let result = enqueue_many_with(
            &data.0,
            &cache.0,
            &q,
            true,
            &in_flight,
            &[
                "/music/a.flac".to_string(),
                "/music/b.flac".to_string(),
                "/music/c.flac".to_string(),
                "/music/c.flac".to_string(),
            ],
        );

        assert_eq!(
            result,
            EnqueueManyResult {
                added: 1,
                rejected: 0,
                skipped: 3,
            }
        );
        assert_eq!(
            queue::snapshot(&q),
            vec![
                PathBuf::from("/music/a.flac"),
                PathBuf::from("/music/c.flac"),
            ]
        );
    }

    #[test]
    fn enqueue_many_with_counts_the_non_funkot_gate_instead_of_failing() {
        let data = TempDir::new("enqueue-many-gate-data");
        let cache = TempDir::new("enqueue-many-gate-cache");

        let (non_funkot, mut analysis) = track_with_analysis(&cache.0);
        analysis.is_funkot = false;
        store_for(&non_funkot, &cache.0, &analysis);
        let nf_hash = funkot_core::cache::content_hash(&non_funkot).unwrap();
        let nf_path = non_funkot.to_string_lossy().into_owned();

        let unanalysed = cache.0.join("unanalysed.wav");
        std::fs::write(&unanalysed, vec![9u8; 4096]).unwrap();
        let ua_path = unanalysed.to_string_lossy().into_owned();

        let mut index = store::HashIndex::new();
        index.insert(nf_path.clone(), arrivals_entry(&nf_hash, None));
        index.insert(ua_path.clone(), arrivals_entry("hash-unanalysed", None));
        store::save_hash_index(&data.0, &index).unwrap();

        let q = queue::new_shared_queue();
        let result = enqueue_many_with(
            &data.0,
            &cache.0,
            &q,
            false,
            &[],
            &[nf_path.clone(), ua_path.clone()],
        );

        assert_eq!(
            result,
            EnqueueManyResult {
                added: 1,
                rejected: 1,
                skipped: 0,
            }
        );
        assert_eq!(queue::snapshot(&q), vec![PathBuf::from(&ua_path)]);
    }

    #[test]
    fn enqueue_many_with_nothing_selected_is_all_zeros() {
        let data = TempDir::new("enqueue-many-empty-data");
        let cache = TempDir::new("enqueue-many-empty-cache");
        let q = queue::new_shared_queue();
        assert_eq!(
            enqueue_many_with(&data.0, &cache.0, &q, true, &[], &[]),
            EnqueueManyResult {
                added: 0,
                rejected: 0,
                skipped: 0,
            }
        );
        assert!(queue::snapshot(&q).is_empty());
    }

    #[test]
    fn queue_new_arrivals_with_applies_non_funkot_gate() {
        let data = TempDir::new("queue-arrivals-gate-data");
        let cache = TempDir::new("queue-arrivals-gate-cache");
        store::save_settings(
            &data.0,
            &store::Settings {
                arrivals_baseline_done: true,
                ..Default::default()
            },
        )
        .unwrap();

        let (non_funkot, mut analysis) = track_with_analysis(&cache.0);
        analysis.is_funkot = false;
        store_for(&non_funkot, &cache.0, &analysis);
        let nf_hash = funkot_core::cache::content_hash(&non_funkot).unwrap();
        let nf_path = non_funkot.to_string_lossy().into_owned();

        let unanalysed = cache.0.join("unanalysed.wav");
        std::fs::write(&unanalysed, vec![9u8; 4096]).unwrap();
        let ua_path = unanalysed.to_string_lossy().into_owned();

        let mut index = store::HashIndex::new();
        index.insert(
            nf_path.clone(),
            arrivals_entry(&nf_hash, Some("2026-01-01T00:00:00Z")),
        );
        index.insert(
            ua_path.clone(),
            arrivals_entry("hash-unanalysed", Some("2026-01-02T00:00:00Z")),
        );
        store::save_hash_index(&data.0, &index).unwrap();

        let q = queue::new_shared_queue();
        let added = queue_new_arrivals_with(&data.0, &cache.0, &q, false, &[]).unwrap();
        assert_eq!(added, 1);
        assert_eq!(queue::snapshot(&q), vec![PathBuf::from(&ua_path)]);
    }

    #[test]
    fn queue_new_arrivals_with_excludes_now_playing() {
        let data = TempDir::new("queue-arrivals-now-data");
        let cache = TempDir::new("queue-arrivals-now-cache");
        store::save_settings(
            &data.0,
            &store::Settings {
                arrivals_baseline_done: true,
                ..Default::default()
            },
        )
        .unwrap();
        let mut index = store::HashIndex::new();
        index.insert(
            "/music/now.flac".into(),
            arrivals_entry("hn", Some("2026-01-01T00:00:00Z")),
        );
        index.insert(
            "/music/new.flac".into(),
            arrivals_entry("hx", Some("2026-01-02T00:00:00Z")),
        );
        store::save_hash_index(&data.0, &index).unwrap();

        {
            let mut now = NOW.lock().unwrap();
            now.now = Some(PathBuf::from("/music/now.flac"));
        }
        let q = queue::new_shared_queue();
        let added = queue_new_arrivals_with(&data.0, &cache.0, &q, true, &[]).unwrap();
        assert_eq!(added, 1);
        assert_eq!(queue::snapshot(&q), vec![PathBuf::from("/music/new.flac")]);
        NOW.lock().unwrap().now = None;
    }

    #[test]
    fn set_folder_label_impl_recurses_and_skips_non_audio() {
        let data = TempDir::new("folder-label-data");
        let music = TempDir::new("folder-label-music");
        std::fs::write(music.0.join("a.wav"), vec![1u8; 4096]).unwrap();
        std::fs::create_dir_all(music.0.join("sub").join("nested")).unwrap();
        std::fs::write(music.0.join("sub").join("b.wav"), vec![2u8; 4096]).unwrap();
        std::fs::write(music.0.join("sub").join("nested").join("c.mp3"), vec![3u8; 4096])
            .unwrap();
        std::fs::write(music.0.join("readme.txt"), b"not audio").unwrap();
        std::fs::write(music.0.join("sub").join("notes.md"), b"skip").unwrap();

        let (scanned, _) = scan_tracks(&music.0).unwrap();
        assert_eq!(scanned.len(), 3, "scan_tracks paths: {scanned:?}");
        let (count, undo) = set_folder_label_impl(&data.0, &music.0, true).unwrap();
        assert_eq!(count, 3);
        assert_eq!(undo.len(), 3);
        assert_eq!(store::load_labels(&data.0).len(), 3);
        assert!(store::load_labels(&data.0).values().all(|l| l.verdict));
    }

    #[test]
    fn undo_folder_label_restores_previous_state() {
        let cache = TempDir::new("folder-undo-cache");
        let data = TempDir::new("folder-undo-data");
        let music = TempDir::new("folder-undo-music");
        std::fs::write(music.0.join("a.wav"), vec![1u8; 4096]).unwrap();
        std::fs::write(music.0.join("b.wav"), vec![2u8; 4096]).unwrap();
        std::fs::write(music.0.join("c.mp3"), vec![3u8; 4096]).unwrap();

        let a = music.0.join("a.wav");
        set_label_impl(&cache.0, &data.0, &a, Some(false)).unwrap();
        let before = store::load_labels(&data.0);
        assert_eq!(before.len(), 1);

        let (count, undo) = set_folder_label_impl(&data.0, &music.0, true).unwrap();
        assert_eq!(count, 3);
        assert_eq!(store::load_labels(&data.0).len(), 3);

        assert_eq!(undo_folder_label_impl(&data.0, &undo).unwrap(), 3);
        let after = store::load_labels(&data.0);
        assert_eq!(after.len(), 1, "b and c must go back to unlabeled");
        let hash = store::resolve_content_hash(&a, &mut store::load_hash_index(&data.0).index).unwrap();
        assert_eq!(after.get(&hash).map(|l| l.verdict), Some(false));
        assert_eq!(
            store::load_overrides(&data.0).get(&hash).and_then(|o| o.funkot),
            Some(false),
            "the library.json mirror must follow the label back"
        );
    }

    #[test]
    fn undo_folder_label_keeps_manual_bars() {
        let data = TempDir::new("folder-undo-bars-data");
        let music = TempDir::new("folder-undo-bars-music");
        std::fs::write(music.0.join("a.wav"), vec![7u8; 4096]).unwrap();

        let (_, undo) = set_folder_label_impl(&data.0, &music.0, true).unwrap();
        assert_eq!(undo.len(), 1);

        let mut overrides = store::load_overrides(&data.0);
        overrides.get_mut(&undo[0].hash).unwrap().intro_bars = Some(32);
        store::save_overrides(&data.0, &overrides).unwrap();

        undo_folder_label_impl(&data.0, &undo).unwrap();
        let after = store::load_overrides(&data.0);
        let entry = after.get(&undo[0].hash).expect("entry kept for the bars");
        assert_eq!(entry.intro_bars, Some(32));
        assert_eq!(entry.funkot, None);
        assert!(store::load_labels(&data.0).is_empty());
    }

    #[test]
    fn label_stats_impl_matches_music_dir_and_verdicts() {
        let data = TempDir::new("label-stats-data");
        let music = TempDir::new("label-stats-music");
        std::fs::write(music.0.join("a.wav"), vec![10u8; 4096]).unwrap();
        std::fs::write(music.0.join("b.wav"), vec![20u8; 4096]).unwrap();
        std::fs::write(music.0.join("c.mp3"), vec![30u8; 4096]).unwrap();

        set_folder_label_impl(&data.0, &music.0, true).unwrap();
        let a = music.0.join("a.wav");
        let cache = TempDir::new("label-stats-cache");
        set_label_impl(&cache.0, &data.0, &a, Some(false)).unwrap();

        let stats = label_stats_impl(&data.0, Some(music.0.as_path()));
        let expected_total = scan_tracks(&music.0).unwrap().0.len();
        assert_eq!(stats.total, expected_total);
        assert_eq!(stats.labeled, 3);
        assert_eq!(stats.funkot, 2);
        assert_eq!(stats.not_funkot, 1);
        assert_eq!(label_stats_impl(&data.0, None).total, 0);
    }

    #[test]
    fn set_label_survives_reload() {
        let cache = TempDir::new("label-reload-cache");
        let data = TempDir::new("label-reload-data");
        let (track, analysis) = track_with_analysis(&cache.0);
        store_for(&track, &cache.0, &analysis);

        set_label_impl(&cache.0, &data.0, &track, Some(false)).unwrap();
        let hash = funkot_core::cache::content_hash(&track).unwrap();
        let reloaded = store::load_labels(&data.0);
        assert_eq!(reloaded.get(&hash).map(|l| l.verdict), Some(false));
        assert!(reloaded[&hash].labeled_at_ms > 0);
        assert_eq!(
            store::load_overrides(&data.0)
                .get(&hash)
                .and_then(|o| o.funkot),
            Some(false)
        );
    }
}

#[cfg(test)]
mod scan_tracks_tests {
    use super::*;

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

        let (found, _) = scan_tracks(&dir.0).unwrap();
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

        let (found, _) = scan_tracks(&dir.0).unwrap();
        assert_eq!(found, vec![dir.0.join("visible.wav")]);
    }

    #[test]
    fn ignores_dot_prefixed_files() {
        let dir = TempDir::new("dot-file");
        touch(&dir.0.join(".track.wav"));
        touch(&dir.0.join("track.wav"));

        let (found, _) = scan_tracks(&dir.0).unwrap();
        assert_eq!(found, vec![dir.0.join("track.wav")]);
    }

    #[test]
    fn ignores_unsupported_extensions() {
        let dir = TempDir::new("unsupported");
        touch(&dir.0.join("notes.txt"));
        touch(&dir.0.join("track.wav"));

        let (found, _) = scan_tracks(&dir.0).unwrap();
        assert_eq!(found, vec![dir.0.join("track.wav")]);
    }

    #[test]
    fn result_is_sorted() {
        let dir = TempDir::new("sorted");
        touch(&dir.0.join("z.wav"));
        touch(&dir.0.join("m.wav"));
        touch(&dir.0.join("a.wav"));

        let (found, _) = scan_tracks(&dir.0).unwrap();
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

        let (found, _) = scan_tracks(&dir.0).unwrap();
        assert_eq!(found, vec![dir.0.join("inside.wav")]);
    }

    #[test]
    fn same_basename_in_different_subdirs_both_survive() {
        let dir = TempDir::new("same-basename");
        touch(&dir.0.join("a").join("01.mp3"));
        touch(&dir.0.join("b").join("01.mp3"));

        let (found, _) = scan_tracks(&dir.0).unwrap();
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

    #[test]
    fn playback_track_count_accepts_one_track() {
        let dir = Path::new("/music");
        assert_eq!(ensure_tracks_available(&[dir.join("only.mp3")], dir), Ok(()));
    }

    #[test]
    fn playback_track_count_rejects_an_empty_library() {
        let dir = Path::new("/music");
        assert_eq!(
            ensure_tracks_available(&[], dir),
            Err("need >= 1 track in /music, found 0".into())
        );
    }
}

#[cfg(test)]
mod arrivals_settings_rmw_tests {
    use super::*;
    use std::sync::{Arc, Barrier, Mutex, MutexGuard};

    pub(crate) static ALLOW_NON_FUNKOT_LOCK: Mutex<()> = Mutex::new(());

    fn lock_allow_non_funkot() -> MutexGuard<'static, ()> {
        ALLOW_NON_FUNKOT_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "funkot-player-arrivals-rmw-{name}-{}-{}",
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

    #[test]
    fn refresh_baseline_commit_and_allow_false_both_orders() {
        let _allow = lock_allow_non_funkot();
        for setter_first in [true, false] {
            let dir = TempDir::new(&format!("baseline-allow-{setter_first}"));
            let mut settings = store::Settings::default();
            settings.arrivals_baseline_done = false;
            settings.allow_non_funkot = true;
            store::save_settings(&dir.0, &settings).unwrap();

            let barrier = Arc::new(Barrier::new(2));
            let data_a = dir.0.clone();
            let data_b = dir.0.clone();
            let b1 = barrier.clone();
            let b2 = barrier.clone();

            let commit = std::thread::spawn(move || {
                if setter_first {
                    b1.wait();
                }
                mark_arrivals_baseline_done(&data_a).unwrap();
                if !setter_first {
                    b1.wait();
                }
            });
            let setter = std::thread::spawn(move || {
                if !setter_first {
                    b2.wait();
                }
                with_settings_rmw_then(
                    &data_b,
                    |s| s.allow_non_funkot = false,
                    |_| {
                        ALLOW_NON_FUNKOT.store(false, Ordering::Relaxed);
                    },
                )
                .unwrap();
                if setter_first {
                    b2.wait();
                }
            });
            commit.join().unwrap();
            setter.join().unwrap();

            let final_s = store::load_settings(&dir.0);
            assert!(
                final_s.arrivals_baseline_done,
                "setter_first={setter_first}"
            );
            assert!(!final_s.allow_non_funkot, "setter_first={setter_first}");
        }
    }

    #[test]
    fn refresh_baseline_commit_and_labeling_mode_both_kept() {
        let dir = TempDir::new("baseline-labeling");
        let mut settings = store::Settings::default();
        settings.arrivals_baseline_done = false;
        settings.labeling_mode = false;
        store::save_settings(&dir.0, &settings).unwrap();

        let barrier = Arc::new(Barrier::new(2));
        let data_a = dir.0.clone();
        let data_b = dir.0.clone();
        let b1 = barrier.clone();
        let b2 = barrier.clone();

        let commit = std::thread::spawn(move || {
            b1.wait();
            mark_arrivals_baseline_done(&data_a).unwrap();
        });
        let setter = std::thread::spawn(move || {
            b2.wait();
            with_settings_rmw(&data_b, |s| s.labeling_mode = true).unwrap();
        });
        commit.join().unwrap();
        setter.join().unwrap();

        let final_s = store::load_settings(&dir.0);
        assert!(final_s.arrivals_baseline_done);
        assert!(final_s.labeling_mode);
    }

    #[test]
    fn consecutive_allow_setters_match_disk_and_atomic() {
        let _allow = lock_allow_non_funkot();
        let dir = TempDir::new("allow-consecutive");
        store::save_settings(&dir.0, &store::Settings::default()).unwrap();
        for allow in [false, true, false, true, false] {
            with_settings_rmw_then(
                &dir.0,
                |s| s.allow_non_funkot = allow,
                |_| {
                    ALLOW_NON_FUNKOT.store(allow, Ordering::Relaxed);
                },
            )
            .unwrap();
            assert_eq!(store::load_settings(&dir.0).allow_non_funkot, allow);
            assert_eq!(ALLOW_NON_FUNKOT.load(Ordering::Relaxed), allow);
        }
    }

    #[test]
    fn legacy_queue_conflict_keeps_library_commit_available_and_baseline_pending() {
        let dir = TempDir::new("library-legacy-conflict");
        let queue = vec![QueueItem::manual(PathBuf::from("/synthetic/player.flac"))];
        let mut catalog = playlists::Catalog::default();
        catalog.normal = Some(playlists::NormalResume {
            items: vec![QueueItem::manual(PathBuf::from("/synthetic/playlist.flac"))],
            folder_pos: None,
        });
        let originals = [
            ("queue.json", serde_json::to_vec(&queue).unwrap()),
            ("playlists.json", serde_json::to_vec(&catalog).unwrap()),
        ];
        for (name, bytes) in &originals {
            std::fs::write(dir.0.join(name), bytes).unwrap();
        }
        assert!(playback_state::PlaybackStore::open(&dir.0).snapshot().is_err());
        commit_arrivals_after_scan(
            &dir.0,
            &store::HashIndex::new(),
            store::ArrivalsCommitPlan { save_index: true, mark_baseline_done: true },
            store::save_hash_index,
            mark_arrivals_baseline_done,
        ).expect("detected tracks must remain available during queue recovery");
        assert_eq!(store::load_hash_index(&dir.0).provenance, store::HashIndexProvenance::Loaded);
        assert!(!store::load_settings(&dir.0).arrivals_baseline_done);
        assert!(!dir.0.join("playback-state.json").exists());
        for (name, bytes) in originals {
            assert_eq!(std::fs::read(dir.0.join(name)).unwrap(), bytes);
        }
    }

    #[test]
    fn baseline_flag_save_failure_makes_commit_fail() {
        let dir = TempDir::new("baseline-save-fail");
        let index = store::HashIndex::new();
        let plan = store::ArrivalsCommitPlan {
            save_index: true,
            mark_baseline_done: true,
        };
        let err = commit_arrivals_after_scan(
            &dir.0,
            &index,
            plan,
            store::save_hash_index,
            |_data| Err("injected baseline save failure".into()),
        );
        assert!(err.is_err());
        assert!(store::load_hash_index(&dir.0).provenance == store::HashIndexProvenance::Loaded);
        assert!(!store::load_settings(&dir.0).arrivals_baseline_done);
    }

    #[test]
    fn incomplete_recovery_commit_does_not_save_index() {
        let dir = TempDir::new("incomplete-no-save");
        let mut index = store::HashIndex::new();
        index.insert(
            "/music/partial.flac".into(),
            store::HashIndexEntry {
                metadata_version: 0,
                embedded_metadata: None,
                metadata_error: None,
                mtime_ms: 1,
                len: 1,
                hash: "p".into(),
                tags_cached: false,
                title: None,
                artist: None,
                first_seen: None,
                added_order: None,
            },
        );
        let plan = store::arrivals_commit_plan(store::ArrivalsKind::Recovery, false);
        commit_arrivals_after_scan(
            &dir.0,
            &index,
            plan,
            store::save_hash_index,
            mark_arrivals_baseline_done,
        )
        .unwrap();
        assert_eq!(
            store::load_hash_index(&dir.0).provenance,
            store::HashIndexProvenance::Missing
        );
        assert!(!store::load_settings(&dir.0).arrivals_baseline_done);
    }
}

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
    let labels = store::load_labels(data_dir);
    let history = store::load_history(data_dir);
    spawn_analysis_worker(
        app.clone(),
        pending,
        cache_dir.to_path_buf(),
        data_dir.to_path_buf(),
        labels,
        history,
    );
}

#[derive(serde::Serialize, Clone)]
struct LibraryScanProgress {
    phase: String,
    found: usize,
    done: usize,
}

#[derive(serde::Serialize)]
struct LibraryScanResult {
    rows: Vec<TrackRow>,
    persistence_error: Option<String>,
}

struct ScannedLibrary {
    reply: LibraryScanResult,
    pending_analysis: Vec<PathBuf>,
}

#[tauri::command(async)]
fn refresh_library(app: tauri::AppHandle, kick_analysis: bool) -> Result<LibraryScanResult, String> {
    use tauri::Emitter;
    let _index_guard = INDEX_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let dirs = resolve_dirs(&app)?;
    if dirs.music_dir_needed {
        tag_service::publish(Path::new(&dirs.data_dir), Default::default());
        return Ok(LibraryScanResult { rows: Vec::new(), persistence_error: None });
    }
    let music_dir = PathBuf::from(&dirs.music_dir);
    let cache_dir = PathBuf::from(&dirs.cache_dir);
    let data_dir = PathBuf::from(&dirs.data_dir);
    let result = scan_library_under_index_lock(&music_dir, &cache_dir, &data_dir, |progress| {
        let _ = app.emit("library-scan", progress);
    })?;
    if kick_analysis {
        analyze_these(&app, result.pending_analysis, &cache_dir, &data_dir);
    }
    Ok(result.reply)
}

fn scan_library_under_index_lock(
    music_dir: &Path,
    cache_dir: &Path,
    data_dir: &Path,
    mut progress: impl FnMut(LibraryScanProgress),
) -> Result<ScannedLibrary, String> {

    let baseline_done = store::load_settings(&data_dir).arrivals_baseline_done;

    progress(LibraryScanProgress {
            phase: "walking".into(),
            found: 0,
            done: 0,
        });

    let (paths, complete) = scan_tracks(&music_dir)?;
    let overrides = store::load_overrides(&data_dir);
    let labels = store::load_labels(&data_dir);
    let history = store::load_history(&data_dir);
    let loaded_index = store::load_hash_index(&data_dir);
    let provenance = loaded_index.provenance;
    let next_added_order = store::next_added_order(&loaded_index.index);
    let mut hash_index = loaded_index.index;
    let scan_now = store::utc_rfc3339_now();
    let original_keys: std::collections::BTreeSet<String> =
        hash_index.keys().cloned().collect();
    let found = paths.len();

    progress(LibraryScanProgress {
            phase: "hashing".into(),
            found,
            done: 0,
        });

    let mut rows: Vec<TrackRow> = Vec::with_capacity(found);
    let mut seen_paths = std::collections::BTreeSet::new();
    for path in &paths {
        let path_key = path.to_string_lossy().into_owned();
        seen_paths.insert(path_key.clone());
        let prior_hash = hash_index.get(&path_key).map(|entry| entry.hash.clone());
        let (hash, tags) = match store::resolve_library_file(path, &mut hash_index) {
            Ok(resolved) => {
                let tags = CachedTags {
                    title: resolved.title,
                    artist: resolved.artist,
                };
                if hash_index
                    .get(&path_key)
                    .is_some_and(|e| e.tags_cached)
                {
                    TAG_CACHE
                        .lock()
                        .unwrap()
                        .insert(path.to_path_buf(), tags.clone());
                }
                if prior_hash
                    .as_ref()
                    .is_some_and(|prior| prior != &resolved.hash)
                {
                    if let Some(entry) = hash_index.get_mut(&path_key) {
                        entry.added_order = next_added_order;
                    }
                }
                (Some(resolved.hash), Some(tags))
            }
            Err(_) => (None, None),
        };
        rows.push(track_row(
            path,
            &cache_dir,
            &overrides,
            &labels,
            &history,
            hash.as_deref(),
            tags,
        ));
        progress(LibraryScanProgress {
                phase: "hashing".into(),
                found,
                done: rows.len(),
            });
    }

    if complete {
        hash_index.retain(|path, _| seen_paths.contains(path));
    }

    let kind = store::arrivals_kind(baseline_done, provenance);
    match kind {
        store::ArrivalsKind::Normal => {
            store::stamp_new_paths(&mut hash_index, &original_keys, &scan_now);
        }
        store::ArrivalsKind::Baseline | store::ArrivalsKind::Recovery => {
            if matches!(kind, store::ArrivalsKind::Recovery) {
                log::warn!(
                    "arrivals recovery baseline (provenance={provenance:?}); \
                     not stamping new paths"
                );
            }
            store::apply_baseline_markers(&mut hash_index, &seen_paths);
        }
    }

    let arrivals_complete = complete && rows.iter().all(|row| row.content_hash.is_some());
    let plan = store::arrivals_commit_plan(kind, arrivals_complete);
    let ordering_ready = !plan.save_index || next_added_order
        .and_then(|order| store::stamp_missing_added_order(&mut hash_index, order)).is_some();
    let mut index_saved = false;
    let commit_result = if ordering_ready { commit_arrivals_after_scan(
        &data_dir,
        &hash_index,
        plan,
        |dir, index| {
            store_cache::save_hash_index(dir, index)?;
            index_saved = true;
            Ok(())
        },
        mark_arrivals_baseline_done,
    ) } else { Err("library addition order exhausted".into()) };

    store_cache::with_index(data_dir, |index| {
        for row in &mut rows {
            row.added_order = index.get(&row.path)
                .filter(|entry| Some(&entry.hash) == row.content_hash.as_ref())
                .and_then(|entry| entry.added_order);
        }
    });

    if index_saved || !plan.save_index {
      let committed = store_cache::with_index(&data_dir, |index| {
        rows.iter().map(|row| {
            let entry = index.get(&row.path).filter(|entry| Some(&entry.hash) == row.content_hash.as_ref()).cloned();
            (row.path.clone(), entry)
        }).collect()
      });
      tag_service::publish(&data_dir, committed);
    }
    let persistence_error = commit_result.err();
    if let Some(error) = &persistence_error { log::warn!("library persistence: {error}"); }
    let pending_analysis = paths.into_iter().zip(&rows)
        .filter(|(_, row)| !row.analyzed).map(|(path, _)| path).collect();
    Ok(ScannedLibrary { reply: LibraryScanResult { rows, persistence_error }, pending_analysis })
}

#[tauri::command(async)]
fn list_track_tags(app: tauri::AppHandle) -> Result<tag_service::Snapshot, tag_service::CommandError> {
    let dirs = resolve_dirs(&app).map_err(|_| tag_service::CommandError { code: "store_read_only", message: "data directory unavailable".into() })?;
    Ok(tag_service::list(Path::new(&dirs.data_dir)))
}

#[tauri::command(async)]
fn playback_recovery_status(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<playback_state::PlaybackRecoveryStatus, playlist_service::CommandError> {
    let dirs = resolve_dirs(&app).map_err(|message| playlist_service::CommandError {
        code: "store_read_only".into(), message,
    })?;
    let service = playlist_service::get(
        Path::new(&dirs.data_dir), Path::new(&dirs.cache_dir), &state.queue,
    );
    let owner = service.lock().unwrap_or_else(|error| error.into_inner());
    Ok(owner.recovery_status())
}

#[derive(serde::Deserialize)]
struct PlaybackRecoveryRequest {
    token: u64,
    choice: playback_state::LegacyNormalChoice,
}

#[tauri::command(async)]
fn resolve_playback_recovery(
    request: PlaybackRecoveryRequest,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<playback_state::PlaybackRecoveryStatus, playlist_service::CommandError> {
    let started = state.started.lock().unwrap_or_else(|error| error.into_inner());
    if *started {
        return Err(playlist_service::CommandError { code: "busy".into(), message: "playback has started".into() });
    }
    let _prestart = playlist_service::lock_prestart_queue();
    let dirs = resolve_dirs(&app).map_err(|message| playlist_service::CommandError {
        code: "store_read_only".into(), message,
    })?;
    let service = playlist_service::get(
        Path::new(&dirs.data_dir), Path::new(&dirs.cache_dir), &state.queue,
    );
    let mut owner = service.lock().unwrap_or_else(|error| error.into_inner());
    let _saving = SAVE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let restored = owner.resolve_legacy_normal_conflict(request.token, request.choice)?;
    *SESSION.lock().unwrap_or_else(|error| error.into_inner()) = store::Session::new();
    ALLOW_NON_FUNKOT.store(restored.settings.allow_non_funkot, Ordering::Relaxed);
    *LOCALE_TAG.lock().unwrap_or_else(|error| error.into_inner()) = restored.settings.locale.unwrap_or_default();
    Ok(owner.recovery_status())
}

#[tauri::command(async)]
fn playlist_catalog(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<playlist_service::CatalogView, playlist_service::CommandError> {
    let dirs = resolve_dirs(&app).map_err(|message| playlist_service::CommandError { code: "store_read_only".into(), message })?;
    let service = playlist_service::get(Path::new(&dirs.data_dir), Path::new(&dirs.cache_dir), &state.queue);
    let owner = service.lock().unwrap_or_else(|e|e.into_inner());
    Ok(owner.catalog_view())
}

#[tauri::command(async)]
fn playlist_entries(id: String, app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<playlist_service::Details, playlist_service::CommandError> {
    let dirs = resolve_dirs(&app).map_err(|message| playlist_service::CommandError { code: "store_read_only".into(), message })?;
    let service = playlist_service::get(Path::new(&dirs.data_dir), Path::new(&dirs.cache_dir), &state.queue);
    let mut owner = service.lock().unwrap_or_else(|e|e.into_inner());
    owner.reconcile();
    owner.inspect_entries(&id)
}

#[tauri::command(async)]
fn playlist_command(request: playlist_service::Request, app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<playlist_service::CommandResult, playlist_service::CommandError> {
    let dirs = resolve_dirs(&app).map_err(|message| playlist_service::CommandError { code: "store_read_only".into(), message })?;
    let service = playlist_service::get(Path::new(&dirs.data_dir), Path::new(&dirs.cache_dir), &state.queue);
    playlist_service::command(&service, request)
}

#[tauri::command(async)]
fn update_track_tags(app: tauri::AppHandle, request: tag_service::UpdateRequest) -> Result<tag_service::UpdateResult, tag_service::CommandError> {
    let dirs = resolve_dirs(&app).map_err(|_| tag_service::CommandError { code: "store_read_only", message: "data directory unavailable".into() })?;
    tag_service::update(Path::new(&dirs.data_dir), request)
}

fn commit_arrivals_after_scan(
    data_dir: &Path,
    index: &store::HashIndex,
    plan: store::ArrivalsCommitPlan,
    save_index: impl FnOnce(&Path, &store::HashIndex) -> std::io::Result<()>,
    mark_baseline: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    if plan.save_index {
        save_index(data_dir, index)
            .map_err(|e| format!("cannot save hash-index.json: {e}"))?;
    }
    if plan.mark_baseline_done
        && playback_state::PlaybackStore::open(data_dir).load_state()
            != playlists::LoadState::LegacyNormalConflict
    {
        mark_baseline(data_dir)?;
    }
    Ok(())
}

fn mark_arrivals_baseline_done(data_dir: &Path) -> Result<(), String> {
    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut settings = store::load_settings(data_dir);
    settings.arrivals_baseline_done = true;
    store::save_settings(data_dir, &settings)
        .map_err(|e| format!("cannot save settings: {e}"))
}

fn apply_override(
    cache_dir: &std::path::Path,
    hash: &str,
    o: &store::BarOverride,
) -> Result<(), String> {
    if o.intro_bars.is_some() || o.outro_structure_bars.is_some() {
        funkot_core::cache::edit_bars(
            cache_dir,
            hash,
            o.intro_bars,
            o.outro_structure_bars,
            true,
        )
        .map_err(|e| format!("cannot set manual bars: {e}"))?;
    }
    Ok(())
}

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
    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    set_bars_impl(
        &cache_dir,
        &data_dir,
        Path::new(&path),
        intro_bars,
        outro_structure_bars,
        mark_manual.unwrap_or(true),
    )
}

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
    funkot_core::cache::edit_bars(
        cache_dir,
        &hash,
        edit.intro_bars,
        edit.outro_structure_bars,
        mark_manual,
    )
    .map_err(|e| format!("cannot edit cached bars: {e}"))?;

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
    if let Err(e) = store::save_overrides(data_dir, &overrides) {
        log::warn!("cannot persist manual bars: {e}");
    }

    let labels = store::load_labels(data_dir);
    let history = store::load_history(data_dir);
    Ok(track_row(
        track,
        cache_dir,
        &overrides,
        &labels,
        &history,
        Some(&hash),
        None,
    ))
}

#[tauri::command(async)]
fn set_label(
    app: tauri::AppHandle,
    path: String,
    verdict: Option<bool>,
) -> Result<TrackRow, String> {
    let dirs = resolve_dirs(&app)?;
    let cache_dir = PathBuf::from(&dirs.cache_dir);
    let data_dir = PathBuf::from(&dirs.data_dir);
    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    set_label_impl(&cache_dir, &data_dir, Path::new(&path), verdict)
}

fn set_label_impl(
    cache_dir: &std::path::Path,
    data_dir: &std::path::Path,
    track: &std::path::Path,
    verdict: Option<bool>,
) -> Result<TrackRow, String> {
    let hash = store_cache::content_hash(data_dir, track)
        .map_err(|e| format!("cannot hash {}: {e}", track.display()))?;

    let mut labels = store::load_labels(data_dir);
    match verdict {
        Some(v) => {
            labels.insert(
                hash.clone(),
                store::TrackLabel {
                    verdict: v,
                    labeled_at_ms: now_ms(),
                },
            );
        }
        None => {
            labels.remove(&hash);
        }
    }
    if let Err(e) = store::save_labels(data_dir, &labels) {
        log::warn!("cannot persist labels: {e}");
    }

    let mut overrides = store::load_overrides(data_dir);
    match verdict {
        Some(v) => {
            overrides.entry(hash.clone()).or_default().funkot = Some(v);
        }
        None => {
            if let Some(entry) = overrides.get_mut(&hash) {
                entry.funkot = None;
                if entry.intro_bars.is_none()
                    && entry.outro_structure_bars.is_none()
                    && entry.funkot.is_none()
                {
                    overrides.remove(&hash);
                }
            }
        }
    }
    if let Err(e) = store::save_overrides(data_dir, &overrides) {
        log::warn!("cannot persist manual bars: {e}");
    }

    let history = store::load_history(data_dir);
    Ok(track_row(
        track,
        cache_dir,
        &overrides,
        &labels,
        &history,
        Some(&hash),
        None,
    ))
}

#[tauri::command(async)]
fn set_folder_label(
    app: tauri::AppHandle,
    dir: String,
    verdict: bool,
) -> Result<usize, String> {
    let dirs = resolve_dirs(&app)?;
    let data_dir = PathBuf::from(&dirs.data_dir);
    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (count, undo) = set_folder_label_impl(&data_dir, Path::new(&dir), verdict)?;
    *LAST_FOLDER_LABEL_UNDO
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(undo);
    Ok(count)
}

fn set_folder_label_impl(
    data_dir: &std::path::Path,
    dir: &std::path::Path,
    verdict: bool,
) -> Result<(usize, Vec<FolderLabelUndo>), String> {
    let (paths, _complete) = scan_tracks(dir)?;
    let mut index = store::load_hash_index(data_dir).index;
    let mut labels = store::load_labels(data_dir);
    let mut overrides = store::load_overrides(data_dir);
    let labeled_at_ms = now_ms();
    let mut count = 0usize;
    let mut undo: Vec<FolderLabelUndo> = Vec::new();
    let mut snapshotted = std::collections::HashSet::new();

    for path in &paths {
        let Ok(hash) = store::resolve_content_hash(path, &mut index) else {
            continue;
        };
        if snapshotted.insert(hash.clone()) {
            undo.push(FolderLabelUndo {
                hash: hash.clone(),
                label: labels.get(&hash).cloned(),
                funkot: overrides.get(&hash).and_then(|o| o.funkot),
            });
        }
        labels.insert(
            hash.clone(),
            store::TrackLabel {
                verdict,
                labeled_at_ms,
            },
        );
        overrides.entry(hash).or_default().funkot = Some(verdict);
        count += 1;
    }

    if let Err(e) = store::save_labels(data_dir, &labels) {
        log::warn!("cannot persist labels: {e}");
    }
    if let Err(e) = store::save_overrides(data_dir, &overrides) {
        log::warn!("cannot persist manual bars: {e}");
    }
    Ok((count, undo))
}

#[tauri::command(async)]
fn undo_last_folder_label(app: tauri::AppHandle) -> Result<usize, String> {
    let dirs = resolve_dirs(&app)?;
    let data_dir = PathBuf::from(&dirs.data_dir);

    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let entries = {
        let slot = LAST_FOLDER_LABEL_UNDO
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        slot.clone().ok_or_else(|| "nothing to undo".to_string())?
    };

    let restored = undo_folder_label_impl(&data_dir, &entries)?;
    *LAST_FOLDER_LABEL_UNDO
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    Ok(restored)
}

fn undo_folder_label_impl(
    data_dir: &std::path::Path,
    entries: &[FolderLabelUndo],
) -> Result<usize, String> {
    let mut labels = store::load_labels(data_dir);
    let mut overrides = store::load_overrides(data_dir);

    for entry in entries {
        match &entry.label {
            Some(label) => {
                labels.insert(entry.hash.clone(), label.clone());
            }
            None => {
                labels.remove(&entry.hash);
            }
        }
        match entry.funkot {
            Some(v) => {
                overrides.entry(entry.hash.clone()).or_default().funkot = Some(v);
            }
            None => {
                if let Some(o) = overrides.get_mut(&entry.hash) {
                    o.funkot = None;
                    if o.intro_bars.is_none() && o.outro_structure_bars.is_none() {
                        overrides.remove(&entry.hash);
                    }
                }
            }
        }
    }

    store::save_labels(data_dir, &labels).map_err(|e| format!("cannot persist labels: {e}"))?;
    store::save_overrides(data_dir, &overrides)
        .map_err(|e| format!("cannot persist manual bars: {e}"))?;
    Ok(entries.len())
}

#[tauri::command(async)]
fn label_stats(app: tauri::AppHandle) -> Result<LabelStats, String> {
    let dirs = resolve_dirs(&app)?;
    let data_dir = PathBuf::from(&dirs.data_dir);
    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let music_dir = if dirs.music_dir_needed {
        None
    } else {
        Some(Path::new(dirs.music_dir.as_str()))
    };
    Ok(label_stats_impl(&data_dir, music_dir))
}

fn label_stats_impl(data_dir: &std::path::Path, music_dir: Option<&Path>) -> LabelStats {
    let labels = store::load_labels(data_dir);
    let labeled = labels.len();
    let funkot = labels.values().filter(|l| l.verdict).count();
    let not_funkot = labels.values().filter(|l| !l.verdict).count();
    let total = match music_dir {
        Some(dir) => scan_tracks(dir).map(|(p, _)| p.len()).unwrap_or(0),
        None => 0,
    };
    LabelStats {
        labeled,
        total,
        funkot,
        not_funkot,
    }
}

#[tauri::command(async)]
fn clear_labels(app: tauri::AppHandle) -> Result<(), String> {
    let dirs = resolve_dirs(&app)?;
    let data_dir = PathBuf::from(&dirs.data_dir);
    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    clear_labels_impl(&data_dir)?;
    *LAST_FOLDER_LABEL_UNDO
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    Ok(())
}

fn clear_labels_impl(data_dir: &std::path::Path) -> Result<(), String> {
    store::save_labels(data_dir, &store::Labels::new())
        .map_err(|e| format!("cannot persist labels: {e}"))?;
    let mut overrides = store::load_overrides(data_dir);
    for entry in overrides.values_mut() {
        entry.funkot = None;
    }
    overrides.retain(|_, entry| {
        entry.intro_bars.is_some() || entry.outro_structure_bars.is_some()
    });
    store::save_overrides(data_dir, &overrides)
        .map_err(|e| format!("cannot persist manual bars: {e}"))?;
    Ok(())
}

#[tauri::command(async)]
fn clear_play_log(app: tauri::AppHandle) -> Result<(), String> {
    let dirs = resolve_dirs(&app)?;
    let data_dir = PathBuf::from(&dirs.data_dir);
    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    clear_play_log_impl(&data_dir)?;
    HISTORY_REVISION.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

fn clear_play_log_impl(data_dir: &std::path::Path) -> Result<(), String> {
    store::clear_play_log(data_dir).map_err(|e| format!("cannot clear play log: {e}"))?;
    Ok(())
}

#[tauri::command(async)]
fn clear_play_counts(app: tauri::AppHandle) -> Result<(), String> {
    let dirs = resolve_dirs(&app)?;
    let data_dir = PathBuf::from(&dirs.data_dir);
    let _index = INDEX_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    clear_play_counts_impl(&data_dir)?;
    Ok(())
}

fn clear_play_counts_impl(data_dir: &std::path::Path) -> Result<(), String> {
    clear_play_counts_with_index_save(
        data_dir,
        store_cache::save_hash_index,
        &HISTORY_REVISION,
    )
}

fn clear_play_counts_with_index_save(
    data_dir: &std::path::Path,
    save_index: impl FnOnce(&std::path::Path, &store::HashIndex) -> std::io::Result<()>,
    revision: &AtomicU64,
) -> Result<(), String> {
    let history = store::load_history(data_dir);
    let mut index = store::load_hash_index(data_dir).index;
    if store::fold_played_arrivals(&mut index, &history) {
        save_index(data_dir, &index).map_err(|e| format!("cannot save hash-index: {e}"))?;
    }
    store::save_history(data_dir, &store::History::new())
        .map_err(|e| format!("cannot persist history: {e}"))?;
    revision.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

#[tauri::command(async)]
fn remove_play_log_entry(app: tauri::AppHandle, at_ms: u64) -> Result<(), String> {
    let dirs = resolve_dirs(&app)?;
    let data_dir = PathBuf::from(&dirs.data_dir);
    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    remove_play_log_entry_impl(&data_dir, at_ms)?;
    HISTORY_REVISION.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

fn remove_play_log_entry_impl(data_dir: &std::path::Path, at_ms: u64) -> Result<(), String> {
    store::remove_play_log_entry(data_dir, at_ms).map_err(|e| format!("cannot remove play log entry: {e}"))?;
    Ok(())
}

#[tauri::command(async)]
fn clear_track_play_count(app: tauri::AppHandle, hash: String) -> Result<(), String> {
    let dirs = resolve_dirs(&app)?;
    let data_dir = PathBuf::from(&dirs.data_dir);
    let _index = INDEX_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    clear_track_play_count_impl(&data_dir, &hash)?;
    Ok(())
}

fn clear_track_play_count_impl(data_dir: &std::path::Path, hash: &str) -> Result<(), String> {
    clear_track_play_count_with_index_save(
        data_dir,
        hash,
        store_cache::save_hash_index,
        &HISTORY_REVISION,
    )
}

fn clear_track_play_count_with_index_save(
    data_dir: &std::path::Path,
    hash: &str,
    save_index: impl FnOnce(&std::path::Path, &store::HashIndex) -> std::io::Result<()>,
    revision: &AtomicU64,
) -> Result<(), String> {
    let mut history = store::load_history(data_dir);
    if history.remove(hash).is_some() {
        let mut index = store::load_hash_index(data_dir).index;
        if store::fold_played_arrival_for_hash(&mut index, hash) {
            save_index(data_dir, &index).map_err(|e| format!("cannot save hash-index: {e}"))?;
        }
        store::save_history(data_dir, &history)
            .map_err(|e| format!("cannot persist history: {e}"))?;
        revision.fetch_add(1, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command(async)]
fn list_play_history(app: tauri::AppHandle, limit: usize) -> Result<store::PlayHistory, String> {
    let dirs = resolve_dirs(&app)?;
    let data_dir = Path::new(&dirs.data_dir);
    let (log, history, index) = {
        let _saving = SAVE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (
            store::load_play_log(data_dir),
            store::load_history(data_dir),
            store::load_hash_index(data_dir).index,
        )
    };
    let limit = limit.min(store::PLAY_LOG_MAX_ENTRIES);
    Ok(store::build_play_history(&log, &history, &index, limit))
}

#[tauri::command(async)]
fn list_new_arrivals(app: tauri::AppHandle) -> Result<Vec<store::NewArrival>, String> {
    let dirs = resolve_dirs(&app)?;
    let data_dir = Path::new(&dirs.data_dir);
    let _index = INDEX_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    list_new_arrivals_impl(data_dir)
}

fn list_new_arrivals_impl(data_dir: &std::path::Path) -> Result<Vec<store::NewArrival>, String> {
    let settings = store::load_settings(data_dir);
    let loaded = store::load_hash_index(data_dir);
    if !settings.arrivals_baseline_done
        || loaded.provenance != store::HashIndexProvenance::Loaded
    {
        return Err("arrivals_index_unavailable".to_string());
    }
    let mut index = loaded.index;
    let history = store::load_history(data_dir);
    if store::fold_played_arrivals(&mut index, &history) {
        store_cache::save_hash_index(data_dir, &index)
            .map_err(|e| format!("cannot save hash-index: {e}"))?;
    }
    Ok(store::extract_new_arrivals(
        &index,
        &history,
        loaded.provenance,
        settings.arrivals_baseline_done,
    ))
}

#[cfg(test)]
fn queue_new_arrivals_with(
    data_dir: &std::path::Path,
    cache_dir: &std::path::Path,
    queue: &SharedQueue,
    allow_non_funkot: bool,
    in_flight: &[QueueItem],
) -> Result<u32, String> {
    let _index = INDEX_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    queue_new_arrivals_under_locks(data_dir, cache_dir, queue, allow_non_funkot, in_flight)
}

fn queue_new_arrivals_under_locks(
    data_dir: &std::path::Path,
    cache_dir: &std::path::Path,
    queue: &SharedQueue,
    allow_non_funkot: bool,
    in_flight: &[QueueItem],
) -> Result<u32, String> {
    let settings = store::load_settings(data_dir);
    let loaded = store::load_hash_index(data_dir);
    let mut index = loaded.index;
    let history = store::load_history(data_dir);
    if store::fold_played_arrivals(&mut index, &history) {
        store_cache::save_hash_index(data_dir, &index)
            .map_err(|e| format!("cannot save hash-index: {e}"))?;
    }
    let arrivals = store::extract_new_arrivals(
        &index,
        &history,
        loaded.provenance,
        settings.arrivals_baseline_done,
    );
    let candidates: Vec<PathBuf> = arrivals
        .into_iter()
        .map(|a| PathBuf::from(a.path))
        .collect();
    let candidates = if allow_non_funkot {
        candidates
    } else {
        let overrides = store::load_overrides(data_dir);
        candidates
            .into_iter()
            .filter(|p| !gated_non_funkot_from_index(p, cache_dir, &index, &overrides))
            .collect()
    };

    let now_playing = {
        let now = NOW
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        now.now.clone()
    };

    let added = queue::prepend_pending_filtered(
        queue,
        &candidates,
        now_playing.as_deref(),
        in_flight,
    );
    Ok(added as u32)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
struct EnqueueManyResult {
    added: u32,
    rejected: u32,
    skipped: u32,
}

#[cfg(test)]
fn enqueue_many_with(
    data_dir: &std::path::Path,
    cache_dir: &std::path::Path,
    queue: &SharedQueue,
    allow_non_funkot: bool,
    in_flight: &[QueueItem],
    paths: &[String],
) -> EnqueueManyResult {
    let _index = INDEX_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    enqueue_many_under_locks(
        data_dir,
        cache_dir,
        queue,
        allow_non_funkot,
        in_flight,
        paths,
    )
}

fn enqueue_many_under_locks(
    data_dir: &std::path::Path,
    cache_dir: &std::path::Path,
    queue: &SharedQueue,
    allow_non_funkot: bool,
    in_flight: &[QueueItem],
    paths: &[String],
) -> EnqueueManyResult {
    let requested = paths.len();
    let candidates: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let candidates = if allow_non_funkot {
        candidates
    } else {
        let index = store::load_hash_index(data_dir).index;
        let overrides = store::load_overrides(data_dir);
        candidates
            .into_iter()
            .filter(|p| !gated_non_funkot_from_index(p, cache_dir, &index, &overrides))
            .collect()
    };
    let rejected = requested - candidates.len();

    let now_playing = {
        let now = NOW
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        now.now.clone()
    };

    let added = queue::prepend_pending_filtered(
        queue,
        &candidates,
        now_playing.as_deref(),
        in_flight,
    );
    EnqueueManyResult {
        added: added as u32,
        rejected: rejected as u32,
        skipped: (candidates.len() - added) as u32,
    }
}

#[derive(serde::Serialize, Clone)]
struct AnalysisProgress {
    done: usize,
    total: usize,
    name: String,
    row: TrackRow,
}

fn reapply_overrides(
    path: &std::path::Path,
    cache_dir: &std::path::Path,
    data_dir: &std::path::Path,
) {
    let _saving = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let overrides = store::load_overrides(data_dir);
    if overrides.is_empty() {
        return;
    }
    let Ok(hash) = funkot_core::cache::content_hash(path) else {
        return;
    };
    let Some(entry) = overrides.get(&hash) else {
        return;
    };
    if let Err(e) = apply_override(cache_dir, &hash, entry) {
        log::warn!("cannot re-apply manual bars for {}: {e}", path.display());
    }
}

const STARTUP_WAIT: std::time::Duration = std::time::Duration::from_secs(60);

fn wait_out_startup() {
    let until = std::time::Instant::now() + STARTUP_WAIT;
    while std::time::Instant::now() < until {
        let phase = get_phase();
        let manual_plan_pending = manual_next_owns_analysis(
            MANUAL_NEXT_PENDING.load(Ordering::Acquire),
            MANUAL_NEXT_IN_FLIGHT.load(Ordering::Acquire));
        let hold = matches!(phase, Phase::Starting | Phase::Stalled)
            || (phase == Phase::Playing && YIELD_FOR_LOADER.load(Ordering::Relaxed))
            || (matches!(phase, Phase::Playing | Phase::Paused) && manual_plan_pending);
        if !hold {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

fn spawn_analysis_worker(
    app: tauri::AppHandle,
    paths: Vec<PathBuf>,
    cache_dir: PathBuf,
    data_dir: PathBuf,
    labels: store::Labels,
    history: store::History,
) {
    if ANALYZING.swap(true, Ordering::SeqCst) {
        return;
    }

    std::thread::Builder::new()
        .name("funkot-analysis".into())
        .spawn(move || {
            use tauri::Emitter;

            let total = paths.len();
            for (i, path) in paths.iter().enumerate() {
                wait_out_startup();

                let name = file_name_str(path);

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
                            row: {
                                let _saving = SAVE_LOCK
                                    .lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                                let overrides = store::load_overrides(&data_dir);
                                track_row(
                                    path,
                                    &cache_dir,
                                    &overrides,
                                    &labels,
                                    &history,
                                    hash.as_deref(),
                                    None,
                                )
                            },
                        },
                    );
                    continue;
                }

                loop {
                    LIBRARY_ANALYSIS_BUSY.store(true, Ordering::Release);
                    let manual_plan = manual_next_owns_analysis(
                        MANUAL_NEXT_PENDING.load(Ordering::Acquire),
                        MANUAL_NEXT_IN_FLIGHT.load(Ordering::Acquire));
                    if !manual_plan { break; }
                    LIBRARY_ANALYSIS_BUSY.store(false, Ordering::Release);
                    wait_out_startup();
                }
                match funkot_core::decode::decode_file(path) {
                    Ok(buffer) => {
                        if let Err(e) = funkot_core::cache::fill_missing(path, &cache_dir, &buffer) {
                            log::warn!("analysis failed for {}: {e}", path.display());
                        } else {
                            reapply_overrides(path, &cache_dir, &data_dir);
                        }
                    }
                    Err(e) => {
                        log::warn!("decode failed for {}: {e}", path.display());
                    }
                }

                LIBRARY_ANALYSIS_BUSY.store(false, Ordering::Release);

                let row = {
                    let _saving = SAVE_LOCK
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    let overrides = store::load_overrides(&data_dir);
                    track_row(
                        path,
                        &cache_dir,
                        &overrides,
                        &labels,
                        &history,
                        hash.as_deref(),
                        None,
                    )
                };
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
    SERVICE_RUNNING.store(running, Ordering::Relaxed);
    service_call(if running { "startFrom" } else { "stopFrom" });
}

fn service_sync_state() {
    if SERVICE_RUNNING.load(Ordering::Relaxed) {
        service_call("syncFrom");
    }
}

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
        let model = String::from(s.mutf8_chars(env)?);
        Ok(model)
    })
    .unwrap_or_else(|_| "android".into())
}

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
            let path = String::from(s.mutf8_chars(env)?);
            Ok(path)
        })
        .map_err(|e: jni::errors::Error| format!("cannot resolve getCacheDir: {e}"))?;
    Ok(PathBuf::from(path))
}

#[cfg(target_os = "android")]
fn feedback_share(absolute_path: &str, title: &str) -> Result<(), String> {
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
        let title = env.new_string(title)?;
        env.call_static_method(
            &class,
            JNIString::new("shareFrom"),
            jni::jni_sig!("(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)V"),
            &[(&context).into(), (&path).into(), (&title).into()],
        )?;
        Ok(())
    });
    result.map_err(|e| format!("FeedbackShare.shareFrom: {e}"))
}

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

#[cfg(target_os = "android")]
static LAST_FLAG_OK: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_jp_hatsuboshi_funkotplayer_PlaybackService_onNativeControl(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    action: i32,
) -> jni::sys::jint {
    if action == 3 {
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
        0 | 4 | 5 => {
            let audition = try_audition_lock();
            if audition.is_ok() && ensure_pause_allowed(
                AUDITIONING.load(Ordering::Relaxed),
                AUDITION_PREPARING.load(Ordering::Relaxed),
            )
            .is_ok()
            {
                match action {
                    0 => { flip_paused(&playback.paused); }
                    4 => { set_paused(&playback.paused, false); }
                    5 => { set_paused(&playback.paused, true); }
                    _ => unreachable!(),
                }
            }
        }
        1 => {
            let _ = request_skip_next();
        }
        _ => {}
    }
    pack_native_control_state(playback.paused.load(Ordering::Relaxed), get_phase())
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_jp_hatsuboshi_funkotplayer_PlaybackService_playbackAlive(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
) -> jni::sys::jboolean {
    playback_session_alive(PLAYBACK.get().is_some(), get_phase()) as jni::sys::jboolean
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_jp_hatsuboshi_funkotplayer_PlaybackService_lastFlagOk(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
) -> jni::sys::jboolean {
    LAST_FLAG_OK.load(Ordering::Relaxed) as jni::sys::jboolean
}

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

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_jp_hatsuboshi_funkotplayer_PlaybackService_currentLocaleTag<'local>(
    mut env: jni::EnvUnowned<'local>,
    _class: jni::objects::JClass<'local>,
) -> jni::sys::jstring {
    let tag = notification_locale_tag();
    env.with_env(|env| {
        Ok::<_, jni::errors::Error>(env.new_string(&tag)?.into_raw())
    })
    .resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

#[cfg(not(target_os = "android"))]
fn restore_desktop_window(app: &tauri::AppHandle, data: &Path) {
    use tauri::{LogicalSize, Manager, Size};

    let Some(frame) = store::load_window_frame(data) else {
        return;
    };
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let frame = match w.current_monitor() {
        Ok(Some(m)) => {
            let scale = m.scale_factor();
            let phys = m.size();
            let max_w = phys.width as f64 / scale;
            let max_h = phys.height as f64 / scale;
            frame.clamp_to(max_w, max_h)
        }
        _ => frame,
    };
    if let Err(e) = w.set_size(Size::Logical(LogicalSize {
        width: frame.width,
        height: frame.height,
    })) {
        log::warn!("restore window size: {e}");
        return;
    }
    if frame.maximized {
        if let Err(e) = w.maximize() {
            log::warn!("restore maximized: {e}");
        }
    }
}

#[cfg(not(target_os = "android"))]
fn persist_desktop_window(app: &tauri::AppHandle) {
    use tauri::Manager;

    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let Ok(physical) = w.inner_size() else {
        return;
    };
    let Ok(scale) = w.scale_factor() else {
        return;
    };
    let logical = physical.to_logical::<f64>(scale);
    let maximized = w.is_maximized().unwrap_or(false);
    let Some(frame) = store::WindowFrame::new(logical.width, logical.height, maximized) else {
        return;
    };
    let Some(dir) = DATA_DIR.get() else {
        log::warn!("persist window: DATA_DIR not resolved yet");
        return;
    };
    if let Err(e) = store::save_window_frame(dir, &frame) {
        log::warn!("save_window_frame({}): {e}", dir.display());
    }
}

#[cfg(not(target_os = "android"))]
fn on_desktop_run_event(app: &tauri::AppHandle, event: &tauri::RunEvent) {
    match event {
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { .. },
            ..
        } if label == "main" => persist_desktop_window(app),
        tauri::RunEvent::ExitRequested { .. } => persist_desktop_window(app),
        _ => {}
    }
}

#[cfg(test)]
mod desktop_window_default_tests {
    #[test]
    fn default_width_fits_two_browse_panes() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let width = conf["app"]["windows"][0]["width"]
            .as_f64()
            .expect("app.windows[0].width");
        const ROOT_PX: f64 = 16.0;
        const BROWSE_TWO_PANE_MIN_REM: f64 = 48.0;
        const BODY_PAD_X_REM: f64 = 1.0;
        let inner_min = (BROWSE_TWO_PANE_MIN_REM + 2.0 * BODY_PAD_X_REM) * ROOT_PX;
        assert!(
            width >= inner_min,
            "default width {width} is below the two-pane floor {inner_min}"
        );
    }
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
    builder
        .setup(|app| {
            #[cfg(all(target_os = "windows", feature = "verified-capture"))]
            let capture_control = verified_capture_control::prepare(app.handle())
                .map_err(std::io::Error::other)?;
            #[cfg(target_os = "windows")]
            current_track_http::start(current_track_http_snapshot);
            use tauri::Manager;
            let handle = app.handle().clone();
            #[cfg(not(target_os = "android"))]
            match handle.path().app_data_dir() {
                Ok(data) => {
                    restore_desktop_window(&handle, &data);
                    let cache = data.join("funkot-cache");
                    preload_queue_tab(&handle, data, &cache);
                }
                Err(e) => {
                    log::warn!("setup: cannot resolve dirs, queue preload skipped: {e}");
                }
            }
            #[cfg(target_os = "android")]
            match resolve_dirs(&handle) {
                Ok(dirs) => {
                    let data = PathBuf::from(dirs.data_dir);
                    let cache = PathBuf::from(dirs.cache_dir);
                    preload_queue_tab(&handle, data, &cache);
                }
                Err(e) => {
                    log::warn!("setup: cannot resolve dirs, queue preload skipped: {e}");
                }
            }
            // Linux GUI debug: open the WebKit inspector with the window so a
            // render throw is visible. Svelte 5 does not catch throws during
            // an effect flush; production minifies the message to a URL.
            #[cfg(all(debug_assertions, not(target_os = "android")))]
            if let Some(w) = app.get_webview_window("main") {
                w.open_devtools();
            }
            #[cfg(all(target_os = "windows", feature = "verified-capture"))]
            if let Some(control) = capture_control {
                verified_capture_control::start(handle, control).map_err(std::io::Error::other)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_dirs,
            open_music_dir,
            set_music_dir,
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
            playback_recovery_status,
            resolve_playback_recovery,
            list_track_tags,
            playlist_catalog,
            playlist_entries,
            playlist_command,
            update_track_tags,
            set_bars,
            set_label,
            set_folder_label,
            undo_last_folder_label,
            label_stats,
            clear_labels,
            clear_play_log,
            clear_play_counts,
            clear_track_play_count,
            remove_play_log_entry,
            list_new_arrivals,
            list_play_history,
            queue_state,
            get_allow_non_funkot,
            set_allow_non_funkot,
            get_labeling_mode,
            set_labeling_mode,
            get_locale,
            set_locale,
            share_feedback,
            take_pending_import
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            #[cfg(not(target_os = "android"))]
            on_desktop_run_event(app, &event);
            #[cfg(target_os = "android")]
            {
                let _ = app;
                if let tauri::RunEvent::Exit = event {
                    // tao otherwise calls std::process::exit, running libc's
                    // global finalizers while Android's WebView/render threads
                    // are still alive. On Pixel this crashes in graphics
                    // teardown (__cxa_finalize -> WebViewFunctor -> Vulkan).
                    // Exit is the committed decision, after ExitRequested;
                    // Home/Back only background the task and never reach it.
                    // End all threads without running those finalizers, so
                    // audio stops and the next launch gets a fresh runtime.
                    // State is saved when changed, not by exit finalizers.
                    // SAFETY: _exit has no preconditions and never returns.
                    unsafe { libc::_exit(0) }
                }
            }
        });
}
