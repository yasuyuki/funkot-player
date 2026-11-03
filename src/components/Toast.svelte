<script lang="ts">
  import { toast } from "../lib/toast.svelte";
  import { i18n } from "../lib/i18n.svelte";

  interface Props {
    raised: boolean;
  }

  let { raised }: Props = $props();

  let t = $derived(i18n.t);
  let toastElement = $state<HTMLDivElement | null>(null);
  $effect(() => {
    const el = toastElement;
    const update = () => document.documentElement.style.setProperty("--toast-height", `${el?.getBoundingClientRect().height ?? 0}px`);
    update();
    if (!el) return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => { observer.disconnect(); document.documentElement.style.setProperty("--toast-height", "0px"); };
  });
</script>

{#if toast.message !== null}
  <div class="toast" class:raised bind:this={toastElement} role="status">
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
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 21;
    display: flex;
    align-items: center;
    padding: var(--space-md) 0 calc(var(--space-md) + env(safe-area-inset-bottom, 0px));
    background: var(--color-minibar-bg);
    border-top: 1px solid var(--color-border);
    box-sizing: border-box;
    font-size: var(--font-size-sm);
    color: var(--color-text-dim);
  }

  .toast.raised {
    bottom: calc(var(--minibar-height) + env(safe-area-inset-bottom, 0px));
    padding-bottom: var(--space-md);
  }

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
  .undo {
    width: auto;
    flex: none;
    white-space: nowrap;
    text-decoration: underline;
  }
</style>
