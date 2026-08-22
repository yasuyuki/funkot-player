#!/usr/bin/env bash
set -euo pipefail
agent=funkot-agent
workspace=/srv/funkot-agent/funkot-player
if (( $# != 1 )); then echo "Usage: $0 <owner-checkout>" >&2; exit 2; fi
owner_repo=$(readlink -f -- "$1")
secret_dir="$owner_repo/.secrets"
as_agent() { sudo -iu "$agent" -- env -i HOME="/home/$agent" USER="$agent" LOGNAME="$agent" PATH="/home/$agent/.local/bin:/usr/local/bin:/usr/bin:/bin" "$@"; }
as_agent test ! -r "$secret_dir"
as_agent test ! -x "$secret_dir"
as_agent test ! -e "$workspace/.secrets"
if as_agent sudo -n true 2>/dev/null; then echo "Agent unexpectedly has passwordless sudo." >&2; exit 1; fi
as_agent test ! -r /var/run/docker.sock
as_agent test ! -w /var/run/docker.sock
if as_agent id -nG | tr " " "\n" | grep -Eq "^(sudo|docker|yasuyuki)$"; then echo "Agent has a forbidden supplementary group." >&2; exit 1; fi
as_agent git -C "$workspace" remote get-url origin >/dev/null
printf '%s\n' "PASS: protected signing directory is neither readable nor traversable by the agent." "PASS: agent clone has no signing directory." "PASS: agent has neither sudo nor Docker-socket access." "PASS: agent clone is a Git checkout."
