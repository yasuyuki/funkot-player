//! Committed library/tag snapshots. Lock order: scan INDEX_LOCK -> SERVICES ->
//! manual store. Editing only takes SERVICES -> manual store, never playback
//! locks or INDEX_LOCK. Scans publish automatic data; they cannot save manual data.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use crate::{audio_metadata, store, track_tags as tags};

#[derive(Debug, Clone, serde::Serialize)]
pub struct CommandError { pub code: &'static str, pub message: String }
fn error(code: &'static str) -> CommandError { CommandError { code, message: code.into() } }
fn store_error(e: tags::StoreError) -> CommandError {
    error(match e {
        tags::StoreError::ReadOnly(_) => "store_read_only",
        tags::StoreError::Conflict => "stale_revision",
        tags::StoreError::Busy => "busy",
        tags::StoreError::InvalidPatch => "invalid_input",
        tags::StoreError::Io(_) => "persist_failed",
    })
}
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Target { pub path: String, pub expected_hash: String }
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct Patch {
    pub year_change: Option<tags::YearState>,
    #[serde(default)] pub add: Vec<tags::Tag>,
    #[serde(default)] pub remove: Vec<tags::Tag>,
}
#[derive(Debug, Clone, serde::Deserialize)]
pub struct UpdateRequest { pub targets: Vec<Target>, pub expected_revision: String, pub patch: Patch }
#[derive(Debug, Clone, serde::Serialize)]
pub struct TagView { pub key: String, pub kind: &'static str, pub value: String, pub origin: &'static str }
#[derive(Debug, Clone, serde::Serialize)]
pub struct ManualView { pub year: tags::YearState, pub manual_additions: Vec<tags::Tag>, pub suppressed_auto_tags: Vec<tags::Tag> }
#[derive(Debug, Clone, serde::Serialize)]
pub struct TrackState {
    pub content_hash: Option<String>,
    pub effective: Vec<TagView>,
    pub manual: ManualView,
    pub auto_year: Option<u16>,
    pub year_status: &'static str,
    pub metadata_status: &'static str,
    pub candidates: Vec<audio_metadata::YearCandidate>,
    pub diagnostics: Vec<String>,
}
#[derive(Debug, Clone, serde::Serialize)]
pub struct Snapshot { pub revision: String, pub ready: bool, pub store_status: &'static str, pub tracks: BTreeMap<String, TrackState> }
#[derive(Debug, Clone, serde::Serialize)]
pub struct UpdateResult { pub snapshot: Snapshot, pub changed: usize, pub no_op: usize }

struct Service {
    manual: tags::TrackTagsStore,
    library: BTreeMap<String, Option<store::HashIndexEntry>>,
    ready: bool,
    epoch: u64,
    session: String,
}
fn services() -> &'static Mutex<BTreeMap<PathBuf, Service>> {
    static SERVICES: OnceLock<Mutex<BTreeMap<PathBuf, Service>>> = OnceLock::new();
    SERVICES.get_or_init(|| Mutex::new(BTreeMap::new()))
}
impl Service {
    fn new(dir: &Path) -> Self {
        Self { manual: tags::TrackTagsStore::load(dir), library: BTreeMap::new(), ready: false, epoch: 0,
            session: format!("{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()) }
    }
    fn revision(&self, year: u16) -> String {
        let revision = self.manual.snapshot().map(|s| s.revision).unwrap_or_else(|_| "read-only".into());
        format!("{}/{}/{}/{}", self.session, self.epoch, year, revision)
    }
    fn publish(&mut self, library: BTreeMap<String, Option<store::HashIndexEntry>>) {
        if !self.ready || self.library != library {
            self.library = library;
            self.epoch += 1;
            self.ready = true;
        }
    }
    fn snapshot(&self, year: u16) -> Snapshot {
        let manual = self.manual.snapshot().ok();
        let store_status = match self.manual.load_state() {
            tags::LoadState::Missing => "missing", tags::LoadState::Ready => "ready",
            tags::LoadState::Corrupt => "corrupt", tags::LoadState::UnsupportedSchema => "unsupported_schema",
            tags::LoadState::IoError => "io_error",
        };
        let tracks = self.library.iter().map(|(path, entry)| {
            let record = entry.as_ref().and_then(|e| manual.as_ref()?.tracks.get(&e.hash)).cloned()
                .unwrap_or(tags::TrackManualState { year: tags::YearState::Auto, manual_additions: vec![], suppressed_auto_tags: vec![] });
            (path.clone(), track_state(entry.as_ref(), record, year))
        }).collect();
        Snapshot { revision: self.revision(year), ready: self.ready, store_status, tracks }
    }
    fn update(&mut self, request: UpdateRequest, year: u16) -> Result<UpdateResult, CommandError> {
        if !self.ready { return Err(error("identity_unavailable")); }
        if self.revision(year) != request.expected_revision { return Err(error("stale_revision")); }
        if request.targets.is_empty() { return Err(error("invalid_input")); }
        let mut hashes = Vec::new();
        let mut auto = BTreeMap::new();
        for target in &request.targets {
            let entry = self.library.get(&target.path).and_then(Option::as_ref).ok_or_else(|| error("identity_unavailable"))?;
            if target.expected_hash != entry.hash || !store::fingerprint_matches(Path::new(&target.path), entry) {
                return Err(error("identity_changed"));
            }
            hashes.push(entry.hash.clone());
        }
        // Manual state is shared by every path with this hash. Validate against
        // all committed copies, including an unselected copy whose metadata
        // succeeded while a selected copy had a probe error.
        let selected: std::collections::BTreeSet<_> = hashes.iter().collect();
        for entry in self.library.values().flatten() {
            if selected.contains(&entry.hash) {
                auto.entry(entry.hash.clone()).or_insert_with(Vec::new).extend(auto_tags(entry));
            }
        }
        let normalize = |values: Vec<tags::Tag>| -> Result<Vec<tags::Tag>, CommandError> {
            values.into_iter().map(|t| tags::Tag::new(t.kind, t.value).map_err(|_| error("invalid_input"))).collect()
        };
        let patch = tags::TrackTagPatch { year_change: request.patch.year_change,
            add: normalize(request.patch.add)?, remove: normalize(request.patch.remove)? };
        let revision = self.manual.snapshot().map_err(store_error)?.revision;
        let result = self.manual.apply_patch_with_auto(&hashes, &revision, &patch, &auto).map_err(store_error)?;
        Ok(UpdateResult { snapshot: self.snapshot(year), changed: result.changed, no_op: result.no_op })
    }
}
fn auto_tags(entry: &store::HashIndexEntry) -> Vec<tags::Tag> {
    if entry.metadata_version != store::METADATA_VERSION || entry.metadata_error.is_some() { return vec![]; }
    entry.embedded_metadata.as_ref().map(|m| m.genres.iter().filter_map(|v| tags::Tag::new(tags::TagKind::Genre, v).ok()).collect()).unwrap_or_default()
}
fn track_state(entry: Option<&store::HashIndexEntry>, manual: tags::TrackManualState, year: u16) -> TrackState {
    let metadata = entry.and_then(|e| e.embedded_metadata.as_ref());
    let candidates = metadata.map(|m| m.year_candidates.clone()).unwrap_or_default();
    let mut diagnostics = metadata.map(|m| m.diagnostics.clone()).unwrap_or_default();
    let metadata_status = match entry {
        Some(e) if e.metadata_error.is_some() => { diagnostics.push(e.metadata_error.clone().unwrap()); "error" },
        Some(e) if e.metadata_version == store::METADATA_VERSION && metadata.is_some() => "ready",
        _ => "pending",
    };
    let (auto_year, year_status) = match audio_metadata::resolve_year(&candidates, year) {
        audio_metadata::YearResolution::Ready { year, .. } => (Some(year), "resolved"),
        audio_metadata::YearResolution::Missing => (None, "missing"),
        audio_metadata::YearResolution::Future { .. } => (None, "future"),
        audio_metadata::YearResolution::Conflict { .. } => (None, "conflict"),
        audio_metadata::YearResolution::Invalid { .. } => (None, "invalid"),
    };
    let auto_year = if metadata_status == "ready" { auto_year } else { None };
    let auto = entry.map(auto_tags).unwrap_or_default();
    let resolved = tags::effective_tags(&auto, &manual);
    // An excessive embedded set is a diagnosed error, never silent truncation.
    let resolved = if resolved.len() > 128 { diagnostics.push("too_many_effective_tags".into()); tags::effective_tags(&[], &manual) } else { resolved };
    let mut effective: Vec<_> = resolved.into_iter().map(|t| {
        let key = t.tag.key();
        let kind = match t.tag.kind { tags::TagKind::Genre => "genre", tags::TagKind::Custom => "custom" };
        TagView { key: format!("{kind}:{}", key.value), kind, value: t.tag.value,
            origin: match t.origin { tags::TagOrigin::Embedded => "embedded", tags::TagOrigin::Manual => "manual", tags::TagOrigin::Both => "both" } }
    }).collect();
    let effective_year = match manual.year { tags::YearState::Auto => auto_year, tags::YearState::Set { value } => Some(value), tags::YearState::Unset => None };
    if let Some(value) = effective_year { effective.insert(0, TagView { key: format!("year:{value}"), kind: "year", value: value.to_string(), origin: if matches!(manual.year, tags::YearState::Set { .. }) { "manual" } else { "embedded" } }); }
    TrackState { content_hash: entry.map(|e| e.hash.clone()), effective,
        manual: ManualView { year: manual.year, manual_additions: manual.manual_additions, suppressed_auto_tags: manual.suppressed_auto_tags },
        auto_year, year_status, metadata_status, candidates, diagnostics }
}
fn current_year() -> u16 { store::utc_rfc3339_now()[..4].parse().unwrap_or(0) }

pub fn publish(dir: &Path, library: BTreeMap<String, Option<store::HashIndexEntry>>) {
    let mut all = services().lock().unwrap_or_else(|e| e.into_inner());
    all.entry(dir.into()).or_insert_with(|| Service::new(dir)).publish(library);
}
pub fn list(dir: &Path) -> Snapshot {
    let mut all = services().lock().unwrap_or_else(|e| e.into_inner());
    all.entry(dir.into()).or_insert_with(|| Service::new(dir)).snapshot(current_year())
}
pub fn update(dir: &Path, request: UpdateRequest) -> Result<UpdateResult, CommandError> {
    let mut all = services().lock().unwrap_or_else(|e| e.into_inner());
    all.entry(dir.into()).or_insert_with(|| Service::new(dir)).update(request, current_year())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    struct Fixture { dir: PathBuf, path: String, entry: store::HashIndexEntry }
    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!("funkot-tags-service-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
            fs::create_dir_all(&dir).unwrap();
            let path = dir.join("synthetic.wav");
            fs::write(&path, b"synthetic source bytes, only fingerprinted in IPC tests").unwrap();
            let mut index = store::HashIndex::new();
            store::resolve_content_hash(&path, &mut index).unwrap();
            let path = path.to_string_lossy().into_owned();
            let mut entry = index.remove(&path).unwrap();
            entry.metadata_version = store::METADATA_VERSION;
            entry.embedded_metadata = Some(audio_metadata::Metadata {
                genres: vec!["Funkot".into()],
                year_candidates: vec![audio_metadata::YearCandidate { raw_key: "TDRC".into(), raw_value: "2024".into(), semantic: audio_metadata::YearSemantic::Recording, rank: 0 }],
                ..Default::default()
            });
            Self { dir, path, entry }
        }
        fn service(&self) -> Service {
            let mut s = Service::new(&self.dir);
            s.publish(BTreeMap::from([(self.path.clone(), Some(self.entry.clone()))]));
            s
        }
        fn request(&self, s: &Service, patch: Patch) -> UpdateRequest {
            UpdateRequest { targets: vec![Target { path: self.path.clone(), expected_hash: self.entry.hash.clone() }], expected_revision: s.revision(2026), patch }
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.dir); } }

    #[test]
    fn edits_survive_scan_restart_and_leave_sources_and_other_data_unchanged() {
        let f = Fixture::new();
        for name in ["library.json", "labels.json", "history.json", "queue.json"] { fs::write(f.dir.join(name), b"existing user data").unwrap(); }
        let bytes = fs::read(&f.path).unwrap(); let modified = fs::metadata(&f.path).unwrap().modified().unwrap();
        let mut s = f.service();
        let request = f.request(&s, Patch { year_change: Some(tags::YearState::Set { value: 2022 }),
            remove: vec![tags::Tag::new(tags::TagKind::Genre, "funkot").unwrap()], ..Default::default() });
        let result = s.update(request, 2026).unwrap(); assert_eq!(result.changed, 1);
        s.publish(BTreeMap::from([(f.path.clone(), Some(f.entry.clone()))]));
        let restarted = f.service();
        for snapshot in [s.snapshot(2026), restarted.snapshot(2026)] {
            let effective = &snapshot.tracks[&f.path].effective;
            assert_eq!(effective.len(), 1); assert_eq!(effective[0].key, "year:2022");
        }
        assert_eq!(fs::read(&f.path).unwrap(), bytes); assert_eq!(fs::metadata(&f.path).unwrap().modified().unwrap(), modified);
        for name in ["library.json", "labels.json", "history.json", "queue.json"] { assert_eq!(fs::read(f.dir.join(name)).unwrap(), b"existing user data"); }
    }

    #[test]
    fn source_replacement_missing_and_wrong_identity_refuse_entire_batch() {
        let f = Fixture::new(); let mut s = f.service();
        let mut req = f.request(&s, Patch { add: vec![tags::Tag::new(tags::TagKind::Custom, "candidate").unwrap()], ..Default::default() });
        req.targets.push(Target { path: "missing".into(), expected_hash: "none".into() });
        assert_eq!(s.update(req, 2026).unwrap_err().code, "identity_unavailable");
        assert!(!f.dir.join("track-tags.json").exists());
        let mut req = f.request(&s, Patch::default()); req.targets[0].expected_hash = "wrong".into();
        assert_eq!(s.update(req, 2026).unwrap_err().code, "identity_changed");
        let req = f.request(&s, Patch::default()); fs::write(&f.path, b"replacement").unwrap();
        assert_eq!(s.update(req, 2026).unwrap_err().code, "identity_changed");
        let req = f.request(&s, Patch::default()); fs::remove_file(&f.path).unwrap();
        assert_eq!(s.update(req, 2026).unwrap_err().code, "identity_changed");
    }

    #[test]
    fn automatic_changes_invalidate_revision_and_no_op_does_not() {
        let f = Fixture::new(); let mut s = f.service(); let revision = s.revision(2026);
        let no_op = s.update(f.request(&s, Patch::default()), 2026).unwrap();
        assert_eq!(no_op.no_op, 1); assert_eq!(no_op.snapshot.revision, revision);
        let old = f.request(&s, Patch::default());
        let mut changed = f.entry.clone(); changed.embedded_metadata.as_mut().unwrap().genres.push("Pop".into());
        s.publish(BTreeMap::from([(f.path.clone(), Some(changed))]));
        assert_eq!(s.update(old, 2026).unwrap_err().code, "stale_revision");
        assert_ne!(s.revision(2026), s.revision(2027));
    }

    #[test]
    fn duplicate_paths_share_one_transaction_and_all_displays() {
        let f = Fixture::new(); let duplicate = f.dir.join("duplicate.wav"); fs::copy(&f.path, &duplicate).unwrap();
        let mut index = store::HashIndex::new(); store::resolve_content_hash(&duplicate, &mut index).unwrap();
        let duplicate = duplicate.to_string_lossy().into_owned();
        let mut s = f.service(); let mut library = s.library.clone(); library.insert(duplicate.clone(), index.remove(&duplicate)); s.publish(library);
        let mut req = f.request(&s, Patch { add: vec![tags::Tag { kind: tags::TagKind::Custom, value: "  Candidate  ".into() }], ..Default::default() });
        req.targets.push(Target { path: duplicate.clone(), expected_hash: f.entry.hash.clone() });
        let result = s.update(req, 2026).unwrap(); assert_eq!(result.changed, 1);
        for path in [&f.path, &duplicate] { assert!(result.snapshot.tracks[path].effective.iter().any(|t| t.key == "custom:candidate")); }
    }

    #[test]
    fn damaged_store_keeps_embedded_reading_but_rejects_edit() {
        let f = Fixture::new(); fs::write(f.dir.join("track-tags.json"), b"{invalid").unwrap();
        let mut s = f.service(); let snapshot = s.snapshot(2026); assert_eq!(snapshot.store_status, "corrupt");
        assert_eq!(snapshot.tracks[&f.path].auto_year, Some(2024));
        let req = f.request(&s, Patch::default()); assert_eq!(s.update(req, 2026).unwrap_err().code, "store_read_only");
        assert_eq!(fs::read(f.dir.join("track-tags.json")).unwrap(), b"{invalid");
    }

    #[test]
    fn outdated_metadata_is_pending_without_effective_automatic_values() {
        let mut f = Fixture::new(); f.entry.metadata_version = 0;
        let s = f.service(); let snapshot = s.snapshot(2026); let state = &snapshot.tracks[&f.path];
        assert_eq!(state.metadata_status, "pending");
        assert_eq!(state.auto_year, None); assert!(state.effective.is_empty());
    }

    #[test]
    fn real_metadata_probe_preserves_manual_tags_across_rebuild_duplicate_and_restart() {
        use std::time::Instant;

        let dir = std::env::temp_dir().join(format!("funkot-tags-real-service-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/metadata");
        let copies = [
            ("a.flac", "vorbis.flac"),
            ("b.ogg", "vorbis.ogg"),
            ("c.ogg", "no-year-pop.ogg"),
        ];
        for (name, fixture) in copies { fs::copy(fixtures.join(fixture), dir.join(name)).unwrap(); }
        fs::copy(dir.join("a.flac"), dir.join("duplicate.flac")).unwrap();
        fs::rename(dir.join("duplicate.flac"), dir.join("renamed.flac")).unwrap();
        for name in ["labels.json", "history.json", "manual-bars.json"] {
            fs::write(dir.join(name), b"existing baseline user data").unwrap();
        }
        let sources: Vec<_> = ["a.flac", "b.ogg", "c.ogg", "renamed.flac"]
            .into_iter().map(|name| dir.join(name)).collect();
        let before: Vec<_> = sources.iter().map(|path| {
            (path.clone(), fs::read(path).unwrap(), fs::metadata(path).unwrap().modified().unwrap())
        }).collect();

        let mut discovered = store::HashIndex::new();
        for path in &sources { store::resolve_library_file(path, &mut discovered).unwrap(); }
        for (position, entry) in discovered.values_mut().enumerate() {
            entry.metadata_version = 0;
            entry.embedded_metadata = None;
            entry.metadata_error = None;
            entry.tags_cached = true;
            entry.first_seen = Some(format!("2020-01-01T00:00:0{position}Z"));
            entry.added_order = Some(40 + position as u64);
        }
        let legacy_identity: BTreeMap<_, _> = discovered.iter().map(|(path, entry)| {
            (path.clone(), (entry.hash.clone(), entry.first_seen.clone(), entry.added_order))
        }).collect();
        store::save_hash_index(&dir, &discovered).unwrap();
        let mut index = store::load_hash_index(&dir).index;
        let legacy_start = Instant::now();
        for path in &sources { store::resolve_library_file(path, &mut index).unwrap(); }
        let legacy_upgrade_elapsed = legacy_start.elapsed();
        for (path, entry) in &index {
            assert_eq!((entry.hash.clone(), entry.first_seen.clone(), entry.added_order), legacy_identity[path]);
            assert_eq!(entry.metadata_version, store::METADATA_VERSION);
            assert!(entry.embedded_metadata.is_some());
            assert!(entry.metadata_error.is_none());
        }
        let warm_start = Instant::now();
        for path in &sources { store::resolve_library_file(path, &mut index).unwrap(); }
        let warm_elapsed = warm_start.elapsed();
        let key = |name: &str| dir.join(name).to_string_lossy().into_owned();
        let a = key("a.flac"); let b = key("b.ogg"); let c = key("c.ogg"); let renamed = key("renamed.flac");
        assert_eq!(index[&a].embedded_metadata.as_ref().unwrap().genres, vec!["Funkot", "Breakbeat"]);
        assert_eq!(index[&b].embedded_metadata.as_ref().unwrap().genres, vec!["Funkot", "Breakbeat"]);
        assert_eq!(index[&c].embedded_metadata.as_ref().unwrap().genres, vec!["Pop"]);

        let mut service = Service::new(&dir);
        service.publish(index.iter().map(|(path, entry)| (path.clone(), Some(entry.clone()))).collect());
        let initial = service.snapshot(2026);
        assert_eq!(initial.tracks[&a].auto_year, Some(2024));
        assert_eq!(initial.tracks[&b].auto_year, Some(2023));
        assert_eq!(initial.tracks[&c].auto_year, None);

        let request = |service: &Service, targets: Vec<&str>, patch: Patch| UpdateRequest {
            targets: targets.into_iter().map(|path| Target {
                path: path.into(), expected_hash: service.library[path].as_ref().unwrap().hash.clone(),
            }).collect(),
            expected_revision: service.revision(2026), patch,
        };
        let single_start = Instant::now();
        assert_eq!(service.update(request(&service, vec![&a], Patch {
            year_change: Some(tags::YearState::Set { value: 2022 }), ..Default::default()
        }), 2026).unwrap().changed, 1);
        let single_elapsed = single_start.elapsed();
        assert_eq!(service.snapshot(2026).tracks[&a].effective[0].key, "year:2022");
        let mut after_set = Service::new(&dir);
        after_set.publish(index.iter().map(|(path, entry)| (path.clone(), Some(entry.clone()))).collect());
        assert!(matches!(after_set.snapshot(2026).tracks[&a].manual.year, tags::YearState::Set { value: 2022 }));
        assert_eq!(service.update(request(&service, vec![&a], Patch {
            year_change: Some(tags::YearState::Auto), ..Default::default()
        }), 2026).unwrap().changed, 1);
        assert_eq!(service.snapshot(2026).tracks[&a].effective[0].key, "year:2024");
        let batch_start = Instant::now();
        let batch = service.update(request(&service, vec![&a, &b], Patch {
            add: vec![tags::Tag::new(tags::TagKind::Custom, "配信候補").unwrap()], ..Default::default()
        }), 2026).unwrap();
        let batch_elapsed = batch_start.elapsed();
        assert_eq!(batch.changed, 2); // One request is one logical tag-store transaction.
        assert_eq!(batch.snapshot.tracks[&a].effective[0].key, "year:2024");
        assert_eq!(batch.snapshot.tracks[&b].effective[0].key, "year:2023");
        assert!(batch.snapshot.tracks[&renamed].effective.iter().any(|tag| tag.key == "custom:配信候補"));

        assert_eq!(service.update(request(&service, vec![&a], Patch {
            year_change: Some(tags::YearState::Unset),
            remove: vec![tags::Tag::new(tags::TagKind::Genre, "Funkot").unwrap()],
            ..Default::default()
        }), 2026).unwrap().changed, 1);
        let suppressed = service.snapshot(2026);
        assert!(suppressed.tracks[&a].effective.iter().all(|tag| tag.key != "genre:funkot"));
        let mut after_suppress = Service::new(&dir);
        after_suppress.publish(index.iter().map(|(path, entry)| (path.clone(), Some(entry.clone()))).collect());
        assert!(after_suppress.snapshot(2026).tracks[&a].effective.iter().all(|tag| tag.key != "genre:funkot"));
        assert_eq!(service.update(request(&service, vec![&a], Patch {
            add: vec![tags::Tag::new(tags::TagKind::Genre, "Funkot").unwrap()], ..Default::default()
        }), 2026).unwrap().changed, 1);
        assert!(service.snapshot(2026).tracks[&a].effective.iter().any(|tag| tag.key == "genre:funkot"));

        let mut rebuilt = store::HashIndex::new();
        for path in &sources { store::resolve_library_file(path, &mut rebuilt).unwrap(); }
        let mut restarted = Service::new(&dir);
        restarted.publish(rebuilt.iter().map(|(path, entry)| (path.clone(), Some(entry.clone()))).collect());
        let restarted_snapshot = restarted.snapshot(2026);
        assert!(matches!(restarted_snapshot.tracks[&a].manual.year, tags::YearState::Unset));
        assert!(restarted_snapshot.tracks[&a].effective.iter().any(|tag| tag.key == "custom:配信候補"));
        assert!(restarted_snapshot.tracks[&renamed].effective.iter().any(|tag| tag.key == "custom:配信候補"));

        for (path, bytes, modified) in before {
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
        }
        for name in ["labels.json", "history.json", "manual-bars.json"] {
            assert_eq!(fs::read(dir.join(name)).unwrap(), b"existing baseline user data");
        }
        eprintln!(
            "track-tags #22 metrics: tracks=4 legacy_metadata_upgrade={legacy_upgrade_elapsed:?} warm_resolve={warm_elapsed:?} single_update={single_elapsed:?} batch_update={batch_elapsed:?}; probe/hash/decode and physical write counts are not instrumented"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
