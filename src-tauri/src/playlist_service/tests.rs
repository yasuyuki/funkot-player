use super::*;
use funkot_core::engine::TrackSource;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

struct Fixture { data: tempfile::TempDir, cache: tempfile::TempDir, queue: SharedQueue, service: Shared }

impl Fixture {
    fn new() -> Self {
        let data = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let queue = queue::new_shared_queue();
        let service = Arc::new(Mutex::new(Service::new(data.path(), cache.path(), queue.clone())));
        Self { data, cache, queue, service }
    }
    fn file(&self, name: &str) -> PathBuf {
        let path = self.data.path().join(name);
        fs::write(&path, format!("synthetic {name}")).unwrap();
        path
    }
    fn track(path: &Path) -> TrackRef {
        TrackRef { content_hash: funkot_core::cache::content_hash(path).unwrap(), preferred_path: path.into(),
            title: path.file_name().unwrap().to_string_lossy().into(), artist: String::new() }
    }
    fn install(&self, name: &str, tracks: Vec<TrackRef>) -> String {
        let mut owner = self.service.lock().unwrap();
        let id = owner.catalog.create(name, tracks).unwrap();
        owner.disk.persist(&owner.catalog).unwrap();
        id
    }
    fn request(&self, request_id: &str, action: Action) -> Request {
        Request { request_id: request_id.into(), target: self.service.lock().unwrap().target(), action }
    }
    fn command(&self, request_id: &str, action: Action) -> Result<CommandResult, CommandError> {
        command_with(&self.service, self.request(request_id, action), None)
    }
}

#[test]
fn moved_identity_resolves_but_changed_content_is_skipped_once_without_fallback() {
    let fixture = Fixture::new();
    let original = fixture.file("original.wav");
    let reference = Fixture::track(&original);
    let moved = fixture.data.path().join("moved.wav");
    fs::rename(&original, &moved).unwrap();
    let mut index = store::HashIndex::new();
    store::resolve_library_file(&moved, &mut index).unwrap();
    store::save_hash_index(fixture.data.path(), &index).unwrap();
    assert_eq!(fixture.service.lock().unwrap().lookup(&reference).unwrap(), moved);
    fs::write(&moved, b"different content at the previously resolved path").unwrap();
    fs::write(&original, b"different content at the preferred path").unwrap();
    assert!(fixture.service.lock().unwrap().lookup(&reference).is_err());

    let id = fixture.install("unavailable", vec![reference.clone(), reference]);
    let normal = fixture.file("normal.wav");
    queue::replace_pending(&fixture.queue, vec![QueueItem::manual(normal.clone())]);
    fixture.command("select-unavailable", Action::Select { id: Some(id.clone()) }).unwrap();
    let mut source = ManagedSource { service: fixture.service.clone(), epoch: 0 };
    assert!(source.next().is_none());
    assert!(source.next().is_none());
    let owner = fixture.service.lock().unwrap();
    assert_eq!(owner.catalog.definition(&id).unwrap().entries.len(), 2);
    assert_eq!(owner.catalog.run(&id).unwrap().failures.len(), 2);
    assert!(owner.catalog.remaining(&id).unwrap().is_empty());
    assert_eq!(queue::pending_snapshot(&fixture.queue), vec![QueueItem::manual(normal)]);
}

#[test]
fn starting_distinct_duplicate_occurrences_preserves_definition() {
    let fixture = Fixture::new();
    let path = fixture.file("same.wav");
    let id = fixture.install("duplicates", vec![Fixture::track(&path), Fixture::track(&path)]);
    fixture.command("select", Action::Select { id: Some(id.clone()) }).unwrap();
    let mut source = ManagedSource { service: fixture.service.clone(), epoch: 0 };
    let (first, _) = source.next().unwrap();
    let (second, _) = source.next().unwrap();
    assert_ne!(first, second, "engine indices identify occurrences, not paths");
    let before = fixture.service.lock().unwrap().catalog.definition(&id).unwrap().entries.clone();
    fixture.service.lock().unwrap().started(first);
    let owner = fixture.service.lock().unwrap();
    assert_eq!(owner.catalog.definition(&id).unwrap().entries, before);
    assert_eq!(owner.catalog.remaining(&id).unwrap().len(), 1);
    assert_eq!(owner.claims[&first].entry, Some(before[0].entry_id.clone()));
    assert_eq!(owner.claims[&second].entry, Some(before[1].entry_id.clone()));
}

#[test]
fn request_receipt_replays_only_the_identical_source_and_revision_command() {
    let fixture = Fixture::new();
    let created = fixture.command("create", Action::Create { name: "set".into() }).unwrap().created_id.unwrap();
    let target = fixture.service.lock().unwrap().target();
    let request = Request { request_id: "select".into(), target: target.clone(), action: Action::Select { id: Some(created.clone()) } };
    command_with(&fixture.service, request.clone(), None).unwrap();
    let replay = command_with(&fixture.service, request, None);
    assert!(replay.is_ok());
    let changed_payload = Request { request_id: "select".into(), target, action: Action::Select { id: None } };
    assert_eq!(command_with(&fixture.service, changed_payload, None).err().unwrap().code, "stale");
    assert_eq!(fixture.service.lock().unwrap().active(), Some(created.as_str()));
}

#[test]
fn source_switch_waits_for_initial_engine_control_handle() {
    let fixture = Fixture::new();
    let normal_a = fixture.file("normal-a.wav");
    queue::replace_pending(&fixture.queue, vec![QueueItem::manual(normal_a)]);
    let normal = HostSource::new(fixture.queue.clone(), queue::DrainPolicy::ContinueFolder { tracks: vec![], pos: 0 });
    let mut source = configure(&fixture.service, normal);
    let (index, _) = source.next().unwrap();
    let playlist = fixture.install("playlist", vec![]);
    let error = fixture.command("playlist", Action::Select { id: Some(playlist) }).err().unwrap();
    assert_eq!(error.code, "busy");
    let owner = fixture.service.lock().unwrap();
    assert_eq!(owner.active(), None);
    assert!(owner.claims[&index].live);
    assert!(!owner.claims[&index].cancelled);
}

#[test]
fn stale_save_aborts_without_publishing_candidate_or_altering_claims() {
    let fixture = Fixture::new();
    let path = fixture.file("claim.wav");
    let id = fixture.install("before", vec![Fixture::track(&path)]);
    fixture.command("select", Action::Select { id: Some(id.clone()) }).unwrap();
    let mut source = ManagedSource { service: fixture.service.clone(), epoch: 0 };
    let (index, _) = source.next().unwrap();
    fixture.service.lock().unwrap().started(index);
    let (catalog, current, future) = { let owner = fixture.service.lock().unwrap();
        (owner.catalog.clone(), owner.current_index, owner.future_claims().into_iter().map(|(i, _)| i).collect::<Vec<_>>()) };
    let file = fixture.data.path().join("playlists.json");
    fs::write(&file, b"external update").unwrap();
    assert_eq!(fixture.command("rename", Action::Rename { id: id.clone(), name: "after".into() }).err().unwrap().code, "stale");
    let owner = fixture.service.lock().unwrap();
    assert_eq!(owner.catalog, catalog);
    assert_eq!(owner.current_index, current);
    assert_eq!(owner.future_claims().into_iter().map(|(i, _)| i).collect::<Vec<_>>(), future);
    assert_eq!(fs::read(&file).unwrap(), b"external update");
}

#[test]
fn removed_current_is_not_restored_by_a_new_service() {
    let fixture = Fixture::new();
    let path = fixture.file("current.wav");
    let id = fixture.install("set", vec![Fixture::track(&path)]);
    fixture.command("select", Action::Select { id: Some(id.clone()) }).unwrap();
    let mut source = ManagedSource { service: fixture.service.clone(), epoch: 0 };
    let (index, _) = source.next().unwrap();
    fixture.service.lock().unwrap().started(index);
    let entry_id = fixture.service.lock().unwrap().claims[&index].entry.clone().unwrap();
    fixture.command("remove", Action::Remove { id, entry_id }).unwrap();
    let Fixture { data, cache, queue, service } = fixture;
    drop(source);
    drop(service);
    let reopened = Service::new(data.path(), cache.path(), queue.clone());
    assert!(reopened.restored.is_none());
    assert!(reopened.catalog.current.is_none());
}

#[test]
fn delayed_started_event_consumes_its_occurrence_without_rolling_current_backward() {
    let fixture = Fixture::new();
    let first_path = fixture.file("first.wav");
    let second_path = fixture.file("second.wav");
    let id = fixture.install("set", vec![Fixture::track(&first_path), Fixture::track(&second_path)]);
    fixture.command("select", Action::Select { id: Some(id.clone()) }).unwrap();
    let mut source = ManagedSource { service: fixture.service.clone(), epoch: 0 };
    let (first, _) = source.next().unwrap();
    let (second, _) = source.next().unwrap();
    let mut owner = fixture.service.lock().unwrap();
    owner.started(second);
    owner.observe_started(first, None);
    assert_eq!(owner.current_index, Some(second));
    assert!(!owner.claims[&first].live);
    assert_eq!(owner.catalog.remaining(&id).unwrap().len(), 0);
}

#[test]
fn preparing_and_finished_empty_engine_do_not_consume_playlist_occurrences() {
    let fixture = Fixture::new();
    let a = fixture.file("a.wav");
    let b = fixture.file("b.wav");
    let id = fixture.install("repeated", vec![
        Fixture::track(&a), Fixture::track(&b), Fixture::track(&a),
        Fixture::track(&b), Fixture::track(&a),
    ]);
    let other = fixture.install("other", vec![Fixture::track(&a), Fixture::track(&b)]);
    fixture.command("select", Action::Select { id: Some(id.clone()) }).unwrap();

    let mut source = ManagedSource { service: fixture.service.clone(), epoch: 0 };
    let prepared: Vec<_> = (0..5).map(|_| source.next().expect("claim to prepare")).collect();
    assert!(source.next().is_none(), "all remaining rows are claimed, not started");
    {
        let owner = fixture.service.lock().unwrap();
        assert_eq!(owner.catalog.remaining(&id).unwrap().len(), 5, "preparation has no playback evidence");
        assert!(owner.catalog.run(&id).unwrap().failures.is_empty());
        assert_eq!(owner.catalog.remaining(&other).unwrap().len(), 2);
    }

    // A finite engine with no current deck represents a pending-empty/Finished
    // lifecycle notification. It is not a TrackStarted event for these claims.
    let empty = playback(&[], 64);
    assert!(empty.render.lock().unwrap().engine.is_finished());
    fixture.service.lock().unwrap().reconcile_with(Some(&empty));
    let owner = fixture.service.lock().unwrap();
    assert_eq!(owner.catalog.remaining(&id).unwrap().len(), prepared.len());
    assert!(owner.catalog.run(&id).unwrap().failures.is_empty());
    assert_eq!(owner.catalog.remaining(&other).unwrap().len(), 2);
}

#[test]
fn real_engine_events_for_all_prepared_occurrences_are_consumed_by_index() {
    let fixture = Fixture::new();
    let a = fixture.file("a.wav");
    let b = fixture.file("b.wav");
    let id = fixture.install("repeated", vec![
        Fixture::track(&a), Fixture::track(&b), Fixture::track(&a),
        Fixture::track(&b), Fixture::track(&a),
    ]);
    let other = fixture.install("other", vec![Fixture::track(&a), Fixture::track(&b)]);
    fixture.command("select", Action::Select { id: Some(id.clone()) }).unwrap();
    let mut source = ManagedSource { service: fixture.service.clone(), epoch: 0 };
    let prepared: Vec<_> = (0..5).map(|_| source.next().unwrap()).collect();
    let entries = fixture.service.lock().unwrap().catalog.definition(&id).unwrap().entries.clone();

    // This synthetic generator checks the Engine-to-service trust boundary,
    // not the device report's cause. Its 120s@180 BPM source becomes 90 bars
    // at target 198 BPM: outro at bar 26, 64-bar intro/outro. The transition
    // plan enters each incoming deck after its own outro, producing 0→4.
    let player = geometry_playback(&prepared);
    fixture.service.lock().unwrap().reconcile_with(Some(&player));
    {
        let owner = fixture.service.lock().unwrap();
        let run = owner.catalog.run(&id).unwrap();
        assert!(run.consumed.contains(&entries[0].entry_id));
        assert!(!run.consumed.contains(&entries[2].entry_id), "same path is still a distinct unplayed occurrence");
        assert_eq!(owner.current_index, Some(prepared[0].0));
    }

    let started = emitted_track_starts(&player);
    assert_eq!(started, prepared.iter().map(|(index, _)| *index).collect::<Vec<_>>(),
        "each delivered service index must come from EngineEvent::TrackStarted");
    let mut delayed = started.clone(); delayed.rotate_left(1);
    {
        let mut owner = fixture.service.lock().unwrap();
        for index in delayed {
            let before = owner.catalog.run(&id).unwrap().consumed.len();
            owner.observe_started(index, Some(&player));
            let after = owner.catalog.run(&id).unwrap().consumed.len();
            assert_eq!(after, before + usize::from(index != started[0]),
                "only this emitted occurrence may advance progress");
        }
        owner.observe_started(started[2], Some(&player));
        assert_eq!(owner.catalog.run(&id).unwrap().consumed.len(), 5, "duplicate emitted event is idempotent");
        let run = owner.catalog.run(&id).unwrap();
        assert!(entries.iter().all(|entry| run.consumed.contains(&entry.entry_id)));
        assert!(run.failures.is_empty());
        assert_eq!(owner.disk.snapshot().unwrap().run(&id).unwrap().consumed, run.consumed);
        assert!(owner.disk.snapshot().unwrap().run(&id).unwrap().failures.is_empty());
        assert!(owner.catalog.current.is_none());
        assert!(owner.ended, "ended is derived from observed progress plus Engine finish");
        assert_eq!(owner.catalog.remaining(&other).unwrap().len(), 2);
    }
}

#[test]
fn real_engine_snapshot_keeps_old_audible_current_and_rejects_cancelled_future_event() {
    let fixture = Fixture::new();
    let a = fixture.file("a.wav");
    let b = fixture.file("b.wav");
    let id = fixture.install("set", vec![Fixture::track(&a), Fixture::track(&b)]);
    let other = fixture.install("other", vec![Fixture::track(&a), Fixture::track(&b)]);
    fixture.command("select", Action::Select { id: Some(id.clone()) }).unwrap();
    let mut source = ManagedSource { service: fixture.service.clone(), epoch: 0 };
    let first = source.next().unwrap();
    let second = source.next().unwrap();
    let player = playback(&[first.clone(), second.clone()], 4096);
    fixture.service.lock().unwrap().reconcile_with(Some(&player));

    let request = fixture.request("select-other", Action::Select { id: Some(other.clone()) });
    command_with(&fixture.service, request, Some(&player)).unwrap();
    let mut owner = fixture.service.lock().unwrap();
    assert!(!owner.claims[&first.0].cancelled, "the real Engine snapshot keeps its audible claim");
    assert!(owner.claims[&second.0].cancelled);
    let remaining_before_cancelled_event = owner.catalog.remaining(&id).unwrap().len();
    owner.observe_started(second.0, Some(&player));
    assert_eq!(owner.catalog.remaining(&id).unwrap().len(), remaining_before_cancelled_event);
    assert_eq!(owner.current_index, Some(first.0), "a cancelled future event cannot become current");
    owner.observe_started(first.0, Some(&player));
    assert_eq!(owner.current_index, Some(first.0));
    assert_eq!(owner.catalog.remaining(&other).unwrap().len(), 2);
}

#[test]
fn restarted_run_rejects_delayed_old_start_and_old_engine_snapshot() {
    let fixture = Fixture::new();
    let a = fixture.file("a.wav");
    let b = fixture.file("b.wav");
    let id = fixture.install("set", vec![Fixture::track(&a), Fixture::track(&b)]);
    fixture.command("select", Action::Select { id: Some(id.clone()) }).unwrap();
    let mut source = ManagedSource { service: fixture.service.clone(), epoch: 0 };
    let first = source.next().unwrap();
    let second = source.next().unwrap();
    let player = playback(&[first.clone(), second.clone()], 4096);

    let mut owner = fixture.service.lock().unwrap();
    owner.catalog.restart(&id).unwrap();
    // The delayed TrackStarted names old index 1; reconciliation then sees the
    // real Engine's old index 0 snapshot. Neither belongs to the restarted run.
    owner.observe_started(second.0, Some(&player));
    let restarted = owner.catalog.run(&id).unwrap();
    assert!(restarted.consumed.is_empty());
    assert!(restarted.failures.is_empty());
    assert!(owner.catalog.current.is_none(), "an old-run snapshot cannot restore current playback");
    assert_eq!(owner.catalog.remaining(&id).unwrap().len(), 2);
}

#[test]
fn failures_require_a_reason_and_a_matching_live_run_claim() {
    let fixture = Fixture::new();
    let a = fixture.file("a.wav");
    let b = fixture.file("b.wav");
    let c = fixture.file("c.wav");
    let id = fixture.install("set", vec![Fixture::track(&a), Fixture::track(&b), Fixture::track(&c)]);
    fixture.command("select", Action::Select { id: Some(id.clone()) }).unwrap();
    let mut source = ManagedSource { service: fixture.service.clone(), epoch: 0 };
    let first = source.next().unwrap();
    let second = source.next().unwrap();
    let third = source.next().unwrap();
    let entries = fixture.service.lock().unwrap().catalog.definition(&id).unwrap().entries.clone();

    let mut owner = fixture.service.lock().unwrap();
    owner.failed(first.0, " \t ");
    assert_eq!(owner.catalog.remaining(&id).unwrap().len(), 3);
    assert!(owner.claims[&first.0].live, "empty failure retains the claim for a later real start");

    owner.failed(first.0, "decoder rejected stream");
    let run = owner.catalog.run(&id).unwrap();
    assert!(run.consumed.contains(&entries[0].entry_id));
    assert_eq!(run.failures[&entries[0].entry_id], "decoder rejected stream");
    assert!(!run.consumed.contains(&entries[1].entry_id));

    owner.claims.get_mut(&second.0).unwrap().cancelled = true;
    owner.failed(second.0, "late cancelled failure");
    assert!(!owner.catalog.run(&id).unwrap().consumed.contains(&entries[1].entry_id));
    assert!(!owner.catalog.run(&id).unwrap().failures.contains_key(&entries[1].entry_id));

    owner.catalog.restart(&id).unwrap();
    owner.failed(third.0, "late old-run failure");
    let restarted = owner.catalog.run(&id).unwrap();
    assert!(restarted.consumed.is_empty());
    assert!(restarted.failures.is_empty());
}

fn playback(tracks: &[(usize, PathBuf)], frames: usize) -> crate::Playback {
    use funkot_core::engine::{Engine, PreparedTrack};
    use std::sync::atomic::AtomicBool;
    let prepared = tracks.iter().map(|(index,path)| PreparedTrack {
        path: path.clone(), playlist_index: *index, samples: Arc::new(vec![0.25; frames * 2]),
        frames: frames as u64, first_downbeat_out: 0, outro_start_out: frames as u64, outro_end_anchored_out: frames as u64,
        intro_bars: 0, outro_bars: 0, gain_linear: 1.0, preview: false, head_only: false,
    }).collect();
    let mut engine = Engine::from_prepared(funkot_core::EngineOptions::default(), prepared).unwrap();
    engine.set_realtime(true);
    engine.render(&mut [0.0; 128]);
    let nav_tx = engine.nav_sender();
    crate::Playback { paused: Arc::new(AtomicBool::new(false)), nav_tx, sample_rate: 48_000,
        render: Arc::new(Mutex::new(crate::RenderState { engine, audition: None,
            stall: crate::StallWatch::new(48_000), was_in_transition: false })) }
}

fn geometry_playback(tracks: &[(usize, PathBuf)]) -> crate::Playback {
    use funkot_core::engine::{Engine, PreparedTrack};
    use std::sync::atomic::AtomicBool;
    const SAMPLE_RATE: u32 = 198;
    const BAR_FRAMES: usize = 240;
    const FRAMES: usize = 90 * BAR_FRAMES;
    const OUTRO: usize = 26 * BAR_FRAMES;
    let prepared = tracks.iter().map(|(index, path)| PreparedTrack {
        path: path.clone(), playlist_index: *index,
        samples: Arc::new((0..FRAMES * 2).map(|frame| (frame % 11) as f32 / 11.0 - 0.5).collect()),
        frames: FRAMES as u64, first_downbeat_out: 0,
        outro_start_out: OUTRO as u64, outro_end_anchored_out: OUTRO as u64,
        intro_bars: 64, outro_bars: 64, gain_linear: 1.0, preview: false, head_only: false,
    }).collect();
    let mut options = funkot_core::EngineOptions::default();
    options.output_sample_rate = SAMPLE_RATE;
    options.highpass_hz = 30.0;
    options.loop_playlist = false;
    let mut engine = Engine::from_prepared(options, prepared).unwrap();
    engine.set_realtime(false);
    let nav_tx = engine.nav_sender();
    crate::Playback { paused: Arc::new(AtomicBool::new(false)), nav_tx, sample_rate: SAMPLE_RATE,
        render: Arc::new(Mutex::new(crate::RenderState { engine, audition: None,
            stall: crate::StallWatch::new(SAMPLE_RATE), was_in_transition: false })) }
}

fn emitted_track_starts(player: &crate::Playback) -> Vec<usize> {
    use funkot_core::engine::EngineEvent;
    let mut render = player.render.lock().unwrap();
    let mut starts = render.engine.poll_events().into_iter().filter_map(|event| match event {
        EngineEvent::TrackStarted { index, .. } => Some(index), _ => None,
    }).collect::<Vec<_>>();
    // Use the Engine contract tests' existing five-second channel deadline.
    // from_prepared still has an asynchronous tail/exhaustion sender; CPU-speed
    // silence pulls do not measure track duration while waiting for that sender.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !render.engine.is_finished() && std::time::Instant::now() < deadline {
        let _ = render.engine.render(&mut [0.0; 480]);
        starts.extend(render.engine.poll_events().into_iter().filter_map(|event| match event {
            EngineEvent::TrackStarted { index, .. } => Some(index), _ => None,
        }));
        if render.engine.is_finished() { break; }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert!(render.engine.is_finished(), "finite prepared Engine must deliver exhaustion before the channel deadline");
    starts
}

#[test]
fn failed_source_save_aborts_real_engine_fence_and_keeps_prepared_next() {
    let fixture = Fixture::new();
    let a = fixture.file("a.wav"); let b = fixture.file("b.wav");
    let id = fixture.install("playing", vec![Fixture::track(&a), Fixture::track(&b)]);
    let other = fixture.install("other", vec![]);
    fixture.command("select", Action::Select { id: Some(id.clone()) }).unwrap();
    let mut source = ManagedSource { service: fixture.service.clone(), epoch: 0 };
    let first = source.next().unwrap(); let second = source.next().unwrap();
    let player = playback(&[first,second], 4096);
    fixture.service.lock().unwrap().reconcile_with(Some(&player));
    let before = fixture.service.lock().unwrap().catalog.clone();
    fs::write(fixture.data.path().join("playlists.json"), b"external update").unwrap();
    let request = fixture.request("switch", Action::Select { id: Some(other) });
    assert_eq!(command_with(&fixture.service, request, Some(&player)).err().unwrap().code, "stale");
    let mut render = player.render.lock().unwrap();
    assert_eq!(render.engine.source_generation(), 0);
    assert_eq!(render.engine.next_track_path(), Some(b.as_path()));
    assert!(render.engine.render(&mut [0.0; 128]) > 0);
    let token = render.engine.begin_future_update().expect("failed save resolved its fence");
    render.engine.abort_future_update(token);
    assert_eq!(fixture.service.lock().unwrap().catalog, before);
}

#[test]
fn real_source_switch_cancels_all_future_claims_and_retains_normal_order() {
    let fixture = Fixture::new();
    let paths: Vec<_> = ["a.wav", "b.wav", "c.wav"].iter().map(|n| fixture.file(n)).collect();
    queue::replace_pending(&fixture.queue, vec![QueueItem::manual(paths[0].clone()), QueueItem::automatic(paths[1].clone()), QueueItem::manual(paths[2].clone())]);
    let normal = HostSource::new(fixture.queue.clone(), queue::DrainPolicy::ContinueFolder { tracks: vec![], pos: 0 });
    let mut source = configure(&fixture.service, normal);
    let first = source.next().unwrap(); let second = source.next().unwrap();
    let player = playback(&[first.clone(),second.clone()], 4096);
    fixture.service.lock().unwrap().reconcile_with(Some(&player));
    let id = fixture.install("empty playlist", vec![]);
    let request = fixture.request("switch", Action::Select { id: Some(id) });
    command_with(&fixture.service, request, Some(&player)).unwrap();
    {
        let owner = fixture.service.lock().unwrap();
        assert!(owner.claims[&second.0].cancelled);
        assert_eq!(owner.normal_items(), vec![QueueItem::automatic(paths[1].clone()),QueueItem::manual(paths[2].clone())]);
    }
    assert!(source.next().is_none(), "detached source cannot consume the new owner");
    let mut render = player.render.lock().unwrap();
    assert_eq!(render.engine.current_index(), Some(first.0));
    assert_eq!(render.engine.next_track_path(), None);
    assert!(render.engine.render(&mut [0.0; 128]) > 0, "current audio remains audible");
    drop(render);
    let request = fixture.request("return", Action::Select { id: None });
    command_with(&fixture.service, request, Some(&player)).unwrap();
    let owner = fixture.service.lock().unwrap();
    assert_eq!(owner.active(), None);
    assert_eq!(owner.normal_items(), vec![QueueItem::automatic(paths[1].clone()), QueueItem::manual(paths[2].clone())]);
}

#[test]
fn removing_unprepared_row_during_transition_does_not_require_a_source_fence() {
    let fixture = Fixture::new();
    let paths: Vec<_> = ["a.wav", "b.wav", "c.wav"].iter().map(|n| fixture.file(n)).collect();
    let id = fixture.install("set", paths.iter().map(|p|Fixture::track(p)).collect());
    fixture.command("select", Action::Select { id: Some(id.clone()) }).unwrap();
    let mut source = ManagedSource { service: fixture.service.clone(), epoch: 0 };
    let first = source.next().unwrap(); let second = source.next().unwrap();
    let player = playback(&[first,second], 4096);
    {
        let mut render = player.render.lock().unwrap();
        render.engine.request_nav(funkot_core::engine::NavAction::TransitionToNext);
        render.engine.render(&mut [0.0; 128]);
        assert!(render.engine.transition_frames_into().is_some());
    }
    fixture.service.lock().unwrap().reconcile_with(Some(&player));
    let last = fixture.service.lock().unwrap().catalog.definition(&id).unwrap().entries[2].entry_id.clone();
    let request = fixture.request("remove", Action::Remove { id: id.clone(), entry_id: last });
    command_with(&fixture.service, request, Some(&player)).unwrap();
    assert_eq!(fixture.service.lock().unwrap().catalog.definition(&id).unwrap().entries.len(), 2);
    assert_eq!(player.render.lock().unwrap().engine.source_generation(), 0);
}

#[test]
fn paused_transition_rejects_source_switch_with_actionable_reason() {
    let fixture = Fixture::new();
    let a = fixture.file("a.wav"); let b = fixture.file("b.wav");
    let id = fixture.install("playing", vec![Fixture::track(&a), Fixture::track(&b)]);
    let other = fixture.install("other", vec![]);
    fixture.command("select", Action::Select { id: Some(id.clone()) }).unwrap();
    let mut source = ManagedSource { service: fixture.service.clone(), epoch: 0 };
    let first = source.next().unwrap(); let second = source.next().unwrap();
    let player = playback(&[first, second], 4096);
    {
        let mut render = player.render.lock().unwrap();
        render.engine.request_nav(funkot_core::engine::NavAction::TransitionToNext);
        render.engine.render(&mut [0.0; 128]);
        assert!(render.engine.transition_frames_into().is_some());
    }
    fixture.service.lock().unwrap().reconcile_with(Some(&player));
    player.paused.store(true, Ordering::Relaxed);
    let before = fixture.service.lock().unwrap().catalog.clone();
    let request = fixture.request("switch-while-paused", Action::Select { id: Some(other) });
    assert_eq!(command_with(&fixture.service, request, Some(&player)).err().unwrap().code, "transition_paused");
    assert_eq!(fixture.service.lock().unwrap().catalog, before);
    assert!(player.render.lock().unwrap().engine.transition_frames_into().is_some());
}

#[test]
fn ended_restart_is_saved_without_resuming_engine_or_destroying_definition() {
    let fixture = Fixture::new(); let a = fixture.file("a.wav");
    let id = fixture.install("set", vec![Fixture::track(&a)]);
    fixture.command("select", Action::Select { id: Some(id.clone()) }).unwrap();
    let mut source = ManagedSource { service: fixture.service.clone(), epoch: 0 };
    let first = source.next().unwrap(); assert!(source.next().is_none());
    let player = playback(&[first], 256);
    fixture.service.lock().unwrap().reconcile_with(Some(&player));
    { let mut render = player.render.lock().unwrap(); while render.engine.render(&mut [0.0; 128]) != 0 {} }
    fixture.service.lock().unwrap().reconcile_with(Some(&player));
    let request = fixture.request("restart", Action::Restart { id: id.clone() });
    command_with(&fixture.service, request, Some(&player)).unwrap();
    let mut render = player.render.lock().unwrap();
    assert!(render.engine.is_finished());
    assert_eq!(render.engine.render(&mut [0.0; 128]), 0);
    assert!(render.engine.resume());
    assert!(!render.engine.is_finished());
    let owner = fixture.service.lock().unwrap();
    assert_eq!(owner.catalog.definition(&id).unwrap().entries.len(), 1);
    assert_eq!(owner.catalog.remaining(&id).unwrap().len(), 1);
}

#[test]
fn restart_replays_normal_current_before_selected_playlist_without_queue_duplication() {
    let fixture = Fixture::new(); let normal = fixture.file("normal.wav"); let playlist = fixture.file("playlist.wav");
    let id = fixture.install("set", vec![Fixture::track(&playlist)]);
    {
        let mut owner = fixture.service.lock().unwrap();
        owner.catalog.select(Some(id.clone())).unwrap();
        owner.catalog.current = Some(CurrentOccurrence { playlist_id: None, run_id: 0, entry_id: None,
            track_ref: TrackRef { content_hash: String::new(), preferred_path: normal.clone(), title: String::new(), artist: String::new() },
            origin: PlaybackOrigin::Normal, queue_origin: Some(QueueOrigin::Automatic) });
        owner.catalog.normal = Some(NormalResume { items: vec![], folder_pos: Some(7) });
        owner.disk.persist(&owner.catalog).unwrap();
    }
    let Fixture { data, cache, queue, service } = fixture; drop(service);
    let service = Arc::new(Mutex::new(Service::new(data.path(), cache.path(), queue.clone())));
    let target = service.lock().unwrap().target();
    command_with(&service, Request { request_id: "rename-before-play".into(), target,
        action: Action::Rename { id: id.clone(), name: "renamed".into() } }, None).unwrap();
    drop(service);
    let service = Arc::new(Mutex::new(Service::new(data.path(), cache.path(), queue)));
    let mut source = ManagedSource { service: service.clone(), epoch: 0 };
    let (index, first) = source.next().unwrap();
    assert_eq!(first, normal);
    {
        let owner = service.lock().unwrap();
        assert!(owner.catalog.normal.as_ref().unwrap().items.is_empty(), "restoring current must not also be saved in the normal queue");
        assert_eq!(owner.catalog.current.as_ref().unwrap().track_ref.preferred_path, normal);
    }
    service.lock().unwrap().started(index);
    assert_eq!(source.next().unwrap().1, playlist);
    let owner = service.lock().unwrap();
    assert!(owner.normal_items().is_empty());
    assert_eq!(owner.catalog.normal.as_ref().unwrap().folder_pos, Some(7));
}

#[test]
fn undoing_current_membership_restores_its_restart_identity_without_requeueing() {
    let fixture = Fixture::new(); let path = fixture.file("current.wav");
    let id = fixture.install("set", vec![Fixture::track(&path)]);
    fixture.command("select", Action::Select { id: Some(id.clone()) }).unwrap();
    let mut source = ManagedSource { service: fixture.service.clone(), epoch: 0 };
    let (index, _) = source.next().unwrap();
    fixture.service.lock().unwrap().started(index);
    let entry_id = fixture.service.lock().unwrap().claims[&index].entry.clone().unwrap();
    let removed = fixture.command("remove", Action::Remove { id: id.clone(), entry_id: entry_id.clone() }).unwrap();
    assert!(fixture.service.lock().unwrap().catalog.current.is_none());
    fixture.command("undo", Action::UndoRemove { undo_id: removed.undo_id.unwrap() }).unwrap();
    let owner = fixture.service.lock().unwrap();
    assert_eq!(owner.catalog.current.as_ref().unwrap().entry_id, Some(entry_id));
    assert!(owner.catalog.remaining(&id).unwrap().is_empty());
}

#[test]
fn waking_finite_tail_keeps_a_current_restore_that_has_not_started_yet() {
    let fixture = Fixture::new(); let path = fixture.file("restore.wav");
    let id = fixture.install("set", vec![]);
    {
        let mut owner = fixture.service.lock().unwrap();
        owner.catalog.select(Some(id)).unwrap();
        let current = CurrentOccurrence { playlist_id: None, run_id: 0, entry_id: None,
            track_ref: Fixture::track(&path), origin: PlaybackOrigin::Normal,
            queue_origin: Some(QueueOrigin::Automatic) };
        owner.catalog.current = Some(current.clone()); owner.restored = Some(current);
        owner.disk.persist(&owner.catalog).unwrap();
    }
    let mut source = ManagedSource { service: fixture.service.clone(), epoch: 0 };
    let (old, _) = source.next().unwrap(); assert!(source.next().is_none());
    let engine = funkot_core::engine::Engine::from_prepared(funkot_core::EngineOptions::default(), vec![]).unwrap();
    let player = crate::Playback { paused: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        nav_tx: engine.nav_sender(), sample_rate: 48_000,
        render: Arc::new(Mutex::new(crate::RenderState { engine, audition: None,
            stall: crate::StallWatch::new(48_000), was_in_transition: false })) };
    let request = fixture.request("append", Action::Append { tracks: vec![TrackTarget {
        path: path.to_string_lossy().into(), expected_hash: None }], mode: "single".into() });
    command_with(&fixture.service, request, Some(&player)).unwrap();
    let owner = fixture.service.lock().unwrap();
    assert!(owner.claims[&old].cancelled);
    assert!(owner.restored.as_ref().is_some_and(|c| c.track_ref.preferred_path == path)
        || owner.claims.values().any(|c| c.restoring && !c.cancelled && c.item.path == path));
    assert!(owner.normal_items().is_empty());
}
