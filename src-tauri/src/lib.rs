//! Spike 0 step 2: prove that a Tauri v2 Android app can drive funkot-core
//! through cpal's AAudio host and actually make sound on a device.
//!
//! Deliberately minimal: no library UI, no queue, no persistence.

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use funkot_core::engine::Engine;
use funkot_core::EngineOptions;

/// Where the audio thread reports back to the UI. `cpal::Stream` is not `Send`
/// on every platform, so it never leaves the thread that created it.
#[derive(Default)]
struct AppState {
    log_rx: Mutex<Option<Receiver<String>>>,
    lines: Mutex<Vec<String>>,
    started: Mutex<bool>,
}

fn audio_thread(paths: Vec<PathBuf>, cache_dir: PathBuf, log: Sender<String>) {
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
    options.loop_playlist = true;

    let mut engine = match Engine::new(options, paths) {
        Ok(e) => e,
        Err(e) => {
            say!("FAIL: Engine::new: {e}");
            return;
        }
    };
    // Never block in the audio callback.
    engine.set_realtime(true);
    say!("engine created");

    let err_log = log.clone();
    let stream = device.build_output_stream(
        supported.config(),
        move |out: &mut [f32], _: &cpal::OutputCallbackInfo| {
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
        .filter(|p| {
            p.extension()
                .and_then(|s| s.to_str())
                .map(|e| matches!(e.to_ascii_lowercase().as_str(),
                    "wav" | "mp3" | "flac" | "m4a" | "ogg"))
                .unwrap_or(false)
        })
        .collect();
    paths.sort();

    if paths.len() < 2 {
        return Err(format!("need >= 2 tracks in {}, found {}", dir.display(), paths.len()));
    }

    let (tx, rx) = mpsc::channel();
    *state.log_rx.lock().unwrap() = Some(rx);
    let found = format!("{} tracks", paths.len());
    let cache = PathBuf::from(cache_dir);

    std::thread::Builder::new()
        .name("funkot-audio".into())
        .spawn(move || audio_thread(paths, cache, tx))
        .map_err(|e| format!("spawn audio thread: {e}"))?;

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
        .invoke_handler(tauri::generate_handler![start, poll_log])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
