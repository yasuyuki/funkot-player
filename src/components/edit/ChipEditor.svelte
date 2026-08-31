<script lang="ts">
  import { i18n } from "../../lib/i18n.svelte";

  /// Shared intro/outro step set (legacy INTRO_STEPS / OUTRO_STEPS).
  const STEPS = [16, 32, 48, 64, 80];

  interface Props {
    kind: "intro" | "outro";
    current: number | null;
    manual: boolean;
    /// Called with the newly picked bar count. Parent runs `set_bars`.
    onPick: (value: number) => Promise<void>;
  }

  let { kind, current, manual, onPick }: Props = $props();

  let busy = $state(false);

  let cur = $derived(
    current === null || current === undefined ? null : Number(current),
  );

  /// Current value is included even when it is outside the default steps
  /// (legacy `chipValues`).
  let values = $derived.by(() => {
    const set = new Set(STEPS);
    if (cur !== null) set.add(cur);
    return Array.from(set).sort((a, b) => a - b);
  });

  let t = $derived(i18n.t);
  let title = $derived(kind === "intro" ? t.intro : t.outro);
  let hint = $derived(kind === "outro" ? t.outroHint : t.introHint);

  async function pick(v: number) {
    // Re-tapping the current chip is a no-op (legacy).
    if (cur === v || busy) return;
    busy = true;
    try {
      await onPick(v);
    } finally {
      busy = false;
    }
  }
</script>

<div class="chip-editor">
  <h3 class="title">{title}</h3>
  <div class="scale">{t.chipScale}</div>
  <div class="row">
    {#each values as v (v)}
      <button
        type="button"
        class="chip"
        class:current={cur === v}
        disabled={busy}
        onclick={() => pick(v)}
      >{v}{cur === v && manual ? "*" : ""}</button>
    {/each}
  </div>
  <p class="hint">{hint}</p>
</div>

<style>
  .chip-editor {
    margin: var(--space-sm) 0 var(--space-lg);
  }

  .title {
    margin: 0 0 var(--space-xs);
    font-size: var(--font-size-md);
    font-weight: 600;
  }

  .scale {
    font-size: var(--font-size-sm);
    color: var(--color-text-dimmer);
    margin: 0 0 var(--space-sm);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
  }

  .chip {
    width: auto;
    font-size: var(--font-size-md);
    padding: var(--space-xs) var(--space-md);
    background: var(--color-tab-bg);
    color: var(--color-text);
  }

  .chip.current {
    background: var(--color-chip-current-bg);
    color: var(--color-chip-current-text);
  }

  .chip:disabled {
    background: var(--color-transport-disabled-bg);
    color: var(--color-transport-disabled-text);
  }

  .hint {
    font-size: var(--font-size-sm);
    color: var(--color-text-dim);
    margin: var(--space-sm) 0 0;
  }
</style>
