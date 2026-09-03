// Multi-select bookkeeping, shared by the library and the history panes.
//
// Keyed by absolute path in both, even though a history row's own identity is
// (played-at, hash): what gets queued is a path, so keying by path lets the
// same functions and the same bulk add serve both, and picking the same track
// out of three different log rows collapses to one queue entry by itself.
//
// Every function returns a **new** Set rather than mutating: `$state(new Set())`
// does not track mutation of the set's contents, so the components reassign,
// the same way they already do with `busy = { ...busy, [path]: true }`.
//
// Rune-free on purpose — that is what makes it testable under the repo's
// node:test + esbuild harness.

export function toggleSelected(
  selected: ReadonlySet<string>,
  key: string,
): Set<string> {
  const next = new Set(selected);
  if (!next.delete(key)) next.add(key);
  return next;
}

export function addAll(
  selected: ReadonlySet<string>,
  keys: readonly string[],
): Set<string> {
  const next = new Set(selected);
  for (const key of keys) next.add(key);
  return next;
}

export function clearSelection(): Set<string> {
  return new Set();
}

/// Selected keys in `order`'s order, deduplicated.
///
/// Keys absent from `order` are dropped: a track that has left the library
/// cannot be queued, and the history log lists the same path many times.
export function selectedInOrder(
  selected: ReadonlySet<string>,
  order: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of order) {
    if (!selected.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/// State of the select-all control against the rows currently on screen.
///
/// "all" only when there is something to select — an empty list is "none", so
/// the button never offers to deselect nothing.
export function selectAllState(
  selected: ReadonlySet<string>,
  visible: readonly string[],
): "none" | "some" | "all" {
  let hits = 0;
  const counted = new Set<string>();
  for (const key of visible) {
    if (counted.has(key)) continue;
    counted.add(key);
    if (selected.has(key)) hits += 1;
  }
  if (hits === 0) return "none";
  return hits === counted.size ? "all" : "some";
}
