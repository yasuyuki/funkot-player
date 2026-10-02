//! The driver imports the same transition used by production.
#[path = "../src-tauri/src/queue_progress.rs"]
mod queue_progress;

#[cfg(kani)]
mod proofs {
    use super::queue_progress::*;

    fn event() -> Event<u64> {
        match kani::any::<u8>() % 8 {
            0 => Event::UserAdd(kani::any()),
            1 => Event::AutomaticFill {
                entry: kani::any(),
                source_request: kani::any(),
                unreserved_usable: kani::any(),
                admitted: kani::any(),
            },
            2 => Event::UserDelete(kani::any()),
            3 => Event::PlaybackStarted {
                entry: kani::any(),
                accepted: kani::any(),
            },
            4 => Event::Reserve(kani::any()),
            5 => Event::Reject(kani::any()),
            6 => Event::Reorder,
            _ => Event::Passive,
        }
    }

    #[kani::proof]
    fn membership_update() {
        let target: u64 = kani::any();
        let before: bool = kani::any();
        let e = event();
        let after = transition(target, before, e);
        let addition = match e {
            Event::UserAdd(id) => id == target,
            Event::AutomaticFill {
                entry,
                source_request,
                unreserved_usable,
                admitted,
            } => entry == target && source_request && !unreserved_usable && admitted,
            _ => false,
        };
        let removal = match e {
            Event::UserDelete(id) => id == target,
            Event::PlaybackStarted { entry, accepted } => entry == target && accepted,
            _ => false,
        };
        assert_eq!(after.accepted.is_some(), addition || removal);
        assert_eq!(after.present, addition || (before && !removal));
        assert!(before || !after.present || addition);
        assert!(!before || after.present || removal);
        assert_eq!(transition(target, after.present, e), after);
        match after.accepted {
            Some(Cause::UserAdd) => assert!(matches!(e, Event::UserAdd(_))),
            Some(Cause::AutomaticFill) => assert!(matches!(e, Event::AutomaticFill { .. })),
            Some(Cause::UserDelete) => assert!(matches!(e, Event::UserDelete(_))),
            Some(Cause::PlaybackStarted) => assert!(matches!(e, Event::PlaybackStarted { .. })),
            None => assert_eq!(after.present, before),
        }
        kani::cover!(
            !before && after.present && matches!(e, Event::UserAdd(_)),
            "user adds"
        );
        kani::cover!(
            !before && after.present && matches!(e, Event::AutomaticFill { .. }),
            "source fills"
        );
        kani::cover!(
            before && !after.present && matches!(e, Event::UserDelete(_)),
            "user deletes"
        );
        kani::cover!(
            before && !after.present && matches!(e, Event::PlaybackStarted { .. }),
            "accepted start removes"
        );
        kani::cover!(
            before
                && after.present
                && matches!(e, Event::PlaybackStarted { entry, accepted: false } if entry == target),
            "unaccepted start preserves"
        );
        kani::cover!(
            before && after.present && matches!(e, Event::Reserve(id) if id == target),
            "reservation preserves"
        );
        kani::cover!(
            before && after.present && matches!(e, Event::Reject(id) if id == target),
            "rejection preserves"
        );
        kani::cover!(
            before && after.present && matches!(e, Event::Reorder),
            "reordering preserves"
        );
        kani::cover!(
            before && after.present && matches!(e, Event::Passive),
            "passive event preserves"
        );
    }

    #[kani::proof]
    fn distinct_occurrences() {
        let first: u64 = kani::any();
        let second: u64 = kani::any();
        kani::assume(first != second);
        let a: bool = kani::any();
        let b: bool = kani::any();
        let e = event();
        let updated_a = transition(first, a, e);
        let updated_b = transition(second, b, e);
        assert!(!(updated_a.accepted.is_some() && updated_b.accepted.is_some()));
        assert!(updated_a.present == a || updated_b.present == b);
        kani::cover!(
            updated_a.present != a && updated_b.present == b,
            "first occurrence alone changes"
        );
        kani::cover!(
            updated_a.present == a && updated_b.present != b,
            "second occurrence alone changes"
        );
    }

    #[kani::proof]
    fn automatic_fill_requires_exhausted_selection() {
        let id: u64 = kani::any();
        let before: bool = kani::any();
        let request: bool = kani::any();
        let available = transition(
            id,
            before,
            Event::AutomaticFill {
                entry: id,
                source_request: request,
                unreserved_usable: true,
                admitted: kani::any(),
            },
        );
        assert_eq!(
            available,
            Update {
                present: before,
                accepted: None
            }
        );
        let unsolicited = transition(
            id,
            before,
            Event::AutomaticFill {
                entry: id,
                source_request: false,
                unreserved_usable: kani::any(),
                admitted: kani::any(),
            },
        );
        assert_eq!(
            unsolicited,
            Update {
                present: before,
                accepted: None
            }
        );
        let rejected = transition(
            id,
            before,
            Event::AutomaticFill {
                entry: id,
                source_request: true,
                unreserved_usable: false,
                admitted: false,
            },
        );
        assert_eq!(rejected, Update { present: before, accepted: None });
        kani::cover!(
            request && !before && !available.present,
            "usable entry blocks fill"
        );
        kani::cover!(!before && !rejected.present, "rejected candidate cannot fill");
        kani::cover!(!before && !unsolicited.present, "absence alone cannot fill");
    }
}
