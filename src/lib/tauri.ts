// Typed `invoke` wrapper for the Tauri commands stage 1 needs.
//
// Every type below has to match the shape of the corresponding Rust struct
// (`src-tauri/src/lib.rs`) field-for-field: serde serialises struct field
// names as-is (snake_case), and this file does not translate them. If a
// field is renamed, added, or removed on the Rust side and not mirrored
// here, playback data silently comes through as `undefined` instead of
// failing to compile.
import { invoke } from "@tauri-apps/api/core";

/// Matches `AppDirs`.
export interface AppDirs {
  music_dir: string;
  cache_dir: string;
  data_dir: string;
  /// The `settings.json` value that produced `music_dir`, or `null` if
  /// nothing is configured (fresh install, or always on Android).
  music_dir_custom: string | null;
  /// `true` when `music_dir_custom` was set but unreadable this launch.
  /// `settings.json` is left untouched. Implies `music_dir_needed`.
  music_dir_unavailable: boolean;
  /// Desktop: `true` until settings has a readable `music_dir`. Android:
  /// always `false`. While `true`, Start must stay disabled.
  music_dir_needed: boolean;
  /// Whether `setMusicDir` can do anything on this platform. `true` on
  /// desktop, `false` on Android.
  music_dir_configurable: boolean;
}

/// Matches `TransitionInfo`. `from` / `to` are absolute paths, matching
/// `TrackRow.path`'s format (tracks can share a basename across
/// subdirectories now that scanning is recursive, so a bare file name is not
/// enough to identify one).
export interface TransitionInfo {
  from: string;
  to: string;
  automatic: boolean;
  seconds_ago: number;
}

/// Matches `PlayerState`. `now_playing` / `previous` are absolute paths,
/// matching `TrackRow.path`'s format (see `TransitionInfo`'s doc comment for
/// why a bare file name would not be enough).
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
}

/// Matches `TrackRow`. `path` is the identity the UI keys on (basenames can
/// collide across subdirectories now that scanning is recursive).
export interface TrackRow {
  path: string;
  title: string;
  artist: string;
  duration_secs: number | null;
  analyzed: boolean;
  /// Effective Funkot flag. Unanalysed rows are `true` (not greyed); grey
  /// with `analyzed && !is_funkot`.
  is_funkot: boolean;
  /// Human Funkot / non-Funkot label (`labels.json`). Unlabeled is `null`.
  label: boolean | null;
  intro_bars: number | null;
  outro_structure_bars: number | null;
  outro_bars: number | null;
  intro_manual: boolean;
  outro_manual: boolean;
  intro_low_confidence: boolean;
  outro_low_confidence: boolean;
  /// `history.json` last_played_ms; null when never heard.
  played_at_ms: number | null;
}

export function appDirs(): Promise<AppDirs> {
  return invoke<AppDirs>("app_dirs");
}

/// Opens the Music folder (explorer / open / xdg-open) and returns its
/// absolute path. Desktop only: the UI hides the menu item on Android, where
/// the folder cannot be opened at all (see `open_music_dir` in `lib.rs`).
export function openMusicDir(): Promise<string> {
  return invoke<string>("open_music_dir");
}

/// Matches `SetMusicDirResult`.
export interface SetMusicDirResult {
  changed: boolean;
  dirs: AppDirs;
  restart_required: boolean;
}

/// Opens a native folder-picker dialog and, if the listener confirms a
/// folder, validates it and saves it to `settings.json`. Desktop only
/// (Windows/Mac/Linux) — rejects with `"unsupported_platform"` on Android.
///
/// Rejects with one of `"not_absolute"` / `"not_found"` / `"not_a_directory"`
/// / `"not_readable"` / `"contains_app_data"` / `"unsupported_platform"`
/// (see `set_music_dir`'s doc comment in `src-tauri/src/lib.rs`) — this file
/// and that one, plus `OverflowMenu.svelte`, must keep the exact strings in
/// sync.
export function setMusicDir(): Promise<SetMusicDirResult> {
  return invoke<SetMusicDirResult>("set_music_dir");
}

export function playerState(): Promise<PlayerState> {
  return invoke<PlayerState>("player_state");
}

// Tauri converts these camelCase argument names to the Rust commands'
// snake_case parameters itself; see legacy/index.html's `invoke("start", …)`
// call for the same convention.
export function start(musicDir: string, cacheDir: string): Promise<string> {
  return invoke<string>("start", { musicDir, cacheDir });
}

export function togglePause(): Promise<boolean> {
  return invoke<boolean>("toggle_pause");
}

export function skipNext(): Promise<void> {
  return invoke<void>("skip_next");
}

export function refreshLibrary(kickAnalysis = true): Promise<TrackRow[]> {
  return invoke<TrackRow[]>("refresh_library", { kickAnalysis });
}

/// Matches `QueueSnapshot`. `reserved` / `pending` are absolute paths (see
/// `src-tauri/src/lib.rs`); the UI resolves them against the library by path.
export interface QueueSnapshot {
  reserved: string | null;
  pending: string[];
  /// Whether `reorder`/`dequeue` would currently accept an edit that reaches
  /// into the `reserved` slot (displayed index 0, or `Move { to: 0 }`).
  reserved_swappable: boolean;
  /// Whether the engine has actually finished preparing `reserved`, as
  /// opposed to still decoding/time-stretching it. Reads as prepared
  /// (`true`) during an audition or while paused even though preparation
  /// state is frozen then — see `QueueSnapshot::reserved_prepared` in
  /// `src-tauri/src/lib.rs`.
  reserved_prepared: boolean;
  /// Seconds until the engine's automatic transition may begin, or `null`
  /// when unknown (stopped, auditioning, or no active deck).
  transition_in_secs: number | null;
}

/// Matches `AnalysisProgress`. Emitted as `analysis-progress`; `row` is the
/// just-finished track so the UI can splice it in without a full rescan.
export interface AnalysisProgress {
  done: number;
  total: number;
  name: string;
  row: TrackRow;
}

/// Matches `LibraryScanProgress`. Emitted as `library-scan` while
/// `refresh_library` walks the music folder and content-hashes each track.
export interface LibraryScanProgress {
  phase: "walking" | "hashing";
  found: number;
  done: number;
}

export function queueState(): Promise<QueueSnapshot> {
  return invoke<QueueSnapshot>("queue_state");
}

export function enqueue(path: string): Promise<number> {
  return invoke<number>("enqueue", { path });
}

/// Current `settings.json` `allow_non_funkot` (also drives the live gate).
export function getAllowNonFunkot(): Promise<boolean> {
  return invoke<boolean>("get_allow_non_funkot");
}

/// Persist and apply `allow_non_funkot`. Returns the saved value.
export function setAllowNonFunkot(allow: boolean): Promise<boolean> {
  return invoke<boolean>("set_allow_non_funkot", { allow });
}

// `index`/`from`/`to` below are indices into the *displayed* queue list
// (`[reserved?] ++ pending` — index 0 is `reserved` when present, matching
// `QueueSnapshot`), not just `pending`. `expect` is the path currently shown
// at the edited position; a stale caller gets `"stale"` back rather than
// silently acting on the wrong track.
//
// Rejects with one of `"too_late"` / `"stale"` / `"out_of_range"` /
// `"auditioning"` (see `queue::EditError` and `reorder`'s doc comment in
// `src-tauri/src/lib.rs`) — this file and that one must keep the exact
// strings in sync.
export function dequeue(index: number, expect: string): Promise<string> {
  return invoke<string>("dequeue", { index, expect });
}

export function reorder(from: number, to: number, expect: string): Promise<void> {
  return invoke<void>("reorder", { from, to, expect });
}

/// Matches `FlagResult`.
export interface FlagResult {
  from_title: string;
  to_title: string;
  count: number;
}

/// Records `PlayerState.last_transition` into `flags.json`. Never touches
/// playback (`src-tauri/src/lib.rs`'s `flag_last_transition_impl` doc
/// comment: "Playback is untouched: no nav, pause, or engine call.").
export function flagLastTransition(): Promise<FlagResult> {
  return invoke<FlagResult>("flag_last_transition");
}

/// Undoes the most recent `flagLastTransition` call (single-shot). Rejects
/// with "nothing to undo" once already consumed or if nothing was flagged.
export function undoLastFlag(): Promise<void> {
  return invoke<void>("undo_last_flag");
}

/// Drains whatever the audio thread has logged so far. Safe to call before
/// `start()`; returns an empty array rather than failing.
export function pollLog(): Promise<string[]> {
  return invoke<string[]>("poll_log");
}

/// Matches `store::FlagPartner`.
export interface FlagPartner {
  track_hash: string;
  title: string;
  count: number;
  missing: boolean;
  path: string | null;
}

/// Matches `store::FlaggedTrackRow`. `role` is `"outgoing"` | `"incoming"`.
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
  return invoke<FlaggedTrackRow[]>("list_flagged_tracks");
}

/// Hides one track×role from the flagged list. Returns `1` when a new dismiss
/// key was recorded (undo armed); `0` when already dismissed / bad role.
export function dismissFlags(trackHash: string, role: string): Promise<number> {
  return invoke<number>("dismiss_flags", { trackHash, role });
}

export function undoLastDismiss(): Promise<void> {
  return invoke<void>("undo_last_dismiss");
}

/// Writes intro and/or outro structure bars. A side left as `null` is untouched.
/// `markManual` defaults to `true` (confirm / normal chip). Pass `false` to
/// revert cancel/undo without leaving `*` or a library.json override.
export function setBars(
  path: string,
  introBars: number | null,
  outroStructureBars: number | null,
  markManual?: boolean,
): Promise<TrackRow> {
  return invoke<TrackRow>("set_bars", {
    path,
    introBars,
    outroStructureBars,
    markManual,
  });
}

/// Matches `LabelStats`.
export interface LabelStats {
  labeled: number;
  total: number;
  funkot: number;
  not_funkot: number;
}

/// Set or clear one track's human Funkot label. `verdict: null` clears it.
export function setLabel(path: string, verdict: boolean | null): Promise<TrackRow> {
  return invoke<TrackRow>("set_label", { path, verdict });
}

/// Label every supported track under `dir` (recursive). Returns how many were labeled.
export function setFolderLabel(dir: string, verdict: boolean): Promise<number> {
  return invoke<number>("set_folder_label", { dir, verdict });
}

export function labelStats(): Promise<LabelStats> {
  return invoke<LabelStats>("label_stats");
}

export function auditionTransition(
  fromPath: string,
  toPath: string,
  musicDir: string,
  cacheDir: string,
): Promise<void> {
  return invoke<void>("audition_transition", {
    fromPath,
    toPath,
    musicDir,
    cacheDir,
  });
}

export function auditionAgain(musicDir: string, cacheDir: string): Promise<void> {
  return invoke<void>("audition_again", { musicDir, cacheDir });
}

export function resumeAutodj(): Promise<void> {
  return invoke<void>("resume_autodj");
}

/// Matches `ShareFeedbackResult`.
export interface ShareFeedbackResult {
  /** `"shared"` (Android chooser) or `"saved"` (desktop path written). */
  mode: string;
  /** Absolute path of the staged ZIP. */
  path: string;
}

/// Snapshot `library.json` / `flags.json` into a ZIP and share (Android) or
/// return the staged path (desktop).
export function shareFeedback(): Promise<ShareFeedbackResult> {
  return invoke<ShareFeedbackResult>("share_feedback");
}

/// Matches `ImportResult`.
export interface ImportResult {
  /** Files copied into `music_dir`. */
  tracks: number;
  /** Staged files whose extension is not one the engine can decode. */
  skipped: number;
  /** Staged files that passed the extension check but whose copy failed. */
  failed: number;
  /**
   * `true` when `Import.kt` is still copying a share-sheet file into the
   * staging dir. The caller should retry shortly rather than treat this
   * drain as final — see `doTakePendingImport` in `state.svelte.ts`.
   */
  in_flight: boolean;
}

/// Drains files staged by the Android share sheet (`Import.kt`) into
/// `music_dir`. Always `{ tracks: 0, skipped: 0, failed: 0, in_flight: false }`
/// on desktop, since nothing ever stages anything there.
export function takePendingImport(): Promise<ImportResult> {
  return invoke<ImportResult>("take_pending_import");
}
