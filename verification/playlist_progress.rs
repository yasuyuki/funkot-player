//! Standalone driver: the path below is the production module, not a model.
#[path = "../src-tauri/src/playlist_progress.rs"]
mod playlist_progress;

#[cfg(kani)]
mod proofs {
    use super::playlist_progress::*;

    fn identity() -> Occurrence<u8> {
        Occurrence { playlist: kani::any(), run: kani::any(), entry: kani::any() }
    }
    fn claim() -> Option<Claim<u8>> {
        if kani::any() { Some(Claim { occurrence: identity(), index: kani::any(),
            live: kani::any(), cancelled: kani::any() }) } else { None }
    }
    fn observation() -> Observation<u8> {
        match kani::any::<u8>() % 5 {
            0 => Observation::Started(kani::any()),
            1 => Observation::Current(kani::any()),
            2 => Observation::Failed { index: kani::any(), reason_present: kani::any() },
            3 => Observation::Unavailable { occurrence: identity(), reason_present: kani::any() },
            _ => Observation::Passive,
        }
    }
    fn state() -> Progress {
        // Include restored/imported states too; no state assumption is needed.
        Progress { consumed: kani::any(), failed: kani::any() }
    }

    // Specification of the evidence that can justify *this* occurrence. Kept
    // separate from the transition's state writes and accepted outcome.
    fn justified(target: Option<Occurrence<u8>>, c: Option<Claim<u8>>, e: Observation<u8>) -> bool {
        match e {
            Observation::Started(index) | Observation::Current(index) => c.is_some_and(|c|
                Some(c.occurrence) == target && !c.cancelled && c.index == index),
            Observation::Failed { index, reason_present } => c.is_some_and(|c|
                Some(c.occurrence) == target && !c.cancelled && c.live && c.index == index && reason_present),
            Observation::Unavailable { occurrence, reason_present } =>
                target == Some(occurrence) && reason_present,
            Observation::Passive => false,
        }
    }

    #[kani::proof]
    #[kani::unwind(8)]
    fn occurrence_update() {
        let target = if kani::any() { Some(identity()) } else { None };
        let before = state();
        let c = claim();
        let e = observation();
        let after = observe(target, before, c, e);
        let valid = justified(target, c, e);
        assert!(!after.progress.consumed || before.consumed || valid);
        assert!(!after.progress.failed || before.failed || after.progress.consumed);
        assert!(valid == after.accepted.is_some());
        // Success is required too: a no-op implementation cannot pass.
        assert!(!valid || after.progress.consumed);
        assert!(valid || after.progress == before);
        assert_eq!(observe(target, after.progress, c, e).progress, after.progress);
        kani::cover!(valid && !before.consumed && matches!(e, Observation::Started(_)), "start progresses");
        kani::cover!(valid && !before.consumed && matches!(e, Observation::Current(_)), "snapshot progresses");
        kani::cover!(valid && !before.consumed && matches!(e, Observation::Failed { .. }), "reasoned engine failure progresses");
        kani::cover!(valid && !before.consumed && matches!(e, Observation::Unavailable { .. }), "reasoned unavailable progresses");
        kani::cover!(valid && c.is_some_and(|c| !c.live) && matches!(e, Observation::Started(_)), "delayed retired start progresses");
        kani::cover!(!valid && c.is_some_and(|c| c.cancelled) && matches!(e, Observation::Started(_)), "cancelled start rejected");
        kani::cover!(!valid && target.is_some() && c.is_some_and(|c| c.occurrence.run != target.unwrap().run), "old run rejected");
        kani::cover!(!valid && target.is_none(), "unregistered occurrence rejected");
    }

    #[kani::proof]
    #[kani::unwind(8)]
    fn initial_and_seven_occurrences() {
        let zero = Progress::default();
        assert!(!zero.consumed && !zero.failed);
        // Five occurrences in one list and two in another. Repeated audio
        // paths are intentionally absent from the identity/update API.
        let before = [state(), state(), state(), state(), state(), state(), state()];
        let c = claim();
        let e = observation();
        let first_run: u64 = kani::any();
        let second_run: u64 = kani::any();
        let mut additions = 0;
        for i in 0..7 {
            let target = Some(Occurrence { playlist: if i < 5 { 0 } else { 1 },
                run: if i < 5 { first_run } else { second_run }, entry: i as u8 });
            let after = observe(target, before[i], c, e).progress;
            if after.consumed && !before[i].consumed {
                additions += 1;
                assert!(justified(target, c, e));
            }
        }
        assert!(additions <= 1, "one observation never consumes another occurrence");
        kani::cover!(additions == 1, "seven-entry state can progress");
        kani::cover!(additions == 0, "seven-entry state can reject");
    }
}
