<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { primaryMode as resolvePrimaryMode, canSkipNext } from "../lib/transportMode";
  import { i18n } from "../lib/i18n.svelte";

  interface Props {
    /// Whether the bar is up. Derived in App rather than here because Toast
    /// docks directly on top of this bar and has to know the same answer;
    /// deriving it twice would let the two disagree for a frame.
    show: boolean;
  }

  let { show }: Props = $props();

  let t = $derived(i18n.t);

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
  <div class="minibar" role="toolbar" aria-label={t.playbackControlsLabel}>
    <div class="inner">
      <div class="title">{store.nowTitle ?? ""}</div>
      <button
        type="button"
        class="ctrl"
        class:resume={mode === "resume"}
        disabled={primaryDisabled}
        onclick={onPrimaryClick}
        aria-label={mode === "resume" ? t.resumeLabel : t.pauseLabel}
      >{primaryLabel}</button>
      <button
        type="button"
        class="ctrl next"
        disabled={nextDisabled}
        onclick={onNextClick}
        aria-label={t.nextTrackLabel}
      >⏭</button>
    </div>
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
    height: calc(var(--minibar-height) + env(safe-area-inset-bottom, 0px));
    padding: var(--space-sm) 0 calc(var(--space-sm) + env(safe-area-inset-bottom, 0px));
    background: var(--color-minibar-bg);
    border-top: 1px solid var(--color-border);
    box-sizing: border-box;
  }

  /* Two layers: the fill runs edge to edge (it is the bottom of the window),
     the content lines up with #app's shell so the title and the controls do
     not drift to opposite corners on a wide window. The extra --space-xl per
     side is body's padding, which puts this content box exactly on the
     shell's rather than 1rem inside it. Below the cap only the padding is
     left, which is what the bar had before. */
  .inner {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    width: 100%;
    max-width: calc(var(--shell-max-width) + 2 * var(--space-xl));
    margin-inline: auto;
    padding-inline: var(--space-xl);
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
