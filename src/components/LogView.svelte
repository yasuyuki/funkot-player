<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { ui } from "../lib/ui.svelte";
  import { pollLog } from "../lib/tauri";
  import { i18n } from "../lib/i18n.svelte";

  let t = $derived(i18n.t);

  const POLL_INTERVAL_MS = 500;

  let lines = $state<string[]>([]);
  let arrivalsInspect = $derived(store.arrivalsInspect);

  $effect(() => {
    if (!ui.logOpen) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        lines = await pollLog();
      } catch (e) {
        store.lastError = String(e);
      }
      if (!cancelled) {
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
    void tick();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  });

  function onClose() {
    ui.logOpen = false;
    store.lastError = null;
  }
</script>

{#if ui.logOpen}
  <div class="log-view">
    <div class="log-header">
      <span class="log-title">{t.logTitle}</span>
      <button type="button" class="close" onclick={onClose}>{t.close}</button>
    </div>
    {#if store.dirs}
      <div class="dirs">
        <div>{t.musicFolderLabel}: {store.dirs.music_dir}</div>
        <div>{t.cacheLabel}: {store.dirs.cache_dir}</div>
      </div>
    {/if}
    <div class="dirs">
      <div>
        {t.arrivalsInspect(arrivalsInspect.listed, arrivalsInspect.gated, arrivalsInspect.banner)}
      </div>
      <div>
        {t.historyRevLine(
          String(arrivalsInspect.historyRevision ?? "—"),
          String(arrivalsInspect.processedRevision ?? "—"),
        )}
      </div>
      <div>
        now {arrivalsInspect.nowPlaying ? store.relName(arrivalsInspect.nowPlaying) : "—"}
        / reserved {arrivalsInspect.reserved ? store.relName(arrivalsInspect.reserved) : "—"}
        / pending {arrivalsInspect.pending}
      </div>
      {#if arrivalsInspect.names.length > 0}
        <div>{t.arrivalsPathsLabel}: {arrivalsInspect.names.join(" · ")}</div>
      {/if}
    </div>
    {#if store.lastError}
      <p class="error">{store.lastError}</p>
    {/if}
    <pre>{lines.join("\n")}</pre>
  </div>
{/if}

<style>
  .log-view {
    margin-top: var(--space-xl);
  }
  .log-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-sm);
  }
  .log-title {
    font-size: var(--font-size-md);
    color: var(--color-text);
  }
  .close {
    width: auto;
  }
  .dirs {
    font-size: var(--font-size-sm);
    color: var(--color-text-dim);
    margin-bottom: var(--space-sm);
    overflow-wrap: anywhere;
  }
  .error {
    color: var(--color-status-failed);
    font-size: var(--font-size-sm);
  }
  pre {
    white-space: pre-wrap;
    word-break: break-all;
    font-size: var(--font-size-sm);
    background: var(--color-log-bg);
    padding: var(--space-md);
    border-radius: var(--radius-sm);
    margin-top: var(--space-md);
  }
</style>
