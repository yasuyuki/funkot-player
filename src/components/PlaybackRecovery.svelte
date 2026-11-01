<script lang="ts">
  import { i18n } from "../lib/i18n.svelte";
  import { store } from "../lib/state.svelte";
  import type { PlaybackRecoveryChoice } from "../lib/tauri";

  let t = $derived(i18n.t);
  let status = $derived(store.playbackRecovery);
  let conflict = $derived(
    status?.kind === "legacy_normal_conflict" ? status : null,
  );
  let dialog = $state<HTMLDialogElement | null>(null);
  let opener = $state<HTMLButtonElement | null>(null);
  let reviewOpen = $state(false);
  let busy = $state(false);
  let failed = $state(false);

  $effect(() => {
    if (!reviewOpen || !conflict) return;
    queueMicrotask(() => {
      if (dialog && !dialog.open) dialog.showModal();
      dialog?.querySelector<HTMLButtonElement>("button[data-choice]")?.focus();
    });
  });

  function dismiss(): void {
    if (dialog?.open) dialog.close();
    reviewOpen = false;
    failed = false;
    queueMicrotask(() => opener?.focus({ preventScroll: true }));
  }

  async function choose(choice: PlaybackRecoveryChoice): Promise<void> {
    if (busy || !conflict) return;
    busy = true;
    failed = false;
    const resolved = await store.resolvePlaybackRecovery(choice);
    busy = false;
    if (resolved) dismiss();
    else failed = true;
  }
</script>

{#if conflict}
  <section class="recovery-card" aria-labelledby="playback-recovery-title">
    <div>
      <h2 id="playback-recovery-title">{t.playbackRecoveryTitle}</h2>
      <p>{t.playbackRecoverySummary}</p>
    </div>
    <button
      type="button"
      class="primary"
      bind:this={opener}
      onclick={() => { reviewOpen = true; failed = false; }}
    >{t.playbackRecoveryReview}</button>
  </section>

  {#if reviewOpen}
    <dialog
      bind:this={dialog}
      class="recovery-dialog"
      aria-label={t.playbackRecoveryDialog}
      oncancel={(event) => { event.preventDefault(); if (!busy) dismiss(); }}
    >
      <h2>{t.playbackRecoveryDialog}</h2>
      <p>{t.playbackRecoveryExplain}</p>
      <div class="choices">
        <button
          type="button"
          class="choice"
          data-choice="queue_file"
          disabled={busy}
          onclick={() => void choose("queue_file")}
        >{t.playbackRecoveryQueueFile(conflict.queue_file_items)}</button>
        <button
          type="button"
          class="choice"
          data-choice="catalog_normal"
          disabled={busy}
          onclick={() => void choose("catalog_normal")}
        >{t.playbackRecoveryCatalogNormal(conflict.catalog_normal_items)}</button>
      </div>
      <p class="preserved">{t.playbackRecoveryPreserved}</p>
      {#if failed}<p class="failure" role="alert">{t.playbackRecoveryFailed}</p>{/if}
      <div class="actions">
        <button type="button" class="quiet" disabled={busy} onclick={dismiss}>{t.close}</button>
      </div>
    </dialog>
  {/if}
{/if}

<style>
  .recovery-card {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
    margin-top: var(--space-xl);
    padding: var(--space-md);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-panel-bg);
  }
  .recovery-card > div { min-width: 0; flex: 1 1 18rem; }
  h2, p { margin: 0; }
  h2 { font-size: var(--font-size-md); }
  .recovery-card p, .preserved { margin-top: var(--space-xs); color: var(--color-text-dim); font-size: var(--font-size-sm); }
  .recovery-card > button { flex: 0 0 auto; }
  .recovery-dialog {
    width: min(34rem, calc(100% - 2 * var(--space-xl)));
    max-height: min(90dvh, 32rem);
    overflow: auto;
    padding: var(--space-lg);
    color: var(--color-text);
    background: var(--color-panel-bg);
    border: 1px solid var(--color-input-border);
    border-radius: var(--radius-md);
  }
  .recovery-dialog::backdrop { background: var(--color-backdrop); }
  .recovery-dialog > p { margin-top: var(--space-md); }
  .choices { display: grid; gap: var(--space-sm); margin-top: var(--space-lg); }
  .choice { width: 100%; text-align: start; }
  .failure { color: var(--color-status-failed); }
  .actions {
    position: sticky;
    bottom: calc(-1 * var(--space-lg));
    display: flex;
    justify-content: end;
    margin: var(--space-lg) calc(-1 * var(--space-lg)) 0;
    padding: var(--space-sm) var(--space-lg);
    background: var(--color-panel-bg);
    border-top: 1px solid var(--color-border);
  }
</style>
