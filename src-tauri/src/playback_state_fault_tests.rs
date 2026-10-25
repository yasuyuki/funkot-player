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
        let stores = process_spawn_guard();
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
        drop(stores);
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
        assert_eq!(store.recovery_status(), PlaybackRecoveryStatus::Blocked { reason: LoadState::Corrupt });
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
fn legacy_catalog_queue_disagreement_preserves_both_possible_histories() {
    let kept = QueueItem::manual(PathBuf::from("/synthetic/kept.flac"));
    let deleted = QueueItem::manual(PathBuf::from("/synthetic/deleted.flac"));
    let added = QueueItem::manual(PathBuf::from("/synthetic/added.flac"));
    let automatic = QueueItem::automatic(PathBuf::from("/synthetic/automatic.flac"));
    for (normal, queue) in [
        (vec![kept.clone(), added.clone()], vec![kept.clone(), deleted.clone()]),
        (vec![kept.clone(), deleted], vec![kept, added]),
        (vec![], vec![automatic]),
    ] {
        for choice in [LegacyNormalChoice::QueueFile, LegacyNormalChoice::CatalogNormal] {
            let dir = tempfile::tempdir().unwrap();
            let mut catalog = Catalog::default();
            catalog.normal = Some(NormalResume { items: normal.clone(), folder_pos: Some(2) });
            let originals = [
                ("queue.json", serde_json::to_vec(&queue).unwrap()),
                ("session.json", serde_json::to_vec(&Session::new()).unwrap()),
                ("playlists.json", serde_json::to_vec(&catalog).unwrap()),
                ("settings.json", serde_json::to_vec(&Settings::default()).unwrap()),
            ];
            for (name, bytes) in &originals { fs::write(dir.path().join(name), bytes).unwrap(); }
            let store = PlaybackStore::open(dir.path());
            let token = match store.recovery_status() {
                PlaybackRecoveryStatus::LegacyNormalConflict { token, queue_file_items, catalog_normal_items } => {
                    assert_eq!(queue_file_items, queue.len());
                    assert_eq!(catalog_normal_items, normal.len());
                    token
                }
                status => panic!("expected conflict, got {status:?}"),
            };
            assert_eq!(store.load_state(), LoadState::LegacyNormalConflict);
            assert!(store.snapshot().is_err());
            assert!(crate::store::save_session(dir.path(), &Session::new()).is_err());
            assert!(!dir.path().join(FILE_NAME).exists());
            for (name, bytes) in &originals { assert_eq!(fs::read(dir.path().join(name)).unwrap(), *bytes); }

            store.resolve_legacy_normal_conflict(token, choice, |_| Ok(())).unwrap();
            let resolved = store.snapshot().unwrap();
            let expected = if choice == LegacyNormalChoice::QueueFile { &queue } else { &normal };
            assert_eq!(&resolved.queue, expected);
            assert_eq!(&resolved.catalog.normal.unwrap().items, expected);
            for (name, bytes) in originals { assert_eq!(fs::read(dir.path().join(name)).unwrap(), bytes); }
        }
    }
}

#[test]
fn conflict_resolution_rejects_wrong_tokens_changed_legacy_bytes_and_failed_persists() {
    let dir = tempfile::tempdir().unwrap();
    let queue = vec![QueueItem::manual(PathBuf::from("/synthetic/queue.flac"))];
    let normal = vec![QueueItem::manual(PathBuf::from("/synthetic/catalog.flac"))];
    let mut catalog = Catalog::default();
    catalog.normal = Some(NormalResume { items: normal, folder_pos: None });
    fs::write(dir.path().join("queue.json"), serde_json::to_vec(&queue).unwrap()).unwrap();
    fs::write(dir.path().join("session.json"), serde_json::to_vec(&Session::new()).unwrap()).unwrap();
    fs::write(dir.path().join("playlists.json"), serde_json::to_vec(&catalog).unwrap()).unwrap();
    fs::write(dir.path().join("settings.json"), serde_json::to_vec(&Settings::default()).unwrap()).unwrap();
    let store = PlaybackStore::open(dir.path());
    let token = match store.recovery_status() {
        PlaybackRecoveryStatus::LegacyNormalConflict { token, .. } => token,
        status => panic!("expected conflict, got {status:?}"),
    };

    assert_eq!(store.resolve_legacy_normal_conflict(token + 1, LegacyNormalChoice::QueueFile, |_| Ok(())), Err(PlaylistError::Stale));
    assert!(!dir.path().join(FILE_NAME).exists());
    fs::write(dir.path().join("queue.json"), b"[]").unwrap();
    assert_eq!(store.resolve_legacy_normal_conflict(token, LegacyNormalChoice::QueueFile, |_| Ok(())), Err(PlaylistError::Stale));
    assert!(!dir.path().join(FILE_NAME).exists());
}

#[test]
fn failed_conflict_persist_remains_retryable() {
    let dir = tempfile::tempdir().unwrap();
    let queue = vec![QueueItem::manual(PathBuf::from("/synthetic/queue.flac"))];
    let normal = vec![QueueItem::manual(PathBuf::from("/synthetic/catalog.flac"))];
    let mut catalog = Catalog::default();
    catalog.normal = Some(NormalResume { items: normal, folder_pos: None });
    fs::write(dir.path().join("queue.json"), serde_json::to_vec(&queue).unwrap()).unwrap();
    fs::write(dir.path().join("session.json"), serde_json::to_vec(&Session::new()).unwrap()).unwrap();
    fs::write(dir.path().join("playlists.json"), serde_json::to_vec(&catalog).unwrap()).unwrap();
    fs::write(dir.path().join("settings.json"), serde_json::to_vec(&Settings::default()).unwrap()).unwrap();
    let store = PlaybackStore::open(dir.path());
    let token = match store.recovery_status() {
        PlaybackRecoveryStatus::LegacyNormalConflict { token, .. } => token,
        status => panic!("expected conflict, got {status:?}"),
    };

    set_fail_persist_stage(3);
    assert!(store.resolve_legacy_normal_conflict(token, LegacyNormalChoice::QueueFile, |_| Ok(())).is_err());
    assert!(matches!(store.recovery_status(), PlaybackRecoveryStatus::LegacyNormalConflict { token: retry_token, .. } if retry_token == token));
    assert!(!dir.path().join(FILE_NAME).exists());
    store.resolve_legacy_normal_conflict(token, LegacyNormalChoice::QueueFile, |_| Ok(())).unwrap();
    assert_eq!(store.recovery_status(), PlaybackRecoveryStatus::Ready);
}

#[test]
fn conflict_choices_preserve_the_complete_snapshot_and_status_exposes_counts_only() {
    let current = QueueItem::manual(PathBuf::from("/synthetic/current.flac"));
    let queue_duplicate_one = QueueItem::manual(PathBuf::from("/synthetic/queue-repeat.flac"));
    let queue_duplicate_two = QueueItem::manual(PathBuf::from("/synthetic/queue-repeat.flac"));
    let catalog_duplicate_one = QueueItem::automatic(PathBuf::from("/synthetic/catalog-repeat.flac"));
    let catalog_duplicate_two = QueueItem::automatic(PathBuf::from("/synthetic/catalog-repeat.flac"));
    let queue_items = vec![current.clone(), queue_duplicate_one.clone(), queue_duplicate_two.clone()];
    let catalog_items = vec![current.clone(), catalog_duplicate_one.clone(), catalog_duplicate_two.clone()];
    let mut catalog = Catalog::default();
    let definition = catalog.create("kept definition", vec![TrackRef {
        content_hash: "kept-hash".into(), preferred_path: PathBuf::from("/synthetic/definition.flac"),
        title: "Kept definition".into(), artist: "Kept artist".into(),
    }]).unwrap();
    catalog.runs.get_mut(&definition).unwrap().consumed.insert(catalog.definitions[0].entries[0].entry_id.clone());
    catalog.normal = Some(NormalResume { items: catalog_items.clone(), folder_pos: Some(9) });
    catalog.current = Some(crate::playlists::CurrentOccurrence {
        playlist_id: None, run_id: 0, entry_id: None,
        track_ref: TrackRef { content_hash: "current-hash".into(), preferred_path: current.path.clone(), title: "Current".into(), artist: String::new() },
        origin: crate::playlists::PlaybackOrigin::Normal,
        queue_origin: Some(current.origin), queue_item: Some(current.clone()),
    });
    let session = Session { in_flight: vec![current.clone()], paused: true };
    let settings = Settings {
        locale: Some("ja".into()), allow_non_funkot: false, arrivals_baseline_done: true,
        ..Settings::default()
    };

    for choice in [LegacyNormalChoice::QueueFile, LegacyNormalChoice::CatalogNormal] {
        let dir = tempfile::tempdir().unwrap();
        let originals = [
            ("queue.json", serde_json::to_vec(&queue_items).unwrap()),
            ("session.json", serde_json::to_vec(&session).unwrap()),
            ("playlists.json", serde_json::to_vec(&catalog).unwrap()),
            ("settings.json", serde_json::to_vec(&settings).unwrap()),
        ];
        for (name, bytes) in &originals { fs::write(dir.path().join(name), bytes).unwrap(); }
        let store = PlaybackStore::open(dir.path());
        assert_eq!(crate::store::load_settings(dir.path()), settings);
        assert!(crate::store::save_settings(dir.path(), &Settings::default()).is_err());
        let status = store.recovery_status();
        let token = match &status {
            PlaybackRecoveryStatus::LegacyNormalConflict { token, queue_file_items, catalog_normal_items } => {
                assert_eq!((*queue_file_items, *catalog_normal_items), (queue_items.len(), catalog_items.len()));
                *token
            }
            status => panic!("expected conflict, got {status:?}"),
        };
        let exposed = serde_json::to_string(&status).unwrap();
        assert!(!exposed.contains(current.path.to_string_lossy().as_ref()));
        assert!(!exposed.contains(&current.entry_id));

        store.resolve_legacy_normal_conflict(token, choice, |_| Ok(())).unwrap();
        let resolved = store.snapshot().unwrap();
        let expected_items = if choice == LegacyNormalChoice::QueueFile { &queue_items } else { &catalog_items };
        assert_eq!(&resolved.queue, expected_items);
        assert_eq!(&resolved.catalog.normal.as_ref().unwrap().items, expected_items);
        assert_eq!(resolved.session, session);
        assert_eq!(resolved.settings, settings);
        assert_eq!(resolved.catalog.definitions, catalog.definitions);
        assert_eq!(resolved.catalog.runs, catalog.runs);
        assert_eq!(resolved.catalog.current, catalog.current);
        let committed = fs::read(dir.path().join(FILE_NAME)).unwrap();
        let other = if choice == LegacyNormalChoice::QueueFile { LegacyNormalChoice::CatalogNormal } else { LegacyNormalChoice::QueueFile };
        assert_eq!(store.resolve_legacy_normal_conflict(token, other, |_| Ok(())), Err(PlaylistError::Stale));
        assert_eq!(fs::read(dir.path().join(FILE_NAME)).unwrap(), committed);
        for (name, bytes) in originals { assert_eq!(fs::read(dir.path().join(name)).unwrap(), bytes); }
    }
}

#[test]
fn legacy_catalog_is_imported_when_the_queue_file_is_absent() {
    let dir = tempfile::tempdir().unwrap();
    let item = QueueItem::manual(PathBuf::from("/synthetic/only-catalog.flac"));
    let mut catalog = Catalog::default();
    catalog.normal = Some(NormalResume { items: vec![item.clone()], folder_pos: None });
    let bytes = serde_json::to_vec(&catalog).unwrap();
    fs::write(dir.path().join("playlists.json"), &bytes).unwrap();
    let snapshot = PlaybackStore::open(dir.path()).snapshot().unwrap();
    assert_eq!(snapshot.queue, vec![item]);
    assert_eq!(fs::read(dir.path().join("playlists.json")).unwrap(), bytes);
}

#[test]
fn legacy_old_queue_new_session_and_new_queue_old_session_restore_each_id_once() {
    let current = QueueItem::manual(PathBuf::from("/synthetic/repeated.flac"));
    let prepared = QueueItem::manual(current.path.clone());
    let unrelated = QueueItem::automatic(PathBuf::from("/synthetic/unrelated.flac"));
    for old_queue in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let queue = if old_queue { vec![current.clone(), prepared.clone(), unrelated.clone()] }
            else { vec![prepared.clone(), unrelated.clone()] };
        let session = Session { in_flight: if old_queue { vec![current.clone(), prepared.clone()] }
            else { vec![current.clone()] }, paused: false };
        let queue_bytes = serde_json::to_vec(&queue).unwrap();
        let session_bytes = serde_json::to_vec(&session).unwrap();
        fs::write(dir.path().join("queue.json"), &queue_bytes).unwrap();
        fs::write(dir.path().join("session.json"), &session_bytes).unwrap();
        let store = PlaybackStore::open(dir.path());
        let state = store.snapshot().unwrap();
        assert_eq!(crate::store::restored_pending(&state.session.in_flight, &state.queue),
            vec![current.clone(), prepared.clone(), unrelated.clone()]);
        drop(store);
        assert_eq!(PlaybackStore::open(dir.path()).snapshot().unwrap(), state);
        assert_eq!(fs::read(dir.path().join("queue.json")).unwrap(), queue_bytes);
        assert_eq!(fs::read(dir.path().join("session.json")).unwrap(), session_bytes);
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

#[test]
fn suspended_normal_identity_conflicts_without_current_are_read_only() {
    for conflict_in_session in [false, true] {
        let fixture = Fixture::new();
        let mut state = fixture.before.clone();
        let selected = state.catalog.create("Active", vec![]).unwrap();
        state.catalog.select(Some(selected)).unwrap();
        state.catalog.current = None;
        let mut conflict = state.catalog.normal.as_ref().unwrap().items[0].clone();
        conflict.path = PathBuf::from("/synthetic/conflicting-suspended.flac");
        state.queue.clear();
        state.session.in_flight.clear();
        if conflict_in_session {
            state.session.in_flight.push(conflict);
        } else {
            state.queue.push(conflict);
        }
        let bytes = serde_json::to_vec(&state).unwrap();
        fs::write(fixture.root.path().join(FILE_NAME), &bytes).unwrap();
        let store = PlaybackStore::open(fixture.root.path());
        assert_eq!(store.load_state(), LoadState::Corrupt);
        assert!(store.snapshot().is_err());
        assert!(crate::store::save_session(fixture.root.path(), &Session::new()).is_err());
        assert_eq!(fs::read(fixture.root.path().join(FILE_NAME)).unwrap(), bytes);
    }
}
