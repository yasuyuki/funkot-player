use std::fs::{File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use sha2::{Digest, Sha256};
use serde_json::json;
use funkot_core::engine::{prepare_tracks_parallel, Engine, EngineEvent};
use funkot_core::EngineOptions;
#[path = "../src/transport_fade.rs"]
mod transport_fade;

const CORE_MARKER: &str = concat!("FUNKOT_CYCLE_CORE_REVISION:", env!("FUNKOT_CORE_GIT"), ":END");
const MAX_FRAMES: u64 = (u32::MAX as u64 - 36) / 8;

fn hash(path: &Path) -> Result<String, String> {
    let mut value = Sha256::new();
    std::io::copy(&mut File::open(path).map_err(|e| e.to_string())?, &mut value).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", value.finalize()))
}

fn render(mut engine: Engine, limit: u64, mut write: impl FnMut(&[f32]) -> Result<(), String>) -> Result<(u64, Vec<serde_json::Value>), String> {
    let mut buffer = vec![0.0f32; 1024 * 2];
    let mut frames = 0u64;
    let mut events = Vec::new();
    while !engine.is_finished() && frames < limit {
        let wanted = (limit - frames).min(1024) as usize;
        let count = engine.render(&mut buffer[..wanted * 2]);
        if count == 0 { break; }
        let samples = &buffer[..count * 2];
        if samples.iter().any(|x| !x.is_finite()) { return Err("cycle reference contains a non-finite sample".into()); }
        write(samples)?;
        frames += count as u64;
        for event in engine.poll_events() {
            let record = match event {
                EngineEvent::TrackStarted { index, entry_frame_out, .. } => json!({ "kind": "track_started", "index": index, "entry_frame": entry_frame_out }),
                EngineEvent::TransitionStarted { from, to, .. } => json!({ "kind": "transition_started", "from": from, "to": to }),
                EngineEvent::TrackFailed { .. } => return Err("cycle reference track failed".into()),
                EngineEvent::Finished => json!({ "kind": "finished" }),
            };
            events.push(json!({ "engine_frame_after_render": engine.render_frame(), "event": record }));
        }
    }
    let started: Vec<u64> = events.iter().filter_map(|event| (event["event"]["kind"] == "track_started").then(|| event["event"]["index"].as_u64()).flatten()).collect();
    if !engine.is_finished() || started != [0, 1, 2] {
        return Err("cycle reference did not naturally finish all A-B180-A occurrences".into());
    }
    Ok((frames, events))
}

fn cached_first_entry(options: &EngineOptions, file: &Path) -> Result<u64, String> {
    let mut options = options.clone();
    options.loop_playlist = false;
    let mut engine = Engine::new(options, vec![file.to_owned()]).map_err(|e| e.to_string())?;
    let mut buffer = [0.0; 2048];
    while !engine.is_finished() {
        engine.render(&mut buffer);
        for event in engine.poll_events() {
            match event {
                EngineEvent::TrackStarted { index: 0, entry_frame_out, .. } => return Ok(entry_frame_out),
                EngineEvent::TrackFailed { .. } => return Err("cached first-source probe failed".into()),
                _ => {}
            }
        }
        std::thread::yield_now();
    }
    Err("cached first-source probe ended without a source".into())
}

fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    if args.first().is_some_and(|arg| arg == Path::new("--compose")) { return compose(&args[1..]); }
    if args.len() != 4 { return Err("Usage: diagnostic_cycle_reference input-manifest.json capture-header.json cache-directory output-prefix".into()); }
    let manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(&args[0]).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let entries = manifest["files"].as_array().filter(|files| files.len() == 2).ok_or("cycle reference needs two fixed inputs")?;
    let base = args[0].parent().unwrap_or_else(|| Path::new("."));
    let mut files = Vec::new();
    let mut hashes = Vec::new();
    for entry in entries {
        let file = base.join(entry["file"].as_str().ok_or("cycle input path is missing")?);
        let actual = hash(&file)?;
        if entry["sha256"].as_str() != Some(actual.as_str()) { return Err("cycle input hash does not match".into()); }
        files.push(file);
        hashes.push(actual);
    }
    if hashes[0] == hashes[1] { return Err("cycle inputs must be distinct".into()); }
    let header: serde_json::Value = serde_json::from_slice(&std::fs::read(&args[1]).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if header["core_git"].as_str() != Some(env!("FUNKOT_CORE_GIT")) { return Err("cycle reference core does not match capture".into()); }
    let mut options: EngineOptions = serde_json::from_value(header["options"].clone()).map_err(|e| e.to_string())?;
    if options.output_sample_rate != 48_000 { return Err("cycle reference requires 48 kHz".into()); }
    options.cache_dir = args[2].clone();
    let mut tracks = prepare_tracks_parallel(&options, &files, 1).map_err(|e| e.to_string())?;
    if tracks.len() != 2 { return Err("cycle reference preparation is incomplete".into()); }
    let first_entry = header["cycle_origin"]["entry_frame"].as_u64().ok_or("cycle first-source entry is missing")?;
    let leading_frames = header["cycle_origin"]["engine_frame"].as_u64().ok_or("cycle first-source engine frame is missing")?;
    if first_entry >= tracks[0].outro_start_out || first_entry >= tracks[0].frames { return Err("cycle first-source entry is outside the first track body".into()); }
    let mut last_a = tracks[0].clone();
    last_a.playlist_index = 2;
    tracks.push(last_a);
    let mut ordinary_entries = vec![tracks[0].first_downbeat_out, cached_first_entry(&options, &files[0])?];
    ordinary_entries.sort_unstable();
    ordinary_entries.dedup();
    let ordinary_tracks = tracks.clone();
    tracks[0].first_downbeat_out = first_entry;
    let limit = tracks.iter().try_fold(0u64, |count, track| count.checked_add(track.frames)).filter(|&count| count > 0 && count.checked_add(leading_frames).is_some_and(|all| all <= MAX_FRAMES))
        .ok_or("cycle reference exceeds the RIFF frame domain")?;
    let engine = Engine::from_prepared(options.clone(), tracks).map_err(|e| e.to_string())?;
    let wav = args[3].with_extension("wav");
    let metadata = args[3].with_extension("json");
    let mut output = BufWriter::new(OpenOptions::new().write(true).create_new(true).open(&wav).map_err(|e| e.to_string())?);
    output.write_all(b"RIFF\0\0\0\0WAVEfmt \x10\0\0\0\x03\0\x02\0\x80\xbb\0\0\0\xdc\x05\0\x08\0\x20\0data\0\0\0\0").map_err(|e| e.to_string())?;
    for _ in 0..leading_frames { output.write_all(&[0u8; 8]).map_err(|e| e.to_string())?; }
    let outcome = render(engine, limit, |samples| {
        for sample in samples { output.write_all(&sample.to_le_bytes()).map_err(|e| e.to_string())?; }
        Ok(())
    });
    let length = output.stream_position().map_err(|e| e.to_string())?;
    output.seek(SeekFrom::Start(4)).and_then(|_| output.write_all(&((length - 8) as u32).to_le_bytes()))
        .and_then(|_| output.seek(SeekFrom::Start(40))).and_then(|_| output.write_all(&((length - 44) as u32).to_le_bytes()))
        .and_then(|_| output.flush()).map_err(|e| e.to_string())?;
    output.get_ref().sync_all().map_err(|e| e.to_string())?;
    let (frames, events, error) = match outcome {
        Ok((frames, events)) => (frames + leading_frames, events, None),
        Err(error) => ((length - 44) / 8, Vec::new(), Some(error)),
    };
    let mut verified_initial_entries = vec![json!({ "entry_frame": first_entry, "source_frame_offset": 0, "frames": frames - leading_frames })];
    for ordinary_entry in ordinary_entries.into_iter().filter(|&entry| error.is_none() && entry > first_entry) {
        let offset = ordinary_entry - first_entry;
        let expected_frames = frames.checked_sub(leading_frames).and_then(|count| count.checked_sub(offset)).ok_or("cycle entry exceeds its source")?;
        let mut expected = BufReader::new(File::open(&wav).map_err(|e| e.to_string())?);
        expected.seek(SeekFrom::Start(44 + (leading_frames + offset) * 8)).map_err(|e| e.to_string())?;
        let mut variant = ordinary_tracks.clone();
        variant[0].first_downbeat_out = ordinary_entry;
        let ordinary = Engine::from_prepared(options.clone(), variant).map_err(|e| e.to_string())?;
        let mut digest = Sha256::new();
        let (actual_frames, _) = render(ordinary, limit, |samples| {
            let mut actual = Vec::with_capacity(samples.len() * 4);
            for sample in samples { actual.extend_from_slice(&sample.to_le_bytes()); }
            let mut reference = vec![0u8; actual.len()];
            expected.read_exact(&mut reference).map_err(|e| e.to_string())?;
            if actual != reference { return Err("ordinary initial entry does not match the reusable source PCM".into()); }
            digest.update(&actual);
            Ok(())
        })?;
        if actual_frames != expected_frames { return Err("ordinary initial entry changed the finite source length".into()); }
        verified_initial_entries.push(json!({ "entry_frame": ordinary_entry, "source_frame_offset": offset, "frames": actual_frames, "rendered_pcm_sha256": format!("{:x}", digest.finalize()) }));
    }
    let result = json!({ "schema": 1, "runtime": { "core_revision": env!("FUNKOT_CORE_GIT"), "marker": std::hint::black_box(CORE_MARKER) },
        "driver_source_sha256": format!("{:x}", Sha256::digest(include_bytes!("diagnostic_cycle_reference.rs"))),
        "transport_source_sha256": format!("{:x}", Sha256::digest(include_bytes!("../src/transport_fade.rs"))),
        "core_source_sha256": format!("{:x}", Sha256::digest(include_bytes!("../../../funkot-autodj-for-ui/funkot-core/src/engine.rs"))),
        "executable_sha256": hash(&std::env::current_exe().map_err(|e| e.to_string())?)?,
        "input_hashes": hashes, "occurrences": [0, 1, 0], "engine_options": options, "cycle_origin": header["cycle_origin"], "verified_initial_entries": verified_initial_entries,
        "output": { "file": wav, "sha256": hash(&wav)?, "frames": frames, "engine_frame_zero": 0, "rate": 48000 },
        "events": events, "outcome": error });
    let mut file = OpenOptions::new().write(true).create_new(true).open(metadata).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut file, &result).map_err(|e| e.to_string())?;
    file.write_all(b"\n").and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
    match error { Some(error) => Err(error), None => Ok(()) }
}

fn compose(args: &[PathBuf]) -> Result<(), String> {
    if args.len() != 5 { return Err("Usage: diagnostic_cycle_reference --compose reference.wav reference.json callbacks.csv navigation.jsonl output-prefix".into()); }
    let bytes = std::fs::read(&args[0]).map_err(|e| e.to_string())?;
    if bytes.len() < 44 || &bytes[..4] != b"RIFF" || &bytes[8..16] != b"WAVEfmt " || &bytes[36..40] != b"data" ||
        u16::from_le_bytes(bytes[20..22].try_into().unwrap()) != 3 || u16::from_le_bytes(bytes[22..24].try_into().unwrap()) != 2 ||
        u32::from_le_bytes(bytes[24..28].try_into().unwrap()) != 48000 || (bytes.len() - 44) % 8 != 0 ||
        u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize != bytes.len() - 44 {
        return Err("invalid cycle producer PCM".into());
    }
    let source: Vec<f32> = bytes[44..].chunks_exact(4).map(|part| f32::from_le_bytes(part.try_into().unwrap())).collect();
    let metadata: serde_json::Value = serde_json::from_slice(&std::fs::read(&args[1]).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if metadata["output"]["sha256"].as_str() != Some(hash(&args[0])?.as_str()) || metadata["runtime"]["core_revision"].as_str() != Some(env!("FUNKOT_CORE_GIT")) {
        return Err("cycle producer identity changed".into());
    }
    let trace = std::fs::read_to_string(&args[3]).map_err(|e| e.to_string())?;
    let sources: Vec<serde_json::Value> = trace.lines().map(serde_json::from_str::<serde_json::Value>)
        .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?.into_iter().filter(|row| row["kind"] == "cycle_source_started").collect();
    if sources.len() != 3 || sources.iter().enumerate().any(|(index, row)| row["index"].as_u64() != Some(index as u64)) {
        return Err("cycle source order is incomplete".into());
    }
    let first = sources[0]["engine_frame"].as_u64().ok_or("cycle source engine frame missing")?;
    let previous_first = metadata["cycle_origin"]["engine_frame"].as_u64().ok_or("reference source engine frame missing")?;
    let entry = metadata["verified_initial_entries"].as_array().and_then(|entries| entries.iter().find(|entry| entry["entry_frame"] == sources[0]["entry_frame"]))
        .ok_or("cycle initial source entry is not verified by the producer")?;
    let source_offset = entry["source_frame_offset"].as_u64().ok_or("cycle entry source offset is missing")?;
    let source_frames = (source.len() as u64 / 2).checked_sub(previous_first).and_then(|frames| frames.checked_sub(source_offset)).ok_or("cycle source range overflow")?;
    if entry["frames"].as_u64() != Some(source_frames) { return Err("cycle entry source extent changed".into()); }
    let engine_end = source_frames.checked_add(first).ok_or("cycle engine range overflow")?;
    let callbacks = std::fs::read_to_string(&args[2]).map_err(|e| e.to_string())?;
    let mut lines = callbacks.lines();
    if lines.next() != Some("sequence,callback_qpc_100ns,playback_qpc_100ns,output_frames,engine_start,engine_end,paused,audition,render_lock_miss,trace_dropped") {
        return Err("invalid cycle callback schema".into());
    }
    let mut fade = transport_fade::TransportFade::new(48000);
    let mut output = Vec::new();
    let mut spans = Vec::new();
    let mut last_engine = 0u64;
    let mut sequence = 0u64;
    for line in lines {
        let values: Vec<_> = line.split(',').collect();
        if values.len() != 10 { return Err("invalid cycle callback row".into()); }
        let number = |column: usize| values[column].parse::<u64>().map_err(|_| "invalid cycle callback number".to_owned());
        if number(0)? != sequence + 1 || number(7)? != 0 || number(8)? != 0 || number(9)? != 0 || number(6)? > 1 {
            return Err("cycle callback continuity or state fault".into());
        }
        sequence += 1;
        let frames = number(3)?;
        let start = output.len() as u64 / 2;
        if frames == 0 || start.checked_add(frames).is_none_or(|end| end > MAX_FRAMES) { return Err("cycle callback output range is invalid".into()); }
        let mut buffer = vec![0.0; frames as usize * 2];
        let mut rendered = 0usize;
        let mut kind = "intentional";
        let mut reason = "diagnostic_gate";
        if values[4].is_empty() || values[5].is_empty() {
            if !values[4].is_empty() || !values[5].is_empty() || number(6)? != 1 || (last_engine > 0 && last_engine != engine_end) { return Err("cycle gate interrupted its finite source".into()); }
        } else {
            let engine_start = number(4)?;
            let end = number(5)?;
            if engine_start != last_engine || end < engine_start || end > engine_end || end - engine_start > frames {
                return Err("cycle engine frame coverage changed".into());
            }
            let paused = number(6)? == 1;
            if paused && engine_start < engine_end { return Err("finite cycle was paused before natural end".into()); }
            let count = (end - engine_start) as usize;
            if count < frames as usize && end != engine_end { return Err("cycle short render preceded natural end".into()); }
            rendered = fade.render(&mut buffer, paused, |out| {
                assert!(count * 2 <= out.len());
                for index in 0..count {
                    let position = engine_start + index as u64;
                    if position >= first {
                        let reference = (position - first + previous_first + source_offset) as usize;
                        out[index * 2..index * 2 + 2].copy_from_slice(&source[reference * 2..reference * 2 + 2]);
                    }
                }
                count
            });
            if end <= first { reason = "engine_wait"; }
            else if rendered > 0 { kind = "audio"; reason = "rendered_source"; }
            else { reason = "paused"; }
            last_engine = end;
            if end == engine_end { fade.silence(); }
        }
        let prefix = if kind == "audio" { rendered as u64 } else { frames };
        spans.push(json!({ "start": start, "end": start + prefix, "kind": kind, "reason": reason, "first_sequence": sequence, "last_sequence": sequence }));
        if prefix < frames { spans.push(json!({ "start": start + prefix, "end": start + frames, "kind": "intentional", "reason": "engine_end_padding", "first_sequence": sequence, "last_sequence": sequence })); }
        output.extend(buffer);
    }
    if last_engine != engine_end { return Err("cycle engine did not cover the complete reference".into()); }
    let wave = args[4].with_extension("wav");
    let mut file = BufWriter::new(OpenOptions::new().write(true).create_new(true).open(&wave).map_err(|e| e.to_string())?);
    let data_bytes = output.len() as u32 * 4;
    file.write_all(b"RIFF").and_then(|_| file.write_all(&(data_bytes + 36).to_le_bytes())).and_then(|_| file.write_all(b"WAVEfmt \x10\0\0\0\x03\0\x02\0\x80\xbb\0\0\0\xdc\x05\0\x08\0\x20\0data"))
        .and_then(|_| file.write_all(&data_bytes.to_le_bytes())).map_err(|e| e.to_string())?;
    for sample in &output { file.write_all(&sample.to_le_bytes()).map_err(|e| e.to_string())?; }
    file.flush().and_then(|_| file.get_ref().sync_all()).map_err(|e| e.to_string())?;
    let value = json!({ "schema": 1, "runtime": { "core_revision": env!("FUNKOT_CORE_GIT") }, "engine_start_frame": first, "engine_end_frame": engine_end,
        "driver_source_sha256": format!("{:x}", Sha256::digest(include_bytes!("diagnostic_cycle_reference.rs"))),
        "transport_source_sha256": format!("{:x}", Sha256::digest(include_bytes!("../src/transport_fade.rs"))),
        "reference_sha256": hash(&args[0])?, "callbacks_sha256": hash(&args[2])?, "trace_sha256": hash(&args[3])?,
        "output": { "file": wave, "sha256": hash(&wave)?, "frames": output.len() / 2 }, "spans": spans, "sources": sources, "outcome": null });
    let mut meta = OpenOptions::new().write(true).create_new(true).open(args[4].with_extension("json")).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut meta, &value).map_err(|e| e.to_string())?;
    meta.write_all(b"\n").and_then(|_| meta.sync_all()).map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    if let Err(error) = run() { eprintln!("{error}"); std::process::exit(1); }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(directory: &Path, callbacks: &str, first_engine: u64) -> Vec<PathBuf> {
        let wave = directory.join("source.wav");
        let mut bytes = b"RIFF\x54\0\0\0WAVEfmt \x10\0\0\0\x03\0\x02\0\x80\xbb\0\0\0\xdc\x05\0\x08\0\x20\0data\x30\0\0\0".to_vec();
        for _ in 0..12 { bytes.extend_from_slice(&0.25f32.to_le_bytes()); }
        std::fs::write(&wave, bytes).unwrap();
        let metadata = directory.join("source.json");
        std::fs::write(&metadata, serde_json::to_vec(&json!({
            "output": { "sha256": hash(&wave).unwrap() },
            "runtime": { "core_revision": env!("FUNKOT_CORE_GIT") },
            "cycle_origin": { "entry_frame": 7, "engine_frame": 0 },
            "verified_initial_entries": [{ "entry_frame": 7, "source_frame_offset": 0, "frames": 6 }, { "entry_frame": 9, "source_frame_offset": 2, "frames": 4 }]
        })).unwrap()).unwrap();
        let rows = directory.join("callbacks.csv");
        std::fs::write(&rows, format!("sequence,callback_qpc_100ns,playback_qpc_100ns,output_frames,engine_start,engine_end,paused,audition,render_lock_miss,trace_dropped\n{callbacks}")).unwrap();
        let trace = directory.join("trace.jsonl");
        let mut file = File::create(&trace).unwrap();
        for index in 0..3 {
            writeln!(file, "{}", json!({ "kind": "cycle_source_started", "index": index, "entry_frame": 7, "engine_frame": first_engine + index * 2 })).unwrap();
        }
        vec![wave, metadata, rows, trace, directory.join("expected")]
    }

    #[test]
    fn observed_callback_output_has_exact_startup_source_and_natural_end_spans() {
        let directory = tempfile::tempdir().unwrap();
        let args = fixture(directory.path(), "1,1,1,3,,,1,0,0,0\n2,2,2,8,0,6,0,0,0,0\n3,3,3,2,6,6,1,0,0,0\n", 0);
        compose(&args).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&std::fs::read(args[4].with_extension("json")).unwrap()).unwrap();
        assert_eq!(value["output"]["frames"], 13);
        assert_eq!(value["spans"][0]["reason"], "diagnostic_gate");
        assert_eq!(value["spans"][1]["end"], 9);
        assert_eq!(value["spans"][2]["reason"], "engine_end_padding");
        assert_eq!(value["spans"][2]["end"], 11);
        assert_eq!(value["spans"][3]["reason"], "paused");
        let bytes = std::fs::read(args[4].with_extension("wav")).unwrap();
        assert!(bytes[44..68].iter().all(|byte| *byte == 0));
        assert!(bytes[44 + 9 * 8..].iter().all(|byte| *byte == 0));
    }

    #[test]
    fn changed_startup_wait_reuses_the_same_source_without_changing_its_samples() {
        let directory = tempfile::tempdir().unwrap();
        let args = fixture(directory.path(), "1,1,1,2,0,2,0,0,0,0\n2,2,2,8,2,8,0,0,0,0\n", 2);
        compose(&args).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&std::fs::read(args[4].with_extension("json")).unwrap()).unwrap();
        assert_eq!(value["engine_end_frame"], 8);
        assert_eq!(value["spans"][0]["reason"], "engine_wait");
        assert_eq!(value["spans"][1]["end"], 8);
        let bytes = std::fs::read(args[4].with_extension("wav")).unwrap();
        assert!(bytes[44..44 + 3 * 8].iter().all(|byte| *byte == 0));
        assert_eq!(f32::from_le_bytes(bytes[44 + 3 * 8..48 + 3 * 8].try_into().unwrap()), 0.25 / 479.0);
    }

    #[test]
    fn only_a_producer_verified_initial_entry_can_reuse_a_source_suffix() {
        let directory = tempfile::tempdir().unwrap();
        let args = fixture(directory.path(), "1,1,1,6,0,4,0,0,0,0\n", 0);
        let trace = std::fs::read_to_string(&args[3]).unwrap().replacen("\"entry_frame\":7", "\"entry_frame\":9", 1);
        std::fs::write(&args[3], &trace).unwrap();
        compose(&args).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&std::fs::read(args[4].with_extension("json")).unwrap()).unwrap();
        assert_eq!(value["engine_end_frame"], 4);
        std::fs::write(&args[3], trace.replacen("\"entry_frame\":9", "\"entry_frame\":8", 1)).unwrap();
        assert!(compose(&args).unwrap_err().contains("not verified by the producer"));
    }

    #[test]
    fn a_missing_frame_false_pause_or_unpaused_gate_cannot_cover_a_finite_source() {
        for rows in [
            "1,1,1,5,0,5,0,0,0,0\n",
            "1,1,1,6,0,6,1,0,0,0\n",
            "1,1,1,3,,,0,0,0,0\n2,2,2,6,0,6,0,0,0,0\n",
        ] {
            let directory = tempfile::tempdir().unwrap();
            assert!(compose(&fixture(directory.path(), rows, 0)).is_err());
        }
    }
}
