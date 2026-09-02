// Host codes → catalogue text.
//
// These live here rather than in the components because more than one screen
// asks the same question: `set_music_dir` errors are surfaced by both the
// library empty state and the ⋮ menu, and a flagged row's role is shown in
// both the list and the detail. Two copies of a switch like this is how one
// of them ends up untranslated.
//
// Each takes the catalogue explicitly instead of reaching for `i18n`, so this
// stays a plain `.ts` (no runes) and the mapping can be tested on its own.
import type { Messages } from "./locales/en";

/// `set_music_dir` rejection code → toast text. The codes are the contract
/// documented on `set_music_dir` in `src-tauri/src/lib.rs` and mirrored in
/// `src/lib/tauri.ts`; an unknown one falls through to the generic message
/// rather than showing the raw code.
export function musicDirErrorMessage(t: Messages, code: string): string {
  switch (code) {
    case "not_absolute":
      return t.musicDirErrNotAbsolute;
    case "not_found":
      return t.musicDirErrNotFound;
    case "not_a_directory":
      return t.musicDirErrNotADirectory;
    case "not_readable":
      return t.musicDirErrNotReadable;
    case "contains_app_data":
      return t.musicDirErrContainsAppData;
    case "unsupported_platform":
      return t.musicDirErrUnsupportedPlatform;
    default:
      return t.musicDirErrGeneric;
  }
}

/// `queue::EditError` code (`reorder` / `dequeue`) → toast text.
export function queueErrorMessage(t: Messages, code: string): string {
  switch (code) {
    case "too_late":
      return t.queueErrTooLate;
    case "stale":
      return t.queueErrStale;
    case "auditioning":
      return t.queueErrAuditioning;
    case "origin_boundary":
      return t.queueErrOriginBoundary;
    default:
      return t.queueErrGeneric;
  }
}

/// `PlayerState.phase` → badge text. An unrecognised phase shows as-is: it
/// can only come from a host newer than this bundle, and the raw
/// discriminant is more useful to whoever is looking than a blank badge.
export function phaseLabel(t: Messages, phase: string): string {
  switch (phase) {
    case "idle":
      return t.phaseIdle;
    case "starting":
      return t.phaseStarting;
    case "playing":
      return t.phasePlaying;
    case "paused":
      return t.phasePaused;
    case "stalled":
      return t.phaseStalled;
    case "failed":
      return t.phaseFailed;
    case "disconnected":
      return t.phaseDisconnected;
    default:
      return phase;
  }
}

/// `FlaggedTrackRow.role` → text. Anything that is not `"outgoing"` reads as
/// incoming, matching `aggregate_flags`, which only ever emits the two.
export function roleLabel(t: Messages, role: string): string {
  return role === "outgoing" ? t.roleOutgoing : t.roleIncoming;
}

/// Title for a flagged row or partner. The host sends an empty title with
/// `missing: true` for a track that has left the library (see
/// `MISSING_TITLE` in `src-tauri/src/store.rs`); the stand-in wording is
/// here so it is translated like everything else.
export function flaggedTitle(t: Messages, title: string, missing: boolean): string {
  return missing && !title ? t.missingTrack : title;
}
