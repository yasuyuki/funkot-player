<script lang="ts">
  import { toast } from "../lib/toast.svelte";
  import { i18n } from "../lib/i18n.svelte";

  interface Props {
    /// True while MiniBar is up, so the toast sits on top of it instead of
    /// on the bottom edge. App derives it once and hands it to both.
    raised: boolean;
  }

  let { raised }: Props = $props();

  let t = $derived(i18n.t);
</script>

{#if toast.message !== null}
  <div class="toast" class:raised>
    <div class="inner">
      <span class="message">{toast.message}</span>
      {#if toast.undoable}
        <span class="sep">｜</span>
        <button type="button" class="undo" disabled={toast.busy} onclick={() => toast.undo()}>
          {t.undo}
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Docked to the bottom edge rather than left in the flow under the
     transport. Every message here is the result of something the user just
     did, and the two places they are most likely to be looking -- the
     library list and the edit tabs -- are scrolled far below that spot, so
     an in-flow toast auto-dismissed off-screen. It also puts undo within
     thumb reach. Deliberately NOT where the scan/analysis progress lines
     live (Library.svelte): those belong next to the rows they describe, and
     analysis keeps running in the background, so sharing this one slot
     would let an 8-second toast bury a minutes-long progress readout. */
  .toast {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    /* Above MiniBar's 20: the two stack rather than overlap, but a fraction
       of a pixel of rounding must not tuck the toast under its border. */
    z-index: 21;
    display: flex;
    align-items: center;
    padding: var(--space-md) 0 calc(var(--space-md) + env(safe-area-inset-bottom, 0px));
    /* Same fill and top rule as MiniBar: when both are up they read as one
       two-row dock rather than two competing bars. */
    background: var(--color-minibar-bg);
    border-top: 1px solid var(--color-border);
    box-sizing: border-box;
    font-size: var(--font-size-sm);
    color: var(--color-text-dim);
  }

  /* Exactly MiniBar's own height calc -- keep the two in step. MiniBar
     already carries the safe-area inset in that height, so the toast drops
     its own padding for it here. */
  .toast.raised {
    bottom: calc(var(--minibar-height) + env(safe-area-inset-bottom, 0px));
    padding-bottom: var(--space-md);
  }

  /* Same two layers as MiniBar (see its .inner): fill edge to edge, content on
     #app's shell, so a toast sitting on the bar shares its left and right
     edges instead of running the full width of a wide window. */
  .inner {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    width: 100%;
    max-width: calc(var(--shell-max-width) + 2 * var(--space-xl));
    margin-inline: auto;
    padding-inline: var(--space-xl);
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
  /* Overrides tokens.css's default `button` (full width, large padding): undo
     is an inline text action next to the message, not a standalone control.
     No `transition` here either, for the same tap-must-be-instant reason as
     every other button in this app. */
  .undo {
    width: auto;
    /* Two long titles make the message wrap, and without these the flex row
       squeezes undo down to one character per line -- seen on the device. */
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
