//! One source owner for the queue, playlist IPC and loader. Lock order is
//! service -> INDEX -> SAVE -> SESSION -> queue -> render. Persistence never
//! holds render; the core future fence makes its commit reversible until save.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
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
pub struct Service {
    data: PathBuf, cache: PathBuf, queue: SharedQueue, disk: PlaylistStore, catalog: Catalog,
    normal_source: Option<HostSource>, claims: BTreeMap<usize, Claim>, next_index: usize,
    current_index: Option<usize>, epoch: u64, exhausted: bool, ended: bool,
    restored: Option<CurrentOccurrence>, undo: BTreeMap<String, (String, RemovedEntry)>,
    receipts: BTreeMap<String, (String, CommandResult)>, progress_error: bool,
    availability: BTreeMap<String, (String, String)>,
}
type Shared = Arc<Mutex<Service>>;
static SERVICE: OnceLock<Shared> = OnceLock::new();
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
            normal.items.insert(0, QueueItem { path: current.track_ref.preferred_path,
                origin: current.queue_origin.unwrap_or(QueueOrigin::Manual) });
        }
        let ended = catalog.active_id.as_deref().is_some_and(|id| catalog.definition(id).is_ok_and(|d| !d.entries.is_empty())
            && catalog.remaining(id).is_ok_and(|r| r.is_empty())) && restored.is_none();
        Self { data: data.into(), cache: cache.into(), queue, disk, catalog, normal_source: None,
            claims: BTreeMap::new(), next_index: 0, current_index: None, epoch: 0, exhausted: false, ended,
            restored, undo: BTreeMap::new(), receipts: BTreeMap::new(), progress_error: false, availability: BTreeMap::new() }
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
        self.future_claims().into_iter().filter(|(_,c)| c.source.is_none() && !c.restoring).map(|(_,c)| c.item.clone())
            .chain(queue::pending_snapshot(&self.queue)).collect()
    }
    pub fn normal_view(&self) -> (Option<QueueItem>, Vec<QueueItem>, Vec<QueueItem>) {
        let mut future: Vec<_> = self.future_claims().into_iter().filter(|(_,c)| c.source.is_none()).map(|(_,c)| c.item.clone()).collect();
        let reserved = if future.is_empty() { None } else { Some(future.remove(0)) };
        future.extend(queue::pending_snapshot(&self.queue));
        let inflight = self.claims.values().filter(|c| c.live && !c.cancelled && c.source.is_none()).map(|c| c.item.clone()).collect();
        (reserved, future, inflight)
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
    fn started(&mut self, index: usize) {
        if self.current_index == Some(index) { return; }
        let Some(claim) = self.claims.get(&index).filter(|c| !c.cancelled).cloned() else { return; };
        if let Some(old) = self.current_index.and_then(|i| self.claims.get_mut(&i)) { old.live = false; }
        self.current_index = Some(index);
        self.claims.get_mut(&index).unwrap().live = true;
        self.claims.get_mut(&index).unwrap().restoring = false;
        let valid = if let (Some(id), Some(entry)) = (&claim.source, &claim.entry) {
            self.catalog.mark_started(id, claim.run, entry).is_ok()
        } else { self.catalog.revision += 1; true };
        self.catalog.current = valid.then(|| CurrentOccurrence { playlist_id: claim.source.clone(), run_id: claim.run,
            entry_id: claim.entry, track_ref: claim.track, origin: if claim.source.is_some() { PlaybackOrigin::Playlist } else { PlaybackOrigin::Normal },
            queue_origin: claim.source.is_none().then_some(claim.item.origin) });
        self.ended = false; self.save_progress();
    }
    fn observe_started(&mut self, index: usize, playback: Option<&crate::Playback>) {
        let actual = playback.and_then(|p| p.render.lock().unwrap_or_else(|e|e.into_inner()).engine.current_index());
        if actual == Some(index) { self.started(index); return; }
        // Events may lag a polling snapshot or a whole short track. Consume
        // the exact event occurrence, but never move current playback backward.
        if let Some(claim) = self.claims.get_mut(&index).filter(|c| !c.cancelled) {
            if self.current_index != Some(index) { claim.live = false; }
            if let (Some(id), Some(entry)) = (&claim.source, &claim.entry) {
                let _ = self.catalog.mark_started(id, claim.run, entry);
            }
        }
        self.reconcile_with(playback); self.save_progress();
    }
    fn failed(&mut self, index: usize, message: &str) {
        let Some(claim) = self.claims.get_mut(&index).filter(|c| !c.cancelled && c.live) else { return; };
        claim.live = false;
        if claim.restoring { self.catalog.current = None; claim.restoring = false; }
        if let (Some(id), Some(entry)) = (&claim.source, &claim.entry) {
            let _ = self.catalog.mark_failed(id, claim.run, entry, message);
        }
        self.save_progress();
    }
    pub fn reconcile(&mut self) { self.reconcile_with(crate::PLAYBACK.get()); }
    fn reconcile_with(&mut self, playback: Option<&crate::Playback>) {
        let Some(playback) = playback else { return; };
        let (current, finished) = { let render = playback.render.lock().unwrap_or_else(|e| e.into_inner());
            (render.engine.current_index(), render.engine.is_finished()) };
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
            if let Err(reason) = self.lookup(&entry.track) { self.availability.insert(entry.entry_id, ("missing".into(), reason.into())); }
            else { self.availability.remove(&entry.entry_id); }
        }
        self.details(id, true)
    }
    pub fn restore_normal(&self) -> Option<NormalResume> { self.catalog.normal.clone() }
    pub fn has_playlist(&self) -> bool { self.active().is_some() }
}

pub struct ManagedSource { service: Shared, epoch: u64 }
impl TrackSource for ManagedSource {
    fn next(&mut self) -> Option<(usize, PathBuf)> {
        let mut owner = self.service.lock().unwrap_or_else(|e| e.into_inner());
        if owner.epoch != self.epoch { return None; }
        let restored = owner.restored.take().filter(|current| {
            current.origin == PlaybackOrigin::Normal || current.playlist_id.as_deref().is_some_and(|id| owner.catalog.run(id).is_ok_and(|r| r.run_id == current.run_id)
                && owner.catalog.definition(id).is_ok_and(|d| d.entries.iter().any(|e| Some(&e.entry_id) == current.entry_id.as_ref())))
        });
        let claim = if let Some(current) = restored {
            let path = if current.playlist_id.is_some() { owner.lookup(&current.track_ref).ok() } else { Some(current.track_ref.preferred_path.clone()) };
            if path.is_some() { owner.catalog.current = Some(current.clone()); }
            else if let (Some(id), Some(entry)) = (&current.playlist_id, &current.entry_id) {
                let _ = owner.catalog.mark_failed(id, current.run_id, entry, "missing");
                owner.catalog.current = None;
            }
            path.map(|path| Claim { source: current.playlist_id, run: current.run_id, entry: current.entry_id,
                track: current.track_ref, item: QueueItem { path, origin: current.queue_origin.unwrap_or(QueueOrigin::Manual) }, live: true, cancelled: false, restoring: true })
        } else { None };
        let claim = match claim {
            Some(c) => Some(c),
            None if owner.catalog.active_id.is_some() => {
                let id = owner.catalog.active_id.clone().unwrap(); let run = owner.catalog.run(&id).ok()?.run_id;
                let claimed: BTreeSet<_> = owner.claims.values().filter(|c| c.live && !c.cancelled && c.source.as_deref() == Some(&id) && c.run == run).filter_map(|c|c.entry.clone()).collect();
                let mut next = None;
                for entry in owner.catalog.remaining(&id).ok()? {
                    if claimed.contains(&entry.entry_id) { continue; }
                    let path = owner.lookup(&entry.track);
                    let failure = match &path { Err(reason) => Some(*reason), Ok(path) if !crate::ALLOW_NON_FUNKOT.load(Ordering::Relaxed)
                        && crate::gated_non_funkot(path, &owner.cache, &owner.data) => Some("non_funkot"), _ => None };
                    if let Some(reason) = failure { let _ = owner.catalog.mark_failed(&id, run, &entry.entry_id, reason); owner.save_progress(); continue; }
                    next = Some(Claim { source: Some(id.clone()), run, entry: Some(entry.entry_id), track: entry.track,
                        item: QueueItem::manual(path.unwrap()), live: true, cancelled: false, restoring: false }); break;
                }
                next
            }
            None => {
                let Some((_, path)) = owner.normal_source.as_mut()?.next() else { owner.exhausted = true; return None; };
                let item = queue::reserved_item(&owner.queue).unwrap_or_else(|| QueueItem::manual(path.clone()));
                Some(Claim { source: None, run: 0, entry: None, track: TrackRef { content_hash: String::new(),
                    preferred_path: path, title: String::new(), artist: String::new() }, item, live: true, cancelled: false, restoring: false })
            }
        };
        let Some(claim) = claim else { owner.exhausted = true; return None; };
        let index = owner.next_index; owner.next_index += 1; let path = claim.item.path.clone();
        owner.claims.insert(index, claim); owner.save_progress(); Some((index, path))
    }
}
pub fn configure(service: &Shared, normal: HostSource) -> ManagedSource {
    let mut owner = service.lock().unwrap_or_else(|e| e.into_inner()); owner.normal_source = Some(normal);
    ManagedSource { service: service.clone(), epoch: owner.epoch }
}
pub fn started(index: usize) {
    if let Some(s) = existing() {
        let mut owner = s.lock().unwrap_or_else(|e|e.into_inner());
        owner.observe_started(index, crate::PLAYBACK.get());
    }
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
    if owner.target() != request.target { return Err(error("stale")); }
    let mut next = owner.catalog.clone(); let mut normal = owner.normal_items(); let old_normal = normal.clone();
    let normal_only = owner.active().is_none() && matches!(&request.action, Action::Append { .. } | Action::QueueMove { .. } | Action::QueueRemove { .. });
    let append_action = matches!(&request.action, Action::Append { .. });
    let normal_append = owner.active().is_none() && append_action;
    let mut result = CommandResult::default(); let mut removed = None; let mut undo_used = None;
    let mut force_source = false;
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
                else { let at = normal.iter().position(|i|i.origin == QueueOrigin::Automatic).unwrap_or(normal.len()); normal.insert(at, QueueItem::manual(path)); }
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
            normal.remove(index); next.revision += 1;
        }
    }
    if force_source && !append_action && owner.current_index.is_none() {
        if let Some(current) = owner.restored.as_ref().filter(|c| c.origin == PlaybackOrigin::Normal) {
            normal.insert(0, QueueItem { path: current.track_ref.preferred_path.clone(),
                origin: current.queue_origin.unwrap_or(QueueOrigin::Manual) });
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
                if token.current_index() != owner.current_index { render.engine.abort_future_update(token); return Err(error("stale")); }
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
    let saved = if normal_only && !matches!(owner.disk.load_state(), LoadState::Ready | LoadState::Missing) {
        let _saving = crate::SAVE_LOCK.lock().unwrap_or_else(|e|e.into_inner());
        store::save_queue(&owner.data, &normal.iter().cloned().collect()).map_err(|e| PlaylistError::PersistFailed { message: e.to_string() })
    } else { owner.disk.persist(&next) };
    if let Err(failure) = saved {
        if let Some(token) = fence { playback.unwrap().render.lock().unwrap_or_else(|e|e.into_inner()).engine.abort_future_update(token); }
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
        let retired = { let mut render = playback.unwrap().render.lock().unwrap_or_else(|e|e.into_inner());
            render.engine.commit_future_update(fence.unwrap(), prepared.unwrap()) };
        drop(retired);
    } else if normal != old_normal {
        let claimed = owner.future_claims().iter().filter(|(_,c)|c.source.is_none()).count();
        queue::replace_pending(&owner.queue, normal.into_iter().skip(claimed).collect::<Vec<_>>());
    }
    // Appending to an ended list makes new pending work, but core remains
    // naturally stopped until the existing Play control explicitly resumes.
    if force_source && playback.is_none() { owner.ended = false; }
    owner.receipts.insert(request.request_id, (fingerprint, result.clone()));
    Ok(result)
}

/// Keep the uncancellable future once, with new manual entries at the head of
/// pending. Equal paths with different origins remain distinct queue items.
fn preserve_claims(normal: &mut Vec<QueueItem>, claims: &[QueueItem]) {
    for claim in claims { if let Some(at) = normal.iter().position(|item| item == claim) { normal.remove(at); } }
    normal.splice(..0, claims.iter().cloned());
}

#[cfg(test)]
mod tests;
