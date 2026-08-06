<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { openMusicDir, shareFeedback } from "../lib/tauri";
  import { toast } from "../lib/toast.svelte";
  import { ui } from "../lib/ui.svelte";

  let scanBusy = $state(false);
  let openMusicBusy = $state(false);
  let feedbackBusy = $state(false);

  function toggleMenu(event: MouseEvent) {
    event.stopPropagation();
    ui.menuOpen = !ui.menuOpen;
  }

  function onShowLog() {
    ui.logOpen = true;
    ui.menuOpen = false;
  }

  async function onRescan() {
    if (scanBusy) return;
    scanBusy = true;
    ui.menuOpen = false;
    try {
      await store.doRefreshLibrary();
    } finally {
      scanBusy = false;
    }
  }

  async function onOpenMusicDir() {
    if (openMusicBusy) return;
    openMusicBusy = true;
    ui.menuOpen = false;
    try {
      const path = await openMusicDir();
      // Android cannot open the folder; the path toast is the UX. Desktop
      // already opened Explorer / the file manager — still show the path so
      // Windows Store users can confirm where files go.
      toast.notify(path);
    } catch (err) {
      toast.notify(String(err));
    } finally {
      openMusicBusy = false;
    }
  }

  async function onShareFeedback() {
    if (feedbackBusy) return;
    feedbackBusy = true;
    ui.menuOpen = false;
    try {
      const result = await shareFeedback();
      if (result.mode === "saved") {
        toast.notify(result.path);
      }
    } catch (err) {
      toast.notify(String(err));
    } finally {
      feedbackBusy = false;
    }
  }

  // Mirrors legacy/index.html's menu: a click anywhere in the document
  // closes it, and a click inside the menu itself must not (stopPropagation
  // there stops it from bubbling up to this listener).
  $effect(() => {
    if (!ui.menuOpen) return;
    const onDocClick = () => {
      ui.menuOpen = false;
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  });
</script>

<div class="overflow">
  <button type="button" class="menu-btn" aria-label="menu" onclick={toggleMenu}>⋮</button>
  {#if ui.menuOpen}
    <!-- Not a keyboard-interactive element itself -- it only exists to stop
         a tap inside the menu from bubbling to the document listener below
         that closes it; every actual action here is one of its buttons. -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="menu" onclick={(event) => event.stopPropagation()}>
      <button type="button" onclick={onRescan} disabled={scanBusy}>再スキャン</button>
      <button type="button" onclick={onOpenMusicDir} disabled={openMusicBusy}>Musicフォルダを開く</button>
      <button type="button" onclick={onShowLog}>ログを表示</button>
      <button type="button" onclick={onShareFeedback} disabled={feedbackBusy}>意見を送る</button>
    </div>
  {/if}
</div>

<style>
  .overflow {
    position: relative;
    flex: 0 0 auto;
  }
  .menu-btn {
    width: auto;
    font-size: var(--font-size-lg);
    padding: var(--space-sm) var(--space-md);
    background: var(--color-border);
    color: var(--color-text);
  }
  .menu {
    position: absolute;
    right: 0;
    top: 100%;
    margin-top: var(--space-xs);
    background: var(--color-menu-bg);
    border: 1px solid var(--color-menu-border);
    border-radius: var(--radius-sm);
    padding: var(--space-xs);
    z-index: 10;
    min-width: 8rem;
  }
  .menu button {
    width: 100%;
    font-size: var(--font-size-md);
    padding: var(--space-sm) var(--space-md);
    background: transparent;
    color: var(--color-text);
    text-align: left;
    border-radius: var(--radius-sm);
  }
  /* tokens.css's global `button:active` is a brightness filter, which does
     nothing visible on a transparent background -- these items would give
     no feedback at all on desktop (Android still tap-highlights them).
     Same fill legacy/index.html used for `.menu button:active`. */
  .menu button:active {
    background: var(--color-transport-secondary-bg);
  }
</style>
