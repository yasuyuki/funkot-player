<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { toast } from "../lib/toast.svelte";
  import { primaryMode as resolvePrimaryMode, canSkipNext } from "../lib/transportMode";
  import { i18n } from "../lib/i18n.svelte";

  let t = $derived(i18n.t);

  let primaryBusy = $state(false);
  let flagBusy = $state(false);

  let phase = $derived(store.player?.phase ?? "idle");
  let paused = $derived(store.player?.paused ?? false);
  let auditioning = $derived(store.player?.auditioning ?? false);

  let mode = $derived(resolvePrimaryMode(phase, paused, auditioning));

  let primaryLabel = $derived(
    mode === "pause" ? t.pause : mode === "resume" ? t.resumePlayback : t.start,
  );

  let primaryDisabled = $derived(
    mode === "off" ||
      primaryBusy ||
      (mode === "start" && !store.canStart),
  );

  let nextEnabled = $derived(
    canSkipNext(phase, auditioning, store.queue),
  );
  let nextDisabled = $derived(!nextEnabled || store.player?.playback_started_frames == null || store.skipNextPending !== null);

  let flagEnabled = $derived(
    (store.player?.last_transition ?? null) !== null && !auditioning,
  );

  async function onFlagClick() {
    if (flagBusy || !flagEnabled) return;
    flagBusy = true;
    try {
      const result = await store.doFlagLastTransition();
      if (result) {
        toast.show(t.flagRecorded(result.from_title, result.to_title), () =>
          store.doUndoLastFlag(),
        );
      }
    } finally {
      flagBusy = false;
    }
  }

  async function onPrimaryClick() {
    if (primaryBusy) return;
    primaryBusy = true;
    try {
      if (mode === "start") {
        await store.doStart();
      } else if (mode === "pause" || mode === "resume") {
        await store.doTogglePause();
      }
    } finally {
      primaryBusy = false;
    }
  }

  async function onNextClick() {
    if (nextDisabled) return;
    await store.doSkipNext();
  }
</script>

<div class="transport">
  <button
    type="button"
    class="primary"
    class:resume={mode === "resume"}
    disabled={primaryDisabled}
    onclick={onPrimaryClick}
  >
    {primaryLabel}
  </button>
  <button type="button" class="secondary" disabled={nextDisabled} onclick={onNextClick}>
    {t.nextTrack}
  </button>
  <button
    type="button"
    class="flag"
    disabled={!flagEnabled || flagBusy}
    aria-label={t.flagBadTransition}
    title={t.flagBadTransition}
    onclick={onFlagClick}
  >⚑</button>
</div>

<style>
  .transport {
    display: flex;
    flex-direction: row;
    gap: var(--space-md);
    align-items: stretch;
  }

  .primary,
  .secondary,
  .flag {
    width: auto;
    min-width: var(--control-target);
  }

  .primary {
    flex: 2;
    background: var(--color-transport-primary-bg);
    color: var(--color-transport-primary-text);
  }
  .primary.resume {
    background: var(--color-transport-paused-bg);
    color: var(--color-transport-paused-text);
  }
  .secondary {
    flex: 1;
    background: var(--color-transport-secondary-bg);
    color: var(--color-transport-secondary-text);
  }
  .secondary:not(:disabled):hover {
    background: var(--color-transport-secondary-text);
    color: var(--color-transport-secondary-bg);
    border-color: var(--color-transport-secondary-text);
  }
  .flag {
    flex: 1;
    background: transparent;
    color: var(--color-flag-amber);
    border: 1px solid var(--color-flag-amber);
  }
  .flag:not(:disabled):hover {
    background: color-mix(in srgb, var(--color-flag-amber) 35%, var(--color-bg));
    color: var(--color-text);
    box-shadow: inset 0 0 0 1px var(--color-flag-amber);
    filter: none;
  }
  .primary:disabled,
  .secondary:disabled {
    background: var(--color-transport-disabled-bg);
    color: var(--color-transport-disabled-text);
  }
  .secondary:disabled {
    cursor: not-allowed;
    opacity: 1;
  }
</style>
