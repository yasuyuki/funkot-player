# AI agent isolation

The owner checkout is a signing boundary. Do not launch Claude Code, Codex,
Cursor, or OpenCode here. All AI work happens as `funkot-agent` in
`/srv/funkot-agent/funkot-player`.

After this commit is available from `origin`, the owner performs the one-time
OS setup. It creates a login-capable, non-sudo user, protects the owner home
from that user, and makes a fresh network clone; it neither copies the owner
checkout nor shares its Git database.

```bash
cd ~/releases/foundation-n-plus-17/funkot-player
sudo tools/agent-isolation/provision.sh "$PWD" https://github.com/yasuyuki/funkot-player.git
tools/agent-isolation/verify-isolation.sh "$PWD"
```

Start every CLI through the launcher. It discards the caller environment and
uses only `funkot-agent` home/config roots.

```bash
tools/agent-isolation/launch-agent.sh codex
tools/agent-isolation/launch-agent.sh claude
tools/agent-isolation/launch-agent.sh bash
```

Install each CLI and complete its login while running as `funkot-agent`; never
copy owner authentication or configuration. In Cursor, connect only through
WSL Remote/SSH as `funkot-agent`, open `/srv/funkot-agent/funkot-player`, and
accept the connection only when its remote terminal reports `funkot-agent`.

OpenCode is pinned under `tools/opencode-policy/`. Install, authenticate, and
verify it through the launcher:

```bash
tools/agent-isolation/launch-agent.sh npm ci --prefix tools/opencode-policy
tools/agent-isolation/launch-agent.sh tools/opencode-policy/node_modules/.bin/opencode
tools/agent-isolation/verify-opencode.sh
tools/agent-isolation/launch-agent.sh tools/opencode-policy/node_modules/.bin/opencode --model openrouter/stealth/ox-alpha
```

The OpenCode verifier emits only the CLI version, provider name, and model
name; it does not display authentication values or read authentication files.
Review agent changes from the owner account, then use a patch, cherry-pick, or
merge in the owner checkout. Android builds, signing, and releases remain
owner-only operations.
