//! funkot-player: drives funkot-core's auto-DJ engine from a Tauri app.
//!
//! Still minimal: no library UI. The playback queue (`queue.rs`) is wired to
//! the engine, and its contents survive a restart via `store.rs`.

mod queue;
mod store;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
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

/// Where the app keeps music and the analysis cache, as absolute paths.
///
/// Both directories exist by the time this is returned.
#[derive(serde::Serialize, Clone, Debug)]
struct AppDirs {
    /// Drop tracks here. On Android this is the app's external files dir, which
    /// shows up over MTP so a PC can copy into it.
    music_dir: String,
    /// `EngineOptions::cache_dir`. Must be absolute: the default in funkot-core
    /// is the relative `"funkot-cache"`.
    cache_dir: String,
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

    // The cache is internal: it is derived data, and keeping it out of the
    // MTP-visible folder means a PC only ever sees the music.
    let cache = PathBuf::from(files).join("funkot-cache");
    ensure_dirs(&PathBuf::from(&music), &cache)?;
    Ok(AppDirs {
        music_dir: music,
        cache_dir: cache.to_string_lossy().into_owned(),
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
    ensure_dirs(&music, &cache)?;
    Ok(AppDirs {
        music_dir: music.to_string_lossy().into_owned(),
        cache_dir: cache.to_string_lossy().into_owned(),
    })
}

fn ensure_dirs(music: &std::path::Path, cache: &std::path::Path) -> Result<(), String> {
    for dir in [music, cache] {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    Ok(())
}

#[tauri::command]
fn app_dirs(#[allow(unused)] app: tauri::AppHandle) -> Result<AppDirs, String> {
    #[cfg(target_os = "android")]
    let dirs = platform_dirs();
    #[cfg(not(target_os = "android"))]
    let dirs = platform_dirs(&app);
    if let Ok(d) = &dirs {
        log::info!("music: {} / cache: {}", d.music_dir, d.cache_dir);
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

fn audio_thread(paths: Vec<PathBuf>, cache_dir: PathBuf, log: Sender<String>, queue: SharedQueue) {
    macro_rules! say {
        ($($a:tt)*) => {{ let m = format!($($a)*); log::info!("{m}"); let _ = log.send(m); }};
    }

    let host = cpal::default_host();
    say!("host: {:?}", host.id());

    let device = match host.default_output_device() {
        Some(d) => d,
        None => {
            say!("FAIL: no default output device");
            return;
        }
    };
    // cpal 0.18: Device is Display; there is no name() -> Result any more.
    say!("device: {device}");

    let supported = match device.default_output_config() {
        Ok(c) => c,
        Err(e) => {
            say!("FAIL: default_output_config: {e}");
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
        return;
    }

    let mut options = EngineOptions::default();
    options.output_sample_rate = supported.sample_rate();
    options.cache_dir = cache_dir;

    // `options.loop_playlist` is not set here: `Engine::new_with_source`
    // never reads it (only `Engine::new`'s internal `PlaylistSource` does).
    // Looping once the host-managed queue drains is instead the job of
    // `DrainPolicy::ContinueFolder`, passed to `HostSource` below.
    let source = HostSource::new(queue, DrainPolicy::ContinueFolder { tracks: paths, pos: 0 });
    let mut engine = match Engine::new_with_source(options, Box::new(source)) {
        Ok(e) => e,
        Err(e) => {
            say!("FAIL: Engine::new_with_source: {e}");
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

    let err_log = log.clone();
    let stream = device.build_output_stream(
        supported.config(),
        move |out: &mut [f32], _: &cpal::OutputCallbackInfo| {
            if paused.load(Ordering::Relaxed) {
                out.fill(0.0);
                return;
            }
            let frames = engine.render(out);
            let written = frames * 2;
            if written < out.len() {
                out[written..].fill(0.0);
            }
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
            return;
        }
    };

    if let Err(e) = stream.play() {
        say!("FAIL: stream.play: {e}");
        return;
    }
    say!("PLAYING");

    // Hold the stream alive; it dies with this thread.
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
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

#[tauri::command]
fn start(music_dir: String, cache_dir: String, state: tauri::State<AppState>) -> Result<String, String> {
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
        return Err(format!("need >= 2 tracks in {}, found {}", dir.display(), paths.len()));
    }

    let (tx, rx) = mpsc::channel();
    *state.log_rx.lock().unwrap() = Some(rx);
    let found = format!("{} tracks", paths.len());
    let cache = PathBuf::from(cache_dir);

    // Restore whatever was still pending from a previous run before the
    // engine starts pulling from the queue. Replaces rather than appends:
    // anything queued in this process since launch was already mirrored into
    // queue.json by the command that queued it, so appending would duplicate
    // every entry queued before start was pressed.
    match store::load_queue(&cache) {
        Ok(saved) => queue::replace_pending(&state.queue, saved),
        Err(e) => log::warn!("load_queue({}): {e}", cache.display()),
    }
    let queue = Arc::clone(&state.queue);

    std::thread::Builder::new()
        .name("funkot-audio".into())
        .spawn(move || audio_thread(paths, cache, tx, queue))
        .map_err(|e| format!("spawn audio thread: {e}"))?;

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

/// Snapshot of the playback queue, for the UI.
#[derive(serde::Serialize, Clone)]
struct QueueSnapshot {
    /// Reserved = already handed to the engine to play next; the host can no
    /// longer take it back.
    reserved: Option<String>,
    /// Waiting queue; its head is "reserved's successor".
    pending: Vec<String>,
}

/// Resolve just the cache directory, mirroring the `platform_dirs` dance
/// `refresh_library` already does.
fn cache_dir_for(#[allow(unused)] app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "android")]
    let dirs = platform_dirs()?;
    #[cfg(not(target_os = "android"))]
    let dirs = platform_dirs(app)?;
    Ok(PathBuf::from(dirs.cache_dir))
}

/// Save the queue's current pending contents to `queue.json`. Failure is
/// logged, not propagated: the in-memory queue mutation already succeeded,
/// and losing the on-disk mirror is not worth failing the caller's command
/// over.
fn persist_queue(app: &tauri::AppHandle, queue: &SharedQueue) {
    let cache_dir = match cache_dir_for(app) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("save_queue: cannot resolve cache dir: {e}");
            return;
        }
    };
    let pending: VecDeque<PathBuf> = queue::snapshot(queue).into_iter().collect();
    if let Err(e) = store::save_queue(&cache_dir, &pending) {
        log::warn!("save_queue({}): {e}", cache_dir.display());
    }
}

/// Append `path` to the tail of the pending queue. Returns the pending
/// queue's length after the insert.
#[tauri::command]
fn enqueue(path: String, app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<usize, String> {
    let len = queue::enqueue(&state.queue, PathBuf::from(path));
    persist_queue(&app, &state.queue);
    Ok(len)
}

/// Move a pending item from one position to another.
#[tauri::command]
fn reorder(
    from: usize,
    to: usize,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    queue::reorder(&state.queue, from, to)?;
    persist_queue(&app, &state.queue);
    Ok(())
}

/// Remove the item at `index` from the pending queue, returning its path.
#[tauri::command]
fn dequeue(index: usize, app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<String, String> {
    let path = queue::dequeue(&state.queue, index)?;
    persist_queue(&app, &state.queue);
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
    outro_bars: Option<u32>,
    intro_manual: bool,
    outro_manual: bool,
    intro_low_confidence: bool,
    outro_low_confidence: bool,
}

/// Guards against starting a second analysis worker while one is running.
static ANALYZING: AtomicBool = AtomicBool::new(false);

/// Build one `TrackRow` from whatever `cache::load` returns for `path`.
///
/// A hashing failure (unreadable file, etc.) is reported as unanalyzed rather
/// than dropped, so one bad file does not remove itself from the listing.
fn track_row(path: &std::path::Path, cache_dir: &std::path::Path) -> TrackRow {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("?")
        .to_string();
    let analysis = funkot_core::cache::content_hash(path)
        .ok()
        .and_then(|hash| funkot_core::cache::load(cache_dir, &hash));
    match analysis {
        Some(a) => TrackRow {
            path: path.to_string_lossy().into_owned(),
            name,
            analyzed: true,
            intro_bars: Some(a.intro_bars),
            outro_bars: Some(a.outro_bars),
            intro_manual: a.intro_bars_manual,
            outro_manual: a.outro_bars_manual,
            intro_low_confidence: a.intro_bars_low_confidence,
            outro_low_confidence: a.outro_bars_low_confidence,
        },
        None => TrackRow {
            path: path.to_string_lossy().into_owned(),
            name,
            analyzed: false,
            intro_bars: None,
            outro_bars: None,
            intro_manual: false,
            outro_manual: false,
            intro_low_confidence: false,
            outro_low_confidence: false,
        },
    }
}

/// Scan `music_dir` (top-level only) for supported tracks and report what the
/// analysis cache already knows about each. Kicks off a background analysis
/// worker (one thread, one track at a time) if anything is unanalyzed.
#[tauri::command]
fn refresh_library(app: tauri::AppHandle) -> Result<Vec<TrackRow>, String> {
    #[cfg(target_os = "android")]
    let dirs = platform_dirs()?;
    #[cfg(not(target_os = "android"))]
    let dirs = platform_dirs(&app)?;

    let music_dir = PathBuf::from(&dirs.music_dir);
    let cache_dir = PathBuf::from(&dirs.cache_dir);

    let mut paths: Vec<PathBuf> = std::fs::read_dir(&music_dir)
        .map_err(|e| format!("cannot read {}: {e}", music_dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| is_supported_track(p))
        .collect();
    paths.sort();

    let rows: Vec<TrackRow> = paths.iter().map(|p| track_row(p, &cache_dir)).collect();

    // Hand the worker only what is actually missing. `fill_missing` checks the
    // cache *after* it is given a decoded buffer, so passing an already-analysed
    // track still costs a full decode — adding one file to a large library would
    // otherwise re-decode the whole library, which is the same heat and battery
    // cost the serial worker exists to avoid.
    let pending: Vec<PathBuf> = paths
        .iter()
        .zip(&rows)
        .filter(|(_, row)| !row.analyzed)
        .map(|(path, _)| path.clone())
        .collect();
    if !pending.is_empty() {
        spawn_analysis_worker(app, pending, cache_dir);
    }

    Ok(rows)
}

/// Progress payload for the `analysis-progress` event.
#[derive(serde::Serialize, Clone)]
struct AnalysisProgress {
    done: usize,
    total: usize,
    name: String,
}

/// Spawn the single background analysis thread, if one is not already running.
///
/// Deliberately serial, not parallelised across tracks: this runs on a phone,
/// and analysing more than one file at a time would mean more heat and battery
/// drain for no benefit the user can perceive (the worker already runs
/// unattended in the background).
fn spawn_analysis_worker(app: tauri::AppHandle, paths: Vec<PathBuf>, cache_dir: PathBuf) {
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
                let name = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("?")
                    .to_string();

                match funkot_core::decode::decode_file(path) {
                    Ok(buffer) => {
                        if let Err(e) = funkot_core::cache::fill_missing(path, &cache_dir, &buffer) {
                            log::warn!("analysis failed for {}: {e}", path.display());
                        }
                        // `buffer` drops here, before the next track is decoded,
                        // so only one track's worth of samples (tens of MB) is
                        // ever resident at once.
                    }
                    Err(e) => {
                        log::warn!("decode failed for {}: {e}", path.display());
                    }
                }

                let _ = app.emit(
                    "analysis-progress",
                    AnalysisProgress {
                        done: i + 1,
                        total,
                        name,
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
            playback.paused.fetch_xor(true, Ordering::Relaxed);
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
            refresh_library,
            enqueue,
            reorder,
            dequeue,
            queue_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
