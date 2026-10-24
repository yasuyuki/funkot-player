#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LegacyNormalImport {
    KeepQueue,
    UseCatalog,
    Conflict,
}

pub(crate) fn classify_legacy_normal<T: PartialEq>(
    queue: Option<&[T]>,
    normal: Option<&[T]>,
) -> LegacyNormalImport {
    match (queue, normal) {
        (_, None) => LegacyNormalImport::KeepQueue,
        (None, Some(_)) => LegacyNormalImport::UseCatalog,
        (Some(queue), Some(normal)) if queue == normal => LegacyNormalImport::UseCatalog,
        (Some(_), Some(_)) => LegacyNormalImport::Conflict,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum IdentityRestoration<T> {
    Preserve,
    Reuse(T),
    Create(T),
}

pub(crate) fn restore_missing_current_identity<T>(
    normal: bool,
    existing: Option<&T>,
    matching: Option<T>,
    create: impl FnOnce() -> T,
) -> IdentityRestoration<T> {
    if !normal || existing.is_some() {
        IdentityRestoration::Preserve
    } else if let Some(item) = matching {
        IdentityRestoration::Reuse(item)
    } else {
        IdentityRestoration::Create(create())
    }
}
