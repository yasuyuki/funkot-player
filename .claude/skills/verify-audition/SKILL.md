---
name: verify-audition
description: Verify Funkot Player's transition audition (試聴, もう一度聴く, 〔再開〕) against its TLC model after any change to audition_transition, prepare_audition, install_audition, resume_autodj, toggle_pause, AUDITION_LOCK, the Android pause actions, or verification/audition.
---
# Verify transition audition

## What is verified

Three rules, checked by TLC over every interleaving of two audition requests,
the 〔再開〕 banner and the in-app pause button:

- `QuietWhilePreparing`: while an audition is being prepared, the queue stays silent.
- `QueueFollowsListener`: once everything settles with no audition engine, the queue
  plays exactly when the listener chose to play it. Harm when broken: a failed
  audition restarts music the listener had paused (#115).
- `BannerMatchesAudition`: once everything settles, the audition banner shows
  exactly while an audition engine is installed. Harm when broken: a stuck banner
  that refuses pause and skip, or an audition that plays with no banner.

The model is `verification/audition/Audition.tla`. Each action is one store or one
locked section in `src-tauri/src/lib.rs`, and its comment names the line.

## When to use

Use this skill when a change touches any of these in `src-tauri/src/lib.rs`:
`AUDITION_LOCK`, `try_audition_lock`, `audition_transition`, `prepare_audition`,
`install_audition`, `resume_autodj`, `audition_again`, `toggle_pause`,
`flip_paused`, `set_paused`, `ensure_pause_allowed`, the `0 | 4 | 5` arm of
`onNativeControl`, or any store to `AUDITIONING`, `AUDITION_PREPARING`,
`Playback::paused` or `RenderState::audition`. Also use it when `src/App.svelte`
changes when the banner shows, when `src/lib/transportMode.ts` changes
`primaryMode`, or when `verification/audition` or `verification/check_audition.py`
changes.

Sync commit: `fecd729081c6957516f4e20e6de10a1e5788b5b8`. The model was last confirmed against the code at that
commit. Run `git diff fecd729081c6957516f4e20e6de10a1e5788b5b8 -- src-tauri/src/lib.rs src/App.svelte
src/lib/transportMode.ts` and read every hunk that touches the names above. Move
the sync commit forward only after you confirm that every model action and line
comment still describes the code at the new commit.

## Run

From the player root on Linux with Python 3.12+ and Java 21, on a clean committed
checkout (the runner archives `HEAD`, so uncommitted edits are not checked):

```sh
python3 -B verification/check_source_switch.py --setup
python3 -B verification/check_audition.py --output "$(mktemp -d)/audition-proof"
cargo +1.93.0 test --manifest-path src-tauri/Cargo.toml --locked --lib audition
```

The Rust tests need the core sibling at `funkot-core.commit`
(`scripts/check-funkot-core-commit.sh` checks it). CI runs the TLC check in the
`Source switch model` job and uploads `audition-proof`.

PASS means `summary.json` has `"status": "PASS"`: the baseline explored the whole
graph with no violation, and each mutation in `MUTATIONS` produced its expected
counterexample. A missing Java, a wrong jar hash or a dirty checkout fails; never
report that as a pass.

## Read a failure

Read every TLC result with the `/statechart` skill. It tells each invariant
violation as its shortest path in plain words, and with a fix model it shows which
violations the fix removes.

- Baseline violation after a product change: replay the path against the code. If
  the code really takes those steps, it is a product bug; report it with the steps,
  and do not weaken the rule or the model.
- Baseline violation that the code cannot take: the model drifted. Find the action
  whose guard or line comment no longer matches the code and fix the model.
- A mutation that no longer fails: the rule or the mutation lost its teeth. Fix the
  model so that the pre-#115 behavior (`Serialize = FALSE` or
  `RestoreOnFailure = FALSE`) breaks it again.
- `sensitivity edit no longer matches`: `Audition.cfg` changed shape; update the
  edits in `MUTATIONS`.

The two Rust tests are the code-level half of the check.
`failed_audition_prepare_restores_the_listeners_pause` fails if a failed prepare
unmutes instead of restoring. `overlapping_audition_work_refuses_resume_and_pause`
fails if `resume_autodj` or `toggle_pause` stops taking `AUDITION_LOCK`. TLC alone
cannot see such a code change, because the model is written by hand.

## Update for an intended change

Change the code, then the matching model action and its line comment, in the same
task. If the change adds a step that releases or takes the lock, or writes one of
the flags above, add it as its own action. Rerun the check, read the result with
`/statechart`, and move the sync commit.

## Scope

Bounds: two audition requests that may repeat, repeated resume and pause presses,
both initial pause states. The main engine already exists. A cold start is the same
as a queue the listener has not asked to play. The model leaves out title parking
in `AuditionSession`, stale audition events in `events_thread`, skip, and
output-device loss. The Android `onNativeControl` pause actions take the same lock
but are not separate model actions. The audio callback's pause store when the main
engine finishes is outside the lock and outside the model. A pass covers the model,
not the audio callback or the UI polling.
