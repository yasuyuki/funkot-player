<script lang="ts">
  import { store } from "../../lib/state.svelte";
  import { ui } from "../../lib/ui.svelte";
  import { toast } from "../../lib/toast.svelte";
  import type { FlaggedTrackRow } from "../../lib/tauri";

  let busyKey = $state<string | null>(null);

  let rows = $derived(store.flaggedRows);

  function roleLabel(role: string): string {
    return role === "outgoing" ? "出る側" : "入る側";
  }

  function openDetail(row: FlaggedTrackRow) {
    ui.openFlaggedDetail(row.track_hash, row.role);
  }

  function seeAll() {
    ui.setEditSub("all");
  }

  async function dismiss(row: FlaggedTrackRow) {
    const key = `${row.track_hash}\t${row.role}`;
    if (busyKey === key) return;
    busyKey = key;
    try {
      const n = await store.doDismissFlags(row.track_hash, row.role);
      // Legacy: toast only when dismiss actually recorded a new key (`n` truthy).
      if (n) {
        toast.show("削除しました", () => store.doUndoLastDismiss());
      }
    } finally {
      busyKey = null;
    }
  }
</script>

{#if rows.length === 0}
  <p class="empty">直すべきつなぎはありません</p>
  <button type="button" class="linkish" onclick={seeAll}>すべての曲を見る</button>
{:else}
  <ul class="list">
    {#each rows as row (`${row.track_hash}:${row.role}`)}
      <li class="row">
        {#if row.missing}
          <button type="button" class="head" disabled>
            <span class="title">{row.title}</span>
            {#if row.artist}<span class="artist">{row.artist}</span>{/if}
            <span class="role">{roleLabel(row.role)}</span>
            <span class="count">{row.count}</span>
          </button>
          <button
            type="button"
            class="ok"
            disabled={busyKey === `${row.track_hash}\t${row.role}`}
            onclick={() => dismiss(row)}
          >〔外す〕</button>
        {:else if !row.analyzed}
          <button type="button" class="head" disabled>
            <span class="title">{row.title}</span>
            {#if row.artist}<span class="artist">{row.artist}</span>{/if}
            <span class="role">{roleLabel(row.role)}</span>
            <span class="count">{row.count}</span>
            {#if row.low_confidence}<span class="warn">⚠</span>{/if}
            <span class="unanalyzed">未解析</span>
          </button>
        {:else}
          <button type="button" class="head" onclick={() => openDetail(row)}>
            <span class="title">{row.title}</span>
            {#if row.artist}<span class="artist">{row.artist}</span>{/if}
            <span class="role">{roleLabel(row.role)}</span>
            <span class="count">{row.count}</span>
            {#if row.low_confidence}<span class="warn">⚠</span>{/if}
          </button>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .empty {
    color: var(--color-text-dim);
    margin: var(--space-lg) 0 var(--space-sm);
  }

  .linkish {
    width: auto;
    font-size: inherit;
    padding: 0;
    background: transparent;
    color: var(--color-link);
    text-decoration: underline;
    border-radius: 0;
  }

  .list {
    list-style: none;
    margin: var(--space-md) 0 0;
    padding: 0;
  }

  .row {
    display: flex;
    align-items: baseline;
    gap: var(--space-sm);
    border-bottom: 1px solid var(--color-border);
  }

  .head {
    flex: 1;
    text-align: left;
    background: transparent;
    color: var(--color-text);
    font-size: var(--font-size-md);
    padding: var(--space-md) var(--space-xs);
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm) var(--space-md);
    align-items: baseline;
    border-radius: 0;
  }

  .head:disabled {
    opacity: 0.55;
  }

  .title {
    font-weight: 500;
  }

  .artist {
    color: var(--color-text-dim);
    font-size: var(--font-size-sm);
  }

  .role {
    color: var(--color-text-dimmer);
    font-size: var(--font-size-sm);
  }

  .count {
    margin-left: auto;
  }

  .warn {
    color: var(--color-flagged-warn);
  }

  .unanalyzed {
    color: var(--color-text-dim);
    font-size: var(--font-size-sm);
  }

  .ok {
    width: auto;
    flex: 0 0 auto;
    font-size: var(--font-size-sm);
    padding: var(--space-sm) var(--space-md);
    background: var(--color-tab-bg);
    color: var(--color-text);
  }

  .ok:disabled {
    background: var(--color-transport-disabled-bg);
    color: var(--color-transport-disabled-text);
  }
</style>
