# AI workspace boundary

AI tools may change only the `funkot-player` member declared by the selected
`funkot-dev` working set's common-parent `WORKING-SET.json`. Resolve the member
from that manifest; do not hard-code an absolute path or substitute another
checkout. Start tool entry points from the common parent and read this file
before changing the member.

This interactive working-set boundary is separate from isolated
`wsl-agent-lifecycle` clone management. Do not access `.secrets/`, copy
authentication, or handle signing material. Android builds, signing, Docker
