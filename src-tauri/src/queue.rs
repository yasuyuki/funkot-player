//! Pending entries remain members until user deletion or accepted playback.
//! Reservations and rejection markers do not remove membership.
//! Lock order is INDEX_LOCK, SAVE_LOCK, SESSION, queue, render. Loader
//! observers run after releasing the queue lock; the audio callback never
//! acquires this mutex.

use std::collections::{HashSet, VecDeque};
use std::hash::{BuildHasher, Hasher};
use crate::queue_progress::{transition, Event};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use funkot_core::engine::TrackSource;

/// How a track entered the playback queue.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueueOrigin {
    Manual,
    Automatic,
}

/// A queued path together with the policy that controls its priority.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct QueueItem {
    #[serde(default = "new_entry_id")]
    pub entry_id: String,
    pub path: PathBuf,
    pub origin: QueueOrigin,
}

fn new_entry_id() -> String {
    static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    static PROCESS: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    let process = PROCESS.get_or_init(|| std::collections::hash_map::RandomState::new().build_hasher().finish());
    format!("{process:016x}-{:016x}", SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

impl QueueItem {
    pub fn with_origin(path: PathBuf, origin: QueueOrigin) -> Self {
        Self { entry_id: new_entry_id(), path, origin }
    }

    pub fn manual(path: PathBuf) -> Self {
        Self { entry_id: new_entry_id(), path, origin: QueueOrigin::Manual }
    }

    pub fn automatic(path: PathBuf) -> Self {
        Self { entry_id: new_entry_id(), path, origin: QueueOrigin::Automatic }
    }
}

impl From<PathBuf> for QueueItem {
    fn from(path: PathBuf) -> Self {
        Self::manual(path)
    }
}

impl PartialEq<PathBuf> for QueueItem {
    fn eq(&self, other: &PathBuf) -> bool {
        self.path == *other
    }
}

impl PartialEq<QueueItem> for PathBuf {
    fn eq(&self, other: &QueueItem) -> bool {
        *self == other.path
    }
}

pub struct QueueState {
    pending: VecDeque<QueueItem>,
    reserved: Option<QueueItem>,
    reservations: HashSet<String>,
    blocked: HashSet<String>,
}

impl QueueState {
    fn usable(&self) -> Option<&QueueItem> {
        self.pending.iter().find(|item| !self.reservations.contains(&item.entry_id) && !self.blocked.contains(&item.entry_id))
    }
    fn cancel(&mut self, id: &str) -> bool {
        let removed = self.reservations.remove(id);
        if self.reserved.as_ref().is_some_and(|item| item.entry_id == id) {
            self.reserved = None;
        }
        removed
    }
}

/// Shared handle to the host-owned queue. Cheap to clone; every clone points
/// at the same underlying [`QueueState`].
pub type SharedQueue = Arc<Mutex<QueueState>>;

/// A fresh, empty queue with nothing reserved.
pub fn new_shared_queue() -> SharedQueue {
    Arc::new(Mutex::new(QueueState {
        pending: VecDeque::new(),
        reserved: None,
        reservations: HashSet::new(),
        blocked: HashSet::new(),
    }))
}

/// Append `path` to the tail of the pending queue. Returns the pending
/// queue's length after the insert.
pub fn enqueue(queue: &SharedQueue, path: PathBuf) -> usize {
    let mut q = queue.lock().unwrap();
    let at = q
        .pending
        .iter()
        .position(|item| item.origin == QueueOrigin::Automatic)
        .unwrap_or(q.pending.len());
    let item = QueueItem::manual(path);
    if transition(item.entry_id.as_str(), false, Event::UserAdd(item.entry_id.as_str())).present {
        q.pending.insert(at, item);
    }
    q.pending.len()
}

pub fn replace_pending<T: Into<QueueItem>>(queue: &SharedQueue, items: Vec<T>) {
    let mut q = queue.lock().unwrap();
    q.pending = items.into_iter().map(Into::into).collect();
    let retained: HashSet<_> = q.pending.iter().map(|item| item.entry_id.clone()).collect();
    q.reservations.retain(|id| retained.contains(id));
    q.blocked.retain(|id| retained.contains(id));
    if q.reserved.as_ref().is_some_and(|item| !retained.contains(&item.entry_id)) {
        q.reserved = None;
    }
}

pub(crate) fn pending_snapshot(queue: &SharedQueue) -> Vec<QueueItem> {
    queue.lock().unwrap().pending.iter().cloned().collect()
}

pub(crate) fn reserved_item(queue: &SharedQueue) -> Option<QueueItem> {
    queue.lock().unwrap().reserved.clone()
}

pub(crate) fn discard_reserved(queue: &SharedQueue, item: &QueueItem) -> bool {
    queue.lock().unwrap().cancel(&item.entry_id)
}

pub(crate) fn mark_started(queue: &SharedQueue, item: &QueueItem) -> bool {
    let mut q = queue.lock().unwrap();
    let Some(index) = q.pending.iter().position(|entry| entry.entry_id == item.entry_id) else { return false; };
    let update = transition(item.entry_id.as_str(), true, Event::PlaybackStarted { entry: item.entry_id.as_str(), accepted: true });
    if update.present { return false; }
    q.pending.remove(index);
    q.cancel(&item.entry_id);
    q.blocked.remove(&item.entry_id);
    true
}

pub(crate) fn block_reserved(queue: &SharedQueue, item: &QueueItem) -> bool {
    let mut q = queue.lock().unwrap();
    if !q.pending.iter().any(|entry| entry.entry_id == item.entry_id) { return false; }
    let update = transition(item.entry_id.as_str(), true, Event::Reject(item.entry_id.as_str()));
    if !update.present { return false; }
    q.cancel(&item.entry_id);
    q.blocked.insert(item.entry_id.clone());
    true
}

/// Restore persisted membership after old engine claims have been fenced.
pub(crate) fn restore_all(queue: &SharedQueue, items: Vec<QueueItem>) {
    let mut q = queue.lock().unwrap();
    q.pending = items.into();
    q.reserved = None;
    q.reservations.clear();
    q.blocked.clear();
}

pub fn prepend_pending_filtered(
    queue: &SharedQueue,
    candidates: &[PathBuf],
    now_playing: Option<&Path>,
    in_flight: &[QueueItem],
) -> usize {
    use std::collections::HashSet;

    let mut q = queue.lock().unwrap();
    let mut excluded: HashSet<PathBuf> = HashSet::new();
    if let Some(r) = q.reserved.as_ref() {
        excluded.insert(r.path.clone());
    }
    for item in &q.pending {
        excluded.insert(item.path.clone());
    }
    if let Some(np) = now_playing {
        excluded.insert(np.to_path_buf());
    }
    for item in in_flight {
        excluded.insert(item.path.clone());
    }

    let mut to_add: Vec<PathBuf> = Vec::new();
    for c in candidates {
        if excluded.insert(c.clone()) {
            to_add.push(c.clone());
        }
    }
    let n = to_add.len();
    let mut at = q
        .pending
        .iter()
        .position(|item| item.origin == QueueOrigin::Automatic)
        .unwrap_or(q.pending.len());
    for path in to_add {
        let item = QueueItem::manual(path);
    if transition(item.entry_id.as_str(), false, Event::UserAdd(item.entry_id.as_str())).present {
        q.pending.insert(at, item);
    }
        at += 1;
    }
    n
}

/// An edit to pending membership, including reserved occurrences.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueueEdit {
    /// Move the item at `from` to `to` (both displayed-list indices).
    Move { from: usize, to: usize },
    /// Remove the item at `index` (a displayed-list index).
    Remove { index: usize },
}

/// Why [`edit_displayed`] refused an edit. Machine-readable so the frontend
/// can pick a message without parsing prose; kept in sync with the
/// `reorder`/`dequeue` Tauri commands (`src-tauri/src/lib.rs`), which return
/// [`EditError::as_str`] verbatim as their error string, and with
/// `src/lib/tauri.ts`, which matches on those same strings. Changing the
/// strings on one side without the other breaks that contract silently.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditError {
    /// The edit reached into the reserved slot, but `revoke` reported
    /// nothing to take back — the engine already consumed it into a
    /// transition, or (per the caller's `revoke`) an audition engine is
    /// currently loaded. The queue is left exactly as it was.
    TooLate,
    /// The path at the edit's subject index (`Move::from` / `Remove::index`)
    /// no longer matches `expect`: the caller's view of the list is older
    /// than what is here now. The queue is left exactly as it was.
    Stale,
    /// An index in the edit is outside the displayed list's current bounds.
    /// The queue is left exactly as it was.
    OutOfRange,
    /// A move attempted to cross the manual/automatic priority boundary.
    OriginBoundary,
}

impl EditError {
    pub fn as_str(&self) -> &'static str {
        match self {
            EditError::TooLate => "too_late",
            EditError::Stale => "stale",
            EditError::OutOfRange => "out_of_range",
            EditError::OriginBoundary => "origin_boundary",
        }
    }
}

impl std::fmt::Display for EditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

pub fn edit_displayed(
    queue: &SharedQueue,
    edit: QueueEdit,
    expect: &QueueItem,
    revoke: impl FnOnce() -> Option<PathBuf>,
) -> Result<(), EditError> {
    let mut q = queue.lock().unwrap();
    let (subject, end) = match edit {
        QueueEdit::Move { from, to } => (from, to),
        QueueEdit::Remove { index } => (index, index),
    };
    if subject >= q.pending.len() || end >= q.pending.len() { return Err(EditError::OutOfRange); }
    if q.pending.get(subject) != Some(expect) { return Err(EditError::Stale); }
    if let QueueEdit::Move { from, to } = edit {
        if from == to { return Ok(()); }
        if (from.min(to)..=from.max(to)).any(|i| q.pending[i].origin != expect.origin) {
            return Err(EditError::OriginBoundary);
        }
    }
    let affected: Vec<_> = (subject.min(end)..=subject.max(end))
        .filter_map(|i| q.reservations.contains(&q.pending[i].entry_id).then(|| q.pending[i].clone())).collect();
    if !affected.is_empty() {
        // This compatibility entry point can revoke only one prepared slot.
        if affected.len() != 1 || revoke().as_ref() != Some(&affected[0].path) { return Err(EditError::TooLate); }
        q.cancel(&affected[0].entry_id);
    }
    match edit {
        QueueEdit::Move { from, to } => {
            let item = q.pending.remove(from).unwrap();
            q.pending.insert(to, item);
        }
        QueueEdit::Remove { index } => {
            if !transition(expect.entry_id.as_str(), true, Event::UserDelete(expect.entry_id.as_str())).present {
                q.pending.remove(index);
                q.blocked.remove(&expect.entry_id);
            }
        }
    }
    Ok(())
}

/// Snapshot of the pending queue's current contents, for `state()`.
pub fn snapshot(queue: &SharedQueue) -> Vec<QueueItem> {
    queue.lock().unwrap().pending.iter().cloned().collect()
}

/// Pending owns every row; reservation metadata must not duplicate it.
pub fn state_snapshot(queue: &SharedQueue) -> (Option<QueueItem>, Vec<QueueItem>) {
    (None, pending_snapshot(queue))
}

#[cfg(test)]
pub(crate) fn reserved_track(queue: &SharedQueue) -> Option<PathBuf> {
    reserved_item(queue).map(|item| item.path)
}

pub fn manual_priority_needed(queue: &SharedQueue) -> bool {
    let q = queue.lock().unwrap();
    q.reserved.as_ref().is_some_and(|item| item.origin == QueueOrigin::Automatic)
        && q.pending.iter().any(|item| item.origin == QueueOrigin::Manual && !q.reservations.contains(&item.entry_id) && !q.blocked.contains(&item.entry_id))
}

pub fn prioritize_manual(queue: &SharedQueue, revoke: impl FnOnce() -> Option<PathBuf>) -> Option<QueueItem> {
    let mut q = queue.lock().unwrap();
    let item = q.reserved.clone()?;
    if item.origin != QueueOrigin::Automatic || !q.pending.iter().any(|entry| entry.origin == QueueOrigin::Manual && !q.reservations.contains(&entry.entry_id) && !q.blocked.contains(&entry.entry_id)) { return None; }
    if revoke()? != item.path { return None; }
    q.cancel(&item.entry_id);
    Some(item)
}

/// What to play once the host-managed pending queue runs dry.
pub enum DrainPolicy {
    /// BGM use case: keep cycling through the source folder's tracks in
    /// order, wrapping back to the start once the end is reached.
    ContinueFolder { tracks: Vec<PathBuf>, pos: usize },
}

pub type PendingObserver = Box<dyn FnMut(&[QueueItem]) + Send>;

/// Called with the track [`HostSource::next`] is about to hand back, every
/// time it is called, regardless of whether the track came from the pending
/// queue or the folder-drain fallback. See [`HostSource::on_reserved`].
pub type ReservedObserver = Box<dyn FnMut(&QueueItem) + Send>;

pub type FolderPosObserver = Box<dyn FnMut(usize) + Send>;

/// Called for each folder-drain candidate; return `true` to skip that path
/// and try the next. See [`HostSource::skip_folder_entry`].
pub type FolderSkip = Box<dyn FnMut(&Path) -> bool + Send>;

/// `TrackSource` backed by a [`SharedQueue`] instead of a fixed playlist, so a
/// host can append/reorder/remove tracks while the engine is already running.
///
/// `index` handed back to the engine (and echoed verbatim in
/// [`funkot_core::engine::EngineEvent::TrackStarted`]) is just this source's
/// own call count; nothing outside this module currently depends on its
/// values being contiguous or matching queue positions.
pub struct HostSource {
    queue: SharedQueue,
    policy: DrainPolicy,
    calls: usize,
    on_pending_consumed: Option<PendingObserver>,
    on_reserved: Option<ReservedObserver>,
    on_folder_pos: Option<FolderPosObserver>,
    folder_skip: Option<FolderSkip>,
}

impl HostSource {
    pub fn new(queue: SharedQueue, policy: DrainPolicy) -> Self {
        Self {
            queue,
            policy,
            calls: 0,
            on_pending_consumed: None,
            on_reserved: None,
            on_folder_pos: None,
            folder_skip: None,
        }
    }

    /// Skip folder-drain candidates for which `skip` returns `true` (e.g.
    /// analysed non-Funkot while the gate is on). Pending-queue entries are
    /// never filtered. If every folder entry is skipped in one full cycle,
    /// [`TrackSource::next`] returns `None` (exhausted).
    pub fn skip_folder_entry(mut self, skip: FolderSkip) -> Self {
        self.folder_skip = Some(skip);
        self
    }

    /// Notify the host after automatic fill changes pending membership.
    pub fn on_pending_consumed(mut self, observer: PendingObserver) -> Self {
        self.on_pending_consumed = Some(observer);
        self
    }

    pub fn on_reserved(mut self, observer: ReservedObserver) -> Self {
        self.on_reserved = Some(observer);
        self
    }

    pub fn on_folder_pos(mut self, observer: FolderPosObserver) -> Self {
        self.on_folder_pos = Some(observer);
        self
    }
}

impl TrackSource for HostSource {
    fn next(&mut self) -> Option<(usize, PathBuf)> {
        // Take the skip callback out so `pick_folder_track` can borrow
        // `self.policy` and the callback at the same time.
        let mut folder_skip = self.folder_skip.take();
        let result = self.next_with_skip(&mut folder_skip);
        self.folder_skip = folder_skip;
        result
    }
}

impl HostSource {
    fn next_with_skip(
        &mut self,
        folder_skip: &mut Option<FolderSkip>,
    ) -> Option<(usize, PathBuf)> {
        let (item, remaining) = loop {
            let mut q = self.queue.lock().unwrap();
            if let Some(item) = q.usable().cloned() {
                q.reservations.insert(item.entry_id.clone());
                q.reserved = Some(item.clone());
                break (item, None);
            }
            let blocked_paths: HashSet<_> = q.pending.iter().filter(|item| q.blocked.contains(&item.entry_id)).map(|item| item.path.clone()).collect();
            drop(q);
            let mut candidate = None;
            let DrainPolicy::ContinueFolder { tracks, .. } = &self.policy;
            for _ in 0..tracks.len() {
                let Some(path) = Self::pick_folder_track(&mut self.policy, folder_skip) else { break; };
                if !blocked_paths.contains(&path) { candidate = Some(path); break; }
            }
            let path = candidate?;
            if let Some(observer) = self.on_folder_pos.as_mut() {
                let DrainPolicy::ContinueFolder { pos, .. } = &self.policy;
                observer(*pos);
            }
            let mut q = self.queue.lock().unwrap();
            if q.usable().is_some() { continue; }
            // Rejection may have arrived while the folder predicate ran.
            if q.pending.iter().any(|item| item.path == path && q.blocked.contains(&item.entry_id)) { continue; }
            let item = QueueItem::automatic(path);
            if !transition(item.entry_id.as_str(), false, Event::AutomaticFill {
                entry: item.entry_id.as_str(), source_request: true, unreserved_usable: false,
            }).present { return None; }
            q.pending.push_back(item.clone());
            q.reservations.insert(item.entry_id.clone());
            q.reserved = Some(item.clone());
            let remaining = Some(q.pending.iter().cloned().collect::<Vec<_>>());
            break (item, remaining);
        };
        if let (Some(remaining), Some(observer)) =
            (remaining, self.on_pending_consumed.as_mut())
        {
            observer(&remaining);
        }
        if let Some(observer) = self.on_reserved.as_mut() {
            observer(&item);
        }
        let index = self.calls;
        self.calls += 1;
        Some((index, item.path))
    }

    /// Next folder-drain path that `folder_skip` does not reject, advancing
    /// `pos` for every considered entry (skipped or not). `None` when the
    /// folder list is empty or every entry is skipped in one full cycle.
    fn pick_folder_track(
        policy: &mut DrainPolicy,
        folder_skip: &mut Option<FolderSkip>,
    ) -> Option<PathBuf> {
        let DrainPolicy::ContinueFolder { tracks, pos } = policy;
        if tracks.is_empty() {
            return None;
        }
        // Wrap before indexing, not just after: `pos` is a public
        // field, so a caller can hand us one that is already past
        // the end. Panicking here would kill the loader thread and
        // stop playback with no way back (see the module docs on
        // the `loader_exhausted` latch).
        if *pos >= tracks.len() {
            *pos = 0;
        }
        let start = *pos;
        loop {
            let path = tracks[*pos].clone();
            *pos = (*pos + 1) % tracks.len();
            let skip = folder_skip
                .as_mut()
                .map(|f| f(path.as_path()))
                .unwrap_or(false);
            if !skip {
                return Some(path);
            }
            if *pos == start {
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn p(name: &str) -> PathBuf { PathBuf::from(name) }
    fn empty_policy() -> DrainPolicy { folder_policy(&[]) }
    fn folder_policy(names: &[&str]) -> DrainPolicy {
        DrainPolicy::ContinueFolder { tracks: names.iter().map(|name| p(name)).collect(), pos: 0 }
    }
    #[test]
    fn host_source_returns_none_when_pending_and_folder_are_both_empty() {
        let q = new_shared_queue();
        let mut source = HostSource::new(q, empty_policy());
        assert_eq!(source.next(), None);
    }

    #[test]
    fn host_source_sees_items_enqueued_after_construction() {
        let q = new_shared_queue();
        let mut source = HostSource::new(Arc::clone(&q), empty_policy());
        assert_eq!(source.next(), None);
        enqueue(&q, p("late"));
        assert_eq!(source.next(), Some((0, p("late"))));
    }

    #[test]
    fn host_source_wraps_around_at_end_of_folder() {
        let q = new_shared_queue();
        let mut source = HostSource::new(q, folder_policy(&["f1", "f2"]));
        assert_eq!(source.next(), Some((0, p("f1"))));
        assert_eq!(source.next(), Some((1, p("f2"))));
        assert_eq!(source.next(), Some((2, p("f1"))));
        assert_eq!(source.next(), Some((3, p("f2"))));
    }

    #[test]
    fn host_source_repeats_a_single_folder_track_as_distinct_occurrences() {
        let q = new_shared_queue();
        let mut source = HostSource::new(q, folder_policy(&["only"]));
        assert_eq!(source.next(), Some((0, p("only"))));
        assert_eq!(source.next(), Some((1, p("only"))));
        assert_eq!(source.next(), Some((2, p("only"))));
    }

    #[test]
    fn host_source_skips_folder_entries_matching_predicate() {
        let q = new_shared_queue();
        let mut source = HostSource::new(q, folder_policy(&["f1", "skip", "f3"])).skip_folder_entry(
            Box::new(|path| path.file_name().and_then(|n| n.to_str()) == Some("skip")),
        );
        assert_eq!(source.next(), Some((0, p("f1"))));
        assert_eq!(source.next(), Some((1, p("f3"))));
        assert_eq!(source.next(), Some((2, p("f1"))));
    }

    #[test]
    fn host_source_folder_skip_does_not_filter_pending() {
        let q = new_shared_queue();
        enqueue(&q, p("pending-non-funkot"));
        let mut source = HostSource::new(Arc::clone(&q), folder_policy(&["f1"]))
            .skip_folder_entry(Box::new(|_| true));
        assert_eq!(source.next(), Some((0, p("pending-non-funkot"))));
        // Folder has only skippable entries left → exhausted.
        assert_eq!(source.next(), None);
    }

    #[test]
    fn host_source_prefers_pending_queue_and_resumes_folder_position() {
        let q = new_shared_queue();
        let mut source = HostSource::new(Arc::clone(&q), folder_policy(&["f1", "f2", "f3"]));
        assert_eq!(source.next(), Some((0, p("f1"))));
        enqueue(&q, p("priority"));
        assert_eq!(source.next(), Some((1, p("priority"))));
        // Folder resumes from where it left off (f2), not from the start.
        assert_eq!(source.next(), Some((2, p("f2"))));
        assert_eq!(source.next(), Some((3, p("f3"))));
    }

    #[test]
    fn reservations_keep_membership_until_each_accepted_start() {
        let q = new_shared_queue();
        enqueue(&q, p("same")); enqueue(&q, p("same"));
        let before = snapshot(&q);
        assert_ne!(before[0].entry_id, before[1].entry_id);
        let mut source = HostSource::new(q.clone(), empty_policy());
        assert_eq!(source.next(), Some((0, p("same"))));
        assert_eq!(source.next(), Some((1, p("same"))));
        assert_eq!(source.next(), None);
        assert_eq!(snapshot(&q), before);
        assert_eq!(state_snapshot(&q), (None, before.clone()));
        assert!(mark_started(&q, &before[1]));
        assert!(!mark_started(&q, &before[1]));
        assert_eq!(snapshot(&q), vec![before[0].clone()]);
        assert!(mark_started(&q, &before[0]));
        assert!(snapshot(&q).is_empty());
    }

    #[test]
    fn rejected_entries_stay_and_folder_does_not_retry_their_paths() {
        let q = new_shared_queue();
        enqueue(&q, p("bad"));
        let bad = snapshot(&q)[0].clone();
        let mut source = HostSource::new(q.clone(), folder_policy(&["bad", "good"]));
        assert_eq!(source.next(), Some((0, p("bad"))));
        assert!(block_reserved(&q, &bad));
        assert_eq!(source.next(), Some((1, p("good"))));
        let good = reserved_item(&q).unwrap();
        assert!(block_reserved(&q, &good));
        assert_eq!(source.next(), None);
        assert_eq!(snapshot(&q), vec![bad, good]);
    }

    #[test]
    fn automatic_fill_waits_for_all_usable_pending_reservations() {
        let q = new_shared_queue();
        enqueue(&q, p("first")); enqueue(&q, p("second"));
        let mut source = HostSource::new(q.clone(), folder_policy(&["auto"]));
        source.next(); assert_eq!(snapshot(&q).len(), 2);
        source.next(); assert_eq!(snapshot(&q).len(), 2);
        source.next(); assert_eq!(snapshot(&q).len(), 3);
        assert_eq!(snapshot(&q)[2].origin, QueueOrigin::Automatic);
        enqueue(&q, p("manual"));
        assert_eq!(source.next(), Some((3, p("manual"))));
        assert_eq!(snapshot(&q).len(), 4);
    }

    #[test]
    fn cancellation_releases_occurrence_without_adding_it_again() {
        let q = new_shared_queue(); enqueue(&q, p("a"));
        let item = snapshot(&q)[0].clone();
        let mut source = HostSource::new(q.clone(), empty_policy());
        source.next(); assert!(discard_reserved(&q, &item));
        assert_eq!(source.next(), Some((1, p("a"))));
        assert_eq!(snapshot(&q), vec![item]);
    }

    #[test]
    fn restore_preserves_identity_and_resets_reservations_and_rejections() {
        let q = new_shared_queue(); enqueue(&q, p("a"));
        let before = snapshot(&q);
        let mut source = HostSource::new(q.clone(), empty_policy());
        source.next(); block_reserved(&q, &before[0]);
        restore_all(&q, before.clone());
        assert_eq!(snapshot(&q), before);
        assert_eq!(source.next(), Some((1, p("a"))));
    }

    #[test]
    fn persisted_reservations_survive_restart_until_playback_or_user_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let queue = new_shared_queue();
        enqueue(&queue, p("same")); enqueue(&queue, p("same"));
        let expected = snapshot(&queue);
        let mut source = HostSource::new(queue.clone(), folder_policy(&["auto"]));
        assert_eq!(source.next(), Some((0, p("same"))));
        assert_eq!(source.next(), Some((1, p("same"))));
        assert_eq!(source.next(), Some((2, p("auto"))));
        let with_auto = snapshot(&queue);
        assert_eq!(with_auto.len(), 3);
        assert_eq!(&with_auto[..2], expected.as_slice());
        crate::store::save_queue(dir.path(), &with_auto.iter().cloned().collect::<VecDeque<_>>()).unwrap();
        let saved = crate::store::load_queue(dir.path()).unwrap();
        let restored = crate::store::restored_pending(&with_auto, &saved);
        assert_eq!(restored, with_auto, "reservation must not duplicate or retire membership");

        let restarted = new_shared_queue();
        restore_all(&restarted, restored);
        let mut source = HostSource::new(restarted.clone(), empty_policy());
        assert_eq!(source.next(), Some((0, p("same"))));
        assert_eq!(snapshot(&restarted), with_auto);
        assert!(mark_started(&restarted, &expected[0]));
        assert_eq!(snapshot(&restarted), with_auto[1..].to_vec());
        edit_displayed(&restarted, QueueEdit::Remove { index: 0 }, &expected[1], || Some(p("same"))).unwrap();
        assert_eq!(snapshot(&restarted), vec![with_auto[2].clone()]);
    }

    #[test]
    fn serde_persists_ids_and_assigns_distinct_legacy_occurrences() {
        let legacy = r#"{"path":"same","origin":"manual"}"#;
        let first: QueueItem = serde_json::from_str(legacy).unwrap();
        let second: QueueItem = serde_json::from_str(legacy).unwrap();
        assert_ne!(first.entry_id, second.entry_id);
        let encoded = serde_json::to_string(&first).unwrap();
        assert_eq!(serde_json::from_str::<QueueItem>(&encoded).unwrap(), first);
    }

    #[test]
    fn edits_check_identity_bounds_priority_and_preserve_membership_on_move() {
        let q = new_shared_queue(); enqueue(&q, p("a")); enqueue(&q, p("a"));
        let before = snapshot(&q);
        assert_eq!(edit_displayed(&q, QueueEdit::Remove { index: 0 }, &before[1], || panic!()), Err(EditError::Stale));
        assert_eq!(edit_displayed(&q, QueueEdit::Remove { index: 2 }, &before[0], || panic!()), Err(EditError::OutOfRange));
        edit_displayed(&q, QueueEdit::Move { from: 0, to: 1 }, &before[0], || panic!()).unwrap();
        assert_eq!(snapshot(&q), vec![before[1].clone(), before[0].clone()]);
        edit_displayed(&q, QueueEdit::Remove { index: 1 }, &before[0], || panic!()).unwrap();
        assert_eq!(snapshot(&q), vec![before[1].clone()]);
        let auto = QueueItem::automatic(p("auto"));
        replace_pending(&q, vec![before[1].clone(), auto]);
        assert_eq!(edit_displayed(&q, QueueEdit::Move { from: 0, to: 1 }, &before[1], || panic!()), Err(EditError::OriginBoundary));
    }

    #[test]
    fn reserved_edit_requires_successful_revoke_without_duplicating_rows() {
        let q = new_shared_queue(); enqueue(&q, p("a")); enqueue(&q, p("b"));
        let before = snapshot(&q);
        let mut source = HostSource::new(q.clone(), empty_policy()); source.next();
        assert_eq!(edit_displayed(&q, QueueEdit::Remove { index: 0 }, &before[0], || None), Err(EditError::TooLate));
        assert_eq!(snapshot(&q), before);
        edit_displayed(&q, QueueEdit::Move { from: 0, to: 1 }, &before[0], || Some(p("a"))).unwrap();
        assert_eq!(snapshot(&q), vec![before[1].clone(), before[0].clone()]);
    }

    #[test]
    fn filtered_insert_excludes_existing_and_active_paths_and_keeps_manual_priority() {
        let q = new_shared_queue();
        let auto = QueueItem::automatic(p("auto"));
        replace_pending(&q, vec![auto.clone()]);
        let flight = QueueItem::manual(p("flight"));
        assert_eq!(prepend_pending_filtered(&q, &[p("auto"), p("now"), p("flight"), p("new"), p("new")], Some(Path::new("now")), &[flight]), 1);
        let items = snapshot(&q);
        assert_eq!(items.iter().map(|item| item.path.clone()).collect::<Vec<_>>(), vec![p("new"), p("auto")]);
        assert_eq!(items[1], auto);
        assert_eq!(prepend_pending_filtered(&q, &[p("new")], None, &[]), 0);
    }

    #[test]
    fn manual_priority_releases_auto_reservation_without_duplicate_or_new_identity() {
        let q = new_shared_queue();
        let mut source = HostSource::new(q.clone(), folder_policy(&["auto"]));
        source.next();
        let auto = reserved_item(&q).unwrap();
        enqueue(&q, p("manual"));
        assert!(manual_priority_needed(&q));
        assert_eq!(prioritize_manual(&q, || Some(p("auto"))), Some(auto.clone()));
        assert_eq!(snapshot(&q)[1], auto);
        assert_eq!(source.next(), Some((1, p("manual"))));
        assert_eq!(snapshot(&q).len(), 2);
    }

    #[test]
    fn observers_report_reservations_and_only_actual_automatic_additions() {
        let q = new_shared_queue(); enqueue(&q, p("manual"));
        let added = Arc::new(Mutex::new(Vec::new()));
        let reserved = Arc::new(Mutex::new(Vec::new()));
        let added_sink = added.clone(); let reserved_sink = reserved.clone();
        let mut source = HostSource::new(q.clone(), folder_policy(&["auto"]))
            .on_pending_consumed(Box::new(move |items| added_sink.lock().unwrap().push(items.len())))
            .on_reserved(Box::new(move |item| reserved_sink.lock().unwrap().push(item.path.clone())));
        source.next(); source.next();
        assert_eq!(*added.lock().unwrap(), vec![2]);
        assert_eq!(*reserved.lock().unwrap(), vec![p("manual"), p("auto")]);
    }

}
