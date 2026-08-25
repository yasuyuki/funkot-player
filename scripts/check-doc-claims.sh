#!/bin/sh
# Check that documentation citations still point at something real.
#
# Line numbers rot: a `lib.rs:2394` that was true when written becomes a lie
# that later phases copy. Symbol citations (`symbol`（`path`）) rot when the
# symbol is renamed or the file moves. Either way the document keeps looking
# authoritative while teaching the wrong place to look.
#
# CI runs this on every push (.github/workflows/checks.yml). It needs nothing
# but a POSIX shell -- no Docker, no toolchain, no sibling checkout. Keep it
# that way. Sibling-repo paths are deferred and counted, never silently skipped.
#
# POLICY: when a doc claim turns out to be rotten and has already spread a
# false pointer into later phases, do not just fix the prose -- add a check
# here that would have caught it. A rule that lives only in a comment gets
# skipped by the next person who writes a phase file; one that lives here
# cannot be. New checks go in as a `check_*` function, called from the list
# at the bottom.
set -eu

cd "$(dirname "$0")/.."
ROOT=$(pwd)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

status=0

# Directories whose Markdown makes claims about the code. A phase document is
# deleted once its acceptance condition passes, so .claude/plan-phases is empty
# -- or absent -- whenever nothing is open; probe each directory instead of
# handing a missing path to find under `set -e`.
DOC_CLAIM_DIRS="docs .claude/plan-phases"

collect_md_files() {
    : > "$TMP/md_files"
    for _dir in $DOC_CLAIM_DIRS; do
        [ -d "$_dir" ] || continue
        find "$_dir" -name '*.md' -type f >> "$TMP/md_files"
    done
    sort -o "$TMP/md_files" "$TMP/md_files"
}

# Detection is extension:[digits]; the path stem is included so -o reports the
# full citation (lib.rs:2394), not a bare .rs:2394.
LINE_CITE_RE='[[:alnum:]_./-]*(\.gitignore|\.(rs|ts|svelte|toml|sh|py|json|md)):[0-9]+'
FILE_PATH_RE='(\.gitignore|\.(rs|ts|svelte|toml|sh|py|json|md))(:[0-9].*)?$'
# Separators are :: (Rust path) or . (field); lead examples include both.
SYMBOL_IDENT_RE='^[A-Za-z_][A-Za-z0-9_]*((::|\.)[A-Za-z_][A-Za-z0-9_]*)*[!]?$'
SYMBOL_FILE_RE='^[A-Za-z0-9_.-]+\.(rs|ts|svelte|toml|sh|py|json|md)$'

# path:NNN / path:NNN-MMM citations. Line numbers are a rotting field; banning
# them is the fix (see doc-claim-checks README).
check_no_line_citations() {
    failed=0
    collect_md_files
    while IFS= read -r f; do
        # grep exits 1 on no match under set -e; keep going.
        grep -nEo "$LINE_CITE_RE" "$f" > "$TMP/hits" 2>/dev/null || true
        while IFS= read -r hit; do
            [ -n "$hit" ] || continue
            lineno=${hit%%:*}
            cite=${hit#*:}
            echo "FAIL: line-number citation in $f:$lineno" >&2
            echo "  $cite is a rotting line number; write \`symbol\`（\`path\`） instead" >&2
            failed=1
        done < "$TMP/hits"
    done < "$TMP/md_files"
    [ "$failed" = 0 ]
}

is_file_like_path() {
    printf '%s' "$1" | grep -qE "$FILE_PATH_RE"
}

path_has_line_number() {
    printf '%s' "$1" | grep -q ':[0-9]'
}

is_resolvable_symbol() {
    printf '%s' "$1" | grep -qE "$SYMBOL_IDENT_RE" && return 0
    printf '%s' "$1" | grep -qE "$SYMBOL_FILE_RE" && return 0
    return 1
}

# Resolve path to an absolute file. Prints the path on success.
# Exit 0 = found, 1 = missing (FAIL), 2 = sibling dir absent (defer).
resolve_citation_file() {
    path=$1
    case "$path" in
        funkot-player/*) path=${path#funkot-player/} ;;
    esac

    if [ -f "$ROOT/$path" ]; then
        printf '%s\n' "$ROOT/$path"
        return 0
    fi

    case "$path" in
        funkot-autodj-for-ui/*)
            sibling=$ROOT/../funkot-autodj-for-ui
            rest=${path#funkot-autodj-for-ui/}
            if [ ! -d "$sibling" ]; then
                return 2
            fi
            if [ -f "$sibling/$rest" ]; then
                printf '%s\n' "$sibling/$rest"
                return 0
            fi
            return 1
            ;;
        funkot-core/*)
            sibling=$ROOT/../funkot-autodj-for-ui
            if [ ! -d "$sibling" ]; then
                return 2
            fi
            if [ -f "$sibling/$path" ]; then
                printf '%s\n' "$sibling/$path"
                return 0
            fi
            return 1
            ;;
        funkot-autodj/*)
            sibling=$ROOT/../funkot-autodj
            rest=${path#funkot-autodj/}
            if [ ! -d "$sibling" ]; then
                return 2
            fi
            if [ -f "$sibling/$rest" ]; then
                printf '%s\n' "$sibling/$rest"
                return 0
            fi
            return 1
            ;;
        *)
            return 1
            ;;
    esac
}

# Collect `A` / `B` / `C` sharing one （`path`）. Writes symbols to $TMP/syms,
# one per line; last symbol is the one glued to （`path`）.
collect_chain_symbols() {
    match=$1
    line=$2
    last=$(printf '%s' "$match" | sed 's/^`//; s/`（`.*//')
    before=${line%%"$match"*}

    rm -f "$TMP/pred_syms"
    : > "$TMP/syms"
    work=$before
    while printf '%s' "$work" | grep -qE '`[^`]+` / $'; do
        pred=$(printf '%s' "$work" | sed 's/.*`\([^`]*\)` \/ $/\1/')
        printf '%s\n' "$pred" >> "$TMP/pred_syms"
        work=$(printf '%s' "$work" | sed 's/`[^`]*` \/ $//')
    done
    if [ -f "$TMP/pred_syms" ]; then
        cat "$TMP/pred_syms" >> "$TMP/syms"
        rm -f "$TMP/pred_syms"
    fi
    printf '%s\n' "$last" >> "$TMP/syms"
}

# `symbol`（`path`） citations: path exists and contains symbol. Citations whose
# symbol form cannot be extracted are reported as unchecked.
check_symbols_resolve() {
    failed=0
    deferred=0
    collect_md_files
    while IFS= read -r f; do
        lineno=0
        while IFS= read -r line || [ -n "$line" ]; do
            lineno=$((lineno + 1))
            # Fullwidth paren U+FF08 / U+FF09.
            printf '%s\n' "$line" | grep -o '`[^`]*`（`[^`]*`）' > "$TMP/cites" 2>/dev/null || true
            while IFS= read -r cite; do
                [ -n "$cite" ] || continue
                path=$(printf '%s' "$cite" | sed 's/^`[^`]*`（`//; s/`）$//')
                is_file_like_path "$path" || continue
                path_has_line_number "$path" && continue

                collect_chain_symbols "$cite" "$line"
                while IFS= read -r sym; do
                    [ -n "$sym" ] || continue
                    if ! is_resolvable_symbol "$sym"; then
                        echo "FAIL: unchecked citation in $f:$lineno" >&2
                        echo "  \`$sym\`（\`$path\`） is not a resolvable symbol form; rewrite so the checker can extract it" >&2
                        failed=1
                        continue
                    fi

                    rc=0
                    resolved=$(resolve_citation_file "$path") || rc=$?
                    if [ "$rc" -eq 2 ]; then
                        deferred=$((deferred + 1))
                        continue
                    fi
                    if [ "$rc" -ne 0 ]; then
                        echo "FAIL: symbol citation in $f:$lineno" >&2
                        echo "  \`$sym\`（\`$path\`） — file not found (bare names are not searched; use a repo-relative path)" >&2
                        failed=1
                        continue
                    fi
                    if ! grep -Fq -- "$sym" "$resolved"; then
                        echo "FAIL: symbol citation in $f:$lineno" >&2
                        echo "  \`$sym\` not found in $path; the claim no longer points at the code it names" >&2
                        failed=1
                    fi
                done < "$TMP/syms"
            done < "$TMP/cites"
        done < "$f"
    done < "$TMP/md_files"

    echo "doc-claim symbols: deferred $deferred sibling-repo citation(s)"
    [ "$failed" = 0 ]
}

check_no_line_citations || status=1
check_symbols_resolve || status=1

if [ "$status" = 0 ]; then
    echo "doc-claim checks: OK"
fi
exit "$status"
