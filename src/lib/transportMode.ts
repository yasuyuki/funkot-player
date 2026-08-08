/// Shared primary-button / MiniBar visibility mapping for transport UI.
///
/// `PlayerState.paused` only flips via `flip_paused`; automatic track
/// changes leave it alone. Phase can briefly leave `playing` during a
/// handoff (`starting` / `disconnected`), so pause/resume must not key
/// off phase alone — otherwise the button flickers to "start"/off.
///
/// Mapping for `primaryMode` (first match wins):
///   1. auditioning                         → "off"
///   2. phase === "idle"                     → "start"
///   3. phase === "failed"                   → "off"
///   4. paused === true                      → "resume"  (over phase)
///   5. playing|stalled|starting|paused|
///      disconnected                         → "pause"
///   6. else                                 → "off"
///
/// Mapping for `sessionActive`:
///   auditioning                             → false
///   idle | failed                           → false
///   else                                    → true

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
