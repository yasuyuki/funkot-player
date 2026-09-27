# Issue 47 viewport evidence

One comparison set for [Issue 47](https://github.com/yasuyuki/funkot-player/issues/47).
The Issue owns the accepted revision, measurements, checks and remaining native
UI acceptance. These synthetic browser captures do not establish native storage,
audio or WebView keyboard behavior.

## Before / after

Before: `1bb2aac8c39dbbfd8f5017c450e720b67b0c6709`. After: the source commit
containing this directory. Both use Chromium 153.0.8010.12, English, dark mode,
device scale 1 and touch capability, at 1280×900 and 412×915.
The existing six fixture tracks repeat four times with unique synthetic paths
and hashes; the playlist contains all 24 occurrences and the flagged long-name
track has eight partners. Each image starts at scroll position zero.

| Screen | 1280 before | 1280 after | 412 before | 412 after |
|---|---|---|---|---|
| Library | [image](before/1280-library.jpg) | [image](after/1280-library.jpg) | [image](before/412-library.jpg) | [image](after/412-library.jpg) |
| Queue | [image](before/1280-queue.jpg) | [image](after/1280-queue.jpg) | [image](before/412-queue.jpg) | [image](after/412-queue.jpg) |
| AllTracks | [image](before/1280-all-tracks.jpg) | [image](after/1280-all-tracks.jpg) | [image](before/412-all-tracks.jpg) | [image](after/412-all-tracks.jpg) |
| FlaggedDetail | [image](before/1280-flagged-detail.jpg) | [image](after/1280-flagged-detail.jpg) | [image](before/412-flagged-detail.jpg) | [image](after/412-flagged-detail.jpg) |

`before/metrics.json` and `after/metrics.json` retain DOM bounding rectangles and
computed control styles. `rowsInViewport` counts whole rows within the viewport,
not partial rows. For FlaggedDetail the measured region is the bars editor.
AllTracks now includes readable title, artist and path; its old path-only row
count is not a measure of equivalent readable information. Queue measurements
start with no row selected; movement/removal appears in one shared toolbar after
selection. Counts of controls are omitted because the structures differ.

## Additional acceptance states

These are selected final viewport captures from the existing `tests/ui/` tests:

- [Short TagEditor after a failed Save](states/tag-short.jpg), with the input
  scrolled into the available field area and the action footer outside it.
- [Playlist full editor](states/playlist-editor.jpg), [History](states/history.jpg),
  [MiniBar](states/minibar.jpg), [tag filter](states/tag-filter.jpg),
  [AllTracks selected editor](states/all-tracks-editor.png).
- [1024px two-column layout](states/browse-1024.jpg) and [menu](states/menu-1024.jpg).
- FlaggedDetail in [Japanese](states/flagged-ja.jpg), [Indonesian](states/flagged-id.jpg),
  and [200% text](states/flagged-enlarged.jpg).

`SHA256SUMS` identifies these retained artifacts. Normal tests continue to write
temporary captures under `artifacts/ui-review`; this directory is a single task
evidence set, not a screenshot baseline to regenerate on each change.

## Continuation: AllTracks comparison and repeated editing

[Continuation captures and measurements](continuation/) use the same 24-track
fixture and viewport conditions as `after/`. Compare those two directories;
`before/` remains the earlier UI. The edited-source revision is the commit
containing `continuation/`. Editing JSON records the duplicate-name track 7,
then long-name track 8, two immediate value changes each, and Escape/focus return.
The enlarged capture uses Japanese and 200% root text. These are synthetic
browser observations; the Issue owns the judgment and remaining device acceptance.
