---
executor: subject
handoff: none
---

# Phase 02: agent rootless Docker daemon

## Objective

Initialize a rootless Docker daemon and CLI context owned by funkot-agent.

## Scope

- Agent installs rootless Docker, enables the user service, selects the
  rootless context, and verifies the agent-local socket.

## Out of scope

- Owner Docker/socket changes, Docker group membership, privileged containers,
  host networking, SSH setup, application builds, and release/signing work.

## Related files or subsystems

- tools/agent-isolation/launch-agent.sh
- /home/funkot-agent/.config/docker
- /home/funkot-agent/.local/share/docker
- /run/user/<agent-uid>/docker.sock

## Constraints and invariants

- Host: WSL Ubuntu. Agent launch directory:
  /srv/funkot-agent/funkot-player.
- Use a proper funkot-agent systemd session, never root/default WSL user.
- Never set DOCKER_HOST to /var/run/docker.sock or add docker/sudo membership.

## Acceptance criteria

- docker info reports Context rootless and a rootless security option.
- Socket/context/data are agent-owned and verify-isolation.sh remains all PASS.
- docker context and docker info work through launch-agent.sh.

## Required verification commands

~~~bash
cd /home/yasuyuki/releases/foundation-n-plus-17/funkot-player
tools/agent-isolation/verify-isolation.sh "$PWD"
tools/agent-isolation/launch-agent.sh docker context ls
tools/agent-isolation/launch-agent.sh docker info
~~~

## Report format

Report context name, rootless status, socket ownership boundary, test result,
and commit SHA. Never print Docker config, credentials, raw PATH, or logs.
