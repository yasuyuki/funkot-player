use super::*;
use crate::playlists::{NormalResume, PlaylistStore, TrackRef};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

struct Fixture {
    root: tempfile::TempDir,
    before: PlaybackState,
    after: PlaybackState,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let current = QueueItem::manual(PathBuf::from("/synthetic/repeated.flac"));
        let prepared = QueueItem::manual(current.path.clone());
        let unrelated = QueueItem::automatic(PathBuf::from("/synthetic/unrelated.flac"));
        let deleted = QueueItem::manual(PathBuf::from("/synthetic/deleted.flac"));
        let store = PlaybackStore::open(root.path());
        store
            .update(|state| {
                state.queue = vec![current.clone(), prepared.clone(), unrelated, deleted];
                state.session = Session {
                    in_flight: vec![current, prepared],
                    paused: false,
                };
                state.catalog.create(
                    "Before",
                    vec![TrackRef {
                        content_hash: "synthetic".into(),
                        preferred_path: PathBuf::from("/synthetic/catalog.flac"),
                        title: "Synthetic".into(),
                        artist: String::new(),
                    }],
                )?;
                state.catalog.normal = Some(NormalResume {
                    items: state.queue.clone(),
                    folder_pos: Some(5),
                });
                Ok(())
            })
            .unwrap();
        let before = store.snapshot().unwrap();
        let mut after = before.clone();
        after.revision += 1;
        after.queue.pop().unwrap();
        after
            .queue
            .push(QueueItem::manual(PathBuf::from("/synthetic/added.flac")));
        after.session.paused = true;
        let list = after.catalog.definitions[0].id.clone();
        after.catalog.rename(&list, "After").unwrap();
        after.catalog.normal.as_mut().unwrap().items = after.queue.clone();
        after.settings.allow_non_funkot = false;
        after.settings.locale = Some("ja".into());
        drop(store);
        Self {
            root,
            before,
            after,
        }
    }

    fn publish(&self, store: &PlaybackStore) -> Result<(), PlaylistError> {
        let candidate = self.after.clone();
        store.update(move |state| {
            let revision = state.revision;
            *state = candidate;
            state.revision = revision;
            Ok(())
        })
    }
}

#[test]
fn failed_io_preserves_the_whole_previous_revision_and_allows_retry() {
    for stage in 1..=3 {
        let fixture = Fixture::new();
        let store = PlaybackStore::open(fixture.root.path());
        let bytes = fs::read(fixture.root.path().join(FILE_NAME)).unwrap();
        set_fail_persist_stage(stage);
        assert!(
            fixture.publish(&store).is_err(),
            "stage {stage} must reject the edit"
        );
        assert_eq!(store.snapshot().unwrap(), fixture.before);
        assert_eq!(
            fs::read(fixture.root.path().join(FILE_NAME)).unwrap(),
            bytes
        );
        drop(store);
        let reopened = PlaybackStore::open(fixture.root.path());
        assert_eq!(reopened.snapshot().unwrap(), fixture.before);
        fixture.publish(&reopened).unwrap();
        assert_eq!(reopened.snapshot().unwrap(), fixture.after);
        drop(reopened);
        assert_eq!(
            PlaybackStore::open(fixture.root.path()).snapshot().unwrap(),
            fixture.after
        );
    }
}

#[test]
fn interrupted_writer() {
    let Ok(stage) = std::env::var("FUNKOT_CRASH_STAGE") else {
        return;
    };
    let dir = PathBuf::from(std::env::var_os("FUNKOT_CRASH_DATA").unwrap());
    let candidate_path = PathBuf::from(std::env::var_os("FUNKOT_CRASH_CANDIDATE").unwrap());
    let candidate: PlaybackState =
        serde_json::from_slice(&fs::read(candidate_path).unwrap()).unwrap();
    let store = PlaybackStore::open(dir);
    set_crash_stage(stage.parse().unwrap());
    store
        .update(move |state| {
            let revision = state.revision;
            *state = candidate;
            state.revision = revision;
            Ok(())
        })
        .unwrap();
    panic!("the parent must terminate this child at the requested cut");
}

#[test]
fn process_termination_recovers_one_complete_revision_at_every_commit_cut() {
    for stage in 0..=4 {
        let fixture = Fixture::new();
        let candidate_dir = tempfile::tempdir().unwrap();
        let candidate = candidate_dir.path().join("candidate.json");
        fs::write(&candidate, serde_json::to_vec(&fixture.after).unwrap()).unwrap();
        // A forked child can retain other tests' flock handles until exec.
        let stores = STORES.lock().unwrap_or_else(|e| e.into_inner());
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "playback_state::fault_tests::interrupted_writer",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("FUNKOT_CRASH_STAGE", stage.to_string())
            .env("FUNKOT_CRASH_DATA", fixture.root.path())
            .env("FUNKOT_CRASH_CANDIDATE", candidate)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        drop(stores);
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let expected = format!("playback-cut:{stage}");
        loop {
            let mut line = String::new();
            assert_ne!(
                output.read_line(&mut line).unwrap(),
                0,
                "child did not reach {expected}"
            );
            if line.contains(&expected) {
                break;
            }
        }
        child.kill().unwrap();
        assert!(!child.wait().unwrap().success());
        let reopened = PlaybackStore::open(fixture.root.path());
        let restored = reopened.snapshot().unwrap();
        assert_eq!(
            restored,
            if stage == 4 {
                &fixture.after
            } else {
                &fixture.before
            }
            .clone()
        );
        let pending = crate::store::restored_pending(&restored.session.in_flight, &restored.queue);
        let ids: std::collections::BTreeSet<_> =
            pending.iter().map(|item| &item.entry_id).collect();
        assert_eq!(
            ids.len(),
            pending.len(),
            "restoration must emit each occurrence once"
        );
        for item in fixture.before.queue.iter().take(3) {
            assert!(
                pending
                    .iter()
                    .any(|restored| restored.entry_id == item.entry_id),
                "unrelated or in-flight occurrence disappeared at stage {stage}"
            );
        }
        assert_ne!(pending[0].entry_id, pending[1].entry_id);
        assert_eq!(pending[0].path, pending[1].path);
    }
}

#[test]
fn acknowledged_addition_and_deletion_survive_repeated_restarts() {
    let fixture = Fixture::new();
    let deleted = fixture.before.queue.last().unwrap().entry_id.clone();
    let added = fixture.after.queue.last().unwrap().entry_id.clone();
    let store = PlaybackStore::open(fixture.root.path());
    fixture.publish(&store).unwrap();
    drop(store);
    for _ in 0..2 {
        let store = PlaybackStore::open(fixture.root.path());
        let state = store.snapshot().unwrap();
        let restored = crate::store::restored_pending(&state.session.in_flight, &state.queue);
        assert!(!restored.iter().any(|item| item.entry_id == deleted));
        assert_eq!(
            restored
                .iter()
                .filter(|item| item.entry_id == added)
                .count(),
            1
        );
        assert_eq!(state, fixture.after);
    }
}

#[test]
fn corrupt_and_unknown_snapshots_never_fall_back_to_legacy_or_accept_default_saves() {
    for bytes in [b"{".to_vec(), br#"{"schema_version":999}"#.to_vec()] {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE_NAME), &bytes).unwrap();
        let legacy = serde_json::to_vec(&vec![QueueItem::manual(PathBuf::from(
            "/synthetic/legacy.flac",
        ))])
        .unwrap();
        fs::write(dir.path().join("queue.json"), &legacy).unwrap();
        let store = PlaybackStore::open(dir.path());
        assert!(!matches!(
            store.load_state(),
            LoadState::Ready | LoadState::Missing
        ));
        assert!(store.snapshot().is_err());
        assert!(crate::store::load_queue(dir.path()).is_err());
        assert!(crate::store::save_queue(dir.path(), &VecDeque::<QueueItem>::new()).is_err());
        assert!(crate::store::save_session(dir.path(), &Session::new()).is_err());
        assert!(crate::store::save_settings(dir.path(), &Settings::default()).is_err());
        assert!(PlaylistStore::load(dir.path())
            .persist(&Catalog::default())
            .is_err());
        assert_eq!(fs::read(dir.path().join(FILE_NAME)).unwrap(), bytes);
        assert_eq!(fs::read(dir.path().join("queue.json")).unwrap(), legacy);
    }
}

#[test]
fn unreadable_snapshot_path_stays_read_only() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join(FILE_NAME)).unwrap();
    let store = PlaybackStore::open(dir.path());
    assert_eq!(store.load_state(), LoadState::IoError);
    assert!(store.snapshot().is_err());
    assert!(crate::store::save_session(dir.path(), &Session::new()).is_err());
    assert!(dir.path().join(FILE_NAME).is_dir());
}

#[test]
fn legacy_component_corruption_preserves_every_original() {
    for corrupt_name in [
        "queue.json",
        "session.json",
        "playlists.json",
        "settings.json",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let originals = [
            (
                "queue.json",
                serde_json::to_vec(&vec![QueueItem::manual(PathBuf::from(
                    "/synthetic/kept.flac",
                ))])
                .unwrap(),
            ),
            ("session.json", serde_json::to_vec(&Session::new()).unwrap()),
            (
                "playlists.json",
                serde_json::to_vec(&Catalog::default()).unwrap(),
            ),
            (
                "settings.json",
                serde_json::to_vec(&Settings::default()).unwrap(),
            ),
        ];
        for (name, bytes) in &originals {
            fs::write(
                dir.path().join(name),
                if *name == corrupt_name {
                    b"{".as_slice()
                } else {
                    bytes.as_slice()
                },
            )
            .unwrap();
        }
        let store = PlaybackStore::open(dir.path());
        assert_eq!(store.load_state(), LoadState::Corrupt, "{corrupt_name}");
        assert!(store.snapshot().is_err());
        assert!(crate::store::save_settings(dir.path(), &Settings::default()).is_err());
        assert!(!dir.path().join(FILE_NAME).exists());
        for (name, bytes) in &originals {
            assert_eq!(
                fs::read(dir.path().join(name)).unwrap(),
                if *name == corrupt_name {
                    b"{".to_vec()
                } else {
                    bytes.clone()
                }
            );
        }
    }
}

#[test]
fn legacy_catalog_edits_survive_migration_when_the_old_queue_mirror_is_stale() {
    let dir = tempfile::tempdir().unwrap();
    let kept = QueueItem::manual(PathBuf::from("/synthetic/kept.flac"));
    let deleted = QueueItem::manual(PathBuf::from("/synthetic/deleted.flac"));
    let added = QueueItem::manual(PathBuf::from("/synthetic/added.flac"));
    let mut catalog = Catalog::default();
    catalog.normal = Some(NormalResume {
        items: vec![kept.clone(), added.clone()],
        folder_pos: Some(2),
    });
    let originals = [
        (
            "queue.json",
            serde_json::to_vec(&vec![kept.clone(), deleted.clone()]).unwrap(),
        ),
        ("session.json", serde_json::to_vec(&Session::new()).unwrap()),
        ("playlists.json", serde_json::to_vec(&catalog).unwrap()),
        (
            "settings.json",
            serde_json::to_vec(&Settings::default()).unwrap(),
        ),
    ];
    for (name, bytes) in &originals {
        fs::write(dir.path().join(name), bytes).unwrap();
    }
    let snapshot = PlaybackStore::open(dir.path()).snapshot().unwrap();
    let restored = crate::store::restored_pending(&snapshot.session.in_flight, &snapshot.queue);
    assert_eq!(restored, vec![kept, added]);
    assert!(!restored
        .iter()
        .any(|item| item.entry_id == deleted.entry_id));
    for (name, bytes) in originals {
        assert_eq!(fs::read(dir.path().join(name)).unwrap(), bytes);
    }
}

#[test]
fn missing_or_blank_snapshot_occurrence_ids_are_preserved_as_corrupt_data() {
    for location in [
        "/queue/0",
        "/session/in_flight/0",
        "/catalog/normal/items/0",
        "/catalog/current/queue_item",
    ] {
        for missing in [true, false] {
            let fixture = Fixture::new();
            let item = fixture.before.queue[0].clone();
            let mut state = fixture.before.clone();
            state.catalog.current = Some(crate::playlists::CurrentOccurrence {
                playlist_id: None,
                run_id: 0,
                entry_id: None,
                track_ref: TrackRef {
                    content_hash: "synthetic".into(),
                    preferred_path: item.path.clone(),
                    title: "Current".into(),
                    artist: String::new(),
                },
                origin: crate::playlists::PlaybackOrigin::Normal,
                queue_origin: Some(item.origin),
                queue_item: Some(item),
            });
            let mut value = serde_json::to_value(state).unwrap();
            let object = value
                .pointer_mut(location)
                .unwrap()
                .as_object_mut()
                .unwrap();
            if missing {
                object.remove("entry_id");
            } else {
                object.insert("entry_id".into(), serde_json::Value::String(String::new()));
            }
            let bytes = serde_json::to_vec(&value).unwrap();
            fs::write(fixture.root.path().join(FILE_NAME), &bytes).unwrap();
            let store = PlaybackStore::open(fixture.root.path());
            assert_eq!(
                store.load_state(),
                LoadState::Corrupt,
                "{location}, missing={missing}"
            );
            assert!(store.snapshot().is_err());
            assert!(crate::store::save_session(fixture.root.path(), &Session::new()).is_err());
            assert_eq!(
                fs::read(fixture.root.path().join(FILE_NAME)).unwrap(),
                bytes
            );
        }
    }
}

#[test]
fn contradictory_current_identity_is_read_only_instead_of_deduplicating_data_away() {
    for conflict_location in 0..3 {
        let fixture = Fixture::new();
        let mut state = fixture.before.clone();
        let mut current = state.queue[0].clone();
        if conflict_location == 1 {
            state.queue.retain(|item| item.entry_id != current.entry_id);
        } else if conflict_location == 0 {
            state
                .session
                .in_flight
                .retain(|item| item.entry_id != current.entry_id);
        }
        if conflict_location == 2 {
            state.queue.clear();
            state.session.in_flight.clear();
        }
        current.path = PathBuf::from("/synthetic/conflicting.flac");
        state.catalog.current = Some(crate::playlists::CurrentOccurrence {
            playlist_id: None,
            run_id: 0,
            entry_id: None,
            track_ref: TrackRef {
                content_hash: "synthetic".into(),
                preferred_path: current.path.clone(),
                title: "Current".into(),
                artist: String::new(),
            },
            origin: crate::playlists::PlaybackOrigin::Normal,
            queue_origin: Some(current.origin),
            queue_item: Some(current),
        });
        let bytes = serde_json::to_vec(&state).unwrap();
        fs::write(fixture.root.path().join(FILE_NAME), &bytes).unwrap();
        let store = PlaybackStore::open(fixture.root.path());
        assert_eq!(store.load_state(), LoadState::Corrupt);
        assert!(store.snapshot().is_err());
        assert!(
            crate::store::save_queue(fixture.root.path(), &VecDeque::<QueueItem>::new()).is_err()
        );
        assert_eq!(
            fs::read(fixture.root.path().join(FILE_NAME)).unwrap(),
            bytes
        );
    }
}

#[test]
fn legacy_missing_ids_are_generated_once_and_stay_stable_after_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let queue = br#"[{"path":"/synthetic/same.flac","origin":"manual"}]"#;
    let session =
        br#"{"in_flight":[{"path":"/synthetic/same.flac","origin":"manual"}],"paused":false}"#;
    fs::write(dir.path().join("queue.json"), queue).unwrap();
    fs::write(dir.path().join("session.json"), session).unwrap();
    let store = PlaybackStore::open(dir.path());
    let before = store.snapshot().unwrap();
    assert_ne!(
        before.queue[0].entry_id,
        before.session.in_flight[0].entry_id
    );
    drop(store);
    assert_eq!(PlaybackStore::open(dir.path()).snapshot().unwrap(), before);
    assert_eq!(fs::read(dir.path().join("queue.json")).unwrap(), queue);
    assert_eq!(fs::read(dir.path().join("session.json")).unwrap(), session);
}
