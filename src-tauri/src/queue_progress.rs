//! Queue membership for one occurrence. Audio paths are not occurrence IDs.

#[derive(Clone, Copy, Debug)]
pub enum Event<I> {
    UserAdd(I),
    AutomaticFill {
        entry: I,
        source_request: bool,
        unreserved_usable: bool,
    },
    UserDelete(I),
    PlaybackStarted {
        entry: I,
        accepted: bool,
    },
    Reserve(I),
    Reject(I),
    Reorder,
    Passive,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cause {
    UserAdd,
    AutomaticFill,
    UserDelete,
    PlaybackStarted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Update {
    pub present: bool,
    pub accepted: Option<Cause>,
}

/// Authorize one event against one occurrence, including idempotent repeats.
/// Callers mutate membership only when `present` changes. A playback start's
/// `accepted` flag must come from a validated claim for an observed engine index.
/// Automatic fill requires a source request with no unreserved usable entry.
pub fn transition<I: Copy + Eq>(target: I, present: bool, event: Event<I>) -> Update {
    let accepted = match event {
        Event::UserAdd(entry) if entry == target => Some(Cause::UserAdd),
        Event::AutomaticFill {
            entry,
            source_request: true,
            unreserved_usable: false,
        } if entry == target => Some(Cause::AutomaticFill),
        Event::UserDelete(entry) if entry == target => Some(Cause::UserDelete),
        Event::PlaybackStarted {
            entry,
            accepted: true,
        } if entry == target => Some(Cause::PlaybackStarted),
        _ => None,
    };
    let present = match accepted {
        Some(Cause::UserAdd | Cause::AutomaticFill) => true,
        Some(Cause::UserDelete | Cause::PlaybackStarted) => false,
        None => present,
    };
    Update { present, accepted }
}
