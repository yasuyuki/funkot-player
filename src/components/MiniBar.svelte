<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { primaryMode as resolvePrimaryMode, canSkipNext } from "../lib/transportMode";

  interface Props {
    /// Whether the bar is up. Derived in App rather than here because Toast
    /// docks directly on top of this bar and has to know the same answer;
    /// deriving it twice would let the two disagree for a frame.
    show: boolean;
  }

  let { show }: Props = $props();

  let primaryBusy = $state(false);
  let nextBusy = $state(false);

  let phase = $derived(store.player?.phase ?? "idle");
  let paused = $derived(store.player?.paused ?? false);
  let auditioning = $derived(store.player?.auditioning ?? false);

  let mode = $derived(resolvePrimaryMode(phase, paused, auditioning));
  let primaryLabel = $derived(mode === "resume" ? "▶" : "⏸");
  let primaryDisabled = $derived(mode === "off" || primaryBusy || auditioning);
  let nextEnabled = $derived(
    canSkipNext(phase, auditioning, store.queue?.reserved_prepared ?? false),
  );
  let nextDisabled = $derived(!nextEnabled || nextBusy);

  async function onPrimaryClick() {
    if (primaryBusy || mode === "off") return;
    primaryBusy = true;
    try {
      await store.doTogglePause();
    } finally {
      primaryBusy = false;
    }
  }

  async function onNextClick() {
    if (nextBusy || !nextEnabled) return;
    nextBusy = true;
    try {
      await store.doSkipNext();
    } finally {
      nextBusy = false;
    }
  }
</script>

{#if show}
  <!-- In-flow spacer so the fixed bar does not cover the last library rows. -->
  <div class="spacer" aria-hidden="true"></div>
  <div class="minibar" role="toolbar" aria-label="再生コントロール">
    <div class="title">{store.nowTitle ?? ""}</div>
    <button
      type="button"
      class="ctrl"
      class:resume={mode === "resume"}
      disabled={primaryDisabled}
      onclick={onPrimaryClick}
      aria-label={mode === "resume" ? "再開" : "一時停止"}
    >{primaryLabel}</button>
    <button
      type="button"
      class="ctrl next"
      disabled={nextDisabled}
      onclick={onNextClick}
      aria-label="次の曲"
    >⏭</button>
  </div>
{/if}

<style>
  .spacer {
    height: calc(var(--minibar-height) + env(safe-area-inset-bottom, 0px));
  }

  .minibar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    height: calc(var(--minibar-height) + env(safe-area-inset-bottom, 0px));
    padding: var(--space-sm) var(--space-xl)
      calc(var(--space-sm) + env(safe-area-inset-bottom, 0px));
    background: var(--color-minibar-bg);
    border-top: 1px solid var(--color-border);
    box-sizing: border-box;
  }

  .title {
    flex: 1;
    min-width: 0;
    font-size: var(--font-size-md);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ctrl {
    width: auto;
    min-width: 2.8rem;
    padding: var(--space-sm) var(--space-md);
    font-size: var(--font-size-lg);
    background: var(--color-transport-primary-bg);
    color: var(--color-transport-primary-text);
  }

  .ctrl.resume {
    background: var(--color-transport-paused-bg);
    color: var(--color-transport-paused-text);
  }

  .ctrl.next {
    background: var(--color-transport-secondary-bg);
    color: var(--color-transport-secondary-text);
  }

  .ctrl:disabled {
    background: var(--color-transport-disabled-bg);
    color: var(--color-transport-disabled-text);
  }
</style>
