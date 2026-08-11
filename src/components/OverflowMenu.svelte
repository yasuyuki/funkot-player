<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { ui } from "../lib/ui.svelte";
  import { toast } from "../lib/toast.svelte";
  import { openMusicDir, shareFeedback } from "../lib/tauri";

  let scanBusy = $state(false);
  let openMusicBusy = $state(false);
  let musicDirBusy = $state(false);
  let feedbackBusy = $state(false);

  let musicDirNeeded = $derived(!!store.dirs?.music_dir_needed);
  let musicDirConfigurable = $derived(!!store.dirs?.music_dir_configurable);

  function toggleMenu(event: MouseEvent) {
    event.stopPropagation();
    ui.menuOpen = !ui.menuOpen;
  }

  function onShowLog() {
    ui.menuOpen = false;
    ui.logOpen = true;
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
      // Desktop opens Explorer / the file manager; Android only returns the
      // path (the private Music folder is not reliably openable via Intent).
      const path = await openMusicDir();
      // Always toast the path: Android has no Explorer, and desktop has
      // already opened Explorer / the file manager — still show the path so
      // Windows Store users can confirm where files go.
      toast.notify(path);
    } catch (err) {
      toast.notify(String(err));
    } finally {
      openMusicBusy = false;
    }
  }

  /// Error code (`set_music_dir`) → Japanese toast text.
  /// Codes must stay in sync with `src-tauri/src/lib.rs` and
  /// `src/lib/tauri.ts` (same contract as `Queue.svelte`'s `toastForError`).
  function toastForMusicDirError(error: string): string {
    switch (error) {
      case "not_absolute":
        return "絶対パスのフォルダを選んでください";
      case "not_found":
        return "そのフォルダが見つかりません";
      case "not_a_directory":
        return "フォルダを選んでください";
      case "not_readable":
        return "そのフォルダを読み取れません";
      case "contains_app_data":
        return "アプリのデータフォルダを含むフォルダは選べません";
      case "unsupported_platform":
        return "この端末では変更できません";
      default:
        return "Musicフォルダを変更できませんでした";
    }
  }

  async function onSetMusicDir() {
    if (musicDirBusy) return;
    musicDirBusy = true;
    ui.menuOpen = false;
    try {
      const result = await store.doSetMusicDir();
      if (!result.ok) {
        toast.notify(toastForMusicDirError(result.error));
      } else if (!result.changed) {
        toast.notify("変更しませんでした");
      } else if (result.restartRequired) {
        toast.notify(
          `Musicフォルダを変更しました: ${store.dirs?.music_dir}（自動選曲は再起動後に切り替わります）`,
        );
      } else {
        toast.notify(`Musicフォルダを変更しました: ${store.dirs?.music_dir}`);
      }
    } finally {
      musicDirBusy = false;
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
      {#if musicDirConfigurable && musicDirNeeded}
        <button type="button" onclick={onSetMusicDir} disabled={musicDirBusy}>Musicフォルダを選ぶ</button>
      {/if}
      {#if musicDirConfigurable && !musicDirNeeded}
        <button type="button" onclick={onSetMusicDir} disabled={musicDirBusy}>Musicフォルダを変更</button>
      {/if}
      {#if !musicDirNeeded}
        <button type="button" onclick={onOpenMusicDir} disabled={openMusicBusy}>Musicフォルダを開く</button>
      {/if}
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
