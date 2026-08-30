import type { TrackRow } from "./tauri";

export type LibrarySortKey = "recent" | "title" | "artist";

function comparePath(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareTitleThenPath(a: TrackRow, b: TrackRow): number {
  return (
    a.title.localeCompare(b.title, "ja") || comparePath(a.path, b.path)
  );
}

export function sortLibraryRows(
  rows: readonly TrackRow[],
  sortKey: LibrarySortKey,
): TrackRow[] {
  return rows.slice().sort((a, b) => {
    if (sortKey === "recent") {
      if (a.added_order !== b.added_order) {
        if (a.added_order === null) return 1;
        if (b.added_order === null) return -1;
        return b.added_order - a.added_order;
      }
      return compareTitleThenPath(a, b);
    }
    if (sortKey === "artist") {
      const byArtist = a.artist.localeCompare(b.artist, "ja");
      if (byArtist !== 0) return byArtist;
    }
    return a.title.localeCompare(b.title, "ja");
  });
}

export function nextLibrarySortKey(
  current: LibrarySortKey,
): LibrarySortKey {
  if (current === "recent") return "title";
  if (current === "title") return "artist";
  return "recent";
}

/// Analysis and edit commands do not rescan the hash index. Keep the
/// authoritative addition order already present in the library row when such
/// a partial replacement carries `null`.
export function preserveLibraryAddedOrder(
  previous: TrackRow | undefined,
  incoming: TrackRow,
): TrackRow {
  if (incoming.added_order !== null || previous?.added_order == null) {
    return incoming;
  }
  return { ...incoming, added_order: previous.added_order };
}
