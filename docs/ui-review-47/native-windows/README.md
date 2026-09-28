# Windows native UI evidence

This is a selected evidence set for [Issue 47](https://github.com/yasuyuki/funkot-player/issues/47#issuecomment-5853349921).
The Issue owns acceptance, outstanding cases and restart conditions.

## Candidate 63a647f

Player `63a647f2e4500169b7d4394e840e9c37faf6eb56`, core
`b8e23759c4455b0cf6f79489291f9b72bd711319`; unsigned Windows EXE SHA-256
`0cb96f9bcea39ca4d75262a69c38e9f3bef1ece4bf8ccd596136b892cba9b557`.
Windows 11 Pro build 26200, WebView2 153.0.4234.48. The existing display and text
settings were retained. Screenshot widths are captured window pixels, not a
claim about CSS viewport dimensions. Inputs were actual mouse/keyboard events.

The disposable profile used 24 generated PCM WAV files with repeated titles,
long titles/artists and distinct paths/content hashes. Known analysis values
were seeded only into that test profile to exercise native UI/IPC/storage;
these observations do not test analysis accuracy or audio playback.

| Observation | Image |
|---|---|
| Non-active full-list editor after two moves; normal queue remains the source | [image](queue-nonactive-move.png) |
| Two columns above the existing 48rem container boundary | [820px capture](queue-boundary-above-820.png) |
| One column below the boundary | [816px capture](queue-boundary-below-816.png) |
| Narrow dialog, with input and both actions reachable | [image](queue-rename-dialog-414.png) |
| Escape closes the dialog and returns focus to its menu button | [image](queue-dialog-escape-focus-414.png) |
| Single add reports its selected destination | [image](single-add-destination-414.png) |
| The added occurrence remains selected after two upward moves | [image](duplicate-occurrence-move-414.png) |

Native storage readback: the added `entry-26` moved from index 24 to 22 while
the original same-track `entry-5` remained at index 3. The normal queue retained
24 items. Selecting the Library destination explicitly selected that playback
source; the earlier non-active editor operation kept the normal source.

This run exposed a failure: after adding to a playlist whose full editor was
already open, storage/remaining view had 25 entries but the full editor retained
24 until reopened. The subsequent fix and its acceptance are tracked in the
Issue. These images must not be read as proof that this failure was fixed.

AllTracks native captures containing private local paths remain in the private
evidence store. The Issue records their hashes and the native saved-value checks;
the public browser comparison remains under `../continuation/`.

After this run, the original profile's 854 files and pre-existing backup's 811
files matched every pre-run SHA-256. The guard stash was absent and no Funkot
process remained. No audio playback was requested. Android IME/font enlargement,
delete/Undo, bars Undo and FlaggedDetail semantics are not established here.
