---
executor: subject
handoff: owner-review
---

# Phase 03: agent Docker development smoke

## Objective

Prove that agent-owned rootless Docker runs the non-signing development workflow
from independent player and engine clones.

## Scope

- Create the agent-owned funkot-autodj-for-ui clone from canonical remote.
- Run the documented npm build and Rust library test through launch-agent.sh.
- Report exit status and the owner review command.

## Out of scope

- Owner checkout mounts, ADB/GUI host networking, release builds, signing,
  cleanup, and merging changes.

## Related files or subsystems

- /srv/funkot-agent/funkot-player/dev.sh
- /srv/funkot-agent/funkot-autodj-for-ui
- tools/agent-isolation/launch-agent.sh

## Constraints and invariants

- Host: WSL Ubuntu. Agent launch directory:
  /srv/funkot-agent/funkot-player.
- Engine checkout is an agent-owned canonical clone and dev.sh mounts it
  read-only. Do not run ADB=1, GUI=1, or a release build.

## Acceptance criteria

- Both clones are agent-owned and have no .secrets directory.
- npm build and Rust library test exit 0 through launch-agent.sh.
- Owner Docker socket and signing boundary remain inaccessible.

## Required verification commands

~~~bash
cd /home/yasuyuki/releases/foundation-n-plus-17/funkot-player
tools/agent-isolation/launch-agent.sh ./dev.sh npm run build
tools/agent-isolation/launch-agent.sh ./dev.sh cargo test --manifest-path src-tauri/Cargo.toml --lib
tools/agent-isolation/verify-isolation.sh "$PWD"
~~~

## Report format

Report clone identities, exit status, isolation result, owner review command,
and commit SHA. Do not print credentials, raw PATH, or container logs.
