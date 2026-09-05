#!/bin/sh
# Install pinned, unsigned host tools into an explicitly supplied job directory.
set -eu
test "$#" = 1 || { echo "usage: sh scripts/portable-toolchain.sh JOB_TOOLS" >&2; exit 2; }
test "$(uname -sm)" = "Linux x86_64" || exit 2
mkdir "$1"
TOOLS=$(cd "$1" && pwd)
fetch() {
    url=$1 digest=$2 name=${1##*/}
    if ! test -f "$TOOLS/$name"; then
        curl -fsSL "$url" -o "$TOOLS/$name.partial"
        printf '%s  %s\n' "$digest" "$TOOLS/$name.partial" | sha256sum -c -
        mv "$TOOLS/$name.partial" "$TOOLS/$name"
    fi
    printf '%s  %s\n' "$digest" "$TOOLS/$name" | sha256sum -c -
}
fetch https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz 69b09dba5c8dcb05c4e4273a4340db1005abeafe3927efda2bc5b249e80437ec
fetch https://static.rust-lang.org/dist/rust-1.93.0-x86_64-unknown-linux-gnu.tar.xz b9d9f01a96a2542852ccfddd82194276ba1c86bc76353309ff636b737fc0a772
tar -xJf "$TOOLS/node-v22.14.0-linux-x64.tar.xz" -C "$TOOLS"
tar -xJf "$TOOLS/rust-1.93.0-x86_64-unknown-linux-gnu.tar.xz" -C "$TOOLS"
sh "$TOOLS/rust-1.93.0-x86_64-unknown-linux-gnu/install.sh" --prefix="$TOOLS/rust" --components=rustc,cargo,rust-std-x86_64-unknown-linux-gnu --disable-ldconfig
printf 'Toolchain ready. Add to PATH: %s/node-v22.14.0-linux-x64/bin:%s/rust/bin\n' "$TOOLS" "$TOOLS"
