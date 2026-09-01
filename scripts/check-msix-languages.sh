#!/bin/sh
# Fail if MSIX package languages drift from the UI locale list.
#
# UI strings live in src/lib/locales/*.ts and are listed in locale.ts LOCALES.
# They are not MRT language-qualified resources, so Visual Studio's x-generate
# cannot see them. Partner Center reads <Resources> in AppxManifest.xml, which
# this repo copies from packaging/msix/Package.appxmanifest via pack-msix.ps1.
#
# Microsoft Store BCP-47 tags (supported-languages table):
#   https://learn.microsoft.com/windows/apps/publish/publish-your-app/msix/app-package-requirements#supported-languages
# Add a row here when adding a locale, and a <Resource Language="..."/> in
# Package.appxmanifest. The first Resource is the package default language.
#
# Usage (from anywhere):
#   ./scripts/check-msix-languages.sh              # source manifest vs locale.ts
#   ./scripts/check-msix-languages.sh path/to.msix  # also inspect the packed file
set -eu

cd "$(dirname "$0")/.."

MANIFEST=packaging/msix/Package.appxmanifest
LOCALE_TS=src/lib/locale.ts

bcp47_for() {
    case $1 in
    en) echo en-US ;;
    ja) echo ja-JP ;;
    id) echo id-ID ;;
    *)
        echo "FAIL: UI locale '$1' has no Microsoft Store BCP-47 mapping." >&2
        echo "  Add a row to bcp47_for in scripts/check-msix-languages.sh" >&2
        echo "  and a <Resource Language=\"...\"/> in $MANIFEST." >&2
        return 1 ;;
    esac
}

# LOCALES = ["en", "ja", "id"] as const;  -- keep the parser tight so a
# comment that happens to mention a locale cannot match.
ui_locales() {
    sed -n 's/^export const LOCALES = \[\(.*\)\] as const;$/\1/p' "$LOCALE_TS" |
        tr -d '" ' | tr ',' '\n' | grep -v '^$'
}

manifest_languages() {
    # From a file path or stdin. Canonical form is language-REGION.
    sed -n 's/^[[:space:]]*<Resource Language="\([^"]*\)"[[:space:]]*\/>[[:space:]]*$/\1/p' "$1"
}

sorted_lower() {
    # Windows Git bash / CPython text mode may inject CR; compare as a set of tags.
    tr -d '\r' | tr '[:upper:]' '[:lower:]' | grep -v '^$' | sort
}

compare_sets() {
    # $1 expected newline list, $2 got newline list, $3 label for got
    expected_norm=$(printf '%s\n' "$1" | sorted_lower)
    got_norm=$(printf '%s\n' "$2" | sorted_lower)
    if [ "$expected_norm" = "$got_norm" ]; then
        return 0
    fi
    echo "FAIL: $3 languages do not match UI locales." >&2
    echo "  expected:" >&2
    printf '%s\n' "$1" | sed 's/^/    /' >&2
    echo "  got:" >&2
    printf '%s\n' "$2" | sed 's/^/    /' >&2
    return 1
}

require_canonical() {
    # $1 newline list of tags that must already be language-REGION
    st=0
    for tag in $1; do
        lang=${tag%%-*}
        rest=${tag#*-}
        case $tag in
        *-*) ;;
        *)
            echo "FAIL: '$tag' is not a region-qualified BCP-47 tag (use e.g. en-US)." >&2
            st=1
            continue ;;
        esac
        lower_lang=$(printf '%s' "$lang" | tr '[:upper:]' '[:lower:]')
        upper_rest=$(printf '%s' "$rest" | tr '[:lower:]' '[:upper:]')
        canonical="$lower_lang-$upper_rest"
        if [ "$tag" != "$canonical" ]; then
            echo "FAIL: '$tag' should be spelled '$canonical' in the package manifest." >&2
            st=1
        fi
    done
    return "$st"
}

find_python() {
    if command -v python3 >/dev/null 2>&1; then
        echo python3
    elif command -v python >/dev/null 2>&1; then
        echo python
    else
        echo "FAIL: python3 (or python) is required to inspect a packed MSIX." >&2
        return 1
    fi
}

packed_languages() {
    msix=$1
    py=$(find_python)
    "$py" - "$msix" << 'PY'
import re
import sys
import zipfile

path = sys.argv[1]
with zipfile.ZipFile(path) as zf:
    try:
        text = zf.read("AppxManifest.xml").decode("utf-8")
    except KeyError as exc:
        sys.stderr.write("FAIL: packed MSIX has no AppxManifest.xml\n")
        raise SystemExit(1) from exc
langs = re.findall(r'<Resource Language="([^"]+)"', text)
if not langs:
    sys.stderr.write("FAIL: packed AppxManifest.xml has no Resource Language entries\n")
    raise SystemExit(1)
sys.stdout.buffer.write(("\n".join(langs) + "\n").encode("utf-8"))
PY
}

status=0

if [ ! -f "$MANIFEST" ]; then
    echo "FAIL: missing $MANIFEST" >&2
    exit 1
fi
if [ ! -f "$LOCALE_TS" ]; then
    echo "FAIL: missing $LOCALE_TS" >&2
    exit 1
fi

ui=$(ui_locales)
if [ -z "$ui" ]; then
    echo "FAIL: $LOCALE_TS -- could not read LOCALES. Fix the parser in" >&2
    echo "      scripts/check-msix-languages.sh if the declaration moved." >&2
    exit 1
fi

expected=
for loc in $ui; do
    tag=$(bcp47_for "$loc") || exit 1
    expected="$expected$tag
"
done
expected=$(printf '%s' "$expected")

got=$(manifest_languages "$MANIFEST")
if [ -z "$got" ]; then
    echo "FAIL: $MANIFEST has no <Resource Language=.../> entries." >&2
    exit 1
fi

require_canonical "$got" || status=1
compare_sets "$expected" "$got" "$MANIFEST" || status=1

if [ -n "${1:-}" ]; then
    msix=$1
    if [ ! -f "$msix" ]; then
        echo "FAIL: packed MSIX not found: $msix" >&2
        exit 1
    fi
    packed=$(packed_languages "$msix")
    require_canonical "$packed" || status=1
    compare_sets "$expected" "$packed" "$msix AppxManifest.xml" || status=1
fi

if [ "$status" = 0 ]; then
    echo "msix package languages: $(printf '%s' "$got" | tr '\n' ' ' | sed 's/ *$//') (match UI locales)"
    if [ -n "${1:-}" ]; then
        echo "packed AppxManifest.xml: $(printf '%s' "$packed" | tr '\n' ' ' | sed 's/ *$//')"
    fi
fi
exit "$status"
