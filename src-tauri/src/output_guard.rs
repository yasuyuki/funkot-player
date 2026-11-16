//! Last stage before the output device. No allocation, synchronization or I/O.
//!
//! The engine's mix bus has no ceiling: RMS normalization can raise a quiet
//! track by 12 dB, and a transition adds two decks. `guarded` wraps the
//! stream callback so that every sample it leaves in the device buffer has
//! passed `seal`, whatever the callback and the limiter did before.

/// Maps any `f32` into `[-1.0, 1.0]`. In-range samples are returned unchanged
/// (bit for bit); NaN becomes silence.
#[inline]
pub fn seal(sample: f32) -> f32 {
    if sample >= -1.0 && sample <= 1.0 {
        sample
    } else if sample > 1.0 {
        1.0
    } else if sample < -1.0 {
        -1.0
    } else {
        0.0
    }
}

/// Stereo-linked gain rider: instant attack, exponential release.
///
/// It only keeps overs from being flattened by `seal`; the bound itself is
/// `seal`'s. While nothing exceeds full scale the gain is exactly 1.0 and the
/// buffer is untouched.
pub struct Limiter {
    gain: f64,
    release: f64,
}

/// Time constant of the return to unity gain.
const RELEASE_SECS: f64 = 1.0;
/// Below this distance from unity the gain snaps back to exactly 1.0.
const UNITY_SNAP: f64 = 1e-6;

impl Limiter {
    pub fn new(sample_rate: u32) -> Self {
        let frames = f64::from(sample_rate.max(1)) * RELEASE_SECS;
        Self { gain: 1.0, release: 1.0 - (-1.0 / frames).exp() }
    }

    pub fn process(&mut self, out: &mut [f32]) {
        for frame in out.chunks_exact_mut(2) {
            let peak = frame[0].abs().max(frame[1].abs());
            if !(frame[0].is_finite() && frame[1].is_finite()) {
                frame[0] = 0.0;
                frame[1] = 0.0;
                continue;
            }
            if self.gain < 1.0 {
                self.gain += (1.0 - self.gain) * self.release;
                if 1.0 - self.gain < UNITY_SNAP {
                    self.gain = 1.0;
                }
            }
            if peak > 1.0 {
                self.gain = self.gain.min(1.0 / f64::from(peak));
            }
            if self.gain < 1.0 {
                let gain = self.gain as f32;
                frame[0] *= gain;
                frame[1] *= gain;
            }
        }
    }
}

/// Wraps a stream callback. `seal` is the last write to every sample of the
/// device buffer, on every path through `fill`, including its early returns.
pub fn guarded<I>(
    sample_rate: u32,
    mut fill: impl FnMut(&mut [f32], &I),
) -> impl FnMut(&mut [f32], &I) {
    let mut limiter = Limiter::new(sample_rate);
    move |out, info| {
        fill(out, info);
        limiter.process(out);
        for sample in out.iter_mut() {
            *sample = seal(*sample);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(frames: &[[f32; 2]]) -> Vec<f32> {
        let mut callback = guarded(48_000, |out: &mut [f32], source: &Vec<f32>| out.copy_from_slice(source));
        let source: Vec<f32> = frames.iter().flatten().copied().collect();
        let mut out = vec![9.0; source.len()];
        callback(&mut out, &source);
        out
    }

    #[test]
    fn in_range_audio_is_untouched() {
        let frames = [[0.25, -0.5], [1.0, -1.0], [-0.0, 0.0], [f32::MIN_POSITIVE, -1e-30]];
        let out = run(&frames);
        let expected: Vec<u32> = frames.iter().flatten().map(|x| x.to_bits()).collect();
        assert_eq!(out.iter().map(|x| x.to_bits()).collect::<Vec<_>>(), expected);
    }

    #[test]
    fn an_over_lowers_both_channels_together_and_keeps_their_ratio() {
        let out = run(&[[2.0, -1.0], [2.0, -1.0], [0.5, 0.25]]);
        assert_eq!(&out[..4], &[1.0, -0.5, 1.0, -0.5]);
        assert!(out[4] > 0.25 && out[4] < 0.2501, "gain is released slowly: {}", out[4]);
        assert!((out[4] / out[5] - 2.0).abs() < 1e-6);
    }

    #[test]
    fn gain_returns_to_exactly_unity() {
        let mut limiter = Limiter::new(48_000);
        limiter.process(&mut [4.0, 0.0]);
        let mut quiet = vec![0.5f32; 2 * 48_000];
        for _ in 0..20 {
            quiet.fill(0.5);
            limiter.process(&mut quiet);
        }
        assert_eq!(quiet[quiet.len() - 1], 0.5);
        assert_eq!(limiter.gain, 1.0);
    }

    #[test]
    fn non_finite_frames_become_silence_without_muting_what_follows() {
        let out = run(&[[f32::NAN, 0.5], [f32::INFINITY, 0.5], [0.5, f32::NEG_INFINITY], [0.5, -0.5]]);
        assert_eq!(out, [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.5, -0.5]);
    }
}
