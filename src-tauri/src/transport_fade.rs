//! Callback-local pause/play envelope. No allocation, synchronization or I/O.
//!
//! Fade the real waveform instead of truncating it or extending its last sample
//! as DC. A pause can advance playback by at most 10 ms of audible tail (the
//! same de-click duration used by the engine). Once silent, rendering freezes.

pub(super) struct TransportFade {
    // Gain for the next stereo frame, on an integer grid. Retargeting never
    // resets it, so rapid pause/play commands cannot introduce a gain jump.
    level: usize,
    full: usize,
    // True only after the zero-gain frame has been emitted. Keeping that
    // endpoint across callbacks makes the rendered frame count invariant.
    muted: bool,
}

impl TransportFade {
    pub(super) fn new(sample_rate: u32) -> Self {
        let frames = (f64::from(sample_rate) * 0.010).round().max(2.0) as usize;
        let full = frames - 1;
        // A new/reopened output stream also starts after silence. Its first
        // Play must fade in; an initially paused stream remains frozen.
        Self { level: 0, full, muted: true }
    }

    pub(super) fn is_silent(&self) -> bool { self.muted }

    pub(super) fn silence(&mut self) { self.level = 0; self.muted = true; }

    /// Return the actual number of engine frames rendered. Partial callbacks
    /// retain the envelope; the unused tail is exact zero. Repeated pause at
    /// zero never calls the renderer (and cannot consume another occurrence).
    pub(super) fn render(
        &mut self,
        out: &mut [f32],
        paused: bool,
        render: impl FnOnce(&mut [f32]) -> usize,
    ) -> usize {
        let available = out.len() / 2;
        let wanted = if paused {
            if self.is_silent() { 0 } else { available.min(self.level + 1) }
        } else { available };
        if wanted == 0 {
            out.fill(0.0);
            return 0;
        }
        let frames = render(&mut out[..wanted * 2]);
        for frame in out[..frames * 2].chunks_exact_mut(2) {
            let gain = self.level as f32 / self.full as f32;
            frame[0] *= gain;
            frame[1] *= gain;
            self.muted = paused && self.level == 0;
            self.level = if paused {
                self.level.saturating_sub(1)
            } else { (self.level + 1).min(self.full) };
        }
        out[frames * 2..].fill(0.0);
        frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A continuous stereo waveform with nonzero samples at both transport
    // boundaries. Chunk size must not alter output, duration or resumed phase.
    fn wave(frame: usize, rate: u32) -> [f32; 2] {
        let x = (0.37 + frame as f64 * 196.0 * std::f64::consts::TAU / rate as f64).sin() as f32;
        [0.4 * x, -0.2 * x]
    }

    fn cycle(rate: u32, chunk: usize) -> (Vec<f32>, Vec<f32>, usize) {
        let mut fade = TransportFade::new(rate);
        let mut warmup = vec![0.0; ((rate as f64 * 0.010).round() as usize) * 2];
        fade.render(&mut warmup, false, |out| { out.fill(0.1); out.len() / 2 });
        let mut position = 17;
        let mut tail = Vec::new();
        while !fade.is_silent() {
            let mut out = vec![99.0; chunk * 2];
            let n = fade.render(&mut out, true, |out| {
                for frame in out.chunks_exact_mut(2) {
                    frame.copy_from_slice(&wave(position, rate));
                    position += 1;
                }
                out.len() / 2
            });
            tail.extend_from_slice(&out[..n * 2]);
            assert!(out[n * 2..].iter().all(|x| *x == 0.0));
        }
        let stopped_at = position;
        let mut out = [99.0; 14];
        for _ in 0..3 {
            assert_eq!(fade.render(&mut out, true, |_| panic!("paused engine advanced")), 0);
            assert_eq!(out, [0.0; 14]);
        }
        let mut resumed = Vec::new();
        while resumed.len() < tail.len() + 40 {
            let frames = chunk.min((tail.len() + 40 - resumed.len()) / 2);
            let mut out = vec![99.0; frames * 2];
            fade.render(&mut out, false, |out| {
                for frame in out.chunks_exact_mut(2) {
                    frame.copy_from_slice(&wave(position, rate));
                    position += 1;
                }
                out.len() / 2
            });
            resumed.extend_from_slice(&out);
        }
        (tail, resumed, stopped_at)
    }

    #[test]
    fn pause_and_resume_are_continuous_chunk_independent_and_freeze_at_silence() {
        for rate in [44_100, 48_000] {
            let (tail, resumed, stopped_at) = cycle(rate, 1);
            let span = (rate as f64 * 0.010).round() as usize;
            assert_eq!(stopped_at, 17 + span);
            assert_eq!(tail.len(), span * 2);
            assert_eq!(&tail[..2], &wave(17, rate));
            assert_eq!(&tail[tail.len() - 2..], &[0.0, 0.0]);
            assert_eq!(&resumed[..2], &[0.0, 0.0]);
            for (i, frame) in resumed.chunks_exact(2).enumerate().skip(span - 1) {
                assert_eq!(frame, wave(stopped_at + i, rate));
            }
            // The envelope adds no more than peak/(span-1) to the ordinary
            // waveform's analytic adjacent-sample bound, including endpoints.
            let bound = 0.4 * (196.0 * std::f64::consts::TAU / rate as f64) as f32
                + 0.4 / (span - 1) as f32 + 1e-6;
            for output in [&tail, &resumed] {
                for i in 2..output.len() { assert!((output[i] - output[i - 2]).abs() <= bound); }
            }
            for chunk in [17, 192, 4096] {
                assert_eq!(cycle(rate, chunk), (tail.clone(), resumed.clone(), stopped_at));
            }
        }
    }

    #[test]
    fn reversing_a_partial_fade_never_jumps_and_short_render_keeps_progress() {
        let mut fade = TransportFade::new(48_000);
        let mut warmup = [0.0; 960];
        fade.render(&mut warmup, false, |out| { out.fill(0.1); out.len() / 2 });
        let mut unchanged = [0.25, -0.75, 0.8, -0.1];
        let expected = unchanged;
        fade.render(&mut unchanged, false, |out| out.len() / 2);
        assert_eq!(unchanged, expected);
        let mut prior = 1.0;
        for (paused, frames) in [(true, 91), (false, 37), (true, 503), (false, 700)] {
            let mut out = vec![99.0; frames * 2];
            fade.render(&mut out, paused, |out| { out.fill(1.0); out.len() / 2 });
            for frame in out.chunks_exact(2) {
                assert_eq!(frame[0], frame[1]);
                assert!((frame[0] - prior).abs() <= 1.0 / 479.0 + 1e-6);
                prior = frame[0];
            }
        }
        let mut out = [99.0; 32];
        let level = fade.level;
        assert_eq!(fade.render(&mut out, true, |out| { out[..6].fill(1.0); 3 }), 3);
        assert_eq!(fade.level, level - 3);
        assert!(out[6..].iter().all(|x| *x == 0.0));
        let level = fade.level;
        assert_eq!(fade.render(&mut out, false, |_| 0), 0);
        assert_eq!(fade.level, level);
        assert_eq!(out, [0.0; 32]);
    }

    #[test]
    fn first_play_on_a_new_stream_fades_in_without_skipping_source_frames() {
        for rate in [44_100, 48_000] {
            let span = (rate as f64 * 0.010).round() as usize;
            for chunk in [1, 17, 192, 4096] {
                let mut fade = TransportFade::new(rate);
                let mut position = 17;
                let mut output = Vec::new();
                while output.len() < (span + 20) * 2 {
                    let n = chunk.min(span + 20 - output.len() / 2);
                    let mut out = vec![99.0; n * 2];
                    assert_eq!(fade.render(&mut out, false, |out| {
                        for frame in out.chunks_exact_mut(2) {
                            frame.copy_from_slice(&wave(position, rate));
                            position += 1;
                        }
                        out.len() / 2
                    }), n);
                    output.extend(out);
                }
                assert_eq!(position, 17 + span + 20);
                assert_eq!(&output[..2], &[0.0; 2]);
                for (i, frame) in output.chunks_exact(2).enumerate() {
                    let gain = i.min(span - 1) as f32 / (span - 1) as f32;
                    let raw = wave(17 + i, rate);
                    assert_eq!(frame, [raw[0] * gain, raw[1] * gain]);
                }
            }
        }
    }

    #[test]
    fn paused_open_and_finished_stay_silent_until_play() {
        let mut fade = TransportFade::new(48_000);
        let mut out = [99.0; 32];
        assert_eq!(fade.render(&mut out, true, |_| panic!("paused open rendered")), 0);
        assert_eq!(out, [0.0; 32]);
        fade.render(&mut out, false, |out| { out.fill(0.5); out.len() / 2 });
        assert_eq!(&out[..2], &[0.0; 2]);
        fade.silence();
        assert_eq!(fade.render(&mut out, true, |_| panic!("finished rendered")), 0);
        assert_eq!(out, [0.0; 32]);
    }
}
