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

/// Move the item at `from` to `to` (both 0-based positions in the pending
/// queue as it stands right now). Does not touch `reserved`: once
/// `HostSource::next` has taken an item out of the pending queue for
/// preparation, it moves to `reserved` and is no longer reachable here.
///
/// Errors (queue left unchanged) if either index is out of range.
pub fn reorder(queue: &SharedQueue, from: usize, to: usize) -> Result<(), String> {
    let mut q = queue.lock().unwrap();
    let len = q.pending.len();
    if from >= len || to >= len {
        return Err(format!(
            "reorder index out of range: len={len}, from={from}, to={to}"
        ));
    }
    if from == to {
        return Ok(());
    }
    let item = q.pending.remove(from).expect("from checked above");
    q.pending.insert(to, item);
    Ok(())
}

/// Remove and return the item at `index` from the pending queue.
///
/// Errors if `index` is out of range (including an empty queue).
pub fn dequeue(queue: &SharedQueue, index: usize) -> Result<PathBuf, String> {
    let mut q = queue.lock().unwrap();
    let len = q.pending.len();
    q.pending
        .remove(index)
        .ok_or_else(|| format!("dequeue index out of range: len={len}, index={index}"))
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
}

impl HostSource {
    pub fn new(queue: SharedQueue, policy: DrainPolicy) -> Self {
        Self {
            queue,
            policy,
            calls: 0,
            on_pending_consumed: None,
            on_reserved: None,
        }
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
    /// released, so it may block (the loader already decodes whole tracks);
    /// it must not lock the queue itself, and the slice it is given is a
    /// snapshot that a concurrent command may already have moved past.
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
}

impl TrackSource for HostSource {
    fn next(&mut self) -> Option<(usize, PathBuf)> {
        let mut q = self.queue.lock().unwrap();
        let mut consumed_pending = true;
        let path = match q.pending.pop_front() {
            Some(path) => path,
            None => match &mut self.policy {
                DrainPolicy::ContinueFolder { tracks, pos } => {
                    consumed_pending = false;
                    if tracks.is_empty() {
                        q.reserved = None;
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
                    let path = tracks[*pos].clone();
                    *pos = (*pos + 1) % tracks.len();
                    path
                }
            },
        };
        q.reserved = Some(path.clone());
        // Snapshot under the lock, notify without it: the observer writes to
        // disk, and the queue's mutex is also taken by Tauri commands.
        let remaining: Option<Vec<PathBuf>> =
            consumed_pending.then(|| q.pending.iter().cloned().collect());
        drop(q);
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

    #[test]
    fn reorder_moves_item_forward_and_backward() {
        let q = new_shared_queue();
        for name in ["a", "b", "c", "d"] {
            enqueue(&q, p(name));
        }
        // Move "a" (index 0) to the end.
        reorder(&q, 0, 3).unwrap();
        assert_eq!(snapshot(&q), vec![p("b"), p("c"), p("d"), p("a")]);
        // Move it back to the front.
        reorder(&q, 3, 0).unwrap();
        assert_eq!(snapshot(&q), vec![p("a"), p("b"), p("c"), p("d")]);
    }

    #[test]
    fn reorder_same_index_is_a_noop() {
        let q = new_shared_queue();
        for name in ["a", "b"] {
            enqueue(&q, p(name));
        }
        reorder(&q, 1, 1).unwrap();
        assert_eq!(snapshot(&q), vec![p("a"), p("b")]);
    }

    #[test]
    fn reorder_out_of_range_errors_and_leaves_queue_untouched() {
        let q = new_shared_queue();
        for name in ["a", "b"] {
            enqueue(&q, p(name));
        }
        assert!(reorder(&q, 0, 2).is_err());
        assert!(reorder(&q, 2, 0).is_err());
        assert_eq!(snapshot(&q), vec![p("a"), p("b")]);
    }

    #[test]
    fn reorder_on_empty_queue_errors() {
        let q = new_shared_queue();
        assert!(reorder(&q, 0, 0).is_err());
    }

    #[test]
    fn dequeue_removes_the_right_item() {
        let q = new_shared_queue();
        for name in ["a", "b", "c"] {
            enqueue(&q, p(name));
        }
        assert_eq!(dequeue(&q, 1).unwrap(), p("b"));
        assert_eq!(snapshot(&q), vec![p("a"), p("c")]);
    }

    #[test]
    fn dequeue_out_of_range_errors_and_leaves_queue_untouched() {
        let q = new_shared_queue();
        enqueue(&q, p("a"));
        assert!(dequeue(&q, 1).is_err());
        assert!(dequeue(&q, 99).is_err());
        assert_eq!(snapshot(&q), vec![p("a")]);
    }

    #[test]
    fn dequeue_on_empty_queue_errors() {
        let q = new_shared_queue();
        assert!(dequeue(&q, 0).is_err());
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
    fn reorder_and_dequeue_do_not_require_a_running_source() {
        // Sanity check that the plain queue functions work with no
        // `HostSource` involved at all, matching how Tauri commands would use
        // them (a `SharedQueue` handed around independently of the engine).
        let q = new_shared_queue();
        enqueue(&q, p("a"));
        enqueue(&q, p("b"));
        enqueue(&q, p("c"));
        reorder(&q, 2, 0).unwrap();
        assert_eq!(dequeue(&q, 1).unwrap(), p("a"));
        assert_eq!(snapshot(&q), vec![p("c"), p("b")]);
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
    fn pending_queue_mutations_do_not_affect_reserved() {
        let q = new_shared_queue();
        enqueue(&q, p("a"));
        let mut source = HostSource::new(Arc::clone(&q), empty_policy());
        assert_eq!(source.next(), Some((0, p("a"))));
        assert_eq!(reserved(&q), Some(p("a")));

        enqueue(&q, p("b"));
        enqueue(&q, p("c"));
        reorder(&q, 0, 1).unwrap();
        dequeue(&q, 0).unwrap();

        assert_eq!(reserved(&q), Some(p("a")));
        assert_eq!(state_snapshot(&q).0, Some(p("a")));
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
}
