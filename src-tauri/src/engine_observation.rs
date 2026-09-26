//! A bounded, lock-free observation of the main engine for non-realtime users.
//!
//! Writers already hold the render mutex. Readers make one coherent attempt and
//! return `None` while a write is in progress so observers never contend with
//! the audio callback.
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct EngineSnapshot {
    pub current: Option<usize>,
    pub finished: bool,
}

pub(crate) struct EngineObservation {
    sequence: AtomicU64,
    current_present: AtomicBool,
    current: AtomicUsize,
    finished: AtomicBool,
}

impl EngineObservation {
    pub(crate) fn new(current: Option<usize>, finished: bool) -> Self {
        Self {
            sequence: AtomicU64::new(0),
            current_present: AtomicBool::new(current.is_some()),
            current: AtomicUsize::new(current.unwrap_or(0)),
            finished: AtomicBool::new(finished),
        }
    }

    pub(crate) fn publish(&self, current: Option<usize>, finished: bool) {
        self.sequence.fetch_add(1, Ordering::SeqCst);
        self.current_present.store(current.is_some(), Ordering::SeqCst);
        if let Some(current) = current {
            self.current.store(current, Ordering::SeqCst);
        }
        self.finished.store(finished, Ordering::SeqCst);
        self.sequence.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn read(&self) -> Option<EngineSnapshot> {
        self.read_after_before(|| {})
    }

    fn read_after_before(&self, after_before: impl FnOnce()) -> Option<EngineSnapshot> {
        let before = self.sequence.load(Ordering::SeqCst);
        if before % 2 != 0 { return None; }
        after_before();
        let current_present = self.current_present.load(Ordering::SeqCst);
        let current = self.current.load(Ordering::SeqCst);
        let finished = self.finished.load(Ordering::SeqCst);
        let after = self.sequence.load(Ordering::SeqCst);
        (before == after).then_some(EngineSnapshot {
            current: current_present.then_some(current),
            finished,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_none_and_usize_max() {
        let observation = EngineObservation::new(None, false);
        assert_eq!(observation.read(), Some(EngineSnapshot { current: None, finished: false }));
        observation.publish(Some(usize::MAX), true);
        assert_eq!(observation.read(), Some(EngineSnapshot { current: Some(usize::MAX), finished: true }));
    }

    #[test]
    fn rejects_an_in_progress_or_intervening_write() {
        let observation = EngineObservation::new(Some(3), false);
        observation.sequence.fetch_add(1, Ordering::SeqCst);
        assert_eq!(observation.read(), None);
        observation.sequence.fetch_add(1, Ordering::SeqCst);
        assert_eq!(observation.read(), Some(EngineSnapshot { current: Some(3), finished: false }));
        assert_eq!(observation.read_after_before(|| observation.publish(Some(4), true)), None);
        assert_eq!(observation.read(), Some(EngineSnapshot { current: Some(4), finished: true }));
    }
}
