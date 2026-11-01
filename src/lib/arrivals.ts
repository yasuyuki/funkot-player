import type { NewArrival, TrackRow } from "./tauri";

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

export function gatedArrivals(
  arrivals: NewArrival[],
  library: ReadonlyMap<string, TrackRow>,
  allowNonFunkot: boolean,
): NewArrival[] {
  return arrivals.filter((a) => passesGate(library.get(a.path), allowNonFunkot));
}

export function actionableArrivals(
  arrivals: NewArrival[],
  library: ReadonlyMap<string, TrackRow>,
  allowNonFunkot: boolean,
  nowPlaying: string | null,
  reserved: string | null,
  pending: readonly string[],
  inFlight: readonly string[],
  activePlaylistPaths: readonly string[],
): NewArrival[] {
  const exclude = new Set<string>();
  if (nowPlaying) exclude.add(nowPlaying);
  if (reserved) exclude.add(reserved);
  for (const p of pending) exclude.add(p);
  for (const p of inFlight) exclude.add(p);
  for (const p of activePlaylistPaths) exclude.add(p);
  return gatedArrivals(arrivals, library, allowNonFunkot).filter(
    (a) => !exclude.has(a.path),
  );
}

export type RefreshAttempt = "success" | "busy" | "error" | "stale";

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
