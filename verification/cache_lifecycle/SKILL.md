---
name: verify-funkot-test-cache
description: Verify Funkot Player native child-test cache isolation after changes to isolated_source_fixture, the adopted core, child working directories, wait/cleanup ordering, or verification/cache_lifecycle.
---
# Verify native test cache ownership

Use the selected `funkot-player` working-set member. The shared editing source
is `agent-rules/skills/verify-funkot-test-cache/SKILL.md`; the player's
`verification/cache_lifecycle/SKILL.md` is its byte-identical distribution.
Update both together. The last product synchronization is
`49597f0062ebda6abe5395397133713934376b73`, which isolates fixture working directories.
Advance that anchor only after checking every intervening change to the covered
code and confirming that the model still describes it.

The promise is that a child fixture's relative cache stays in its parent's
temporary directory until the child exits, then disappears with that directory.
Breaking it leaves checkout files behind and prevents normal task completion.

## Run and judge

From the player root on Linux, use Java 21 and Python 3.12 or later:

```sh
python3 -B verification/check_cache_lifecycle.py --setup
python3 -B verification/check_cache_lifecycle.py
```

The ordinary check archives the clean committed player and selected adopted core.
It rejects a dirty or mismatched core and records both revisions and source hashes.
It reuses the existing
TLC 1.7.4 hash, runner deadline and result validator. Read `summary.json` and all
three logs. Ownership must pass; inherited-cwd and early-cleanup variants must
produce `CacheOwnership` counterexamples. A timeout, compiler/tool failure,
missing result, or incomplete positive exploration is a failure.

Read every TLC result with `/statechart`. Use that skill's current instructions
and `verification/cache_lifecycle/view.mjs`; do not copy its launcher into this
project. Replay a counterexample against the Rust helper before calling it a
product defect. A model/code mismatch is verification drift.

Also run the normal native library tests through the environment's existing
development entry. All tests must pass, and `git status --porcelain --ignored`
must contain no `funkot-cache`. Keep pre-existing files intact; use a clean
isolated checkout if a cache already exists.

## Coverage and detection

`src-tauri/src/playlist_service/tests.rs::isolated_source_fixture` maps to
`Allocate`, `Spawn`, `ExitChild`, and `RemoveScratch`. Its parent owns the
`TempDir`, sets the child's cwd, waits for process exit, and explicitly closes
the directory. `ReturnFromTest` permits a detached loader to write after the
test body returns. Process exit terminates those threads; Engine drop alone
does not. The adopted core's `EngineOptions::default`, `loader_main_mode`,
`prepare_first_live`, and `Engine::drop` supply those adapter facts.
Those core facts were checked at `a5fa36a399c9f09ecbd7638ce4f144b016d059f7`.
Recheck them when `funkot-core.commit` changes.

The bound is two simultaneous child fixtures, distinct temporary directories,
one possible cache write per child, and every ordering of body return, write,
exit and cleanup. Repeated writes do not change the ownership state. Successful
directory creation, spawn, pipe IO, wait and cleanup are assumptions. Parent
termination, IO failure, descendants that outlive a child, absolute-path writes,
real profiles, and production playback shutdown are outside this model.

On an isolated copy of the actual source, remove only
`.current_dir(directory.path())`. Run
`playlist_service::tests::isolated_source_fixture_keeps_relative_cache_outside_checkout`
with the native lib test's `--exact` selector. It must fail with
`fixture child wrote its relative cache into the checkout`.
The real decoder path is
`uncached_non_funkot_first_candidate_is_analysed_before_source_returns`.
Discard the scratch variant and rerun the unchanged source. A build failure or
zero selected tests does not demonstrate detection.

The regression runs in the existing Linux and Windows native CI. The model
runs in the existing Java-backed Checks job. Results belong in player Issue
#80. After a covered change skipped this check, use
`/maintain-formal-verification-skill` to reassess model/code synchronization.
