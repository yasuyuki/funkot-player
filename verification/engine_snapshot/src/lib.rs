#![allow(dead_code)]

include!(concat!(env!("OUT_DIR"), "/engine_observation.rs"));

#[cfg(test)]
mod proof {
    use super::{EngineObservation, EngineSnapshot};
    use loom::sync::Arc;
    use loom::thread;

    fn snap(current: Option<usize>, finished: bool) -> EngineSnapshot {
        EngineSnapshot { current, finished }
    }

    fn assert_one_publication(got: Option<EngineSnapshot>, allowed: &[EngineSnapshot]) {
        assert!(
            got.is_none() || allowed.contains(&got.unwrap()),
            "read returned {got:?}, outside {allowed:?}"
        );
    }

    fn explore(check: impl Fn() + Send + Sync + 'static) {
        // Loom's default preemption bound is unlimited. max_branches is 1_000,
        // above the atomic steps in one or two publishes.
        loom::model(check);
    }

    #[test]
    fn index_and_finished_move_together() {
        let before = snap(Some(1), false);
        let after = snap(Some(2), true);
        explore(move || {
            let observation = Arc::new(EngineObservation::new(before.current, before.finished));
            let writing = observation.clone();
            let writer = thread::spawn(move || writing.publish(after.current, after.finished));
            let got = observation.read();
            writer.join().unwrap();
            assert_one_publication(got, &[before, after]);
        });
    }

    #[test]
    fn absent_current_hides_the_stale_index() {
        let before = snap(Some(1), false);
        let after = snap(None, true);
        explore(move || {
            let observation = Arc::new(EngineObservation::new(before.current, before.finished));
            let writing = observation.clone();
            let writer = thread::spawn(move || writing.publish(after.current, after.finished));
            let got = observation.read();
            writer.join().unwrap();
            assert_one_publication(got, &[before, after]);
        });
    }

    #[test]
    fn reader_can_span_two_serialized_publishes() {
        let initial = snap(Some(1), false);
        let mid = snap(None, true);
        let last = snap(Some(2), false);
        explore(move || {
            let observation = Arc::new(EngineObservation::new(initial.current, initial.finished));
            let writing = observation.clone();
            let writer = thread::spawn(move || {
                writing.publish(mid.current, mid.finished);
                writing.publish(last.current, last.finished);
            });
            let got = observation.read();
            writer.join().unwrap();
            assert_one_publication(got, &[initial, mid, last]);
        });
    }

    #[test]
    fn quiescent_publish_is_exactly_the_written_pair() {
        loom::model(|| {
            let observation = EngineObservation::new(None, false);
            assert_eq!(observation.read(), Some(snap(None, false)));
            observation.publish(Some(usize::MAX), true);
            assert_eq!(observation.read(), Some(snap(Some(usize::MAX), true)));
            observation.publish(None, true);
            assert_eq!(
                observation.read(),
                Some(snap(None, true)),
                "clearing current must not leave the previous index visible"
            );
        });
    }
}
