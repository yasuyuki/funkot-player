---
executor: subject
handoff: owner-sudo
---

# Phase 01: agent SSH endpoint

## Objective

Provision a loopback-only SSH endpoint for funkot-agent so a Windows Cursor
Remote SSH authority can select that user explicitly in the existing Ubuntu
distro.

## Scope

- Agent probes openssh-server availability, service status, current listener,
  and the funkot-agent account without reading credentials.
- Owner installs and enables openssh-server only if absent.
- Configure the endpoint to listen on loopback only and authenticate
  funkot-agent with a newly created agent-local credential.
- Verify Windows can reach the named SSH authority as funkot-agent and that
  the remote workspace is /srv/funkot-agent/funkot-player.
- Add only credential-free launcher/config fields required by the Windows
  Remote SSH phase.

## Out of scope

- WSL distro/default-user changes, owner SSH login, password/key copying,
  forwarding the owner Docker socket, public-network SSH exposure, and
  local/UNC Cursor workspaces.
- Rootless Docker changes, agent application changes, signing, release, or
  owner checkout access.

## Related files or subsystems

- /etc/ssh/sshd_config and systemd ssh.service
- /home/funkot-agent/.ssh
- Windows SSH config and cursor-isolation-poc phase
  funkot-agent-remote-workspace/phase-01-remote-ssh-launcher.md
- /srv/funkot-agent/funkot-player

## Constraints and invariants

- Host: WSL Ubuntu. Owner launch directory:
  /home/yasuyuki/releases/foundation-n-plus-17/funkot-player.
- Bind SSH only to 127.0.0.1 and/or ::1; do not expose a LAN listener.
- The agent creates its own SSH credential; never copy owner keys, config, or
  authentication state.
- Permit only funkot-agent for this endpoint and keep owner checkout/home
  inaccessible through Unix permissions.
- Human work is limited to the explicit owner sudo command and agent-local
  credential approval. All probes and verification are agent delegated.

## Acceptance criteria

- ssh.service is enabled and listening only on loopback.
- The configured Windows authority authenticates as funkot-agent.
- A remote command reports id -un as funkot-agent and pwd as
  /srv/funkot-agent/funkot-player.
- The agent cannot traverse owner home, read .secrets, use sudo, or access the
  owner Docker socket.
- No private key, password, known_hosts content, or SSH config secret is
  printed, copied, or committed.

## Required verification commands

~~~bash
cd /home/yasuyuki/releases/foundation-n-plus-17/funkot-player
tools/agent-isolation/verify-isolation.sh "$PWD"
sudo systemctl is-active ssh
sudo ss -ltnp | grep ':2222'
~~~

## Report format

Report service state, listener scope, remote identity/workspace, isolation
result, changed credential-free files, and commit SHA. Do not report SSH
credentials, host keys, known-hosts records, or raw SSH config.
