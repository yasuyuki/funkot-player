# Copy recognized Funkot tracks to Android

Scan the library in the PC app first, then use the existing transfer entry.
It needs Python and an authenticated adb connection. It reads app data and
source music without modifying them, and preserves existing device files.

## Configure the transfer

Start Funkot on the phone once so the app creates its Music directory.
Use the existing `adb-device` entry or authenticated adb server for connection.
Transfer does not pair devices, copy keys, or reinstall the app.

Keep a private JSON profile outside the repository. Run
`scripts/adb-push-music-list.py --help` for its keys and command arguments.
Configure the actual app data directory, adb, device identity or model, and
the cache version used by the app that produced the analysis. Windows sandbox
environment variables may resolve somewhere different from the installed app.

After an app update changes its analysis format, rescan in the app and update
the configured cache version. Older or incomplete analysis is not treated as
recognized Funkot.

## Run the transfer

```sh
python scripts/adb-push-music-list.py --profile /path/to/private-profile.json
```

Add `--dry-run` to inspect the difference without copying. A normal transfer
does not require a separate dry run. It uses the saved recognition result and
manual override, then skips device files with the same relative path and size.
It does not hash or reread the contents of the whole music library.

Transfers use a temporary name outside the app's audio extensions. A file is
promoted to its final name only after its size matches. Rerun the same command
after interruption. An existing final file with a different size is a conflict
and is preserved. Same-path, same-size files with different contents are not
distinguished by this lightweight comparison.

Explicit path lists use the same script's list mode. See `--help` and the
reported result for arguments, diagnostic categories, and completion status.

## Refresh the app

File transfer completion and app refresh are separate. Open the menu in the
phone's Funkot app, rescan, and confirm that the added tracks appear. The
transfer result does not certify completed analysis or successful playback.
