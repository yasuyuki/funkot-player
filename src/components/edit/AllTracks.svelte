<script lang="ts">
  import { store } from "../../lib/state.svelte";
  import { toast } from "../../lib/toast.svelte";
  import ChipEditor from "./ChipEditor.svelte";
  import type { TrackRow } from "../../lib/tauri";

  /// At most one inline chip editor: `"path\\tintro|outro"` (legacy `openChipKey`).
  let openChipKey = $state<string | null>(null);
  let busy = $state(false);

  let rows = $derived(store.libraryList);
  let labelingPath = $derived(store.labelingPath);

  type FolderGroup = {
    key: string;
    title: string;
    absDir: string;
    tracks: TrackRow[];
  };

  /// First path segment of `relName` (`/`-normalized). Root files → `""`.
  function topSegment(rel: string): string {
    const i = rel.indexOf("/");
    if (i < 0) return "";
    return rel.slice(0, i);
  }

  function folderAbsDir(firstPath: string, segment: string): string {
    const musicDir = store.dirs?.music_dir;
    if (!musicDir) return "";
    if (!segment) return musicDir;
    const after = firstPath.slice(musicDir.length);
    const sep = after.startsWith("\\") ? "\\" : "/";
    return `${musicDir}${sep}${segment}`;
  }

  function rootHeading(): string {
    const md = store.dirs?.music_dir;
    if (!md) return "（ルート）";
    return store.pathBasename(md) || "（ルート）";
  }

  let groups = $derived.by(() => {
    const out: FolderGroup[] = [];
    let current: FolderGroup | null = null;
    for (const row of rows) {
      const seg = topSegment(store.relName(row.path));
      if (!current || current.key !== seg) {
        current = {
          key: seg,
          title: seg || rootHeading(),
          absDir: folderAbsDir(row.path, seg),
          tracks: [],
        };
        out.push(current);
      }
      current.tracks.push(row);
    }
    return out;
  });

  function cellMark(manual: boolean, low: boolean): string {
    if (manual) return "*";
    if (low) return "!";
    return "";
  }

  function toggleChip(path: string, kind: "intro" | "outro") {
    const key = `${path}\t${kind}`;
    if (openChipKey === key) {
      openChipKey = null;
      return;
    }
    const row = store.libraryList.find((r) => r.path === path);
    if (!row || !row.analyzed) return;
    openChipKey = key;
  }

  function openKind(path: string): "intro" | "outro" | null {
    if (!openChipKey || !openChipKey.startsWith(`${path}\t`)) return null;
    const kind = openChipKey.slice(path.length + 1);
    return kind === "intro" || kind === "outro" ? kind : null;
  }

  function chipRow(path: string): TrackRow | null {
    return store.libraryList.find((r) => r.path === path) ?? null;
  }

  function labelText(row: TrackRow): string {
    if (row.label === true) return "Funkot";
    if (row.label === false) return "非Funkot";
    return "—";
  }

  async function onChipPick(path: string, kind: "intro" | "outro", value: number) {
    const row = chipRow(path);
    if (!row) return;
    const prevIntro = row.intro_bars;
    const prevOutro = row.outro_structure_bars;
    const prevManual =
      kind === "intro" ? row.intro_manual : row.outro_manual;
    const updated = await store.doSetBars(
      path,
      kind === "intro" ? value : null,
      kind === "outro" ? value : null,
    );
    if (!updated) return;
    // Re-open the same editor on the refreshed row (legacy).
    openChipKey = `${path}\t${kind}`;
    toast.show("変更しました", async () => {
      const restored = await store.doSetBars(
        path,
        kind === "intro" ? prevIntro : null,
        kind === "outro" ? prevOutro : null,
        prevManual,
      );
      return restored !== null;
    });
  }

  async function onToggleLabel(row: TrackRow) {
    if (busy) return;
    busy = true;
    const prevLabel = row.label;
    const next = !(row.label ?? row.is_funkot);
    try {
      const updated = await store.doSetLabel(row.path, next);
      if (!updated) return;
      toast.show(next ? "Funkot に登録" : "非Funkot に登録", async () => {
        const restored = await store.doSetLabel(row.path, prevLabel);
        return restored !== null;
      });
    } finally {
      busy = false;
    }
  }

  async function onFolderLabel(
    absDir: string,
    verdict: boolean,
    tracks: TrackRow[],
    rootOnly: boolean,
  ) {
    if (busy || (!rootOnly && !absDir)) return;
    busy = true;
    const prev = tracks.map((t) => ({
      path: t.path,
      label: t.label,
      is_funkot: t.is_funkot,
    }));
    try {
      // Root heading is music_dir; `set_folder_label` would recurse the
      // whole library. Label only the root-level files already in this group.
      let n: number | null;
      if (rootOnly) {
        const results = await Promise.all(
          tracks.map((t) => store.doSetLabel(t.path, verdict)),
        );
        n = results.every((r) => r !== null) ? tracks.length : null;
      } else {
        n = await store.doSetFolderLabel(absDir, verdict);
      }
      if (n === null) return;
      const word = verdict ? "Funkot" : "非Funkot";
      toast.show(`${n}曲を ${word} に登録`, async () => {
        for (const p of prev) {
          const ok = await store.doSetLabel(p.path, p.label);
          if (!ok) return false;
        }
        return true;
      });
    } finally {
      busy = false;
    }
  }

  async function onAdd(path: string) {
    if (busy) return;
    busy = true;
    try {
      await store.doEnqueue(path);
    } finally {
      busy = false;
    }
  }

  function isNonFunkot(row: TrackRow): boolean {
    return row.analyzed && !row.is_funkot;
  }

  function addDisabled(row: TrackRow): boolean {
    return busy || (isNonFunkot(row) && !store.allowNonFunkot);
  }
</script>

<div class="wrap">
  <table class="table">
    <thead>
      <tr>
        <th>track</th>
        <th>ラベル</th>
        <th>intro</th>
        <th>outro</th>
        <th>mix</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      {#each groups as group (group.key + "\0" + group.absDir)}
        <tr class="folder-row">
          <td class="folder-name" colspan="1">{group.title}</td>
          <td class="folder-acts" colspan="5">
            <button
              type="button"
              class="folder-btn"
              disabled={busy || (group.key !== "" && !group.absDir)}
              onclick={() =>
                onFolderLabel(group.absDir, true, group.tracks, group.key === "")}
            >Funkot</button>
            <button
              type="button"
              class="folder-btn"
              disabled={busy || (group.key !== "" && !group.absDir)}
              onclick={() =>
                onFolderLabel(group.absDir, false, group.tracks, group.key === "")}
            >非Funkot</button>
          </td>
        </tr>
        {#each group.tracks as row (row.path)}
          <tr
            class:non-funkot={isNonFunkot(row)}
            class:current={row.path === labelingPath}
          >
            <td class="name">
              {#if row.played_at_ms != null}
                <span class="played">✓</span>
              {/if}
              {store.relName(row.path)}
            </td>
            <td class="label-cell">
              <button
                type="button"
                class="label-btn"
                disabled={busy}
                onclick={() => onToggleLabel(row)}
              >{labelText(row)}</button>
            </td>
            <td>
              {#if row.intro_bars === null}
                -
              {:else}
                <button
                  type="button"
                  class="bars"
                  class:low={row.intro_low_confidence && !row.intro_manual}
                  onclick={() => toggleChip(row.path, "intro")}
                >{row.intro_bars}{cellMark(row.intro_manual, row.intro_low_confidence)}</button>
              {/if}
            </td>
            <td>
              {#if row.outro_structure_bars === null}
                -
              {:else}
                <button
                  type="button"
                  class="bars"
                  class:low={row.outro_low_confidence && !row.outro_manual}
                  onclick={() => toggleChip(row.path, "outro")}
                >{row.outro_structure_bars}{cellMark(row.outro_manual, row.outro_low_confidence)}</button>
              {/if}
            </td>
            <td class="mix">{row.outro_bars ?? ""}</td>
            <td class="act">
              <button
                type="button"
                class="add"
                disabled={addDisabled(row)}
                onclick={() => onAdd(row.path)}
              >+</button>
            </td>
          </tr>
          {#if openKind(row.path)}
            {@const kind = openKind(row.path)}
            {@const live = chipRow(row.path)}
            {#if kind && live}
              <tr class="chip-row">
                <td colspan="6">
                  <ChipEditor
                    {kind}
                    current={kind === "intro" ? live.intro_bars : live.outro_structure_bars}
                    manual={kind === "intro" ? live.intro_manual : live.outro_manual}
                    onPick={(v) => onChipPick(row.path, kind, v)}
                  />
                </td>
              </tr>
            {/if}
          {/if}
        {/each}
      {/each}
    </tbody>
  </table>
</div>

<style>
  .wrap {
    margin-top: var(--space-md);
    overflow-x: auto;
  }

  .table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--font-size-sm);
  }

  th,
  td {
    text-align: left;
    padding: var(--space-xs) var(--space-sm);
    border-bottom: 1px solid var(--color-border);
    vertical-align: middle;
  }

  th {
    color: var(--color-text-dim);
    font-weight: 600;
  }

  tr.non-funkot {
    opacity: 0.45;
    color: var(--color-text-dim);
  }

  tr.current {
    background: var(--color-queue-reserved-bg);
  }

  .folder-row td {
    background: var(--color-tab-bg);
    border-bottom: 1px solid var(--color-border);
    padding-top: var(--space-sm);
    padding-bottom: var(--space-sm);
  }

  .folder-name {
    font-weight: 600;
    color: var(--color-text);
    max-width: 10rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .folder-acts {
    white-space: nowrap;
  }

  .folder-btn,
  .label-btn {
    width: auto;
    min-width: 0;
    font-size: var(--font-size-sm);
    padding: var(--space-xs) var(--space-sm);
    background: var(--color-tab-bg);
    color: var(--color-text);
  }

  .folder-btn + .folder-btn {
    margin-left: var(--space-xs);
  }

  .folder-btn:disabled,
  .label-btn:disabled {
    background: var(--color-transport-disabled-bg);
    color: var(--color-transport-disabled-text);
  }

  .name {
    max-width: 10rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .played {
    color: var(--color-text-dim);
    margin-right: 0.25em;
  }

  .label-cell {
    width: 1%;
    white-space: nowrap;
  }

  .mix {
    color: var(--color-text-dimmer);
    width: 1%;
  }

  .act {
    width: 1%;
  }

  .bars,
  .add {
    width: auto;
    min-width: 3.2rem;
    font-size: var(--font-size-md);
    padding: var(--space-xs) var(--space-md);
    background: var(--color-tab-bg);
    color: var(--color-text);
  }

  .bars.low {
    color: var(--color-flagged-warn);
  }

  .add:disabled,
  .bars:disabled {
    background: var(--color-transport-disabled-bg);
    color: var(--color-transport-disabled-text);
  }

  .chip-row td {
    padding: var(--space-xs) var(--space-sm) var(--space-md);
  }
</style>
