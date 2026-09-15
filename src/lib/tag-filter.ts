import type { EffectiveTag, TrackRow, TrackTagState, TrackTagsSnapshot } from "./tauri";
export type TagChoice = Pick<EffectiveTag, "key" | "kind" | "value">;

export type TagFilter = {
  keys: readonly string[];
  mode: "all" | "any";
  yearUnset: boolean;
};

export type TagIndex = {
  tracks: Map<string, { keys: ReadonlySet<string>; state: TrackTagState | null }>;
  candidates: Array<TagChoice & { count: number }>;
};

const kindOrder: Record<string, number> = { year: 0, genre: 1, custom: 2 };

/** Build only from current library membership. A stale snapshot is never a
 * candidate source, and a path whose UI hash disagrees with the snapshot is
 * pending rather than assigned a potentially wrong tag set. */
export function buildTagIndex(rows: readonly TrackRow[], snapshot: TrackTagsSnapshot | null): TagIndex {
  const tracks = new Map<string, { keys: ReadonlySet<string>; state: TrackTagState | null }>();
  const candidates = new Map<string, TagChoice & { count: number }>();
  for (const row of rows) {
    const state = snapshot?.tracks[row.path] ?? null;
    const current = state !== null && state.content_hash !== null && state.content_hash === row.content_hash;
    const keys = new Set<string>();
    if (current) {
      for (const tag of state.effective) {
        keys.add(tag.key);
      }
      for (const tag of state.effective) {
        const existing = candidates.get(tag.key);
        if (existing) {
          if (tag.value < existing.value) existing.value = tag.value;
          continue;
        }
        candidates.set(tag.key, { key: tag.key, kind: tag.kind, value: tag.value, count: 0 });
      }
      for (const key of keys) candidates.get(key)!.count += 1;
    }
    tracks.set(row.path, { keys, state: current ? state : null });
  }
  return {
    tracks,
    candidates: [...candidates.values()].sort((a, b) => {
      const order = (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9);
      if (order) return order;
      return a.kind === "year" ? Number(a.value) - Number(b.value) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    }),
  };
}

export function matchesTagFilter(index: TagIndex, path: string, filter: TagFilter): boolean {
  const entry = index.tracks.get(path);
  if (!entry) return false;
  // Duplicated selection keys do not alter every/some semantics. Avoid
  // rebuilding a set for every row on every text keystroke.
  const selected = filter.keys;
  const tagMatch = selected.length === 0 || (filter.mode === "all"
    ? selected.every((key) => entry.keys.has(key))
    : selected.some((key) => entry.keys.has(key)));
  if (!tagMatch) return false;
  if (!filter.yearUnset) return true;
  const state = entry.state;
  if (!state || state.effective.some((tag) => tag.kind === "year")) return false;
  // A deliberate manual unset is known even while metadata is pending. Other
  // pending rows are not silently classified as missing; metadata errors are.
  return state.manual.year.mode === "unset" || state.metadata_status !== "pending";
}
