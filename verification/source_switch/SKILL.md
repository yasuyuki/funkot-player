---
name: verify-funkot-source-switch
description: Verify Funkot Player source-switch transactions, delayed reservations, recovery and request receipts after changes to the service, queue, playback store or their finite model.
---
# Verify source-switch transactions

Use the player and adopted core declared by the selected working set. Read the
player's `AGENTS.md` and `verification/README.md`. The shared editing source is
`agent-rules/skills/verify-funkot-source-switch/SKILL.md`; the player's
`verification/source_switch/SKILL.md` is its byte-identical distribution.
Update both together through their registered tasks.

The product audit anchor is `4d49996e3d7c6062de0773ccf3c8c4804a818674`, with
adopted core `a5fa36a399c9f09ecbd7638ce4f144b016d059f7`. These identify the last
reviewed implementation, not permission to substitute that core for the current
`funkot-core.commit`. Read every intervening covered change before advancing the
anchor. A stale model PASS is not evidence about a changed adapter.

## Covered boundaries

Read `playlist_service.rs` (`ManagedSource::next`, `normal_future_items`,
`normal_items_for_update`, `reconcile_with`, `command_with`,
`reconfigure_admission`, `restore_saved_queue`, `configure`), `queue.rs`,
`playlists.rs`, `playback_state.rs`, `store.rs`, and the host observation,
reservation, preload and start call sites in `lib.rs`. For the exact adopted
core, inspect loader generation handling and begin/abort/commit future updates
in `funkot-core/src/engine.rs`.

Keep file revision, catalog revision/generation, service epoch, core generation,
playlist run, engine index and occurrence identity distinct. Paths do not merge
occurrences. An old-source audible current can survive a future-source change.
Reservation and preparation alone do not consume an occurrence. A local claim
must exist before slow admission and remain live with the same epoch/identity
when admission returns. A stale worker cannot recreate a cancelled claim.

The authoritative file replacement precedes live queue/catalog/session and core
publication. Failed writes leave the prior state and abort the future fence.
Before a core source exists, reconstruct the canonical normal queue, apply the
edit, retire saved in-flight reservations in the same commit, and publish only
after success. Preload failure does not mean there was no saved pending work.
Successful Play normalizes again before configuring the source.

Receipts are process-local. An identical request fingerprint can replay before
target freshness checking; altered action, entry or target must be stale.
Rejection preservation is measured after reconciliation. A process can die after
rename before reply, so a missing reply is not proof that the command failed.

## Run and judge

From the clean player root on Linux with Python 3.12 or later and Java 21:

```sh
python3 -B -m unittest discover -s verification -p 'test_source_switch_result.py'
python3 -B verification/check_source_switch.py --setup
python3 -B verification/check_source_switch.py --output /tmp/source-switch-proof
cargo +1.93.0 test --manifest-path src-tauri/Cargo.toml --locked --lib
./scripts/check-release-invariants.sh
```

Use a new output directory on every run. Both selected repositories must be
clean and the core HEAD must match the player pin. Outside a working set the
public CI layout uses the sibling `funkot-autodj-for-ui`. The runner archives
both commits, rechecks the archived pin, and fixes TLC 1.7.4 by hash. Read its
summary, all logs and the exact-commit CI artifacts. Missing/malformed revision,
dirty source, partial state exploration, unexpected tool bytes, timeout or an
undetected mutation fails. An unavailable verifier is BLOCKED, never PASS.

The unchanged existing Kani entry `./scripts/check-playlist-progress.sh` and
Loom entry `./scripts/check-engine-snapshot.sh` remain required in CI. Kani
imports the production pure progress/recovery decisions; it does not prove
service locks, collection adapters or file publication. Do not replace an
actual product transition with a second pure implementation merely to prove it.

## Read counterexamples and maintain the mapping

Use `/statechart` when reading a TLC trace. Keep the README's transition-to-code
table current. Replay a trace in actual Rust before labeling it a product bug.
The existing native regressions cover failed saves with real core fences,
pre/post-rename process interruption, delayed same-path/different-ID claims,
receipt replay, and failed preload followed by Select, OFF and QueueMove, including valid saved normal/playlist current
retention before Play. Legacy current/reservation overlap is covered by native
exact-ID retirement tests, outside the finite initial states.
Preserve their failure-before/fix-after evidence. Keep regression and product
fix commits separate from verification changes.

The normal model exhausts its finite graph. The runner then requires completed
counterexamples for ignored epoch (`NoStaleLoaderEffect`), missing future fence
(`FenceBeforeFutureDelta`), and publishing after write failure
(`NoCommitWithoutDurableCandidate`). Compiler errors, tool errors, timeout and a
mutation that passes do not establish sensitivity. Mutations stay in isolated
copies; rerun the unchanged committed source afterward.

The README owns exact bounds and assumptions: two sources, two initial
occurrences per source, one fresh normal identity, two attempts, one delayed
future per process and one crash. No fairness/liveness, arbitrary queues,
numeric wrap, multiple future loads, mixed queue priority, OS/power-loss,
Android device, DSP or click-freedom proof is claimed. Progress/reservation
persistence succeeds in the model; actual store failures remain native-test
obligations. Atomic rename is an assumption checked by real-file tests.

Record exact source/CI commits, completed counts, mutants, counterexamples,
product fixes and unproved scope in player Issue #112. Keep private paths, raw
diagnostics and individual hashes in private evidence. After covered changes,
use `maintain-formal-verification-skill` and classify each failure as model drift,
a product bug or unavailable verification; repair and rerun before accepting it.
