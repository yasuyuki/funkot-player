# UI design and review

## Screen skeleton

Funkot Player's main job is helping people find a track, judge it, and play or add it. The list is the main content.

The screen has three bands: one navigation row at the top, the work area, and the playback bar at the bottom. The page itself never scrolls. The work area is divided into panes that scroll separately; the width decides how many panes are shown, and the navigation tabs switch the ones that do not fit. Tabs and pane columns switch at the same width, measured on the whole shell.

A change that adds permanent height outside the lists shows the `tests/ui/density.spec.mjs` measurement before and after.

## Size follows the input kind

There are two sizes. The primary pointer chooses between them, not the screen width ([ADR 0001](adr/0001-control-size-follows-input-kind.md)).

| | Mouse (`pointer: fine`) | Touch (`pointer: coarse`) |
|---|---|---|
| Minimum control height and width | 28px (1.75rem) | 44px (2.75rem) |
| Control label | 0.85rem | 0.95rem |
| Minimum list row height | 40px (2.5rem) | 48px (3rem) |

The values live in [`src/tokens.css`](../src/tokens.css) as rem, so enlarged text enlarges them. Within one input kind there is one ordinary control size; a screen does not invent another. The ⋮ menu overrides the detected kind with Automatic, For mouse or For touch. Android uses the same screen with the touch size. The touch size follows [WCAG target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html) and the mouse size exceeds the 24px [minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html); neither is a claim of complete WCAG conformance.

## Where an action goes

Classify an action by how often it is needed and what it acts on. Each class has one place.

| Class | Examples | Place |
|---|---|---|
| Needed at any time | start, pause, next track, flag | The playback bar: same position in every mode, one press |
| Main row action | add | One control at the end of the row, pressed directly |
| Secondary row action | favorite, label, edit tags | The most used one on the row; the rest in the long-press and right-click menu |
| Acts on the selection | move up, move down, remove, add several | An operation area shown only while something is selected |
| Pane tool | search, sort, filter, select | One row at the top of the pane |
| Management and rare | rename, clear, settings, log | The ⋮ and ⋯ menus |

- When pane tools do not fit one row, the least used move into a panel that opens and closes. While a condition inside the panel is active, its opener is marked.
- Show a state once per screen. The add target and the current track each need only one visible place.
- Say what an action applies to inside or beside the control. The flag button shows the transition it will flag.
- Information that needs no interaction is not a control. Title, artist and tags are text to read.
- A symbol-only button has an accessible name and a title.
- A navigation label is never cut short. Tabs that do not fit one line move to the next.

## List rows

A row has two lines: the title, then the artist with any accompanying information. New information joins the second line; there is no third line. A list for browsing truncates long names so that rows stay the same height. A list for comparing names while editing wraps them.

## Editors

Editors lead with the target, then current values and changes, then result and return actions. The actions sit below the scrolling content so that they never cover the control being edited.

Preserve each commit model: TagEditor sends a draft with Save; playlist edits persist immediately; bars apply immediately while Confirm resolves the flag, Cancel restores opening values and manual state, and Back keeps changes. Selection follows playlist entry identity, never the row index. The playback source and a browsed list are separate: browsing or closing an editor must not switch the source.

## What does not change

Keep accessible names, focus indication, keyboard order, contrast, and the loading, empty, disabled and error states. Choose colour and geometry from the roles in `src/tokens.css`. `.primary` adds emphasis, `.danger` marks destructive actions and `.quiet` reduces fill.

## Choose the verification route

Use the smallest existing layer that proves the changed behavior, in this order:

1. Pure/unit/state tests for logic and request construction.
2. Playwright browser tests for navigation, menus, inputs, ordering, displayed
   state, accessibility names and screenshots. Batch the whole flow in one test
   run rather than using Computer Use to click through known steps.
3. Native automation only for a changed Tauri/WebView boundary that the browser
   fixture cannot prove.
4. Visual/UX review of the prepared captures for hierarchy, density, readability,
   discoverability and human interaction feel. Computer Use is appropriate for
   those judgments or a remaining OS/native interaction; record the exact reason.

Reuse `tests/ui/` and its synthetic IPC seam. Prefer native elements with
`getByRole()` or `getByLabel()`, then existing stable semantic selectors.
Add a dedicated test id only when those cannot identify the target reliably.
Do not make screen coordinates or styling classes a new automation contract.
Assert the relevant request payload and resulting frontend state, not merely
that a button could be clicked. Mock replies establish the frontend contract,
not the native implementation.

Use Playwright’s existing file/title selection for a focused check, for example:

```sh
npm run ui:capture -- tests/ui/queue-ui.spec.mjs --grep "playlist removal keeps Undo"
```

This existing flow selects an occurrence, removes it and invokes Undo, checks
the exact occurrence/undo identifiers, and captures the final state for review
at both configured widths. Use the affected existing files for regression and
the full capture run when shell/layout changes require it. The report contains
test timing and attached screenshots; setup, tool round trips and visual
reasoning must also be counted when reporting end-to-end review time. An
occasional timing comparison is evidence for that run, not a speed guarantee.

### Native boundary

The browser fixture proves neither WebView2 rendering nor real Tauri IPC,
on-disk persistence/restart, OS dialogs, audio output or Android device behavior.
Keep existing build/device acceptance for those boundaries. Do not replay
ordinary DOM regression in a second native suite.

For a native change, first consider the existing
[Tauri WebDriver route](https://v2.tauri.app/develop/tests/webdriver/) on a built
Windows app. `tauri-driver` uses Edge WebDriver, whose version must match the
app's WebView2 Runtime. Use controlled test data and the existing profile protection
before any native mutation. The
[WebView2 WebDriver guide](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/webdriver)
distinguishes launching the app from attaching to a running WebView.
WebDriver does not operate OS-native dialogs; those need a separate native
automation or human/Computer Use check. DOM playback state does not establish
audible output. No native runner is required for a browser-only change:
record the changed boundary, available automation and any remaining native
review in the task Issue before adding one.

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
Inspect affected screens in the desktop and narrow runs, and the
column boundaries when navigation or shell layout changes. Use viewport images
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
