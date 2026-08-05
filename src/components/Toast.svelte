<script lang="ts">
  import { toast } from "../lib/toast.svelte";
</script>

{#if toast.message !== null}
  <div class="toast">
    <span class="message">{toast.message}</span>
    <span class="sep">｜</span>
    <button type="button" class="undo" disabled={toast.busy} onclick={() => toast.undo()}>
      取消
    </button>
  </div>
{/if}

<style>
  .toast {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    margin-top: var(--space-md);
    font-size: var(--font-size-sm);
    color: var(--color-text-dim);
  }
  .message {
    flex: 1;
    overflow-wrap: anywhere;
  }
  .sep {
    flex: none;
    color: var(--color-text-dimmer);
  }
  /* Overrides tokens.css's default `button` (full width, large padding): 取消
     is an inline text action next to the message, not a standalone control.
     No `transition` here either, for the same tap-must-be-instant reason as
     every other button in this app. */
  .undo {
    width: auto;
    /* Two long titles make the message wrap, and without these the flex row
       squeezes 取消 down to one character per line -- seen on the device. */
    flex: none;
    white-space: nowrap;
    font-size: inherit;
    padding: 0;
    background: transparent;
    color: var(--color-link);
    text-decoration: underline;
    border-radius: 0;
  }
</style>
