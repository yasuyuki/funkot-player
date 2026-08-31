<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { i18n } from "../lib/i18n.svelte";

  let t = $derived(i18n.t);

  // Internal re-entry guard only — the button is never `disabled`. Queuing an
  // unanalysed arrival can stall playback (loader may analyse synchronously);
  // kick-less paths (quiet reload / after clearing history) do not start
  // background analysis.
  let busy = $state(false);

  let count = $derived(store.actionableNewArrivalCount);

  async function onQueue() {
    if (busy) return;
    busy = true;
    try {
      await store.doQueueNewArrivals();
    } finally {
      busy = false;
    }
  }
</script>

{#if count > 0}
  <div class="banner">
    <button type="button" class="action" onclick={onQueue}>
      {t.queueNewArrivals(count)}
    </button>
  </div>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-sm);
    margin: 0 0 var(--space-md);
    padding: var(--space-md) var(--space-lg);
    background: var(--color-menu-bg);
    border-radius: var(--radius-md);
    font-size: var(--font-size-md);
  }

  .action {
    width: auto;
    font-size: var(--font-size-md);
    padding: var(--space-sm) var(--space-lg);
    background: var(--color-transport-secondary-bg);
    color: var(--color-transport-secondary-text);
  }
</style>
