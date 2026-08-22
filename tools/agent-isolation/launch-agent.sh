#!/usr/bin/env bash
set -euo pipefail
agent=funkot-agent
workspace=/srv/funkot-agent/funkot-player
if (( $# == 0 )); then echo "Usage: $0 <command> [arguments...]" >&2; exit 2; fi
exec sudo -iu "$agent" -- env -i \
  HOME="/home/$agent" USER="$agent" LOGNAME="$agent" SHELL=/bin/bash \
  PATH="/home/$agent/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  XDG_CONFIG_HOME="/home/$agent/.config" XDG_DATA_HOME="/home/$agent/.local/share" XDG_STATE_HOME="/home/$agent/.local/state" \
  CODEX_HOME="/home/$agent/.codex" CLAUDE_CONFIG_DIR="/home/$agent/.claude" \
  bash --noprofile --norc -c 'cd "$1"; shift; exec "$@"' bash "$workspace" "$@"
