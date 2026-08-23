# Agent-isolation phase execution review material

Date: 2026-08-23

## Purpose

This document records failures observed while executing
`funkot-agent-rootless-docker` phases 02 and 03. It is source material for an
independent reviewer to produce an improvement plan. It does not prescribe or
implement that plan.

## Intended contract

The requested work was to execute only the named phase as `funkot-agent`, run
its required verification, update the phase index and `HANDOFF.md`, and commit
the verified documentation change. The owner should have been involved only at
an unavoidable privilege or review boundary.

## Result

Both phases eventually passed. Rootless Docker uses the `rootless` context and
the agent-owned socket at `/run/user/1001/docker.sock`. The documented npm build
and Rust library test exited successfully, isolation verification passed, and
owner review found no tracked change in the agent player clone.

The path to that result imposed substantially more manual work on the user than
the contract required.

## Observed problems

### The execution boundary was discovered repeatedly instead of once

`tools/agent-isolation/launch-agent.sh` calls `sudo -iu funkot-agent`. The
user's `sudo -v` in one terminal did not authorize the separate PTY used by the
agent. The agent attempted the same boundary again after this was already
known, then repeatedly transferred subject commands to the user.

The initial request to run `sudo -v` was ineffective. A preflight should have
established whether the active execution channel could invoke the launcher and
then selected one stable mechanism for the whole phase.

### Long commands sent through chat were fragile

Commands containing multiline quoted shell programs were visually wrapped or
pasted with embedded whitespace. This corrupted `XDG_RUNTIME_DIR` into
`/run/user/  1001` and previously caused subsequent commands to become
arguments to `export`.

The agent continued sending long commands after the first wrapping failure.
The user later had to state explicitly that long output commands were being
broken. A short checked-in or temporary driver script should have been created
at the first unavoidable owner boundary.

### Commands were not validated against launcher semantics

Several transferred commands failed for reasons unrelated to the phase:

- a nested shell printed an empty saved exit code and attempted `exit` with a
  non-numeric argument;
- owner-side redirection could not overwrite an agent-owned file in `/tmp`;
- a nested shell resolved `./dev.sh` from `/home/funkot-agent` rather than the
  required agent workspace;
- the first final-verification helper invoked `git remote` without an explicit
  `-C` and failed outside a Git worktree.

These failures were defects in the orchestration commands, not in rootless
Docker or the application.

### The documented first-time workflow was read too late

Phase 03 required `./dev.sh npm run build`, but the repository's first-time
verification sequence first runs `./dev.sh npm install`. The agent attempted
the build before reading that sequence, producing `vite: not found` and another
user round trip.

The smallest reliable preparation was discoverable in
`docs/development-setup.md` before running the smoke test.

### The engine revision was not established before testing

The fresh engine clone's default branch was incompatible with the player and
the Rust test reported missing engine methods and fields. The agent then:

- inferred `player/v0.1.6` from an existing owner checkout;
- asked the user to check out a tag absent from the fresh clone;
- asked the user to fetch a historical commit that the canonical remote no
  longer advertised;
- finally used the current canonical `feat/player-ui` head,
  `767f86df6417e0384a9fd6f612c5b6c32b71f1cc`, which passed.

The existing owner checkout had stale remote-tracking history, so it was not a
reliable statement of what a fresh canonical clone could fetch. The phase also
did not declare the engine ref needed by the player smoke test. This is an
apparatus ambiguity that should be addressed by the review plan.

### Verification was fragmented into many user actions

Clone creation, dependency installation, build, test, ownership checks, remote
identity checks, secret-directory checks, and isolation verification were
provided as separate interactive commands. Some were repeated after command
construction failures.

The final helper script demonstrated that the required owner-mediated work
could instead be represented by one short command with deterministic paths and
exit propagation. That mechanism was introduced only near the end.

### Completion was reported before the handoff was proven

The phase was initially reported complete with an owner review command. That
command failed because the current owner shell had not loaded its configured
`funkot-review` supplementary group. The review succeeded only after wrapping
the command with `sg funkot-review -c`.

Completion should not have been reported until the declared `owner-review`
handoff command had itself been exercised successfully in the current session.

### Log handling approached the report boundary unnecessarily

The phase says not to print container logs. Logs were redirected to `/tmp`,
which was appropriate, but the user was later asked to print selected log
content for diagnosis. The excerpts were limited to error evidence, yet a
better driver could classify common failures and print only a sanitized summary
by default.

## User operations that should not have been necessary

The following work arose from orchestration defects or late discovery rather
than from an inherent owner boundary:

- refreshing `sudo` in a terminal that could not authorize the agent PTY;
- retrying rootless setup after chat wrapping corrupted its environment;
- retrying npm build because exit-code capture, redirection ownership, and
  working-directory handling were incorrect;
- diagnosing the missing npm installation after the build was attempted;
- trying unavailable engine tags and commits;
- running fragmented identity and isolation checks;
- retrying final verification after its helper omitted an explicit repository
  path;
- retrying owner review because the current-session group state was not checked
  first.

The unavoidable user action was authentication at the owner-to-subject sudo
boundary, given the current launcher design and isolated PTYs. The surrounding
workflow could have been prepared and validated so that this boundary was
crossed once through a short command.

## Evidence and present state

- Phase 02 index commit: `bd51e61`
- Phase 03 index commit: `df4b569`
- Engine smoke commit: `767f86df6417e0384a9fd6f612c5b6c32b71f1cc`
- npm install: exit 0
- npm build: exit 0
- Rust library test: exit 0
- isolation verifier: all checks passed
- owner review through `sg funkot-review`: exit 0 with no diff
- phase 03 diagnostic logs and the temporary final-verification helper were
  placed under `/tmp` and were not committed

## Questions for the independent reviewer

- What single phase driver should own preflight, subject execution, sanitized
  reporting, and exit propagation?
- How should the owner authenticate once without granting the subject sudo or
  exposing an owner Docker socket?
- Where should the compatible engine ref be declared so a fresh clone is
  deterministic?
- Should `launch-agent.sh` guarantee its documented working directory even for
  nested shell commands, and how should that contract be tested?
- How should current-session `funkot-review` membership be preflighted before
  advertising an owner review command?
- Which failure summaries may be printed while retaining the prohibition on
  raw container logs and configuration output?
- Which automated test proves that chat line wrapping cannot alter a required
  command?

## Constraints the improvement plan must preserve

- The agent remains non-sudo and cannot access the owner Docker socket or
  signing directory.
- Subject work runs only as `funkot-agent` in
  `/srv/funkot-agent/funkot-player`.
- The engine clone remains an independent canonical clone and is mounted
  read-only by `dev.sh`.
- Owner signing, release, ADB, GUI, and privileged Docker work stay out of the
  subject workflow.
- Credentials, Docker configuration, raw PATH values, and raw container logs
  are not printed or committed.
- A phase remains individually authorized by its named phase file.
