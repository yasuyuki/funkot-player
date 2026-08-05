<script lang="ts">
  import { store } from "../lib/state.svelte";

  interface Props {
    /// True while the transport sentinel is intersecting the viewport.
    /// MiniBar only shows when this is false *and* playback is active.
    transportVisible: boolean;
  }

  let { transportVisible }: Props = $props();

  let primaryBusy = $state(false);
  let nextBusy = $state(false);

  let phase = $derived(store.player?.phase ?? "idle");
  let auditioning = $derived(store.player?.auditioning ?? false);

  // No start mode here: idle/starting/failed/disconnected keep the bar
  // hidden. Pause/resume/skip enablement matches Transport otherwise.
  let active = $derived(
    !auditioning && (phase === "playing" || phase === "paused" || phase === "stalled"),
  );
  let show = $derived(!transportVisible && active);

  let primaryMode = $derived(
    phase === "paused" ? "resume" : phase === "playing" || phase === "stalled" ? "pause" : "off",
  );
  let primaryLabel = $derived(primaryMode === "resume" ? "▶" : "⏸");
  let primaryDisabled = $derived(primaryMode === "off" || primaryBusy || auditioning);
  let nextDisabled = $derived(!active || nextBusy);

  async function onPrimaryClick() {
    if (primaryBusy || primaryMode === "off") return;
    primaryBusy = true;
    try {
      await store.doTogglePause();
    } finally {
      primaryBusy = false;
    }
  }

  async function onNextClick() {
    if (nextBusy || !active) return;
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
      class:resume={primaryMode === "resume"}
      disabled={primaryDisabled}
      onclick={onPrimaryClick}
      aria-label={primaryMode === "resume" ? "再開" : "一時停止"}
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
