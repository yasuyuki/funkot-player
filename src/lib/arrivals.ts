// Pure new-arrival helpers (no Svelte). Gate matches library rows:
// `analyzed && !is_funkot && !allowNonFunkot` → excluded. Unanalysed rows
// pass (TrackRow.is_funkot is true until analysis finishes).
import type { NewArrival, TrackRow } from "./tauri";

/// Badge / "new only" filter — gate-independent.
export function arrivalPathSet(arrivals: NewArrival[]): Set<string> {
  return new Set(arrivals.map((a) => a.path));
}

function passesGate(
  row: TrackRow | undefined,
  allowNonFunkot: boolean,
): boolean {
  if (!row) return true;
  if (row.analyzed && !row.is_funkot && !allowNonFunkot) return false;
  return true;
}

/// Gate-applied arrivals (still includes now-playing / queue members).
export function gatedArrivals(
  arrivals: NewArrival[],
  library: ReadonlyMap<string, TrackRow>,
  allowNonFunkot: boolean,
): NewArrival[] {
  return arrivals.filter((a) => passesGate(library.get(a.path), allowNonFunkot));
}

/// Banner count: gated, then drop everything already playing or queued.
///
/// `inFlight` is the stable record of everything handed to the engine, while
/// `reserved` closes the short gap between the loader updating the queue slot
/// and persisting that hand-off. The union matches the backend bulk action.
export function actionableArrivals(
  arrivals: NewArrival[],
  library: ReadonlyMap<string, TrackRow>,
  allowNonFunkot: boolean,
  nowPlaying: string | null,
  reserved: string | null,
  pending: readonly string[],
  inFlight: readonly string[],
): NewArrival[] {
  const exclude = new Set<string>();
  if (nowPlaying) exclude.add(nowPlaying);
  if (reserved) exclude.add(reserved);
  for (const p of pending) exclude.add(p);
  for (const p of inFlight) exclude.add(p);
  return gatedArrivals(arrivals, library, allowNonFunkot).filter(
    (a) => !exclude.has(a.path),
  );
}

export type RefreshAttempt = "success" | "busy" | "error" | "stale";

/**
 * Auto-refresh owed. Busy / error / stale keep `owed`. Success clears only
 * when this attempt started as the owed consumer (`consume`) and the owed
 * epoch did not bump mid-walk (a newer music-dir / import / startup mark).
 * Manual ⋮ success therefore cannot erase a concurrent owed.
 */
export function nextLibraryRefreshOwed(
  owed: boolean,
  attempt: RefreshAttempt,
  consume: boolean,
  epochAtStart: number,
  epochNow: number,
): boolean {
  if (attempt !== "success") return owed;
  if (!consume) return owed;
  if (epochAtStart !== epochNow) return owed;
  return false;
}

export type ArrivalsPullApply =
  | { apply: true; processedRevision: number }
  | { apply: false };

/** Stale gen or failure → do not apply / do not advance revision. */
export function arrivalsPullDecision(
  responseGen: number,
  currentGen: number,
  ok: boolean,
  revision: number,
): ArrivalsPullApply {
  if (responseGen !== currentGen) return { apply: false };
  if (!ok) return { apply: false };
  return { apply: true, processedRevision: revision };
}
