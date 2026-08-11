// Single store: the only place that polls `player_state` / `queue_state` and
// holds the results. Components read derived values off `store`; none of them
// talk to `tauri.ts` directly for playback/queue state, so there is exactly
// one poll loop and exactly one place a "what changed since last time" bug
// can hide. Analysis events (`analysis-progress` / `analysis-done`) are also
// listened to here only — same reason.
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
} from "./tauri";
import type {
  AnalysisProgress,
  AppDirs,
  FlaggedTrackRow,
  FlagResult,
  PlayerState,
  QueueSnapshot,
  TrackRow,
} from "./tauri";

/// How often `player_state` / `queue_state` are polled. A self-rescheduling
/// `setTimeout`, not `setInterval`: an `invoke` that is slow to answer (or a
/// phone that just woke the WebView back up) must not stack a second poll on
/// top of one still in flight.
const POLL_INTERVAL_MS = 500;

/// How often the client-side elapsed-time interpolation between polls ticks.
const INTERPOLATION_TICK_MS = 250;

class PlayerStore {
  dirs = $state<AppDirs | null>(null);
  player = $state<PlayerState | null>(null);
  queue = $state<QueueSnapshot | null>(null);
  /// Keyed by file name (`TrackRow.name`), matching `PlayerState.now_playing`.
  /// Insertion order follows the last `refresh_library` response so
  /// `libraryList` stays stable for the play-tab list.
  library = $state<Map<string, TrackRow>>(new Map());
  /// Non-null while a background analysis run is in flight. Cleared on
  /// `analysis-done` (or overwritten by the next progress event).
  analysis = $state<{ done: number; total: number; name: string } | null>(null);
  /// Last invoke failure, from either the poll loop or a transport action.
  /// Polling keeps running after one of these; it is not fatal.
  lastError = $state<string | null>(null);
  /// Edit-tab flagged list (`list_flagged_tracks`). Empty until first load.
  flaggedRows = $state<FlaggedTrackRow[]>([]);

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
  /// Bumped on every Music-folder change refresh so a superseded wait / walk
  /// yields to the latest `doSetMusicDir`.
  #musicDirGen = 0;
  /// When a Music-folder change lands while analysis is still running, set so
  /// `analysis-done` re-runs a kick refresh instead of a quiet reload.
  #rekickAnalysisAfterDone = false;
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
    // The old UI only fetched the library when ⟳ was pressed; this fetches it
    // at startup because the now-playing title/artist are resolved against it
    // (a `TrackRow` lookup by file name), so there is nothing to show without
    // it. The side effect is that `refresh_library(true)` also kicks off
    // analysis of anything unanalysed — which is wanted here: the engine's
    // loader would have to analyse those tracks mid-playback otherwise, and
    // that is what the `stalled` phase is.
    try {
      const rows = await refreshLibrary(true);
      this.library = new Map(rows.map((r) => [r.name, r]));
    } catch (e) {
      this.lastError = String(e);
    }

    // Analysis events land here only. Progress carries the finished row so
    // we splice by path (no full folder walk per track); done reloads the
    // listing without re-kicking analysis (failures must not loop forever).
    try {
      await listen<AnalysisProgress>("analysis-progress", (event) => {
        const { done, total, name, row } = event.payload;
        // Stale worker from a previous music_dir must not pollute the list
        // or the progress banner after the folder was changed.
        if (!this.#pathUnderMusicDir(row.path)) return;
        this.analysis = { done, total, name };
        this.#replaceLibraryRow(row);
      });
      await listen("analysis-done", () => {
        this.analysis = null;
        if (this.#rekickAnalysisAfterDone) {
          this.#rekickAnalysisAfterDone = false;
          void this.#refreshLibraryAfterMusicDirChange();
        } else {
          void this.#reloadLibraryQuiet();
        }
      });
    } catch (e) {
      this.lastError = String(e);
    }

    this.#poll();
    setInterval(() => {
      this.#tickNow = Date.now();
    }, INTERPOLATION_TICK_MS);
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
      this.library = new Map(rows.map((r) => [r.name, r]));
    } catch (e) {
      // Ignore on analysis-done the same way legacy did: a stray error here
      // shouldn't disrupt the UI after the worker itself has finished.
      this.lastError = String(e);
    } finally {
      this.#libraryBusy = false;
    }
  }

  #pathUnderMusicDir(path: string): boolean {
    const root = this.dirs?.music_dir;
    if (!root) return true;
    const norm = (s: string) => s.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
    const p = norm(path);
    const r = norm(root);
    return p === r || p.startsWith(r + "/");
  }

  /// Wait out an in-flight library walk, then rescan with analysis kick.
  /// Generation-guarded so rapid Music-folder changes do not apply a stale list.
  async #refreshLibraryAfterMusicDirChange(): Promise<void> {
    this.#musicDirGen += 1;
    const gen = this.#musicDirGen;
    if (this.analysis !== null) {
      this.#rekickAnalysisAfterDone = true;
    }
    while (this.#libraryBusy) {
      if (gen !== this.#musicDirGen) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (gen !== this.#musicDirGen) return;
    this.#libraryBusy = true;
    try {
      const rows = await refreshLibrary(true);
      if (gen === this.#musicDirGen) {
        this.library = new Map(rows.map((r) => [r.name, r]));
      }
    } catch (e) {
      if (gen === this.#musicDirGen) {
        this.lastError = String(e);
      }
    } finally {
      this.#libraryBusy = false;
    }
  }

  /// Swap one library row in place by `path`, keeping the name-keyed Map in
  /// sync (and preserving insertion order for every other entry).
  #replaceLibraryRow(row: TrackRow): void {
    const next = new Map(this.library);
    for (const [name, existing] of next) {
      if (existing.path === row.path) {
        if (name !== row.name) next.delete(name);
        break;
      }
    }
    next.set(row.name, row);
    this.library = next;
  }

  /// Ordered view of `library` for the play-tab list. Map insertion order
  /// follows the last full refresh; progress splices update values in place.
  get libraryList(): TrackRow[] {
    return Array.from(this.library.values());
  }

  /// Engine start needs a usable Music folder and at least two tracks.
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
    const i = path.lastIndexOf("/");
    return i >= 0 ? path.slice(i + 1) : path;
  }

  /// Resolves an absolute path (as found in `QueueSnapshot`) against the
  /// library. Tries the basename key first (usual case: `TrackRow.name` is
  /// the file name), then falls back to a path scan.
  trackForPath(path: string): TrackRow | undefined {
    const base = this.pathBasename(path);
    const byName = this.library.get(base);
    if (byName?.path === path) return byName;
    for (const row of this.library.values()) {
      if (row.path === path) return row;
    }
    return undefined;
  }

  titleForPath(path: string): string {
    return this.trackForPath(path)?.title ?? this.pathBasename(path);
  }

  artistForPath(path: string): string {
    return this.trackForPath(path)?.artist ?? "";
  }

  /// Resolves a file name (as found in `PlayerState.now_playing` or
  /// `TransitionInfo.from`/`.to`) to a library title, falling back to the
  /// file name itself when the library has not resolved it (or does not
  /// have it) yet. `null` in, `""` out -- matches `TrackRow.artist`'s own
  /// "nothing to show" convention rather than returning `null`, since every
  /// caller just interpolates this into a string.
  titleFor(name: string | null): string {
    if (!name) return "";
    return this.library.get(name)?.title ?? name;
  }

  /// `now_playing` resolved via `titleFor`, kept nullable (unlike `titleFor`
  /// itself) so `NowCard` can tell "no track" apart from "unresolved title".
  get nowTitle(): string | null {
    const name = this.player?.now_playing;
    if (!name) return null;
    return this.titleFor(name);
  }

  /// As `nowTitle`, for the artist. Empty string (not null) when unresolved,
  /// matching `TrackRow.artist`'s own "no artist tag" convention.
  get nowArtist(): string {
    const name = this.player?.now_playing;
    if (!name) return "";
    return this.library.get(name)?.artist ?? "";
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
  async doRefreshLibrary(): Promise<void> {
    if (this.#libraryBusy) return;
    this.#libraryBusy = true;
    try {
      const rows = await refreshLibrary();
      this.library = new Map(rows.map((r) => [r.name, r]));
    } catch (e) {
      this.lastError = String(e);
    } finally {
      this.#libraryBusy = false;
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

  /// Opens the native folder picker (⋮ Musicフォルダを選ぶ) and applies the
  /// result. `changed: false` covers a cancelled dialog. Waits out any
  /// in-flight library walk before rescanning (see `#refreshLibraryAfterMusicDirChange`).
  async doSetMusicDir(): Promise<
    { ok: true; changed: boolean; restartRequired: boolean } | { ok: false; error: string }
  > {
    try {
      const result = await setMusicDirCmd();
      this.dirs = result.dirs;
      if (result.changed) await this.#refreshLibraryAfterMusicDirChange();
      return { ok: true, changed: result.changed, restartRequired: result.restart_required };
    } catch (e) {
      const message = String(e);
      this.lastError = message;
      return { ok: false, error: message };
    }
  }

}

export const store = new PlayerStore();
