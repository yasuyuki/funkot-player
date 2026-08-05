#!/bin/sh
# Pack the Android release signing material into one encrypted archive.
#
# Includes:
#   - .secrets/upload-keystore.jks
#   - src-tauri/gen/android/keystore.properties
#   - RESTORE.txt (how to put them back)
#   - MANIFEST.txt (date, alias, sha256 of the jks — no passwords)
#
# Default password = storePassword from keystore.properties (one secret to keep).
# Override with BACKUP_PASS=... if you want a separate archive password.
#
# Usage:
#   ./scripts/pack-signing-backup.sh
#   OUT=/path/to/funkot-player-signing.7z ./scripts/pack-signing-backup.sh
#   BACKUP_PASS='...' ./scripts/pack-signing-backup.sh
#
# Restore (example):
#   7z x -p"$PASS" -o/tmp/funkot-signing-restore funkot-player-signing-YYYYMMDD.7z
#   # then follow RESTORE.txt inside
set -eu

cd "$(dirname "$0")/.."
REPO=$(pwd)

JKS="$REPO/.secrets/upload-keystore.jks"
PROPS="$REPO/src-tauri/gen/android/keystore.properties"

[ -f "$JKS" ] || { echo "missing $JKS" >&2; exit 1; }
[ -f "$PROPS" ] || { echo "missing $PROPS" >&2; exit 1; }
command -v 7z >/dev/null || { echo "7z not found (need p7zip)" >&2; exit 1; }

STORE_PASS=$(sed -n 's/^storePassword=//p' "$PROPS")
KEY_ALIAS=$(sed -n 's/^keyAlias=//p' "$PROPS")
[ -n "$STORE_PASS" ] || { echo "storePassword missing in keystore.properties" >&2; exit 1; }
[ -n "$KEY_ALIAS" ] || { echo "keyAlias missing in keystore.properties" >&2; exit 1; }

PASS=${BACKUP_PASS:-$STORE_PASS}
STAMP=$(date +%Y%m%d)
# Outside the git repo by default: sibling of the project directory.
OUT=${OUT:-"$REPO/../funkot-player-signing-backup-$STAMP.7z"}

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

PKG="$STAGE/funkot-player-signing"
mkdir -p "$PKG"
cp -a "$JKS" "$PKG/upload-keystore.jks"
cp -a "$PROPS" "$PKG/keystore.properties"
chmod 600 "$PKG/upload-keystore.jks" "$PKG/keystore.properties"

JKS_SHA=$(sha256sum "$JKS" | awk '{print $1}')

cat >"$PKG/MANIFEST.txt" <<EOF
project: funkot-player
created: $(date -Iseconds)
host: $(hostname 2>/dev/null || echo unknown)
alias: $KEY_ALIAS
jks_sha256: $JKS_SHA
jks_bytes: $(wc -c <"$JKS" | tr -d ' ')
archive_password: same as keystore storePassword unless BACKUP_PASS was set
EOF

cat >"$PKG/RESTORE.txt" <<'EOF'
Restore onto a funkot-player checkout
====================================

1. Decrypt (you will be prompted, or pass -p):

     7z x -o/tmp/funkot-signing-restore funkot-player-signing-backup-YYYYMMDD.7z

2. From the extracted funkot-player-signing/ directory:

     mkdir -p /path/to/funkot-player/.secrets
     cp -a upload-keystore.jks /path/to/funkot-player/.secrets/
     chmod 700 /path/to/funkot-player/.secrets
     chmod 600 /path/to/funkot-player/.secrets/upload-keystore.jks

     cp -a keystore.properties \
       /path/to/funkot-player/src-tauri/gen/android/keystore.properties
     chmod 600 /path/to/funkot-player/src-tauri/gen/android/keystore.properties

3. Confirm keystore.properties still has:

     storeFile=../../../.secrets/upload-keystore.jks
     keyAlias=upload

4. Release build (via ./dev.sh) should pick up signingConfig automatically.

Do not commit .secrets/ or keystore.properties. Keep another copy of this
archive off the build machine (password manager attachment, encrypted USB, etc.).
EOF

# -mhe=on encrypts the header (file names) as well as contents.
# -sdel is NOT used; we delete the stage via trap.
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
# 7z reads password from -p; do not echo it.
7z a -t7z -m0=lzma2 -mx=9 -mhe=on -p"$PASS" "$OUT" "$PKG" >/dev/null

chmod 600 "$OUT"
echo "wrote $OUT"
echo "bytes $(wc -c <"$OUT" | tr -d ' ')"
echo "sha256 $(sha256sum "$OUT" | awk '{print $1}')"
echo "contains: upload-keystore.jks keystore.properties MANIFEST.txt RESTORE.txt"
