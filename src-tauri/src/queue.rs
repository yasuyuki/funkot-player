//! Host-owned playback queue: the `Arc<Mutex<VecDeque<PathBuf>>>` the plan
//! calls for, plus the `TrackSource` that lets `Engine::new_with_source` read
//! from it.
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
//! Per `TrackSource`'s contract (`funkot-core/src/engine.rs`), `next` returning
//! `None` ends the playlist for good (the loader thread exits; the engine
//! cannot be handed more tracks afterwards). Whether a drained queue *should*
//! ever reach that point — and how that interacts with `start()`'s current
//! whole-folder loop — is a product decision left to the caller/wiring code,
//! not to this module.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use funkot_core::engine::TrackSource;

/// Shared handle to the host-owned queue. Cheap to clone; every clone points
/// at the same underlying `VecDeque`.
pub type SharedQueue = Arc<Mutex<VecDeque<PathBuf>>>;

/// A fresh, empty queue.
pub fn new_shared_queue() -> SharedQueue {
    Arc::new(Mutex::new(VecDeque::new()))
}

/// Append `path` to the tail. Returns the queue length after the insert.
pub fn enqueue(queue: &SharedQueue, path: PathBuf) -> usize {
    let mut q = queue.lock().unwrap();
    q.push_back(path);
    q.len()
}

/// Move the item at `from` to `to` (both 0-based positions in the queue as it
/// stands right now). Does not touch whatever the engine has already taken
/// off the front for preparation — those are gone from this queue the moment
/// `HostSource::next` returns them.
///
/// Errors (queue left unchanged) if either index is out of range.
pub fn reorder(queue: &SharedQueue, from: usize, to: usize) -> Result<(), String> {
    let mut q = queue.lock().unwrap();
    let len = q.len();
    if from >= len || to >= len {
        return Err(format!(
            "reorder index out of range: len={len}, from={from}, to={to}"
        ));
    }
    if from == to {
        return Ok(());
    }
    let item = q.remove(from).expect("from checked above");
    q.insert(to, item);
    Ok(())
}

/// Remove and return the item at `index`.
///
/// Errors if `index` is out of range (including an empty queue).
pub fn dequeue(queue: &SharedQueue, index: usize) -> Result<PathBuf, String> {
    let mut q = queue.lock().unwrap();
    let len = q.len();
    q.remove(index)
        .ok_or_else(|| format!("dequeue index out of range: len={len}, index={index}"))
}

/// Snapshot of the queue's current contents, for `state()`.
pub fn snapshot(queue: &SharedQueue) -> Vec<PathBuf> {
    queue.lock().unwrap().iter().cloned().collect()
}

/// `TrackSource` backed by a [`SharedQueue`] instead of a fixed playlist, so a
/// host can append/reorder/remove tracks while the engine is already running.
///
/// `index` handed back to the engine (and echoed verbatim in
/// [`funkot_core::engine::EngineEvent::TrackStarted`]) is just this source's
/// own call count; nothing outside this module currently depends on its
/// values being contiguous or matching queue positions.
pub struct HostSource {
    queue: SharedQueue,
    calls: usize,
}

impl HostSource {
    pub fn new(queue: SharedQueue) -> Self {
        Self { queue, calls: 0 }
    }
}

impl TrackSource for HostSource {
    fn next(&mut self) -> Option<(usize, PathBuf)> {
        let path = self.queue.lock().unwrap().pop_front()?;
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

    #[test]
    fn enqueue_appends_in_order() {
        let q = new_shared_queue();
        assert_eq!(enqueue(&q, p("a")), 1);
        assert_eq!(enqueue(&q, p("b")), 2);
        assert_eq!(enqueue(&q, p("c")), 3);
        assert_eq!(snapshot(&q), vec![p("a"), p("b"), p("c")]);
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
        let mut source = HostSource::new(Arc::clone(&q));
        assert_eq!(source.next(), Some((0, p("a"))));
        assert_eq!(source.next(), Some((1, p("b"))));
        assert_eq!(source.next(), Some((2, p("c"))));
        assert_eq!(snapshot(&q), Vec::<PathBuf>::new());
    }

    #[test]
    fn host_source_returns_none_on_empty_queue() {
        let q = new_shared_queue();
        let mut source = HostSource::new(q);
        assert_eq!(source.next(), None);
    }

    #[test]
    fn host_source_sees_items_enqueued_after_construction() {
        let q = new_shared_queue();
        let mut source = HostSource::new(Arc::clone(&q));
        assert_eq!(source.next(), None);
        enqueue(&q, p("late"));
        // Once `next` has returned `None`, funkot-core's loader thread has
        // already exited and will not call `next` again — this only checks
        // that the queue/source themselves don't have some internal
        // "exhausted" latch of their own; whether a live engine ever sees this
        // item is a separate, unresolved question (see module docs).
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
}
