# AI workspace boundary

Claude Code, Codex, Cursor, and OpenCode must run only as `funkot-agent` in
`/srv/funkot-agent/funkot-player`. The owner checkout is signing-only: do not
open it in an AI tool, copy its configuration or authentication, or access its
`.secrets/` directory. Agent changes are reviewed by the owner and transferred
by patch, cherry-pick, or merge. Android builds, signing, Docker operations,
and releases are owner-only.
