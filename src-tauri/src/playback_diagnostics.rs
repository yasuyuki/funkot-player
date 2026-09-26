//! Callback-safe playback diagnostics.
//!
//! The cpal callback only performs fixed-size atomic operations here. Logging
//! and formatting stay on `audio_thread`. Counters are individually monotonic,
//! not a transactional snapshot. Only the upgrade record is read coherently.
//! Its main frame is observed at the callback boundary, not an exact event time.
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use funkot_core::engine::{PreviewUpgrade, RenderDiagnostics};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PreviewUpgradeSnapshot {
    pub count: u64,
    pub playlist_index: usize,
    pub playhead: u64,
    pub preview_frames: u64,
    pub main_callback_frame: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DiagnosticsSnapshot {
    pub render_lock_misses: u64,
    pub render_lock_missed_frames: u64,
    pub preview_wait_frames: u64,
    pub upgrade: Option<PreviewUpgradeSnapshot>,
}

pub(crate) struct PlaybackDiagnostics {
    render_lock_misses: AtomicU64,
    render_lock_missed_frames: AtomicU64,
    preview_wait_frames: AtomicU64,
    upgrade_sequence: AtomicU64,
    upgrade_count: AtomicU64,
    upgrade_index: AtomicUsize,
    upgrade_playhead: AtomicU64,
    upgrade_preview_frames: AtomicU64,
    upgrade_main_callback_frame: AtomicU64,
}

impl PlaybackDiagnostics {
    pub(crate) fn new() -> Self {
        Self {
            render_lock_misses: AtomicU64::new(0),
            render_lock_missed_frames: AtomicU64::new(0),
            preview_wait_frames: AtomicU64::new(0),
            upgrade_sequence: AtomicU64::new(0),
            upgrade_count: AtomicU64::new(0),
            upgrade_index: AtomicUsize::new(0),
            upgrade_playhead: AtomicU64::new(0),
            upgrade_preview_frames: AtomicU64::new(0),
            upgrade_main_callback_frame: AtomicU64::new(0),
        }
    }

    pub(crate) fn record_render_lock_miss(&self, frames: u64) {
        self.render_lock_misses.fetch_add(1, Ordering::Relaxed);
        self.render_lock_missed_frames.fetch_add(frames, Ordering::Relaxed);
    }

    fn publish_preview_wait_frames(&self, frames: u64) {
        self.preview_wait_frames.store(frames, Ordering::Relaxed);
    }

    fn published_core_values(&self) -> (u64, u64) {
        (
            self.preview_wait_frames.load(Ordering::Relaxed),
            self.upgrade_count.load(Ordering::SeqCst),
        )
    }

    fn publish_upgrade(&self, count: u64, upgrade: PreviewUpgrade, main_callback_frame: u64) {
        self.upgrade_sequence.fetch_add(1, Ordering::SeqCst);
        self.upgrade_count.store(count, Ordering::SeqCst);
        self.upgrade_index.store(upgrade.playlist_index, Ordering::SeqCst);
        self.upgrade_playhead.store(upgrade.playhead, Ordering::SeqCst);
        self.upgrade_preview_frames.store(upgrade.preview_frames, Ordering::SeqCst);
        self.upgrade_main_callback_frame.store(main_callback_frame, Ordering::SeqCst);
        self.upgrade_sequence.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn read(&self) -> Option<DiagnosticsSnapshot> {
        self.read_after_before(|| {})
    }

    fn read_after_before(&self, after_before: impl FnOnce()) -> Option<DiagnosticsSnapshot> {
        let before = self.upgrade_sequence.load(Ordering::SeqCst);
        if before % 2 != 0 { return None; }
        after_before();
        let render_lock_misses = self.render_lock_misses.load(Ordering::Relaxed);
        let render_lock_missed_frames = self.render_lock_missed_frames.load(Ordering::Relaxed);
        let preview_wait_frames = self.preview_wait_frames.load(Ordering::Relaxed);
        let count = self.upgrade_count.load(Ordering::SeqCst);
        let playlist_index = self.upgrade_index.load(Ordering::SeqCst);
        let playhead = self.upgrade_playhead.load(Ordering::SeqCst);
        let preview_frames = self.upgrade_preview_frames.load(Ordering::SeqCst);
        let main_callback_frame = self.upgrade_main_callback_frame.load(Ordering::SeqCst);
        let after = self.upgrade_sequence.load(Ordering::SeqCst);
        (before == after).then_some(DiagnosticsSnapshot {
            render_lock_misses,
            render_lock_missed_frames,
            preview_wait_frames,
            upgrade: (count != 0).then_some(PreviewUpgradeSnapshot {
                count, playlist_index, playhead, preview_frames, main_callback_frame,
            }),
        })
    }
}

pub(crate) struct CoreDiagnosticsPublisher {
    preview_wait_frames: u64,
    preview_upgrades: u64,
}

impl CoreDiagnosticsPublisher {
    pub(crate) fn new(target: &PlaybackDiagnostics) -> Self {
        let (preview_wait_frames, preview_upgrades) = target.published_core_values();
        Self { preview_wait_frames, preview_upgrades }
    }

    pub(crate) fn observe(&mut self, diagnostics: RenderDiagnostics, main_callback_frame: impl FnOnce() -> u64, target: &PlaybackDiagnostics) {
        if diagnostics.preview_wait_frames != self.preview_wait_frames {
            self.preview_wait_frames = diagnostics.preview_wait_frames;
            target.publish_preview_wait_frames(diagnostics.preview_wait_frames);
        }
        if diagnostics.preview_upgrades != self.preview_upgrades {
            self.preview_upgrades = diagnostics.preview_upgrades;
            if let Some(upgrade) = diagnostics.last_preview_upgrade {
                target.publish_upgrade(diagnostics.preview_upgrades, upgrade, main_callback_frame());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upgrade(index: usize) -> PreviewUpgrade {
        PreviewUpgrade { playlist_index: index, playhead: 12, preview_frames: 34 }
    }

    #[test]
    fn publishes_upgrade_only_when_count_changes() {
        let target = PlaybackDiagnostics::new();
        let mut publisher = CoreDiagnosticsPublisher::new(&target);
        publisher.observe(RenderDiagnostics { preview_wait_frames: 4, preview_upgrades: 1, last_preview_upgrade: Some(upgrade(usize::MAX)) }, || 50, &target);
        let first = target.read().unwrap();
        assert_eq!(first.preview_wait_frames, 4);
        assert_eq!(first.upgrade.unwrap().main_callback_frame, 50);
        publisher.observe(RenderDiagnostics { preview_wait_frames: 9, preview_upgrades: 1, last_preview_upgrade: Some(upgrade(3)) }, || panic!("unchanged upgrade must not sample main frame"), &target);
        let second = target.read().unwrap();
        assert_eq!(second.preview_wait_frames, 9);
        assert_eq!(second.upgrade.unwrap().main_callback_frame, 50);
        assert_eq!(second.upgrade.unwrap().playlist_index, usize::MAX);
        let mut reopened = CoreDiagnosticsPublisher::new(&target);
        reopened.observe(RenderDiagnostics { preview_wait_frames: 9, preview_upgrades: 1, last_preview_upgrade: Some(upgrade(usize::MAX)) }, || panic!("reopen must not republish an old upgrade"), &target);
        assert_eq!(target.read(), Some(second));
    }

    #[test]
    fn read_rejects_in_progress_and_intervening_upgrade_writes() {
        let target = PlaybackDiagnostics::new();
        target.upgrade_sequence.fetch_add(1, Ordering::SeqCst);
        assert_eq!(target.read(), None);
        target.upgrade_sequence.fetch_add(1, Ordering::SeqCst);
        target.publish_upgrade(1, upgrade(usize::MAX), 9);
        assert_eq!(target.read().unwrap().upgrade.unwrap().playlist_index, usize::MAX);
        assert_eq!(target.read_after_before(|| target.publish_upgrade(2, upgrade(7), 10)), None);
        assert_eq!(target.read().unwrap().upgrade.unwrap().count, 2);
    }

    #[test]
    fn accounts_for_exact_render_lock_miss_frames() {
        let target = PlaybackDiagnostics::new();
        target.record_render_lock_miss(512);
        target.record_render_lock_miss(7);
        let snapshot = target.read().unwrap();
        assert_eq!(snapshot.render_lock_misses, 2);
        assert_eq!(snapshot.render_lock_missed_frames, 519);
    }
}
