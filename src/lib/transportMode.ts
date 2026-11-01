import type { QueueSnapshot } from "./tauri";

export type PrimaryMode = "start" | "pause" | "resume" | "off";

const PAUSE_PHASES = new Set([
  "playing",
  "stalled",
  "starting",
  "paused",
  "disconnected",
]);

export function primaryMode(
  phase: string,
  paused: boolean,
  auditioning: boolean,
): PrimaryMode {
  if (auditioning) return "off";
  if (phase === "idle") return "start";
  if (phase === "failed") return "off";
  if (paused) return "resume";
  if (PAUSE_PHASES.has(phase)) return "pause";
  return "off";
}

export function sessionActive(phase: string, auditioning: boolean): boolean {
  if (auditioning) return false;
  if (phase === "idle" || phase === "failed") return false;
  return true;
}

export function canSkipNext(
  phase: string,
  auditioning: boolean,
  queue: Pick<QueueSnapshot, "playlist" | "reserved_prepared"> | null | undefined,
): boolean {
  if (!sessionActive(phase, auditioning)) return false;
  return queue?.playlist
    ? queue.playlist.rows.some(row => row.status === "prepared")
    : queue?.reserved_prepared ?? false;
}
