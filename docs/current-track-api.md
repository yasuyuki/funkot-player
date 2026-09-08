# Current-track local API

On Windows, a companion tool can read Funkot's current track from a small loopback-only HTTP endpoint. It is disabled unless the process environment sets a non-zero port.
After building the Windows executable using the existing [Windows build instructions](../README.md#running-the-desktop-build), close that test instance if it is already running. From this repository root in PowerShell:

```powershell
$env:FUNKOT_CURRENT_TRACK_PORT = '43123'
& .\src-tauri\target\release\funkot-player.exe
```

`0`, an unset value, or an invalid value disables the endpoint. Restart Funkot after changing the value.

Request `GET http://127.0.0.1:43123/now-playing` (replace the port as needed):

```json
{"version":1,"title":"Track title","artist":"Artist","playing":true}
```

The response always has these fields. `playing` is true only while main playback is actively playing. A paused or stalled current track retains its title and artist with `playing: false`; before a track is known, and during an audition, title and artist are empty and `playing` is false.

The endpoint listens only on `127.0.0.1`, accepts only this GET route, rejects browser `Origin` requests, and provides no playback controls. It is intended for a local native companion process; there is no CORS support. If the port is already occupied or the server cannot start, Funkot logs a warning and audio playback continues normally.

The port above is an example, not a fixed application port. Configure the same port in
DJ Live Text and apply its settings. A received track is only a candidate: use its 曲紹介
button to send it. The app's existing current-track definition applies during mixing:
`NOW.now` changes at the end of a transition, not when the incoming audio first starts.
Title fallback is the filename when embedded title is absent; a missing artist is an empty string.

The manual Windows workflow also uploads `funkot-player-windows-portable`: the exact executable
used by the native smoke test and any adjacent DLLs. Extract the artifact to its own folder,
close the existing Funkot instance, open PowerShell in that folder, and launch it without an
installer:

```powershell
$env:FUNKOT_CURRENT_TRACK_PORT = '43123'
& .\funkot-player.exe
```

This build uses Funkot's normal application data location, so do not run it alongside another
Funkot instance. It is an unsigned development artifact, not a new Store release.

This environment variable applies to the process launched from that shell. It does not enable
an already running instance or imply support for Store activation. Any local process may read
this optional endpoint. The endpoint has no LAN binding, authentication, artwork, paths or commands.

The Windows workflow tests the compiled process's idle response and listener shutdown. Real
music playback, installed MSIX/Store behavior and simultaneous capture remain manual acceptance.
