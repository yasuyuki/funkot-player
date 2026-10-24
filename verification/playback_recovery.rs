//! Standalone driver: the path below is the production module, not a model.
#[path = "../src-tauri/src/playback_recovery.rs"]
mod playback_recovery;

#[cfg(kani)]
mod proofs {
    use super::playback_recovery::{
        classify_legacy_normal, restore_missing_current_identity, IdentityRestoration,
        LegacyNormalImport,
    };

    fn entries() -> ([u8; 2], usize) {
        ([kani::any(), kani::any()], (kani::any::<u8>() % 3) as usize)
    }

    #[kani::proof]
    #[kani::unwind(3)]
    fn classifies_legacy_normal_import() {
        let (queue_values, queue_length) = entries();
        let (normal_values, normal_length) = entries();
        let queue = kani::any::<bool>().then(|| &queue_values[..queue_length]);
        let normal = kani::any::<bool>().then(|| &normal_values[..normal_length]);
        let result = classify_legacy_normal(queue, normal);

        match (queue, normal) {
            (_, None) => assert_eq!(result, LegacyNormalImport::KeepQueue),
            (None, Some(_)) => assert_eq!(result, LegacyNormalImport::UseCatalog),
            (Some(queue), Some(normal)) if queue == normal => {
                assert_eq!(result, LegacyNormalImport::UseCatalog);
            }
            (Some(_), Some(_)) => assert_eq!(result, LegacyNormalImport::Conflict),
        }

        kani::cover!(queue.is_none() && normal.is_none(), "both sources absent keeps queue");
        kani::cover!(queue.is_none() && normal.is_some(), "catalog-only import uses catalog");
        kani::cover!(queue.is_some() && normal.is_none(), "queue-only import keeps queue");
        kani::cover!(queue.is_some() && normal.is_some() && queue == normal,
            "equal sources use catalog");
        kani::cover!(queue.is_some() && normal.is_some() && queue != normal,
            "divergent sources conflict");
    }

    #[kani::proof]
    fn restores_missing_normal_current_identity() {
        let normal: bool = kani::any();
        let existing = kani::any::<bool>().then(kani::any::<u8>);
        let matching = kani::any::<bool>().then(kani::any::<u8>);
        let fresh: u8 = kani::any();
        let mut creates = 0_u8;
        let decision = restore_missing_current_identity(
            normal,
            existing.as_ref(),
            matching,
            || {
                creates += 1;
                fresh
            },
        );
        let restored = match decision {
            IdentityRestoration::Preserve => existing,
            IdentityRestoration::Reuse(item) | IdentityRestoration::Create(item) => Some(item),
        };

        if existing.is_some() {
            assert_eq!(restored, existing, "an existing identity remains unchanged");
            assert_eq!(creates, 0);
        }
        if !normal {
            assert_eq!(restored, existing, "a playlist current remains unchanged");
            assert_eq!(creates, 0);
        }
        if normal && existing.is_none() {
            match matching {
                Some(item) => {
                    assert_eq!(restored, Some(item));
                    assert_eq!(creates, 0);
                }
                None => {
                    assert_eq!(restored, Some(fresh));
                    assert_eq!(creates, 1);
                }
            }
        }

        kani::cover!(normal && existing.is_some(), "normal existing identity preserves");
        kani::cover!(!normal && existing.is_some(), "playlist existing identity preserves");
        kani::cover!(!normal && existing.is_none(), "playlist missing identity preserves");
        kani::cover!(normal && existing.is_none() && matching.is_some(),
            "missing normal identity reuses first match");
        kani::cover!(normal && existing.is_none() && matching.is_none(),
            "missing normal identity creates once");
    }
}
