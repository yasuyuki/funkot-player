use std::fs::OpenOptions;
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::time::SystemTime;
use serde::Deserialize;
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
    gate: Option<Arc<AtomicBool>>,
    run_id: Arc<str>,
}

enum CaptureRecord {
    Callback(CallbackRecord),
    Requested { id: u64 },
    StreamOpened {
        stream: StreamMetadata,
        complete: mpsc::SyncSender<io::Result<()>>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct StreamMetadata {
    run_id: String,
    process_id: u32,
    endpoint_id: String,
    rate: u32,
    channels: u16,
    sample_format: &'static str,
}

#[derive(Deserialize)]
struct StartAuthorization {
    schema: u64,
    run_id: String,
    process_id: u32,
    stream: StartStream,
    session: StartSession,
    user_sound_signal: bool,
}

#[derive(Deserialize)]
struct StartStream {
    endpoint_id: String,
    rate: u32,
    channels: u16,
    sample_format: String,
}

#[derive(Deserialize)]
struct StartSession {
    process_id: u32,
    endpoint_id: String,
    session_id: String,
    rate: u32,
    channels: u16,
    sample_format: String,
}

static CAPTURE: OnceLock<CaptureSink> = OnceLock::new();
static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static RUN_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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

    pub(crate) fn blocks_audio(&self) -> bool {
        self.gate
            .as_ref()
            .is_some_and(|gate| !gate.load(Ordering::Acquire))
    }

    pub(crate) fn open_output_stream(&self, endpoint_id: String, rate: u32) -> io::Result<()> {
        let Some(gate) = &self.gate else { return Ok(()); };
        if endpoint_id.trim().is_empty() {
            return Err(io::Error::other("output device id is empty"));
        }
        gate.store(false, Ordering::Release);
        let (complete, result) = mpsc::sync_channel(1);
        let stream = StreamMetadata {
            run_id: self.run_id.to_string(),
            process_id: std::process::id(),
            endpoint_id,
            rate,
            channels: 2,
            sample_format: "f32",
        };
        self.sender
            .send(CaptureRecord::StreamOpened { stream, complete })
            .map_err(|_| io::Error::other("navigation capture writer stopped"))?;
        result
            .recv()
            .map_err(|_| io::Error::other("navigation capture writer stopped"))?
    }
}

pub(crate) fn gate_output(capture: Option<&CaptureSink>, output: &mut [f32]) -> bool {
    if capture.is_some_and(CaptureSink::blocks_audio) {
        output.fill(0.0);
        true
    } else {
        false
    }
}

pub(crate) fn start(engine: &mut Engine, options: &EngineOptions, inputs: &[PathBuf]) -> io::Result<Option<CaptureSink>> {
    let require_start = match std::env::var_os("FUNKOT_NAVIGATION_REQUIRE_START_SIGNAL") {
        None => false,
        Some(value) if value == "1" => true,
        Some(_) => return Err(io::Error::other("FUNKOT_NAVIGATION_REQUIRE_START_SIGNAL must be 1")),
    };
    let directory = std::env::var_os("FUNKOT_NAVIGATION_CAPTURE_DIR");
    if require_start && directory.as_ref().is_none_or(|value| value.is_empty()) {
        return Err(io::Error::other("FUNKOT_NAVIGATION_CAPTURE_DIR must name an existing directory"));
    }
    let Some(directory) = directory else { return Ok(None); };
    if !cfg!(target_os = "windows") {
        return Err(io::Error::other("navigation capture requires the WASAPI QPC clock"));
    }
    if require_start && !Path::new(&directory).is_dir() {
        return Err(io::Error::other("FUNKOT_NAVIGATION_CAPTURE_DIR must name an existing directory"));
    }
    let sink = start_in(engine, options, inputs, Path::new(&directory), require_start)?;
    CAPTURE.set(sink.clone()).map_err(|_| io::Error::other("navigation capture already started"))?;
    Ok(Some(sink))
}

fn start_in(engine: &mut Engine, options: &EngineOptions, inputs: &[PathBuf], directory: &Path, require_start: bool) -> io::Result<CaptureSink> {
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
    let run_id: Arc<str> = current_run_id().into();
    let mut header = BufWriter::new(create("navigation-header.json")?);
    serde_json::to_writer(&mut header, &serde_json::json!({
        "schema_version": 1,
        "run_id": &*run_id,
        "process_id": std::process::id(),
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
    let gate = require_start.then(|| Arc::new(AtomicBool::new(false)));
    let writer_gate = gate.as_ref().map(Arc::clone);
    let capture_directory = directory.to_owned();
    std::thread::Builder::new().name("navigation-capture".into()).spawn(move || {
        let result = (|| -> io::Result<()> {
            let mut last = None;
            let mut stream_output: Option<BufWriter<std::fs::File>> = None;
            let mut expected_stream: Option<StreamMetadata> = None;
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
                    Ok(CaptureRecord::StreamOpened { stream, complete }) => {
                        if let Some(gate) = &writer_gate {
                            gate.store(false, Ordering::Release);
                        }
                        expected_stream = None;
                        let output = match stream_output.as_mut() {
                            Some(output) => output,
                            None => {
                                let file = OpenOptions::new().write(true).create_new(true)
                                    .open(capture_directory.join("output-stream.jsonl"));
                                match file {
                                    Ok(file) => stream_output.insert(BufWriter::new(file)),
                                    Err(error) => {
                                        let _ = complete.send(Err(error));
                                        continue;
                                    }
                                }
                            }
                        };
                        let write_result = (|| -> io::Result<()> {
                            clear_start(&capture_directory)?;
                            serde_json::to_writer(&mut *output, &serde_json::json!({
                                "schema": 1,
                                "run_id": &stream.run_id,
                                "process_id": stream.process_id,
                                "endpoint_id": &stream.endpoint_id,
                                "stream": {
                                    "endpoint_id": &stream.endpoint_id,
                                    "rate": stream.rate,
                                    "channels": stream.channels,
                                    "sample_format": stream.sample_format,
                                },
                            }))?;
                            writeln!(output)?;
                            output.flush()
                        })();
                        if write_result.is_ok() {
                            expected_stream = Some(stream);
                        }
                        let _ = complete.send(write_result);
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) if stop.exists() => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        authorize_start(&capture_directory, writer_gate.as_ref(), expected_stream.as_ref());
                        continue;
                    }
                };
                authorize_start(&capture_directory, writer_gate.as_ref(), expected_stream.as_ref());
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
    Ok(CaptureSink { sender, dropped, gate, run_id })
}

fn current_run_id() -> String {
    format!("{}-{}-{}", std::process::id(), SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default().as_nanos(), RUN_SEQUENCE.fetch_add(1, Ordering::Relaxed))
}

fn clear_start(directory: &Path) -> io::Result<()> {
    match std::fs::remove_file(directory.join("START.json")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn authorize_start(directory: &Path, gate: Option<&Arc<AtomicBool>>, expected: Option<&StreamMetadata>) {
    let (Some(gate), Some(stream)) = (gate, expected) else { return; };
    if gate.load(Ordering::Acquire) { return; }
    let authorization = std::fs::read(directory.join("START.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<StartAuthorization>(&bytes).ok());
    if authorization.as_ref().is_some_and(|value| authorization_matches(value, stream)) {
        gate.store(true, Ordering::Release);
    }
}

fn authorization_matches(value: &StartAuthorization, stream: &StreamMetadata) -> bool {
    value.schema == 1
        && nonblank(&value.run_id)
        && nonblank(&value.stream.endpoint_id)
        && nonblank(&value.session.endpoint_id)
        && nonblank(&value.session.session_id)
        && value.user_sound_signal
        && value.run_id == stream.run_id
        && value.process_id == stream.process_id
        && value.stream.endpoint_id == stream.endpoint_id
        && value.stream.rate == stream.rate
        && value.stream.channels == stream.channels
        && value.stream.sample_format == stream.sample_format
        && value.session.process_id == stream.process_id
        && endpoint_matches(&value.session.endpoint_id, &stream.endpoint_id)
        && value.session.rate == stream.rate
        && value.session.channels == stream.channels
        && value.session.sample_format == stream.sample_format
}

fn nonblank(value: &str) -> bool { !value.trim().is_empty() }

fn endpoint_matches(session: &str, expected: &str) -> bool {
    // The receipt records CPAL's backend ID. Windows session discovery may return
    // that same ID with CPAL's `wasapi:` display prefix.
    session == expected || session.strip_prefix("wasapi:") == Some(expected)
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

    fn stream() -> StreamMetadata {
        StreamMetadata {
            run_id: "run-1".into(), process_id: 42, endpoint_id: "endpoint".into(),
            rate: 48_000, channels: 2, sample_format: "f32",
        }
    }

    fn authorization(stream: &StreamMetadata) -> StartAuthorization {
        StartAuthorization {
            schema: 1, run_id: stream.run_id.clone(), process_id: stream.process_id,
            stream: StartStream {
                endpoint_id: stream.endpoint_id.clone(), rate: stream.rate,
                channels: stream.channels, sample_format: stream.sample_format.into(),
            },
            session: StartSession {
                process_id: stream.process_id, endpoint_id: format!("wasapi:{}", stream.endpoint_id),
                session_id: "session".into(), rate: stream.rate, channels: stream.channels,
                sample_format: stream.sample_format.into(),
            },
            user_sound_signal: true,
        }
    }

    fn write_authorization(directory: &Path, stream: &StreamMetadata, session_id: &str) {
        std::fs::write(directory.join("START.json"), serde_json::to_vec(&serde_json::json!({
            "schema": 1, "run_id": &stream.run_id, "process_id": stream.process_id,
            "stream": {"endpoint_id": &stream.endpoint_id, "rate": stream.rate, "channels": stream.channels, "sample_format": stream.sample_format},
            "session": {"process_id": stream.process_id, "endpoint_id": format!("wasapi:{}", stream.endpoint_id), "session_id": session_id, "rate": stream.rate, "channels": stream.channels, "sample_format": stream.sample_format},
            "user_sound_signal": true,
        })).unwrap()).unwrap();
    }

    fn callback_record() -> CallbackRecord {
        CallbackRecord {
            sequence: 1, callback_qpc_100ns: 1, playback_qpc_100ns: 2, output_frames: 64,
            engine_start: None, engine_end: None, paused: true, audition: false,
            render_lock_miss: false, trace_dropped: 0,
        }
    }

    fn sink_with_gate(authorized: bool) -> CaptureSink {
        let (sender, _receiver) = mpsc::sync_channel(1);
        CaptureSink {
            sender,
            dropped: Arc::new(AtomicU64::new(0)),
            gate: Some(Arc::new(AtomicBool::new(authorized))),
            run_id: "run-1".into(),
        }
    }

    #[test]
    fn full_or_disconnected_capture_never_waits_for_the_writer() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let sink = CaptureSink {
            sender,
            dropped: Arc::new(AtomicU64::new(0)),
            gate: None,
            run_id: "run-1".into(),
        };
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
        let sink = start_in(&mut engine, &options, &[input], directory.path(), false).unwrap();
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

    #[test]
    fn authorization_requires_a_current_matching_user_signal() {
        let stream = stream();
        let valid = authorization(&stream);
        assert!(authorization_matches(&valid, &stream));

        let mut invalid = authorization(&stream);
        invalid.run_id.clear();
        assert!(!authorization_matches(&invalid, &stream));
        let mut invalid = authorization(&stream);
        invalid.process_id += 1;
        assert!(!authorization_matches(&invalid, &stream));
        let mut invalid = authorization(&stream);
        invalid.stream.endpoint_id = "other".into();
        assert!(!authorization_matches(&invalid, &stream));
        let mut invalid = authorization(&stream);
        invalid.stream.sample_format = "i16".into();
        assert!(!authorization_matches(&invalid, &stream));
        let mut invalid = authorization(&stream);
        invalid.session.session_id.clear();
        assert!(!authorization_matches(&invalid, &stream));
        let mut invalid = authorization(&stream);
        invalid.user_sound_signal = false;
        assert!(!authorization_matches(&invalid, &stream));

        let directory = tempfile::tempdir().unwrap();
        let gate = Arc::new(AtomicBool::new(false));
        authorize_start(directory.path(), Some(&gate), Some(&stream));
        assert!(!gate.load(Ordering::Acquire));
        std::fs::write(directory.path().join("START.json"), b"not json").unwrap();
        authorize_start(directory.path(), Some(&gate), Some(&stream));
        assert!(!gate.load(Ordering::Acquire));
    }

    #[test]
    fn gate_silences_output_without_advancing_an_engine() {
        let sink = sink_with_gate(false);
        let mut output = [0.5; 8];
        let options = EngineOptions::default();
        let track = funkot_core::engine::PreparedTrack {
            path: PathBuf::from("gate-test.wav"), playlist_index: 0, samples: Arc::new(vec![0.25; 16]), frames: 8,
            first_downbeat_out: 0, outro_start_out: 8, outro_end_anchored_out: 8,
            intro_bars: 0, outro_bars: 0, gain_linear: 1.0, preview: false, head_only: false,
        };
        let mut engine = Engine::from_prepared(options, vec![track]).unwrap();
        let before = engine.render_frame();
        if !gate_output(Some(&sink), &mut output) {
            engine.render(&mut output);
        }
        assert_eq!(output, [0.0; 8]);
        assert_eq!(engine.render_frame(), before);

        sink.gate.as_ref().unwrap().store(true, Ordering::Release);
        assert!(!gate_output(Some(&sink), &mut output));
    }

    #[test]
    fn reopened_stream_requires_a_new_start_file() {
        let directory = tempfile::tempdir().unwrap();
        let stream = stream();
        let gate = Arc::new(AtomicBool::new(false));
        let start = authorization(&stream);
        std::fs::write(directory.path().join("START.json"), serde_json::to_vec(&serde_json::json!({
            "schema": start.schema, "run_id": start.run_id, "process_id": start.process_id,
            "stream": {"endpoint_id": start.stream.endpoint_id, "rate": start.stream.rate, "channels": start.stream.channels, "sample_format": start.stream.sample_format},
            "session": {"process_id": start.session.process_id, "endpoint_id": start.session.endpoint_id, "session_id": start.session.session_id, "rate": start.session.rate, "channels": start.session.channels, "sample_format": start.session.sample_format},
            "user_sound_signal": start.user_sound_signal,
        })).unwrap()).unwrap();
        authorize_start(directory.path(), Some(&gate), Some(&stream));
        assert!(gate.load(Ordering::Acquire));
        gate.store(false, Ordering::Release);
        clear_start(directory.path()).unwrap();
        authorize_start(directory.path(), Some(&gate), Some(&stream));
        assert!(!gate.load(Ordering::Acquire));
        std::fs::write(directory.path().join("START.json"), serde_json::to_vec(&serde_json::json!({
            "schema": 1, "run_id": &stream.run_id, "process_id": stream.process_id,
            "stream": {"endpoint_id": &stream.endpoint_id, "rate": stream.rate, "channels": stream.channels, "sample_format": stream.sample_format},
            "session": {"process_id": stream.process_id, "endpoint_id": format!("wasapi:{}", stream.endpoint_id), "session_id": "new-session", "rate": stream.rate, "channels": stream.channels, "sample_format": stream.sample_format},
            "user_sound_signal": true,
        })).unwrap()).unwrap();
        authorize_start(directory.path(), Some(&gate), Some(&stream));
        assert!(gate.load(Ordering::Acquire));
    }

    #[test]
    fn writer_reopen_cannot_reauthorize_an_older_start_queued_callback() {
        let directory = tempfile::tempdir().unwrap();
        let options = EngineOptions { cache_dir: directory.path().join("cache"), ..EngineOptions::default() };
        let track = funkot_core::engine::PreparedTrack {
            path: PathBuf::from("writer-gate.wav"), playlist_index: 0, samples: Arc::new(vec![0.25; 16]), frames: 8,
            first_downbeat_out: 0, outro_start_out: 8, outro_end_anchored_out: 8,
            intro_bars: 0, outro_bars: 0, gain_linear: 1.0, preview: false, head_only: false,
        };
        let mut engine = Engine::from_prepared(options.clone(), vec![track]).unwrap();
        let sink = start_in(&mut engine, &options, &[], directory.path(), true).unwrap();
        let header: serde_json::Value = serde_json::from_slice(&std::fs::read(directory.path().join("navigation-header.json")).unwrap()).unwrap();
        let stream = StreamMetadata {
            run_id: header["run_id"].as_str().unwrap().into(),
            process_id: header["process_id"].as_u64().unwrap() as u32,
            endpoint_id: "endpoint".into(), rate: 48_000, channels: 2, sample_format: "f32",
        };
        sink.open_output_stream(stream.endpoint_id.clone(), stream.rate).unwrap();
        write_authorization(directory.path(), &stream, "first-session");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while sink.blocks_audio() {
            assert!(std::time::Instant::now() < deadline, "writer did not authorize the first stream");
            std::thread::sleep(std::time::Duration::from_millis(1));
        }

        sink.record(callback_record());
        sink.open_output_stream(stream.endpoint_id.clone(), stream.rate).unwrap();
        assert!(sink.blocks_audio());
        assert!(!directory.path().join("START.json").exists());

        std::fs::write(directory.path().join("STOP"), b"stop").unwrap();
        drop(sink);
        drop(engine);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !directory.path().join("navigation-complete.json").exists() {
            assert!(std::time::Instant::now() < deadline, "capture writer failed to finish");
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
}
