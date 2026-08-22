#!/usr/bin/env bash
set -euo pipefail
agent=funkot-agent
review_group=funkot-review
agent_root=/srv/funkot-agent
if (( EUID != 0 )); then echo "Run with sudo: sudo $0 <owner-checkout> <canonical-remote>" >&2; exit 2; fi
if (( $# != 2 )); then echo "Usage: $0 <owner-checkout> <canonical-remote>" >&2; exit 2; fi
owner_repo=$(readlink -f -- "$1")
remote=$2
owner=${SUDO_USER:-}
if [[ -z $owner || $owner == root ]]; then echo "Run through sudo from the checkout owner." >&2; exit 2; fi
if [[ ! -d $owner_repo/.git || ! -d $owner_repo/.secrets ]]; then echo "Owner checkout or its protected signing directory is missing." >&2; exit 1; fi
if [[ $(sudo -u "$owner" git -C "$owner_repo" remote get-url origin) != "$remote" ]]; then echo "The supplied remote is not origin for the owner checkout." >&2; exit 1; fi
if [[ -e $agent_root/funkot-player ]]; then echo "Refusing to reuse an existing agent clone: $agent_root/funkot-player" >&2; exit 1; fi
getent group "$review_group" >/dev/null || groupadd --system "$review_group"
if ! id -u "$agent" >/dev/null 2>&1; then useradd --create-home --shell /bin/bash "$agent"; fi
usermod -G "$review_group" "$agent"
usermod -aG "$review_group" "$owner"
owner_home=$(getent passwd "$owner" | cut -d: -f6)
chmod 750 "$owner_home" "$owner_repo"
chmod 700 "$owner_repo/.git" "$owner_repo/.secrets"
install -d -o "$agent" -g "$review_group" -m 2750 "$agent_root"
runuser -u "$agent" -- env -i HOME="/home/$agent" USER="$agent" LOGNAME="$agent" PATH="/home/$agent/.local/bin:/usr/local/bin:/usr/bin:/bin" git clone --no-local "$remote" "$agent_root/funkot-player"
chown -R "$agent:$review_group" "$agent_root/funkot-player"
chmod -R o-rwx "$agent_root/funkot-player"
chmod -R g+rX "$agent_root/funkot-player"
find "$agent_root/funkot-player" -type d -exec chmod g+s {} +
printf '%s\n' "Provisioned $agent_root/funkot-player for $agent. Run tools/agent-isolation/verify-isolation.sh $owner_repo next."
