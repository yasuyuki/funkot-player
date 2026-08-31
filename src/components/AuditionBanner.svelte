<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { i18n } from "../lib/i18n.svelte";

  let t = $derived(i18n.t);

  let busy = $state(false);

  let from = $derived(store.player?.audition_from ?? null);
  let to = $derived(store.player?.audition_to ?? null);
  // Same wording as legacy/index.html: raw file names from player_state,
  // not library-resolved titles.
  let label = $derived(from && to ? t.auditioning(from, to) : t.autoplayInterrupted);

  async function onResume() {
    if (busy) return;
    busy = true;
    try {
      await store.doResumeAutodj();
    } finally {
      busy = false;
    }
  }
</script>

<div class="banner">
  <span class="what">{label}</span>
  <span class="sep" aria-hidden="true">｜</span>
  <button type="button" class="resume" disabled={busy} onclick={onResume}>
    {t.resumeAction}
  </button>
</div>

<style>
  .banner {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-sm);
    margin: var(--space-sm) 0 var(--space-md);
    padding: var(--space-md) var(--space-lg);
    background: var(--color-audition-banner-bg);
    border-radius: var(--radius-md);
    font-size: var(--font-size-md);
  }

  .what {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .sep {
    color: var(--color-text-dim);
  }

  .resume {
    width: auto;
    font-size: var(--font-size-md);
    padding: var(--space-sm) var(--space-lg);
    background: var(--color-transport-secondary-bg);
    color: var(--color-transport-secondary-text);
  }

  .resume:disabled {
    background: var(--color-transport-disabled-bg);
    color: var(--color-transport-disabled-text);
  }
</style>
