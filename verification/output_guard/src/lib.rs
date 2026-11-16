//! Runs the production output guard on every `f32` bit pattern.
#![allow(dead_code)]

mod guard {
    include!(concat!(env!("OUT_DIR"), "/output_guard.rs"));
}

#[cfg(test)]
mod proof {
    use super::guard::{guarded, seal};

    /// Calls `check(first, last)` on disjoint ranges that cover all 2^32 patterns.
    fn every_bit_pattern(check: impl Fn(u32, u32) + Sync) {
        let workers = std::thread::available_parallelism().map_or(1, |n| n.get()).min(64) as u64;
        let total = 1u64 << 32;
        std::thread::scope(|scope| {
            for worker in 0..workers {
                let first = (total * worker / workers) as u32;
                let last = (total * (worker + 1) / workers - 1) as u32;
                let check = &check;
                scope.spawn(move || check(first, last));
            }
        });
    }

    #[test]
    fn seal_maps_every_f32_into_full_scale_and_keeps_in_range_samples() {
        every_bit_pattern(|first, last| {
            for bits in first..=last {
                let sample = f32::from_bits(bits);
                let sealed = seal(sample);
                let expected = if sample.is_nan() {
                    0.0f32
                } else if sample > 1.0 {
                    1.0
                } else if sample < -1.0 {
                    -1.0
                } else {
                    sample
                };
                assert!(
                    sealed.to_bits() == expected.to_bits(),
                    "seal({bits:#010x}) = {:#010x}, expected {:#010x}",
                    sealed.to_bits(),
                    expected.to_bits()
                );
                assert!(sealed >= -1.0 && sealed <= 1.0, "seal({bits:#010x}) = {sealed}");
            }
        });
    }

    /// The other channel of each frame, so the pair exercises every kind of
    /// neighbour: silence, in range, full scale, over, and non-finite.
    const PARTNERS: [f32; 8] =
        [0.0, -0.75, 1.0, -1.0, 3.0, f32::MAX, f32::NEG_INFINITY, f32::NAN];

    #[test]
    fn the_wrapped_callback_leaves_only_full_scale_samples_for_every_f32() {
        every_bit_pattern(|first, last| {
            // One callback per range: the limiter's gain carries over between
            // buffers, as it does on the device.
            let mut callback = guarded(48_000, |out: &mut [f32], source: &[f32; 4]| {
                out.copy_from_slice(source)
            });
            for bits in first..=last {
                let sample = f32::from_bits(bits);
                let partner = PARTNERS[(bits % 8) as usize];
                let source = [sample, partner, partner, sample];
                let mut out = [9.0f32; 4];
                callback(&mut out, &source);
                for written in out {
                    assert!(
                        written >= -1.0 && written <= 1.0,
                        "callback left {written} for input {bits:#010x} beside {partner}"
                    );
                }
            }
        });
    }
}
