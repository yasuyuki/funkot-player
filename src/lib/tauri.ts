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
}

/// Matches `TransitionInfo`.
export interface TransitionInfo {
  from: string;
  to: string;
  automatic: boolean;
  seconds_ago: number;
}

/// Matches `PlayerState`.
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

/// Matches `TrackRow`. Stage 1 only reads `name` / `title` / `artist`, but
/// every field is declared so later stages do not have to touch this file.
export interface TrackRow {
  path: string;
  name: string;
  title: string;
  artist: string;
  duration_secs: number | null;
  analyzed: boolean;
  intro_bars: number | null;
  outro_structure_bars: number | null;
  outro_bars: number | null;
  intro_manual: boolean;
  outro_manual: boolean;
  intro_low_confidence: boolean;
  outro_low_confidence: boolean;
}

export function appDirs(): Promise<AppDirs> {
  return invoke<AppDirs>("app_dirs");
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

export function refreshLibrary(): Promise<TrackRow[]> {
  return invoke<TrackRow[]>("refresh_library");
}

/// Matches `QueueSnapshot`. `reserved` / `pending` are absolute paths (see
/// `src-tauri/src/lib.rs`); the UI resolves them against the library by path.
export interface QueueSnapshot {
  reserved: string | null;
  pending: string[];
}

/// Matches `AnalysisProgress`. Emitted as `analysis-progress`; `row` is the
/// just-finished track so the UI can splice it in without a full rescan.
export interface AnalysisProgress {
  done: number;
  total: number;
  name: string;
  row: TrackRow;
}

export function queueState(): Promise<QueueSnapshot> {
  return invoke<QueueSnapshot>("queue_state");
}

export function enqueue(path: string): Promise<number> {
  return invoke<number>("enqueue", { path });
}

export function dequeue(index: number): Promise<string> {
  return invoke<string>("dequeue", { index });
}

export function reorder(from: number, to: number): Promise<void> {
  return invoke<void>("reorder", { from, to });
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
