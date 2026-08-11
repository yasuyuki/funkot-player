#!/bin/sh
# WSL entry for scripts/win-profile-guard.ps1
#
# Usage:
#   ./scripts/win-profile-guard.sh -Backup
#   ./scripts/win-profile-guard.sh -Restore
#   ./scripts/win-profile-guard.sh -Run -ReplaceBackup
#   ./scripts/win-profile-guard.sh -Run -ReplaceBackup -InPlace
#   ./scripts/win-profile-guard.sh -Run -ReplaceBackup -SkipCache
#
# Typical Store-like verify (empty profile, demos only, restore on close):
#   ./scripts/win-run.sh
#   ./scripts/win-profile-guard.sh -Run -ReplaceBackup
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
WIN_PLAYER=/mnt/c/src/funkot-player
PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe

if [ "$#" -eq 0 ]; then
	echo "Usage: $0 -Backup | -Restore | -Run [-ReplaceBackup] [-InPlace] [-SkipCache] [-Exe PATH]" >&2
	exit 1
fi

mkdir -p "$WIN_PLAYER/scripts"
rsync -a "$ROOT/scripts/win-profile-guard.ps1" "$WIN_PLAYER/scripts/win-profile-guard.ps1"

exec "$PS" -NoProfile -ExecutionPolicy Bypass \
	-File 'C:\src\funkot-player\scripts\win-profile-guard.ps1' "$@"
