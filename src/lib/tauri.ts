import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import {
  listen as nativeListen,
  type EventCallback,
  type EventName,
  type UnlistenFn,
} from "@tauri-apps/api/event";

export interface TauriIpc {
  invoke: typeof nativeInvoke;
  listen: <T>(
    event: EventName,
    handler: EventCallback<T>,
  ) => Promise<UnlistenFn>;
}

let ipc: TauriIpc = {
  invoke: nativeInvoke,
  listen: nativeListen,
};

export function installIpcForTesting(next: TauriIpc): () => void {
  const previous = ipc;
  ipc = next;
  return () => {
    ipc = previous;
  };
}

export function listen<T>(
  event: EventName,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  return ipc.listen(event, handler);
}

export interface AppDirs {
  music_dir: string;
  cache_dir: string;
  data_dir: string;
  music_dir_custom: string | null;
  music_dir_unavailable: boolean;
  music_dir_needed: boolean;
  music_dir_configurable: boolean;
}

export interface TransitionInfo {
  from: string;
  to: string;
  automatic: boolean;
  seconds_ago: number;
}

export interface PlayerState {
  phase: string;
  paused: boolean;
  now_playing: string | null;
  previous: string | null;
  last_transition: TransitionInfo | null;
  auditioning: boolean;
  audition_from: string | null;
  audition_to: string | null;
  position_secs: number | null;
  duration_secs: number | null;
  history_revision: number;
  playback_started_frames: number | null;
}

export interface TrackRow {
  path: string;
  content_hash: string | null;
  title: string;
  artist: string;
  duration_secs: number | null;
  analyzed: boolean;
  is_funkot: boolean;
  label: boolean | null;
  intro_bars: number | null;
  outro_structure_bars: number | null;
  outro_bars: number | null;
  intro_manual: boolean;
  outro_manual: boolean;
  intro_low_confidence: boolean;
  outro_low_confidence: boolean;
  played_at_ms: number | null;
  added_order: number | null;
}

export type TagKind = "genre" | "custom";
export interface Tag { kind: TagKind; value: string }
export type TagYear = { mode: "auto" } | { mode: "set"; value: number } | { mode: "unset" };
export interface TagPatch { year_change?: TagYear; add?: Tag[]; remove?: Tag[] }
export interface TagTarget { path: string; expected_hash: string }
export interface EffectiveTag {
  key: string;
  kind: TagKind | "year";
  value: string;
  origin: "embedded" | "manual" | "both";
}
export interface YearCandidate {
  raw_key: string;
  raw_value: string;
  semantic: "recording" | "generic" | "release" | "original";
  rank: number;
}
export interface TrackTagState {
  content_hash: string | null;
  effective: EffectiveTag[];
  manual: { year: TagYear; manual_additions: Tag[]; suppressed_auto_tags: Tag[] };
  auto_year: number | null;
  year_status: "resolved" | "missing" | "future" | "conflict" | "invalid";
  metadata_status: "pending" | "ready" | "error";
  candidates: YearCandidate[];
  diagnostics: string[];
}
export interface TrackTagsSnapshot {
  revision: string;
  ready: boolean;
  store_status: string;
  tracks: Record<string, TrackTagState>;
}
export interface TagUpdateRequest {
  targets: TagTarget[];
  expected_revision: string;
  patch: TagPatch;
}
export interface TagUpdateResult {
  snapshot: TrackTagsSnapshot;
  changed: number;
  no_op: number;
}
export type TagErrorCode = "invalid_input" | "identity_unavailable" | "identity_changed"
  | "stale_revision" | "store_read_only" | "persist_failed" | "busy";
export interface TagCommandError { code: TagErrorCode; message: string }
export function listTrackTags(): Promise<TrackTagsSnapshot> {
  return ipc.invoke("list_track_tags");
}
export function updateTrackTags(request: TagUpdateRequest): Promise<TagUpdateResult> {
  return ipc.invoke("update_track_tags", { request });
}

export function appDirs(): Promise<AppDirs> {
  return ipc.invoke<AppDirs>("app_dirs");
}

export type PlaybackRecoveryStatus =
  | { kind: "ready" }
  | {
      kind: "legacy_normal_conflict";
      token: number;
      queue_file_items: number;
      catalog_normal_items: number;
    }
  | { kind: "blocked"; reason: string };

export type PlaybackRecoveryChoice = "queue_file" | "catalog_normal";

export interface PlaybackRecoveryRequest {
  token: number;
  choice: PlaybackRecoveryChoice;
}

export function playbackRecoveryStatus(): Promise<PlaybackRecoveryStatus> {
  return ipc.invoke<PlaybackRecoveryStatus>("playback_recovery_status");
}

export function resolvePlaybackRecovery(
  request: PlaybackRecoveryRequest,
): Promise<PlaybackRecoveryStatus> {
  return ipc.invoke<PlaybackRecoveryStatus>("resolve_playback_recovery", { request });
}

export function openMusicDir(): Promise<string> {
  return ipc.invoke<string>("open_music_dir");
}

export interface SetMusicDirResult {
  changed: boolean;
  dirs: AppDirs;
  restart_required: boolean;
}

export function setMusicDir(title: string): Promise<SetMusicDirResult> {
  return ipc.invoke<SetMusicDirResult>("set_music_dir", { title });
}

export function playerState(): Promise<PlayerState> {
  return ipc.invoke<PlayerState>("player_state");
}

// Tauri maps these camelCase keys to the Rust commands' snake_case parameters.
export function start(musicDir: string, cacheDir: string): Promise<string> {
  return ipc.invoke<string>("start", { musicDir, cacheDir });
}

export function togglePause(): Promise<boolean> {
  return ipc.invoke<boolean>("toggle_pause");
}

export function skipNext(): Promise<void> {
  return ipc.invoke<void>("skip_next");
}

export interface LibraryScanResult {
  rows: TrackRow[];
  persistence_error: string | null;
}

export function refreshLibrary(kickAnalysis = true): Promise<LibraryScanResult> {
  return ipc.invoke<LibraryScanResult>("refresh_library", { kickAnalysis });
}

export interface QueueItem {
  entry_id: string;
  path: string;
  origin: "manual" | "automatic";
}

export interface QueueSnapshot {
  reserved: QueueItem | null;
  pending: QueueItem[];
  in_flight: QueueItem[];
  reserved_swappable: boolean;
  reserved_prepared: boolean;
  transition_in_secs: number | null;
  folder_pos: number;
  folder_len: number;
  source?: SourceTarget;
  playlist?: PlaylistDetails | null;
  catalog_revision?: number;
  playlist_store_status?: string;
}

export interface SourceTarget { playlist_id: string | null; generation: number; revision: number; }
export interface PlaylistSummary { id: string; name: string; revision: number; total: number; remaining: number; }
export const FAVORITES_PLAYLIST_ID = "favorites";

export interface PlaylistCatalogSnapshot { revision: number; active_id: string | null; generation: number; store_status: string; lists: PlaylistSummary[]; favorite_hashes: string[]; }
export interface PlaylistEntryView { entry_id: string; path: string; title: string; artist: string; status: "pending" | "preparing" | "prepared" | "missing" | "unplayable" | "played" | "current"; reason: string | null; }
export interface PlaylistDetails { id: string; name: string; revision: number; run_id: number; total: number; ended: boolean; skipped: number; rows: PlaylistEntryView[]; }
export type PlaylistAction =
  | { kind: "select"; id: string | null } | { kind: "create"; name: string }
  | { kind: "save_queue"; name: string } | { kind: "rename"; id: string; name: string }
  | { kind: "duplicate"; id: string } | { kind: "delete"; id: string; confirm_name: string }
  | { kind: "restart"; id: string } | { kind: "remove"; id: string; entry_id: string }
  | { kind: "undo_remove"; undo_id: string } | { kind: "move"; id: string; entry_id: string; to: number; scope: "remaining" | "all" }
  | { kind: "append"; tracks: Array<{ path: string; expected_hash: string | null }>; mode: "single" | "many" | "arrivals" }
  | { kind: "set_favorite"; track: { path: string; expected_hash: string | null }; favorite: boolean }
  | { kind: "queue_move"; from: number; to: number; expect: QueueItem }
  | { kind: "queue_remove"; index: number; expect: QueueItem };
export interface PlaylistCommandResult { created_id: string | null; undo_id: string | null; added: number; rejected: number; skipped: number; }
export type PlaylistCommandErrorCode = "stale" | "invalid_input" | "not_found" | "active_list" | "store_read_only" | "persist_failed" | "busy" | "transition_in_progress" | "active_upgrade_pending" | "navigation_pending" | "no_runway" | "auditioning" | "identity_unavailable" | "identity_changed" | "duplicate_undo";
export interface PlaylistCommandError { code: PlaylistCommandErrorCode; message: string; }

export function playlistCatalog(): Promise<PlaylistCatalogSnapshot> { return ipc.invoke("playlist_catalog"); }
export function playlistEntries(id: string): Promise<PlaylistDetails> { return ipc.invoke("playlist_entries", { id }); }
export function playlistCommand(request: { request_id: string; target: SourceTarget; action: PlaylistAction }): Promise<PlaylistCommandResult> {
  return ipc.invoke("playlist_command", { request });
}

export interface AnalysisProgress {
  done: number;
  total: number;
  name: string;
  row: TrackRow;
}

export interface LibraryScanProgress {
  phase: "walking" | "hashing";
  found: number;
  done: number;
}

export function queueState(): Promise<QueueSnapshot> {
  return ipc.invoke<QueueSnapshot>("queue_state");
}

export function getAllowNonFunkot(): Promise<boolean> {
  return ipc.invoke<boolean>("get_allow_non_funkot");
}

export function setAllowNonFunkot(allow: boolean): Promise<boolean> {
  return ipc.invoke<boolean>("set_allow_non_funkot", { allow });
}

export function getLocale(): Promise<string | null> {
  return ipc.invoke<string | null>("get_locale");
}

export function setLocale(locale: string): Promise<string> {
  return ipc.invoke<string>("set_locale", { locale });
}

export function getLabelingMode(): Promise<boolean> {
  return ipc.invoke<boolean>("get_labeling_mode");
}

export function setLabelingMode(on: boolean): Promise<boolean> {
  return ipc.invoke<boolean>("set_labeling_mode", { on });
}

export interface FlagResult {
  from_title: string;
  to_title: string;
  count: number;
}

export function flagLastTransition(): Promise<FlagResult> {
  return ipc.invoke<FlagResult>("flag_last_transition");
}

export function undoLastFlag(): Promise<void> {
  return ipc.invoke<void>("undo_last_flag");
}

export function pollLog(): Promise<string[]> {
  return ipc.invoke<string[]>("poll_log");
}

export interface FlagPartner {
  track_hash: string;
  title: string;
  count: number;
  missing: boolean;
  path: string | null;
}

export interface FlaggedTrackRow {
  track_hash: string;
  role: string;
  title: string;
  artist: string;
  count: number;
  low_confidence: boolean;
  missing: boolean;
  partners: FlagPartner[];
  path: string | null;
  intro_bars: number | null;
  outro_structure_bars: number | null;
  outro_bars: number | null;
  intro_manual: boolean;
  outro_manual: boolean;
  analyzed: boolean;
}

export function listFlaggedTracks(): Promise<FlaggedTrackRow[]> {
  return ipc.invoke<FlaggedTrackRow[]>("list_flagged_tracks");
}

export function dismissFlags(trackHash: string, role: string): Promise<number> {
  return ipc.invoke<number>("dismiss_flags", { trackHash, role });
}

export function undoLastDismiss(): Promise<void> {
  return ipc.invoke<void>("undo_last_dismiss");
}

export function setBars(
  path: string,
  introBars: number | null,
  outroStructureBars: number | null,
  markManual?: boolean,
): Promise<TrackRow> {
  return ipc.invoke<TrackRow>("set_bars", {
    path,
    introBars,
    outroStructureBars,
    markManual,
  });
}

export interface LabelStats {
  labeled: number;
  total: number;
  funkot: number;
  not_funkot: number;
}

export function setLabel(path: string, verdict: boolean | null): Promise<TrackRow> {
  return ipc.invoke<TrackRow>("set_label", { path, verdict });
}

export function setFolderLabel(dir: string, verdict: boolean): Promise<number> {
  return ipc.invoke<number>("set_folder_label", { dir, verdict });
}

export function undoLastFolderLabel(): Promise<number> {
  return ipc.invoke<number>("undo_last_folder_label");
}

export function labelStats(): Promise<LabelStats> {
  return ipc.invoke<LabelStats>("label_stats");
}

export function clearLabels(): Promise<void> {
  return ipc.invoke<void>("clear_labels");
}

export function clearPlayLog(): Promise<void> {
  return ipc.invoke<void>("clear_play_log");
}

export function clearPlayCounts(): Promise<void> {
  return ipc.invoke<void>("clear_play_counts");
}

export function clearTrackPlayCount(hash: string): Promise<void> {
  return ipc.invoke<void>("clear_track_play_count", { hash });
}

export function removePlayLogEntry(atMs: number): Promise<void> {
  return ipc.invoke<void>("remove_play_log_entry", { atMs });
}

export interface NewArrival {
  path: string;
  first_seen: string;
}

export function listNewArrivals(): Promise<NewArrival[]> {
  return ipc.invoke<NewArrival[]>("list_new_arrivals");
}

export interface PlayLogRow {
  at_ms: number;
  track_hash: string;
  title: string;
  artist: string;
  path: string | null;
  missing: boolean;
  origin: string | null;
}

export interface PlayedTrackRow {
  track_hash: string;
  title: string;
  artist: string;
  path: string | null;
  missing: boolean;
  count: number;
  last_played_ms: number;
}

export interface PlayHistory {
  log: PlayLogRow[];
  tracks: PlayedTrackRow[];
  log_total: number;
}

export function listPlayHistory(limit: number): Promise<PlayHistory> {
  return ipc.invoke<PlayHistory>("list_play_history", { limit });
}

export function auditionTransition(
  fromPath: string,
  toPath: string,
  musicDir: string,
  cacheDir: string,
): Promise<void> {
  return ipc.invoke<void>("audition_transition", {
    fromPath,
    toPath,
    musicDir,
    cacheDir,
  });
}

export function auditionAgain(musicDir: string, cacheDir: string): Promise<void> {
  return ipc.invoke<void>("audition_again", { musicDir, cacheDir });
}

export function resumeAutodj(): Promise<void> {
  return ipc.invoke<void>("resume_autodj");
}

export interface ShareFeedbackResult {
  mode: string;
  path: string;
}

export function shareFeedback(title: string): Promise<ShareFeedbackResult> {
  return ipc.invoke<ShareFeedbackResult>("share_feedback", { title });
}

export interface ImportResult {
  tracks: number;
  skipped: number;
  failed: number;
  in_flight: boolean;
}

export function takePendingImport(): Promise<ImportResult> {
  return ipc.invoke<ImportResult>("take_pending_import");
}
