import {
  appDirs,
  playerState,
  queueState as queueStateCmd,
  refreshLibrary,
  listTrackTags,
  updateTrackTags,
  start as startCmd,
  togglePause as togglePauseCmd,
  skipNext as skipNextCmd,
  flagLastTransition as flagLastTransitionCmd,
  undoLastFlag as undoLastFlagCmd,
  playlistCatalog as playlistCatalogCmd,
  playlistEntries as playlistEntriesCmd,
  playlistCommand as playlistCommandCmd,
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
  getLabelingMode as getLabelingModeCmd,
  setLabelingMode as setLabelingModeCmd,
  getLocale as getLocaleCmd,
  setLocale as setLocaleCmd,
  playbackRecoveryStatus as playbackRecoveryStatusCmd,
  resolvePlaybackRecovery as resolvePlaybackRecoveryCmd,
  takePendingImport as takePendingImportCmd,
  setLabel as setLabelCmd,
  setFolderLabel as setFolderLabelCmd,
  undoLastFolderLabel as undoLastFolderLabelCmd,
  clearLabels as clearLabelsCmd,
  clearPlayLog as clearPlayLogCmd,
  clearPlayCounts as clearPlayCountsCmd,
  clearTrackPlayCount as clearTrackPlayCountCmd,
  removePlayLogEntry as removePlayLogEntryCmd,
  listNewArrivals as listNewArrivalsCmd,
  listPlayHistory,
  listen,
  FAVORITES_PLAYLIST_ID,
} from "./tauri";
import type {
  AnalysisProgress,
  AppDirs,
  PlaylistCatalogSnapshot,
  PlaylistCommandErrorCode,
  PlaylistCommandResult,
  PlaylistAction,
  PlaybackRecoveryChoice,
  PlaybackRecoveryStatus,
  FlaggedTrackRow,
  FlagResult,
  ImportResult,
  LibraryScanProgress,
  NewArrival,
  PlayerState,
  PlayHistory,
  QueueItem,
  QueueSnapshot,
  TrackRow,
  TrackTagsSnapshot,
  TagUpdateRequest,
  TagUpdateResult,
} from "./tauri";
import {
  actionableArrivals,
  arrivalPathSet,
  arrivalsPullDecision,
  gatedArrivals,
  nextLibraryRefreshOwed,
  type RefreshAttempt,
} from "./arrivals";
import { applyAnalysisProgress, preserveLibraryAddedOrder } from "./library-sort";
import { TrackTagsClient } from "./track-tags-client";
import { canSkipNext } from "./transportMode";
import { toast } from "./toast.svelte";
import { i18n } from "./i18n.svelte";
import { isLocale, type Locale } from "./locale";

const POLL_INTERVAL_MS = 500;

const INTERPOLATION_TICK_MS = 250;

const PLAY_HISTORY_LIMIT = 200;

const IMPORT_RETRY_MS = 1500;

class PlayerStore {
  dirs = $state<AppDirs | null>(null);
  player = $state<PlayerState | null>(null);
  queue = $state<QueueSnapshot | null>(null);
  catalog = $state<PlaylistCatalogSnapshot | null>(null);
  favoriteBusy = $state<Set<string>>(new Set());
  favoriteHashes = $derived<ReadonlySet<string>>(new Set(this.catalog?.favorite_hashes ?? []));
  browsedPlaylist = $state<import("./tauri").PlaylistDetails | null>(null);
  library = $state<Map<string, TrackRow>>(new Map());
  trackTags = $state<TrackTagsSnapshot | null>(null);
  trackTagsError = $state<unknown>(null);
  #tagClient = new TrackTagsClient({
    list: listTrackTags,
    update: updateTrackTags,
    changed: (snapshot) => { this.trackTags = snapshot; this.trackTagsError = null; },
    failed: (error) => { this.trackTagsError = error; },
  });

  async reloadTrackTags(): Promise<void> { await this.#tagClient.reload(); }
  async saveTrackTags(request: TagUpdateRequest): Promise<TagUpdateResult> {
    return this.#tagClient.save(request);
  }
  analysis = $state<{ done: number; total: number; name: string } | null>(null);
  libraryScan = $state<LibraryScanProgress | null>({
    phase: "walking",
    found: 0,
    done: 0,
  });
  lastError = $state<string | null>(null);
  flaggedRows = $state<FlaggedTrackRow[]>([]);
  allowNonFunkot = $state(true);
  labelingMode = $state(false);
  playbackRecovery = $state<PlaybackRecoveryStatus | null>(null);
  localeReady = $state(false);
  activeLabelingMode = $state<boolean | null>(null);
  arrivals = $state<NewArrival[]>([]);
  playHistory = $state<PlayHistory | null>(null);

  #polledAt = $state(0);
  #tickNow = $state(Date.now());
  #libraryBusy = false;
  #importBusy = false;
  #importPending = false;
  #libraryRefreshOwed = false;
  #libraryRefreshOwedEpoch = 0;
  #refreshGen = 0;
  #queueGen = 0;
  #catalogGen = 0;
  #catalogRevision: number | null = null;
  #browseGen = 0;
  #browseTarget: import("./tauri").SourceTarget | null = null;
  #arrivalsGen = 0;
  #processedHistoryRevision: number | null = null;
  #arrivalsPullBusy = false;
  #flaggedGen = 0;
  #playHistoryGen = 0;
  #playHistoryBusy = false;
  #appliedPlayHistoryRevision: number | null = null;
  #labelSkipBusy = false;
  skipNextPending = $state<{ startedFrames: number | null } | null>(null);
  #folderLabelUndoRows: TrackRow[] | null = null;

  constructor() {
    void this.#init();
  }

  async #init() {
    await this.#loadLocale();
    try {
      this.dirs = await appDirs();
      if (this.dirs.music_dir_needed && this.dirs.music_dir_unavailable) {
        this.lastError = i18n.t.musicDirUnavailable(this.dirs.music_dir_custom ?? "");
      }
      void this.#loadPlaybackRecovery();
    } catch (e) {
      this.lastError = String(e);
    }
    await this.doTakePendingImport();
    try {
      this.allowNonFunkot = await getAllowNonFunkotCmd();
    } catch (e) {
      this.lastError = String(e);
    }
    try {
      this.labelingMode = await getLabelingModeCmd();
    } catch (e) {
      this.lastError = String(e);
    }

    try {
      await listen<LibraryScanProgress>("library-scan", (event) => {
        this.libraryScan = event.payload;
      });
      await listen<AnalysisProgress>("analysis-progress", (event) => {
        const update = applyAnalysisProgress(this.library, event.payload);
        this.library = update.library;
        this.analysis = update.analysis;
      });
      await listen("analysis-done", () => {
        this.analysis = null;
        void this.#reloadLibraryQuiet();
      });
    } catch (e) {
      this.lastError = String(e);
    }

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        void this.doTakePendingImport();
        if (this.#libraryRefreshOwed) void this.doRefreshLibrary();
      }
    });

    void this.#refreshCatalog();
    this.#poll();
    setInterval(() => {
      this.#tickNow = Date.now();
    }, INTERPOLATION_TICK_MS);

    this.#markLibraryRefreshOwed();
    await this.doRefreshLibrary();
  }

  async #poll() {
    try {
      const state = await playerState();
      this.player = state;
      this.#reconcileSkipNextPending();
      this.#polledAt = Date.now();
      const rev = state.history_revision;
      if (this.#processedHistoryRevision !== rev) {
        void this.#pullArrivals(rev);
      }
    } catch (e) {
      this.lastError = String(e);
    }
    try {
      const gen = this.#queueGen;
      const q = await queueStateCmd();
      if (gen === this.#queueGen) {
        this.queue = q;
        this.#reconcileSkipNextPending();
        if (q.catalog_revision !== undefined && q.catalog_revision !== this.#catalogRevision) void this.#refreshCatalog();
      }
    } catch (e) {
      this.lastError = String(e);
    }
    setTimeout(() => this.#poll(), POLL_INTERVAL_MS);
  }

  async #loadPlaybackRecovery(): Promise<void> {
    try {
      this.playbackRecovery = await playbackRecoveryStatusCmd();
    } catch (e) {
      this.lastError = String(e);
    }
  }

  #markLibraryRefreshOwed(): void {
    this.#libraryRefreshOwed = true;
    this.#libraryRefreshOwedEpoch += 1;
  }

  #requestArrivalsPull(): void {
    this.#processedHistoryRevision = null;
    this.#arrivalsGen += 1;
    void this.#pullArrivals(this.player?.history_revision ?? 0);
  }

  async #pullArrivals(revision: number): Promise<void> {
    if (this.#arrivalsPullBusy) return;
    this.#arrivalsPullBusy = true;
    const gen = ++this.#arrivalsGen;
    try {
      const list = await listNewArrivalsCmd();
      const d = arrivalsPullDecision(gen, this.#arrivalsGen, true, revision);
      if (!d.apply) return;
      this.arrivals = list;
      this.#processedHistoryRevision = d.processedRevision;
    } catch (e) {
      arrivalsPullDecision(gen, this.#arrivalsGen, false, revision);
      const msg = String(e);
      if (!msg.includes("arrivals_index_unavailable")) {
        this.lastError = msg;
      }
    } finally {
      this.#arrivalsPullBusy = false;
    }
  }

  async #reloadLibraryQuiet(): Promise<void> {
    if (this.#libraryBusy) return;
    this.#libraryBusy = true;
    const gen = ++this.#refreshGen;
    this.libraryScan = { phase: "walking", found: 0, done: 0 };
    let applied = false;
    try {
      const { rows, persistence_error } = await refreshLibrary(false);
      if (gen !== this.#refreshGen) return;
      this.library = new Map(rows.map((r) => [r.path, r]));
      if (persistence_error !== null) this.lastError = persistence_error;
      await this.reloadTrackTags();
      applied = persistence_error === null;
    } catch (e) {
      this.lastError = String(e);
    } finally {
      this.libraryScan = null;
      this.#libraryBusy = false;
      if (applied) this.#requestArrivalsPull();
      if (this.#libraryRefreshOwed) {
        queueMicrotask(() => void this.doRefreshLibrary());
      }
    }
  }

  #replaceLibraryRow(row: TrackRow): void {
    const next = new Map(this.library);
    const previous = next.get(row.path);
    next.set(row.path, preserveLibraryAddedOrder(previous, row));
    this.library = next;
  }

  get libraryList(): TrackRow[] {
    return Array.from(this.library.values());
  }

  get newArrivalPaths(): Set<string> {
    return arrivalPathSet(this.arrivals);
  }

  get actionableNewArrivalCount(): number {
    return this.actionableNewArrivals.length;
  }

  get activeArrivalPlaylistName(): string | null {
    return this.queue?.source?.playlist_id === null ? null : this.destinationName;
  }

  get actionableNewArrivals(): NewArrival[] {
    const id = this.queue?.source?.playlist_id;
    const activeRows = id !== undefined && id !== null && this.activePlaylist?.id === id
      ? this.activePlaylist.rows
      : [];
    const activePlaylistPaths = activeRows
      .filter((row) => ["pending", "preparing", "prepared"].includes(row.status))
      .map((row) => row.path);
    return actionableArrivals(
      this.arrivals,
      this.library,
      this.allowNonFunkot,
      this.player?.now_playing ?? null,
      this.queue?.reserved?.path ?? null,
      this.queue?.pending.map((item) => item.path) ?? [],
      this.queue?.in_flight.map((item) => item.path) ?? [],
      activePlaylistPaths,
    );
  }

  isNewArrival(path: string): boolean {
    return this.newArrivalPaths.has(path);
  }

  get arrivalsInspect(): {
    historyRevision: number | null;
    processedRevision: number | null;
    listed: number;
    gated: number;
    banner: number;
    nowPlaying: string | null;
    reserved: string | null;
    pending: number;
    names: string[];
  } {
    const listed = this.arrivals;
    return {
      historyRevision: this.player?.history_revision ?? null,
      processedRevision: this.#processedHistoryRevision,
      listed: listed.length,
      gated: gatedArrivals(listed, this.library, this.allowNonFunkot)
        .length,
      banner: this.actionableNewArrivalCount,
      nowPlaying: this.player?.now_playing ?? null,
      reserved: this.queue?.reserved?.path ?? null,
      pending: this.queue?.pending?.length ?? 0,
      names: listed.map((a) => this.relName(a.path)),
    };
  }

  get labelingPath(): string | null {
    return this.player?.now_playing ?? null;
  }

  get labelProgress(): { current: number; total: number } {
    const total =
      this.queue?.folder_len && this.queue.folder_len > 0
        ? this.queue.folder_len
        : this.libraryList.length;
    const path = this.player?.now_playing ?? null;
    if (!path) return { current: 0, total };
    const idx = this.libraryList.findIndex((r) => r.path === path);
    return { current: idx >= 0 ? idx + 1 : 0, total };
  }

  get canStart(): boolean {
    return this.playbackRecovery?.kind === "ready" && !this.dirs?.music_dir_needed && this.libraryList.length >= 1;
  }

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

  relName(path: string): string {
    const musicDir = this.dirs?.music_dir;
    if (!musicDir || !path.startsWith(musicDir)) return this.pathBasename(path);
    const rest = path.slice(musicDir.length).replace(/^[/\\]+/, "");
    if (!rest) return this.pathBasename(path);
    return rest.replace(/\\/g, "/");
  }

  trackForPath(path: string): TrackRow | undefined {
    return this.library.get(path);
  }

  titleForPath(path: string): string {
    return this.trackForPath(path)?.title ?? this.pathBasename(path);
  }

  artistForPath(path: string): string {
    return this.trackForPath(path)?.artist ?? "";
  }

  get nowTitle(): string | null {
    const path = this.player?.now_playing;
    if (!path) return null;
    return this.titleForPath(path);
  }

  get nowArtist(): string {
    const path = this.player?.now_playing;
    if (!path) return "";
    return this.artistForPath(path);
  }

  async doStart(): Promise<void> {
    if (!this.dirs || !this.canStart) {
      this.lastError = "app directories are not resolved yet";
      return;
    }
    try {
      await startCmd(this.dirs.music_dir, this.dirs.cache_dir);
      this.activeLabelingMode = this.labelingMode;
    } catch (e) {
      this.lastError = String(e);
    }
  }

  async doTogglePause(): Promise<void> {
    if (this.playbackRecovery?.kind !== "ready") return;
    try {
      await togglePauseCmd();
    } catch (e) {
      this.lastError = String(e);
    }
  }

  #reconcileSkipNextPending(): void {
    const pending = this.skipNextPending;
    if (pending === null) return;
    const player = this.player;
    if (player && player.playback_started_frames !== pending.startedFrames) {
      this.skipNextPending = null;
      return;
    }
    if (this.queue && !canSkipNext(player?.phase ?? "idle", player?.auditioning ?? false, this.queue)) {
      this.skipNextPending = null;
    }
  }

  async doSkipNext(): Promise<boolean> {
    if (this.playbackRecovery?.kind !== "ready") return false;
    const player = this.player;
    if (
      this.skipNextPending !== null ||
      !player ||
      player.playback_started_frames === null ||
      !canSkipNext(player.phase, player.auditioning, this.queue)
    ) return false;
    this.skipNextPending = { startedFrames: player.playback_started_frames };
    try {
      await skipNextCmd();
      void this.#refreshQueueNow();
      return true;
    } catch (e) {
      this.skipNextPending = null;
      this.lastError = String(e);
      return false;
    }
  }

  async doLabelAndSkip(verdict: boolean | null): Promise<void> {
    const path = this.player?.now_playing ?? null;
    if (!path) return;
    if (!this.labelingMode) {
      if (verdict !== null) void this.doSetLabel(path, verdict);
      return;
    }
    if (this.#labelSkipBusy) return;
    const phase = this.player?.phase ?? "idle";
    const auditioning = this.player?.auditioning ?? false;
    if (this.skipNextPending !== null || this.player?.playback_started_frames == null || !canSkipNext(phase, auditioning, this.queue)) {
      if (verdict !== null) void this.doSetLabel(path, verdict);
      return;
    }
    this.#labelSkipBusy = true;
    if (verdict !== null) void this.doSetLabel(path, verdict);
    try {
      await this.doSkipNext();
    } finally {
      this.#labelSkipBusy = false;
    }
  }

  async doSetLabel(
    path: string,
    verdict: boolean | null,
  ): Promise<TrackRow | null> {
    const prev = this.library.get(path);
    if (prev) {
      const patched: TrackRow = { ...prev };
      if (verdict === true) {
        patched.label = true;
        patched.is_funkot = true;
      } else if (verdict === false) {
        patched.label = false;
        patched.is_funkot = false;
      } else {
        patched.label = null;
      }
      this.#replaceLibraryRow(patched);
    }
    try {
      const updated = await setLabelCmd(path, verdict);
      this.#replaceLibraryRow(updated);
      return updated;
    } catch (e) {
      if (prev) this.#replaceLibraryRow(prev);
      this.lastError = String(e);
      return null;
    }
  }

  async doClearLabels(): Promise<boolean> {
    try {
      await clearLabelsCmd();
      await this.#reloadLibraryQuiet();
      return true;
    } catch (e) {
      this.lastError = String(e);
      return false;
    }
  }

  async doClearPlayLog(): Promise<boolean> {
    try {
      await clearPlayLogCmd();
      this.invalidatePlayHistory();
      await this.loadPlayHistory(null);
      return true;
    } catch (e) {
      this.lastError = String(e);
      return false;
    }
  }

  async doClearPlayCounts(): Promise<boolean> {
    try {
      await clearPlayCountsCmd();
      this.invalidatePlayHistory();
      await this.loadPlayHistory(null);
      return true;
    } catch (e) {
      this.lastError = String(e);
      return false;
    }
  }

  async doClearTrackPlayCount(hash: string): Promise<boolean> {
    try {
      await clearTrackPlayCountCmd(hash);
      this.invalidatePlayHistory();
      await this.loadPlayHistory(null);
      return true;
    } catch (e) {
      this.lastError = String(e);
      return false;
    }
  }

  async doRemovePlayLogEntry(atMs: number): Promise<boolean> {
    try {
      await removePlayLogEntryCmd(atMs);
      this.invalidatePlayHistory();
      await this.loadPlayHistory(null);
      return true;
    } catch (e) {
      this.lastError = String(e);
      return false;
    }
  }

  async doSetFolderLabel(
    dir: string,
    verdict: boolean,
  ): Promise<number | null> {
    const prevRows: TrackRow[] = [];
    const next = new Map(this.library);
    for (const row of next.values()) {
      const under =
        row.path === dir ||
        row.path.startsWith(`${dir}/`) ||
        row.path.startsWith(`${dir}\\`);
      if (!under) continue;
      prevRows.push(row);
      next.set(row.path, { ...row, label: verdict, is_funkot: verdict });
    }
    this.library = next;
    try {
      const count = await setFolderLabelCmd(dir, verdict);
      this.#folderLabelUndoRows = prevRows;
      return count;
    } catch (e) {
      this.#restoreLibraryRows(prevRows);
      this.#folderLabelUndoRows = null;
      this.lastError = String(e);
      return null;
    }
  }

  async doUndoLastFolderLabel(): Promise<boolean> {
    const rows = this.#folderLabelUndoRows;
    if (!rows) return false;
    try {
      await undoLastFolderLabelCmd();
      this.#restoreLibraryRows(rows);
      this.#folderLabelUndoRows = null;
      return true;
    } catch (e) {
      this.lastError = String(e);
      return false;
    }
  }

  #restoreLibraryRows(rows: TrackRow[]): void {
    const next = new Map(this.library);
    for (const row of rows) {
      next.set(row.path, row);
    }
    this.library = next;
  }

  async doFlagLastTransition(): Promise<FlagResult | null> {
    try {
      return await flagLastTransitionCmd();
    } catch (e) {
      this.lastError = String(e);
      return null;
    }
  }

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
    this.#queueGen += 1;
    const gen = this.#queueGen;
    try {
      const q = await queueStateCmd();
      if (gen === this.#queueGen) {
        this.queue = q;
        this.#reconcileSkipNextPending();
        if (q.catalog_revision !== undefined && q.catalog_revision !== this.#catalogRevision) await this.#refreshCatalog();
      }
    } catch (e) {
      this.lastError = String(e);
    }
  }

  async #refreshCatalog(): Promise<void> {
    const gen = ++this.#catalogGen;
    try {
      const catalog = await playlistCatalogCmd();
      if (gen === this.#catalogGen) { this.catalog = catalog; this.#catalogRevision = catalog.revision; }
    } catch (e) { this.lastError = String(e); }
  }

  #target(): import("./tauri").SourceTarget | null {
    return this.queue?.source ?? null;
  }

  #requestId(): string { return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`; }

  #errorCode(error: unknown): PlaylistCommandErrorCode | string {
    if (typeof error === "object" && error && "code" in error) return String((error as { code: unknown }).code);
    const text = String(error);
    try { const parsed = JSON.parse(text); return typeof parsed.code === "string" ? parsed.code : text; } catch { return text; }
  }

  async #command(action: PlaylistAction, target = this.#target()): Promise<PlaylistCommandResult | null> {
    if (this.playbackRecovery?.kind !== "ready") {
      this.lastError = "playback_recovery_required";
      return null;
    }
    if (!target) { this.lastError = "busy"; return null; }
    try {
      const result = await playlistCommandCmd({ request_id: this.#requestId(), target, action });
      await this.#refreshQueueNow();
      if (action.kind === "set_favorite") await this.#refreshCatalog();
      if (action.kind === "delete" && this.browsedPlaylist?.id === action.id) this.closeBrowsedPlaylist();
      else if (this.browsedPlaylist && ((action.kind === "set_favorite" && this.browsedPlaylist.id === FAVORITES_PLAYLIST_ID) || action.kind === "undo_remove" || ("id" in action && action.id === this.browsedPlaylist.id) || (action.kind === "append" && target.playlist_id === this.browsedPlaylist.id)))
        await this.browsePlaylist(this.browsedPlaylist.id);
      return result;
    } catch (e) {
      this.lastError = this.#errorCode(e);
      await this.#refreshQueueNow();
      if (action.kind === "set_favorite") await this.#refreshCatalog();
      if (this.browsedPlaylist && ((action.kind === "set_favorite" && this.browsedPlaylist.id === FAVORITES_PLAYLIST_ID) || action.kind === "undo_remove" || ("id" in action && action.id === this.browsedPlaylist.id) || (action.kind === "append" && target.playlist_id === this.browsedPlaylist.id)))
        await this.browsePlaylist(this.browsedPlaylist.id);
      return null;
    }
  }

  get activePlaylist() { return this.queue?.playlist ?? null; }
  get destinationName() {
    const id = this.queue?.source?.playlist_id;
    if (id === undefined) return i18n.t.playlistLoading;
    if (id === null) return i18n.t.playlistNormal;
    const name = (this.activePlaylist?.id === id ? this.activePlaylist.name : null)
      ?? this.catalog?.lists.find((list) => list.id === id)?.name;
    return name ? this.playlistName(id, name) : i18n.t.playlistLoading;
  }
  playlistName(id: string, name: string): string {
    return id === FAVORITES_PLAYLIST_ID ? i18n.t.favoritesTitle : name;
  }
  isFavorite(contentHash: string | null): boolean { return contentHash !== null && this.favoriteHashes.has(contentHash); }
  isFavoriteBusy(path: string, contentHash: string | null): boolean {
    return this.favoriteBusy.has(contentHash ?? path);
  }
  get destinationLabel() { return this.destinationName; }
  get playlistStoreStatus() { return this.queue?.playlist_store_status ?? this.catalog?.store_status ?? "ready"; }
  get canPlaylistMutate() { return this.playbackRecovery?.kind === "ready" && this.queue?.source !== undefined && ["ready", "missing", "persist_failed"].includes(this.playlistStoreStatus); }
  get canAddToSource() {
    const id = this.queue?.source?.playlist_id;
    return this.playbackRecovery?.kind === "ready" && (id === null || (id !== undefined && this.canPlaylistMutate && (this.activePlaylist?.id === id || !!this.catalog?.lists.some((list) => list.id === id))));
  }
  get canFavoriteMutate() { return this.catalog !== null && this.canPlaylistMutate; }

  async doPlaylist(action: PlaylistAction): Promise<PlaylistCommandResult | null> {
    const anchored = ["rename", "duplicate", "delete", "move", "remove"].includes(action.kind)
      && "id" in action && action.id === this.browsedPlaylist?.id;
    return this.#command(action, anchored ? this.#browseTarget : this.#target());
  }
  async doSetFavorite(path: string, favorite: boolean, expectedHash: string | null): Promise<PlaylistCommandResult | null> {
    const key = expectedHash ?? path;
    if (this.favoriteBusy.has(key)) return null;
    this.favoriteBusy = new Set(this.favoriteBusy).add(key);
    try {
      return await this.#command({ kind: "set_favorite", track: { path, expected_hash: expectedHash }, favorite });
    } finally {
      const next = new Set(this.favoriteBusy);
      next.delete(key);
      this.favoriteBusy = next;
    }
  }
  closeBrowsedPlaylist(): void { ++this.#browseGen; this.browsedPlaylist = null; this.#browseTarget = null; }
  async browsePlaylist(id: string): Promise<void> {
    const gen = ++this.#browseGen;
    const target = this.#target();
    const browseTarget = target ? { ...target } : null;
    try {
      const details = await playlistEntriesCmd(id);
      if (gen === this.#browseGen && details.id === id) {
        this.browsedPlaylist = details;
        this.#browseTarget = browseTarget;
      }
    }
    catch (e) { if (gen === this.#browseGen) this.lastError = this.#errorCode(e); }
  }
  async doEnqueue(path: string): Promise<PlaylistCommandResult | null> { return this.#command({ kind: "append", tracks: [{ path, expected_hash: this.trackForPath(path)?.content_hash ?? null }], mode: "single" }); }

  async doEnqueueMany(paths: string[], mode: "many" | "arrivals" = "many"): Promise<PlaylistCommandResult | null> {
    const target = this.#target();
    return this.#command({ kind: "append", tracks: paths.map((path) => ({ path, expected_hash: this.trackForPath(path)?.content_hash ?? null })), mode }, target);
  }

  async loadPlayHistory(revision: number | null): Promise<void> {
    if (this.#playHistoryBusy) return;
    if (revision !== null && revision === this.#appliedPlayHistoryRevision) return;
    this.#playHistoryBusy = true;
    this.#playHistoryGen += 1;
    const gen = this.#playHistoryGen;
    try {
      const view = await listPlayHistory(PLAY_HISTORY_LIMIT);
      if (gen === this.#playHistoryGen) {
        this.playHistory = view;
        this.#appliedPlayHistoryRevision = revision;
      }
    } catch (e) {
      this.lastError = String(e);
    } finally {
      this.#playHistoryBusy = false;
    }
  }

  invalidatePlayHistory(): void {
    this.#appliedPlayHistoryRevision = null;
  }

  async #loadLocale(): Promise<void> {
    try {
      const stored = await getLocaleCmd();
      if (isLocale(stored)) i18n.setLocale(stored);
    } catch (e) {
      console.warn("get_locale failed; keeping the platform locale", e);
    } finally {
      this.localeReady = true;
    }
  }

  async resolvePlaybackRecovery(choice: PlaybackRecoveryChoice): Promise<boolean> {
    const current = this.playbackRecovery;
    if (!current || current.kind !== "legacy_normal_conflict") return false;
    try {
      const status = await resolvePlaybackRecoveryCmd({ token: current.token, choice });
      this.playbackRecovery = status;
      if (status.kind !== "ready") return false;

      await this.#loadLocale();
      try {
        this.allowNonFunkot = await getAllowNonFunkotCmd();
      } catch (e) {
        this.lastError = String(e);
      }
      try {
        this.labelingMode = await getLabelingModeCmd();
      } catch (e) {
        this.lastError = String(e);
      }
      await this.#refreshQueueNow();
      await this.#refreshCatalog();
      const refreshed = await this.doRefreshLibrary();
      if (!refreshed.ok && "busy" in refreshed) await this.reloadTrackTags();
      return true;
    } catch (e) {
      this.lastError = String(e);
      return false;
    }
  }

  async doSetLocale(locale: Locale): Promise<void> {
    if (!this.localeReady || this.playbackRecovery?.kind !== "ready") return;
    i18n.setLocale(locale);
    try {
      await setLocaleCmd(locale);
    } catch (e) {
      this.lastError = String(e);
    }
  }

  async doSetAllowNonFunkot(allow: boolean): Promise<boolean> {
    if (this.playbackRecovery?.kind !== "ready") return false;
    try {
      this.allowNonFunkot = await setAllowNonFunkotCmd(allow);
      return true;
    } catch (e) {
      this.lastError = String(e);
      return false;
    }
  }

  async doSetLabelingMode(on: boolean): Promise<void> {
    if (this.playbackRecovery?.kind !== "ready") return;
    try {
      this.labelingMode = await setLabelingModeCmd(on);
    } catch (e) {
      this.lastError = String(e);
    }
  }

  async doDequeue(index: number, expect: QueueItem): Promise<string | null> {
    try {
      const result = await this.#command({ kind: "queue_remove", index, expect });
      return result ? null : this.lastError ?? "busy";
    } catch { return this.lastError ?? "busy"; }
  }

  async doReorder(from: number, to: number, expect: QueueItem): Promise<string | null> {
    try {
      const result = await this.#command({ kind: "queue_move", from, to, expect });
      return result ? null : this.lastError ?? "busy";
    } catch { return this.lastError ?? "busy"; }
  }

  async doRefreshLibrary(): Promise<
    { ok: true; count: number } | { ok: false; error: string } | { ok: false; busy: true }
  > {
    if (this.#libraryBusy) return { ok: false, busy: true };
    this.#libraryBusy = true;
    this.libraryScan = { phase: "walking", found: 0, done: 0 };
    let attempt: RefreshAttempt = "error";
    const consume = this.#libraryRefreshOwed;
    const owedEpoch = this.#libraryRefreshOwedEpoch;
    const gen = ++this.#refreshGen;
    try {
      const { rows, persistence_error } = await refreshLibrary();
      if (gen !== this.#refreshGen) {
        attempt = "stale";
        this.#libraryRefreshOwed = nextLibraryRefreshOwed(
          this.#libraryRefreshOwed,
          "stale",
          consume,
          owedEpoch,
          this.#libraryRefreshOwedEpoch,
        );
        return { ok: false, error: "stale" };
      }
      this.library = new Map(rows.map((r) => [r.path, r]));
      if (persistence_error !== null) this.lastError = persistence_error;
      await this.reloadTrackTags();
      attempt = persistence_error === null ? "success" : "error";
      this.#libraryRefreshOwed = nextLibraryRefreshOwed(
        this.#libraryRefreshOwed,
        attempt,
        consume,
        owedEpoch,
        this.#libraryRefreshOwedEpoch,
      );
      if (persistence_error === null) this.#requestArrivalsPull();
      return { ok: true, count: rows.length };
    } catch (e) {
      const error = String(e);
      this.lastError = error;
      attempt = "error";
      this.#libraryRefreshOwed = nextLibraryRefreshOwed(
        this.#libraryRefreshOwed,
        "error",
        consume,
        owedEpoch,
        this.#libraryRefreshOwedEpoch,
      );
      return { ok: false, error };
    } finally {
      this.libraryScan = null;
      this.#libraryBusy = false;
      if (attempt !== "error" && this.#libraryRefreshOwed) {
        queueMicrotask(() => void this.doRefreshLibrary());
      }
    }
  }

  async doQueueNewArrivals(): Promise<PlaylistCommandResult | null> {
    return this.doEnqueueMany(this.actionableNewArrivals.map((row) => row.path), "arrivals");
  }

  async doTakePendingImport(): Promise<void> {
    if (this.#importBusy) {
      this.#importPending = true;
      return;
    }
    this.#importBusy = true;
    let result: ImportResult | null = null;
    try {
      result = await takePendingImportCmd();
      if (result.tracks > 0) {
        toast.notify(i18n.t.importedSummary(result.tracks, result.skipped, result.failed));
      } else if (result.skipped > 0 || result.failed > 0) {
        toast.notify(i18n.t.importProblems(result.skipped, result.failed));
      }
      if (result.tracks > 0 || this.#libraryRefreshOwed) {
        this.#markLibraryRefreshOwed();
        await this.doRefreshLibrary();
      }
    } catch (e) {
      this.lastError = String(e);
    } finally {
      this.#importBusy = false;
      if (this.#importPending) {
        this.#importPending = false;
        void this.doTakePendingImport();
      } else if (result?.in_flight) {
        setTimeout(() => void this.doTakePendingImport(), IMPORT_RETRY_MS);
      }
    }
  }

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

  async #refreshPlayerNow(): Promise<void> {
    try {
      this.player = await playerState();
      this.#polledAt = Date.now();
    } catch (e) {
      this.lastError = String(e);
    }
  }

  async doAuditionTransition(fromPath: string, toPath: string): Promise<boolean> {
    if (this.playbackRecovery?.kind !== "ready") return false;
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
    if (this.playbackRecovery?.kind !== "ready") return false;
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

  async doSetMusicDir(): Promise<
    { ok: true; changed: boolean; restartRequired: boolean } | { ok: false; error: string }
  > {
    if (this.playbackRecovery?.kind !== "ready") {
      return { ok: false, error: "playback_recovery_required" };
    }
    try {
      const result = await setMusicDirCmd(i18n.t.pickMusicFolder);
      this.dirs = result.dirs;
      if (result.changed) {
        this.#markLibraryRefreshOwed();
        await this.doRefreshLibrary();
      }
      return { ok: true, changed: result.changed, restartRequired: result.restart_required };
    } catch (e) {
      const message = String(e);
      this.lastError = message;
      return { ok: false, error: message };
    }
  }
}

export const store = new PlayerStore();
