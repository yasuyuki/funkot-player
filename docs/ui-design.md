# UI design and review

## Project principles

Funkot Player’s main job is helping people find a track, judge it, and play or queue it. Start each UI change by recording the user’s main task and the action order it requires; hierarchy follows that task, rather than a heading-first template. Classify actions as primary, secondary, or rare, and justify each permanently visible control by its expected frequency and importance.

Keep search, sort, and filter controls grouped when they serve the same browsing purpose. Treat metadata display separately from controls: title, artist, tags, and other information should remain plain readable content unless an interaction is actually needed. Reuse an existing entrypoint before adding another one; if a new entrypoint is necessary, record why the existing route cannot serve the task. Preserve the title, artist, and main row action area when adding features.

Use progressive disclosure for infrequent editing, diagnostics, and management actions. Keep the main browsing and queue path visually dominant on desktop and around 412px wide. Reuse existing Svelte components and tokens. UI changes require rendered-screen review, while accessibility and keyboard behavior remain existing quality requirements.

## Capture and review

From the repository root, install dependencies and Chromium once:

```sh
npm ci
npx playwright install chromium
```

On Linux, the host must also have the [Playwright Chromium system dependencies](https://playwright.dev/docs/browsers#install-system-dependencies). A normal development host can install them with `npx playwright install --with-deps chromium`; managed hosts use their existing dependency provisioning. Missing libraries are a setup failure, not a visual-review pass. Run the existing entrypoint:

```sh
npm run ui:capture
```

It writes `artifacts/ui-review` with desktop (1280×900) and narrow (412×915) JPEG screenshots for library, tag filter, and tag editor states, plus an HTML report. Inspect every capture. A passing command confirms these fixture states rendered; it is not human visual approval.

For each state, check:

- The first visual focus matches the main task.
- Primary action is not buried among secondary or rare actions.
- New content does not unnecessarily take space or attention from title, artist, and main action.
- Infrequent operations are not always exposed.
- Controls serving one purpose are not scattered without a reason.
- Information that does not need interaction is not presented as an interactive control.
- Narrow wrapping preserves the action hierarchy.
- Implementation details, internal state, and diagnostics are not overexposed to ordinary users.

Also preserve accessible names, focus indication, keyboard order, readable contrast, usable targets, and clear loading, empty, disabled, and error states where they exist. For this Issue, tag UI is reviewed as a current surface; its redesign is outside scope.

A trivial CSS or text change may skip capture only when it is clearly unable to affect layout or interaction hierarchy. This is a review-cost exception, not permission to make a broader fix without review.

The fixture loads the real `App.svelte`, tokens, and singleton store through the existing
`installIpcForTesting` seam before App import. It uses only synthetic tracks and
fixed IPC replies, date, locale, timezone and viewports; no Tauri process, audio,
user files, keys or service is needed. Unknown commands fail visibly. Playback,
queue mutations and tag persistence are intentionally not simulated: this is a
layout/interaction review fixture, not native acceptance. For interactive inspection,
`npm run dev` serves `/tests/ui/`; the production build still uses the normal root entry.

`artifacts/ui-review/report/index.html` links to the six captures under
`artifacts/ui-review/results/`. Keep evidence outside Git by default and link the
reviewed source revision, viewport/state, captures and findings from the task Issue.
The one-time `docs/ui-review-24/` images preserve the initial trial review evidence;
they are not comparison baselines and should not be updated by future captures.
Browser/OS/font changes may change pixels; review hierarchy and usability rather
than requiring cross-platform byte equality. Add only the affected state to the
fixture when a later UI task is not represented by the current Library examples.
