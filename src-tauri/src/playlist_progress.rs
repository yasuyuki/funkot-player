#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Occurrence<I> {
    pub playlist: I,
    pub run: u64,
    pub entry: I,
}

#[derive(Clone, Copy, Debug)]
pub struct Claim<I> {
    pub occurrence: Occurrence<I>,
    pub index: usize,
    pub live: bool,
    pub cancelled: bool,
}

#[derive(Clone, Copy, Debug)]
pub enum Observation<I> {
    Started(usize),
    Current(usize),
    Failed { index: usize, reason_present: bool },
    Unavailable { occurrence: Occurrence<I>, reason_present: bool },
    Passive,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Progress {
    pub consumed: bool,
    pub failed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cause { Started, Failed }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Update {
    pub progress: Progress,
    pub accepted: Option<Cause>,
}

pub fn observe<I: Copy + Eq>(
    target: Option<Occurrence<I>>,
    before: Progress,
    claim: Option<Claim<I>>,
    observation: Observation<I>,
) -> Update {
    let claim = claim.filter(|c| !c.cancelled && Some(c.occurrence) == target);
    let accepted = match observation {
        Observation::Started(index) | Observation::Current(index) =>
            claim.filter(|c| c.index == index).map(|_| Cause::Started),
        Observation::Failed { index, reason_present } =>
            claim.filter(|c| c.index == index && c.live && reason_present).map(|_| Cause::Failed),
        Observation::Unavailable { occurrence, reason_present } =>
            (target == Some(occurrence) && reason_present).then_some(Cause::Failed),
        Observation::Passive => None,
    };
    let mut progress = before;
    if let Some(cause) = accepted {
        progress.consumed = true;
        progress.failed |= cause == Cause::Failed;
    }
    Update { progress, accepted }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_failure_and_preparation_do_not_consume() {
        let occurrence = Occurrence { playlist: "playlist-1", run: 3, entry: "entry-2" };
        let claim = Some(Claim { occurrence, index: 91, live: true, cancelled: false });
        for observation in [Observation::Passive,
            Observation::Failed { index: 91, reason_present: false },
            Observation::Unavailable { occurrence, reason_present: false }] {
            assert_eq!(observe(Some(occurrence), Progress::default(), claim, observation).progress,
                Progress::default());
        }
    }
}
