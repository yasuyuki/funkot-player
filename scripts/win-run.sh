#!/bin/sh
# Usage: ./scripts/win-run.sh [-Launch] [-ForceBuild]
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
ENGINE=$(CDPATH= cd -- "$ROOT/../funkot-autodj-for-ui" && pwd)

WIN_PLAYER=/mnt/c/src/funkot-player
WIN_ENGINE=/mnt/c/src/funkot-autodj-for-ui
# Keep stamp on the WSL filesystem — /mnt/c writes are flaky (perms / UTF-16).
STAMP=$ROOT/.win-run.stamp
EXE=/mnt/c/funkot-player-test/funkot-player.exe
RELEASE=$WIN_PLAYER/src-tauri/target/release/funkot-player.exe
PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe

LAUNCH=0
FORCE=0
for arg in "$@"; do
	case $arg in
	-Launch) LAUNCH=1 ;;
	-ForceBuild) FORCE=1 ;;
	*)
		echo "Usage: ./scripts/win-run.sh [-Launch] [-ForceBuild]" >&2
		exit 1
		;;
	esac
done

# /mnt/c is drvfs with automount fmask=11 and uid of the WSL default user.
# Cursor/SSH as another user can *see* Windows but cannot exec powershell or
# write C:\src — rsync then dumps hundreds of Permission denied lines that
# look like a broken mount. Fail before syncing.
require_windows_host() {
	c_owner=$(stat -c '%U' /mnt/c 2>/dev/null || echo 'the /mnt/c owner')
	me=$(id -un)
	if [ ! -e "$PS" ]; then
		echo "win-run: Windows is not mounted ($PS missing)." >&2
		exit 1
	fi
	if [ ! -x "$PS" ]; then
		echo "win-run: cannot execute powershell.exe as $me (file owned by $c_owner)." >&2
		echo "This is not a disconnected mount. Open a WSL terminal as $c_owner" >&2
		echo "(Windows Terminal / Ubuntu; not this Cursor SSH session) and run:" >&2
		echo "  cd $ROOT && ./scripts/win-run.sh" >&2
		exit 1
	fi
	if [ ! -d "$WIN_PLAYER" ] || [ ! -w "$WIN_PLAYER" ] || [ ! -w "$WIN_ENGINE" ]; then
		echo "win-run: cannot write Windows mirrors as $me:" >&2
		echo "  $WIN_PLAYER" >&2
		echo "  $WIN_ENGINE" >&2
		echo "Run the same command from a WSL terminal as $c_owner." >&2
		exit 1
	fi
}

require_windows_host

run_ps() {
	"$PS" -NoProfile -ExecutionPolicy Bypass \
		-File 'C:\src\funkot-player\scripts\win-build.ps1' "$@"
}

# Ensure Windows mirror has the latest deploy script (not part of source fingerprint).
sync_build_script() {
	mkdir -p "$WIN_PLAYER/scripts"
	rsync -a "$ROOT/scripts/win-build.ps1" "$WIN_PLAYER/scripts/win-build.ps1"
}

run_deploy() {
	sync_build_script
	if [ "$LAUNCH" -eq 1 ]; then
		run_ps -DeployOnly -Launch
	else
		run_ps -DeployOnly
	fi
}

# Build-affecting sources: path size mtime → sha256.
fp_player=$(
	{
		find "$ROOT/src" -type f -printf '%p %s %T@\n'
		find "$ROOT/src-tauri" \
			\( -path "$ROOT/src-tauri/target" -o -path "$ROOT/src-tauri/gen/android" \) -prune -o \
			-type f -printf '%p %s %T@\n'
		find \
			"$ROOT/package.json" \
			"$ROOT/package-lock.json" \
			"$ROOT/index.html" \
			"$ROOT/vite.config.ts" \
			"$ROOT/svelte.config.js" \
			"$ROOT/tsconfig.json" \
			-printf '%p %s %T@\n'
	} | sort | sha256sum | awk '{ print $1 }'
)
fp_engine=$(
	find "$ENGINE/funkot-core" \
		\( -path "$ENGINE/funkot-core/target" \) -prune -o \
		-type f -printf '%p %s %T@\n' |
		sort | sha256sum | awk '{ print $1 }'
)
fp=$(printf '%s\n' "$fp_player" "$fp_engine" | sha256sum | awk '{ print $1 }')

if [ "$FORCE" -eq 0 ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$fp" ] && [ -f "$RELEASE" ]; then
	if [ -f "$EXE" ] && [ ! "$RELEASE" -nt "$EXE" ]; then
		echo "OK: unchanged, skip build"
		if [ "$LAUNCH" -eq 1 ]; then
			"$PS" -NoProfile -Command "Start-Process 'C:\funkot-player-test\funkot-player.exe'"
		fi
		exit 0
	fi
	# Build ok previously (stamp set) but deploy missing/outdated — e.g. copy failed while exe locked.
	echo "OK: unchanged sources, deploy only"
	run_deploy
	exit 0
fi

# Sync WSL → Windows mirrors. --delete without --delete-excluded keeps
# Windows-side target/ and node_modules/ (they are excluded from transfer).
rsync -a --delete \
	--exclude '.git/' \
	--exclude 'src-tauri/target/' \
	--exclude 'node_modules/' \
	--exclude '.desktop-data/' \
	--exclude 'packaging/msix/out/' \
	--exclude 'packaging/msix/staging/' \
	--exclude 'testdata/' \
	--exclude 'dist/' \
	--exclude 'HANDOFF.md' \
	--exclude '.win-run.stamp' \
	"$ROOT/" "$WIN_PLAYER/"

rsync -a --delete \
	--exclude '.git/' \
	--exclude 'target/' \
	--exclude 'testdata/' \
	--exclude 'dist/' \
	--exclude 'HANDOFF.md' \
	"$ENGINE/" "$WIN_ENGINE/"

# Build first, stamp on success, then deploy. Copy failure must not force a rebuild next time.
run_ps -BuildOnly
printf '%s\n' "$fp" >"$STAMP"
run_deploy
