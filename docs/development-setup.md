# Development setup

External-contributor guide for unsigned checks and a first `./dev.sh` run.
These steps were verified on Ubuntu 24.04 under WSL2 with systemd.

For Android builds, ADB, desktop GUI, and shipping, see [README.md § For developers](../README.md#for-developers) after the smoke checks below pass.

## Prerequisites

### Native unsigned portable checks (Linux x86-64)

The portable profile runs Node tests, Svelte checks, Vite build, Rust library
tests, and the existing invariant/version/language/documentation checks without
Android, a GUI session, audio devices, signing keys, or Docker. It requires an
Ubuntu/Debian host with a C/C++ compiler, pkg-config, libclang, ALSA, GTK3,
WebKitGTK 4.1, librsvg, libxdo and OpenSSL development packages already installed.
Provision those through the host's normal administration process.

From a clean player checkout with the locked engine sibling, install tools into
a new job-local directory:

```sh
sh scripts/portable-toolchain.sh ../job-tools
export PATH="$(cd ../job-tools && pwd)/node-v22.14.0-linux-x64/bin:$(cd ../job-tools && pwd)/rust/bin:$PATH"
export CARGO_HOME="$(cd .. && pwd)/job-cargo"
python3 scripts/verify-portable.py ../inputs.json ../receipt-a.json --record-inputs
```

Node 22.14.0 and Rust 1.93.0 archives are checked against SHA-256 values in
the installer before extraction. `inputs.json` fixes both source commits,
tool versions, and the host's complete package-version list. Test fixtures are
the files tracked by those source commits; no external corpus is used.
The host package list is an environment prerequisite, not a captured OS image:
restoring on another host requires provisioning the recorded package versions.
Unavailable versions are a bootstrap failure, not a skipped successful check.

To restore, obtain the reviewed scripts and input lock from the checkpoint,
then use a destination that does not exist:

```sh
python3 restore-portable.py inputs.json fresh-job
cd fresh-job/funkot-player
sh scripts/portable-toolchain.sh ../job-tools
export PATH="$(cd ../job-tools && pwd)/node-v22.14.0-linux-x64/bin:$(cd ../job-tools && pwd)/rust/bin:$PATH"
export CARGO_HOME="$(cd .. && pwd)/job-cargo"
python3 scripts/verify-portable.py ../../inputs.json ../receipt-b.json
```

The verifier rejects changed SHAs, uncommitted source, toolchain drift and host
package drift. It stops at the first failed check and records exit codes and
timings; a missing or running receipt is not a pass. Keep the receipt and full
command output with the checkpoint. A candidate commit needs its own input lock.
These scripts restore public source and run checks; the operator must provide
the worker's credential isolation and durable checkpoint storage separately.

### Android and interactive desktop development

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

Clone or copy [funkot-autodj](https://github.com/yasuyuki/funkot-autodj) next to this repo as `funkot-autodj-for-ui` before the first build.

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
./dev.sh npm run build
./dev.sh cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Notes:

- The first run builds the `funkot-player-dev` image (Android NDK/SDK, GTK, and related deps). Expect on the order of tens of minutes.
- Temporary crates.io timeouts can occur; re-run the same `cargo` command.
- Frontend checks are `npm test`, `npm run check`, and `npm run build`.

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
