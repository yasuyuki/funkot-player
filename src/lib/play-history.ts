import type { PlayLogRow } from "./tauri";

export interface PlayLogDay {
  key: string;
  rows: PlayLogRow[];
}

function localDayKey(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${at.getFullYear()}-${month}-${day}`;
}

export function groupPlaysByDay(rows: readonly PlayLogRow[]): PlayLogDay[] {
  const days: PlayLogDay[] = [];
  let current: PlayLogDay | null = null;
  for (const row of rows) {
    const key = localDayKey(new Date(row.at_ms));
    if (current === null || current.key !== key) {
      current = { key, rows: [] };
      days.push(current);
    }
    current.rows.push(row);
  }
  return days;
}

export function calendarDaysAgo(atMs: number, nowMs: number): number {
  const at = new Date(atMs);
  const now = new Date(nowMs);
  const atMidnight = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((nowMidnight.getTime() - atMidnight.getTime()) / 86_400_000);
}

export function playedOnly<T extends { last_played_ms: number }>(
  tracks: readonly T[],
): T[] {
  return tracks.filter((t) => t.last_played_ms > 0);
}

export function selectablePaths(
  rows: readonly { path: string | null; missing: boolean }[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.missing || row.path === null || seen.has(row.path)) continue;
    seen.add(row.path);
    out.push(row.path);
  }
  return out;
}
