---
executor: subject
handoff: owner-sudo
---

# Phase 01: rootless Docker prerequisites

## Objective

Verify rootless prerequisites as funkot-agent and reduce privileged work to one
owner-approved package and linger command.

## Scope

- Agent probes Docker, rootlesskit, newuidmap, newgidmap, systemd user manager,
  subuid, and subgid using the deterministic subject environment.
- Owner installs only missing uidmap and systemd-container packages and enables
  linger for funkot-agent.
- Agent reruns the probe and reports pass/fail.

## Out of scope

- Docker daemon setup, Docker group membership, owner daemon changes, SSH,
  application builds, image pulls, and release/signing work.

## Related files or subsystems

- tools/agent-isolation/launch-agent.sh
- tools/agent-isolation/verify-isolation.sh
- /etc/subuid, /etc/subgid, systemd user manager

## Constraints and invariants

- Host: WSL Ubuntu. Owner launch directory:
  /home/yasuyuki/releases/foundation-n-plus-17/funkot-player.
- No shell startup file, sudo/docker/owner group membership, or owner socket.
- Stop at the sudo boundary and report its exact command.

## Acceptance criteria

- Agent identity/home are funkot-agent and /home/funkot-agent.
- Required rootless commands exist and subuid/subgid grant at least 65536 IDs.
- Linger is enabled and verify-isolation.sh remains all PASS.

## Required verification commands

~~~bash
cd /home/yasuyuki/releases/foundation-n-plus-17/funkot-player
tools/agent-isolation/verify-isolation.sh "$PWD"
tools/agent-isolation/launch-agent.sh id -un
tools/agent-isolation/launch-agent.sh sh -c 'printf "%s\n" "$HOME"'
~~~

## Report format

Report capability names and pass/fail plus the owner sudo boundary. Do not print
credentials, raw PATH, or Docker configuration.
