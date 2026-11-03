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
