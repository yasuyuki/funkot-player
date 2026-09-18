import type { EffectiveTag, Tag, TagPatch, TagTarget, TrackRow, TrackTagsSnapshot, TagYear, TrackTagState } from "./tauri";

export function tagEditSelection(visibleRows: readonly TrackRow[], selected: ReadonlySet<string>): TrackRow[] {
  return visibleRows.filter(row => selected.has(row.path));
}

export function enqueueSelection(orderedLibrary: readonly TrackRow[], selected: ReadonlySet<string>, allowNonFunkot: boolean): string[] {
  return orderedLibrary.filter(row => selected.has(row.path) && (allowNonFunkot || !row.analyzed || row.is_funkot)).map(row => row.path);
}

export function tagTargets(rows: readonly TrackRow[], snapshot: TrackTagsSnapshot): TagTarget[] {
  return rows.flatMap((row) => {
    const state = snapshot.tracks[row.path];
    return state?.content_hash && row.content_hash === state.content_hash
      ? [{ path: row.path, expected_hash: state.content_hash }] : [];
  });
}

export function tagPatch(year: TagYear | undefined, add: readonly Tag[], remove: readonly Tag[]): TagPatch {
  const patch: TagPatch = {};
  if (year) patch.year_change = year;
  if (add.length) patch.add = [...add];
  if (remove.length) patch.remove = [...remove];
  return patch;
}

export function sameTag(a: Tag, b: Tag): boolean {
  return a.kind === b.kind && a.value === b.value;
}

export function summarizeTags(states: readonly TrackTagState[]): { tag: EffectiveTag; count: number }[] {
  const tags = new Map<string, { tag: EffectiveTag; count: number }>();
  for (const state of states) {
    const seen = new Set<string>();
    for (const tag of state.effective) {
      if (tag.kind === "year" || seen.has(tag.key)) continue;
      seen.add(tag.key);
      const item = tags.get(tag.key);
      if (item) {
        item.count += 1;
        if (item.tag.origin !== tag.origin) item.tag.origin = "both";
      } else tags.set(tag.key, { tag: { ...tag }, count: 1 });
    }
  }
  return [...tags.values()].sort((a, b) => a.tag.key.localeCompare(b.tag.key));
}
