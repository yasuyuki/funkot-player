# Development setup

External-contributor guide for a first successful `./dev.sh` run.
These steps were verified on Ubuntu 24.04 under WSL2 with systemd.

For Android builds, ADB, desktop GUI, and shipping, see [README.md § For developers](../README.md#for-developers) after the smoke checks below pass.

## Compatibility and data migration

All products under the maintainer's control follow this policy, including
funkot-player. A new version does not have to preserve compatibility with the
currently released or used version. Breaking changes to APIs, CLI commands,
configuration, behavior, and storage formats are allowed. Do not retain aliases,
compatibility layers, old branches, or duplicate implementations solely to keep
old versions compatible. Breaking compatibility or removing working features
without a purpose is not a goal.

When persistent data becomes incompatible, support forward conversion from only
the immediately preceding data-format generation into the current format.
A generation boundary is an incompatible persistent-data format change.
Application releases, patches, and commits that keep the same format belong to
the same generation. Use the product's existing format identifiers.
With current format N, provide N-1 to N conversion and advance that window at
the next incompatible generation. Do not accumulate converters for older
generations. Direct or chained upgrades from N-2 or earlier, reverse conversion,
old-version reads or writes, and application downgrade compatibility are not
supported. Changes that leave persistent data compatible do not require a converter.

This policy does not authorize data loss. Preserve user-owned information that
must carry forward and keep the original recoverable until conversion is verified.
Report unsupported old generations, unknown new formats, corruption, and conversion
failures. Never replace them with apparently valid empty data. Preserving an
unsupported format does not guarantee that the current product can interpret or
convert it. Regenerable derived data may be rebuilt under the existing protection
and use conditions in [the local-data guide](local-data.md). Do not treat manual
or otherwise non-regenerable data as disposable derived data.

Each product owns its implementation, conversion, and verification. The current
supported combination of player, core, dependencies, IPC, and storage must still
work correctly. Keep source-identity checks, core adoption rules, safety,
permissions, and data-protection requirements. Where a breaking change affects
users, explain the changed contract and supported conversion in the existing
change documentation. Do not introduce a migration framework, compatibility
register, approval layer, or per-task compliance report merely to assert this policy.

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

## Compare a captured manual Next

The optional Windows diagnostic capture connects one manual Next to its exact
Engine request, applied plan, transition and fade end. It is disabled during
normal use. Use the existing protected test profile and process-specific
loopback recorder. Prepare the input, endpoint, recorder and build identities
before requesting permission to start sound.

Set `FUNKOT_NAVIGATION_CAPTURE_DIR` to an existing unused private directory
before starting the player. The capture writes `navigation-header.json`,
`navigation.jsonl` and `callbacks.csv`. It records full input hashes and the
actual EngineOptions. Callbacks send bounded value records. A writer thread
serializes them. Any lost record makes the comparison incomplete.

Set `FUNKOT_NAVIGATION_REQUIRE_START_SIGNAL=1` with that directory to open the
real output stream in silence. Match the writer's `output-stream.jsonl` to an
external process-session observation before requesting the user's sound signal.
Only then write its matching `START.json`. The authorization schema is exercised
in `src-tauri/src/navigation_capture.rs`. A reopened stream clears that signal.

After the selected operation and required transport controls, create `STOP`
in that directory. Keep the loopback recorder running until
`navigation-complete.json` exists, then finalize it before closing the player.
An abrupt player exit without the capture footer is incomplete.

Use the adopted core's existing `manual_nav_acceptance` example with
`--at-frame` from the accepted request's `active_playhead`, the recorded sample
rate, and `--engine-options` pointing to the capture header. `--reuse-cache`
accepts a private copy of the captured cache. Its JSON records actual trace,
source, executable, input hashes and the WAV's Engine frame origin.

Navigation generations identify events within one Engine run. Compare separate
runs at the same active playhead and by timing relative to request acceptance;
their generation numbers and output-frame origins can differ. A pause request
renders the existing transport envelope before the Engine freezes.

Run `node scripts/audio-anomaly-detector.cjs compare capture.json replay.json - result.json`.
The two manifests describe actual source, executable, input and recording files.
The runnable fixture in `scripts/audio-anomaly-comparison.test.cjs` demonstrates
their format. The capture manifest also binds hashed endpoint, calibration and
fixed-input source receipts. Endpoint receipts record the before and after
process session observations. Calibration receipts bind the calibration bytes,
the stable endpoint route and complete negative, transient and dropout scans.
Each control also binds its captured PCM, reference WAV, packet and callback
records. Positive controls bind the injected PCM transformation. A missing or
invalid calibration leaves the separately derived plan comparison available,
but leaves sound quality incomplete.
The source receipt supports one fixed, unique-content input sequence. Managed
playlist scope is incomplete. Expected decisions come only from the hashed
real-engine trace and complete all-window scan coverage.
The comparison supports one Next and reports ambiguous or missing requests as
incomplete. Same-rate PCM correlations are observations, not an audio-quality
PASS. It reports comparison evidence separately from `soundQuality`. A
no-anomaly result requires a complete clean scan, measured PCM alignment, and
one same-condition route: the endpoint, capture engine, captured WAV, replay
engine and replay WAV must all be 48 kHz stereo `f32`. Cross-rate timing can
still compare the plan, but its sound quality is incomplete. A new endpoint
needs its own calibration. Audibility outside the fixed input and hardware
timing guarantees remain outside this comparison.

For state-aware PCM inspection, use the detector's `calibrate-state` command
with two independent negative recordings, then `scan-state` for the target and
offline injected controls. The state descriptors bind the PCM, replay, endpoint,
packet and callback files. Every recorded frame needs an audio comparison or a
verified intentional-silence state. See `scripts/audio-anomaly-detector.test.cjs`
for a runnable fixture. Unknown states and incomplete coverage stay incomplete.

## Playlist occurrence proof

[The bounded Kani check](../verification/README.md) shares the production progress
module and runs independently of native/UI builds. On Linux x86_64 with Docker
and cgroup v2:

```sh
./scripts/check-playlist-progress.sh --setup # fixed verifier image, cached
./scripts/check-playlist-progress.sh        # writes evidence under /tmp
```

The same check runs in the independent **Playlist occurrence proof** Checks job.

## Engine snapshot coherence

The Loom check uses Rust 1.93 and Loom 0.7.2. It imports the production `EngineObservation` module. With Docker, it reuses the Kani image. Without Docker, it uses host `cargo +1.93.0`.

```sh
./scripts/check-engine-snapshot.sh /tmp/engine-snapshot-proof
```

Success is `"status": "PASS"` in the printed summary. That status means the four named tests ran and passed on the production module. A Cargo exit code of 0 with a filtered or missing test is a failure. The playlist proof above is a separate command.

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

## Dependency maintenance

Dependabot proposes weekly npm, Gradle, GitHub Actions and Docker image updates.
Review and merge them explicitly. Vite/Svelte peer updates, Tauri's npm/Rust/Android
pairing, AGP/Gradle/Kotlin/JDK and CPAL/JNI/NDK each need a compatibility decision;
patch grouping is not proof of compatibility, especially for 0.x packages. Major
updates remain separate proposals. Cargo is checked separately because its real
pinned core lives in a sibling repository.

The **Dependency audit and Cargo candidates** workflow runs weekly, manually, and
on dependency changes. Its npm audit includes development dependencies and blocks
high/critical findings; the report retains lower severities and registry errors.
Rust uses the existing `deny.toml` with the player's locked graph, including its
six documented Tauri exceptions. Reevaluate those paths when updating Tauri.

From the player root with the clean, adopted core sibling:

```sh
./dev.sh python3 scripts/check-cargo-updates.py
./dev.sh cargo update --manifest-path src-tauri/Cargo.toml -p <package> --precise <version>
```

The first command only reports candidates within current manifest constraints;
it is not a complete major-version inventory. A failed pin, resolver, network or
source-integrity check fails the command. The second is an intentional,
package-specific lockfile update: replace the two placeholders with the reviewed
package and version. The core's own lockfile does not govern the player graph.
Run the existing frontend, locked native and invariant checks after updating.

**Checks** builds/tests Linux with the normal Dockerfile and passes its actual
Rust/Node/npm versions to Windows. Both jobs record the observed versions in
Actions summaries; the Dockerfile remains the toolchain source. Rebuild a stale
local image with `docker build -t funkot-player-dev .` before comparing results.

For Android-affecting dependencies, **Android dependency build (no owner signing)**
runs on matching PRs or manual dispatch. On an existing Docker/SDK host, the same
build is:

```sh
./dev.sh npm ci
./dev.sh npx tauri android build --ci --debug --apk --target aarch64 -- --locked
```

This uses the existing Gradle project and caches, creates a test APK with a generated
debug key, and needs no owner credentials, device or installation. Do not run
`android init` over the customized project. A host test does not replace this build
or device/listening acceptance.

Dependabot configuration alone does not establish successful bot execution. Review
its update logs/PRs separately from the audit and build workflows. Docker checks
image tags, not Debian apt packages or SDK/NDK/command-line-tools arguments. The
Gradle updater also detects wrapper versions, but wrapper/AGP/Kotlin/JDK
compatibility still requires review. SDK/Build Tools, Java selection and
Rust/Android linkage settings are outside these updater entries.

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
| Existing signing owner; owner checkout | The `build` command printed by `prepare` | Signed Release/R8 APK uses the same pair. Build performs no device operation. Use the separate `install` command only after the owner authorizes the update and the release role and actual serial match. |
| Windows device executor; player root with a protected test profile and test tracks | Existing Windows Release build and profile-guard procedures in README | Verify the candidate's source/core, version and artifact hash. Observe light/dark/system, native high-contrast on/off, restart and viewport changes in Release/WebView2. Check rendered background, text, menus, dialogs, inputs, selection and status. Browser forced-colors emulation is supplementary. |
| Android device executor; existing release device or a dedicated synthetic old-profile test device | Existing signed `install` and device procedures in README | Verify the certificate, version, ABI, R8 and artifact identity before an authorized data-preserving update. Upgrade the preceding data generation with synthetic tracks and queue/settings state still present. Check the library, recovery choice, playback/Next, pause/resume and cold restart. Preserve originals; a fresh profile alone does not establish upgrade acceptance. |

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
playing removal/relaunch case to cover warm launches. Capture the crash buffer
and process/service events across removal: the old PID must not report SIGSEGV
or another fatal crash. If Android recreates a service before relaunch, record
whether it retires without playback; no orphan service, live playback session
or playback notification should persist.
A working new screen alone does not prove a clean exit. Keep the issue open until
the stop, crash-free exit and visible relaunch pass, along with Home/Back playback.
