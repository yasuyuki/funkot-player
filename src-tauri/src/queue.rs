//! Host-owned playback queue: the shared queue state the plan calls for, plus
//! the `TrackSource` that lets `Engine::new_with_source` read from it.
//!
//! # Threading
//!
//! `HostSource::next` is called only from the engine's dedicated
//! `funkot-loader` thread (`funkot_core::engine::loader_main`), never from the
//! audio (cpal) callback: the callback only ever calls `Engine::render`, which
//! drains an internal channel the loader thread feeds. That makes locking the
//! queue's `Mutex` here safe under the "never block the audio callback" rule —
//! see `funkot-core/src/engine.rs::loader_main` (spawned in
//! `Engine::new_with_source`) for the call site.
//!
//! # What this does *not* decide
//!
//! Per `TrackSource`'s contract (`funkot-core/src/engine.rs`), `next`
//! returning `None` ends the playlist for good: the loader thread exits and
//! sets the engine's `loader_exhausted` latch, which nothing can clear
//! afterwards (see `funkot-core/src/engine.rs:1409` and `:1944`). Since this
//! app is used for continuous BGM playback, that's not acceptable, so
//! `HostSource` never returns `None` while there is anything left to play at
//! all — see [`DrainPolicy`] for what it falls back to once the host-managed
//! queue drains. `next` only returns `None` when both the queue and the
//! fallback source are exhausted.
//!
//! # Lock ordering
//!
//! The fixed order across this codebase is **`INDEX_LOCK` → `SAVE_LOCK` →
//! `SESSION` → queue → render**, never the reverse. `INDEX_LOCK` and
//! `SAVE_LOCK` / `SESSION` live in `src-tauri/src/lib.rs`. `SESSION` is the
//! restart-persistence counterpart to this module's queue; it only ever
//! nests under `SAVE_LOCK` inside `persist_session`, and never nests with
//! this module's queue lock at all — the two are independent saves that
//! happen to share `SAVE_LOCK`'s ordering slot, not a real dependency.
//! The other nestings here are real, not hypothetical:
//! [`edit_displayed`] takes the engine's `RenderState` lock (`render` in
//! `src-tauri/src/lib.rs`) via its `revoke` closure while already holding this
//! module's queue lock, and both `persist_queue` and the
//! [`HostSource::on_pending_consumed`] observer read the queue while already holding
//! `SAVE_LOCK` (`src-tauri/src/lib.rs`).
//!
//! Nothing takes them the other way round, which is what keeps this
//! acyclic: the loader thread (`next`, above) only ever takes the queue lock,
//! and the cpal audio callback only ever takes the render lock (with
//! `try_lock`, so it cannot block on this module at all). Keep it that way —
//! taking the queue lock and then reaching for `SAVE_LOCK` / `INDEX_LOCK`, or
//! taking `render` and then reaching for the queue lock, is what would close
//! the cycle.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use funkot_core::engine::TrackSource;

/// Shared, lock-protected queue state: the host-managed pending queue plus
/// the most recently reserved (handed to the engine for preparation) track.
///
/// Both fields live behind the same `Mutex` so a reader can take a
/// consistent snapshot of "what's playing next" and "what's queued after
/// that" with a single lock acquisition.
pub struct QueueState {
    pending: VecDeque<PathBuf>,
    reserved: Option<PathBuf>,
}

/// Shared handle to the host-owned queue. Cheap to clone; every clone points
/// at the same underlying [`QueueState`].
pub type SharedQueue = Arc<Mutex<QueueState>>;

/// A fresh, empty queue with nothing reserved.
pub fn new_shared_queue() -> SharedQueue {
    Arc::new(Mutex::new(QueueState {
        pending: VecDeque::new(),
        reserved: None,
    }))
}

/// Append `path` to the tail of the pending queue. Returns the pending
/// queue's length after the insert.
pub fn enqueue(queue: &SharedQueue, path: PathBuf) -> usize {
    let mut q = queue.lock().unwrap();
    q.pending.push_back(path);
    q.pending.len()
}

/// Replace the whole pending queue with `paths`, leaving `reserved` alone.
///
/// This is how the persisted queue is restored, and it must replace rather
/// than append: `queue.json` is a mirror of the pending queue that every
/// mutating command rewrites, so anything already queued in this process is
/// *also* in the file. Appending would therefore duplicate every entry the
/// user queued before pressing start.
pub fn replace_pending(queue: &SharedQueue, paths: Vec<PathBuf>) {
    let mut q = queue.lock().unwrap();
    q.pending = paths.into();
}

/// An edit to the list the UI actually displays: `reserved` (if any) followed
/// by `pending`, as one 0-based sequence. Index `0` is `reserved` when it is
/// present; otherwise the list is just `pending` and indices line up with it
/// directly. This mirrors what `queue_state`'s `QueueSnapshot`
/// (`src-tauri/src/lib.rs`) hands the frontend, so a UI index can be passed
/// straight through to [`edit_displayed`] with no translation of its own.
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
}

impl EditError {
    pub fn as_str(&self) -> &'static str {
        match self {
            EditError::TooLate => "too_late",
            EditError::Stale => "stale",
            EditError::OutOfRange => "out_of_range",
        }
    }
}

impl std::fmt::Display for EditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Apply `edit` to the displayed list (`[reserved?] ++ pending`), swapping
/// the reserved slot back into `pending` first if the edit reaches into it.
///
/// # Why this takes `queue.lock()` once and never lets go
///
/// `revoke` (the caller passes `Engine::revoke_next`, wrapped) frees a loader
/// permit the moment it succeeds, and the loader thread is parked waiting on
/// exactly that permit inside [`HostSource::next`] — which takes this same
/// `SharedQueue`'s lock. If this function released the lock between calling
/// `revoke` and pushing the revoked path back onto `pending`, the loader
/// could win the race, `pop_front` the queue's current head (the very item
/// this edit is about to move or remove), and reserve it again before the
/// edit below ever runs. That is not a rare interleaving to guard against —
/// on a single-core-scheduled or just unlucky run it is the *likely* outcome
/// for any edit that touches `reserved`, since revoking is exactly what
/// unblocks the loader. So every step — the `expect` check, the reserved
/// hand-back, and the index-shifted `pending` mutation — happens under one
/// `MutexGuard` that is held for the whole call.
///
/// # Why `expect` is checked before `revoke` runs
///
/// A stale tap (the UI's last-known list is older than the one on screen
/// right now) must not discard a track the engine has already buffered for
/// nothing: `revoke_next` (`funkot-core/src/engine.rs`) permanently gives up
/// the prepared track's engine-side state, and there is no way to hand it
/// back other than re-queuing the path and letting the loader redo the work
/// from scratch. Checking staleness first means a stale tap costs nothing.
///
/// # What counts as "touches reserved"
///
/// `reserved.is_some()` and the edit's `from`, `to`, or `index` is `0` —
/// including `Move { to: 0, .. }`: moving some other item to the front
/// displaces `reserved` from that slot just as surely as moving `reserved`
/// itself would, so it needs the exact same hand-back.
///
/// # Errors
///
/// Returns [`EditError::OutOfRange`] if any index in `edit` is outside the
/// displayed list, [`EditError::Stale`] if the path at the edit's subject
/// index does not match `expect`, or [`EditError::TooLate`] if the edit
/// touches `reserved` and `revoke` returns `None`. In every error case the
/// queue (`reserved` and `pending` both) is left completely unchanged.
pub fn edit_displayed(
    queue: &SharedQueue,
    edit: QueueEdit,
    expect: &Path,
    revoke: impl FnOnce() -> Option<PathBuf>,
) -> Result<(), EditError> {
    let mut q = queue.lock().unwrap();

    let has_reserved = q.reserved.is_some();
    let len = q.pending.len() + usize::from(has_reserved);

    // The edit's "subject" is the index whose path must match `expect`:
    // `Move::from` (where the item is coming *from*) or `Remove::index`.
    // `Move::to` has no path of its own to check — it is just a destination
    // — but still has to be in bounds.
    let subject = match edit {
        QueueEdit::Move { from, to } => {
            if from >= len || to >= len {
                return Err(EditError::OutOfRange);
            }
            from
        }
        QueueEdit::Remove { index } => {
            if index >= len {
                return Err(EditError::OutOfRange);
            }
            index
        }
    };

    let subject_path: Option<&Path> = if has_reserved {
        if subject == 0 {
            q.reserved.as_deref()
        } else {
            q.pending.get(subject - 1).map(PathBuf::as_path)
        }
    } else {
        q.pending.get(subject).map(PathBuf::as_path)
    };
    if subject_path != Some(expect) {
        return Err(EditError::Stale);
    }

    // A `Move` to its own position changes nothing. Bail out before the
    // `touches_reserved` check below so a no-op `from == to` (e.g. a UI tap
    // that already landed, or `to == 0` on a track already at the front)
    // cannot trigger a `revoke`: that would discard the engine's prepared
    // track for a rearrangement that was never going to happen.
    if let QueueEdit::Move { from, to } = edit {
        if from == to {
            return Ok(());
        }
    }

    let touches_reserved = has_reserved
        && match edit {
            QueueEdit::Move { from, to } => from == 0 || to == 0,
            QueueEdit::Remove { index } => index == 0,
        };

    if touches_reserved {
        match revoke() {
            Some(path) => {
                // The engine's next-track slot and this module's `reserved`
                // are supposed to mirror each other, so this should always
                // match; if it doesn't, trust what the engine actually had
                // and just note the mismatch rather than losing the track.
                if q.reserved.as_deref() != Some(path.as_path()) {
                    log::warn!(
                        "edit_displayed: revoke returned {}, but reserved was {:?}",
                        path.display(),
                        q.reserved,
                    );
                }
                q.reserved = None;
                q.pending.push_front(path);
            }
            None => return Err(EditError::TooLate),
        }
    }

    // Once `reserved` has been folded into `pending` above (or was never
    // there), the displayed list and `pending` are the exact same sequence,
    // so the edit's indices apply to `pending` unshifted. The one case left
    // needing a shift is an edit that never touched `reserved`: `pending`
    // still excludes it, so a displayed index one past `reserved` is
    // `pending`'s index `0`.
    let pending_index = |i: usize| if has_reserved && !touches_reserved { i - 1 } else { i };
    match edit {
        QueueEdit::Move { from, to } => {
            let from = pending_index(from);
            let to = pending_index(to);
            if from != to {
                let item = q.pending.remove(from).expect("from checked above");
                q.pending.insert(to, item);
            }
        }
        QueueEdit::Remove { index } => {
            let index = pending_index(index);
            q.pending.remove(index);
        }
    }

    Ok(())
}

/// Snapshot of the pending queue's current contents, for `state()`.
pub fn snapshot(queue: &SharedQueue) -> Vec<PathBuf> {
    queue.lock().unwrap().pending.iter().cloned().collect()
}

/// `(reserved, pending)` read under a single lock acquisition, so callers get
/// a consistent view instead of two snapshots that could straddle a `next()`
/// call.
pub fn state_snapshot(queue: &SharedQueue) -> (Option<PathBuf>, Vec<PathBuf>) {
    let q = queue.lock().unwrap();
    (q.reserved.clone(), q.pending.iter().cloned().collect())
}

/// What to play once the host-managed pending queue runs dry.
pub enum DrainPolicy {
    /// BGM use case: keep cycling through the source folder's tracks in
    /// order, wrapping back to the start once the end is reached.
    ContinueFolder { tracks: Vec<PathBuf>, pos: usize },
}

/// Called with the pending queue's remaining contents each time [`HostSource`]
/// takes an entry out of it. See [`HostSource::on_pending_consumed`].
pub type PendingObserver = Box<dyn FnMut(&[PathBuf]) + Send>;

/// Called with the track [`HostSource::next`] is about to hand back, every
/// time it is called, regardless of whether the track came from the pending
/// queue or the folder-drain fallback. See [`HostSource::on_reserved`].
pub type ReservedObserver = Box<dyn FnMut(&Path) + Send>;

/// Called with the folder-drain cursor (`DrainPolicy::ContinueFolder.pos`,
/// next 0-based index to pick) each time [`HostSource::pick_folder_track`]
/// returns a path. Not called for pending-queue pops. See
/// [`HostSource::on_folder_pos`].
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

    /// Run `observer` whenever `next` removes an entry from the pending queue,
    /// passing what is left of it.
    ///
    /// Playback is the one way the pending queue shrinks without a command
    /// being involved, so without this the host's on-disk copy would keep
    /// listing tracks that have already been played and hand them back at the
    /// next start.
    ///
    /// The observer runs on the engine's loader thread with the queue's lock
    /// released, so it may block (the loader already decodes whole tracks)
    /// and may take the queue lock itself. The slice it is handed is only a
    /// snapshot from pop time, which a concurrent command may already have
    /// moved past — the host's observer therefore treats it as a signal that
    /// a pop happened and re-reads `pending` itself rather than persisting
    /// the captured value (see `audio_thread` in `src-tauri/src/lib.rs`).
    ///
    /// An observer that does take the queue lock must not already hold a lock
    /// that anything else takes *after* the queue lock, or the two orders can
    /// deadlock. The host's `SAVE_LOCK` is fine: the fixed order there is
    /// `INDEX_LOCK` → `SAVE_LOCK` → queue → render, and nothing takes the
    /// queue lock and then reaches for `SAVE_LOCK` / `INDEX_LOCK`.
    ///
    /// Not called when the queue was empty and [`DrainPolicy`] supplied the
    /// track: nothing was consumed, so there is nothing new to report.
    pub fn on_pending_consumed(mut self, observer: PendingObserver) -> Self {
        self.on_pending_consumed = Some(observer);
        self
    }

    /// Run `observer` with the path `next` is about to hand back, every call,
    /// whether it came from the pending queue or the folder-drain fallback.
    ///
    /// Unlike [`Self::on_pending_consumed`], this fires unconditionally: it
    /// is the one hook that sees *every* track the loader is about to
    /// prepare, which is what makes it useful for logging "here is what the
    /// loader is about to do and whether its analysis cache is warm" ahead of
    /// a stall, rather than only for tracks that happened to come through the
    /// host queue.
    ///
    /// Same threading rule as `on_pending_consumed`: runs on the loader
    /// thread with the queue's lock released, so it may block but must not
    /// lock the queue itself.
    pub fn on_reserved(mut self, observer: ReservedObserver) -> Self {
        self.on_reserved = Some(observer);
        self
    }

    /// Run `observer` with the folder-drain cursor after
    /// [`Self::pick_folder_track`] returns a path. `pos` is the next
    /// 0-based index the policy will consider (already advanced past the
    /// path just picked, including wrap).
    ///
    /// Not called when `next` took a track from the pending queue — the
    /// folder cursor did not move. Same threading rule as
    /// `on_pending_consumed` / `on_reserved`: loader thread, queue lock
    /// released.
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
        let (path, remaining) = {
            let mut q = self.queue.lock().unwrap();
            match q.pending.pop_front() {
                Some(path) => {
                    q.reserved = Some(path.clone());
                    let remaining = Some(q.pending.iter().cloned().collect::<Vec<_>>());
                    (path, remaining)
                }
                None => {
                    // Release before folder-skip I/O (cache / overrides): those
                    // can take milliseconds and must not stall enqueue/reorder.
                    drop(q);
                    let path = match Self::pick_folder_track(&mut self.policy, folder_skip) {
                        Some(path) => {
                            if let Some(observer) = self.on_folder_pos.as_mut() {
                                let DrainPolicy::ContinueFolder { pos, .. } = &self.policy;
                                observer(*pos);
                            }
                            path
                        }
                        None => {
                            let mut q = self.queue.lock().unwrap();
                            q.reserved = None;
                            return None;
                        }
                    };
                    let mut q = self.queue.lock().unwrap();
                    q.reserved = Some(path.clone());
                    (path, None)
                }
            }
        };
        if let (Some(remaining), Some(observer)) =
            (remaining, self.on_pending_consumed.as_mut())
        {
            observer(&remaining);
        }
        if let Some(observer) = self.on_reserved.as_mut() {
            observer(&path);
        }
        let index = self.calls;
        self.calls += 1;
        Some((index, path))
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

    fn p(name: &str) -> PathBuf {
        PathBuf::from(name)
    }

    /// The reserved track on its own. Production code always wants it
    /// together with `pending`, so `state_snapshot` is the only accessor;
    /// this just keeps the assertions below readable.
    fn reserved(queue: &SharedQueue) -> Option<PathBuf> {
        state_snapshot(queue).0
    }

    fn empty_policy() -> DrainPolicy {
        DrainPolicy::ContinueFolder {
            tracks: Vec::new(),
            pos: 0,
        }
    }

    fn folder_policy(names: &[&str]) -> DrainPolicy {
        DrainPolicy::ContinueFolder {
            tracks: names.iter().map(|n| p(n)).collect(),
            pos: 0,
        }
    }

    #[test]
    fn enqueue_appends_in_order() {
        let q = new_shared_queue();
        assert_eq!(enqueue(&q, p("a")), 1);
        assert_eq!(enqueue(&q, p("b")), 2);
        assert_eq!(enqueue(&q, p("c")), 3);
        assert_eq!(snapshot(&q), vec![p("a"), p("b"), p("c")]);
    }

    #[test]
    fn replace_pending_overwrites_instead_of_appending() {
        let q = new_shared_queue();
        for name in ["a", "b"] {
            enqueue(&q, p(name));
        }
        // What start() does with queue.json, whose contents mirror what is
        // already queued here. Appending would give a, b, a, b.
        replace_pending(&q, vec![p("a"), p("b")]);
        assert_eq!(snapshot(&q), vec![p("a"), p("b")]);
    }

    #[test]
    fn replace_pending_leaves_the_reserved_track_alone() {
        let q = new_shared_queue();
        enqueue(&q, p("a"));
        let mut source = HostSource::new(Arc::clone(&q), empty_policy());
        assert_eq!(source.next(), Some((0, p("a"))));
        assert_eq!(reserved(&q), Some(p("a")));

        replace_pending(&q, vec![p("b")]);
        assert_eq!(reserved(&q), Some(p("a")));
        assert_eq!(snapshot(&q), vec![p("b")]);
    }

    /// A `revoke` that panics if it runs. Used by tests below whose whole
    /// point is that a particular edit must *not* reach into `reserved` --
    /// with this, a wrongly-touched slot fails loudly instead of the test
    /// just happening to still pass.
    fn panic_revoke() -> Option<PathBuf> {
        panic!("revoke should not run: this edit does not touch reserved")
    }

    #[test]
    fn edit_displayed_moves_an_item_forward_and_backward_without_reserved() {
        let q = new_shared_queue();
        for name in ["a", "b", "c", "d"] {
            enqueue(&q, p(name));
        }
        // Move "a" (index 0) to the end.
        edit_displayed(&q, QueueEdit::Move { from: 0, to: 3 }, &p("a"), panic_revoke).unwrap();
        assert_eq!(snapshot(&q), vec![p("b"), p("c"), p("d"), p("a")]);
        // Move it back to the front.
        edit_displayed(&q, QueueEdit::Move { from: 3, to: 0 }, &p("a"), panic_revoke).unwrap();
        assert_eq!(snapshot(&q), vec![p("a"), p("b"), p("c"), p("d")]);
    }

    #[test]
    fn edit_displayed_move_out_of_range_without_reserved_leaves_queue_untouched() {
        let q = new_shared_queue();
        for name in ["a", "b"] {
            enqueue(&q, p(name));
        }
        assert_eq!(
            edit_displayed(&q, QueueEdit::Move { from: 0, to: 2 }, &p("a"), panic_revoke),
            Err(EditError::OutOfRange)
        );
        assert_eq!(
            edit_displayed(&q, QueueEdit::Move { from: 2, to: 0 }, &p("a"), panic_revoke),
            Err(EditError::OutOfRange)
        );
        assert_eq!(snapshot(&q), vec![p("a"), p("b")]);
    }

    #[test]
    fn edit_displayed_dequeue_out_of_range_without_reserved_leaves_queue_untouched() {
        let q = new_shared_queue();
        enqueue(&q, p("a"));
        assert_eq!(
            edit_displayed(&q, QueueEdit::Remove { index: 1 }, &p("a"), panic_revoke),
            Err(EditError::OutOfRange)
        );
        assert_eq!(
            edit_displayed(&q, QueueEdit::Remove { index: 99 }, &p("a"), panic_revoke),
            Err(EditError::OutOfRange)
        );
        assert_eq!(snapshot(&q), vec![p("a")]);
    }

    #[test]
    fn edit_displayed_on_an_empty_queue_is_out_of_range() {
        let q = new_shared_queue();
        // `expect` is irrelevant here -- both edits fail the bounds check
        // (len 0) before any path is ever compared against it.
        assert_eq!(
            edit_displayed(&q, QueueEdit::Move { from: 0, to: 0 }, &p("x"), panic_revoke),
            Err(EditError::OutOfRange)
        );
        assert_eq!(
            edit_displayed(&q, QueueEdit::Remove { index: 0 }, &p("x"), panic_revoke),
            Err(EditError::OutOfRange)
        );
    }

    #[test]
    fn edit_displayed_does_not_require_a_running_source() {
        // Sanity check that `edit_displayed` works with no reserved track and
        // no `HostSource` involved at all, matching how the Tauri commands
        // use it (a `SharedQueue` handed around independently of the
        // engine) before anything has been reserved yet.
        let q = new_shared_queue();
        enqueue(&q, p("a"));
        enqueue(&q, p("b"));
        enqueue(&q, p("c"));
        edit_displayed(&q, QueueEdit::Move { from: 2, to: 0 }, &p("c"), panic_revoke).unwrap();
        edit_displayed(&q, QueueEdit::Remove { index: 1 }, &p("a"), panic_revoke).unwrap();
        assert_eq!(snapshot(&q), vec![p("c"), p("b")]);
    }

    #[test]
    fn host_source_pops_front_in_fifo_order() {
        let q = new_shared_queue();
        for name in ["a", "b", "c"] {
            enqueue(&q, p(name));
        }
        let mut source = HostSource::new(Arc::clone(&q), empty_policy());
        assert_eq!(source.next(), Some((0, p("a"))));
        assert_eq!(source.next(), Some((1, p("b"))));
        assert_eq!(source.next(), Some((2, p("c"))));
        assert_eq!(snapshot(&q), Vec::<PathBuf>::new());
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
    fn host_source_falls_back_to_folder_when_queue_drains() {
        let q = new_shared_queue();
        let mut source = HostSource::new(q, folder_policy(&["f1", "f2", "f3"]));
        assert_eq!(source.next(), Some((0, p("f1"))));
        assert_eq!(source.next(), Some((1, p("f2"))));
        assert_eq!(source.next(), Some((2, p("f3"))));
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
    fn host_source_folder_exhausts_when_all_entries_skipped() {
        let q = new_shared_queue();
        let mut source = HostSource::new(Arc::clone(&q), folder_policy(&["a", "b"]))
            .skip_folder_entry(Box::new(|_| true));
        assert_eq!(source.next(), None);
        assert_eq!(reserved(&q), None);
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
    fn reserved_reflects_the_most_recently_handed_out_track() {
        let q = new_shared_queue();
        assert_eq!(reserved(&q), None);
        enqueue(&q, p("a"));
        let mut source = HostSource::new(Arc::clone(&q), empty_policy());
        assert_eq!(source.next(), Some((0, p("a"))));
        assert_eq!(reserved(&q), Some(p("a")));
    }

    #[test]
    fn edits_that_do_not_touch_reserved_do_not_revoke_it() {
        let q = new_shared_queue();
        enqueue(&q, p("a"));
        let mut source = HostSource::new(Arc::clone(&q), empty_policy());
        assert_eq!(source.next(), Some((0, p("a"))));
        assert_eq!(reserved(&q), Some(p("a")));

        enqueue(&q, p("b"));
        enqueue(&q, p("c"));
        // Displayed list is [a(reserved), b, c]; neither edit's `from`/`to`/
        // `index` is 0, so per `edit_displayed`'s "touches reserved" rule
        // neither should revoke `reserved` -- this is the design's central
        // invariant. `panic_revoke` makes that assertion load-bearing: if
        // either edit wrongly reached into the reserved slot, the test
        // panics instead of quietly passing.
        edit_displayed(&q, QueueEdit::Move { from: 1, to: 2 }, &p("b"), panic_revoke).unwrap();
        edit_displayed(&q, QueueEdit::Remove { index: 1 }, &p("c"), panic_revoke).unwrap();

        assert_eq!(reserved(&q), Some(p("a")));
        assert_eq!(state_snapshot(&q), (Some(p("a")), vec![p("b")]));
    }

    /// Collects what the observer is handed, standing in for `queue.json`.
    fn recording_observer() -> (Arc<Mutex<Vec<Vec<PathBuf>>>>, PendingObserver) {
        let seen: Arc<Mutex<Vec<Vec<PathBuf>>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        (
            seen,
            Box::new(move |pending: &[PathBuf]| {
                sink.lock().unwrap().push(pending.to_vec());
            }),
        )
    }

    #[test]
    fn playing_a_queued_track_reports_what_is_left() {
        let q = new_shared_queue();
        for name in ["a", "b", "c"] {
            enqueue(&q, p(name));
        }
        let (seen, observer) = recording_observer();
        let mut source =
            HostSource::new(Arc::clone(&q), empty_policy()).on_pending_consumed(observer);

        source.next();
        source.next();

        // Not [b, c] then [c]: the track handed to the engine is reserved, and
        // reserved is deliberately not part of what gets persisted -- it is
        // already gone as far as the queue is concerned.
        assert_eq!(
            *seen.lock().unwrap(),
            vec![vec![p("b"), p("c")], vec![p("c")]]
        );
    }

    #[test]
    fn falling_back_to_the_folder_reports_nothing() {
        let q = new_shared_queue();
        let (seen, observer) = recording_observer();
        let mut source =
            HostSource::new(Arc::clone(&q), folder_policy(&["f1", "f2"])).on_pending_consumed(observer);

        source.next();
        source.next();

        // The pending queue was empty throughout, so it never changed and
        // there is nothing to write out.
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn draining_the_queue_reports_it_empty_before_the_folder_takes_over() {
        let q = new_shared_queue();
        enqueue(&q, p("a"));
        let (seen, observer) = recording_observer();
        let mut source =
            HostSource::new(Arc::clone(&q), folder_policy(&["f1"])).on_pending_consumed(observer);

        source.next(); // takes "a", queue now empty
        source.next(); // falls back to the folder

        // The empty report is the one that matters: without it, restarting the
        // app would find "a" still listed and play it a second time.
        assert_eq!(*seen.lock().unwrap(), vec![Vec::<PathBuf>::new()]);
    }

    /// Collects what the `on_reserved` observer is handed.
    fn recording_reserved_observer() -> (Arc<Mutex<Vec<PathBuf>>>, ReservedObserver) {
        let seen: Arc<Mutex<Vec<PathBuf>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        (seen, Box::new(move |path: &Path| sink.lock().unwrap().push(path.to_path_buf())))
    }

    #[test]
    fn on_reserved_fires_for_tracks_from_the_pending_queue() {
        let q = new_shared_queue();
        for name in ["a", "b"] {
            enqueue(&q, p(name));
        }
        let (seen, observer) = recording_reserved_observer();
        let mut source = HostSource::new(Arc::clone(&q), empty_policy()).on_reserved(observer);

        source.next();
        source.next();

        assert_eq!(*seen.lock().unwrap(), vec![p("a"), p("b")]);
    }

    #[test]
    fn on_reserved_fires_for_tracks_from_the_folder_fallback() {
        let q = new_shared_queue();
        let (seen, observer) = recording_reserved_observer();
        let mut source =
            HostSource::new(q, folder_policy(&["f1", "f2"])).on_reserved(observer);

        source.next();
        source.next();

        assert_eq!(*seen.lock().unwrap(), vec![p("f1"), p("f2")]);
    }

    #[test]
    fn on_reserved_fires_regardless_of_which_source_a_track_came_from() {
        let q = new_shared_queue();
        enqueue(&q, p("priority"));
        let (seen, observer) = recording_reserved_observer();
        let mut source =
            HostSource::new(Arc::clone(&q), folder_policy(&["f1"])).on_reserved(observer);

        source.next(); // from the pending queue
        source.next(); // pending drained, falls back to the folder

        assert_eq!(*seen.lock().unwrap(), vec![p("priority"), p("f1")]);
    }

    fn recording_folder_pos_observer() -> (Arc<Mutex<Vec<usize>>>, FolderPosObserver) {
        let seen: Arc<Mutex<Vec<usize>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        (seen, Box::new(move |pos: usize| sink.lock().unwrap().push(pos)))
    }

    #[test]
    fn on_folder_pos_fires_for_folder_drain_including_wrap_not_for_pending() {
        let q = new_shared_queue();
        enqueue(&q, p("pending"));
        let (seen, observer) = recording_folder_pos_observer();
        let mut source =
            HostSource::new(Arc::clone(&q), folder_policy(&["f1", "f2", "f3"]))
                .on_folder_pos(observer);

        source.next(); // pending — folder cursor must not move
        assert!(seen.lock().unwrap().is_empty());

        source.next(); // f1 → pos 1
        source.next(); // f2 → pos 2
        source.next(); // f3 → pos 0 (wrap)
        assert_eq!(*seen.lock().unwrap(), vec![1, 2, 0]);
    }

    #[test]
    fn host_source_returns_none_and_clears_reserved_when_fully_exhausted() {
        let q = new_shared_queue();
        enqueue(&q, p("a"));
        let mut source = HostSource::new(Arc::clone(&q), empty_policy());
        assert_eq!(source.next(), Some((0, p("a"))));
        assert_eq!(reserved(&q), Some(p("a")));
        assert_eq!(source.next(), None);
        assert_eq!(reserved(&q), None);
    }

    /// Builds a queue with `reserved` and `pending` already set, bypassing
    /// `HostSource` entirely — `edit_displayed`'s tests only care about the
    /// displayed-list arithmetic, not how a track came to be reserved.
    fn queue_with(reserved: Option<&str>, pending: &[&str]) -> SharedQueue {
        Arc::new(Mutex::new(QueueState {
            pending: pending.iter().map(|n| p(n)).collect(),
            reserved: reserved.map(p),
        }))
    }

    /// A `revoke` closure that records whether it ran and always returns
    /// `answer`.
    fn revoke_stub(answer: Option<PathBuf>) -> (std::rc::Rc<std::cell::Cell<bool>>, impl FnOnce() -> Option<PathBuf>) {
        let called = std::rc::Rc::new(std::cell::Cell::new(false));
        let flag = std::rc::Rc::clone(&called);
        (called, move || {
            flag.set(true);
            answer
        })
    }

    #[test]
    fn edit_displayed_remove_reserved_slot_revokes_and_clears_reserved() {
        let q = queue_with(Some("r"), &["a", "b"]);
        let (called, revoke) = revoke_stub(Some(p("r")));

        edit_displayed(&q, QueueEdit::Remove { index: 0 }, &p("r"), revoke).unwrap();

        assert!(called.get());
        assert_eq!(state_snapshot(&q), (None, vec![p("a"), p("b")]));
    }

    #[test]
    fn edit_displayed_remove_reserved_with_empty_pending_leaves_an_empty_queue() {
        let q = queue_with(Some("r"), &[]);
        let (called, revoke) = revoke_stub(Some(p("r")));

        edit_displayed(&q, QueueEdit::Remove { index: 0 }, &p("r"), revoke).unwrap();

        assert!(called.get());
        assert_eq!(state_snapshot(&q), (None, Vec::<PathBuf>::new()));
    }

    #[test]
    fn edit_displayed_move_reserved_to_itself_is_a_noop_and_does_not_revoke() {
        let q = queue_with(Some("r"), &["a", "b"]);
        let (called, revoke) = revoke_stub(Some(p("r")));

        edit_displayed(&q, QueueEdit::Move { from: 0, to: 0 }, &p("r"), revoke).unwrap();

        assert!(!called.get());
        assert_eq!(state_snapshot(&q), (Some(p("r")), vec![p("a"), p("b")]));
    }

    #[test]
    fn edit_displayed_move_reserved_to_middle_revokes_then_reinserts_at_destination() {
        let q = queue_with(Some("r"), &["a", "b", "c"]);
        let (called, revoke) = revoke_stub(Some(p("r")));

        // Displayed list is [r, a, b, c]; moving index 0 to index 2 means the
        // revoked track is folded back to the front, then moved to slot 2.
        edit_displayed(&q, QueueEdit::Move { from: 0, to: 2 }, &p("r"), revoke).unwrap();

        assert!(called.get());
        assert_eq!(
            state_snapshot(&q),
            (None, vec![p("a"), p("b"), p("r"), p("c")])
        );
    }

    #[test]
    fn edit_displayed_move_into_reserved_slot_revokes_and_promotes_the_source_track() {
        let q = queue_with(Some("r"), &["a", "b", "c"]);
        let (called, revoke) = revoke_stub(Some(p("r")));

        // Displayed list is [r, a, b, c]; index 3 is "c". Moving it to 0
        // displaces reserved, which must be revoked and folded back in.
        edit_displayed(&q, QueueEdit::Move { from: 3, to: 0 }, &p("c"), revoke).unwrap();

        assert!(called.get());
        assert_eq!(
            state_snapshot(&q),
            (None, vec![p("c"), p("r"), p("a"), p("b")])
        );
    }

    #[test]
    fn edit_displayed_move_within_pending_does_not_revoke_reserved() {
        let q = queue_with(Some("r"), &["a", "b", "c"]);
        let (called, revoke) = revoke_stub(Some(p("r")));

        // Displayed indices 1, 2 are "a", "b" — neither is the reserved slot.
        edit_displayed(&q, QueueEdit::Move { from: 1, to: 2 }, &p("a"), revoke).unwrap();

        assert!(!called.get());
        assert_eq!(
            state_snapshot(&q),
            (Some(p("r")), vec![p("b"), p("a"), p("c")])
        );
    }

    #[test]
    fn edit_displayed_too_late_when_revoke_returns_none_and_leaves_queue_untouched() {
        let q = queue_with(Some("r"), &["a", "b"]);
        let (called, revoke) = revoke_stub(None);

        let err = edit_displayed(&q, QueueEdit::Remove { index: 0 }, &p("r"), revoke).unwrap_err();

        assert_eq!(err, EditError::TooLate);
        assert!(called.get());
        assert_eq!(state_snapshot(&q), (Some(p("r")), vec![p("a"), p("b")]));
    }

    #[test]
    fn edit_displayed_stale_expect_does_not_revoke_and_leaves_queue_untouched() {
        let q = queue_with(Some("r"), &["a", "b"]);
        let (called, revoke) = revoke_stub(Some(p("r")));

        let err =
            edit_displayed(&q, QueueEdit::Remove { index: 0 }, &p("stale"), revoke).unwrap_err();

        assert_eq!(err, EditError::Stale);
        assert!(!called.get());
        assert_eq!(state_snapshot(&q), (Some(p("r")), vec![p("a"), p("b")]));
    }

    #[test]
    fn edit_displayed_out_of_range_leaves_queue_untouched() {
        let q = queue_with(Some("r"), &["a", "b"]);
        // len is 3 (r, a, b): index 3 and to=3 are both one past the end.
        let (_, revoke) = revoke_stub(Some(p("r")));
        let err = edit_displayed(&q, QueueEdit::Remove { index: 3 }, &p("r"), revoke).unwrap_err();
        assert_eq!(err, EditError::OutOfRange);

        let (_, revoke) = revoke_stub(Some(p("r")));
        let err =
            edit_displayed(&q, QueueEdit::Move { from: 0, to: 3 }, &p("r"), revoke).unwrap_err();
        assert_eq!(err, EditError::OutOfRange);

        assert_eq!(state_snapshot(&q), (Some(p("r")), vec![p("a"), p("b")]));
    }

    #[test]
    fn edit_displayed_without_reserved_indexes_pending_directly() {
        let q = queue_with(None, &["a", "b", "c"]);
        let (called, revoke) = revoke_stub(Some(p("unused")));

        edit_displayed(&q, QueueEdit::Remove { index: 1 }, &p("b"), revoke).unwrap();

        assert!(!called.get());
        assert_eq!(state_snapshot(&q), (None, vec![p("a"), p("c")]));
    }
}
