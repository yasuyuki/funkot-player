# UI design and review

## Project principles

Funkot Player’s main job is helping people find a track, judge it, and play or queue it. Start each UI change by recording the user’s main task and the action order it requires; hierarchy follows that task, rather than a heading-first template. Classify actions as primary, secondary, or rare, and justify each permanently visible control by its expected frequency and importance.

Keep search, sort, and filter controls grouped when they serve the same browsing purpose. Treat metadata display separately from controls: title, artist, tags, and other information should remain plain readable content unless an interaction is actually needed. Reuse an existing entrypoint before adding another one; if a new entrypoint is necessary, record why the existing route cannot serve the task. Preserve the title, artist, and main row action area when adding features.

Use progressive disclosure for infrequent editing, diagnostics, and management actions. Keep the main browsing and queue path visually dominant on desktop and around 412px wide. Reuse existing Svelte components and tokens. UI changes require rendered-screen review, while accessibility and keyboard behavior remain existing quality requirements.

## Shared roles and screen patterns

Choose the existing role in [`src/tokens.css`](../src/tokens.css) before choosing
new geometry or colour. Body text, metadata, action labels and headings have
separate jobs: labels use the shared control font and line height; supporting
metadata uses the small token. Neutral buttons are content width. `.primary`
adds emphasis, `.danger` marks destructive actions, and `.quiet` reduces fill.
Transport and MiniBar explicitly own playback colours. Layout may allocate
width; a screen must not invent another ordinary button size or shrink labels
to fit. The shared target floor applies to touch and mixed input at any width.
The target policy follows [WCAG target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html);
it is not a claim of complete WCAG conformance.

Library and History group exploration controls and show the current add target.
A direct add stays direct. Queue rows select an occurrence; one persistent
operation area serves repeated moves and removal. Selection follows playlist
entry identity, never the new row index. Playback source and a browsed list are
separate: browsing or closing an editor must not switch the source.

Editors lead with the target, then current values and changes, then result and
return actions. AllTracks keeps comparison columns at wide widths and a
readable summary plus target editor at narrow widths. FlaggedDetail selects a
partner and shares audition controls. Long names and extra partners must not
multiply management controls or bury the current edit.

Preserve each commit model: TagEditor sends a draft with Save; playlist edits
persist immediately; bars apply immediately while Confirm resolves the flag,
Cancel restores opening values and manual state, and Back keeps changes.
Use the existing `.edit-footer` with playback/toast clearance for long pages;
dialogs keep their actions within their own scroll area. A proposed exception
must name the user task or state that needs it and be reviewed beside the same
role in another current screen. Keep geometry in code, not a second value table.

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

It writes `artifacts/ui-review` with an HTML report and viewport captures. The current
scenarios and dimensions are defined by `tests/ui/` and `playwright.config.mjs`.
Inspect affected screens in the desktop and narrow runs, and the existing
two-column boundary when navigation or shell layout changes. Use viewport images
to judge initial occupancy and action reachability; full-page images may supplement
the overall structure. A passing command is rendering evidence, not visual approval.

For each state, check:

- The first visual focus matches the main task.
- Primary action is not buried among secondary or rare actions.
- New content does not unnecessarily take space or attention from title, artist, and main action.
- Infrequent operations are not always exposed.
- Controls serving one purpose are not scattered without a reason.
- Information that does not need interaction is not presented as an interactive control.
- Narrow wrapping preserves the action hierarchy.
- Implementation details, internal state, and diagnostics are not overexposed to ordinary users.

Also preserve accessible names, focus indication, keyboard order, readable contrast, usable targets, and clear loading, empty, disabled, and error states where they exist.

A trivial CSS or text change may skip capture only when it is clearly unable to affect layout or interaction hierarchy. This is a review-cost exception, not permission to make a broader fix without review.

The fixture loads the real `App.svelte`, tokens, and singleton store through the existing
`installIpcForTesting` seam before App import. It uses only synthetic tracks and
fixed IPC replies, date, locale, timezone and viewports; no Tauri process, audio,
user files, keys or service is needed. Unknown commands fail visibly. The fixture also exercises
mutation requests, failures and delayed replies through the real frontend.
Those assertions establish payload and screen state, not native persistence,
real audio, or WebView soft-keyboard acceptance. For interactive inspection,
`npm run dev` serves `/tests/ui/`; the production build still uses the normal root entry.

`artifacts/ui-review/report/index.html` links to captures under
`artifacts/ui-review/results/`. Keep evidence outside Git by default and link the
reviewed source revision, viewport/state, captures and findings from the task Issue.
The one-time `docs/ui-review-24/` images preserve the initial trial review evidence;
they are not comparison baselines and should not be updated by future captures.
Browser/OS/font changes may change pixels; review hierarchy and usability rather
than requiring cross-platform byte equality. Add only the affected state to the
fixture when a later UI task is not represented by the current Library examples.

When density or editing flow changes, compare the same data, viewport, locale and
input conditions before and after. Include long/duplicate names, more rows than
fit, missing data and the relevant busy/error states. Record readable rows and
control occupancy together with task steps; count first selection separately from
repeated edits. Check focus, Escape/return, text enlargement, short display height,
and actions while scrolling. Existing computed-style and behavior assertions in
`tests/ui/` should catch local geometry drift. Extend those tests only for a
changed behavior or uncovered acceptance state; do not create a CSS value lint
framework or use screenshot counts as a quality measure.
