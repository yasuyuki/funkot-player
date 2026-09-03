// Shaping for the history pane. Rune-free so it can be tested on its own.
//
// The host sends `at_ms` and leaves every judgement about how to show it here:
// what counts as "today" depends on the listener's clock and locale, and the
// Rust side has neither.

import type { PlayLogRow } from "./tauri";

/// One day's plays, newest day first, newest play first inside it.
export interface PlayLogDay {
  /// `YYYY-MM-DD` in local time — the group's identity, and the `{#each}` key.
  key: string;
  rows: PlayLogRow[];
}

function localDayKey(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${at.getFullYear()}-${month}-${day}`;
}

/// Group the log by local day, preserving the order it arrives in.
///
/// The host already sorts newest first, so this neither sorts nor reverses:
/// re-sorting here would be a second opinion about the order, and two
/// opinions is how they drift apart.
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

/// Days between two instants, by local calendar day rather than by elapsed
/// milliseconds: 23:59 and 00:01 are a day apart to a reader even though they
/// are two minutes apart on the clock.
export function calendarDaysAgo(atMs: number, nowMs: number): number {
  const at = new Date(atMs);
  const now = new Date(nowMs);
  const atMidnight = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((nowMidnight.getTime() - atMidnight.getTime()) / 86_400_000);
}

/// Rows the aggregate view shows: heard at least once, most recent first.
///
/// The host already sorts `tracks`; this only drops the never-played, which
/// the aggregate carries because `history.json` is the whole of it.
export function playedOnly<T extends { last_played_ms: number }>(
  tracks: readonly T[],
): T[] {
  return tracks.filter((t) => t.last_played_ms > 0);
}

/// Paths in `rows`, in order, once each and skipping rows whose file is gone.
///
/// This is the selection universe for the history pane: the log lists the same
/// track on every play, and a track that has left the library cannot be
/// queued.
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
