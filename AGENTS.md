# AI workspace boundary

AI tools may change only the `funkot-player` member declared by the selected
`funkot-dev` working set's common-parent `WORKING-SET.json`. Resolve the member
from that manifest; do not hard-code an absolute path or substitute another
checkout. Start tool entry points from the common parent and read this file
before changing the member.

Before changing API, CLI, configuration, or persistent-data contracts, follow
[the compatibility and data migration policy](docs/development-setup.md#compatibility-and-data-migration).

## Registered branch work

While `agent-branches/state.json` is in the Git common directory, register work
with the public agent-rules command `branch begin`. `workspace-lifecycle begin`
refuses this registry. After GitHub merges the topic into the registered remote
destination, record that merge with `branch accept-remote-merge`, then remove
the worktree with `branch retire`. Those commands and their refusals are in
that source's README, under "Registered work and branch enforcement".

This interactive working-set boundary is separate from isolated
`wsl-agent-lifecycle` clone management. Do not access `.secrets/`, copy
authentication, or handle signing material. Android builds, signing, Docker

For UI verification and UI/layout/interaction changes, use [.claude/skills/ui-design/SKILL.md](.claude/skills/ui-design/SKILL.md)
and [docs/ui-design.md](docs/ui-design.md) before implementation and for rendered-screen review.
The skill defines the lightweight exception for changes with no layout or hierarchy impact.
When a change touches `src-tauri/src/engine_observation.rs`, a publish of that observation, or `verification/engine_snapshot`, including a condition-only edit or a rename, use [.claude/skills/verify-engine-snapshot/SKILL.md](.claude/skills/verify-engine-snapshot/SKILL.md).
When a change touches transition audition, `resume_autodj`, pause transport or `verification/audition`, use [.claude/skills/verify-audition/SKILL.md](.claude/skills/verify-audition/SKILL.md).
When a change touches `src-tauri/src/playback_recovery.rs`, its call sites in `playback_state.rs`, `verification/playback_recovery.rs`, `verification/check.py`, or `.claude/skills/verify-playback-recovery/`, use [.claude/skills/verify-playback-recovery/SKILL.md](.claude/skills/verify-playback-recovery/SKILL.md).

When a change touches source-switch or startup transaction ordering in `src-tauri/src/playlist_service.rs`, queue/session publication, or `verification/source_switch`, use [verification/source_switch/SKILL.md](verification/source_switch/SKILL.md).
