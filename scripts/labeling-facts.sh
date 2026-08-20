#!/bin/sh
# Print machine-answerable labeling facts for a funkot session start.
# Read-only: never writes under the app data directory.
#
# Usage: ./scripts/labeling-facts.sh [--print] [--app-dir DIR]
set -eu

# --- expected values (edit here only; measured 2026-08-20) ---
EXPECT_CACHE=798
EXPECT_IS_FUNKOT=412
EXPECT_MANUAL=1
EXPECT_NEEDS_REANALYSIS=0
EXPECT_UNDER_30S=0
EXPECT_TOPDIRS=103

PRINT_ONLY=0
APP_DIR_ARG=

while [ $# -gt 0 ]; do
	case $1 in
	--print)
		PRINT_ONLY=1
		shift
		;;
	--app-dir)
		if [ $# -lt 2 ]; then
			echo "Usage: ./scripts/labeling-facts.sh [--print] [--app-dir DIR]" >&2
			exit 1
		fi
		APP_DIR_ARG=$2
		shift 2
		;;
	--app-dir=*)
		APP_DIR_ARG=${1#--app-dir=}
		shift
		;;
	-h|--help)
		echo "Usage: ./scripts/labeling-facts.sh [--print] [--app-dir DIR]" >&2
		exit 0
		;;
	*)
		echo "Usage: ./scripts/labeling-facts.sh [--print] [--app-dir DIR]" >&2
		exit 1
		;;
	esac
done

# Convert a Windows path (backslashes, optional drive letter) to a POSIX path
# usable from WSL (/mnt/c/...) or Git Bash (/c/...). App-data directory only.
win_path_to_posix() {
	_p=$1
	case $_p in
	/*) printf '%s\n' "$_p"; return 0 ;;
	esac
	case $_p in
	[A-Za-z]:[\\/]*)
		_drive=$(printf '%s' "$_p" | cut -c1 | tr 'A-Z' 'a-z')
		_rest=$(printf '%s' "$_p" | cut -c3- | tr '\\' '/')
		if [ -d "/mnt/$_drive" ] || [ -e "/mnt/$_drive" ]; then
			printf '/mnt/%s%s\n' "$_drive" "$_rest"
		else
			printf '/%s%s\n' "$_drive" "$_rest"
		fi
		return 0
		;;
	esac
	printf '%s\n' "$_p" | tr '\\' '/'
}

# Workspace root: first ancestor of this script that contains both
# funkot-player/ and funkot-autodj-for-ui/ as direct children.
resolve_workspace_root() {
	_here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
	_dir=$_here
	while [ "$_dir" != "/" ]; do
		if [ -d "$_dir/funkot-player" ] && [ -d "$_dir/funkot-autodj-for-ui" ]; then
			printf '%s\n' "$_dir"
			return 0
		fi
		_dir=$(CDPATH= cd -- "$_dir/.." && pwd)
	done
	echo "FAIL: workspace root not found (need funkot-player and funkot-autodj-for-ui as siblings)" >&2
	return 1
}

resolve_app_dir() {
	if [ -n "$APP_DIR_ARG" ]; then
		win_path_to_posix "$APP_DIR_ARG"
		return 0
	fi
	if [ -n "${FUNKOT_APP_DIR:-}" ]; then
		win_path_to_posix "$FUNKOT_APP_DIR"
		return 0
	fi
	if [ -n "${APPDATA:-}" ]; then
		_cand=$(win_path_to_posix "$APPDATA/jp.hatsuboshi.funkotplayer")
		if [ -d "$_cand/funkot-cache" ]; then
			printf '%s\n' "$_cand"
			return 0
		fi
	fi

	# Glob in the for-list (not `for d in $pat`): a match with spaces in the
	# Windows user name must stay one word.
	_matches=
	_n=0
	for _d in \
		/mnt/c/Users/*/AppData/Roaming/jp.hatsuboshi.funkotplayer \
		/c/Users/*/AppData/Roaming/jp.hatsuboshi.funkotplayer
	do
		[ -d "$_d" ] || continue
		[ -d "$_d/funkot-cache" ] || continue
		_n=$((_n + 1))
		_matches="${_matches}
${_d}"
	done

	if [ "$_n" -eq 0 ]; then
		echo "FAIL: app data dir not found. Pass --app-dir DIR or set FUNKOT_APP_DIR." >&2
		return 1
	fi
	if [ "$_n" -gt 1 ]; then
		echo "FAIL: multiple app data dirs with funkot-cache found:" >&2
		printf '%s\n' "$_matches" | sed '/^$/d' >&2
		echo "Pass --app-dir DIR to disambiguate." >&2
		return 1
	fi
	printf '%s\n' "$_matches" | sed '/^$/d'
}

git_repo_line() {
	_repo=$1
	_label=$2
	if ! git -C "$_repo" rev-parse --git-dir >/dev/null 2>&1; then
		printf '%s: (not a git repo)\n' "$_label"
		return 0
	fi
	_branch=$(git -C "$_repo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
	_sha=$(git -C "$_repo" rev-parse --short HEAD 2>/dev/null || echo '?')
	_dirty=$(git -C "$_repo" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
	printf '%s: branch=%s sha=%s dirty=%s\n' "$_label" "$_branch" "$_sha" "$_dirty"
}

WS=$(resolve_workspace_root)
APP=$(resolve_app_dir)

PLAYER=$WS/funkot-player
ENGINE=$WS/funkot-autodj-for-ui
TESTDATA=$ENGINE/testdata

echo "=== workspace ==="
echo "workspace_root=$WS"
git_repo_line "$PLAYER" "player"
git_repo_line "$ENGINE" "engine"

echo "=== mount ==="
if [ -d /mnt/oldpc/music ]; then
	if command -v mountpoint >/dev/null 2>&1 && mountpoint -q /mnt/oldpc/music 2>/dev/null; then
		echo "/mnt/oldpc/music: present (mountpoint)"
	else
		echo "/mnt/oldpc/music: present"
	fi
else
	echo "/mnt/oldpc/music: missing"
fi

echo "=== app dir ==="
echo "app_dir=$APP"

if command -v python3 >/dev/null 2>&1; then
	PYTHON=python3
elif command -v python >/dev/null 2>&1; then
	PYTHON=python
else
	echo "FAIL: python3/python not found" >&2
	exit 1
fi

# Facts file: integers only (safe to source). Human sections go to stdout.
FACTS=$(mktemp /tmp/labeling-facts.XXXXXX)
trap 'rm -f "$FACTS"' EXIT INT TERM

"$PYTHON" - "$APP" "$FACTS" <<'PY'
import json
import os
import sys
from collections import Counter

app = sys.argv[1]
facts_path = sys.argv[2]
cache_dir = os.path.join(app, "funkot-cache")

version_counts = Counter()
cache = 0
is_funkot = 0
manual = 0
intro_m = 0
outro_m = 0
outro_s_m = 0
needs_re = 0
classify_missing = 0
under_30s = 0

if os.path.isdir(cache_dir):
    for name in os.listdir(cache_dir):
        if not name.endswith(".json"):
            continue
        path = os.path.join(cache_dir, name)
        cache += 1
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        version_counts[data.get("version")] += 1
        if data.get("is_funkot") is True:
            is_funkot += 1
        ib = data.get("intro_bars_manual") is True
        ob = data.get("outro_bars_manual") is True
        sb = data.get("outro_structure_bars_manual") is True
        if ib:
            intro_m += 1
        if ob:
            outro_m += 1
        if sb:
            outro_s_m += 1
        if ib or ob or sb:
            manual += 1
        if data.get("needs_reanalysis") is True:
            needs_re += 1
        if "classify_scores" not in data or data.get("classify_scores") is None:
            classify_missing += 1
        sr = data.get("sample_rate") or 0
        tf = data.get("total_frames") or 0
        try:
            sr_n = float(sr)
            tf_n = float(tf)
        except (TypeError, ValueError):
            sr_n = 0.0
            tf_n = 0.0
        if sr_n > 0 and (tf_n / sr_n) < 30.0:
            under_30s += 1

parts = []
for v, n in sorted(version_counts.items(), key=lambda x: (x[0] is None, x[0])):
    parts.append("%s:%d" % (("null" if v is None else v), n))
version_dist = ",".join(parts)

def load_obj(path):
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

labels = load_obj(os.path.join(app, "labels.json"))
if labels is None:
    labels_status = "missing"
    labels_n = 0
elif isinstance(labels, dict):
    labels_status = "ok"
    labels_n = len(labels)
else:
    labels_status = "ok"
    labels_n = 0

history = load_obj(os.path.join(app, "history.json"))
if history is None:
    history_status = "missing"
    history_n = 0
elif isinstance(history, dict):
    history_status = "ok"
    history_n = len(history)
else:
    history_status = "ok"
    history_n = 0

settings = load_obj(os.path.join(app, "settings.json"))
if settings is None:
    allow_non = ""
    labeling_mode = ""
    music_dir = ""
else:
    allow_non = settings.get("allow_non_funkot")
    labeling_mode = settings.get("labeling_mode")
    md = settings.get("music_dir")
    music_dir = "" if md is None else str(md)

hash_index = load_obj(os.path.join(app, "hash-index.json"))
if hash_index is None or not isinstance(hash_index, dict):
    hash_n = 0
    topdirs = 0
    unmatched = 0
else:
    hash_n = len(hash_index)
    prefix = music_dir.rstrip("\\")
    prefix_with_sep = prefix + "\\" if prefix else ""
    tops = set()
    unmatched = 0
    for key in hash_index:
        k = str(key)
        if prefix_with_sep and k.startswith(prefix_with_sep):
            rest = k[len(prefix_with_sep):]
            seg = rest.split("\\", 1)[0]
            if seg:
                tops.add(seg)
            else:
                unmatched += 1
        else:
            unmatched += 1
    topdirs = len(tops)

print("=== cache ===")
print("cache=%d" % cache)
print("version_dist=%s" % version_dist)
print("is_funkot=%d" % is_funkot)
print(
    "manual=%d (intro=%d outro=%d outro_structure=%d)"
    % (manual, intro_m, outro_m, outro_s_m)
)
print("needs_reanalysis=%d" % needs_re)
print("classify_scores_missing=%d" % classify_missing)
print("under_30s=%d" % under_30s)

print("=== app state ===")
print("labels: status=%s count=%d" % (labels_status, labels_n))
print("history: status=%s count=%d" % (history_status, history_n))
print(
    "settings: allow_non_funkot=%s labeling_mode=%s"
    % (allow_non, labeling_mode)
)
print("music_dir=%s" % music_dir)
print("hash_index=%d topdirs=%d unmatched=%d" % (hash_n, topdirs, unmatched))

with open(facts_path, "w", encoding="utf-8") as out:
    out.write("CACHE=%d\n" % cache)
    out.write("IS_FUNKOT=%d\n" % is_funkot)
    out.write("MANUAL=%d\n" % manual)
    out.write("NEEDS_REANALYSIS=%d\n" % needs_re)
    out.write("UNDER_30S=%d\n" % under_30s)
    out.write("TOPDIRS=%d\n" % topdirs)
PY

# shellcheck disable=SC1090
. "$FACTS"

echo "=== testdata ==="
ALLOWED='
labels.tsv.example
ivy_transition_playlist.txt
file_list.txt
real_playlist.txt
real_playlist_v20.txt
classify_funkot.txt
classify_not_funkot.txt
classify_funkot_hhhb.txt
'
if [ -d "$TESTDATA" ]; then
	while IFS= read -r _f; do
		[ -n "$_f" ] || continue
		_base=$(basename "$_f")
		_ok=0
		for _a in $ALLOWED; do
			[ "$_base" = "$_a" ] && _ok=1 && break
		done
		if [ "$_ok" -eq 0 ]; then
			echo "WARN: unknown testdata file: $_base" >&2
		fi
	done <<EOF
$(find "$TESTDATA" -type f 2>/dev/null)
EOF
	echo "testdata_dir=$TESTDATA (allowlist checked)"
else
	echo "testdata_dir missing: $TESTDATA" >&2
fi

if [ "$PRINT_ONLY" -eq 1 ]; then
	exit 0
fi

status=0
check() {
	_name=$1
	_expect=$2
	_got=$3
	if [ "$_expect" != "$_got" ]; then
		echo "FAIL: $_name expected $_expect got $_got" >&2
		status=1
	fi
}

check CACHE "$EXPECT_CACHE" "$CACHE"
check IS_FUNKOT "$EXPECT_IS_FUNKOT" "$IS_FUNKOT"
check MANUAL "$EXPECT_MANUAL" "$MANUAL"
check NEEDS_REANALYSIS "$EXPECT_NEEDS_REANALYSIS" "$NEEDS_REANALYSIS"
check UNDER_30S "$EXPECT_UNDER_30S" "$UNDER_30S"
check TOPDIRS "$EXPECT_TOPDIRS" "$TOPDIRS"

exit "$status"
