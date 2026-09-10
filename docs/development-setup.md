# Development setup

External-contributor guide for a first successful `./dev.sh` run.
These steps were verified on Ubuntu 24.04 under WSL2 with systemd.

For Android builds, ADB, desktop GUI, and shipping, see [README.md § For developers](../README.md#for-developers) after the smoke checks below pass.

## Prerequisites

- **Docker Engine** on the host (CLI + daemon). Host Rust and Node are not required; `./dev.sh` runs everything in the `funkot-player-dev` image.
- A sibling checkout of the engine used by this player (see [Repository layout](#repository-layout)).

## Repository layout

`src-tauri/Cargo.toml` depends on `funkot-core` via a **path dependency**. By default that path is the sibling checkout:

```text
<parent>/
  funkot-player/          # this repo
  funkot-autodj-for-ui/   # second checkout of funkot-autodj (path dep target)
```

`./dev.sh` mounts that sibling read-only. Override with `FUNKOT_CORE_REPO` if it lives elsewhere:

```sh
export FUNKOT_CORE_REPO=/path/to/funkot-autodj-for-ui
```

Use this player's `main` and [funkot-autodj](https://github.com/yasuyuki/funkot-autodj)'s
`master` as the integration branches. Start independent work from the latest fetched remote
defaults in separate task worktrees, keeping the two sibling names above. Give the UI engine
its own topic; do not share a checkout with independent engine development. Reuse the same
worktrees for unfinished work and merge verified results back into their integration branches.
Historical `develop` and `feat/player-ui` branches are not starting points for new work.

In a managed working set, select the task's `WORKING-SET.json` from the registered launch
workspace. Use its existing verifier and public branch registration commands before editing.
The manifest describes placement; Git registration records the task, base, dependencies and
integration destination. Outside a managed workspace, Git worktrees can use the same sibling layout.

## Install Docker

Install official Docker Engine and confirm `docker` works for your user (no `sudo` needed for routine commands). Official docs: [Install Docker Engine](https://docs.docker.com/engine/install/).

### Example: Ubuntu 24.04 / WSL2 + systemd

On WSL2, enable systemd in `/etc/wsl.conf` (`systemd=true`), then restart the distro, so `systemctl` can start the daemon.

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
# log out/in or: newgrp docker
docker run --rm hello-world
```

## First-time verification

From the `funkot-player` repo root, with the sibling `../funkot-autodj-for-ui` present:

```sh
./dev.sh npm install
./dev.sh npm run check
./dev.sh npm test
./dev.sh npm run build
./dev.sh cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Notes:

- The first run builds the `funkot-player-dev` image (Android NDK/SDK, GTK, and related deps). Expect on the order of tens of minutes.
- Temporary crates.io timeouts can occur; re-run the same `cargo` command.
- `npm run check`, `npm test`, and `npm run build` cover the frontend. Run the invariant
  scripts listed in `.github/workflows/checks.yml` as well. Engine changes also require its
  own workspace tests and any real-audio acceptance required by its development instructions.

## Common failures

| Symptom | What to do |
|---|---|
| `docker: command not found` / `dev.sh` exit 127 | Install Docker Engine; see [Install Docker](#install-docker). |
| `permission denied` on the Docker socket | Add your user to the `docker` group, then log out/in (or `newgrp docker`). |
| `cannot find funkot-autodj-for-ui` | Create the sibling checkout, or set `FUNKOT_CORE_REPO`. |
| Image build fails for disk space | Free space; the first image build is large. |
| crates.io timeout / network error during `cargo` | Re-run the same `./dev.sh cargo ...` command. |

## Next steps

After the smoke commands succeed, continue with Android, ADB, desktop GUI, and release steps in [README.md § For developers](../README.md#for-developers). Do not duplicate those flows here.
