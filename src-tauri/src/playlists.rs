//! Durable playlist definitions and their non-destructive playback progress.
//!
//! This module deliberately has no engine or IPC dependency.  Its callers
//! prepare a cloned [`Catalog`], persist it, then publish that clone only after
//! `persist` succeeds.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use unicode_normalization::UnicodeNormalization;

use crate::queue::{QueueItem, QueueOrigin};
use crate::playlist_progress::{self as progress, Claim as ProgressClaim, Observation, Occurrence, Progress};

const FILE_NAME: &str = "playlists.json";
const LOCK_NAME: &str = "playlists.lock";
pub const SCHEMA_VERSION: u32 = 1;
#[cfg(test)]
thread_local! { static FAIL_PERSIST_STAGE: std::cell::Cell<u8> = const { std::cell::Cell::new(0) }; }

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TrackRef {
    pub content_hash: String,
    pub preferred_path: PathBuf,
    pub title: String,
    pub artist: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Entry { pub entry_id: String, pub track: TrackRef }

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PlaylistDefinition {
    pub id: String,
    pub name: String,
    pub revision: u64,
    pub entries: Vec<Entry>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, Default)]
pub struct Run {
    pub run_id: u64,
    #[serde(default)] pub consumed: BTreeSet<String>,
    #[serde(default)] pub failures: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackOrigin { Normal, Playlist }

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CurrentOccurrence {
    pub playlist_id: Option<String>,
    pub run_id: u64,
    pub entry_id: Option<String>,
    pub track_ref: TrackRef,
    pub origin: PlaybackOrigin,
    /// Retains manual/automatic priority when a suspended normal current is
    /// requeued after restart. Playlist currents always leave this `None`.
    #[serde(default)] pub queue_origin: Option<QueueOrigin>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NormalResume {
    pub items: Vec<QueueItem>,
    /// None until the legacy folder cursor can be resolved at first Start.
    pub folder_pos: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Catalog {
    pub schema_version: u32,
    pub revision: u64,
    pub generation: u64,
    pub next_id: u64,
    pub active_id: Option<String>,
    #[serde(default)] pub definitions: Vec<PlaylistDefinition>,
    #[serde(default)] pub runs: BTreeMap<String, Run>,
    #[serde(default)] pub current: Option<CurrentOccurrence>,
    #[serde(default)] pub normal: Option<NormalResume>,
}

impl Default for Catalog {
    fn default() -> Self {
        Self { schema_version: SCHEMA_VERSION, revision: 0, generation: 0, next_id: 1,
            active_id: None, definitions: vec![], runs: BTreeMap::new(), current: None, normal: None }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case", tag = "code")]
pub enum PlaylistError {
    InvalidInput { message: String }, NotFound, Stale, ActiveList, DuplicateUndo,
    StoreReadOnly { state: LoadState }, PersistFailed { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoadState { Missing, Ready, Corrupt, UnsupportedSchema, IoError, Busy }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemovedEntry {
    pub entry: Entry,
    pub previous_id: Option<String>,
    pub following_id: Option<String>,
    pub consumed: bool,
    pub failure: Option<String>,
    pub run_id: u64,
}

impl Catalog {
    /// Selects the source for future claims without starting playback or
    /// changing that playlist's run.
    pub fn select(&mut self, id: Option<String>) -> Result<(), PlaylistError> {
        if let Some(id) = id.as_deref() { self.definition(id)?; }
        if self.active_id != id { self.active_id = id; self.source_changed(); }
        Ok(())
    }
    pub fn check_run(&self, id: &str, expected: u64) -> Result<(), PlaylistError> {
        if self.run(id)?.run_id == expected { Ok(()) } else { Err(PlaylistError::Stale) }
    }
    pub fn definition(&self, id: &str) -> Result<&PlaylistDefinition, PlaylistError> {
        self.definitions.iter().find(|p| p.id == id).ok_or(PlaylistError::NotFound)
    }
    pub fn run(&self, id: &str) -> Result<&Run, PlaylistError> { self.runs.get(id).ok_or(PlaylistError::NotFound) }
    pub fn remaining(&self, id: &str) -> Result<Vec<Entry>, PlaylistError> {
        let run = self.run(id)?;
        Ok(self.definition(id)?.entries.iter().filter(|e| !run.consumed.contains(&e.entry_id)).cloned().collect())
    }
    pub fn create(&mut self, name: impl AsRef<str>, tracks: Vec<TrackRef>) -> Result<String, PlaylistError> {
        let name = self.valid_name(name.as_ref(), None)?;
        let id = self.allocate("playlist")?;
        let entries = tracks.into_iter().map(|track| Ok(Entry { entry_id: self.allocate("entry")?, track })).collect::<Result<_, _>>()?;
        self.definitions.push(PlaylistDefinition { id: id.clone(), name, revision: 0, entries });
        self.runs.insert(id.clone(), Run::default()); self.changed(); Ok(id)
    }
    pub fn duplicate(&mut self, id: &str) -> Result<String, PlaylistError> {
        let source = self.definition(id)?.clone();
        let base = format!("{} copy", source.name);
        let name = self.unique_copy_name(&base);
        let new_id = self.allocate("playlist")?;
        let entries = source.entries.into_iter().map(|e| Ok(Entry { entry_id: self.allocate("entry")?, track: e.track })).collect::<Result<_, _>>()?;
        self.definitions.push(PlaylistDefinition { id: new_id.clone(), name, revision: 0, entries });
        self.runs.insert(new_id.clone(), Run::default()); self.changed(); Ok(new_id)
    }
    pub fn rename(&mut self, id: &str, name: impl AsRef<str>) -> Result<(), PlaylistError> {
        let name = self.valid_name(name.as_ref(), Some(id))?;
        self.definition_mut(id)?.name = name; self.definition_changed(id)?; self.changed(); Ok(())
    }
    pub fn delete(&mut self, id: &str) -> Result<(), PlaylistError> {
        if self.active_id.as_deref() == Some(id) { return Err(PlaylistError::ActiveList); }
        let at = self.definitions.iter().position(|p| p.id == id).ok_or(PlaylistError::NotFound)?;
        self.definitions.remove(at); self.runs.remove(id);
        if self.current.as_ref().and_then(|c| c.playlist_id.as_deref()) == Some(id) { self.current = None; }
        self.changed(); Ok(())
    }
    pub fn append(&mut self, id: &str, tracks: Vec<TrackRef>) -> Result<Vec<String>, PlaylistError> {
        self.definition(id)?; let mut entries = Vec::with_capacity(tracks.len());
        for track in tracks { entries.push(Entry { entry_id: self.allocate("entry")?, track }); }
        let ids = entries.iter().map(|e| e.entry_id.clone()).collect();
        self.definition_mut(id)?.entries.extend(entries); self.definition_changed(id)?; self.changed(); Ok(ids)
    }
    pub fn remove(&mut self, id: &str, entry_id: &str) -> Result<RemovedEntry, PlaylistError> {
        let run = self.run(id)?.clone(); let definition = self.definition_mut(id)?;
        let at = definition.entries.iter().position(|e| e.entry_id == entry_id).ok_or(PlaylistError::NotFound)?;
        let previous_id = at.checked_sub(1).map(|n| definition.entries[n].entry_id.clone());
        let following_id = definition.entries.get(at + 1).map(|e| e.entry_id.clone());
        let entry = definition.entries.remove(at);
        let removed = RemovedEntry { consumed: run.consumed.contains(entry_id), failure: run.failures.get(entry_id).cloned(), run_id: run.run_id, entry, previous_id, following_id };
        if self.current.as_ref().is_some_and(|current| current.playlist_id.as_deref() == Some(id) && current.entry_id.as_deref() == Some(entry_id)) { self.current = None; }
        self.definition_changed(id)?; self.changed(); Ok(removed)
    }
    /// Restores only this occurrence.  Neighbours still present determine its
    /// insertion point, so later edits are never replaced wholesale.
    pub fn undo_remove(&mut self, id: &str, removed: RemovedEntry) -> Result<(), PlaylistError> {
        let definition = self.definition_mut(id)?;
        if definition.entries.iter().any(|e| e.entry_id == removed.entry.entry_id) { return Err(PlaylistError::DuplicateUndo); }
        let at = removed.following_id.as_ref().and_then(|next| definition.entries.iter().position(|e| &e.entry_id == next))
            .or_else(|| removed.previous_id.as_ref().and_then(|prev| definition.entries.iter().position(|e| &e.entry_id == prev).map(|n| n + 1)))
            .unwrap_or(definition.entries.len());
        definition.entries.insert(at, removed.entry.clone());
        let run = self.run_mut(id)?;
        if run.run_id == removed.run_id {
            if removed.consumed { run.consumed.insert(removed.entry.entry_id.clone()); }
            if let Some(reason) = removed.failure { run.failures.insert(removed.entry.entry_id.clone(), reason); }
        }
        self.definition_changed(id)?; self.changed(); Ok(())
    }
    pub fn reorder_remaining(&mut self, id: &str, ordered: &[String]) -> Result<(), PlaylistError> {
        let run = self.run(id)?.clone(); let definition = self.definition_mut(id)?;
        let remaining: BTreeSet<_> = definition.entries.iter().filter(|e| !run.consumed.contains(&e.entry_id)).map(|e| e.entry_id.as_str()).collect();
        if ordered.len() != remaining.len() || ordered.iter().any(|e| !remaining.contains(e.as_str())) || ordered.iter().collect::<BTreeSet<_>>().len() != ordered.len() { return Err(PlaylistError::InvalidInput { message: "ordered entries must be exactly the remaining occurrences".into() }); }
        let by_id: BTreeMap<_, _> = definition.entries.iter().filter(|e| !run.consumed.contains(&e.entry_id)).map(|e| (e.entry_id.clone(), e.clone())).collect();
        let mut replacement = ordered.iter().map(|id| by_id[id].clone());
        for entry in &mut definition.entries { if !run.consumed.contains(&entry.entry_id) { *entry = replacement.next().expect("validated order"); } }
        self.definition_changed(id)?; self.changed(); Ok(())
    }
    pub fn move_entry(&mut self, id: &str, entry_id: &str, to: usize) -> Result<(), PlaylistError> {
        let definition = self.definition_mut(id)?; let at = definition.entries.iter().position(|e| e.entry_id == entry_id).ok_or(PlaylistError::NotFound)?;
        if to >= definition.entries.len() { return Err(PlaylistError::InvalidInput { message: "destination is outside playlist".into() }); }
        let entry = definition.entries.remove(at); definition.entries.insert(to, entry);
        self.definition_changed(id)?; self.changed(); Ok(())
    }
    pub fn restart(&mut self, id: &str) -> Result<u64, PlaylistError> {
        let run = self.run_mut(id)?; run.run_id = run.run_id.checked_add(1).ok_or_else(|| PlaylistError::InvalidInput { message: "run id exhausted".into() })?;
        run.consumed.clear(); run.failures.clear(); let new_run_id = run.run_id;
        if self.current.as_ref().is_some_and(|current| current.playlist_id.as_deref() == Some(id)) { self.current = None; }
        self.source_changed(); Ok(new_run_id)
    }
    /// All live progress writes pass through the same occurrence transition.
    /// Resolve membership/run from the catalog rather than trusting the event.
    pub(crate) fn observe_progress(&mut self, claim: Option<ProgressClaim<&str>>,
        mut observation: Observation<&str>, reason: Option<&str>) -> bool {
        let identity = match observation {
            Observation::Unavailable { occurrence, .. } => occurrence,
            _ => match claim { Some(c) => c.occurrence, None => return false },
        };
        // The pure input flag is derived here from a real, retained reason.
        match &mut observation {
            Observation::Failed { reason_present, .. } | Observation::Unavailable { reason_present, .. } =>
                *reason_present = reason.is_some_and(|r| !r.trim().is_empty()),
            _ => {},
        }
        let target = self.definition(identity.playlist).ok().and_then(|d|
            d.entries.iter().find(|e| e.entry_id == identity.entry)).and_then(|entry|
            self.run(identity.playlist).ok().map(|run| Occurrence {
                playlist: identity.playlist, run: run.run_id, entry: entry.entry_id.as_str() }));
        let before = self.run(identity.playlist).map_or(Progress::default(), |run| Progress {
            consumed: run.consumed.contains(identity.entry), failed: run.failures.contains_key(identity.entry) });
        let update = progress::observe(target, before, claim, observation);
        if update.accepted.is_none() { return false; }
        if update.progress != before {
            let run = self.run_mut(identity.playlist).expect("accepted progress has a catalog run");
            if update.progress.consumed { run.consumed.insert(identity.entry.into()); }
            if update.progress.failed && !before.failed {
                run.failures.insert(identity.entry.into(), reason.expect("failure requires reason").into());
            }
            self.changed();
        }
        true
    }
    pub(crate) fn unavailable(&mut self, id: &str, run: u64, entry: &str, reason: &str) -> bool {
        self.observe_progress(None, Observation::Unavailable {
            occurrence: Occurrence { playlist: id, run, entry }, reason_present: false }, Some(reason))
    }
    /// On app restart, the playing occurrence has already been consumed.  Put
    /// it back only if its exact membership and run are still valid.
    pub fn resume_after_restart(&mut self) -> Option<CurrentOccurrence> {
        let current = self.current.clone()?;
        if current.origin == PlaybackOrigin::Normal { self.current = None; self.changed(); return Some(current); }
        let id = current.playlist_id.as_deref()?;
        if self.run(id).ok()?.run_id != current.run_id || !self.definition(id).ok()?.entries.iter().any(|e| Some(e.entry_id.as_str()) == current.entry_id.as_deref()) { self.current = None; self.changed(); return None; }
        self.run_mut(id).ok()?.consumed.remove(current.entry_id.as_deref()?); self.current = None; self.changed(); Some(current)
    }
    #[cfg(test)]
    fn mark_started(&mut self, id: &str, run: u64, entry: &str) -> Result<(), PlaylistError> {
        let claim = ProgressClaim { occurrence: Occurrence { playlist: id, run, entry }, index: 7, live: true, cancelled: false };
        self.observe_progress(Some(claim), Observation::Started(7), None).then_some(()).ok_or(PlaylistError::Stale)
    }
    #[cfg(test)]
    fn mark_failed(&mut self, id: &str, run: u64, entry: &str, reason: &str) -> Result<(), PlaylistError> {
        self.unavailable(id, run, entry, reason).then_some(()).ok_or(PlaylistError::Stale)
    }
    pub fn validate(&self) -> Result<(), PlaylistError> {
        if self.schema_version != SCHEMA_VERSION { return Err(PlaylistError::InvalidInput { message: "unsupported schema".into() }); }
        let mut playlist_ids = BTreeSet::new(); let mut entry_ids = BTreeSet::new(); let mut names = BTreeSet::new();
        for definition in &self.definitions {
            if !playlist_ids.insert(&definition.id) || !names.insert(normalized_name(&definition.name).ok_or_else(|| invalid("invalid playlist name"))?) { return Err(invalid("duplicate playlist id or name")); }
            if self.run(&definition.id).is_err() { return Err(invalid("playlist has no run")); }
            for entry in &definition.entries {
                if entry.track.content_hash.is_empty() { return Err(invalid("playlist track has no content hash")); }
                if !entry_ids.insert(&entry.entry_id) { return Err(invalid("duplicate entry id")); }
            }
        }
        if self.runs.keys().any(|id| !playlist_ids.contains(id)) || self.active_id.as_ref().is_some_and(|id| !playlist_ids.contains(id)) { return Err(invalid("orphan playlist state")); }
        if let Some(current) = &self.current {
            match current.origin {
                PlaybackOrigin::Normal if current.playlist_id.is_some() || current.entry_id.is_some() || current.queue_origin.is_none() => return Err(invalid("normal current lacks normal identity")),
                PlaybackOrigin::Playlist => {
                    let id = current.playlist_id.as_deref().ok_or_else(|| invalid("playlist current lacks playlist id"))?;
                    if current.queue_origin.is_some() || current.track_ref.content_hash.is_empty() || self.run(id)?.run_id != current.run_id || !self.definition(id)?.entries.iter().any(|entry| Some(entry.entry_id.as_str()) == current.entry_id.as_deref()) { return Err(invalid("invalid playlist current")); }
                }
                _ => {}
            }
        }
        Ok(())
    }
    fn definition_mut(&mut self, id: &str) -> Result<&mut PlaylistDefinition, PlaylistError> { self.definitions.iter_mut().find(|p| p.id == id).ok_or(PlaylistError::NotFound) }
    fn run_mut(&mut self, id: &str) -> Result<&mut Run, PlaylistError> { self.runs.get_mut(id).ok_or(PlaylistError::NotFound) }
    fn valid_name(&self, name: &str, except: Option<&str>) -> Result<String, PlaylistError> {
        let name: String = name.trim().nfc().collect(); let key = normalized_name(&name).ok_or_else(|| invalid("playlist name must not be blank or contain control characters"))?;
        if self.definitions.iter().any(|p| Some(p.id.as_str()) != except && normalized_name(&p.name).as_deref() == Some(&key)) { return Err(invalid("playlist name already exists")); } Ok(name)
    }
    fn unique_copy_name(&self, base: &str) -> String { let mut n = 1; loop { let candidate = if n == 1 { base.to_owned() } else { format!("{} {}", base, n) }; if self.valid_name(&candidate, None).is_ok() { return candidate; } n += 1; } }
    fn allocate(&mut self, kind: &str) -> Result<String, PlaylistError> { let n = self.next_id; self.next_id = self.next_id.checked_add(1).ok_or_else(|| invalid("id space exhausted"))?; Ok(format!("{}-{}", kind, n)) }
    fn definition_changed(&mut self, id: &str) -> Result<(), PlaylistError> { let d = self.definition_mut(id)?; d.revision = d.revision.checked_add(1).ok_or_else(|| invalid("definition revision exhausted"))?; Ok(()) }
    fn changed(&mut self) { self.revision = self.revision.checked_add(1).expect("catalog revision exhausted"); }
    fn source_changed(&mut self) {
        self.changed();
        self.generation = self.generation.checked_add(1).expect("source generation exhausted");
    }
}

fn invalid(message: impl Into<String>) -> PlaylistError { PlaylistError::InvalidInput { message: message.into() } }
fn normalized_name(name: &str) -> Option<String> { let name: String = name.trim().nfc().collect(); if name.is_empty() || name.chars().any(char::is_control) { None } else { Some(name.chars().flat_map(char::to_lowercase).collect()) } }

pub struct PlaylistStore { dir: PathBuf, state: Mutex<StoreState>, _lock: Option<File> }
enum StoreState { Ready { catalog: Catalog, bytes: Option<Vec<u8>>, load_state: LoadState }, ReadOnly(LoadState) }

impl PlaylistStore {
    pub fn load(dir: impl Into<PathBuf>) -> Self {
        let dir = dir.into();
        let (lock, state) = match acquire_lock(&dir) {
            Ok(lock) => match read_catalog(&dir) {
                Ok((load_state, catalog, bytes)) => (Some(lock), StoreState::Ready { catalog, bytes, load_state }),
                Err(state) => (Some(lock), StoreState::ReadOnly(state)),
            },
            Err(error) => (None, StoreState::ReadOnly(if error.kind() == io::ErrorKind::WouldBlock { LoadState::Busy } else { LoadState::IoError })),
        };
        Self { dir, state: Mutex::new(state), _lock: lock }
    }
    pub fn load_state(&self) -> LoadState { match &*self.state.lock().expect("playlist store mutex poisoned") { StoreState::Ready { load_state, .. } => load_state.clone(), StoreState::ReadOnly(state) => state.clone() } }
    pub fn snapshot(&self) -> Result<Catalog, PlaylistError> { match &*self.state.lock().expect("playlist store mutex poisoned") { StoreState::Ready { catalog, .. } => Ok(catalog.clone()), StoreState::ReadOnly(state) => Err(PlaylistError::StoreReadOnly { state: state.clone() }) } }
    pub fn reload(&self) -> Result<Catalog, PlaylistError> {
        let mut state = self.state.lock().expect("playlist store mutex poisoned");
        if self._lock.is_none() { return Err(read_only(&state)); }
        let (load_state, catalog, bytes) = read_catalog(&self.dir).map_err(|state| PlaylistError::StoreReadOnly { state })?;
        *state = StoreState::Ready { catalog: catalog.clone(), bytes, load_state }; Ok(catalog)
    }
    /// Writes the candidate only if the file's exact previous bytes still match
    /// this session's snapshot.  The in-memory snapshot changes after replace.
    pub fn persist(&self, candidate: &Catalog) -> Result<(), PlaylistError> {
        candidate.validate()?;
        let mut state = self.state.lock().expect("playlist store mutex poisoned");
        let StoreState::Ready { bytes, .. } = &*state else { return Err(read_only(&state)); };
        let observed = read_bytes(&self.dir).map_err(|_| PlaylistError::StoreReadOnly { state: LoadState::IoError })?;
        if &observed != bytes { return Err(PlaylistError::Stale); }
        persist_catalog(&self.dir, candidate).map_err(|e| PlaylistError::PersistFailed { message: e.to_string() })?;
        let encoded = serde_json::to_vec_pretty(candidate).map_err(|e| PlaylistError::PersistFailed { message: e.to_string() })?;
        *state = StoreState::Ready { catalog: candidate.clone(), bytes: Some(encoded), load_state: LoadState::Ready }; Ok(())
    }
}

fn read_bytes(dir: &Path) -> io::Result<Option<Vec<u8>>> { match fs::read(dir.join(FILE_NAME)) { Ok(bytes) => Ok(Some(bytes)), Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None), Err(e) => Err(e) } }
fn read_catalog(dir: &Path) -> Result<(LoadState, Catalog, Option<Vec<u8>>), LoadState> {
    let Some(bytes) = read_bytes(dir).map_err(|_| LoadState::IoError)? else { return Ok((LoadState::Missing, Catalog::default(), None)); };
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| LoadState::Corrupt)?;
    match value.get("schema_version").and_then(serde_json::Value::as_u64) { Some(v) if v == u64::from(SCHEMA_VERSION) => {}, Some(_) => return Err(LoadState::UnsupportedSchema), None => return Err(LoadState::Corrupt) }
    let catalog: Catalog = serde_json::from_value(value).map_err(|_| LoadState::Corrupt)?;
    catalog.validate().map_err(|_| LoadState::Corrupt)?; Ok((LoadState::Ready, catalog, Some(bytes)))
}
fn persist_catalog(dir: &Path, catalog: &Catalog) -> io::Result<()> {
    fs::create_dir_all(dir)?; let bytes = serde_json::to_vec_pretty(catalog).map_err(io::Error::other)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    #[cfg(test)] fail_persist_stage(1)?;
    tmp.write_all(&bytes)?;
    #[cfg(test)] fail_persist_stage(2)?;
    tmp.as_file().sync_all()?;
    #[cfg(test)] fail_persist_stage(3)?;
    tmp.persist(dir.join(FILE_NAME)).map_err(|e| e.error)?; Ok(())
}
#[cfg(test)]
fn fail_persist_stage(stage: u8) -> io::Result<()> {
    if FAIL_PERSIST_STAGE.with(|failure| { if failure.get() == stage { failure.set(0); true } else { false } }) { Err(io::Error::other("injected persist failure")) } else { Ok(()) }
}
fn acquire_lock(dir: &Path) -> io::Result<File> {
    fs::create_dir_all(dir)?; let file = OpenOptions::new().read(true).write(true).create(true).open(dir.join(LOCK_NAME))?;
    #[cfg(target_os = "android")]
    { let result = unsafe { libc::flock(std::os::fd::AsRawFd::as_raw_fd(&file), libc::LOCK_EX | libc::LOCK_NB) }; if result != 0 { return Err(io::Error::last_os_error()); } }
    #[cfg(not(target_os = "android"))]
    file.try_lock()?;
    Ok(file)
}
fn read_only(state: &StoreState) -> PlaylistError { match state { StoreState::ReadOnly(state) => PlaylistError::StoreReadOnly { state: state.clone() }, StoreState::Ready { .. } => unreachable!() } }

#[cfg(test)]
mod tests {
    use super::*;
    fn track(name: &str) -> TrackRef { TrackRef { content_hash: name.into(), preferred_path: PathBuf::from(format!("/{name}")), title: name.into(), artist: "artist".into() } }
    fn entries(c: &Catalog, id: &str) -> Vec<String> { c.definition(id).unwrap().entries.iter().map(|e| e.track.title.clone()).collect() }
    #[test] fn duplicate_tracks_get_distinct_occurrences_and_non_destructive_progress() {
        let mut c = Catalog::default(); let id = c.create("Set", vec![track("A"), track("B"), track("A")]).unwrap(); let ids: Vec<_> = c.definition(&id).unwrap().entries.iter().map(|e| e.entry_id.clone()).collect();
        c.mark_started(&id, 0, &ids[0]).unwrap(); assert_eq!(c.remaining(&id).unwrap().len(), 2); assert_eq!(entries(&c, &id), vec!["A", "B", "A"]);
    }
    #[test] fn reorder_remaining_preserves_consumed_slots() {
        let mut c = Catalog::default(); let id = c.create("Set", ["A", "B", "C", "D"].into_iter().map(track).collect()).unwrap(); let ids: Vec<_> = c.definition(&id).unwrap().entries.iter().map(|e| e.entry_id.clone()).collect();
        c.mark_started(&id, 0, &ids[0]).unwrap(); c.reorder_remaining(&id, &[ids[3].clone(), ids[1].clone(), ids[2].clone()]).unwrap(); assert_eq!(entries(&c, &id), vec!["A", "D", "B", "C"]);
    }
    #[test] fn undo_is_anchored_without_undoing_later_edits() {
        let mut c = Catalog::default(); let id = c.create("Set", vec![track("A"), track("B"), track("C")]).unwrap(); let b = c.definition(&id).unwrap().entries[1].entry_id.clone(); let removed = c.remove(&id, &b).unwrap(); c.append(&id, vec![track("D")]).unwrap(); let a = c.definition(&id).unwrap().entries[0].entry_id.clone(); c.move_entry(&id, &a, 1).unwrap(); c.undo_remove(&id, removed).unwrap(); assert_eq!(entries(&c, &id), vec!["B", "C", "A", "D"]);
    }
    #[test] fn moved_consumed_occurrence_does_not_replay_and_restart_keeps_definition() {
        let mut c = Catalog::default(); let id = c.create("Set", vec![track("A"), track("B")]).unwrap(); let a = c.definition(&id).unwrap().entries[0].entry_id.clone(); c.mark_started(&id, 0, &a).unwrap(); c.move_entry(&id, &a, 1).unwrap(); assert_eq!(c.remaining(&id).unwrap()[0].track.title, "B"); c.restart(&id).unwrap(); assert_eq!(entries(&c, &id), vec!["B", "A"]); assert_eq!(c.remaining(&id).unwrap().len(), 2);
    }
    #[test] fn restart_resume_never_resurrects_deleted_occurrence() {
        let mut c = Catalog::default(); let id = c.create("Set", vec![track("A")]).unwrap(); let e = c.definition(&id).unwrap().entries[0].clone(); c.mark_started(&id, 0, &e.entry_id).unwrap(); c.current = Some(CurrentOccurrence { playlist_id: Some(id.clone()), run_id: 0, entry_id: Some(e.entry_id.clone()), track_ref: e.track, origin: PlaybackOrigin::Playlist, queue_origin: None }); c.remove(&id, &e.entry_id).unwrap(); assert!(c.resume_after_restart().is_none());
    }
    #[test] fn corrupt_and_unknown_schema_are_read_only() {
        let dir = tempfile::tempdir().unwrap(); fs::write(dir.path().join(FILE_NAME), b"{").unwrap(); let store = PlaylistStore::load(dir.path()); assert_eq!(store.load_state(), LoadState::Corrupt); assert!(store.snapshot().is_err()); drop(store);
        fs::write(dir.path().join(FILE_NAME), br#"{"schema_version":99}"#).unwrap(); let store = PlaylistStore::load(dir.path()); assert_eq!(store.load_state(), LoadState::UnsupportedSchema);
    }
    #[test] fn store_cas_and_lock_preserve_existing_snapshot() {
        let dir = tempfile::tempdir().unwrap(); let first = PlaylistStore::load(dir.path()); let second = PlaylistStore::load(dir.path()); assert_eq!(second.load_state(), LoadState::Busy); let mut candidate = first.snapshot().unwrap(); candidate.create("Set", vec![]).unwrap(); first.persist(&candidate).unwrap(); assert_eq!(first.snapshot().unwrap(), candidate); drop(first); let reopened = PlaylistStore::load(dir.path()); assert_eq!(reopened.snapshot().unwrap(), candidate);
    }
    #[test] fn busy_store_cannot_reload_or_persist() {
        let dir = tempfile::tempdir().unwrap(); let first = PlaylistStore::load(dir.path()); let second = PlaylistStore::load(dir.path()); assert!(matches!(second.reload(), Err(PlaylistError::StoreReadOnly { state: LoadState::Busy }))); let candidate = first.snapshot().unwrap(); assert!(matches!(second.persist(&candidate), Err(PlaylistError::StoreReadOnly { state: LoadState::Busy })));
    }
    #[test] fn normal_current_resume_retains_queue_origin() {
        let mut catalog = Catalog::default(); let current = CurrentOccurrence { playlist_id: None, run_id: 0, entry_id: None, track_ref: track("normal"), origin: PlaybackOrigin::Normal, queue_origin: Some(QueueOrigin::Automatic) };
        catalog.current = Some(current.clone()); assert_eq!(catalog.resume_after_restart(), Some(current)); assert!(catalog.current.is_none());
    }
    #[test] fn failure_consumes_once_and_keeps_first_reason() {
        let mut catalog = Catalog::default(); let id = catalog.create("Set", vec![track("A")]).unwrap(); let entry = catalog.definition(&id).unwrap().entries[0].entry_id.clone(); let before = catalog.revision;
        catalog.mark_failed(&id, 0, &entry, "missing").unwrap(); let after_first = catalog.revision; catalog.mark_failed(&id, 0, &entry, "different").unwrap();
        assert!(catalog.run(&id).unwrap().consumed.contains(&entry)); assert_eq!(catalog.run(&id).unwrap().failures[&entry], "missing"); assert_eq!(catalog.revision, after_first); assert!(after_first > before);
    }
    #[test] fn only_select_and_restart_advance_source_generation() {
        let mut catalog = Catalog::default(); let id = catalog.create("Set", vec![track("A")]).unwrap(); assert_eq!(catalog.generation, 0); catalog.append(&id, vec![track("B")]).unwrap(); assert_eq!(catalog.generation, 0); catalog.select(Some(id.clone())).unwrap(); assert_eq!(catalog.generation, 1); catalog.restart(&id).unwrap(); assert_eq!(catalog.generation, 2);
    }
    #[test] fn external_change_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap(); let store = PlaylistStore::load(dir.path()); let mut candidate = store.snapshot().unwrap(); candidate.create("Set", vec![]).unwrap(); fs::write(dir.path().join(FILE_NAME), b"external").unwrap(); assert_eq!(store.persist(&candidate), Err(PlaylistError::Stale)); assert_eq!(fs::read(dir.path().join(FILE_NAME)).unwrap(), b"external");
    }
    #[test] fn failed_atomic_write_keeps_file_and_snapshot() {
        let dir = tempfile::tempdir().unwrap(); let store = PlaylistStore::load(dir.path()); let mut initial = store.snapshot().unwrap(); initial.create("Old", vec![]).unwrap(); store.persist(&initial).unwrap(); let before = fs::read(dir.path().join(FILE_NAME)).unwrap();
        let mut candidate = initial.clone(); candidate.create("New", vec![]).unwrap();
        for stage in 1..=3 { FAIL_PERSIST_STAGE.with(|failure| failure.set(stage)); assert!(matches!(store.persist(&candidate), Err(PlaylistError::PersistFailed { .. }))); assert_eq!(fs::read(dir.path().join(FILE_NAME)).unwrap(), before); assert_eq!(store.snapshot().unwrap(), initial); }
    }
}
