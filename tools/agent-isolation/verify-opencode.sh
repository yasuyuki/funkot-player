#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
launcher="$script_dir/launch-agent.sh"
check='
set -euo pipefail
cli=tools/opencode-policy/node_modules/.bin/opencode
[[ -x $cli ]]
version=$($cli --version)
[[ $version =~ (^|[^0-9])1\.18\.21([^0-9]|$) ]]
auth=$($cli auth list 2>&1)
[[ $auth =~ [Oo]pen[Rr]outer ]]
models=$($cli models openrouter 2>&1)
[[ $models =~ (openrouter/)?stealth/ox-alpha ]]
printf "%s\n" "Local OpenCode: 1.18.21" "Authenticated provider: OpenRouter" "Available model: openrouter/stealth/ox-alpha"
'
"$launcher" bash -lc "$check"
