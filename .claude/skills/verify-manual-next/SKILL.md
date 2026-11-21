---
name: verify-manual-next
description: >-
  Model-check Funkot Player's Next button (a manual skip from the screen, the
  notification or the verification control) with TLC after any change to
  request_skip_next, press_manual_next, dispatch_manual_next,
  publish_next_state, forget_discarded_manual_next, commit_future_update_on,
  revoke_reserved_on, next_dispatch_ready, the LIBRARY_ANALYSIS_BUSY handshake
  in spawn_analysis_worker, the MANUAL_NEXT_* or NEXT_PREPARED atomics, or
  verification/manual_next. Also use it to draw a Next button violation.
---
# Verify the Next button

A press of Next has no single owner in `src-tauri/src/lib.rs`. Shared atomics
carry it across threads:

- `press_manual_next` (under `MANUAL_NEXT_REQUEST_LOCK`) records the current
  track in `MANUAL_NEXT_EXPECTED_INDEX` and sets `MANUAL_NEXT_PENDING`.
- `dispatch_manual_next` (from the press, or from the `funkot-next-wait`
  thread that `request_skip_next` spawns) holds the render mutex while it
  checks the flag, the analysis, the engine's next and current track, sets
  `MANUAL_NEXT_IN_FLIGHT` and sends `TransitionToNext` on `nav_tx`. The
  message names no track, so the track must not change between the check and
  the send (#166).
- The audio callback's `publish_next_state` stores `NEXT_PREPARED` and clears
  both flags once the current track changed or the engine finished.
- `commit_future_update_on` (a saved list or queue change) and
  `revoke_reserved_on` (a manual track takes the next slot) call
  `forget_discarded_manual_next`.
- `spawn_analysis_worker` hands the CPU back and forth with
  `next_dispatch_ready` and `dispatch_manual_next` through
  `LIBRARY_ANALYSIS_BUSY`.

The engine in funkot-core is abstract in the model: one render drains the
channel (last command wins), then prepares the next track, starts or ends a
transition, or finishes.

## Rules

- `SentNextNotStuck`: a sent skip is on its way, accepted by the engine,
  resolved by a track change, or a press that owns the button will send again.
  Harm when broken: every press is ignored until the track ends by itself, and
  library analysis stalls (#154).
- `PressNotLost`: an accepted press still has a thread that will send it, or
  the track already changed. Harm when broken: the press vanishes and later
  presses are ignored.
- `OneTrackPerPress`: the engine accepts a skip only while the track it was
  pressed on is current. Harm when broken: one press also skips the next track.
- `NoSendDuringDecode`: no skip is sent while the analysis decodes a file.
  Harm when broken: the manual transition plan competes with the decode.

## Why dispatch holds the render mutex (#166)

Before #166, `dispatch_manual_next` checked the observation and then sent
without the mutex. A sender that stalled between the two while the track
changed sent a stale skip: the engine skipped the new track
(`OneTrackPerPress`), the skip arrived during a decode (`NoSendDuringDecode`),
or the sender's `MANUAL_NEXT_PENDING.store(false)` erased a press on the new
track and left `IN_FLIGHT` set (`SentNextNotStuck`). The `unlocked` break
restores that code and must still fail.

The `LIBRARY_ANALYSIS_BUSY` load inside the mutex is needed too: the caller's
`next_dispatch_ready` may have passed for an earlier press, before the
analysis started decoding. The `no_busy_check` break removes that load.

## When to use

Run when a diff touches any name in the description, adds or removes a write
to one of the atomics, or changes what `begin_nav`, `drain_nav_commands`,
`commit_future_update` or `revoke_next` in funkot-core do with a queued
`TransitionToNext`. Line moves alone do not need a run: model references are
scoped by function name, not line number.

Sync commit: `24995d2d2ce35f118566176b24da1ee71435db8b` (core pin
`e6d4916061b4d389d887ebe318b610267a00c5ca`). To see what changed since:

```sh
git diff 24995d2d2ce35f118566176b24da1ee71435db8b -- src-tauri/src/lib.rs src-tauri/src/playlist_service.rs funkot-core.commit
```

Read every hunk inside the functions named above. Move the sync commit forward
only after you confirm each model action and its `lib.rs:FN | FRAGMENT`
comment in `verification/manual_next/ManualNext.tla` still describes the code
at the new commit.

## Run

From the player root on Linux, Python 3.12+ and Java 25, on a clean committed
checkout (the runner archives `HEAD`):

```sh
python3 -B -m unittest discover -s verification -p 'test_manual_next.py'
python3 -B verification/check_source_switch.py --setup
python3 -B verification/check_manual_next.py --output "$(mktemp -d)/manual-next-proof"
```

`--setup` downloads the pinned TLC 1.7.4 jar into `~/.cache/funkot-verification`.
Pass `--jar` and `--java` when they live elsewhere. Each rule explores the
whole graph (about 950 thousand distinct states, seconds with 8 workers); the
variants stop at their counterexample. CI runs it in the
`Source switch model` job and uploads `manual-next-proof`.

Read `summary.json`:

- `PASS`: `FINDINGS` is empty, every rule holds over the whole graph, and each
  `Break` variant broke its rule.
- `KNOWN_FINDINGS`: every rule in `FINDINGS` still breaks, every other rule
  holds, and each variant broke its rule. Use `FINDINGS` only for a break
  reported as a product bug and still open.
- `FAIL` with `error`: read the message. Never report it as a pass.

`summary.json` also records the revision, source hashes, state counts and
`writers` (the writes to the shared atomics per function).

## Read a failure

Read every TLC log (`<rule>.log`, `<variant>.log`) with the `/statechart` skill
and `verification/manual_next/view.mjs`. It tells each violation as its
shortest path in plain words, one region for each thread.

- `expects fn X to contain ...` or `no longer defines`: the cited code changed.
  Read the function. Moved text with the same behavior needs only the fragment
  updated. Changed behavior needs the action updated first.
- `manual Next writers changed`: a write was added, removed or moved. Model it
  as its own action (one atomic load, store or send per action), then update
  `WRITERS`. Do not edit the count alone.
- `missing the required checked counterexample` on a rule in `FINDINGS`: that
  rule now holds. If the fix for that finding landed, model the fix and remove
  the rule from `FINDINGS`. Otherwise the model drifted.
- `missing the required checked counterexample` on a variant: the model no
  longer notices that break. Find which action stopped depending on it.
- `TLC did not finish the complete safety check` on a rule not in `FINDINGS`:
  a new break. Replay the path against the code, one step per action: copy the
  checkout, add a `#[cfg(test)]` hook where the path stalls a thread, and drive
  the real `Engine` with the callback helper from `manual_next_discard_tests`.
  If the code takes those steps, report a product bug with the path. If it
  cannot, the model drifted: fix the action that differs. Do not weaken a
  rule, and do not add a finding to make the run green.

## Update for an intended change

Change the code, then the matching action, its `lib.rs:FN | FRAGMENT` comment,
`SOURCE_REFERENCE_COUNT` and `WRITERS` in `verification/check_manual_next.py`,
in the same commit. An action is one atomic load, store, fetch_add or
try_send, or one section under the render mutex; split a read-then-write into
two actions. Rerun, read the result with `/statechart`, and move the sync
commit.

No statechart is committed: the full graph is far above the chart budget,
and the bug-path charts were removed with the #166 fix. To draw a violation,
run `/statechart` on its TLC log with `verification/manual_next/view.mjs`.

## Scope

Bounds (`ManualNext.cfg`): two presses, two threads that can run a press or a
wait loop at the same time, three tracks, one saved change (commit or failure),
one manual-priority revoke, one file for the analysis, and every interleaving.
The VIEW `Live` ignores thread locals that are always written before they are
read.

Left out: pause (a paused, silent callback renders nothing), audition (skip is
refused), labeling mode, the wait thread's phase check, a full or disconnected
navigation channel, the error paths of `request_skip_next`, `wait_out_startup`,
the preview upgrade in core (it re-accepts a queued request since `e6d4916`),
and the memory ordering of the atomics. TLC explores sequentially consistent
interleavings only. `LIBRARY_ANALYSIS_BUSY` uses Release stores and Acquire
loads, which on their own do not order a store before a later load of another
atomic, so the analysis handshake is not verified on weakly ordered CPUs.

The model is written by hand. The source and writer checks catch renamed or
moved code and new writes, but not a changed meaning inside a cited function,
so keep the action audit above.
