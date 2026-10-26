use std::fs::OpenOptions;
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use sha2::{Digest, Sha256};

use funkot_core::engine::{Engine, NavigationTrace};
use funkot_core::EngineOptions;

#[derive(Clone, Copy, Debug)]
pub(crate) struct CallbackRecord {
    pub sequence: u64,
    pub callback_qpc_100ns: u64,
    pub playback_qpc_100ns: u64,
    pub output_frames: u64,
    pub engine_start: Option<u64>,
    pub engine_end: Option<u64>,
    pub paused: bool,
    pub audition: bool,
    pub render_lock_miss: bool,
    pub trace_dropped: u64,
}

#[derive(Clone)]
pub(crate) struct CaptureSink {
    sender: mpsc::SyncSender<CaptureRecord>,
    dropped: Arc<AtomicU64>,
}

enum CaptureRecord {
    Callback(CallbackRecord),
    Requested { id: u64 },
}

static CAPTURE: OnceLock<CaptureSink> = OnceLock::new();
static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) fn request_next() {
    if let Some(capture) = CAPTURE.get() {
        let id = REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
        capture.send(CaptureRecord::Requested { id });
    }
}

impl CaptureSink {
    pub(crate) fn record(&self, record: CallbackRecord) {
        self.send(CaptureRecord::Callback(record));
    }

    fn send(&self, record: CaptureRecord) {
        if self.sender.try_send(record).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

pub(crate) fn start(engine: &mut Engine, options: &EngineOptions, inputs: &[PathBuf]) -> io::Result<Option<CaptureSink>> {
    let Some(directory) = std::env::var_os("FUNKOT_NAVIGATION_CAPTURE_DIR") else { return Ok(None); };
    if !cfg!(target_os = "windows") {
        return Err(io::Error::other("navigation capture requires the WASAPI QPC clock"));
    }
    let sink = start_in(engine, options, inputs, Path::new(&directory))?;
    CAPTURE.set(sink.clone()).map_err(|_| io::Error::other("navigation capture already started"))?;
    Ok(Some(sink))
}

fn start_in(engine: &mut Engine, options: &EngineOptions, inputs: &[PathBuf], directory: &Path) -> io::Result<CaptureSink> {
    let stop = directory.join("STOP");
    let completion = directory.join("navigation-complete.json");
    if stop.exists() { return Err(io::Error::other("navigation capture STOP already exists")); }
    let create = |name| OpenOptions::new().write(true).create_new(true).open(directory.join(name));
    let mut content_hashes = Vec::new();
    for path in inputs {
        let mut source = std::fs::File::open(path)?;
        let mut hash = Sha256::new();
        io::copy(&mut source, &mut hash)?;
        content_hashes.push(format!("{:x}", hash.finalize()));
    }
    let mut header = BufWriter::new(create("navigation-header.json")?);
    serde_json::to_writer(&mut header, &serde_json::json!({
        "schema_version": 1,
        "core_git": env!("FUNKOT_CORE_GIT"),
        "options": options,
        "input": {"content_hashes": content_hashes},
        "clock": "wasapi_qpc_100ns",
        "engine_frame_domain": "emitted_output_frames_including_engine_silence",
        "transport": "transport_fade"
    }))?;
    header.flush()?;
    let mut navigation = BufWriter::new(create("navigation.jsonl")?);
    let mut callbacks = BufWriter::new(create("callbacks.csv")?);
    writeln!(callbacks, "sequence,callback_qpc_100ns,playback_qpc_100ns,output_frames,engine_start,engine_end,paused,audition,render_lock_miss,trace_dropped")?;
    callbacks.flush()?;
    let trace_rx = engine.enable_navigation_trace(64);
    let (sender, receiver) = mpsc::sync_channel::<CaptureRecord>(64);
    let dropped = Arc::new(AtomicU64::new(0));
    let writer_dropped = Arc::clone(&dropped);
    std::thread::Builder::new().name("navigation-capture".into()).spawn(move || {
        let result = (|| -> io::Result<()> {
            let mut last = None;
            loop {
                let callback = match receiver.recv_timeout(std::time::Duration::from_millis(100)) {
                    Ok(CaptureRecord::Callback(callback)) => callback,
                    Ok(CaptureRecord::Requested { id }) => {
                        serde_json::to_writer(&mut navigation, &serde_json::json!({
                            "kind": "requested", "request_id": id, "label": format!("next-{id}"),
                            "action": "transition_to_next"
                        }))?;
                        writeln!(navigation)?;
                        navigation.flush()?;
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) if stop.exists() => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                };
                drain_trace(&trace_rx, &mut navigation)?;
                let start = callback.engine_start.map(|value| value.to_string()).unwrap_or_default();
                let end = callback.engine_end.map(|value| value.to_string()).unwrap_or_default();
                writeln!(callbacks, "{},{},{},{},{},{},{},{},{},{}", callback.sequence,
                    callback.callback_qpc_100ns, callback.playback_qpc_100ns,
                    callback.output_frames, start, end, u8::from(callback.paused),
                    u8::from(callback.audition), u8::from(callback.render_lock_miss), callback.trace_dropped)?;
                last = Some(callback);
                if stop.exists() { break; }
            }
            drain_trace(&trace_rx, &mut navigation)?;
            serde_json::to_writer(&mut navigation, &serde_json::json!({
                "kind": "capture_end", "callback_records_dropped": writer_dropped.load(Ordering::Relaxed),
                "last_callback_sequence": last.map(|record| record.sequence),
                "last_playback_qpc_100ns": last.map(|record| record.playback_qpc_100ns),
                "last_output_frames": last.map(|record| record.output_frames),
                "last_engine_frame": last.and_then(|record| record.engine_end),
                "trace_dropped": last.map(|record| record.trace_dropped)
            }))?;
            writeln!(navigation)?;
            navigation.flush()?;
            callbacks.flush()?;
            let mut complete = OpenOptions::new().write(true).create_new(true).open(completion)?;
            serde_json::to_writer(&mut complete, &serde_json::json!({"complete": true}))?;
            complete.sync_all()
        })();
        if let Err(error) = result { log::error!("navigation capture incomplete: {error}"); }
    })?;
    Ok(CaptureSink { sender, dropped })
}

fn drain_trace(receiver: &mpsc::Receiver<NavigationTrace>, writer: &mut impl Write) -> io::Result<()> {
    let mut written = false;
    for event in receiver.try_iter() {
        serde_json::to_writer(&mut *writer, &event)?;
        writeln!(writer)?;
        written = true;
    }
    if written { writer.flush()?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_or_disconnected_capture_never_waits_for_the_writer() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let sink = CaptureSink { sender, dropped: Arc::new(AtomicU64::new(0)) };
        let record = CallbackRecord { sequence: 1, callback_qpc_100ns: 1, playback_qpc_100ns: 2,
            output_frames: 192, engine_start: Some(0), engine_end: Some(192), paused: false,
            audition: false, render_lock_miss: false, trace_dropped: 0 };
        sink.record(record);
        sink.record(record);
        assert_eq!(sink.dropped.load(Ordering::Relaxed), 1);
        assert!(matches!(receiver.try_recv().unwrap(), CaptureRecord::Callback(value) if value.engine_end == Some(192)));
        drop(receiver);
        sink.record(record);
        assert_eq!(sink.dropped.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn capture_flushes_actual_input_identity_and_stop_coverage() {
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("input.wav");
        std::fs::write(&input, b"diagnostic input bytes").unwrap();
        let options = EngineOptions { cache_dir: directory.path().join("cache"), ..EngineOptions::default() };
        let track = funkot_core::engine::PreparedTrack {
            path: input.clone(), playlist_index: 0, samples: Arc::new(vec![0.25; 256]), frames: 128,
            first_downbeat_out: 0, outro_start_out: 128, outro_end_anchored_out: 128,
            intro_bars: 0, outro_bars: 0, gain_linear: 1.0, preview: false, head_only: false,
        };
        let mut engine = Engine::from_prepared(options.clone(), vec![track]).unwrap();
        let sink = start_in(&mut engine, &options, &[input], directory.path()).unwrap();
        sink.send(CaptureRecord::Requested { id: 1 });
        let mut pcm = [0.0; 128];
        assert_eq!(engine.render(&mut pcm), 64);
        sink.record(CallbackRecord { sequence: 17, callback_qpc_100ns: 100, playback_qpc_100ns: 200,
            output_frames: 64, engine_start: Some(0), engine_end: Some(engine.render_frame()),
            paused: false, audition: false, render_lock_miss: false, trace_dropped: 0 });
        std::fs::write(directory.path().join("STOP"), b"stop").unwrap();
        drop(sink);
        drop(engine);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !directory.path().join("navigation-complete.json").exists() {
            assert!(std::time::Instant::now() < deadline, "capture writer failed to finish");
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        let header: serde_json::Value = serde_json::from_slice(&std::fs::read(directory.path().join("navigation-header.json")).unwrap()).unwrap();
        assert_eq!(header["input"]["content_hashes"][0], format!("{:x}", Sha256::digest(b"diagnostic input bytes")));
        let navigation = std::fs::read_to_string(directory.path().join("navigation.jsonl")).unwrap();
        let rows: Vec<serde_json::Value> = navigation.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(rows[0]["kind"], "requested");
        assert_eq!(rows.last().unwrap()["last_engine_frame"], 64);
        assert_eq!(rows.last().unwrap()["callback_records_dropped"], 0);
        assert!(std::fs::read_to_string(directory.path().join("callbacks.csv")).unwrap().contains("17,100,200,64,0,64,0,0,0,0"));
    }
}
