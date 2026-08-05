<script lang="ts">
  import { store } from "../../lib/state.svelte";
  import { toast } from "../../lib/toast.svelte";
  import ChipEditor from "./ChipEditor.svelte";
  import type { TrackRow } from "../../lib/tauri";

  /// At most one inline chip editor: `"path\\tintro|outro"` (legacy `openChipKey`).
  let openChipKey = $state<string | null>(null);
  let busy = $state(false);

  let rows = $derived(store.libraryList);

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

  async function onChipPick(path: string, kind: "intro" | "outro", value: number) {
    const row = chipRow(path);
    if (!row) return;
    const prevIntro = row.intro_bars;
    const prevOutro = row.outro_structure_bars;
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
      );
      return restored !== null;
    });
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
</script>

<div class="wrap">
  <table class="table">
    <thead>
      <tr>
        <th>track</th>
        <th>intro</th>
        <th>outro</th>
        <th>mix</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.path)}
        <tr>
          <td class="name">{row.name}</td>
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
              disabled={busy}
              onclick={() => onAdd(row.path)}
            >+</button>
          </td>
        </tr>
        {#if openKind(row.path)}
          {@const kind = openKind(row.path)}
          {@const live = chipRow(row.path)}
          {#if kind && live}
            <tr class="chip-row">
              <td colspan="5">
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

  .name {
    max-width: 10rem;
    overflow: hidden;
    text-overflow: ellipsis;
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
