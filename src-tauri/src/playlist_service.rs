//! One source owner for the queue, playlist IPC and loader. Lock order is
//! service -> INDEX -> SAVE -> SESSION -> queue -> render. Persistence never
//! holds render; the core future fence makes its commit reversible until save.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::sync::atomic::Ordering;
use funkot_core::engine::{TrackSource, PreparedSourceReplacement, FutureUpdateBusy};
use crate::{playlists::*, queue::{self, HostSource, QueueItem, QueueOrigin, SharedQueue}, store};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct SourceTarget { pub playlist_id: Option<String>, pub generation: u64, pub revision: u64 }
#[derive(Clone, Debug, serde::Serialize)]
pub struct CommandError { pub code: String, pub message: String }
fn error(code: &str) -> CommandError { CommandError { code: code.into(), message: code.into() } }
impl From<PlaylistError> for CommandError {
    fn from(value: PlaylistError) -> Self {
        let json = serde_json::to_value(value).unwrap();
        Self { code: json["code"].as_str().unwrap_or("persist_failed").into(),
            message: json["message"].as_str().unwrap_or("").into() }
    }
}
impl From<FutureUpdateBusy> for CommandError {
    fn from(value: FutureUpdateBusy) -> Self {
        error(match value { FutureUpdateBusy::Transition => "transition_in_progress",
            FutureUpdateBusy::Navigation => "navigation_pending", FutureUpdateBusy::PreviewUpgrade => "active_upgrade_pending",
            FutureUpdateBusy::NoRunway => "no_runway", _ => "busy" })
    }
}
#[derive(Clone, serde::Serialize)]
pub struct Summary { pub id: String, pub name: String, pub revision: u64, pub total: usize, pub remaining: usize }
#[derive(serde::Serialize)]
pub struct CatalogView { pub revision: u64, pub active_id: Option<String>, pub generation: u64, pub store_status: String, pub lists: Vec<Summary> }
#[derive(Clone, serde::Serialize)]
pub struct EntryView { pub entry_id: String, pub path: String, pub title: String, pub artist: String, pub status: String, pub reason: Option<String> }
#[derive(Clone, serde::Serialize)]
pub struct Details { pub id: String, pub name: String, pub revision: u64, pub run_id: u64, pub total: usize, pub ended: bool, pub skipped: usize, pub rows: Vec<EntryView> }
#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct TrackTarget { pub path: String, pub expected_hash: Option<String> }
#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    Select { id: Option<String> }, Create { name: String }, SaveQueue { name: String },
    Rename { id: String, name: String }, Duplicate { id: String }, Delete { id: String, confirm_name: String },
    Restart { id: String }, Remove { id: String, entry_id: String }, UndoRemove { undo_id: String },
    Move { id: String, entry_id: String, to: usize, scope: String },
    Append { tracks: Vec<TrackTarget>, mode: String },
    QueueMove { from: usize, to: usize, expect: QueueItem }, QueueRemove { index: usize, expect: QueueItem },
}
#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct Request { pub request_id: String, pub target: SourceTarget, pub action: Action }
#[derive(Clone, Default, serde::Serialize)]
pub struct CommandResult { pub created_id: Option<String>, pub undo_id: Option<String>, pub added: usize, pub rejected: usize, pub skipped: usize }

#[derive(Clone)]
struct Claim { source: Option<String>, run: u64, entry: Option<String>, track: TrackRef, item: QueueItem, live: bool, cancelled: bool, restoring: bool }
impl Claim {
    fn progress(&self, index: usize) -> Option<crate::playlist_progress::Claim<&str>> {
        Some(crate::playlist_progress::Claim {
            occurrence: crate::playlist_progress::Occurrence {
                playlist: self.source.as_deref()?, run: self.run, entry: self.entry.as_deref()? },
            index, live: self.live, cancelled: self.cancelled,
        })
    }
}
use crate::playlist_progress::Observation;
use crate::queue_progress::{transition as queue_transition, Event as QueueEvent};

pub struct Service {
    data: PathBuf, cache: PathBuf, queue: SharedQueue, disk: PlaylistStore, catalog: Catalog,
    normal_source: Option<Arc<Mutex<NormalSource>>>, claims: BTreeMap<usize, Claim>, next_index: usize,
    current_index: Option<usize>, epoch: u64, exhausted: bool, ended: bool,
    restored: Option<CurrentOccurrence>, undo: BTreeMap<String, (String, RemovedEntry)>,
    receipts: BTreeMap<String, (String, CommandResult)>, progress_error: bool,
    availability: BTreeMap<String, (String, String)>,
    admission_blocked: BTreeSet<(String, String)>,
}

struct NormalSource {
    epoch: u64,
    source: HostSource,
}

type Shared = Arc<Mutex<Service>>;
static SERVICE: OnceLock<Shared> = OnceLock::new();
// Serializes pre-playback queue commands with service creation. Otherwise a
// command that checked `existing()` just before OFF creates the service could
// mutate the queue after OFF has captured its canonical normal snapshot.
static PRESTART_QUEUE_GATE: Mutex<()> = Mutex::new(());
pub fn lock_prestart_queue() -> MutexGuard<'static, ()> {
    PRESTART_QUEUE_GATE.lock().unwrap_or_else(|e| e.into_inner())
}
pub fn get(data: &Path, cache: &Path, queue: &SharedQueue) -> Shared {
    SERVICE.get_or_init(|| Arc::new(Mutex::new(Service::new(data, cache, queue.clone())))).clone()
}
pub fn existing() -> Option<Shared> { SERVICE.get().cloned() }

impl Service {
    fn new(data: &Path, cache: &Path, queue: SharedQueue) -> Self {
        let disk = PlaylistStore::load(data);
        let mut catalog = disk.snapshot().unwrap_or_default();
        let mut restored = catalog.resume_after_restart();
        // A normal current track is a future queue item after restart. Fold it
        // in once so pre-start editing and saving see the same queue as Play.
        if catalog.active_id.is_none() && restored.as_ref().is_some_and(|c| c.origin == PlaybackOrigin::Normal) {
            let current = restored.take().unwrap();
            let normal = catalog.normal.get_or_insert(NormalResume { items: vec![], folder_pos: None });
            normal.items.insert(0, QueueItem::with_origin(current.track_ref.preferred_path,
                current.queue_origin.unwrap_or(QueueOrigin::Manual)));
        }
        let ended = catalog.active_id.as_deref().is_some_and(|id| catalog.definition(id).is_ok_and(|d| !d.entries.is_empty())
            && catalog.remaining(id).is_ok_and(|r| r.is_empty())) && restored.is_none();
        Self { data: data.into(), cache: cache.into(), queue, disk, catalog, normal_source: None,
            claims: BTreeMap::new(), next_index: 0, current_index: None, epoch: 0, exhausted: false, ended,
            restored, undo: BTreeMap::new(), receipts: BTreeMap::new(), progress_error: false, availability: BTreeMap::new(),
            admission_blocked: BTreeSet::new() }
    }
    pub fn target(&self) -> SourceTarget { SourceTarget { playlist_id: self.catalog.active_id.clone(), generation: self.catalog.generation, revision: self.catalog.revision } }
    pub fn active(&self) -> Option<&str> { self.catalog.active_id.as_deref() }
    pub fn store_status(&self) -> String {
        if self.progress_error { return "persist_failed".into(); }
        serde_json::to_value(self.disk.load_state()).unwrap().as_str().unwrap_or("io_error").into()
    }
    pub fn catalog_view(&self) -> CatalogView {
        CatalogView { revision: self.catalog.revision, active_id: self.catalog.active_id.clone(), generation: self.catalog.generation,
            store_status: self.store_status(), lists: self.catalog.definitions.iter().map(|d| Summary {
                id: d.id.clone(), name: d.name.clone(), revision: d.revision, total: d.entries.len(),
                remaining: self.catalog.remaining(&d.id).map_or(0, |r| r.len()) }).collect() }
    }
    pub fn details(&self, id: &str, all: bool) -> Result<Details, CommandError> {
        let d = self.catalog.definition(id)?; let run = self.catalog.run(id)?;
        let entries = if all { d.entries.clone() } else { self.catalog.remaining(id)? };
        let rows = entries.into_iter().map(|entry| {
            let claim = self.claims.iter().find(|(_, c)| c.live && !c.cancelled && c.source.as_deref() == Some(id)
                && c.run == run.run_id && c.entry.as_deref() == Some(&entry.entry_id));
            let reason = run.failures.get(&entry.entry_id).cloned().or_else(|| self.availability.get(&entry.entry_id).map(|v| v.1.clone()));
            let status = if run.failures.contains_key(&entry.entry_id) { if reason.as_deref() == Some("missing") { "missing" } else { "unplayable" } }
                else if claim.is_some_and(|(index, _)| Some(*index) == self.current_index) { "current" }
                else if run.consumed.contains(&entry.entry_id) { "played" }
                else if let Some((index, _)) = claim { if self.future_claims().first().is_some_and(|(i, _)| *i == *index)
                    && crate::NEXT_PREPARED.load(Ordering::Relaxed) { "prepared" } else { "preparing" } }
                else if let Some((state, _)) = self.availability.get(&entry.entry_id) { state.as_str() } else { "pending" };
            EntryView { entry_id: entry.entry_id, path: claim.map(|(_, c)| c.item.path.clone()).unwrap_or(entry.track.preferred_path).to_string_lossy().into(),
                title: entry.track.title, artist: entry.track.artist, status: status.into(), reason }
        }).collect();
        Ok(Details { id: d.id.clone(), name: d.name.clone(), revision: d.revision, run_id: run.run_id,
            total: d.entries.len(), ended: self.active() == Some(id) && self.ended, skipped: run.failures.len(), rows })
    }
    fn future_claims(&self) -> Vec<(usize, &Claim)> {
        self.claims.iter().filter(|(i,c)| c.live && !c.cancelled && Some(**i) != self.current_index).map(|(i,c)| (*i,c)).collect()
    }
    pub fn normal_items(&self) -> Vec<QueueItem> {
        queue::pending_snapshot(&self.queue)
    }
    pub fn normal_view(&self) -> (Option<QueueItem>, Vec<QueueItem>, Vec<QueueItem>) {
        let reserved = self.future_claims().into_iter()
            .find(|(_, claim)| claim.source.is_none())
            .map(|(_, claim)| claim.item.clone());
        let pending = queue::pending_snapshot(&self.queue).into_iter()
            .filter(|item| reserved.as_ref().is_none_or(|next| next.entry_id != item.entry_id))
            .collect();
        let inflight = self.claims.values().filter(|c| c.live && !c.cancelled && c.source.is_none()).map(|c| c.item.clone()).collect();
        (reserved, pending, inflight)
    }
    fn capture_normal(&self, catalog: &mut Catalog, items: Option<Vec<QueueItem>>) {
        catalog.normal = Some(NormalResume { items: items.unwrap_or_else(|| self.normal_items()), folder_pos: if self.normal_source.is_some() { Some(crate::FOLDER_POS.load(Ordering::Relaxed)) } else { self.catalog.normal.as_ref().and_then(|n| n.folder_pos) } });
        if catalog.current.is_none() {
            if let Some(claim) = self.current_index.and_then(|i| self.claims.get(&i)).filter(|c| !c.cancelled) {
                let valid = match (&claim.source, &claim.entry) {
                    (Some(id), Some(entry)) => catalog.run(id).is_ok_and(|r| r.run_id == claim.run)
                        && catalog.definition(id).is_ok_and(|d| d.entries.iter().any(|e| &e.entry_id == entry)),
                    (None, None) => true, _ => false,
                };
                if valid { catalog.current = Some(CurrentOccurrence { playlist_id: claim.source.clone(), run_id: claim.run,
                    entry_id: claim.entry.clone(), track_ref: claim.track.clone(),
                    origin: if claim.source.is_some() { PlaybackOrigin::Playlist } else { PlaybackOrigin::Normal },
                    queue_origin: claim.source.is_none().then_some(claim.item.origin) }); }
            }
        }
        // Edits made before Play must not lose the saved audible occurrence
        // from a different source, even across another application restart.
        if self.current_index.is_none() && catalog.current.is_none() {
            if let Some(current) = self.restored.as_ref().filter(|c| c.origin == PlaybackOrigin::Normal
                || c.playlist_id.as_deref().is_some_and(|id| catalog.run(id).is_ok_and(|r| r.run_id == c.run_id)
                    && catalog.definition(id).is_ok_and(|d| d.entries.iter().any(|e| Some(&e.entry_id) == c.entry_id.as_ref())))) {
                catalog.current = Some(current.clone());
            }
        }
    }
    fn save_progress(&mut self) {
        let mut candidate = self.catalog.clone(); self.capture_normal(&mut candidate, None);
        // Actual audio progress cannot be rolled back. Keep it in memory on
        // failure; the durable older run repeats at worst, never loses entries.
        self.catalog = candidate;
        self.progress_error = matches!(self.disk.load_state(), LoadState::Ready | LoadState::Missing) && self.disk.persist(&self.catalog).is_err();
    }
    fn save_normal_queue(&mut self) {
        let _saving = crate::SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let pending = queue::pending_snapshot(&self.queue).into_iter().collect();
        if let Err(error) = store::save_queue(&self.data, &pending) {
            log::warn!("save_queue after playback start: {error}");
            self.progress_error = true;
        }
    }
    fn started(&mut self, index: usize) {
        if self.current_index == Some(index) { return; }
        let Some(claim) = self.claims.get(&index).filter(|c| !c.cancelled).cloned() else { return; };
        if let Some(old) = self.current_index.and_then(|i| self.claims.get_mut(&i)) { old.live = false; }
        self.current_index = Some(index);
        self.claims.get_mut(&index).unwrap().live = true;
        self.claims.get_mut(&index).unwrap().restoring = false;
        let valid = if claim.source.is_some() {
            self.catalog.observe_progress(claim.progress(index), Observation::Current(index), None)
        } else { self.catalog.revision += 1; true };
        let retired = valid && claim.source.is_none() && queue::mark_started(&self.queue, &claim.item);
        if retired { crate::retire_started_in_flight(&claim.item); }
        self.catalog.current = valid.then(|| CurrentOccurrence { playlist_id: claim.source.clone(), run_id: claim.run,
            entry_id: claim.entry, track_ref: claim.track, origin: if claim.source.is_some() { PlaybackOrigin::Playlist } else { PlaybackOrigin::Normal },
            queue_origin: claim.source.is_none().then_some(claim.item.origin) });
        self.ended = false;
        self.save_progress();
        if retired && !self.progress_error { self.save_normal_queue(); }
    }
    fn observe_started(&mut self, index: usize, playback: Option<&crate::Playback>) {
        let snapshot = playback.and_then(|p| p.observation.read());
        if snapshot.is_some_and(|snapshot| snapshot.current == Some(index)) {
            self.started(index);
            return;
        }
        // Events may lag a polling snapshot or a whole short track. Consume
        // the exact event occurrence, but never move current playback backward.
        let mut retired = false;
        if let Some(claim) = self.claims.get_mut(&index).filter(|c| !c.cancelled) {
            if self.current_index != Some(index) { claim.live = false; }
            self.catalog.observe_progress(claim.progress(index), Observation::Started(index), None);
            if claim.source.is_none() {
                retired = queue::mark_started(&self.queue, &claim.item);
                if retired { crate::retire_started_in_flight(&claim.item); }
            }
        }
        if let Some(snapshot) = snapshot { self.reconcile_snapshot(snapshot); }
        self.save_progress();
        if retired && !self.progress_error { self.save_normal_queue(); }
    }
    fn failed(&mut self, index: usize, message: &str) {
        let Some(claim) = self.claims.get_mut(&index).filter(|c| !c.cancelled && c.live) else { return; };
        // An empty failure is not a reason to discard an unplayed occurrence.
        if message.trim().is_empty() { return; }
        self.catalog.observe_progress(claim.progress(index),
            Observation::Failed { index, reason_present: false }, Some(message));
        claim.live = false;
        if claim.restoring { self.catalog.current = None; claim.restoring = false; }
        self.save_progress();
    }
    pub fn reconcile(&mut self) { self.reconcile_with(crate::PLAYBACK.get()); }
    fn reconcile_with(&mut self, playback: Option<&crate::Playback>) {
        let Some(snapshot) = playback.and_then(|playback| playback.observation.read()) else { return; };
        self.reconcile_snapshot(snapshot);
    }
    fn reconcile_snapshot(&mut self, snapshot: crate::engine_observation::EngineSnapshot) {
        let (current, finished) = (snapshot.current, snapshot.finished);
        if let Some(index) = current { self.started(index); }
        if finished {
            let had_current = self.current_index.take();
            if let Some(old) = had_current.and_then(|i| self.claims.get_mut(&i)) { old.live = false; }
            // A newly selected/restarted/appended source may have pending work
            // while the old finite engine waits for explicit Play.
            self.ended = self.active().is_some_and(|id| self.catalog.definition(id).is_ok_and(|d| !d.entries.is_empty())
                && self.catalog.remaining(id).is_ok_and(|r| r.is_empty()));
            if had_current.is_some() || self.catalog.current.is_some() {
                self.catalog.current = None; self.catalog.revision += 1; self.save_progress();
            }
        }
    }
    fn lookup(&self, track: &TrackRef) -> Result<PathBuf, &'static str> {
        let _index = crate::INDEX_LOCK.lock().unwrap_or_else(|e|e.into_inner());
        let index = store::load_hash_index(&self.data).index;
        let matches = |path: &Path, entry: &store::HashIndexEntry| entry.hash == track.content_hash && store::fingerprint_matches(path, entry);
        if index.get(track.preferred_path.to_string_lossy().as_ref()).is_some_and(|e| matches(&track.preferred_path, e)) { return Ok(track.preferred_path.clone()); }
        // Resolve only this referenced file if its fingerprint changed; never
        // rehash the whole library for a playlist operation.
        if track.preferred_path.is_file() && funkot_core::cache::content_hash(&track.preferred_path).is_ok_and(|h| h == track.content_hash) {
            return Ok(track.preferred_path.clone());
        }
        index.iter().find(|(p,e)| matches(Path::new(p), e)).map(|(p,_)| PathBuf::from(p)).ok_or("missing")
    }
    fn track_ref(&self, target: &TrackTarget) -> Result<TrackRef, CommandError> {
        let _index = crate::INDEX_LOCK.lock().unwrap_or_else(|e|e.into_inner());
        let mut index = store::load_hash_index(&self.data).index;
        let path = PathBuf::from(&target.path);
        let resolved = store::resolve_library_file(&path, &mut index).map_err(|_| error("identity_unavailable"))?;
        if target.expected_hash.as_ref().is_some_and(|h| h != &resolved.hash) { return Err(error("identity_changed")); }
        Ok(TrackRef { content_hash: resolved.hash, preferred_path: path.clone(),
            title: resolved.title.unwrap_or_else(|| path.file_name().unwrap_or_default().to_string_lossy().into()), artist: resolved.artist.unwrap_or_default() })
    }
    pub fn inspect_entries(&mut self, id: &str) -> Result<Details, CommandError> {
        for entry in self.catalog.definition(id)?.entries.clone() {
            if self.admission_blocked.contains(&(id.into(), entry.entry_id.clone())) {
                self.availability.insert(entry.entry_id, ("unplayable".into(), "non_funkot".into()));
            } else if let Err(reason) = self.lookup(&entry.track) {
                self.availability.insert(entry.entry_id, ("missing".into(), reason.into()));
            } else if !self.availability.get(&entry.entry_id)
                .is_some_and(|(_, reason)| reason == "admission_unavailable") {
                self.availability.remove(&entry.entry_id);
            }
        }
        self.details(id, true)
    }
    pub fn restore_normal(&self) -> Option<NormalResume> { self.catalog.normal.clone() }
    pub fn has_playlist(&self) -> bool { self.active().is_some() }
}

pub struct ManagedSource { service: Shared, epoch: u64 }
impl TrackSource for ManagedSource {
    fn next(&mut self) -> Option<(usize, PathBuf)> {
        let mut unavailable_this_call = BTreeSet::new();
        loop {
            // Folder admission can decode an unanalysed track. Keep the
            // service mutex available to UI commands while that work runs.
            let normal_source = {
                let owner = self.service.lock().unwrap_or_else(|e| e.into_inner());
                if owner.epoch != self.epoch { return None; }
                if owner.restored.is_none() && owner.catalog.active_id.is_none() {
                    owner.normal_source.clone()
                } else { None }
            };
            let normal_selected = normal_source.map(|source| {
                let mut source = source.lock().unwrap_or_else(|e| e.into_inner());
                (source.epoch == self.epoch).then(|| source.source.next()).flatten()
            });
            let (claim, cache, data, queue) = {
                let mut owner = self.service.lock().unwrap_or_else(|e| e.into_inner());
                if owner.epoch != self.epoch {
                    return None;
                }
                let restored = owner.restored.take().filter(|current| {
                    current.origin == PlaybackOrigin::Normal || current.playlist_id.as_deref().is_some_and(|id| {
                        owner.catalog.run(id).is_ok_and(|run| run.run_id == current.run_id)
                            && owner.catalog.definition(id).is_ok_and(|definition| {
                                definition.entries.iter().any(|entry| Some(&entry.entry_id) == current.entry_id.as_ref())
                            })
                    })
                });
                let claim = if let Some(current) = restored {
                    let path = if current.playlist_id.is_some() {
                        owner.lookup(&current.track_ref).ok()
                    } else {
                        Some(current.track_ref.preferred_path.clone())
                    };
                    if path.is_some() {
                        owner.catalog.current = Some(current.clone());
                    } else if let (Some(id), Some(entry)) = (&current.playlist_id, &current.entry_id) {
                        let _ = owner.catalog.unavailable(id, current.run_id, entry, "missing");
                        owner.catalog.current = None;
                    }
                    path.map(|path| Claim {
                        source: current.playlist_id,
                        run: current.run_id,
                        entry: current.entry_id,
                        track: current.track_ref,
                        item: QueueItem::with_origin(
                            path,
                            current.queue_origin.unwrap_or(QueueOrigin::Manual),
                        ),
                        live: true,
                        cancelled: false,
                        restoring: true,
                    })
                } else {
                    None
                };
                let claim = match claim {
                    Some(claim) => Some(claim),
                    None if owner.catalog.active_id.is_some() => {
                        let id = owner.catalog.active_id.clone().unwrap();
                        let run = owner.catalog.run(&id).ok()?.run_id;
                        let claimed: BTreeSet<_> = owner
                            .claims
                            .values()
                            .filter(|claim| {
                                claim.live
                                    && !claim.cancelled
                                    && claim.source.as_deref() == Some(&id)
                                    && claim.run == run
                            })
                            .filter_map(|claim| claim.entry.clone())
                            .collect();
                        let mut next = None;
                        for entry in owner.catalog.remaining(&id).ok()? {
                            if claimed.contains(&entry.entry_id)
                                || owner.admission_blocked.contains(&(id.clone(), entry.entry_id.clone()))
                                || unavailable_this_call.contains(&(id.clone(), entry.entry_id.clone())) {
                                continue;
                            }
                            let path = match owner.lookup(&entry.track) {
                                Ok(path) => path,
                                Err(reason) => {
                                    let _ = owner.catalog.unavailable(&id, run, &entry.entry_id, reason);
                                    owner.save_progress();
                                    continue;
                                }
                            };
                            next = Some(Claim {
                                source: Some(id.clone()),
                                run,
                                entry: Some(entry.entry_id),
                                track: entry.track,
                                item: QueueItem::manual(path),
                                live: true,
                                cancelled: false,
                                restoring: false,
                            });
                            break;
                        }
                        next
                    }
                    None => {
                        let Some(selection) = normal_selected else {
                            if owner.normal_source.is_some() { continue; }
                            owner.exhausted = true;
                            return None;
                        };
                        let Some((_, path)) = selection else {
                            owner.exhausted = true;
                            return None;
                        };
                        // A queue edit may have revoked the reservation while
                        // folder analysis ran without the service mutex.
                        let Some(item) = queue::reserved_item(&owner.queue)
                            .filter(|item| item.path == path) else { continue; };
                        Some(Claim {
                            source: None,
                            run: 0,
                            entry: None,
                            track: TrackRef {
                                content_hash: String::new(),
                                preferred_path: path,
                                title: String::new(),
                                artist: String::new(),
                            },
                            item,
                            live: true,
                            cancelled: false,
                            restoring: false,
                        })
                    }
                };
                let Some(claim) = claim else {
                    owner.exhausted = true;
                    return None;
                };
                (claim, owner.cache.clone(), owner.data.clone(), owner.queue.clone())
            };
            let allow_non_funkot = crate::ALLOW_NON_FUNKOT.load(Ordering::Relaxed);
            let admission = crate::admit_playback_path(&claim.item.path, &cache, &data, allow_non_funkot);
            log::info!("playback admission: {} allow_non_funkot={} result={:?}",
                claim.item.path.display(), allow_non_funkot, admission);
            if admission != crate::PlaybackAdmission::Accepted {
                let rejected = admission == crate::PlaybackAdmission::Rejected;
                let blocked_normal = {
                    let mut owner = self.service.lock().unwrap_or_else(|e| e.into_inner());
                    if owner.epoch != self.epoch { return None; }
                    let blocked_normal = if let (Some(id), Some(entry)) = (&claim.source, &claim.entry) {
                        if owner.catalog.active_id.as_deref() != Some(id) || !owner.catalog.run(id).is_ok_and(|run| run.run_id == claim.run) || !owner.catalog.definition(id).is_ok_and(|definition| definition.entries.iter().any(|candidate| candidate.entry_id == *entry)) { return None; }
                        if rejected { owner.admission_blocked.insert((id.clone(), entry.clone())); }
                        else { unavailable_this_call.insert((id.clone(), entry.clone())); }
                        owner.availability.insert(entry.clone(), ("unplayable".into(), if rejected { "non_funkot" } else { "admission_unavailable" }.into()));
                        if claim.restoring { owner.catalog.current = None; }
                        false
                    } else {
                        if claim.restoring { owner.catalog.current = None; }
                        if rejected { queue::remove_admission_disabled(&owner.queue, &claim.item) }
                        else { queue::block_reserved(&owner.queue, &claim.item) }
                    };
                    owner.save_progress();
                    blocked_normal
                };
                if rejected && blocked_normal {
                    let _saving = crate::SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
                    let mut session = crate::SESSION.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                    session.in_flight.retain(|item| item.entry_id != claim.item.entry_id);
                    if let Err(error) = crate::store::save_session(&data, &session) {
                        log::warn!("cannot retire admission-disabled session item: {error}");
                    }
                    drop(session);
                    let pending = queue::pending_snapshot(&queue).into_iter().collect();
                    if let Err(error) = crate::store::save_queue(&data, &pending) {
                        log::warn!("cannot save queue after admission-disabled removal: {error}");
                    }
                }
                continue;
            }
            let mut owner = self.service.lock().unwrap_or_else(|e| e.into_inner());
            if owner.epoch != self.epoch { return None; }
            if let (Some(id), Some(entry)) = (&claim.source, &claim.entry) {
                if owner.catalog.active_id.as_deref() != Some(id)
                    || !owner.catalog.run(id).is_ok_and(|run| run.run_id == claim.run)
                    || !owner.catalog.definition(id).is_ok_and(|definition| {
                        definition.entries.iter().any(|candidate| candidate.entry_id == *entry)
                    }) { return None; }
            }
            if let Some(entry) = &claim.entry { owner.availability.remove(entry); }
            let index = owner.next_index;
            owner.next_index += 1;
            let path = claim.item.path.clone();
            owner.claims.insert(index, claim);
            owner.save_progress();
            return Some((index, path));
        }
    }
}
pub fn configure(service: &Shared, normal: HostSource) -> ManagedSource {
    let mut owner = service.lock().unwrap_or_else(|e| e.into_inner());
    owner.normal_source = Some(Arc::new(Mutex::new(NormalSource { epoch: owner.epoch, source: normal })));
    ManagedSource { service: service.clone(), epoch: owner.epoch }
}


/// Persist an admission switch only after the core has accepted a future-source
/// fence. The old source's normal reservation path is held quiescent while the
/// epoch changes, so it cannot write a stale session claim after restoration.
pub fn reconfigure_admission(
    service: &Shared,
    allow_non_funkot: bool,
    playback: Option<&crate::Playback>,
    persist_settings: impl FnOnce() -> Result<(), String>,
) -> Result<(), CommandError> {
    let mut owner = service.lock().unwrap_or_else(|e| e.into_inner());
    let previous = crate::ALLOW_NON_FUNKOT.load(Ordering::Relaxed);
    // OFF is a cleanup operation as well as a setting change. The atomic can
    // already be false while an older source still has admitted normal
    // reservations, so only an unchanged ON setting may skip the future fence.
    if previous == allow_non_funkot && allow_non_funkot {
        let _saving = crate::SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        return persist_settings().map_err(|message| CommandError { code: "persist_failed".into(), message });
    }
    owner.reconcile_with(playback);
    let Some(playback) = playback else {
        if owner.normal_source.is_some() {
            return Err(error("busy"));
        }
        let _saving = crate::SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous_queue = queue::pending_snapshot(&owner.queue).into_iter().collect::<std::collections::VecDeque<_>>();
        // The setting command can arrive before queue-tab preload. Recover the
        // same canonical normal source as startup, then append any live items
        // that were queued after that snapshot by exact occurrence ID.
        let canonical = match owner.restore_normal() {
            Some(resume) => resume.items,
            None => {
                let session = store::load_session(&owner.data);
                let saved = store::load_queue(&owner.data).map_err(|error| CommandError {
                    code: "persist_failed".into(),
                    message: format!("cannot load queue: {error}"),
                })?;
                store::restored_pending(&session.in_flight, &saved)
            }
        };
        let mut normal = merge_normal_items(canonical, previous_queue.iter().cloned());
        if !allow_non_funkot {
            let overrides = store::load_overrides(&owner.data);
            normal.retain(|item| !gated_non_funkot_for_reconfigure(&item.path, &owner.cache, &overrides)
                || queue_transition(item.entry_id.as_str(), true, QueueEvent::AdmissionDisabled(item.entry_id.as_str())).present);
        }
        let queue_changed = !normal.iter().eq(previous_queue.iter());
        let previous_catalog = owner.catalog.clone();
        let mut next_catalog = previous_catalog.clone();
        next_catalog.normal = Some(NormalResume { items: normal.clone(), folder_pos: previous_catalog.normal.as_ref().and_then(|resume| resume.folder_pos) });
        let catalog_changed = next_catalog != previous_catalog;
        if queue_changed {
            let updated = normal.iter().cloned().collect();
            store::save_queue(&owner.data, &updated).map_err(|error| CommandError {
                code: "persist_failed".into(), message: format!("cannot save queue: {error}")
            })?;
        }
        if catalog_changed {
            if let Err(error) = owner.disk.persist(&next_catalog) {
                if queue_changed { let _ = store::save_queue(&owner.data, &previous_queue); }
                return Err(CommandError { code: "persist_failed".into(), message: format!("cannot save normal resume: {error:?}") });
            }
        }
        if let Err(message) = persist_settings() {
            let queue_error = queue_changed.then(|| store::save_queue(&owner.data, &previous_queue)).transpose().err();
            let catalog_error = catalog_changed.then(|| owner.disk.persist(&previous_catalog)).transpose().err();
            if let Some(error) = queue_error {
                return Err(CommandError { code: "persist_failed".into(), message: format!("cannot restore queue after settings failure: {error}") });
            }
            if let Some(error) = catalog_error {
                return Err(CommandError { code: "persist_failed".into(), message: format!("cannot restore normal resume after settings failure: {error:?}") });
            }
            return Err(CommandError { code: "persist_failed".into(), message });
        }
        if queue_changed { queue::restore_all(&owner.queue, normal); }
        if catalog_changed { owner.catalog = next_catalog; owner.progress_error = false; }
        crate::ALLOW_NON_FUNKOT.store(allow_non_funkot, Ordering::Relaxed);
        owner.admission_blocked.clear();
        owner.availability.retain(|_, value| !(value.0 == "unplayable" && value.1 == "non_funkot"));
        return Ok(());
    };

    let next_epoch = owner.epoch + 1;
    let prepared = PreparedSourceReplacement::new(Box::new(ManagedSource {
        service: service.clone(), epoch: next_epoch,
    })).map_err(|_| error("busy"))?;
    // Freeze the core future before waiting for a loader already in
    // HostSource::next. Do not hold render while taking normal_source.
    let mut render = playback.render.lock().unwrap_or_else(|e| e.into_inner());
    let token = if crate::AUDITIONING.load(Ordering::Relaxed)
        || crate::AUDITION_PREPARING.load(Ordering::Relaxed)
        || render.audition.is_some() {
        Err(error("auditioning"))
    } else {
        render.engine.begin_future_update().map_err(|reason| {
            if reason == FutureUpdateBusy::Transition && playback.paused.load(Ordering::Relaxed) {
                error("transition_paused")
            } else { reason.into() }
        })
    }?;
    if token.current_index() != owner.current_index {
        render.engine.abort_future_update(token);
        playback.publish_engine_observation(&render.engine);
        return Err(error("stale"));
    }
    drop(render);

    // ManagedSource releases service while HostSource reserves. Quiesce it
    // after the core fence so a waiting loader cannot admit the old future.
    let normal_source = owner.normal_source.clone();
    let mut normal_source_guard = normal_source.as_ref().map(|source| source.lock().unwrap_or_else(|e| e.into_inner()));
    let future = owner.future_claims();
    let normal_claims: Vec<_> = future.iter().filter(|(_, claim)| claim.source.is_none())
        .map(|(_, claim)| claim.item.clone()).collect();
    let mut revoked_normal = normal_claims.clone();
    if let Some(reserved) = queue::reserved_item(&owner.queue) {
        let is_current = owner.current_index.and_then(|index| owner.claims.get(&index))
            .is_some_and(|claim| claim.source.is_none() && claim.item.entry_id == reserved.entry_id);
        if !is_current && !revoked_normal.iter().any(|claim| claim.entry_id == reserved.entry_id) {
            revoked_normal.push(reserved);
        }
    }
    let _saving = crate::SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let previous_queue = queue::pending_snapshot(&owner.queue).into_iter().collect::<std::collections::VecDeque<_>>();
    let mut normal = owner.normal_items();
    preserve_claims(&mut normal, &revoked_normal);
    if !allow_non_funkot {
        let overrides = store::load_overrides(&owner.data);
        normal.retain(|item| !gated_non_funkot_for_reconfigure(&item.path, &owner.cache, &overrides)
            || queue_transition(item.entry_id.as_str(), true, QueueEvent::AdmissionDisabled(item.entry_id.as_str())).present);
    }
    let queue_changed = !normal.iter().eq(previous_queue.iter());
    let previous_catalog = owner.catalog.clone();
    let mut next_catalog = previous_catalog.clone();
    next_catalog.normal = Some(NormalResume { items: normal.clone(), folder_pos: Some(crate::FOLDER_POS.load(Ordering::Relaxed)) });
    let catalog_changed = next_catalog != previous_catalog;

    let previous_session = if !revoked_normal.is_empty() {
        let mut session = crate::SESSION.lock().unwrap_or_else(|e| e.into_inner());
        let previous = session.clone();
        let mut updated = previous.clone();
        updated.in_flight.retain(|item| !revoked_normal.iter()
            .any(|claim| claim.entry_id == item.entry_id));
        if let Err(error) = store::save_session(&owner.data, &updated) {
            drop(session);
            drop(_saving);
            let mut render = playback.render.lock().unwrap_or_else(|e| e.into_inner());
            render.engine.abort_future_update(token);
            playback.publish_engine_observation(&render.engine);
            return Err(CommandError { code: "persist_failed".into(), message: format!("cannot save session: {error}") });
        }
        *session = updated;
        Some(previous)
    } else {
        None
    };
    if queue_changed {
        let updated_queue = normal.iter().cloned().collect();
        if let Err(error) = store::save_queue(&owner.data, &updated_queue) {
            if let Some(previous) = previous_session.as_ref() {
                let mut session = crate::SESSION.lock().unwrap_or_else(|e| e.into_inner());
                let _ = store::save_session(&owner.data, previous);
                *session = previous.clone();
            }
            drop(_saving);
            let mut render = playback.render.lock().unwrap_or_else(|e| e.into_inner());
            render.engine.abort_future_update(token);
            playback.publish_engine_observation(&render.engine);
            return Err(CommandError { code: "persist_failed".into(), message: format!("cannot save queue: {error}") });
        }
    }
    if catalog_changed {
        if let Err(error) = owner.disk.persist(&next_catalog) {
            if queue_changed { let _ = store::save_queue(&owner.data, &previous_queue); }
            if let Some(previous) = previous_session.as_ref() {
                let mut session = crate::SESSION.lock().unwrap_or_else(|e| e.into_inner());
                let _ = store::save_session(&owner.data, previous);
                *session = previous.clone();
            }
            drop(_saving);
            let mut render = playback.render.lock().unwrap_or_else(|e| e.into_inner());
            render.engine.abort_future_update(token);
            playback.publish_engine_observation(&render.engine);
            return Err(CommandError { code: "persist_failed".into(), message: format!("cannot save normal resume: {error:?}") });
        }
    }
    if let Err(message) = persist_settings() {
        let queue_error = queue_changed.then(|| store::save_queue(&owner.data, &previous_queue)).transpose().err();
        let catalog_error = catalog_changed.then(|| owner.disk.persist(&previous_catalog)).transpose().err();
        let session_error = if let Some(previous) = previous_session.as_ref() {
            let mut session = crate::SESSION.lock().unwrap_or_else(|e| e.into_inner());
            let saved = store::save_session(&owner.data, previous).err();
            *session = previous.clone();
            saved
        } else { None };
        drop(_saving);
        let mut render = playback.render.lock().unwrap_or_else(|e| e.into_inner());
        render.engine.abort_future_update(token);
        playback.publish_engine_observation(&render.engine);
        if let Some(error) = queue_error {
            return Err(CommandError { code: "persist_failed".into(), message: format!("cannot restore queue after settings failure: {error}") });
        }
        if let Some(error) = catalog_error {
            return Err(CommandError { code: "persist_failed".into(), message: format!("cannot restore normal resume after settings failure: {error:?}") });
        }
        if let Some(error) = session_error {
            return Err(CommandError { code: "persist_failed".into(), message: format!("cannot restore session after settings failure: {error}") });
        }
        return Err(CommandError { code: "persist_failed".into(), message });
    }
    if catalog_changed { owner.catalog = next_catalog; owner.progress_error = false; }
    crate::ALLOW_NON_FUNKOT.store(allow_non_funkot, Ordering::Relaxed);
    let current_index = owner.current_index;
    for (index, claim) in owner.claims.iter_mut() {
        if Some(*index) != current_index && claim.live {
            claim.cancelled = true;
            claim.live = false;
        }
    }
    let blocked = std::mem::take(&mut owner.admission_blocked);
    for (_, entry) in blocked {
        if owner.availability.get(&entry) == Some(&("unplayable".into(), "non_funkot".into())) {
            owner.availability.remove(&entry);
        }
    }
    queue::restore_all(&owner.queue, normal);
    owner.epoch = next_epoch;
    owner.exhausted = false;
    if let Some(normal_source) = normal_source_guard.as_mut() {
        normal_source.epoch = next_epoch;
    }
    drop(normal_source_guard);
    drop(_saving);

    let retired = {
        let mut render = playback.render.lock().unwrap_or_else(|e| e.into_inner());
        let retired = render.engine.commit_future_update(token, prepared);
        playback.publish_engine_observation(&render.engine);
        retired
    };
    crate::NEXT_PREPARED.store(false, Ordering::Relaxed);
    crate::YIELD_FOR_LOADER.store(true, Ordering::Relaxed);
    // The retired loader may still be waiting to re-enter ManagedSource::next.
    // It observes the new epoch only after it acquires this service lock.
    drop(owner);
    drop(retired);
    Ok(())
}
pub fn started(index: usize) -> Option<QueueOrigin> {
    if let Some(s) = existing() {
        let mut owner = s.lock().unwrap_or_else(|e|e.into_inner());
        let origin = owner.claims.get(&index)
            .filter(|claim| !claim.cancelled && claim.source.is_none())
            .map(|claim| claim.item.origin);
        owner.observe_started(index, crate::PLAYBACK.get());
        return origin;
    }
    None
}
pub fn current_queue_origin() -> Option<QueueOrigin> {
    let service = existing()?;
    let owner = service.lock().unwrap_or_else(|e| e.into_inner());
    let claim = owner.claims.get(&owner.current_index?)?;
    (claim.source.is_none() && !claim.cancelled).then_some(claim.item.origin)
}
pub fn failed(index: usize, message: &str) { if let Some(s) = existing() { s.lock().unwrap_or_else(|e|e.into_inner()).failed(index, message); } }
pub fn finished() { if let Some(s) = existing() { s.lock().unwrap_or_else(|e|e.into_inner()).reconcile(); } }

pub fn command(service: &Shared, request: Request) -> Result<CommandResult, CommandError> {
    command_with(service, request, crate::PLAYBACK.get())
}
fn command_with(service: &Shared, request: Request, playback: Option<&crate::Playback>) -> Result<CommandResult, CommandError> {
    if request.request_id.trim().is_empty() { return Err(error("invalid_input")); }
    let fingerprint = serde_json::to_string(&request).unwrap();
    let mut owner = service.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((old, receipt)) = owner.receipts.get(&request.request_id) {
        return if old == &fingerprint { Ok(receipt.clone()) } else { Err(error("stale")) };
    }
    owner.reconcile_with(playback);
    // A source replacement must snapshot normal work only after the old
    // HostSource has stopped reserving it. Keep this guard through publication.
    let normal_source = owner.normal_source.clone();
    let mut normal_source_guard = normal_source.as_ref()
        .map(|source| source.lock().unwrap_or_else(|e| e.into_inner()));
    if owner.target() != request.target { return Err(error("stale")); }
    let mut next = owner.catalog.clone(); let mut normal = owner.normal_items(); let old_normal = normal.clone();
    let normal_only = owner.active().is_none() && matches!(&request.action, Action::Append { .. } | Action::QueueMove { .. } | Action::QueueRemove { .. });
    let append_action = matches!(&request.action, Action::Append { .. });
    let normal_append = owner.active().is_none() && append_action;
    let mut result = CommandResult::default(); let mut removed = None; let mut undo_used = None;
    let mut removed_normal = None;
    let mut force_source = false;
    let mut retired = None;
    match request.action {
        Action::Create { name } => { result.created_id = Some(next.create(name, vec![])?); }
        Action::SaveQueue { name } => {
            if owner.active().is_some() { return Err(error("stale")); }
            let tracks = normal.iter().map(|item| owner.track_ref(&TrackTarget { path: item.path.to_string_lossy().into(), expected_hash: None })).collect::<Result<Vec<_>,_>>()?;
            result.created_id = Some(next.create(name, tracks)?);
        }
        Action::Select { id } => { force_source = next.active_id != id; next.select(id)?; }
        Action::Rename { id, name } => next.rename(&id, name)?,
        Action::Duplicate { id } => { result.created_id = Some(next.duplicate(&id)?); }
        Action::Delete { id, confirm_name } => { if next.definition(&id)?.name != confirm_name { return Err(error("stale")); } next.delete(&id)?; }
        Action::Restart { id } => { next.restart(&id)?; force_source = owner.active() == Some(&id); }
        Action::Remove { id, entry_id } => { removed = Some((id.clone(), next.remove(&id, &entry_id)?)); result.undo_id = Some(request.request_id.clone()); }
        Action::UndoRemove { undo_id } => { let (id, entry) = owner.undo.get(&undo_id).cloned().ok_or_else(|| error("stale"))?;
            next.undo_remove(&id, entry)?; undo_used = Some(undo_id); }
        Action::Move { id, entry_id, to, scope } => {
            if scope == "all" { next.move_entry(&id, &entry_id, to)?; }
            else if scope == "remaining" { let mut ids: Vec<_> = next.remaining(&id)?.into_iter().map(|e|e.entry_id).collect();
                let from = ids.iter().position(|e| e == &entry_id).ok_or_else(|| error("stale"))?;
                if to >= ids.len() { return Err(error("invalid_input")); } let entry = ids.remove(from); ids.insert(to, entry); next.reorder_remaining(&id, &ids)?;
            } else { return Err(error("invalid_input")); }
        }
        Action::Append { tracks, mode } => {
            if !["single", "many", "arrivals"].contains(&mode.as_str()) { return Err(error("invalid_input")); }
            let mut accepted = Vec::new();
            for track in tracks {
                let path = PathBuf::from(&track.path);
                if !crate::ALLOW_NON_FUNKOT.load(Ordering::Relaxed) && crate::gated_non_funkot(&path, &owner.cache, &owner.data) { result.rejected += 1; continue; }
                if mode != "single" && owner.active().is_none() && (normal.iter().any(|i|i.path == path)
                    || owner.current_index.and_then(|i|owner.claims.get(&i)).is_some_and(|c|c.item.path == path)) { result.skipped += 1; continue; }
                if owner.active().is_some() { accepted.push(owner.track_ref(&track)?); }
                else {
                    let at = normal.iter().position(|i| i.origin == QueueOrigin::Automatic).unwrap_or(normal.len());
                    let item = QueueItem::manual(path);
                    if queue_transition(item.entry_id.as_str(), false, QueueEvent::UserAdd(item.entry_id.as_str())).present {
                        normal.insert(at, item);
                    }
                }
                result.added += 1;
            }
            if let Some(id) = next.active_id.clone() { if !accepted.is_empty() { next.append(&id, accepted)?; } }
            else if result.added > 0 { next.revision += 1; }
            if result.added > 0 && owner.exhausted { force_source = true; }
        }
        Action::QueueMove { from, to, expect } => {
            if owner.active().is_some() || normal.get(from) != Some(&expect) { return Err(error("stale")); }
            if to >= normal.len() || normal[to].origin != expect.origin { return Err(error("invalid_input")); }
            let item = normal.remove(from); normal.insert(to, item); next.revision += 1;
        }
        Action::QueueRemove { index, expect } => {
            if owner.active().is_some() || normal.get(index) != Some(&expect) { return Err(error("stale")); }
            if !queue_transition(expect.entry_id.as_str(), true, QueueEvent::UserDelete(expect.entry_id.as_str())).present {
                normal.remove(index);
            }
            removed_normal = Some(expect);
            next.revision += 1;
        }
    }
    if force_source && !append_action && owner.current_index.is_none() {
        if let Some(current) = owner.restored.as_ref().filter(|c| c.origin == PlaybackOrigin::Normal) {
            normal.insert(0, QueueItem::with_origin(current.track_ref.preferred_path.clone(),
                current.queue_origin.unwrap_or(QueueOrigin::Manual)));
        } else if let Some(claim) = owner.claims.values().find(|c| c.restoring && c.source.is_none() && c.live && !c.cancelled) {
            normal.insert(0, claim.item.clone());
        }
    }
    let future = owner.future_claims();
    let normal_claims: Vec<_> = future.iter().filter(|(_, c)| c.source.is_none()).map(|(_, c)| c.item.clone()).collect();
    // Preserve the established manual-priority deadline. A committed automatic
    // next track stays first; adding manual work still succeeds behind it.
    if normal_append && !normal_claims.is_empty() {
        if let Some(playback) = playback {
            let render = playback.render.lock().unwrap_or_else(|e|e.into_inner());
            let frames = render.engine.frames_until_transition().unwrap_or(u64::MAX);
            let safe = !crate::AUDITIONING.load(Ordering::Relaxed) && !crate::AUDITION_PREPARING.load(Ordering::Relaxed)
                && render.audition.is_none() && playback.sample_rate != 0
                && frames as f64 / playback.sample_rate as f64 > crate::SWAP_DEADLINE_SECS;
            if !safe { preserve_claims(&mut normal, &normal_claims); }
        }
    }
    let invalidates_claim = if let Some(id) = next.active_id.as_deref() {
        let remaining = next.remaining(id)?;
        let expected: Vec<_> = remaining.iter().map(|e|e.entry_id.as_str()).collect();
        let actual: Vec<_> = future.iter().filter(|(_,c)|c.source.as_deref() == Some(id)).filter_map(|(_,c)|c.entry.as_deref()).collect();
        expected.get(..actual.len()) != Some(actual.as_slice())
    } else {
        let actual: Vec<_> = future.iter().filter(|(_,c)|c.source.is_none()).map(|(_,c)|c.item.clone()).collect();
        normal.get(..actual.len()) != Some(actual.as_slice())
    };
    // Startup publishes the source before the audio control handle. A change
    // affecting already claimed work must wait for that handle's fence.
    if playback.is_none() && owner.normal_source.is_some() && (force_source || invalidates_claim) {
        return Err(error("busy"));
    }
    let mut replace = (force_source || invalidates_claim) && playback.is_some();
    let next_epoch = owner.epoch + usize::from(replace) as u64;
    let mut prepared = if replace { Some(PreparedSourceReplacement::new(Box::new(ManagedSource { service: service.clone(), epoch: next_epoch }))
        .map_err(|_| error("busy"))?) } else { None };
    let fence = if replace {
        let playback = playback.unwrap(); let mut render = playback.render.lock().unwrap_or_else(|e| e.into_inner());
        let token = if crate::AUDITIONING.load(Ordering::Relaxed) || crate::AUDITION_PREPARING.load(Ordering::Relaxed) || render.audition.is_some() {
            Err(error("auditioning"))
        } else { render.engine.begin_future_update().map_err(|reason| {
            if reason == FutureUpdateBusy::Transition && playback.paused.load(Ordering::Relaxed) {
                error("transition_paused")
            } else { reason.into() }
        }) };
        match token {
            Ok(token) => {
                // A callback may have started a track since reconcile. Fail
                // before save instead of editing a different displayed row.
                if token.current_index() != owner.current_index {
                    render.engine.abort_future_update(token);
                    playback.publish_engine_observation(&render.engine);
                    return Err(error("stale"));
                }
                Some(token)
            }
            Err(_) if normal_append && !force_source => {
                preserve_claims(&mut normal, &normal_claims); replace = false; prepared = None; None
            }
            Err(reason) => return Err(reason),
        }
    } else { None };
    owner.capture_normal(&mut next, Some(normal.clone()));
    if force_source && !append_action && owner.current_index.is_none() { next.current = None; }
    // Keep deletion, the session claim, and the displayed queue in one save
    // order. Session goes first: if the queue save fails, the older durable
    // queue still restores the occurrence; the inverse order can resurrect a
    // successfully deleted occurrence after a crash.
    let _saving = crate::SAVE_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let saved = (|| {
        if let Some(item) = &removed_normal {
            let mut session = crate::SESSION.lock().unwrap_or_else(|e|e.into_inner());
            if session.in_flight.iter().any(|entry| entry.entry_id == item.entry_id) {
                let mut updated = session.clone();
                store::retire_revoked(&mut updated.in_flight, item);
                store::save_session(&owner.data, &updated)
                    .map_err(|e| PlaylistError::PersistFailed { message: e.to_string() })?;
                *session = updated;
            }
        }
        if normal_only && !matches!(owner.disk.load_state(), LoadState::Ready | LoadState::Missing) {
            store::save_queue(&owner.data, &normal.iter().cloned().collect())
                .map_err(|e| PlaylistError::PersistFailed { message: e.to_string() })
        } else { owner.disk.persist(&next) }
    })();
    if let Err(failure) = saved {
        drop(_saving);
        if let Some(token) = fence {
            let playback = playback.unwrap();
            let mut render = playback.render.lock().unwrap_or_else(|e|e.into_inner());
            render.engine.abort_future_update(token);
            playback.publish_engine_observation(&render.engine);
        }
        return Err(failure.into());
    }
    owner.catalog = next; owner.progress_error = false;
    if force_source && !append_action && owner.current_index.is_none() { owner.restored = None; }
    if let Some(removed) = removed { owner.undo.insert(request.request_id.clone(), removed); }
    if let Some(id) = undo_used { owner.undo.remove(&id); }
    if replace {
        // Waking this same finite source must replay an interrupted restore
        // claim before its appended tail. A source choice intentionally clears it.
        if append_action && owner.current_index.is_none()
            && owner.claims.values().any(|c| c.restoring && c.live && !c.cancelled) {
            owner.restored = owner.catalog.current.clone();
        }
        let current_index = owner.current_index;
        for (i, claim) in owner.claims.iter_mut() { if Some(*i) != current_index && claim.live { claim.cancelled = true; claim.live = false; } }
        queue::restore_all(&owner.queue, normal);
        owner.epoch = next_epoch; owner.exhausted = false;
        if let Some(normal_source) = normal_source_guard.as_mut() {
            normal_source.epoch = next_epoch;
        }
        drop(normal_source_guard);
        drop(_saving);
        let playback = playback.unwrap();
        retired = Some({ let mut render = playback.render.lock().unwrap_or_else(|e|e.into_inner());
            let retired = render.engine.commit_future_update(fence.unwrap(), prepared.unwrap());
            playback.publish_engine_observation(&render.engine);
            retired });
    } else if normal != old_normal {
        queue::replace_pending(&owner.queue, normal);
        drop(normal_source_guard);
        drop(_saving);
    } else {
        drop(normal_source_guard);
        drop(_saving);
    }
    // Appending to an ended list makes new pending work, but core remains
    // naturally stopped until the existing Play control explicitly resumes.
    if force_source && playback.is_none() { owner.ended = false; }
    // A reopened terminal list has no exhausted source yet, but new pending
    // entries still replace the ended display after their save succeeds.
    if append_action && result.added > 0 && owner.active().is_some() { owner.ended = false; }
    owner.receipts.insert(request.request_id, (fingerprint, result.clone()));
    drop(owner);
    drop(retired);
    Ok(result)
}

/// This destructive removal path uses the same full content hash as final
/// admission. It must not trust the index fingerprint: a replacement can keep
/// its length and mtime while changing content. Unreadable paths stay queued.
fn gated_non_funkot_for_reconfigure(
    path: &Path,
    cache: &Path,
    overrides: &store::Overrides,
) -> bool {
    let Ok(hash) = funkot_core::cache::content_hash(path) else { return false; };
    let Some(analysis) = crate::analyzed_cache_entry(cache, &hash) else { return false; };
    let override_funkot = overrides.get(&hash).and_then(|entry| entry.funkot);
    !store::effective_is_funkot(analysis.is_funkot, override_funkot)
}

/// Merge the startup-normal snapshot with items added to the live queue
/// after that snapshot. Matching occurrence IDs retain canonical order.
fn merge_normal_items(
    mut canonical: Vec<QueueItem>,
    live: impl IntoIterator<Item = QueueItem>,
) -> Vec<QueueItem> {
    let mut known = canonical.iter().map(|item| item.entry_id.clone()).collect::<std::collections::HashSet<_>>();
    for item in live {
        if known.insert(item.entry_id.clone()) {
            canonical.push(item);
        }
    }
    canonical
}

/// Keep the uncancellable future once, with new manual entries at the head of
/// pending. Equal paths with different origins remain distinct queue items.
fn preserve_claims(normal: &mut Vec<QueueItem>, claims: &[QueueItem]) {
    for claim in claims { if let Some(at) = normal.iter().position(|item| item == claim) { normal.remove(at); } }
    normal.splice(..0, claims.iter().cloned());
}

#[cfg(test)]
mod tests;
