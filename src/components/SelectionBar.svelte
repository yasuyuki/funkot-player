<script lang="ts">
  // The second line of a pane's toolbar while multi-select is on: how many are
  // ticked, select-all / clear, and the bulk add.
  //
  // Takes props only -- no store access -- so the library and the history pane
  // can both use it without either one's ordering or filtering rules leaking
  // in here.
  import { i18n } from "../lib/i18n.svelte";

  let {
    totalSelected,
    enqueueCount,
    visibleTagCount,
    tagUnavailable = false,
    count,
    allState,
    busy = false,
    onSelectAll,
    onClear,
    onAdd,
    onEditTags,
  }: {
    totalSelected?: number;
    enqueueCount?: number;
    visibleTagCount?: number;
    tagUnavailable?: boolean;
    count?: number;
    allState: "none" | "some" | "all";
    busy?: boolean;
    onSelectAll: () => void;
    onClear: () => void;
    onAdd: () => void;
    onEditTags?: (event: MouseEvent) => void;
  } = $props();

  let t = $derived(i18n.t);
  let selectedTotal = $derived(totalSelected ?? count ?? 0);
  let queuedTotal = $derived(enqueueCount ?? selectedTotal);
  let editableTotal = $derived(visibleTagCount ?? selectedTotal);
</script>

<div class="bar">
  <span class="count">{t.selectedCount(selectedTotal)}</span>
  <button
    type="button"
    class="mini"
    disabled={busy || allState === "all"}
    onclick={onSelectAll}
  >{t.selectAll}</button>
  <button
    type="button"
    class="mini"
    disabled={busy || selectedTotal === 0}
    onclick={onClear}
  >{t.selectNone}</button>
  <button
    type="button"
    class="add"
    disabled={busy || queuedTotal === 0}
    onclick={onAdd}
  >{onEditTags ? t.tagEnqueueCount(queuedTotal) : t.addSelected}</button>
  {#if onEditTags}
    <button type="button" class="mini" disabled={busy || editableTotal === 0 || tagUnavailable}
      title={tagUnavailable ? t.tagIdentityUnavailable : undefined} onclick={onEditTags}>{t.tagEditCount(editableTotal)}</button>
    {#if tagUnavailable}<span class="unavailable">{t.tagIdentityUnavailable}</span>{/if}
  {/if}
</div>

<style>
  /* Wraps as the toolbar's second line rather than sticking on its own: the
     toolbar's `top` is a hand-computed safe-area calc, and a second sticky
     element would need a second, height-dependent copy of it. */
  .bar {
    display: flex;
    flex-wrap: wrap;
    flex: 1 0 100%;
    align-items: center;
    gap: var(--space-sm);
  }

  .count {
    flex: 1;
    min-width: 0;
    font-size: var(--font-size-sm);
    color: var(--color-text-dim);
  }
  .unavailable { flex-basis: 100%; font-size: var(--font-size-sm); color: var(--color-text-dim); }

  /* `width: auto` on every button here: the global rule in tokens.css makes a
     bare button full-width. */
  .mini,
  .add {
    width: auto;
    flex: 0 0 auto;
    font-size: var(--font-size-sm);
    padding: var(--space-sm) var(--space-md);
  }

  .mini {
    background: var(--color-transport-secondary-bg);
    color: var(--color-transport-secondary-text);
  }

  .add {
    background: var(--color-accent-bg);
    color: var(--color-accent-text);
  }

  .mini:disabled,
  .add:disabled {
    opacity: 0.5;
  }
</style>
