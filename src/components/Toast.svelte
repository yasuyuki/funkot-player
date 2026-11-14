<script lang="ts">
  import { toast } from "../lib/toast.svelte";
  import { i18n } from "../lib/i18n.svelte";

  let t = $derived(i18n.t);
</script>

{#if toast.message !== null}
  <div class="toast" role="status">
    <div class="inner">
      <span class="message">{toast.message}</span>
      {#if toast.undoable}
        <span class="sep">｜</span>
        <button type="button" class="undo quiet" disabled={toast.busy} onclick={() => toast.undo()}>
          {t.undo}
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .toast {
    flex: none;
    display: flex;
    align-items: center;
    padding: var(--space-xs) 0;
    background: var(--color-playback-bar-bg);
    border-top: 1px solid var(--color-border);
    box-sizing: border-box;
    font-size: var(--font-size-sm);
    color: var(--color-text-dim);
  }

  .inner {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    width: 100%;
    padding-inline: var(--shell-pad);
    box-sizing: border-box;
  }
  .message {
    flex: 1;
    overflow-wrap: anywhere;
  }
  .sep {
    flex: none;
    color: var(--color-text-dimmer);
  }
  .undo {
    width: auto;
    flex: none;
    white-space: nowrap;
    text-decoration: underline;
  }
</style>
