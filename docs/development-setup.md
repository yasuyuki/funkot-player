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

`funkot-core.commit` is the immutable core commit adopted by official player
builds. `./scripts/check-funkot-core-commit.sh` (and the Rust build script)
requires the sibling HEAD to match it; CI, the unsigned MSIX workflow, Android
release entry points, and local official builds share that rule. To test an
unmerged core candidate, check the sibling out at its full lowercase SHA and
set `FUNKOT_CORE_CANDIDATE_SHA` to that exact SHA for the build. This is a
candidate-only route: it never changes the tracked adoption file and cannot
produce an official artifact through the CI release workflows.

`dev.sh` checks the same rule before it starts Docker and mounts the sibling's
Git metadata read-only when the sibling is a linked worktree. This lets the
build script record and verify the adopted SHA without making the core source
writable in the container.

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

## Core adoption acceptance and device handoff

The September 2026 review starts at player `1ffcc032abdda49165227207b7ddf377125729b1`
and core `d2c1717c2385fccb2b6a5c06ac44bbda0f8fdff1`. The adopted core is recorded
in `funkot-core.commit`; record the tested player HEAD with it in the handoff.
The core review and synthetic render evidence live in its
[`docs/review-2026-09.md`](https://github.com/yasuyuki/funkot-autodj/blob/master/docs/review-2026-09.md).

Ordinary Checks validates the exact pair on Linux and Windows, including an
unsigned Windows executable. Native regressions cover manual edit/undo after
background analysis starts, persisted overrides and cache reloads, cold hash
insertion, warm fingerprint reuse, and hash-index reload. These tests do not
establish device playback or listening acceptance.

For a device handoff, the core executor verifies the adopted commit in the
dedicated sibling; the player executor changes only the player member. Use the
existing registered environment and its Git handoff procedure. Do not replace
an in-progress core topic or copy signing material into a development checkout.
The receiving executor must verify both full SHAs and run
`./scripts/check-funkot-core-commit.sh` in the player root with candidate mode unset.

| Receiving executor / cwd | Existing operation | Required observation and side effects |
|---|---|---|
| Core executor with existing Docker/NDK; core root | `./cross-build.sh android` | Android arm64 SDK builds with the added dependency; generated `dist/android-arm64` contains shared/static core, header and `libc++_shared.so`. No device operation. |
| Player executor in the existing Android agent checkout; player root | `./scripts/android-signed-release.sh prepare` | Creates the existing bundle/meta handoff for the exact adopted pair. Requires the declared Windows-visible handoff destination; does not sign. |
| Existing signing owner; owner checkout | The `build` command printed by `prepare` | Signed APK uses the same pair. This command can install on an already connected matching phone; the owner must authorize that device operation before running it. No release publication is needed. |
| Windows/Android device executor with a disposable test profile and available test tracks | Existing desktop/device procedures in README | Cold and warm startup, first sound, next/prev/repeated navigation, edit then restart, non-Funkot fallback and supported output formats pass. Verify cache, library overrides and displayed index agree; retain existing user data. |

Keep Android dev-profile optimization, API 26 minimum, 16 KB alignment and shared
C++ runtime. At 44.1/48 kHz record device/format, finite output, peaks/over-range
samples and unexpected silence separately from listening results. Synthetic
tests, failure injection and atomic replacement do not prove power-cut durability.
An unavailable device, audio source or authorized signing environment remains
an uncompleted acceptance item, not a pass.

Classify/CLI/transition decomposition, full-file hash migration, peak processing,
Stage 3 analysis adoption and streaming redesign remain independent later tasks.
The dependency-policy exceptions are limited to six unmaintained Tauri
transitives, with paths and reevaluation conditions in `src-tauri/deny.toml`.

## Android Recents exit acceptance

For [issue #7](https://github.com/yasuyuki/funkot-player/issues/7), build the
candidate player commit with the exact core in `funkot-core.commit`, using the
existing Android build and owner handoff above. Record both SHAs and the APK
hash with the device model and Android version. Host tests cannot exercise
Activity destruction or demonstrate that the relaunched WebView renders.

On the affected Pixel 10 Pro / Android 17, use the existing device procedure in
[README](../README.md#working-with-a-device) with a test profile and test tracks.
Open Funkot from its launcher icon before each case. Do not force-stop, clear
app data, or reinstall between removal and relaunch: those operations hide the
same-process failure.

| Initial state | Device action | Required observation |
|---|---|---|
| Playing | Go Home, then reopen Funkot from its launcher icon | Sound continues in the background; the player screen renders on return. |
| Playing | Press Back, then reopen Funkot from its launcher icon | Same as Home; Back must not finish the task. |
| Playing | Open Recents and swipe away Funkot, then tap its launcher icon | Sound stops on removal. The old PID exits; relaunch uses a fresh PID and displays the library and transport controls. Start playback again and confirm sound. |
| Paused | Remove the task in Recents, then reopen Funkot | No old audio resumes; a fresh process displays working controls. Also test after Android has reaped the paused service. |
| Playback never started | Remove the task in Recents, then reopen Funkot | The player screen renders and playback can be started. |

Record the PID before removal and after relaunch, actual screen contents and
sound, plus the media-session state. `Activity` being `RESUMED` alone is not a
pass: the original failure reached that state with a blank screen. Repeat the
playing removal/relaunch case to cover warm launches. Keep the issue open until
both the stop and visible relaunch pass, along with Home/Back playback.
