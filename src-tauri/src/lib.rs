//! funkot-player: drives funkot-core's auto-DJ engine from a Tauri app.
//!
//! Still minimal: no library UI. The playback queue (`queue.rs`) is wired to
//! the engine, and its contents survive a restart via `store.rs`.

mod queue;
mod store;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::{Arc, Mutex, OnceLock};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use funkot_core::engine::{Engine, NavAction};
use funkot_core::EngineOptions;

use queue::{DrainPolicy, HostSource, SharedQueue};

/// Global handle to the running engine's playback controls.
///
/// Notification-button JNI callbacks (`onNativeControl`) do not go through
/// Tauri, so they cannot reach a `tauri::State`; this is set once, from the
/// audio thread, before the `Engine` moves into the cpal callback closure.
struct Playback {
    paused: Arc<AtomicBool>,
    nav_tx: SyncSender<NavAction>,
}

static PLAYBACK: OnceLock<Playback> = OnceLock::new();

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
    })
}

/// Desktop: everything under the per-app data directory Tauri resolves for us.
#[cfg(not(target_os = "android"))]
fn platform_dirs(app: &tauri::AppHandle) -> Result<AppDirs, String> {
    use tauri::Manager;

    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    let music = base.join("Music");
    let cache = base.join("funkot-cache");
    ensure_dirs(&music, &cache, &base)?;
    Ok(AppDirs {
        music_dir: music.to_string_lossy().into_owned(),
        cache_dir: cache.to_string_lossy().into_owned(),
        data_dir: base.to_string_lossy().into_owned(),
    })
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

/// Where the audio thread reports back to the UI. `cpal::Stream` is not `Send`
/// on every platform, so it never leaves the thread that created it.
struct AppState {
    log_rx: Mutex<Option<Receiver<String>>>,
    lines: Mutex<Vec<String>>,
    started: Mutex<bool>,
    queue: SharedQueue,
    /// Serialises writes of `queue.json`. The queue-mutating commands run on
    /// Tauri's blocking threadpool, so two of them really do overlap — tapping
    /// ✕ on one row and ↑ on another in quick succession is enough. Each takes
    /// its snapshot *inside* this lock, so the last write is always the latest
    /// state; without it the two snapshots can reach `fs::write` in the
    /// opposite order and leave the file a queue behind, or interleave inside
    /// the truncate-then-write and leave it torn.
    save_lock: Mutex<()>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            log_rx: Mutex::new(None),
            lines: Mutex::new(Vec::new()),
            started: Mutex::new(false),
            queue: queue::new_shared_queue(),
            save_lock: Mutex::new(()),
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
        ] {
            assert!(Phase::from_u8(p as u8) == p, "{} did not round-trip", p.as_str());
        }
    }
}

fn audio_thread(
    paths: Vec<PathBuf>,
    cache_dir: PathBuf,
    data_dir: PathBuf,
    log: Sender<String>,
    queue: SharedQueue,
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

    let mut options = EngineOptions::default();
    options.output_sample_rate = supported.sample_rate();
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
    let queue_dir = data_dir;
    let source = HostSource::new(queue, DrainPolicy::ContinueFolder { tracks: paths, pos: 0 })
        .on_pending_consumed(Box::new(move |pending| {
            let pending: VecDeque<PathBuf> = pending.iter().cloned().collect();
            if let Err(e) = store::save_queue(&queue_dir, &pending) {
                log::warn!("save_queue({}): {e}", queue_dir.display());
            }
        }))
        .on_reserved(Box::new(move |path| {
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("?")
                .to_string();
            let analysis = if analyzed_cache_entry(path, &cache_dir_for_log).is_some() {
                "cached"
            } else {
                "missing"
            };
            log::info!("loader: preparing {name} (analysis: {analysis})");
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

    // Grab the nav sender before `engine` moves into the cpal closure below,
    // and publish both it and a fresh `paused` flag for Tauri commands and the
    // notification's JNI callback to reach.
    let paused = Arc::new(AtomicBool::new(false));
    let _ = PLAYBACK.set(Playback {
        paused: Arc::clone(&paused),
        nav_tx: engine.nav_sender(),
    });

    let mut stall = StallWatch::new(supported.sample_rate());
    let err_log = log.clone();
    let stream = device.build_output_stream(
        supported.config(),
        move |out: &mut [f32], _: &cpal::OutputCallbackInfo| {
            if paused.load(Ordering::Relaxed) {
                out.fill(0.0);
                stall.reset_silence();
                set_phase(Phase::Paused);
                return;
            }
            let frames = engine.render(out);
            let written = frames * 2;
            if written < out.len() {
                out[written..].fill(0.0);
            }
            // Bit-exact silence is the one signal a host gets that the
            // engine had nothing prepared for this buffer; see `StallWatch`.
            let silent = out.iter().all(|s| *s == 0.0);
            let total_frames = (out.len() / 2) as u64;
            let phase = stall.observe(total_frames, silent);
            set_phase(phase);
        },
        move |e| {
            let m = format!("stream error: {e}");
            log::error!("{m}");
            let _ = err_log.send(m);
        },
        None,
    );

    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            say!("FAIL: build_output_stream: {e}");
            set_phase(Phase::Failed);
            return;
        }
    };

    if let Err(e) = stream.play() {
        say!("FAIL: stream.play: {e}");
        set_phase(Phase::Failed);
        return;
    }
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
    let mut stalled_since: Option<std::time::Instant> = None;
    loop {
        // A second's granularity on a gap that runs for minutes. Kept coarse
        // on purpose: this thread lives for the whole listening session, and
        // the rest of the app goes out of its way not to wake a phone up for
        // no reason.
        std::thread::sleep(std::time::Duration::from_secs(1));
        match (get_phase() == Phase::Stalled, stalled_since) {
            (true, None) => {
                log::warn!("output has gone silent: the engine has no prepared track ready");
                stalled_since = Some(std::time::Instant::now());
            }
            (false, Some(since)) => {
                log::info!("output resumed after {:.1}s of silence", since.elapsed().as_secs_f64());
                stalled_since = None;
            }
            _ => {}
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

#[tauri::command(async)]
fn start(
    music_dir: String,
    cache_dir: String,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    let mut started = state.started.lock().unwrap();
    if *started {
        return Err("already started".into());
    }

    let dir = PathBuf::from(&music_dir);
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| format!("cannot read {}: {e}", dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| is_supported_track(p))
        .collect();
    paths.sort();

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
    let data = PathBuf::from(resolve_dirs(&app)?.data_dir);

    // Restore whatever was still pending from a previous run before the
    // engine starts pulling from the queue. Replaces rather than appends:
    // anything queued in this process since launch was already mirrored into
    // queue.json by the command that queued it, so appending would duplicate
    // every entry queued before start was pressed.
    match store::load_queue(&data) {
        Ok(saved) => queue::replace_pending(&state.queue, saved),
        Err(e) => log::warn!("load_queue({}): {e}", data.display()),
    }
    let queue = Arc::clone(&state.queue);

    // Before `analyze_missing`, not after: the worker holds off while the
    // phase says `Starting`, and it can only see that if it is already set.
    set_phase(Phase::Starting);

    // Kick off analysis for anything the folder holds that the cache does not
    // already have a complete entry for, so the loader thread never has to
    // run a synchronous analysis mid-playback (see `analyze_missing`).
    analyze_missing(&app, &paths, &cache, &data);

    if let Err(e) = std::thread::Builder::new()
        .name("funkot-audio".into())
        .spawn(move || audio_thread(paths, cache, data, tx, queue))
    {
        set_phase(Phase::Idle);
        return Err(format!("spawn audio thread: {e}"));
    }

    service_set_running(true);

    *started = true;
    Ok(found)
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
    let playback = PLAYBACK.get().ok_or("not playing")?;
    // fetch_xor(true) returns the *previous* value; the new state is its negation.
    let now_paused = !playback.paused.fetch_xor(true, Ordering::Relaxed);
    // Written here too, not just left for the next audio callback: the UI
    // polls PHASE, and without this it would not see the new state until the
    // callback runs again, which never happens at all once actually paused.
    set_phase(if now_paused { Phase::Paused } else { Phase::Playing });
    service_sync_state();
    Ok(now_paused)
}

/// Ask the engine to transition to the next track.
#[tauri::command]
fn skip_next() -> Result<(), String> {
    let playback = PLAYBACK.get().ok_or("not playing")?;
    // A full channel (capacity 8) just means a nav is already queued; that is
    // normal under repeated taps and not an error worth surfacing.
    let _ = playback.nav_tx.try_send(NavAction::TransitionToNext);
    Ok(())
}

#[tauri::command]
fn is_paused() -> bool {
    PLAYBACK
        .get()
        .map(|p| p.paused.load(Ordering::Relaxed))
        .unwrap_or(false)
}

/// What the UI paints. Cheap enough to poll twice a second.
#[derive(serde::Serialize, Clone)]
struct PlayerState {
    phase: &'static str,
    paused: bool,
}

#[tauri::command]
fn player_state() -> PlayerState {
    PlayerState {
        phase: get_phase().as_str(),
        paused: is_paused(),
    }
}

/// Snapshot of the playback queue, for the UI.
#[derive(serde::Serialize, Clone)]
struct QueueSnapshot {
    /// Reserved = already handed to the engine to play next; the host can no
    /// longer take it back.
    reserved: Option<String>,
    /// Waiting queue; its head is "reserved's successor".
    pending: Vec<String>,
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
    // out of order; see `AppState::save_lock`. Poisoning is not a concern:
    // nothing under this guard can panic in a way that leaves shared state
    // half-updated, so recovering the guard is better than taking the app
    // down over a stale mirror.
    let _saving = state
        .save_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let pending: VecDeque<PathBuf> = queue::snapshot(&state.queue).into_iter().collect();
    if let Err(e) = store::save_queue(&data_dir, &pending) {
        log::warn!("save_queue({}): {e}", data_dir.display());
    }
}

/// Append `path` to the tail of the pending queue. Returns the pending
/// queue's length after the insert.
#[tauri::command(async)]
fn enqueue(path: String, app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<usize, String> {
    let len = queue::enqueue(&state.queue, PathBuf::from(path));
    persist_queue(&app, &state);
    Ok(len)
}

/// Move a pending item from one position to another.
#[tauri::command(async)]
fn reorder(
    from: usize,
    to: usize,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    queue::reorder(&state.queue, from, to)?;
    persist_queue(&app, &state);
    Ok(())
}

/// Remove the item at `index` from the pending queue, returning its path.
#[tauri::command(async)]
fn dequeue(index: usize, app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<String, String> {
    let path = queue::dequeue(&state.queue, index)?;
    persist_queue(&app, &state);
    Ok(path.to_string_lossy().into_owned())
}

/// Current queue contents, for the UI to render.
#[tauri::command]
fn queue_state(state: tauri::State<AppState>) -> Result<QueueSnapshot, String> {
    let (reserved, pending) = queue::state_snapshot(&state.queue);
    Ok(QueueSnapshot {
        reserved: reserved.map(|p| p.to_string_lossy().into_owned()),
        pending: pending
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
    })
}

/// One row of the library listing: a track plus whatever the analysis cache
/// already knows about it.
#[derive(serde::Serialize, Clone)]
struct TrackRow {
    /// Absolute path. Used as the UI's key.
    path: String,
    /// Display name (file name).
    name: String,
    /// Whether a cached analysis exists. If false, the bar fields are null.
    analyzed: bool,
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
/// (`track_row`), the pick of what to hand the background worker
/// (`analyze_missing`), and the loader-status log in `audio_thread` cannot
/// drift on what "still needs analysis" means.
///
/// A hashing failure (unreadable file, etc.) reads the same as "not cached".
fn analyzed_cache_entry(
    path: &std::path::Path,
    cache_dir: &std::path::Path,
) -> Option<funkot_core::TrackAnalysis> {
    funkot_core::cache::content_hash(path)
        .ok()
        .and_then(|hash| funkot_core::cache::load(cache_dir, &hash))
        .filter(|a| !a.needs_reanalysis)
}

/// Build one `TrackRow` from whatever `analyzed_cache_entry` returns for `path`.
fn track_row(path: &std::path::Path, cache_dir: &std::path::Path) -> TrackRow {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("?")
        .to_string();
    match analyzed_cache_entry(path, cache_dir) {
        Some(a) => TrackRow {
            path: path.to_string_lossy().into_owned(),
            name,
            analyzed: true,
            intro_bars: Some(a.intro_bars),
            outro_structure_bars: Some(a.outro_structure_bars),
            outro_bars: Some(a.outro_bars),
            intro_manual: a.intro_bars_manual,
            outro_manual: a.outro_structure_bars_manual || a.outro_bars_manual,
            intro_low_confidence: a.intro_bars_low_confidence,
            outro_low_confidence: a.outro_bars_low_confidence,
        },
        None => TrackRow {
            path: path.to_string_lossy().into_owned(),
            name,
            analyzed: false,
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
        assert!(analyzed_cache_entry(&track, &dir.0).is_none());
        assert!(!track_row(&track, &dir.0).analyzed);
    }

    #[test]
    fn a_complete_entry_reads_as_analyzed() {
        let dir = TempDir::new("complete");
        let (track, analysis) = track_with_analysis(&dir.0);
        store_for(&track, &dir.0, &analysis);

        assert!(analyzed_cache_entry(&track, &dir.0).is_some());
        let row = track_row(&track, &dir.0);
        assert!(row.analyzed);
        assert_eq!(row.intro_bars, Some(analysis.intro_bars));
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

        assert!(analyzed_cache_entry(&track, &dir.0).is_none());
        let row = track_row(&track, &dir.0);
        assert!(!row.analyzed);
        // And the numbers are withheld too: showing bars the engine is about
        // to recompute invites hand-correcting a value that is on its way out.
        assert_eq!(row.intro_bars, None);
        assert_eq!(row.outro_structure_bars, None);
    }

    #[test]
    fn an_unreadable_file_reads_as_unanalyzed_rather_than_erroring() {
        let dir = TempDir::new("missing-file");
        assert!(analyzed_cache_entry(&dir.0.join("nope.wav"), &dir.0).is_none());
    }
}

/// Kick off a background analysis worker for whatever in `paths` the cache
/// does not already have a complete entry for (see `analyzed_cache_entry`).
/// Shared by `refresh_library`, which wants the listing to fill in live, and
/// `start`, which wants it so the loader thread is never the one running a
/// fresh analysis while it is also the only thing feeding the engine.
///
/// A no-op (and silent) when nothing is missing.
fn analyze_missing(app: &tauri::AppHandle, paths: &[PathBuf], cache_dir: &Path, data_dir: &Path) {
    // Hand the worker only what is actually missing. `fill_missing` checks the
    // cache *after* it is given a decoded buffer, so passing an already-analysed
    // track still costs a full decode — adding one file to a large library would
    // otherwise re-decode the whole library, which is the same heat and battery
    // cost the serial worker exists to avoid.
    let pending: Vec<PathBuf> = paths
        .iter()
        .filter(|p| analyzed_cache_entry(p, cache_dir).is_none())
        .cloned()
        .collect();
    analyze_these(app, pending, cache_dir, data_dir);
}

/// As [`analyze_missing`], for a caller that has already worked out which
/// tracks are unanalysed and should not pay to hash them all over again.
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

/// Scan `music_dir` (top-level only) for supported tracks and report what the
/// analysis cache already knows about each. Kicks off a background analysis
/// worker (one thread, one track at a time) if anything is unanalyzed.
#[tauri::command(async)]
fn refresh_library(app: tauri::AppHandle) -> Result<Vec<TrackRow>, String> {
    let dirs = resolve_dirs(&app)?;
    let music_dir = PathBuf::from(&dirs.music_dir);
    let cache_dir = PathBuf::from(&dirs.cache_dir);
    let data_dir = PathBuf::from(&dirs.data_dir);

    let mut paths: Vec<PathBuf> = std::fs::read_dir(&music_dir)
        .map_err(|e| format!("cannot read {}: {e}", music_dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| is_supported_track(p))
        .collect();
    paths.sort();

    let rows: Vec<TrackRow> = paths.iter().map(|p| track_row(p, &cache_dir)).collect();

    // Reuse what `track_row` already worked out rather than calling
    // `analyze_missing`, which would hash every file a second time: `analyzed`
    // is exactly `analyzed_cache_entry(...).is_some()`.
    let pending: Vec<PathBuf> = paths
        .iter()
        .zip(&rows)
        .filter(|(_, row)| !row.analyzed)
        .map(|(path, _)| path.clone())
        .collect();
    analyze_these(&app, pending, &cache_dir, &data_dir);

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
#[tauri::command(async)]
fn set_bars(
    app: tauri::AppHandle,
    path: String,
    intro_bars: Option<u32>,
    outro_structure_bars: Option<u32>,
) -> Result<TrackRow, String> {
    let dirs = resolve_dirs(&app)?;
    let cache_dir = PathBuf::from(&dirs.cache_dir);
    let data_dir = PathBuf::from(&dirs.data_dir);
    let track = PathBuf::from(&path);
    let hash = funkot_core::cache::content_hash(&track)
        .map_err(|e| format!("cannot hash {}: {e}", track.display()))?;

    let edit = store::BarOverride {
        intro_bars,
        outro_structure_bars,
    };
    // The cache write comes first: if the track has no analysis yet there is
    // nothing to edit, and storing the override anyway would leave the app
    // claiming a correction the user cannot see taking effect.
    apply_override(&cache_dir, &hash, &edit)?;

    let mut overrides = store::load_overrides(&data_dir);
    let entry = overrides.entry(hash).or_default();
    if let Some(n) = intro_bars {
        entry.intro_bars = Some(n);
    }
    if let Some(n) = outro_structure_bars {
        entry.outro_structure_bars = Some(n);
    }
    // Warn-only, as with the queue: the edit already took effect for playback,
    // so failing the command here would misreport what happened. What is lost
    // is only the ability to re-apply it after a future reanalysis.
    if let Err(e) = store::save_overrides(&data_dir, &overrides) {
        log::warn!("cannot persist manual bars: {e}");
    }

    Ok(track_row(&track, &cache_dir))
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

/// Block until the first track is actually making sound.
///
/// The engine's loader analyses a track itself when the cache has no complete
/// entry for it (`funkot-core` `cache::get_or_analyze`, reached from
/// `prepare_track` and from the first track's Upgrade). That analysis is what
/// this worker exists to do ahead of time — but for the *first* track the
/// loader is already doing it, on the one thread feeding the engine, and
/// piling on there is how a press of start turns into a wait for silence.
///
/// Note what this does **not** wait for. `Starting` ends at the first
/// non-silent buffer, which the loader reaches on a ~20 s head preview
/// (`prepare_first_live`) — its full analysis of that same first track is
/// still running afterwards. So this buys the decode-and-first-sound burst,
/// not the whole of track one, and the worker can still briefly overlap the
/// loader on that file. The per-track cache re-check in the worker loop is
/// what keeps that overlap from costing a second full analysis.
///
/// Idle (nothing playing) does not wait at all, which is the plain
/// press-scan-before-start case.
fn wait_out_startup() {
    let until = std::time::Instant::now() + STARTUP_WAIT;
    while get_phase() == Phase::Starting && std::time::Instant::now() < until {
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

            wait_out_startup();

            let total = paths.len();
            for (i, path) in paths.iter().enumerate() {
                let name = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("?")
                    .to_string();

                // Re-checked here, not just when the list was built: the
                // engine's loader analyses whatever it prepares, so by the
                // time this worker reaches a track the loader may already
                // have done it. `fill_missing` would notice too, but only
                // after a full decode — and it is the decode, tens of MB and
                // seconds of CPU, that is worth not repeating on a phone.
                if analyzed_cache_entry(path, &cache_dir).is_some() {
                    log::info!("analysis: {name} was done elsewhere, skipping");
                    let _ = app.emit(
                        "analysis-progress",
                        AnalysisProgress {
                            done: i + 1,
                            total,
                            name,
                            row: track_row(path, &cache_dir),
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
                let row = track_row(path, &cache_dir);
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
    use jni::objects::JObject;
    use jni::strings::JNIString;
    use jni::{errors::Result as JResult, Env, JavaVM};

    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) };
    let raw_context = ctx.context() as jni::sys::jobject;

    let result: JResult<()> = vm.attach_current_thread(|env: &mut Env<'_>| {
        let context = unsafe { JObject::from_raw(env, raw_context) };
        let class = env.find_class(jni::jni_str!(
            "jp/hatsuboshi/funkotplayer/PlaybackService"
        ))?;
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

/// Called from `PlaybackService`'s notification actions. `action` is
/// 0 = toggle play/pause, 1 = skip to next track.
#[cfg(target_os = "android")]
#[no_mangle]
/// Returns whether playback is paused *after* the action, so the Kotlin side
/// can keep the MediaSession state and the notification in step without holding
/// its own copy of the flag.
pub extern "C" fn Java_jp_hatsuboshi_funkotplayer_PlaybackService_onNativeControl(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    action: i32,
) -> jni::sys::jboolean {
    // jni-sys 0.4 defines jboolean as a real `bool`, not the u8 it used to be.
    let Some(playback) = PLAYBACK.get() else {
        return false;
    };
    match action {
        0 => {
            // fetch_xor(true) returns the *previous* value; the new state is
            // its negation. Written to PHASE here too, so stopping from the
            // notification does not leave the in-app UI reporting "playing".
            let now_paused = !playback.paused.fetch_xor(true, Ordering::Relaxed);
            set_phase(if now_paused { Phase::Paused } else { Phase::Playing });
        }
        1 => {
            let _ = playback.nav_tx.try_send(NavAction::TransitionToNext);
        }
        // 2 = query only, used when the app's own buttons changed the flag.
        _ => {}
    }
    playback.paused.load(Ordering::Relaxed)
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

    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            app_dirs,
            start,
            poll_log,
            toggle_pause,
            skip_next,
            is_paused,
            player_state,
            refresh_library,
            set_bars,
            enqueue,
            reorder,
            dequeue,
            queue_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
