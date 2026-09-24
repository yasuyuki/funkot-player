//! Baseline TrackSource probes (#44): None stays terminal without the explicit
//! future-source replacement API. These are distinct from device acceptance.
use funkot_core::engine::{Engine, EngineEvent, PreparedTrack, TrackSource};
use funkot_core::EngineOptions;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

struct FiniteSource {
    queue: Arc<Mutex<VecDeque<(usize, PathBuf)>>>,
    calls: mpsc::Sender<bool>,
}
impl TrackSource for FiniteSource {
    fn next(&mut self) -> Option<(usize, PathBuf)> {
        let next = self.queue.lock().unwrap().pop_front();
        self.calls.send(next.is_some()).unwrap();
        next
    }
}

fn track(index: usize) -> PreparedTrack {
    PreparedTrack {
        path: PathBuf::from(format!("synthetic-{index}.wav")), playlist_index: index,
        samples: Arc::new(vec![0.25; 4096]), frames: 2048,
        first_downbeat_out: 0, outro_start_out: 2048, outro_end_anchored_out: 2048,
        intro_bars: 0, outro_bars: 0, gain_linear: 1.0, preview: false, head_only: false,
    }
}

#[test]
fn adopted_core_drops_finite_source_on_none_and_cannot_observe_late_append() {
    let pending = Arc::new(Mutex::new(VecDeque::new()));
    let (tx, rx) = mpsc::channel();
    let mut engine = Engine::new_with_source(EngineOptions::default(), Box::new(FiniteSource {
        queue: pending.clone(), calls: tx,
    })).unwrap();
    assert!(!rx.recv_timeout(Duration::from_secs(5)).unwrap());
    // Disconnection proves the source/loader ended; this is not a timing-based
    // assertion that a slow decoder failed to call us soon enough.
    assert!(matches!(rx.recv_timeout(Duration::from_secs(5)), Err(mpsc::RecvTimeoutError::Disconnected)));
    pending.lock().unwrap().push_back((1, PathBuf::from("late.wav")));
    let mut out = [0.0; 128];
    engine.render(&mut out);
    assert!(engine.poll_events().iter().any(|e| matches!(e, EngineEvent::Finished)));
    assert_eq!(pending.lock().unwrap().len(), 1);
    assert_eq!(engine.render(&mut out), 0);
}

#[test]
fn adopted_core_finite_last_track_finishes_and_stays_finished() {
    let mut engine = Engine::from_prepared(EngineOptions::default(), vec![track(0)]).unwrap();
    let mut out = [0.0; 128];
    assert!(engine.render(&mut out) > 0);
    assert!(out.iter().any(|sample| *sample != 0.0));
    assert!(engine.revoke_next().is_none(), "no next slot can wake an exhausted source");
    while engine.render(&mut out) != 0 {}
    assert!(engine.poll_events().iter().any(|e| matches!(e, EngineEvent::Finished)));
    assert_eq!(engine.render(&mut out), 0);
}

#[test]
fn adopted_core_revoke_preserves_current_audio_but_only_returns_a_prepared_path() {
    let mut engine = Engine::from_prepared(EngineOptions::default(), vec![track(0), track(1)]).unwrap();
    let mut out = [0.0; 128];
    engine.render(&mut out);
    let before = engine.frames_until_transition().unwrap();
    assert_eq!(engine.revoke_next(), Some(PathBuf::from("synthetic-1.wav")));
    assert!(engine.revoke_next().is_none());
    assert!(engine.render(&mut out) > 0);
    assert!(engine.frames_until_transition().unwrap() < before);
    assert!(out.iter().any(|sample| *sample != 0.0));
}
