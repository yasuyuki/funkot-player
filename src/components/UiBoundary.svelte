<script lang="ts">
  import type { Snippet } from "svelte";
  import { store } from "../lib/state.svelte";
  import { ui } from "../lib/ui.svelte";

  let { children }: { children: Snippet } = $props();

  function onError(error: unknown) {
    store.lastError = error instanceof Error ? error.message : String(error);
    ui.logOpen = true;
  }
</script>

<svelte:boundary onerror={onError}>
  {@render children()}
  {#snippet failed(error, reset)}
    <div class="boundary-failed" role="alert">
      <p>{error instanceof Error ? error.message : String(error)}</p>
      <button type="button" onclick={reset}>再試行</button>
    </div>
  {/snippet}
</svelte:boundary>

<style>
  .boundary-failed {
    margin: var(--space-md) 0;
    color: var(--color-status-failed);
    font-size: var(--font-size-sm);
  }
</style>
