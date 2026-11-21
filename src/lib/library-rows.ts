import type { QueueSnapshot, TrackRow } from "./tauri";

const WAITING = new Set(["pending", "preparing", "prepared"]);

/** 1-based position of each path's first appearance in what plays next. */
export function upNextPositions(queue: QueueSnapshot | null | undefined): Map<string, number> {
  const paths = queue?.playlist
    ? queue.playlist.rows.filter((row) => WAITING.has(row.status)).map((row) => row.path)
    : [...(queue?.reserved ? [queue.reserved] : []), ...(queue?.pending ?? [])].map((item) => item.path);
  const positions = new Map<string, number>();
  paths.forEach((path, i) => { if (!positions.has(path)) positions.set(path, i + 1); });
  return positions;
}

/** Paths whose title and artist also belong to another row, so the name alone does not identify them. */
export function ambiguousPaths(rows: readonly TrackRow[]): Set<string> {
  const byName = new Map<string, string[]>();
  for (const row of rows) {
    const key = `${row.title}\n${row.artist}`;
    byName.set(key, [...(byName.get(key) ?? []), row.path]);
  }
  return new Set([...byName.values()].filter((paths) => paths.length > 1).flat());
}
