<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { ui } from "../lib/ui.svelte";
  import { pollLog } from "../lib/tauri";

  const POLL_INTERVAL_MS = 500;

  let lines = $state<string[]>([]);

  // This poll loop is owned by this component, not `state.svelte.ts`: the
  // log is diagnostic output, not playback state, and unlike `player_state`
  // there is no reason to keep fetching it while nobody has the panel open.
  // Self-rescheduling `setTimeout`, same reasoning as the store's own poll
  // loop (see its doc comment): an in-flight `poll_log` must not get a
  // second one stacked on top of it, and the effect's cleanup must be able
  // to stop it for good rather than leaking a timer past `logOpen` going
  // false.
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

  // Closing the log acknowledges whatever error is in it. Without this
  // `lastError` is never cleared -- nothing assigns null to it -- so one
  // transient invoke failure would leave NowCard's ログを表示 link up
  // forever, long after polling recovered. Cleared on close rather than on
  // open so the error is still readable while the panel is up.
  function onClose() {
    ui.logOpen = false;
    store.lastError = null;
  }
</script>

{#if ui.logOpen}
  <div class="log-view">
    <div class="log-header">
      <span class="log-title">ログ</span>
      <button type="button" class="close" onclick={onClose}>閉じる</button>
    </div>
    {#if store.dirs}
      <!-- Same paths legacy/index.html printed at startup -- lets a tester
           confirm the app is reading/writing where they expect. On Android
           this is also the only place the music folder's path appears (the
           ⋮ menu has no "開く" item there), and it is what someone about to
           copy files over MTP needs to read, hence Japanese labels rather
           than the bare `music:` / `cache:` keys. -->
      <div class="dirs">
        <div>音楽フォルダ: {store.dirs.music_dir}</div>
        <div>キャッシュ: {store.dirs.cache_dir}</div>
      </div>
    {/if}
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
    font-size: var(--font-size-sm);
    padding: var(--space-xs) var(--space-md);
    background: var(--color-border);
    color: var(--color-text);
  }
  .dirs {
    font-size: var(--font-size-sm);
    color: var(--color-text-dim);
    margin-bottom: var(--space-sm);
    /* The Android music path is one long unbroken token and runs off the
       right edge without this -- the page body must never scroll
       sideways. */
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
