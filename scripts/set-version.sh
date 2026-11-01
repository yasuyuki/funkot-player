#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

SEMVER_SPOTS="package.json
package-lock.json
src-tauri/Cargo.toml
src-tauri/Cargo.lock
src-tauri/tauri.conf.json"

# Written as the 4-part Store form: 0.1.4.0. The Store requires the revision
# component to be 0 on submission, so it is fixed rather than settable.
MSIX_SPOTS="packaging/msix/Package.appxmanifest
packaging/msix/scripts/pack-msix.ps1
packaging/msix/README.md"

ANDROID_PROPS=src-tauri/gen/android/app/tauri.properties

REFERENCE=src-tauri/tauri.conf.json

read_spot() {
    case $1 in
    package.json)
        sed -n '1,15s/^  "version": "\([^"]*\)",$/\1/p' "$1" ;;
    package-lock.json)
        sed -n '1,15s/^ *"version": "\([^"]*\)",$/\1/p' "$1" ;;
    src-tauri/Cargo.toml)
        sed -n '1,10s/^version = "\([^"]*\)"$/\1/p' "$1" ;;
    src-tauri/Cargo.lock)
        sed -n '/^name = "funkot-player"$/{n;s/^version = "\([^"]*\)"$/\1/p;}' "$1" ;;
    src-tauri/tauri.conf.json)
        sed -n '1,10s/^  "version": "\([^"]*\)",$/\1/p' "$1" ;;
    packaging/msix/Package.appxmanifest)
        sed -n 's/^ *Version="\([0-9][^"]*\)"$/\1/p' "$1" ;;
    packaging/msix/scripts/pack-msix.ps1)
        sed -n 's/^\$PackageVersion = "\([^"]*\)"$/\1/p' "$1"
        sed -n 's/.*Funkot_\([0-9][0-9.]*\)_x64.*/\1/p' "$1" ;;
    packaging/msix/README.md)
        sed -n 's/.*Funkot_\([0-9][0-9.]*\)_x64.*/\1/p' "$1" ;;
    *)
        echo "set-version.sh: no reader for $1" >&2; return 1 ;;
    esac
}

write_spot() {
    case $1 in
    package.json)
        edit "$1" '1,15s/^\(  "version": "\)[^"]*\(",\)$/\1'"$2"'\2/' ;;
    package-lock.json)
        edit "$1" '1,15s/^\( *"version": "\)[^"]*\(",\)$/\1'"$2"'\2/' ;;
    src-tauri/Cargo.toml)
        edit "$1" '1,10s/^version = "[^"]*"$/version = "'"$2"'"/' ;;
    src-tauri/Cargo.lock)
        edit "$1" '/^name = "funkot-player"$/{n;s/^version = "[^"]*"$/version = "'"$2"'"/;}' ;;
    src-tauri/tauri.conf.json)
        edit "$1" '1,10s/^\(  "version": "\)[^"]*\(",\)$/\1'"$2"'\2/' ;;
    packaging/msix/Package.appxmanifest)
        edit "$1" 's/^\( *\)Version="[0-9][^"]*"$/\1Version="'"$2"'"/' ;;
    packaging/msix/scripts/pack-msix.ps1)
        edit "$1" 's/^\$PackageVersion = "[^"]*"$/$PackageVersion = "'"$2"'"/
s/Funkot_[0-9][0-9.]*_x64/Funkot_'"$2"'_x64/g' ;;
    packaging/msix/README.md)
        edit "$1" 's/Funkot_[0-9][0-9.]*_x64/Funkot_'"$2"'_x64/g' ;;
    *)
        echo "set-version.sh: no writer for $1" >&2; return 1 ;;
    esac
}

# `sed -i` is not POSIX and replaces the file with a new inode; write back
# through the existing file instead.
edit() {
    tmp=$(mktemp)
    sed "$2" "$1" > "$tmp"
    cat "$tmp" > "$1"
    rm -f "$tmp"
}

value_of() {
    read_spot "$1" | sort -u | tr '\n' ' ' | sed 's/ *$//'
}

want_for() {
    case " $(echo "$MSIX_SPOTS" | tr '\n' ' ') " in
    *" $1 "*) echo "$2.0" ;;
    *)        echo "$2" ;;
    esac
}

current_version() {
    v=$(value_of "$REFERENCE")
    case $v in
    [0-9]*.[0-9]*.[0-9]*" "*|"")
        echo "set-version.sh: cannot read a single version from $REFERENCE (got '$v')" >&2
        return 1 ;;
    esac
    echo "$v"
}

android_report() {
    version=$1
    major=${version%%.*}
    rest=${version#*.}
    minor=${rest%%.*}
    patch=${rest#*.}
    code=$((major * 1000000 + minor * 1000 + patch))
    echo "Android (derived from $REFERENCE, written by the Tauri android build):"
    echo "  versionName  $version"
    echo "  versionCode  $code"
    if [ -f "$ANDROID_PROPS" ]; then
        have_name=$(sed -n 's/^tauri\.android\.versionName=//p' "$ANDROID_PROPS")
        have_code=$(sed -n 's/^tauri\.android\.versionCode=//p' "$ANDROID_PROPS")
        if [ "$have_name" = "$version" ]; then
            echo "  $ANDROID_PROPS is current"
        else
            echo "  $ANDROID_PROPS still says $have_name / $have_code --"
            echo "  the next android build regenerates it. An APK built before"
            echo "  that carries the old version; rebuild before installing."
        fi
    else
        echo "  $ANDROID_PROPS absent (no android build in this tree yet)"
    fi
}

check() {
    version=$(current_version)
    status=0
    for f in $SEMVER_SPOTS $MSIX_SPOTS; do
        want=$(want_for "$f" "$version")
        got=$(value_of "$f")
        if [ -z "$got" ]; then
            echo "FAIL: $f -- no version found. The anchor in set-version.sh no" >&2
            echo "      longer matches this file; fix read_spot and write_spot." >&2
            status=1
        elif [ "$got" != "$want" ]; then
            echo "FAIL: $f has '$got', expected '$want'" >&2
            status=1
        fi
    done
    if [ "$status" = 0 ]; then
        echo "version: $version consistent across $(echo "$SEMVER_SPOTS $MSIX_SPOTS" | wc -w) files"
    else
        echo "Run ./scripts/set-version.sh $version to bring them back together." >&2
    fi
    return "$status"
}

show() {
    version=$(current_version)
    for f in $SEMVER_SPOTS $MSIX_SPOTS; do
        printf '  %-40s %s\n' "$f" "$(value_of "$f")"
    done
    echo
    android_report "$version"
}

case ${1:-} in
"")
    show ;;
--check)
    check ;;
-h|--help)
    sed -n '2,/^set -eu$/{/^set -eu$/d;s/^# \{0,1\}//;p;}' "$0" ;;
[0-9]*.[0-9]*.[0-9]*)
    case $1 in
    *[!0-9.]*|*..*|*.)
        echo "set-version.sh: '$1' is not X.Y.Z" >&2; exit 2 ;;
    esac
    [ "$(echo "$1" | tr -cd . | wc -c)" = 2 ] || {
        echo "set-version.sh: '$1' is not X.Y.Z (three components, no suffix)" >&2
        exit 2
    }
    for f in $SEMVER_SPOTS $MSIX_SPOTS; do
        write_spot "$f" "$(want_for "$f" "$1")"
    done
    check
    echo
    android_report "$1" ;;
*)
    echo "usage: $0 [X.Y.Z | --check]" >&2
    exit 2 ;;
esac
