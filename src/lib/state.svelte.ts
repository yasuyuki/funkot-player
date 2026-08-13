// Single store: the only place that polls `player_state` / `queue_state` and
// holds the results. Components read derived values off `store`; none of them
// talk to `tauri.ts` directly for playback/queue state, so there is exactly
// one poll loop and exactly one place a "what changed since last time" bug
// can hide. Analysis / library-scan events are also listened to here only —
// same reason.
import { listen } from "@tauri-apps/api/event";
import {
  appDirs,
  playerState,
  queueState as queueStateCmd,
  refreshLibrary,
  start as startCmd,
  togglePause as togglePauseCmd,
  skipNext as skipNextCmd,
  flagLastTransition as flagLastTransitionCmd,
  undoLastFlag as undoLastFlagCmd,
  enqueue as enqueueCmd,
  dequeue as dequeueCmd,
  reorder as reorderCmd,
  listFlaggedTracks as listFlaggedTracksCmd,
  dismissFlags as dismissFlagsCmd,
  undoLastDismiss as undoLastDismissCmd,
  setBars as setBarsCmd,
  auditionTransition as auditionTransitionCmd,
  auditionAgain as auditionAgainCmd,
  resumeAutodj as resumeAutodjCmd,
  setMusicDir as setMusicDirCmd,
  getAllowNonFunkot as getAllowNonFunkotCmd,
  setAllowNonFunkot as setAllowNonFunkotCmd,
  takePendingImport as takePendingImportCmd,
} from "./tauri";
import type {
  AnalysisProgress,
  AppDirs,
  FlaggedTrackRow,
  FlagResult,
  ImportResult,
  LibraryScanProgress,
  PlayerState,
  QueueSnapshot,
  TrackRow,
} from "./tauri";
import { toast } from "./toast.svelte";

/// How often `player_state` / `queue_state` are polled. A self-rescheduling
/// `setTimeout`, not `setInterval`: an `invoke` that is slow to answer (or a
/// phone that just woke the WebView back up) must not stack a second poll on
/// top of one still in flight.
const POLL_INTERVAL_MS = 500;

/// How often the client-side elapsed-time interpolation between polls ticks.
const INTERPOLATION_TICK_MS = 250;

/// How long `doTakePendingImport` waits before retrying while
/// `ImportResult.in_flight` is `true` (`Import.kt`'s copy thread has not
/// finished yet). Not folded into `POLL_INTERVAL_MS`'s `#poll` loop -- that
/// would hit the JNI drain on every tick instead of only while a share-sheet
/// copy is actually in progress.
const IMPORT_RETRY_MS = 1500;

class PlayerStore {
  dirs = $state<AppDirs | null>(null);
  player = $state<PlayerState | null>(null);
  queue = $state<QueueSnapshot | null>(null);
  /// Keyed by absolute path (`TrackRow.path`), matching
  /// `PlayerState.now_playing` / `.previous` and `TransitionInfo.from` /
  /// `.to`. Basenames can collide across subdirectories now that scanning is
  /// recursive, so path is the only safe key. Insertion order follows the
  /// last `refresh_library` response so `libraryList` stays stable for the
  /// play-tab list.
  library = $state<Map<string, TrackRow>>(new Map());
  /// Non-null while a background analysis run is in flight. Cleared on
  /// `analysis-done` (or overwritten by the next progress event).
  analysis = $state<{ done: number; total: number; name: string } | null>(null);
  /// Non-null while `refresh_library` is walking / hashing. Cleared when the
  /// invoke returns (success or error).
  libraryScan = $state<LibraryScanProgress | null>(null);
  /// Last invoke failure, from either the poll loop or a transport action.
  /// Polling keeps running after one of these; it is not fatal.
  lastError = $state<string | null>(null);
  /// Edit-tab flagged list (`list_flagged_tracks`). Empty until first load.
  flaggedRows = $state<FlaggedTrackRow[]>([]);
  /// `settings.json` `allow_non_funkot`. Grey styling is independent of this.
  allowNonFunkot = $state(false);

  /// Wall-clock time (`Date.now()`) the current `player.position_secs` was
  /// read at, so `elapsed` can add "how long ago was that" on top of it
  /// between polls instead of holding still for up to `POLL_INTERVAL_MS`.
  #polledAt = $state(0);
  /// Ticks every `INTERPOLATION_TICK_MS` purely to give `elapsed` a reactive
  /// dependency to recompute against; its value is only ever compared to
  /// `#polledAt`.
  #tickNow = $state(Date.now());
  /// Guards `doRefreshLibrary` (⋮ 再スキャン) against double-taps while an
  /// earlier walk is still in flight — same role as legacy `withBusy(scan)`.
  /// Shared with `#reloadLibraryQuiet` so analysis-done cannot start a second
  /// `refresh_library` on top of an in-flight rescan (or vice versa).
  #libraryBusy = false;
  /// Guards `doTakePendingImport` against overlapping calls -- same role as
  /// `#libraryBusy`. The cold-start call in `#init` and the
  /// `visibilitychange` listener can otherwise race (e.g. backgrounding the
  /// app again immediately after launch).
  #importBusy = false;
  /// Set when a `doTakePendingImport` call is bounced by `#importBusy`
  /// instead of silently dropped: the in-flight call's `finally` re-runs it
  /// exactly once after finishing, so a share that lands while the previous
  /// drain is still running is not lost until the next unrelated trigger
  /// (`visibilitychange`, the `in_flight` retry, …).
  #importPending = false;
  /// Set when `doTakePendingImport` imported something but the follow-up
  /// `doRefreshLibrary()` was bounced by `#libraryBusy` (typically the
  /// startup walk still running) -- the newly-copied file may have appeared
  /// too late for that walk to see it, so a refresh is still owed even once
  /// a later `doTakePendingImport` call finds nothing new left to import.
  #importRefreshOwed = false;
  /// Bumped on every immediate queue refresh after enqueue/dequeue/reorder.
  /// Poll / refresh responses whose captured gen no longer matches are
  /// discarded so a slow poll cannot overwrite a fresher post-mutation snapshot.
  #queueGen = 0;
  /// Generation guard for `loadFlaggedTracks` (legacy `flaggedLoadGen`).
  #flaggedGen = 0;

  constructor() {
    void this.#init();
  }

  async #init() {
    try {
      this.dirs = await appDirs();
      if (this.dirs.music_dir_needed && this.dirs.music_dir_unavailable) {
        this.lastError = `指定した音楽フォルダを開けません: ${this.dirs.music_dir_custom}`;
      }
    } catch (e) {
      this.lastError = String(e);
    }
    // Cold-start share-sheet import (Android only; a no-op elsewhere -- see
    // `take_pending_import`'s doc comment). Awaited so a track shared in
    // before launch is already on disk for the startup `refreshLibrary` walk
    // below, rather than waiting for the next rescan.
    await this.doTakePendingImport();
    try {
      this.allowNonFunkot = await getAllowNonFunkotCmd();
    } catch (e) {
      this.lastError = String(e);
    }

    // Register listeners before the startup refresh so `library-scan` (and
    // analysis) progress is visible from the first walk, not only later rescans.
    try {
      await listen<LibraryScanProgress>("library-scan", (event) => {
        this.libraryScan = event.payload;
      });
      // Analysis events land here only. Progress carries the finished row so
      // we splice by path (no full folder walk per track); done reloads the
      // listing without re-kicking analysis (failures must not loop forever).
      await listen<AnalysisProgress>("analysis-progress", (event) => {
        const { done, total, name, row } = event.payload;
        this.analysis = { done, total, name };
        this.#replaceLibraryRow(row);
      });
      await listen("analysis-done", () => {
        this.analysis = null;
        void this.#reloadLibraryQuiet();
      });
    } catch (e) {
      this.lastError = String(e);
    }

    // Already-running share-sheet import (Android only): the app comes back
    // to the foreground rather than restarting, so `#init` never runs again
    // -- this is the only other point files staged by `Import.kt` get drained.
    // Deliberately not folded into `#poll` (500ms): that would hit the JNI
    // drain on every tick instead of only when the app was just backgrounded.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        void this.doTakePendingImport();
      }
    });

    // Start polling before the startup library walk. A long scan holds
    // `refreshLibrary` for a while; Start is still allowed during that time,
    // and without `#poll` the UI would keep `phase ?? "idle"` / miss
    // `now_playing` even though audio is already running. Title can fall
    // back to basename; artist waits for a library row.
    this.#poll();
    setInterval(() => {
      this.#tickNow = Date.now();
    }, INTERPOLATION_TICK_MS);

    // Startup walk: title/artist resolve against `library` (`TrackRow` by
    // path), and `refresh_library(true)` also kicks analysis of unanalysed
    // tracks — wanted here so the loader does not analyse mid-playback
    // (`stalled`). Takes `#libraryBusy` so a slow SMB walk cannot race
    // ⋮ 再スキャン (which would clear `libraryScan` from the first
    // finisher's `finally`).
    this.#libraryBusy = true;
    try {
      const rows = await refreshLibrary(true);
      this.library = new Map(rows.map((r) => [r.path, r]));
    } catch (e) {
      this.lastError = String(e);
    } finally {
      this.libraryScan = null;
      this.#libraryBusy = false;
    }
  }

  async #poll() {
    try {
      const state = await playerState();
      this.player = state;
      this.#polledAt = Date.now();
    } catch (e) {
      this.lastError = String(e);
    }
    try {
      const gen = this.#queueGen;
      const q = await queueStateCmd();
      if (gen === this.#queueGen) this.queue = q;
    } catch (e) {
      this.lastError = String(e);
    }
    // Reschedule unconditionally: a `failed`/`disconnected` phase, or a
    // transient invoke error, both still need to keep being polled so the UI
    // can pick up a recovery. See the store's own doc comment for why this
    // is a self-rescheduling timeout rather than `setInterval`.
    setTimeout(() => this.#poll(), POLL_INTERVAL_MS);
  }

  async #reloadLibraryQuiet(): Promise<void> {
    // Single-flight with ⋮ 再スキャン: if a walk is already running, that
    // result is enough — do not stack a second `refresh_library`.
    if (this.#libraryBusy) return;
    this.#libraryBusy = true;
    try {
      // List only — do not re-queue analysis (would loop on permanent failures).
      const rows = await refreshLibrary(false);
      this.library = new Map(rows.map((r) => [r.path, r]));
    } catch (e) {
      // Ignore on analysis-done the same way legacy did: a stray error here
      // shouldn't disrupt the UI after the worker itself has finished.
      this.lastError = String(e);
    } finally {
      this.libraryScan = null;
      this.#libraryBusy = false;
    }
  }

  /// Swap one library row in place by `path` (preserving insertion order for
  /// every other entry).
  #replaceLibraryRow(row: TrackRow): void {
    const next = new Map(this.library);
    next.set(row.path, row);
    this.library = next;
  }

  /// Ordered view of `library` for the play-tab list. Map insertion order
  /// follows the last full refresh; progress splices update values in place.
  get libraryList(): TrackRow[] {
    return Array.from(this.library.values());
  }

  /// Start stays off until a usable Music folder is chosen and at least two
  /// tracks are listed. `music_dir_needed` is the Store first-launch gate.
  get canStart(): boolean {
    return !this.dirs?.music_dir_needed && this.libraryList.length >= 2;
  }

  /// Seconds into the current track, client-side interpolated between polls.
  /// Only interpolates while `phase === "playing"`: paused / stalled /
  /// starting positions do not move on their own, and interpolating them
  /// anyway would drift the bar ahead of what is actually being heard.
  /// Snaps back to the server's value on every poll, and is clamped to
  /// `[0, duration_secs]` when the duration is known (a same-track restart
  /// can otherwise put a stale interpolated value past the new duration).
  get elapsed(): number | null {
    const p = this.player;
    if (!p || p.position_secs === null) return null;
    let value = p.position_secs;
    if (p.phase === "playing") {
      value += Math.max(0, (this.#tickNow - this.#polledAt) / 1000);
    }
    if (p.duration_secs !== null) {
      value = Math.min(Math.max(value, 0), p.duration_secs);
    }
    return value;
  }

  pathBasename(path: string): string {
    const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return i >= 0 ? path.slice(i + 1) : path;
  }

  /// Path relative to `music_dir`, for display (e.g. `AlbumA/01.mp3`).
  /// `music_dir` (from `app_dirs`) is the exact prefix every scanned path is
  /// `join`ed onto, so a plain string prefix check is enough -- no path
  /// normalisation needed. Falls back to the basename whenever that
  /// assumption does not hold (`dirs` not loaded yet, `path` outside
  /// `music_dir`, or `path === music_dir` itself) rather than surface a
  /// malformed string.
  relName(path: string): string {
    const musicDir = this.dirs?.music_dir;
    if (!musicDir || !path.startsWith(musicDir)) return this.pathBasename(path);
    const rest = path.slice(musicDir.length).replace(/^[/\\]+/, "");
    if (!rest) return this.pathBasename(path);
    return rest.replace(/\\/g, "/");
  }

  /// Looks up a library row by its absolute path (the library `Map`'s key).
  trackForPath(path: string): TrackRow | undefined {
    return this.library.get(path);
  }

  titleForPath(path: string): string {
    return this.trackForPath(path)?.title ?? this.pathBasename(path);
  }

  artistForPath(path: string): string {
    return this.trackForPath(path)?.artist ?? "";
  }

  /// `now_playing` resolved via `titleForPath`, kept nullable (unlike
  /// `titleForPath` itself) so `NowCard` can tell "no track" apart from
  /// "unresolved title".
  get nowTitle(): string | null {
    const path = this.player?.now_playing;
    if (!path) return null;
    return this.titleForPath(path);
  }

  /// As `nowTitle`, for the artist. Empty string (not null) when unresolved,
  /// matching `TrackRow.artist`'s own "no artist tag" convention.
  get nowArtist(): string {
    const path = this.player?.now_playing;
    if (!path) return "";
    return this.artistForPath(path);
  }

  /// idle → start. Requires `dirs` to already have resolved; the only caller
  /// (`Transport`) only offers this while `phase === "idle"`, by which point
  /// `#init` has long since had time to resolve them.
  async doStart(): Promise<void> {
    if (!this.dirs) {
      this.lastError = "app directories are not resolved yet";
      return;
    }
    try {
      await startCmd(this.dirs.music_dir, this.dirs.cache_dir);
    } catch (e) {
      this.lastError = String(e);
    }
  }

  async doTogglePause(): Promise<void> {
    try {
      await togglePauseCmd();
    } catch (e) {
      this.lastError = String(e);
    }
  }

  async doSkipNext(): Promise<void> {
    try {
      await skipNextCmd();
      // Host drops TransitionToNext while next is unset; refresh queue so
      // reserved_prepared (and thus canSkipNext) drops without waiting for poll.
      await this.#refreshQueueNow();
    } catch (e) {
      this.lastError = String(e);
    }
  }

  /// Records `player.last_transition` as a bad mix. Never touches playback
  /// (see `flagLastTransition`'s doc comment). Returns the `FlagResult` so
  /// the caller can build the toast message from the *flagged pair's*
  /// titles (`from_title`/`to_title`, resolved server-side) rather than
  /// re-resolving `now`/`previous` against the library, which could drift
  /// from what was actually recorded.
  async doFlagLastTransition(): Promise<FlagResult | null> {
    try {
      return await flagLastTransitionCmd();
    } catch (e) {
      this.lastError = String(e);
      return null;
    }
  }

  /// Undoes the most recent flag (single-shot). `false` covers both a
  /// genuine invoke failure and "nothing to undo" -- either way the caller
  /// (the toast) should not treat this as consumed.
  async doUndoLastFlag(): Promise<boolean> {
    try {
      await undoLastFlagCmd();
      return true;
    } catch (e) {
      this.lastError = String(e);
      return false;
    }
  }

  async #refreshQueueNow(): Promise<void> {
    // Invalidate in-flight poll/refresh writers before we fetch, so their
    // older snapshot cannot land after this mutation's result.
    this.#queueGen += 1;
    const gen = this.#queueGen;
    try {
      const q = await queueStateCmd();
      if (gen === this.#queueGen) this.queue = q;
    } catch (e) {
      this.lastError = String(e);
    }
  }

  async doEnqueue(path: string): Promise<void> {
    try {
      await enqueueCmd(path);
      await this.#refreshQueueNow();
    } catch (e) {
      this.lastError = String(e);
    }
  }

  async doSetAllowNonFunkot(allow: boolean): Promise<void> {
    try {
      this.allowNonFunkot = await setAllowNonFunkotCmd(allow);
    } catch (e) {
      this.lastError = String(e);
    }
  }

  /// `index` is a displayed-list index (see `dequeue`'s doc comment in
  /// `src/lib/tauri.ts`); `expect` is the path shown there. Returns the
  /// error code (`"too_late"` / `"stale"` / `"out_of_range"` /
  /// `"auditioning"`, or the generic invoke failure string) on failure,
  /// `null` on success, so the caller can pick a toast message without
  /// re-parsing `lastError`. Refreshes the queue either way: a `"stale"` (or
  /// any other) rejection means what's on screen may already not match the
  /// host, so the caller's next render should show the current truth rather
  /// than the guess that just failed.
  async doDequeue(index: number, expect: string): Promise<string | null> {
    try {
      await dequeueCmd(index, expect);
      await this.#refreshQueueNow();
      return null;
    } catch (e) {
      const message = String(e);
      this.lastError = message;
      await this.#refreshQueueNow();
      return message;
    }
  }

  /// As `doDequeue`, for `Move`. `from`/`to` are displayed-list indices;
  /// `expect` is the path shown at `from`.
  async doReorder(from: number, to: number, expect: string): Promise<string | null> {
    try {
      await reorderCmd(from, to, expect);
      await this.#refreshQueueNow();
      return null;
    } catch (e) {
      const message = String(e);
      this.lastError = message;
      await this.#refreshQueueNow();
      return message;
    }
  }

  /// ⋮ 再スキャン. Refuses a second call while one is already in flight.
  async doRefreshLibrary(): Promise<
    { ok: true; count: number } | { ok: false; error: string } | { ok: false; busy: true }
  > {
    if (this.#libraryBusy) return { ok: false, busy: true };
    this.#libraryBusy = true;
    try {
      const rows = await refreshLibrary();
      this.library = new Map(rows.map((r) => [r.path, r]));
      return { ok: true, count: rows.length };
    } catch (e) {
      const error = String(e);
      this.lastError = error;
      return { ok: false, error };
    } finally {
      this.libraryScan = null;
      this.#libraryBusy = false;
    }
  }

  /// Drains files staged by the Android share sheet (`Import.kt`) into
  /// `music_dir` and, if any landed, rescans and toasts a summary. Always a
  /// silent no-op on desktop (`take_pending_import` returns zeros there).
  /// Called from `#init` (cold start), the `visibilitychange` listener
  /// (already running), and itself (see the `finally` block below for the
  /// three reasons it reschedules itself).
  ///
  /// Sharing nothing usable (e.g. a lone `.opus`, which the share sheet's
  /// `audio/*` filter happily matches even though the engine cannot decode
  /// it) still gets a toast -- silently deleting the staged file and saying
  /// nothing would look like the app ignored the share entirely.
  async doTakePendingImport(): Promise<void> {
    if (this.#importBusy) {
      // Do not drop this call on the floor: whatever triggered it (another
      // `visibilitychange`, a fresh share) may not fire again. The call
      // that is currently running re-runs this once more after it finishes
      // -- see the `finally` block below.
      this.#importPending = true;
      return;
    }
    this.#importBusy = true;
    let result: ImportResult | null = null;
    try {
      result = await takePendingImportCmd();
      if (result.tracks > 0) {
        const notes: string[] = [];
        if (result.skipped > 0) notes.push(`非対応${result.skipped}件`);
        if (result.failed > 0) notes.push(`失敗${result.failed}件`);
        const suffix = notes.length > 0 ? `（${notes.join("・")}）` : "";
        toast.notify(`${result.tracks}曲を取り込みました${suffix}`);
      } else if (result.skipped > 0 || result.failed > 0) {
        const notes: string[] = [];
        if (result.skipped > 0) {
          notes.push(`対応していない形式のため${result.skipped}件を取り込めませんでした`);
        }
        if (result.failed > 0) {
          notes.push(`${result.failed}件の取り込みに失敗しました`);
        }
        toast.notify(notes.join("、"));
      }
      // Only worth attempting when something actually landed this call, or
      // an earlier call's attempt was itself bounced (`#importRefreshOwed`)
      // -- otherwise there is nothing new for a walk to find.
      if (result.tracks > 0 || this.#importRefreshOwed) {
        const refreshed = await this.doRefreshLibrary();
        this.#importRefreshOwed = !refreshed.ok && "busy" in refreshed;
      }
    } catch (e) {
      this.lastError = String(e);
    } finally {
      // Released before either retry path below, on purpose: both call
      // `doTakePendingImport` again, which would otherwise find
      // `#importBusy` still true and bounce off itself.
      this.#importBusy = false;
      if (this.#importPending) {
        // A call landed while this one was running -- run it once more
        // immediately, not on `IMPORT_RETRY_MS`: unlike the two cases
        // below, that caller is not waiting on a timer of its own.
        this.#importPending = false;
        void this.doTakePendingImport();
      } else if (result?.in_flight || this.#importRefreshOwed) {
        // `in_flight`: `Import.kt`'s copy thread had not finished yet (see
        // `ImportResult.in_flight` in `tauri.ts`). `#importRefreshOwed`: the
        // library walk that would have shown an already-imported track was
        // busy; see its own doc comment.
        setTimeout(() => void this.doTakePendingImport(), IMPORT_RETRY_MS);
      }
    }
  }

  /// Edit-tab flagged list. Generation-guarded so a slow reply cannot
  /// overwrite a newer load (legacy `flaggedLoadGen`).
  async loadFlaggedTracks(): Promise<void> {
    const gen = ++this.#flaggedGen;
    try {
      const rows = await listFlaggedTracksCmd();
      if (gen !== this.#flaggedGen) return;
      this.flaggedRows = rows;
    } catch (e) {
      if (gen !== this.#flaggedGen) return;
      this.lastError = String(e);
    }
  }

  /// Apply bar fields from a `set_bars` result onto every flagged row that
  /// shares the track path. Mutates row objects in place so an open detail
  /// view that closed over the same object keeps seeing the new values
  /// (legacy `applyFlaggedBarUpdate`).
  #applyFlaggedBarUpdate(updated: TrackRow): void {
    let touched = false;
    for (const row of this.flaggedRows) {
      if (row.path !== updated.path) continue;
      row.intro_bars = updated.intro_bars;
      row.outro_structure_bars = updated.outro_structure_bars;
      row.outro_bars = updated.outro_bars;
      row.intro_manual = updated.intro_manual;
      row.outro_manual = updated.outro_manual;
      row.analyzed = updated.analyzed;
      touched = true;
    }
    if (touched) this.flaggedRows = [...this.flaggedRows];
  }

  /// Writes intro and/or outro structure bars, then syncs library + flagged.
  /// A side left as `null` is untouched. `markManual` defaults to `true`;
  /// pass `false` for cancel/undo revert. Returns the updated row, or `null`
  /// on failure.
  async doSetBars(
    path: string,
    introBars: number | null,
    outroStructureBars: number | null,
    markManual?: boolean,
  ): Promise<TrackRow | null> {
    try {
      const updated = await setBarsCmd(
        path,
        introBars,
        outroStructureBars,
        markManual,
      );
      this.#replaceLibraryRow(updated);
      this.#applyFlaggedBarUpdate(updated);
      return updated;
    } catch (e) {
      this.lastError = String(e);
      return null;
    }
  }

  /// Dismiss one track×role and reload the flagged list. Returns the
  /// dismiss count (`1`/`0`), or `null` on invoke failure.
  async doDismissFlags(trackHash: string, role: string): Promise<number | null> {
    try {
      const n = await dismissFlagsCmd(trackHash, role);
      await this.loadFlaggedTracks();
      return n;
    } catch (e) {
      this.lastError = String(e);
      return null;
    }
  }

  async doUndoLastDismiss(): Promise<boolean> {
    try {
      await undoLastDismissCmd();
      await this.loadFlaggedTracks();
      return true;
    } catch (e) {
      this.lastError = String(e);
      return false;
    }
  }

  /// Pull `player_state` immediately after an audition/resume mutate so the
  /// banner does not wait for the next poll tick (legacy `refreshPlayerState`).
  async #refreshPlayerNow(): Promise<void> {
    try {
      this.player = await playerState();
      this.#polledAt = Date.now();
    } catch (e) {
      this.lastError = String(e);
    }
  }

  async doAuditionTransition(fromPath: string, toPath: string): Promise<boolean> {
    if (!this.dirs) {
      this.lastError = "app directories are not resolved yet";
      return false;
    }
    try {
      await auditionTransitionCmd(
        fromPath,
        toPath,
        this.dirs.music_dir,
        this.dirs.cache_dir,
      );
      await this.#refreshPlayerNow();
      return true;
    } catch (e) {
      this.lastError = String(e);
      return false;
    }
  }

  async doAuditionAgain(): Promise<boolean> {
    if (!this.dirs) {
      this.lastError = "app directories are not resolved yet";
      return false;
    }
    try {
      await auditionAgainCmd(this.dirs.music_dir, this.dirs.cache_dir);
      await this.#refreshPlayerNow();
      return true;
    } catch (e) {
      this.lastError = String(e);
      return false;
    }
  }

  async doResumeAutodj(): Promise<boolean> {
    try {
      await resumeAutodjCmd();
      await this.#refreshPlayerNow();
      return true;
    } catch (e) {
      this.lastError = String(e);
      return false;
    }
  }

  /// Opens the native folder picker (⋮ Musicフォルダを選ぶ / 変更) and applies the
  /// result. `changed: false` covers a cancelled dialog. Reuses
  /// `doRefreshLibrary` for the post-change rescan rather than starting a
  /// second, parallel library walk.
  async doSetMusicDir(): Promise<
    { ok: true; changed: boolean; restartRequired: boolean } | { ok: false; error: string }
  > {
    try {
      const result = await setMusicDirCmd();
      this.dirs = result.dirs;
      if (result.changed) await this.doRefreshLibrary();
      return { ok: true, changed: result.changed, restartRequired: result.restart_required };
    } catch (e) {
      const message = String(e);
      this.lastError = message;
      return { ok: false, error: message };
    }
  }
}

export const store = new PlayerStore();
