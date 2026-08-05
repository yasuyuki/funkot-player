<script lang="ts">
  import { store } from "../lib/state.svelte";

  type PrimaryMode = "start" | "pause" | "resume" | "off";

  // Every command round-trips through the host, and `start`/`toggle_pause`
  // touch the filesystem or the audio thread; without a busy guard a second
  // tap before the first reply lands double-fires (the desktop/legacy
  // equivalent was `withBusy`). Two flags, not one: a tap on 次の曲 must not
  // wait on an in-flight 開始/一時停止 or vice-versa.
  let primaryBusy = $state(false);
  let nextBusy = $state(false);

  let phase = $derived(store.player?.phase ?? "idle");
  let auditioning = $derived(store.player?.auditioning ?? false);

  // Mirrors legacy/index.html's `applyPhase`: idle→開始, playing/stalled→
  // 一時停止, paused→再開; starting/failed/disconnected leave the button off.
  let primaryMode: PrimaryMode = $derived(
    auditioning
      ? "off"
      : phase === "idle"
        ? "start"
        : phase === "playing" || phase === "stalled"
          ? "pause"
          : phase === "paused"
            ? "resume"
            : "off",
  );

  // ⏸ comes out as Android's colour emoji tile (orange, on the green button)
  // while ▶ and ⏭ get the monochrome text glyph. U+FE0E does not override it
  // — tried on the device — so fixing it needs a different glyph or an inline
  // SVG; left for stage 5 rather than spent a build cycle on here.
  let primaryLabel = $derived(
    primaryMode === "start"
      ? "開始"
      : primaryMode === "pause"
        ? "⏸ 一時停止"
        : primaryMode === "resume"
          ? "▶ 再開"
          : "開始",
  );

  // "idle" only, not "failed" as well: `start()` can only fail after it has
  // already flipped its own `started` latch, so offering the button again
  // would just answer "already started". A failed start needs the app
  // restarted, not another tap, so the button stays off rather than looking
  // like it would retry -- see legacy/index.html's `applyPhase` comment,
  // which this rule is carried over from unchanged.
  let primaryDisabled = $derived(primaryMode === "off" || primaryBusy);

  let nextEnabled = $derived(
    !auditioning && (phase === "playing" || phase === "paused" || phase === "stalled"),
  );
  let nextDisabled = $derived(!nextEnabled || nextBusy);

  async function onPrimaryClick() {
    if (primaryBusy) return;
    primaryBusy = true;
    try {
      if (primaryMode === "start") {
        await store.doStart();
      } else if (primaryMode === "pause" || primaryMode === "resume") {
        await store.doTogglePause();
      }
    } finally {
      primaryBusy = false;
    }
  }

  async function onNextClick() {
    if (nextBusy) return;
    nextBusy = true;
    try {
      await store.doSkipNext();
    } finally {
      nextBusy = false;
    }
  }
</script>

<div class="transport">
  <button
    type="button"
    class="primary"
    class:resume={primaryMode === "resume"}
    disabled={primaryDisabled}
    onclick={onPrimaryClick}
  >
    {primaryLabel}
  </button>
  <button type="button" class="secondary" disabled={nextDisabled} onclick={onNextClick}>
    ⏭ 次の曲
  </button>
</div>

<style>
  .transport {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  /* No transition on either button: a tap must show up immediately, not
     after a fade -- see the equivalent comment on the base `button` rule in
     tokens.css, which this deliberately does not override. */
  .primary {
    background: var(--color-transport-primary-bg);
    color: var(--color-transport-primary-text);
  }
  .primary.resume {
    background: var(--color-transport-paused-bg);
    color: var(--color-transport-paused-text);
  }
  .secondary {
    background: var(--color-transport-secondary-bg);
    color: var(--color-transport-secondary-text);
  }
  .primary:disabled,
  .secondary:disabled {
    background: var(--color-transport-disabled-bg);
    color: var(--color-transport-disabled-text);
  }
</style>
