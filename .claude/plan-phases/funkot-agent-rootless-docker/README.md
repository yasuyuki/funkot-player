# funkot-agent-rootless-docker

Rootless Docker runs only in WSL and belongs only to funkot-agent. Each phase
delegates safe work to an agent and leaves one explicit sudo boundary to owner.

| # | File | Content | Status |
|---|---|---|---|
| 01 | phase-01-rootless-prerequisites.md | capability probe and owner sudo boundary | Pending |
| 02 | phase-02-agent-daemon.md | rootless daemon and CLI context | Pending |
| 03 | phase-03-agent-development-smoke.md | agent clone Docker development smoke | Pending |

Execute a phase only when the user names its phase file.
