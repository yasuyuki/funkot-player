//! Manual track tags kept separately from disposable analysis metadata.
//!
//! The store is deliberately the only read-modify-write owner of
//! `track-tags.json`.  It never touches audio files or the analysis cache.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
#[cfg(test)]
use std::cell::Cell;

use unicode_normalization::UnicodeNormalization;

const FILE_NAME: &str = "track-tags.json";
const LOCK_NAME: &str = "track-tags.lock";
const SCHEMA_VERSION: u32 = 1;
const MAX_TAGS: usize = 128;
const MAX_SCALARS: usize = 128;
#[cfg(test)]
thread_local! { static FAIL_NEXT_PERSIST: Cell<u8> = const { Cell::new(0) }; }

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TagKind { Genre, Custom }

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct TagKey { pub kind: TagKind, pub value: String }

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Tag { pub kind: TagKind, pub value: String }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TagError { Empty, ControlCharacter, TooLong }

impl Tag {
    pub fn new(kind: TagKind, value: impl AsRef<str>) -> Result<Self, TagError> {
        let value: String = value.as_ref().trim().nfc().collect();
        if value.is_empty() { return Err(TagError::Empty); }
        if value.chars().any(char::is_control) { return Err(TagError::ControlCharacter); }
        if value.chars().count() > MAX_SCALARS { return Err(TagError::TooLong); }
        Ok(Self { kind, value })
    }

    pub fn key(&self) -> TagKey {
        TagKey { kind: self.kind, value: ascii_fold(&self.value) }
    }

}

fn ascii_fold(value: &str) -> String {
    value.chars().map(|c| if c.is_ascii_uppercase() { c.to_ascii_lowercase() } else { c }).collect()
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum YearState { Auto, Set { value: u16 }, Unset }

impl Default for YearState { fn default() -> Self { Self::Auto } }

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct ManualRecord {
    #[serde(default)] year: YearState,
    #[serde(default)] manual_additions: Vec<Tag>,
    #[serde(default)] suppressed_auto_tags: Vec<Tag>,
}

impl Default for ManualRecord { fn default() -> Self { Self { year: YearState::Auto, manual_additions: vec![], suppressed_auto_tags: vec![] } } }

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct Document {
    schema_version: u32,
    #[serde(default)] generation: u64,
    #[serde(default)] tracks: BTreeMap<String, ManualRecord>,
}

impl Default for Document { fn default() -> Self { Self { schema_version: SCHEMA_VERSION, generation: 0, tracks: BTreeMap::new() } } }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadState { Missing, Ready, Corrupt, UnsupportedSchema, IoError }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError { ReadOnly(LoadState), Conflict, Busy, InvalidPatch, Io(String) }

#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct TrackTagPatch {
    /// `None` is intentionally different from `Some(YearState::Auto)`.
    pub year_change: Option<YearState>,
    pub add: Vec<Tag>,
    pub remove: Vec<Tag>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Snapshot { pub revision: String, pub tracks: BTreeMap<String, TrackManualState> }

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TrackManualState { pub year: YearState, pub manual_additions: Vec<Tag>, pub suppressed_auto_tags: Vec<Tag> }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyResult { pub changed: usize, pub no_op: usize, pub revision: String }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagOrigin { Embedded, Manual, Both }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveTag { pub tag: Tag, pub origin: TagOrigin }

/// Resolves the effective tag set without I/O. Embedded values come from the
/// metadata index; manual values never need to be copied into that index.
pub fn effective_tags(auto: &[Tag], manual: &TrackManualState) -> Vec<EffectiveTag> {
    let suppressed: BTreeSet<_> = manual.suppressed_auto_tags.iter().map(Tag::key).collect();
    let mut tags: BTreeMap<TagKey, EffectiveTag> = BTreeMap::new();
    for tag in auto {
        if !suppressed.contains(&tag.key()) {
            tags.insert(tag.key(), EffectiveTag { tag: tag.clone(), origin: TagOrigin::Embedded });
        }
    }
    for tag in &manual.manual_additions {
        tags.entry(tag.key()).and_modify(|existing| { existing.origin = TagOrigin::Both; existing.tag = tag.clone(); })
            .or_insert_with(|| EffectiveTag { tag: tag.clone(), origin: TagOrigin::Manual });
    }
    tags.into_values().collect()
}

pub struct TrackTagsStore { dir: PathBuf, state: Mutex<StoreState> }

enum StoreState { Ready { document: Document, load_state: LoadState }, ReadOnly(LoadState) }

impl TrackTagsStore {
    pub fn load(dir: impl Into<PathBuf>) -> Self {
        let dir = dir.into();
        let state = match read_document(&dir) {
            Ok((state, Some(doc))) => { debug_assert_eq!(state, LoadState::Ready); StoreState::Ready { document: doc, load_state: state } }
            Ok((state, None)) => StoreState::Ready { document: Document::default(), load_state: state },
            Err(state) => StoreState::ReadOnly(state),
        };
        Self { dir, state: Mutex::new(state) }
    }

    pub fn load_state(&self) -> LoadState {
        match &*self.state.lock().expect("track tag state mutex poisoned") {
            StoreState::Ready { load_state, .. } => load_state.clone(),
            StoreState::ReadOnly(state) => state.clone(),
        }
    }

    pub fn snapshot(&self) -> Result<Snapshot, StoreError> {
        let state = self.state.lock().expect("track tag state mutex poisoned");
        let StoreState::Ready { document: doc, .. } = &*state else { return Err(read_only_error(&state)); };
        Ok(snapshot_of(doc))
    }

    /// Explicitly re-read after a conflict. Normal listing stays memory-only;
    /// callers choose this refresh rather than silently replaying stale input.
    pub fn reload(&self) -> Result<Snapshot, StoreError> {
        let mut state = self.state.lock().expect("track tag state mutex poisoned");
        match read_document(&self.dir) {
            Ok((load_state, Some(document))) => {
                let snapshot = snapshot_of(&document);
                *state = StoreState::Ready { document, load_state };
                Ok(snapshot)
            }
            Ok((load_state, None)) => {
                let document = Document::default();
                let snapshot = snapshot_of(&document);
                *state = StoreState::Ready { document, load_state };
                Ok(snapshot)
            }
            Err(problem) => { *state = StoreState::ReadOnly(problem.clone()); Err(StoreError::ReadOnly(problem)) }
        }
    }

    /// Locks in this order: the process-local state mutex, then the portable
    /// create-new lockfile. It never takes playback, queue, or cache locks.
    /// The lockfile avoids `File::lock`, which Android filesystems may reject.
    /// Apply with no embedded metadata. Callers that have metadata should use
    /// [`apply_patch_with_auto`] so the effective-tag limit includes it.
    pub fn apply_patch(&self, hashes: &[String], expected_revision: &str, patch: &TrackTagPatch) -> Result<ApplyResult, StoreError> {
        self.apply_patch_with_auto(hashes, expected_revision, patch, &BTreeMap::new())
    }

    /// Validates the result against a caller-owned point-in-time embedded-tag
    /// map. Automatic values are never retained or persisted by this module.
    pub fn apply_patch_with_auto(&self, hashes: &[String], expected_revision: &str, patch: &TrackTagPatch, auto_by_hash: &BTreeMap<String, Vec<Tag>>) -> Result<ApplyResult, StoreError> {
        validate_patch(patch)?;
        if hashes.iter().any(String::is_empty) { return Err(StoreError::InvalidPatch); }
        let hashes: BTreeSet<_> = hashes.iter().cloned().collect();
        let mut state = self.state.lock().expect("track tag state mutex poisoned");
        if !matches!(*state, StoreState::Ready { .. }) { return Err(read_only_error(&state)); }
        let _file_lock = FileLock::acquire(&self.dir).map_err(map_io)?;
        let disk = match read_document(&self.dir) {
            Ok((_, Some(doc))) => doc,
            Ok((_, None)) => Document::default(),
            Err(problem) => { *state = StoreState::ReadOnly(problem.clone()); return Err(StoreError::ReadOnly(problem)); }
        };
        if revision_of(&disk) != expected_revision { *state = StoreState::Ready { document: disk, load_state: LoadState::Ready }; return Err(StoreError::Conflict); }
        let mut updated = disk.clone();
        let mut changed = 0;
        for hash in &hashes {
            let before = updated.tracks.get(hash).cloned().unwrap_or_default();
            let after = apply_one(before.clone(), patch)?;
            let manual = TrackManualState { year: after.year.clone(), manual_additions: after.manual_additions.clone(), suppressed_auto_tags: after.suppressed_auto_tags.clone() };
            if effective_tags(auto_by_hash.get(hash).map(Vec::as_slice).unwrap_or(&[]), &manual).len() > MAX_TAGS { return Err(StoreError::InvalidPatch); }
            if before != after { updated.tracks.insert(hash.clone(), after); changed += 1; }
        }
        if changed == 0 { *state = StoreState::Ready { document: disk.clone(), load_state: LoadState::Ready }; return Ok(ApplyResult { changed: 0, no_op: hashes.len(), revision: revision_of(&disk) }); }
        updated.generation = disk.generation.checked_add(1).ok_or(StoreError::Io("revision exhausted".into()))?;
        persist_document(&self.dir, &updated).map_err(map_io)?;
        let revision = revision_of(&updated);
        *state = StoreState::Ready { document: updated, load_state: LoadState::Ready };
        Ok(ApplyResult { changed, no_op: hashes.len() - changed, revision })
    }

    /// Returns a clone of one manual record. Absence is `year:auto` and no
    /// tag changes; callers never receive a mutable view of store state.
    pub fn record(&self, hash: &str) -> Result<TrackManualState, StoreError> {
        let state = self.state.lock().expect("track tag state mutex poisoned");
        let StoreState::Ready { document: doc, .. } = &*state else { return Err(read_only_error(&state)); };
        let record = doc.tracks.get(hash).cloned().unwrap_or_default();
        Ok(TrackManualState { year: record.year, manual_additions: record.manual_additions, suppressed_auto_tags: record.suppressed_auto_tags })
    }
}

fn snapshot_of(doc: &Document) -> Snapshot {
    Snapshot { revision: revision_of(doc), tracks: doc.tracks.iter().map(|(hash, r)| (hash.clone(), TrackManualState { year: r.year.clone(), manual_additions: r.manual_additions.clone(), suppressed_auto_tags: r.suppressed_auto_tags.clone() })).collect() }
}
fn revision_of(doc: &Document) -> String { format!("track-tags-v1:{}", doc.generation) }
fn read_only_error(state: &StoreState) -> StoreError { match state { StoreState::ReadOnly(s) => StoreError::ReadOnly(s.clone()), StoreState::Ready { .. } => unreachable!() } }
fn map_io(e: io::Error) -> StoreError { if e.kind() == io::ErrorKind::WouldBlock { StoreError::Busy } else { StoreError::Io(e.to_string()) } }

fn validate_patch(patch: &TrackTagPatch) -> Result<(), StoreError> {
    if let Some(YearState::Set { value }) = patch.year_change { if !(1000..=9999).contains(&value) { return Err(StoreError::InvalidPatch); } }
    let adds: BTreeSet<_> = patch.add.iter().map(Tag::key).collect();
    let removes: BTreeSet<_> = patch.remove.iter().map(Tag::key).collect();
    if adds.intersection(&removes).next().is_some() { return Err(StoreError::InvalidPatch); }
    if patch.add.iter().any(|t| Tag::new(t.kind, &t.value).as_ref().ok() != Some(t)) || patch.remove.iter().any(|t| Tag::new(t.kind, &t.value).as_ref().ok() != Some(t)) { return Err(StoreError::InvalidPatch); }
    Ok(())
}

fn apply_one(mut record: ManualRecord, patch: &TrackTagPatch) -> Result<ManualRecord, StoreError> {
    if let Some(year) = &patch.year_change { record.year = year.clone(); }
    for tag in &patch.remove {
        let key = tag.key();
        record.manual_additions.retain(|t| t.key() != key);
        if !record.suppressed_auto_tags.iter().any(|t| t.key() == key) { record.suppressed_auto_tags.push(tag.clone()); }
    }
    for tag in &patch.add {
        let key = tag.key();
        record.suppressed_auto_tags.retain(|t| t.key() != key);
        if let Some(existing) = record.manual_additions.iter_mut().find(|t| t.key() == key) { *existing = tag.clone(); }
        else { record.manual_additions.push(tag.clone()); }
    }
    canonicalize(&mut record);
    if record.manual_additions.len() > MAX_TAGS { return Err(StoreError::InvalidPatch); }
    Ok(record)
}

fn canonicalize(record: &mut ManualRecord) {
    let mut additions = BTreeMap::new();
    for tag in record.manual_additions.drain(..) { additions.insert(tag.key(), tag); }
    let mut suppressed = BTreeMap::new();
    for tag in record.suppressed_auto_tags.drain(..) { suppressed.insert(tag.key(), tag); }
    record.manual_additions = additions.into_values().collect();
    record.suppressed_auto_tags = suppressed.into_values().collect();
}

fn read_document(dir: &Path) -> Result<(LoadState, Option<Document>), LoadState> {
    let bytes = match fs::read(dir.join(FILE_NAME)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok((LoadState::Missing, None)),
        Err(_) => return Err(LoadState::IoError),
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| LoadState::Corrupt)?;
    match value.get("schema_version").and_then(serde_json::Value::as_u64) {
        Some(v) if v == u64::from(SCHEMA_VERSION) => {},
        Some(_) => return Err(LoadState::UnsupportedSchema),
        None => return Err(LoadState::Corrupt),
    }
    let mut doc: Document = serde_json::from_value(value).map_err(|_| LoadState::Corrupt)?;
    for record in doc.tracks.values_mut() {
        for tag in record.manual_additions.iter().chain(record.suppressed_auto_tags.iter()) {
            if Tag::new(tag.kind, &tag.value).as_ref().ok() != Some(tag) { return Err(LoadState::Corrupt); }
        }
        canonicalize(record);
        if record.manual_additions.len() > MAX_TAGS { return Err(LoadState::Corrupt); }
        if let YearState::Set { value } = record.year {
            if !(1000..=9999).contains(&value) { return Err(LoadState::Corrupt); }
        }
    }
    Ok((LoadState::Ready, Some(doc)))
}

fn persist_document(dir: &Path, doc: &Document) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let bytes = serde_json::to_vec_pretty(doc).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    #[cfg(test)] fail_persist_stage(1)?;
    tmp.write_all(&bytes)?;
    #[cfg(test)] fail_persist_stage(2)?;
    tmp.as_file().sync_all()?;
    #[cfg(test)] fail_persist_stage(3)?;
    tmp.persist(dir.join(FILE_NAME)).map_err(|error| error.error)?;
    Ok(())
}

#[cfg(test)]
fn fail_persist_stage(stage: u8) -> io::Result<()> {
    if FAIL_NEXT_PERSIST.with(|fail| { if fail.get() == stage { fail.set(0); true } else { false } }) {
        return Err(io::Error::other("injected persistence failure"));
    }
    Ok(())
}

struct FileLock { path: PathBuf }
impl FileLock {
    fn acquire(dir: &Path) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let path = dir.join(LOCK_NAME);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => Ok(Self { path }),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                Err(io::Error::new(io::ErrorKind::WouldBlock, "track tag store is busy"))
            }
            Err(e) => Err(e),
        }
    }
}
impl Drop for FileLock { fn drop(&mut self) { let _ = fs::remove_file(&self.path); } }

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    struct TempDir(PathBuf);
    impl TempDir { fn new(name: &str) -> Self { let p = std::env::temp_dir().join(format!("funkot-tags-{name}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())); fs::create_dir_all(&p).unwrap(); Self(p) } }
    impl Drop for TempDir { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn genre(v: &str) -> Tag { Tag::new(TagKind::Genre, v).unwrap() }
    fn custom(v: &str) -> Tag { Tag::new(TagKind::Custom, v).unwrap() }
    fn patch_add(v: &str) -> TrackTagPatch { TrackTagPatch { add: vec![genre(v)], ..Default::default() } }

    #[test] fn normalization_and_validation() {
        assert_eq!(genre(" Funkot ").key(), genre("funkot").key());
        assert_eq!(genre("e\u{301}").value, genre("é").value);
        assert_ne!(genre("Funkot").key(), custom("Funkot").key());
        assert!(matches!(Tag::new(TagKind::Genre, " \t "), Err(TagError::Empty)));
        assert!(matches!(Tag::new(TagKind::Genre, "x\ny"), Err(TagError::ControlCharacter)));
        assert!(Tag::new(TagKind::Genre, "a".repeat(128)).is_ok());
        assert!(matches!(Tag::new(TagKind::Genre, "a".repeat(129)), Err(TagError::TooLong)));
        assert_eq!(genre("R&B/Soul").value, "R&B/Soul");
    }

    #[test] fn effective_auto_remove_and_readd() {
        let manual = TrackManualState { year: YearState::Auto, manual_additions: vec![], suppressed_auto_tags: vec![genre("pop")] };
        assert!(effective_tags(&[genre("Pop")], &manual).is_empty());
        let manual = TrackManualState { manual_additions: vec![genre("Pop")], suppressed_auto_tags: vec![], ..manual };
        assert_eq!(effective_tags(&[genre("Pop")], &manual)[0].origin, TagOrigin::Both);
    }

    #[test] fn year_and_batch_patch_are_atomic() {
        let d = TempDir::new("batch"); let s = TrackTagsStore::load(&d.0); let rev = s.snapshot().unwrap().revision;
        let r = s.apply_patch(&["a".into(), "a".into(), "b".into()], &rev, &TrackTagPatch { year_change: Some(YearState::Set { value: 2024 }), ..Default::default() }).unwrap();
        assert_eq!((r.changed, r.no_op), (2, 0));
        let before = s.snapshot().unwrap();
        assert!(matches!(s.apply_patch(&["a".into(), "b".into()], &before.revision, &TrackTagPatch { add: vec![genre("x")], remove: vec![genre("X")], ..Default::default() }), Err(StoreError::InvalidPatch)));
        assert_eq!(s.snapshot().unwrap(), before);
        let r = s.apply_patch(&["a".into(), "b".into()], &before.revision, &TrackTagPatch::default()).unwrap();
        assert_eq!((r.changed, r.no_op), (0, 2)); assert_eq!(r.revision, before.revision);
    }

    #[test] fn round_trip_corrupt_and_schema_are_fail_closed() {
        let d = TempDir::new("load"); let s = TrackTagsStore::load(&d.0); let rev = s.snapshot().unwrap().revision;
        s.apply_patch(&["hash".into()], &rev, &patch_add("Funkot")).unwrap();
        assert_eq!(TrackTagsStore::load(&d.0).snapshot().unwrap().tracks["hash"].manual_additions, vec![genre("Funkot")]);
        let path = d.0.join(FILE_NAME); fs::write(&path, b"not json").unwrap(); let bytes = fs::read(&path).unwrap();
        let corrupt = TrackTagsStore::load(&d.0); assert_eq!(corrupt.load_state(), LoadState::Corrupt); assert!(matches!(corrupt.snapshot(), Err(StoreError::ReadOnly(LoadState::Corrupt)))); assert_eq!(fs::read(&path).unwrap(), bytes);
        fs::write(&path, br#"{"schema_version":99,"tracks":{}}"#).unwrap(); let bytes = fs::read(&path).unwrap(); let unknown = TrackTagsStore::load(&d.0); assert_eq!(unknown.load_state(), LoadState::UnsupportedSchema); assert_eq!(fs::read(&path).unwrap(), bytes);
        fs::write(&path, br#"{"schema_version":1,"tracks":{"x":{"year":{"mode":"set","value":0}}}}"#).unwrap(); let bytes = fs::read(&path).unwrap(); let invalid_year = TrackTagsStore::load(&d.0); assert_eq!(invalid_year.load_state(), LoadState::Corrupt); assert_eq!(fs::read(&path).unwrap(), bytes);
    }

    #[test] fn stale_revision_and_concurrent_stores_do_not_lose_updates() {
        let d = TempDir::new("concurrent"); let one = Arc::new(TrackTagsStore::load(&d.0)); let two = Arc::new(TrackTagsStore::load(&d.0)); let rev = one.snapshot().unwrap().revision;
        one.apply_patch(&["one".into()], &rev, &patch_add("one")).unwrap();
        assert!(matches!(two.apply_patch(&["two".into()], &rev, &patch_add("two")), Err(StoreError::Conflict)));
        let rev = two.reload().unwrap().revision; two.apply_patch(&["two".into()], &rev, &patch_add("two")).unwrap();
        let result = TrackTagsStore::load(&d.0).snapshot().unwrap(); assert!(result.tracks.contains_key("one") && result.tracks.contains_key("two"));
    }

    #[test] fn apply_patch_persistence_failure_keeps_disk_snapshot_and_revision() {
        let d = TempDir::new("transaction-failure"); let s = TrackTagsStore::load(&d.0); let revision = s.snapshot().unwrap().revision;
        s.apply_patch(&["x".into()], &revision, &patch_add("old")).unwrap();
        let before = s.snapshot().unwrap(); let bytes = fs::read(d.0.join(FILE_NAME)).unwrap();
        for stage in 1..=3 {
            FAIL_NEXT_PERSIST.with(|fail| fail.set(stage));
            assert!(matches!(s.apply_patch(&["x".into()], &before.revision, &patch_add("new")), Err(StoreError::Io(_))));
            assert_eq!(s.snapshot().unwrap(), before);
            assert_eq!(fs::read(d.0.join(FILE_NAME)).unwrap(), bytes);
            assert_eq!(fs::read_dir(&d.0).unwrap().count(), 1, "temporary and lock files cleaned up");
        }
    }

    #[test] fn limit_counts_effective_manual_state_and_set_is_not_auto() {
        let d = TempDir::new("limit"); let s = TrackTagsStore::load(&d.0); let rev = s.snapshot().unwrap().revision;
        let add = (0..129).map(|i| genre(&format!("g{i}"))).collect(); assert!(matches!(s.apply_patch(&["x".into()], &rev, &TrackTagPatch { add, ..Default::default() }), Err(StoreError::InvalidPatch)));
        let r = s.apply_patch(&["x".into()], &rev, &TrackTagPatch { year_change: Some(YearState::Set { value: 2024 }), ..Default::default() }).unwrap();
        assert!(matches!(s.snapshot().unwrap().tracks["x"].year, YearState::Set { value: 2024 }));
        assert!(s.apply_patch(&["x".into()], &r.revision, &TrackTagPatch::default()).is_ok());
    }

    #[test] fn auto_tags_count_toward_the_effective_limit() {
        let d = TempDir::new("effective-limit"); let s = TrackTagsStore::load(&d.0); let revision = s.snapshot().unwrap().revision;
        let auto = (0..128).map(|i| genre(&format!("auto{i}"))).collect();
        let mut by_hash = BTreeMap::new(); by_hash.insert("x".to_owned(), auto);
        assert!(matches!(s.apply_patch_with_auto(&["x".into()], &revision, &patch_add("manual"), &by_hash), Err(StoreError::InvalidPatch)));
        assert!(s.snapshot().unwrap().tracks.is_empty());
    }
}

#[cfg(test)]
mod acceptance_tests {
    use super::*;
    #[test]
    fn concurrent_edit_conflicts_instead_of_losing_the_first_write() {
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(TrackTagsStore::load(dir.path()));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let revision = store.snapshot().unwrap().revision;
        let workers: Vec<_> = ["one", "two"].into_iter().map(|name| {
            let store = store.clone(); let barrier = barrier.clone(); let revision = revision.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let patch = TrackTagPatch { add: vec![Tag::new(TagKind::Custom, name).unwrap()], ..Default::default() };
                (name, store.apply_patch(&["h".into()], &revision, &patch))
            })
        }).collect();
        let results: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|(_, r)| r.is_ok()).count(), 1);
        let (name, _) = results.into_iter().find(|(_, r)| matches!(r, Err(StoreError::Conflict))).unwrap();
        let current = store.snapshot().unwrap();
        store.apply_patch(&["h".into()], &current.revision, &TrackTagPatch { add: vec![Tag::new(TagKind::Custom, name).unwrap()], ..Default::default() }).unwrap();
        assert_eq!(store.record("h").unwrap().manual_additions.len(), 2);
    }
    #[test]
    fn unknown_schema_is_distinguished_before_decoding_its_future_shape() {
        let dir = tempfile::tempdir().unwrap(); let file = dir.path().join(FILE_NAME);
        let bytes = br#"{"schema_version":99,"tracks":["future layout"]}"#;
        fs::write(&file, bytes).unwrap();
        let store = TrackTagsStore::load(dir.path());
        assert_eq!(store.load_state(), LoadState::UnsupportedSchema);
        assert!(matches!(store.apply_patch(&["h".into()], "r", &TrackTagPatch::default()), Err(StoreError::ReadOnly(LoadState::UnsupportedSchema))));
        assert_eq!(fs::read(&file).unwrap(), bytes);
    }
    #[test]
    fn read_io_error_stays_read_only() {
        let dir = tempfile::tempdir().unwrap(); fs::create_dir(dir.path().join(FILE_NAME)).unwrap();
        let store = TrackTagsStore::load(dir.path());
        assert_eq!(store.load_state(), LoadState::IoError);
        assert!(store.apply_patch(&["h".into()], "r", &TrackTagPatch::default()).is_err());
        assert!(dir.path().join(FILE_NAME).is_dir());
    }
}
