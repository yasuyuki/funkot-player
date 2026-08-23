#!/bin/sh
# Usage: ./scripts/win-run.sh [-Launch] [-ForceBuild]
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
ENGINE=$(CDPATH= cd -- "$ROOT/../funkot-autodj-for-ui" && pwd)

WIN_PLAYER=/mnt/c/src/funkot-player
WIN_ENGINE=/mnt/c/src/funkot-autodj-for-ui
EXE=/mnt/c/funkot-player-test/funkot-player.exe
RELEASE=$WIN_PLAYER/src-tauri/target/release/funkot-player.exe
PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe

# Stamp prefers the WSL tree; this agent workspace is Docker-UID owned so
# yasuyuki cannot write it. Fall back to the Windows deploy dir.
STAMP=$ROOT/.win-run.stamp
if [ ! -w "$ROOT" ]; then
	mkdir -p /mnt/c/funkot-player-test
	STAMP=/mnt/c/funkot-player-test/.win-run.stamp
fi

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

require_windows_host() {
	c_owner=$(stat -c '%U' /mnt/c 2>/dev/null || echo 'the /mnt/c owner')
	me=$(id -un)
	if [ ! -e "$PS" ]; then
		echo "win-run: Windows is not mounted ($PS missing)." >&2
		exit 1
	fi
	if [ ! -x /init ]; then
		echo "win-run: /init missing (not WSL?)." >&2
		exit 1
	fi
	if [ ! -d "$WIN_PLAYER" ] || [ ! -w "$WIN_PLAYER" ] || [ ! -w "$WIN_ENGINE" ]; then
		echo "win-run: cannot write Windows mirrors as $me:" >&2
		echo "  $WIN_PLAYER" >&2
		echo "  $WIN_ENGINE" >&2
		echo "Run the same command as $c_owner (owns /mnt/c)." >&2
		exit 1
	fi
}

# SSH / systemd / Cursor sessions often lack WSL_INTEROP. Direct exec of a
# .exe then returns EINVAL ("Invalid argument"). Pick a live relay socket.
ensure_wsl_interop() {
	if [ -n "${WSL_INTEROP:-}" ] && [ -S "$WSL_INTEROP" ]; then
		return 0
	fi
	sock=
	for s in $(ls -t /run/WSL/*_interop 2>/dev/null); do
		[ -L "$s" ] && continue
		[ -S "$s" ] || continue
		pid=${s##*/}
		pid=${pid%_interop}
		[ -d "/proc/$pid" ] || continue
		sock=$s
		break
	done
	if [ -z "$sock" ]; then
		echo "win-run: no live WSL interop socket in /run/WSL." >&2
		exit 1
	fi
	WSL_INTEROP=$sock
	export WSL_INTEROP
}

# CreateProcess fails with EINVAL if CWD is a Linux path Windows cannot open.
# /init is the binfmt interpreter; call it with WSL_INTEROP set.
run_windows() {
	ensure_wsl_interop
	(
		cd /mnt/c
		/init "$PS" -NoProfile -ExecutionPolicy Bypass "$@"
	)
}

run_ps() {
	run_windows -File 'C:\src\funkot-player\scripts\win-build.ps1' "$@"
}

require_windows_host

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
			run_windows -Command "Start-Process 'C:\funkot-player-test\funkot-player.exe'"
		fi
		exit 0
	fi
	echo "OK: unchanged sources, deploy only"
	run_deploy
	exit 0
fi

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

run_ps -BuildOnly
printf '%s\n' "$fp" >"$STAMP"
run_deploy
