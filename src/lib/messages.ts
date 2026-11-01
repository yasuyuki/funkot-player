import type { Messages } from "./locales/en";

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

export function enqueueManyMessage(
  t: Messages,
  result: { added: number; rejected: number; skipped: number },
): string {
  const notes: string[] = [];
  if (result.skipped > 0) notes.push(t.enqueueManySkipped(result.skipped));
  if (result.rejected > 0) notes.push(t.enqueueManyRejected(result.rejected));
  const added = t.enqueueManyAdded(result.added);
  return notes.length === 0 ? added : `${added}${t.enqueueManyNotes(notes.join(t.listSeparator))}`;
}

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

export function roleLabel(t: Messages, role: string): string {
  return role === "outgoing" ? t.roleOutgoing : t.roleIncoming;
}

export function flaggedTitle(t: Messages, title: string, missing: boolean): string {
  return missing && !title ? t.missingTrack : title;
}
