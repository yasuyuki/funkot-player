use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use sha2::{Digest, Sha256};
use serde_json::{json, Value};
use funkot_core::engine::{prepare_first_live_replay, prepare_first_live_replay_from_recorded, prepare_track, Engine, EngineEvent, FirstLiveReplayEvidence, FirstLiveReplayRecipe, FirstLiveReplaySchedule, FirstLiveReplayUpgradeAdoption};
use funkot_core::EngineOptions;
#[path = "../src/transport_fade.rs"]
mod transport_fade;

const CORE_MARKER: &str = concat!("FUNKOT_CYCLE_CORE_REVISION:", env!("FUNKOT_CORE_GIT"), ":END");
const MAX_FRAMES: u64 = (u32::MAX as u64 - 36) / 8;
const CALLBACK_HEADER: &str = "sequence,callback_qpc_100ns,playback_qpc_100ns,output_frames,engine_start,engine_end,paused,audition,render_lock_miss,trace_dropped";

#[derive(Debug)]
struct Callback { sequence: u64, output_frames: u64, engine_start: Option<u64>, engine_end: Option<u64>, paused: bool }

fn hash(path: &Path) -> Result<String, String> {
    let mut value = Sha256::new();
    std::io::copy(&mut File::open(path).map_err(|e| e.to_string())?, &mut value).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", value.finalize()))
}

fn parse_callbacks(path: &Path) -> Result<Vec<Callback>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut lines = text.lines();
    if lines.next() != Some(CALLBACK_HEADER) { return Err("invalid cycle callback schema".into()); }
    lines.enumerate().map(|(position, line)| {
        let values: Vec<_> = line.split(',').collect();
        if values.len() != 10 { return Err("invalid cycle callback row".into()); }
        let number = |column: usize| values[column].parse::<u64>().map_err(|_| "invalid cycle callback number".to_owned());
        let optional = |column: usize| if values[column].is_empty() { Ok(None) } else { number(column).map(Some) };
        let sequence = number(0)?; let paused = number(6)?;
        if sequence != position as u64 + 1 || paused > 1 || number(7)? != 0 || number(8)? != 0 || number(9)? != 0 { return Err("cycle callback continuity or state fault".into()); }
        let engine_start = optional(4)?; let engine_end = optional(5)?;
        if engine_start.is_some() != engine_end.is_some() { return Err("cycle callback engine range is incomplete".into()); }
        Ok(Callback { sequence, output_frames: number(3)?, engine_start, engine_end, paused: paused == 1 })
    }).collect()
}

fn trace_rows(path: &Path) -> Result<Vec<Value>, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())?.lines().map(serde_json::from_str).collect::<Result<Vec<Value>, _>>().map_err(|e| e.to_string())
}

fn write_wave_new(path: &Path, samples: &[f32]) -> Result<(), String> {
    if !samples.len().is_multiple_of(2) || samples.len() as u64 / 2 > MAX_FRAMES { return Err("cycle reference output exceeds RIFF frame domain".into()); }
    let bytes = (samples.len() * 4) as u32;
    let mut file = BufWriter::new(OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| e.to_string())?);
    file.write_all(b"RIFF").and_then(|_| file.write_all(&(bytes + 36).to_le_bytes())).and_then(|_| file.write_all(b"WAVEfmt \x10\0\0\0\x03\0\x02\0\x80\xbb\0\0\0\xdc\x05\0\x08\0\x20\0data")).and_then(|_| file.write_all(&bytes.to_le_bytes())).map_err(|e| e.to_string())?;
    for sample in samples { file.write_all(&sample.to_le_bytes()).map_err(|e| e.to_string())?; }
    file.flush().and_then(|_| file.get_ref().sync_all()).map_err(|e| e.to_string())
}

fn write_json_new(path: &Path, value: &Value) -> Result<(), String> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut file, value).map_err(|e| e.to_string())?;
    file.write_all(b"\n").and_then(|_| file.sync_all()).map_err(|e| e.to_string())
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

fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    run_args(&args)
}

fn run_args(args: &[PathBuf]) -> Result<(), String> {
    if args.first().is_some_and(|arg| arg == Path::new("--compose")) { return compose(&args[1..]); }
    if args.first().is_some_and(|arg| arg == Path::new("--historical-candidate")) { return historical(&args[1..]); }
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
    let callback_path = PathBuf::from(header["cycle_trace"]["callbacks"].as_str().ok_or("cycle callback trace path is missing")?);
    let navigation_path = PathBuf::from(header["cycle_trace"]["navigation"].as_str().ok_or("cycle navigation trace path is missing")?);
    let callback_sha256 = hash(&callback_path)?;
    let navigation_sha256 = hash(&navigation_path)?;
    let callbacks = parse_callbacks(&callback_path)?;
    let navigation = trace_rows(&navigation_path)?;
    let sources: Vec<_> = navigation.iter().filter(|row| row["kind"] == "cycle_source_started").collect();
    if sources.len() != 3 || sources.iter().enumerate().any(|(index, row)| row["index"].as_u64() != Some(index as u64)) ||
        sources[0] != &header["cycle_origin"] || navigation.iter().filter(|row| row["kind"] == "cycle_first_live_preparation").count() != 1 {
        return Err("cycle source or first-live navigation evidence is incomplete".into());
    }
    let mut options: EngineOptions = serde_json::from_value(header["options"].clone()).map_err(|e| e.to_string())?;
    if options.output_sample_rate != 48_000 { return Err("cycle reference requires 48 kHz".into()); }
    options.cache_dir = args[2].clone();
    let first_live = &header["first_live"];
    let preparation = first_live.get("preparation").ok_or("cycle first-live preparation is missing")?;
    let recipe = FirstLiveReplayRecipe::from_recorded_json(&serde_json::to_vec(&preparation["recipe"]).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let evidence: FirstLiveReplayEvidence = serde_json::from_value(preparation["evidence"].clone()).map_err(|e| e.to_string())?;
    let schedule: FirstLiveReplaySchedule = serde_json::from_value(first_live["schedule"].clone()).map_err(|e| e.to_string())?;
    let mode = preparation["mode"].as_str().ok_or("cycle first-live mode is missing")?;
    if evidence.playlist_index != 0 || !evidence.is_comparable() || recipe.has_preview() != (mode == "preview_full") || !matches!(mode, "preview_full" | "single") {
        return Err("cycle first-live provenance is invalid".into());
    }
    let ready = preparation["ready_engine_frame"].as_u64().ok_or("cycle first-live readiness is missing")?;
    if callbacks.iter().filter(|row| !row.paused && row.engine_start.is_some_and(|start| start <= ready && ready < row.engine_end.unwrap())).count() != 1 {
        return Err("cycle first-live readiness is not covered by one callback".into());
    }
    let first = prepare_first_live_replay_from_recorded(&options, &files[0], 0, &recipe, evidence).map_err(|e| e.to_string())?;
    let later = vec![prepare_track(&options, &files[1], 1).map_err(|e| e.to_string())?, prepare_track(&options, &files[0], 2).map_err(|e| e.to_string())?];
    let engine = Engine::from_prepared_first_live(options.clone(), first, later, schedule).map_err(|e| e.to_string())?;
    let limit = MAX_FRAMES;
    let wav = args[3].with_extension("wav");
    let metadata = args[3].with_extension("json");
    let mut output = BufWriter::new(OpenOptions::new().write(true).create_new(true).open(&wav).map_err(|e| e.to_string())?);
    output.write_all(b"RIFF\0\0\0\0WAVEfmt \x10\0\0\0\x03\0\x02\0\x80\xbb\0\0\0\xdc\x05\0\x08\0\x20\0data\0\0\0\0").map_err(|e| e.to_string())?;
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
        Ok((frames, events)) => (frames, events, None),
        Err(error) => ((length - 44) / 8, Vec::new(), Some(error)),
    };
    if files.iter().zip(&hashes).any(|(file, expected)| hash(file).as_deref() != Ok(expected.as_str())) || hash(&callback_path)? != callback_sha256 || hash(&navigation_path)? != navigation_sha256 { return Err("cycle source or trace changed while rendering".into()); }
    let result = json!({ "schema": 1, "runtime": { "core_revision": env!("FUNKOT_CORE_GIT"), "marker": std::hint::black_box(CORE_MARKER) },
        "driver_source_sha256": format!("{:x}", Sha256::digest(include_bytes!("diagnostic_cycle_reference.rs"))),
        "transport_source_sha256": format!("{:x}", Sha256::digest(include_bytes!("../src/transport_fade.rs"))),
        "core_source_sha256": format!("{:x}", Sha256::digest(include_bytes!("../../../funkot-autodj-for-ui/funkot-core/src/engine.rs"))),
        "executable_sha256": hash(&std::env::current_exe().map_err(|e| e.to_string())?)?,
        "startup_model": "first_live_engine_v1", "historical_candidate": false, "input_manifest": { "path": args[0], "sha256": hash(&args[0])? },
        "capture_header": { "path": args[1], "sha256": hash(&args[1])? }, "input_hashes": hashes, "occurrences": [0, 1, 0], "engine_options": options,
        "cycle_origin": header["cycle_origin"], "first_live": first_live, "cycle_trace": header["cycle_trace"],
        "trace_hashes": { "callbacks": callback_sha256, "navigation": navigation_sha256 },
        "output": { "file": wav, "sha256": hash(&wav)?, "frames": frames, "engine_frame_zero": 0, "rate": 48000 },
        "events": events, "outcome": error });
    let mut file = OpenOptions::new().write(true).create_new(true).open(metadata).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut file, &result).map_err(|e| e.to_string())?;
    file.write_all(b"\n").and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
    match error { Some(error) => Err(error), None => Ok(()) }
}

fn compose(args: &[PathBuf]) -> Result<(), String> {
    if args.len() != 5 { return Err("Usage: diagnostic_cycle_reference --compose reference.wav reference.json callbacks.csv navigation.jsonl output-prefix".into()); }
    let metadata: Value = serde_json::from_slice(&std::fs::read(&args[1]).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if metadata["startup_model"] != "first_live_engine_v1" || metadata["historical_candidate"] != false ||
        metadata["output"]["sha256"].as_str() != Some(hash(&args[0])?.as_str()) || metadata["runtime"]["core_revision"].as_str() != Some(env!("FUNKOT_CORE_GIT")) {
        return Err("cycle producer identity changed".into());
    }
    let manifest = PathBuf::from(metadata["input_manifest"]["path"].as_str().ok_or("cycle producer input manifest is missing")?);
    if metadata["input_manifest"]["sha256"].as_str() != Some(hash(&manifest)?.as_str()) { return Err("cycle producer input manifest changed".into()); }
    let value: Value = serde_json::from_slice(&std::fs::read(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let entries = value["files"].as_array().filter(|items| items.len() == 2).ok_or("cycle reference needs two fixed inputs")?;
    let base = manifest.parent().unwrap_or_else(|| Path::new("."));
    let files: Vec<PathBuf> = entries.iter().map(|item| Ok(base.join(item["file"].as_str().ok_or("cycle input path is missing")?))).collect::<Result<_, String>>()?;
    let hashes: Vec<String> = files.iter().map(|file| hash(file)).collect::<Result<_, _>>()?;
    if metadata["input_hashes"] != json!(hashes) { return Err("cycle source input changed".into()); }
    let callbacks = parse_callbacks(&args[2])?;
    let navigation = trace_rows(&args[3])?;
    let expected_sources: Vec<Value> = navigation.iter().filter(|row| row["kind"] == "cycle_source_started").cloned().collect();
    if expected_sources.len() != 3 { return Err("cycle source order is incomplete".into()); }
    let preparations: Vec<&Value> = navigation.iter().filter(|row| row["kind"] == "cycle_first_live_preparation").collect();
    if preparations.len() != 1 { return Err("current cycle first-live preparation is missing or duplicated".into()); }
    let preparation = preparations[0];
    let active_upgrades: Vec<&Value> = navigation.iter().filter(|row| row["kind"] == "cycle_preview_upgrade").collect();
    if active_upgrades.len() > 1 { return Err("current cycle preview upgrade is duplicated".into()); }
    let queued = preparation["queued_upgrade_at_render_frame"].as_u64();
    let upgrade = active_upgrades.first().copied();
    let schedule = FirstLiveReplaySchedule { ready_at_render_frame: preparation["ready_engine_frame"].as_u64().ok_or("current first-live ready frame is missing")?,
        upgrade_at_render_frame: queued.or_else(|| upgrade.and_then(|row| row["render_frame"].as_u64())),
        upgrade_adoption: if queued.is_some() { Some(FirstLiveReplayUpgradeAdoption::Queued) } else if upgrade.is_some() { Some(FirstLiveReplayUpgradeAdoption::Active) } else { None } };
    let recipe = FirstLiveReplayRecipe::from_recorded_json(&serde_json::to_vec(&preparation["recipe"]).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let evidence: FirstLiveReplayEvidence = serde_json::from_value(preparation["evidence"].clone()).map_err(|e| e.to_string())?;
    let options: EngineOptions = serde_json::from_value(metadata["engine_options"].clone()).map_err(|e| e.to_string())?;
    let first = prepare_first_live_replay_from_recorded(&options, &files[0], 0, &recipe, evidence).map_err(|e| e.to_string())?;
    let later = vec![prepare_track(&options, &files[1], 1).map_err(|e| e.to_string())?, prepare_track(&options, &files[0], 2).map_err(|e| e.to_string())?];
    let mut engine = Engine::from_prepared_first_live(options, first, later, schedule).map_err(|e| e.to_string())?;
    let mut fade = transport_fade::TransportFade::new(48_000);
    let mut output = Vec::new(); let mut spans = Vec::new(); let mut sources = Vec::new(); let mut upgrades = Vec::new(); let mut previous_upgrades = 0;
    for callback in &callbacks {
        let start = output.len() as u64 / 2; let engine_start = engine.render_frame();
        if callback.engine_start.is_some() && callback.engine_start != Some(engine_start) { return Err("cycle callback engine start changed".into()); }
        let mut buffer = vec![0.0; callback.output_frames as usize * 2];
        let count = fade.render(&mut buffer, callback.paused, |out| engine.render(out));
        if callback.engine_end != Some(engine.render_frame()) && callback.engine_end.is_some() { return Err(format!("cycle callback engine end changed at {}: expected {:?}, actual {}", callback.sequence, callback.engine_end, engine.render_frame())); }
        if callback.engine_start.is_none() && (!callback.paused || count != 0) { return Err("cycle gate changed engine state".into()); }
        for event in engine.poll_events() { match event {
            EngineEvent::TrackStarted { index, entry_frame_out, .. } => sources.push(json!({ "kind": "cycle_source_started", "index": index, "entry_frame": entry_frame_out, "engine_frame": engine_start })),
            EngineEvent::TrackFailed { .. } => return Err("cycle reference track failed".into()), _ => {}
        } }
        let after = engine.render_diagnostics();
        if after.preview_upgrades > previous_upgrades { let upgrade = after.last_preview_upgrade.ok_or("cycle preview upgrade diagnostic missing")?;
            upgrades.push(json!({ "render_frame": upgrade.render_frame, "playlist_index": upgrade.playlist_index, "playhead": upgrade.playhead, "preview_frames": upgrade.preview_frames, "evidence": upgrade.evidence })); previous_upgrades = after.preview_upgrades; }
        if count > 0 { spans.push(json!({ "start": start, "end": start + count as u64, "kind": "audio", "reason": "engine_render", "first_sequence": callback.sequence, "last_sequence": callback.sequence })); }
        if count < callback.output_frames as usize { let reason = if callback.paused { "paused" } else { "engine_end_padding" }; spans.push(json!({ "start": start + count as u64, "end": start + callback.output_frames, "kind": "intentional", "reason": reason, "first_sequence": callback.sequence, "last_sequence": callback.sequence })); }
        output.extend(buffer);
    }
    if !engine.is_finished() || sources != expected_sources { return Err("cycle replay did not match the natural source sequence".into()); }
    let observation = engine.first_live_replay_observation().ok_or("cycle replay lost first-live evidence")?;
    let actual = json!({ "ready_engine_frame": observation.ready_at_render_frame, "evidence": observation.evidence, "recipe": &*observation.recipe, "queued_upgrade_at_render_frame": observation.queued_upgrade_at_render_frame });
    let expected_upgrades = upgrade.map(|row| vec![json!({ "render_frame": row["render_frame"], "playlist_index": row["playlist_index"], "playhead": row["playhead"], "preview_frames": row["preview_frames"], "evidence": row["evidence"] })]).unwrap_or_default();
    if actual != json!({ "ready_engine_frame": preparation["ready_engine_frame"], "evidence": preparation["evidence"], "recipe": preparation["recipe"], "queued_upgrade_at_render_frame": preparation["queued_upgrade_at_render_frame"] }) || upgrades != expected_upgrades { return Err("cycle replay first-live adoption changed".into()); }
    let wave = args[4].with_extension("wav"); write_wave_new(&wave, &output)?;
    if files.iter().zip(&hashes).any(|(file, expected)| hash(file).as_deref() != Ok(expected.as_str())) { return Err("cycle source changed while rendering".into()); }
    let result = json!({ "schema": 1, "startup_model": "first_live_engine_v1", "historical_candidate": false, "runtime": { "core_revision": env!("FUNKOT_CORE_GIT") }, "engine_start_frame": 0, "engine_end_frame": engine.render_frame(),
        "driver_source_sha256": format!("{:x}", Sha256::digest(include_bytes!("diagnostic_cycle_reference.rs"))), "transport_source_sha256": format!("{:x}", Sha256::digest(include_bytes!("../src/transport_fade.rs"))),
        "reference_sha256": hash(&args[0])?, "callbacks_sha256": hash(&args[2])?, "trace_sha256": hash(&args[3])?, "output": { "file": wave, "sha256": hash(&wave)?, "frames": output.len() / 2 }, "spans": spans, "sources": sources,
        "first_live": { "preparation": preparation, "upgrade": upgrade, "schedule": schedule }, "actual_first_live": actual,
        "preview_wait_frames": engine.render_diagnostics().preview_wait_frames, "outcome": null });
    write_json_new(&args[4].with_extension("json"), &result)
}

fn historical(args: &[PathBuf]) -> Result<(), String> {
    if args.len() != 7 { return Err("Usage: diagnostic_cycle_reference --historical-candidate input-manifest.json capture-header.json callbacks.csv navigation.jsonl cache-directory output-prefix adopted-engine-frame".into()); }
    let manifest: Value = serde_json::from_slice(&std::fs::read(&args[0]).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let entries = manifest["files"].as_array().filter(|items| items.len() == 2).ok_or("cycle reference needs two fixed inputs")?;
    let base = args[0].parent().unwrap_or_else(|| Path::new("."));
    let files: Vec<PathBuf> = entries.iter().map(|item| Ok(base.join(item["file"].as_str().ok_or("cycle input path is missing")?))).collect::<Result<_, String>>()?;
    let hashes: Vec<String> = files.iter().map(|path| hash(path)).collect::<Result<_, _>>()?;
    if entries.iter().zip(&hashes).any(|(item, actual)| item["sha256"].as_str() != Some(actual)) { return Err("cycle input hash does not match".into()); }
    let header: Value = serde_json::from_slice(&std::fs::read(&args[1]).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut options: EngineOptions = serde_json::from_value(header["options"].clone()).map_err(|e| e.to_string())?;
    if options.output_sample_rate != 48_000 { return Err("cycle reference requires 48 kHz".into()); }
    options.cache_dir = args[4].clone();
    let adopted = args[6].to_string_lossy().parse::<u64>().map_err(|_| "historical adopted engine frame is invalid".to_owned())?;
    let first = prepare_first_live_replay(&options, &files[0], 0).map_err(|e| e.to_string())?;
    let later = vec![prepare_track(&options, &files[1], 1).map_err(|e| e.to_string())?, prepare_track(&options, &files[0], 2).map_err(|e| e.to_string())?];
    let mut engine = Engine::from_prepared_first_live(options.clone(), first, later, FirstLiveReplaySchedule { ready_at_render_frame: 0,
        upgrade_at_render_frame: Some(adopted), upgrade_adoption: Some(FirstLiveReplayUpgradeAdoption::Active) }).map_err(|e| e.to_string())?;
    let callbacks_sha256 = hash(&args[2])?; let trace_sha256 = hash(&args[3])?;
    let callbacks = parse_callbacks(&args[2])?; let navigation = trace_rows(&args[3])?;
    let expected_sources: Vec<Value> = navigation.iter().filter(|row| row["kind"] == "cycle_source_started").cloned().collect();
    if expected_sources.len() != 3 { return Err("historical cycle source order is incomplete".into()); }
    let mut fade = transport_fade::TransportFade::new(48_000); let mut output = Vec::new(); let mut sources = Vec::new();
    for callback in callbacks { let engine_start = engine.render_frame(); let mut count = 0; let mut buffer = vec![0.0; callback.output_frames as usize * 2];
        fade.render(&mut buffer, callback.paused, |out| { count = engine.render(out); count });
        if callback.engine_start.is_some() && (callback.engine_start != Some(engine_start) || callback.engine_end != Some(engine.render_frame())) { return Err("historical callback engine extent changed".into()); }
        if callback.engine_start.is_none() && (!callback.paused || count != 0) { return Err("historical callback gate changed engine state".into()); }
        for event in engine.poll_events() { match event { EngineEvent::TrackStarted { index, entry_frame_out, .. } => sources.push(json!({ "kind": "cycle_source_started", "index": index, "entry_frame": entry_frame_out, "engine_frame": engine_start })), EngineEvent::TrackFailed { .. } => return Err("historical cycle track failed".into()), _ => {} } }
        output.extend(buffer);
    }
    if !engine.is_finished() || sources != expected_sources { return Err("historical replay did not match the captured natural source sequence".into()); }
    if files.iter().zip(&hashes).any(|(file, expected)| hash(file).as_deref() != Ok(expected.as_str())) ||
        hash(&args[2])? != callbacks_sha256 || hash(&args[3])? != trace_sha256 {
        return Err("historical replay inputs changed while rendering".into());
    }
    let observation = engine.first_live_replay_observation().ok_or("historical replay lost its producer observation")?;
    let wave = args[5].with_extension("wav"); write_wave_new(&wave, &output)?;
    let result = json!({ "schema": 1, "startup_model": "first_live_engine_v1", "historical_candidate": true, "observed_upgrade": false,
        "soundQuality": "incomplete", "diagnostic_only": true, "old_capture_core_revision": header["core_git"],
        "runtime": { "core_revision": env!("FUNKOT_CORE_GIT"), "marker": std::hint::black_box(CORE_MARKER) }, "input_hashes": hashes,
        "engine_options": options, "adopted_engine_frame_hypothesis": adopted, "ready_engine_frame_hypothesis": 0,
        "callbacks_sha256": callbacks_sha256, "trace_sha256": trace_sha256, "sources": sources,
        "replay_producer": { "evidence": observation.evidence, "recipe": &*observation.recipe },
        "driver_source_sha256": format!("{:x}", Sha256::digest(include_bytes!("diagnostic_cycle_reference.rs"))),
        "executable_sha256": hash(&std::env::current_exe().map_err(|e| e.to_string())?)?,
        "output": { "file": wave, "sha256": hash(&wave)?, "frames": output.len() / 2 }, "outcome": { "classification": "historical_hypothesis" } });
    write_json_new(&args[5].with_extension("json"), &result)
}

fn main() {
    if let Err(error) = run() { eprintln!("{error}"); std::process::exit(1); }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_input(path: &Path, phase: f32) {
        let rate = 8_000u32; let frames = rate as usize * 31; let bytes = (frames * 8) as u32;
        let mut file = BufWriter::new(File::create(path).unwrap());
        file.write_all(b"RIFF").unwrap(); file.write_all(&(bytes + 36).to_le_bytes()).unwrap();
        file.write_all(b"WAVEfmt \x10\0\0\0\x03\0\x02\0\x40\x1f\0\0\0\xfa\0\0\x08\0\x20\0data").unwrap(); file.write_all(&bytes.to_le_bytes()).unwrap();
        for frame in 0..frames { let sample = ((frame as f32 / rate as f32 * 6.0 + phase).sin() * 0.2).to_le_bytes(); file.write_all(&sample).unwrap(); file.write_all(&sample).unwrap(); }
        file.flush().unwrap();
    }

    #[test]
    fn real_first_live_preparation_observes_delayed_active_and_queued_schedules() {
        let directory = tempfile::tempdir().unwrap(); let input = directory.path().join("a.wav"); write_input(&input, 0.0);
        let options = EngineOptions { output_sample_rate: 48_000, cache_dir: directory.path().join("cache"), loop_playlist: false, ..EngineOptions::default() };
        for (at, adoption) in [(17, FirstLiveReplayUpgradeAdoption::Active), (7, FirstLiveReplayUpgradeAdoption::Queued)] {
            let first = prepare_first_live_replay(&options, &input, 0).unwrap();
            let mut engine = Engine::from_prepared_first_live(options.clone(), first, vec![], FirstLiveReplaySchedule { ready_at_render_frame: 7, upgrade_at_render_frame: Some(at), upgrade_adoption: Some(adoption) }).unwrap();
            let mut fade = transport_fade::TransportFade::new(48_000); let mut output = [0.0; 48];
            fade.render(&mut output, false, |out| engine.render(out)); let _ = engine.poll_events();
            let observation = engine.first_live_replay_observation().unwrap(); assert_eq!(observation.ready_at_render_frame, 7);
            match adoption { FirstLiveReplayUpgradeAdoption::Active => assert_eq!(engine.render_diagnostics().last_preview_upgrade.unwrap().render_frame, at),
                FirstLiveReplayUpgradeAdoption::Queued => assert_eq!(observation.queued_upgrade_at_render_frame, Some(at)) }
        }
    }

    fn end_to_end_cycle(directory: &Path, upgrade_at: u64, name: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf, PathBuf) {
        let a = directory.join("a.wav"); let b = directory.join("b.wav"); write_input(&a, 0.0); write_input(&b, 0.7);
        let manifest = directory.join(format!("{name}-inputs.json"));
        write_json_new(&manifest, &json!({ "files": [{ "file": "a.wav", "sha256": hash(&a).unwrap() }, { "file": "b.wav", "sha256": hash(&b).unwrap() }] })).unwrap();
        let options = EngineOptions { output_sample_rate: 48_000, cache_dir: directory.join(format!("{name}-captured-cache")), loop_playlist: false, ..EngineOptions::default() };
        let first = prepare_first_live_replay(&options, &a, 0).unwrap();
        let later = vec![prepare_track(&options, &b, 1).unwrap(), prepare_track(&options, &a, 2).unwrap()];
        let schedule = FirstLiveReplaySchedule { ready_at_render_frame: 7, upgrade_at_render_frame: Some(upgrade_at), upgrade_adoption: Some(FirstLiveReplayUpgradeAdoption::Active) };
        let mut engine = Engine::from_prepared_first_live(options.clone(), first, later, schedule).unwrap();
        let callbacks = directory.join(format!("{name}-callbacks.csv")); let navigation = directory.join(format!("{name}-navigation.jsonl"));
        let mut rows = format!("{CALLBACK_HEADER}\n"); let mut nav = Vec::new(); let mut fade = transport_fade::TransportFade::new(48_000); let mut sequence = 0; let mut upgrades = 0; let mut preparation = None;
        while !engine.is_finished() { sequence += 1; let start = engine.render_frame(); let mut buffer = vec![0.0; 65_536 * 2];
            fade.render(&mut buffer, false, |out| { let mut count = 0; for frame in out.chunks_exact_mut(2) { if engine.render(frame) == 0 { break; } count += 1; } count }); let end = engine.render_frame();
            rows.push_str(&format!("{sequence},0,0,65536,{start},{end},0,0,0,0\n"));
            for event in engine.poll_events() { if let EngineEvent::TrackStarted { index, entry_frame_out, .. } = event { nav.push(json!({ "kind": "cycle_source_started", "index": index, "entry_frame": entry_frame_out, "engine_frame": start })); } }
            let diagnostics = engine.render_diagnostics(); if diagnostics.preview_upgrades > upgrades { let upgrade = diagnostics.last_preview_upgrade.unwrap(); upgrades = diagnostics.preview_upgrades; nav.push(json!({ "kind": "cycle_preview_upgrade", "count": upgrades, "playlist_index": upgrade.playlist_index, "playhead": upgrade.playhead, "preview_frames": upgrade.preview_frames, "render_frame": upgrade.render_frame, "callback_sequence": sequence, "evidence": upgrade.evidence })); }
            if preparation.is_none() { if let Some(observed) = engine.first_live_replay_observation() { let row = json!({ "kind": "cycle_first_live_preparation", "callback_sequence": sequence, "mode": if observed.recipe.has_preview() { "preview_full" } else { "single" }, "ready_engine_frame": observed.ready_at_render_frame, "queued_upgrade_at_render_frame": observed.queued_upgrade_at_render_frame, "recipe": &*observed.recipe, "evidence": observed.evidence }); preparation = Some(row.clone()); nav.push(row); } }
        }
        let prep = preparation.unwrap(); let origin = nav.iter().find(|row| row["kind"] == "cycle_source_started" && row["index"] == 0).unwrap().clone(); let upgrade = nav.iter().find(|row| row["kind"] == "cycle_preview_upgrade").cloned();
        std::fs::write(&callbacks, rows).unwrap(); std::fs::write(&navigation, nav.iter().map(|row| format!("{}\n", serde_json::to_string(row).unwrap())).collect::<String>()).unwrap();
        let header = directory.join(format!("{name}-header.json")); write_json_new(&header, &json!({ "core_git": env!("FUNKOT_CORE_GIT"), "options": options, "cycle_origin": origin,
            "first_live": { "preparation": prep, "upgrade": upgrade, "schedule": schedule }, "cycle_trace": { "callbacks": callbacks, "navigation": navigation } })).unwrap();
        let fresh = directory.join(format!("{name}-fresh")); run_args(&[manifest.clone(), header, directory.join(format!("{name}-fresh-cache")), fresh.clone()]).unwrap();
        (manifest, fresh.with_extension("wav"), fresh.with_extension("json"), callbacks, navigation)
    }

    #[test]
    fn fresh_first_live_reference_composes_each_recorded_arrival_and_rejects_changed_trace() {
        let directory = tempfile::tempdir().unwrap();
        let mut first_reference = None;
        for (name, arrival) in [("early", 17), ("late", 1_100_007)] { let (_manifest, wave, metadata, callbacks, navigation) = end_to_end_cycle(directory.path(), arrival, name);
            let output = directory.path().join(format!("{name}-compose")); compose(&[wave.clone(), metadata.clone(), callbacks.clone(), navigation.clone(), output.clone()]).unwrap();
            let first: Value = serde_json::from_slice(&std::fs::read(output.with_extension("json")).unwrap()).unwrap(); assert_eq!(first["first_live"]["schedule"]["upgrade_at_render_frame"], arrival);
            if name == "late" { assert!(first["preview_wait_frames"].as_u64().unwrap() > 0); }
            let (initial_wave, initial_metadata) = first_reference.get_or_insert_with(|| (wave.clone(), metadata.clone()));
            let current = directory.path().join(format!("{name}-current-cycle"));
            compose(&[initial_wave.clone(), initial_metadata.clone(), callbacks.clone(), navigation.clone(), current.clone()]).unwrap();
            assert_eq!(hash(&output.with_extension("wav")).unwrap(), hash(&current.with_extension("wav")).unwrap());
            let repeat = directory.path().join(format!("{name}-repeat")); compose(&[wave, metadata, callbacks.clone(), navigation.clone(), repeat.clone()]).unwrap(); assert_eq!(hash(&output.with_extension("wav")).unwrap(), hash(&repeat.with_extension("wav")).unwrap());
            let mut changed = trace_rows(&navigation).unwrap();
            let prep = changed.iter_mut().find(|row| row["kind"] == "cycle_first_live_preparation").unwrap();
            let digest = prep["evidence"]["full_prepared_sha256"][0].as_u64().unwrap();
            prep["evidence"]["full_prepared_sha256"][0] = json!(digest ^ 1);
            let fake = directory.path().join(format!("{name}-fake-navigation.jsonl"));
            std::fs::write(&fake, changed.iter().map(|row| format!("{row}\n")).collect::<String>()).unwrap();
            assert!(compose(&[initial_wave.clone(), initial_metadata.clone(), callbacks.clone(), fake, directory.path().join(format!("{name}-bad-content"))]).unwrap_err().contains("evidence mismatch"));
            let original = std::fs::read_to_string(&navigation).unwrap(); std::fs::write(&navigation, original.replacen("\"entry_frame\":", "\"entry_frame\":999,\"entry_frame_original\":", 1)).unwrap();
            assert!(compose(&[directory.path().join(format!("{name}-fresh.wav")), directory.path().join(format!("{name}-fresh.json")), callbacks, navigation.clone(), directory.path().join(format!("{name}-bad"))]).is_err()); std::fs::write(navigation, original).unwrap(); }
    }

    #[test]
    fn callback_parser_rejects_unpaired_or_nonsequential_engine_records() {
        let directory = tempfile::tempdir().unwrap();
        let rows = directory.path().join("callbacks.csv");
        std::fs::write(&rows, format!("{CALLBACK_HEADER}\n1,1,1,2,0,,0,0,0,0\n")).unwrap();
        assert!(parse_callbacks(&rows).is_err());
        std::fs::write(&rows, format!("{CALLBACK_HEADER}\n2,1,1,2,0,2,0,0,0,0\n")).unwrap();
        assert!(parse_callbacks(&rows).is_err());
    }
}
