use super::*;
use std::fs;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

struct Fixture {
    root: PathBuf,
    music: PathBuf,
    data: PathBuf,
    cache: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("funkot-scan-{}-{}",
            std::process::id(), std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let music = root.join("music");
        let data = root.join("data");
        let cache = root.join("cache");
        for path in [&music, &data, &cache] { fs::create_dir_all(path).unwrap(); }
        let wav = [b"RIFF".as_slice(), &44u32.to_le_bytes(), b"WAVEfmt ",
            &16u32.to_le_bytes(), &1u16.to_le_bytes(), &1u16.to_le_bytes(),
            &8000u32.to_le_bytes(), &16000u32.to_le_bytes(), &2u16.to_le_bytes(),
            &16u16.to_le_bytes(), b"data", &8u32.to_le_bytes(),
            &[0, 0, 10, 0, 246, 255, 0, 0]].concat();
        fs::write(music.join("synthetic.wav"), wav).unwrap();
        Self { root, music, data, cache }
    }

    fn scan(&self) -> LibraryScanResult {
        let _index = INDEX_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        scan_library_under_index_lock(&self.music, &self.cache, &self.data, |_| {})
            .expect("readable tracks survive auxiliary persistence failure").reply
    }

    fn save_default_playback_state(&self) {
        store::save_settings(&self.data, &store::Settings::default()).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); }
}

#[test]
fn index_write_failure_keeps_tracks_and_retries_without_claiming_saved_tags() {
    let fixture = Fixture::new();
    let blocked = fixture.data.join("hash-index.json");
    fs::create_dir(&blocked).unwrap();
    fs::write(blocked.join("preserved"), b"original").unwrap();
    let before = tag_service::list(&fixture.data);
    let scanned = fixture.scan();
    assert_eq!(scanned.rows.len(), 1);
    assert!(scanned.rows[0].content_hash.is_some());
    assert_eq!(scanned.rows[0].added_order, None);
    assert!(scanned.persistence_error.as_deref().unwrap().contains("hash-index"));
    assert!(!store::load_settings(&fixture.data).arrivals_baseline_done);
    let after = tag_service::list(&fixture.data);
    assert_eq!(after.revision, before.revision);
    assert!(!after.ready);
    assert_eq!(fs::read(blocked.join("preserved")).unwrap(), b"original");
    fs::remove_file(blocked.join("preserved")).unwrap();
    fs::remove_dir(&blocked).unwrap();
    let retried = fixture.scan();
    assert_eq!(retried.rows.len(), 1);
    assert!(retried.persistence_error.is_none());
    assert!(store::load_settings(&fixture.data).arrivals_baseline_done);
    assert!(tag_service::list(&fixture.data).ready);
}

#[test]
fn read_only_playback_state_keeps_tracks_and_publishes_only_saved_index() {
    let fixture = Fixture::new();
    let original = b"synthetic corrupt playback state";
    fs::write(fixture.data.join("playback-state.json"), original).unwrap();
    let scanned = fixture.scan();
    assert_eq!(scanned.rows.len(), 1);
    assert!(scanned.persistence_error.as_deref().unwrap().contains("settings"));
    assert!(!store::load_settings(&fixture.data).arrivals_baseline_done);
    assert_eq!(store::load_hash_index(&fixture.data).provenance, store::HashIndexProvenance::Loaded);
    assert!(tag_service::list(&fixture.data).ready);
    assert_eq!(fs::read(fixture.data.join("playback-state.json")).unwrap(), original);
    let retried = fixture.scan();
    assert_eq!(retried.rows.len(), 1);
    assert!(retried.persistence_error.is_some());
}

#[test]
fn missing_music_folder_is_an_actual_read_failure() {
    let fixture = Fixture::new();
    let _index = INDEX_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let error = scan_library_under_index_lock(&fixture.music.join("missing"), &fixture.cache, &fixture.data, |_| {});
    assert!(error.is_err());
    assert!(!fixture.data.join("hash-index.json").exists());
}

#[test]
fn normal_scan_commits_baseline_and_reads_the_same_tracks_again() {
    let fixture = Fixture::new();
    for _ in 0..2 {
        let scanned = fixture.scan();
        assert_eq!(scanned.rows.len(), 1);
        assert!(scanned.persistence_error.is_none());
        assert!(store::load_settings(&fixture.data).arrivals_baseline_done);
        assert_eq!(store::load_hash_index(&fixture.data).index.len(), 1);
    }
}

#[test]
fn legacy_conflict_keeps_sources_exact_while_scan_waits_for_real_resolution() {
    let fixture = Fixture::new();
    let queue = vec![queue::QueueItem::manual(PathBuf::from("/synthetic/queue.wav"))];
    let catalog_items = vec![queue::QueueItem::manual(PathBuf::from("/synthetic/catalog.wav"))];
    let mut catalog = playlists::Catalog::default();
    catalog.normal = Some(playlists::NormalResume {
        items: catalog_items,
        folder_pos: None,
    });
    let originals = [
        ("queue.json", serde_json::to_vec(&queue).unwrap()),
        ("session.json", serde_json::to_vec(&store::Session::new()).unwrap()),
        ("playlists.json", serde_json::to_vec(&catalog).unwrap()),
        ("settings.json", serde_json::to_vec(&store::Settings::default()).unwrap()),
    ];
    for (name, bytes) in &originals {
        fs::write(fixture.data.join(name), bytes).unwrap();
    }

    let scanned = fixture.scan();
    assert_eq!(scanned.rows.len(), 1);
    assert_eq!(
        scanned.rows[0].path,
        fixture.music.join("synthetic.wav").to_string_lossy().into_owned()
    );
    assert!(scanned.rows[0].content_hash.is_some());
    assert!(scanned.persistence_error.is_none());
    assert!(!store::load_settings(&fixture.data).arrivals_baseline_done);
    for (name, bytes) in &originals {
        assert_eq!(fs::read(fixture.data.join(name)).unwrap(), *bytes);
    }

    let playback = playback_state::PlaybackStore::open(&fixture.data);
    let token = match playback.recovery_status() {
        playback_state::PlaybackRecoveryStatus::LegacyNormalConflict { token, .. } => token,
        status => panic!("expected legacy conflict, got {status:?}"),
    };
    playback
        .resolve_legacy_normal_conflict(
            token,
            playback_state::LegacyNormalChoice::QueueFile,
            |_| Ok(()),
        )
        .unwrap();
    drop(playback);
    for (name, bytes) in &originals {
        assert_eq!(fs::read(fixture.data.join(name)).unwrap(), *bytes);
    }

    let retried = fixture.scan();
    assert_eq!(retried.rows.len(), 1);
    assert!(retried.persistence_error.is_none());
    assert!(store::load_settings(&fixture.data).arrivals_baseline_done);
}

#[test]
fn exhausted_added_order_returns_rows_without_committing_an_order() {
    let fixture = Fixture::new();
    let mut index = store::HashIndex::new();
    index.insert(
        "/synthetic/exhausted.wav".into(),
        store::HashIndexEntry {
            metadata_version: 0,
            embedded_metadata: None,
            metadata_error: None,
            mtime_ms: 1,
            len: 1,
            hash: "exhausted".into(),
            tags_cached: false,
            title: None,
            artist: None,
            first_seen: None,
            added_order: Some(u64::MAX),
        },
    );
    store::save_hash_index(&fixture.data, &index).unwrap();
    let before = fs::read(fixture.data.join("hash-index.json")).unwrap();

    let scanned = fixture.scan();
    assert_eq!(scanned.rows.len(), 1);
    assert!(scanned.rows[0].content_hash.is_some());
    assert_eq!(scanned.rows[0].added_order, None);
    assert!(scanned
        .persistence_error
        .as_deref()
        .is_some_and(|message| message.contains("addition order exhausted")));
    assert_eq!(fs::read(fixture.data.join("hash-index.json")).unwrap(), before);
    assert!(!store::load_settings(&fixture.data).arrivals_baseline_done);
}

#[test]
fn failed_baseline_snapshot_save_keeps_baseline_pending_until_retry() {
    let fixture = Fixture::new();
    fixture.save_default_playback_state();
    playback_state::set_fail_persist_stage(3);

    let failed = fixture.scan();
    assert_eq!(failed.rows.len(), 1);
    assert!(failed.rows[0].content_hash.is_some());
    assert!(failed
        .persistence_error
        .as_deref()
        .is_some_and(|message| message.contains("settings")));
    assert_eq!(store::load_hash_index(&fixture.data).provenance, store::HashIndexProvenance::Loaded);
    assert!(!store::load_settings(&fixture.data).arrivals_baseline_done);

    let retried = fixture.scan();
    assert_eq!(retried.rows.len(), 1);
    assert!(retried.persistence_error.is_none());
    assert!(store::load_settings(&fixture.data).arrivals_baseline_done);
}

#[test]
fn interrupted_baseline_writer() {
    let Ok(stage) = std::env::var("FUNKOT_SCAN_CRASH_STAGE") else {
        return;
    };
    let music = PathBuf::from(std::env::var_os("FUNKOT_SCAN_MUSIC").unwrap());
    let cache = PathBuf::from(std::env::var_os("FUNKOT_SCAN_CACHE").unwrap());
    let data = PathBuf::from(std::env::var_os("FUNKOT_SCAN_DATA").unwrap());
    playback_state::set_crash_stage(stage.parse().unwrap());
    let _index = INDEX_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    scan_library_under_index_lock(&music, &cache, &data, |_| {}).unwrap();
    panic!("the parent must terminate this child at the requested cut");
}

#[test]
fn process_cut_during_baseline_commit_recovers_a_complete_snapshot_and_retries() {
    for stage in 0..=4 {
        let fixture = Fixture::new();
        fixture.save_default_playback_state();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "library_scan_tests::interrupted_baseline_writer",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("FUNKOT_SCAN_CRASH_STAGE", stage.to_string())
            .env("FUNKOT_SCAN_MUSIC", &fixture.music)
            .env("FUNKOT_SCAN_CACHE", &fixture.cache)
            .env("FUNKOT_SCAN_DATA", &fixture.data)
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
        child.kill().unwrap();
        assert!(!child.wait().unwrap().success());

        let playback = playback_state::PlaybackStore::open(&fixture.data);
        assert_eq!(
            playback.settings_snapshot().unwrap().arrivals_baseline_done,
            stage == 4,
            "stage {stage} must recover one complete settings revision"
        );
        drop(playback);
        assert_eq!(store::load_hash_index(&fixture.data).provenance, store::HashIndexProvenance::Loaded);

        let retried = fixture.scan();
        assert_eq!(retried.rows.len(), 1);
        assert!(retried.persistence_error.is_none());
        assert!(store::load_settings(&fixture.data).arrivals_baseline_done);
    }
}
