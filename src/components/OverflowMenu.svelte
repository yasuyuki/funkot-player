<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { openMusicDir, shareFeedback } from "../lib/tauri";
  import { toast } from "../lib/toast.svelte";
  import { ui } from "../lib/ui.svelte";
  import { sessionActive } from "../lib/transportMode";
  import { i18n } from "../lib/i18n.svelte";
  import { LOCALE_NAMES, nextLocale } from "../lib/locale";
  import { musicDirErrorMessage } from "../lib/messages";

  let t = $derived(i18n.t);

  let scanBusy = $state(false);
  let openMusicBusy = $state(false);
  let feedbackBusy = $state(false);
  let musicDirBusy = $state(false);
  let allowNonFunkotBusy = $state(false);
  let labelingModeBusy = $state(false);
  let clearLabelsBusy = $state(false);
  let localeBusy = $state(false);

  let musicDirNeeded = $derived(!!store.dirs?.music_dir_needed);
  let musicDirConfigurable = $derived(!!store.dirs?.music_dir_configurable);
  // Labeling mode is fixed at engine construction (no live switch — see
  // `EngineOptions::head_only_secs`), so a toggle only takes effect the next
  // time ▶ is pressed (`doStart`), not merely "while a session happens to be
  // running" -- a session already running WITH the current setting must not
  // show this. Compare against `activeLabelingMode` (captured at the running
  // session's own `doStart`), not just `sessionActive`.
  let labelingModePending = $derived(
    sessionActive(store.player?.phase ?? "idle", store.player?.auditioning ?? false) &&
      store.activeLabelingMode !== null &&
      store.activeLabelingMode !== store.labelingMode,
  );

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
      const result = await store.doRefreshLibrary();
      // Check `ok` first so the busy/error arms narrow cleanly (both are `ok: false`).
      if (result.ok) {
        toast.notify(t.scanFound(result.count));
      } else if ("busy" in result) {
        toast.notify(t.scanBusy);
      } else {
        toast.notify(result.error);
      }
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
      // The file manager is already up by now; the toast rides on top of it
      // so Windows Store users can confirm where files go. Desktop only —
      // see the guard on the menu item.
      toast.notify(path);
    } catch (err) {
      toast.notify(String(err));
    } finally {
      openMusicBusy = false;
    }
  }

  async function onSetMusicDir() {
    if (musicDirBusy) return;
    musicDirBusy = true;
    ui.menuOpen = false;
    try {
      const result = await store.doSetMusicDir();
      if (!result.ok) {
        toast.notify(musicDirErrorMessage(t, result.error));
      } else if (!result.changed) {
        toast.notify(t.musicDirUnchanged);
      } else if (result.restartRequired) {
        toast.notify(t.musicDirChangedRestart(store.dirs?.music_dir ?? ""));
      } else {
        toast.notify(t.musicDirChanged(store.dirs?.music_dir ?? ""));
      }
    } finally {
      musicDirBusy = false;
    }
  }

  async function onToggleAllowNonFunkot() {
    if (allowNonFunkotBusy) return;
    allowNonFunkotBusy = true;
    ui.menuOpen = false;
    try {
      await store.doSetAllowNonFunkot(!store.allowNonFunkot);
      toast.notify(t.allowNonFunkotToast(store.allowNonFunkot));
    } finally {
      allowNonFunkotBusy = false;
    }
  }

  async function onToggleLabelingMode() {
    if (labelingModeBusy) return;
    labelingModeBusy = true;
    ui.menuOpen = false;
    try {
      await store.doSetLabelingMode(!store.labelingMode);
      toast.notify(t.labelingModeToast(store.labelingMode, labelingModePending));
    } finally {
      labelingModeBusy = false;
    }
  }

  async function onClearLabelsAndHistory() {
    if (clearLabelsBusy) return;
    if (!window.confirm(t.confirmClearLabels)) return;
    clearLabelsBusy = true;
    ui.menuOpen = false;
    try {
      const ok = await store.doClearLabelsAndHistory();
      if (ok) {
        toast.notify(t.clearedLabels);
      } else {
        toast.notify(store.lastError ?? t.clearLabelsFailed);
      }
    } finally {
      clearLabelsBusy = false;
    }
  }

  async function onShareFeedback() {
    if (feedbackBusy) return;
    feedbackBusy = true;
    ui.menuOpen = false;
    try {
      const result = await shareFeedback(t.sendFeedback);
      if (result.mode === "saved") {
        toast.notify(result.path);
      }
    } catch (err) {
      toast.notify(String(err));
    } finally {
      feedbackBusy = false;
    }
  }

  async function onCycleLocale() {
    if (localeBusy || !store.localeReady) return;
    localeBusy = true;
    ui.menuOpen = false;
    try {
      await store.doSetLocale(nextLocale(i18n.locale));
    } finally {
      localeBusy = false;
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
      <button type="button" onclick={onRescan} disabled={scanBusy}>{t.rescan}</button>
      {#if musicDirConfigurable && musicDirNeeded}
        <button type="button" onclick={onSetMusicDir} disabled={musicDirBusy}>{t.pickMusicFolder}</button>
      {/if}
      {#if musicDirConfigurable && !musicDirNeeded}
        <button type="button" onclick={onSetMusicDir} disabled={musicDirBusy}>{t.changeMusicFolder}</button>
        <button type="button" onclick={onOpenMusicDir} disabled={openMusicBusy}>{t.openMusicFolder}</button>
      {/if}
      <button type="button" onclick={onToggleAllowNonFunkot} disabled={allowNonFunkotBusy}>
        {t.allowNonFunkotItem(store.allowNonFunkot)}
      </button>
      <!-- Desktop only, same platform test as the folder items above: labeling
           mode prefetches a dozen stretched head buffers at once (~115 MB), which
           is not an Android budget. The authority is `LABELING_AVAILABLE` in
           src-tauri/src/lib.rs -- this only hides the button. -->
      {#if musicDirConfigurable}
        <button type="button" onclick={onToggleLabelingMode} disabled={labelingModeBusy}>
          {t.labelingModeItem(store.labelingMode, labelingModePending)}
        </button>
      {/if}
      <button type="button" onclick={onClearLabelsAndHistory} disabled={clearLabelsBusy}>
        {t.clearLabelsItem}
      </button>
      <button type="button" onclick={onShowLog}>{t.showLog}</button>
      <button type="button" onclick={onShareFeedback} disabled={feedbackBusy}>{t.sendFeedback}</button>
      <button type="button" onclick={onCycleLocale} disabled={localeBusy || !store.localeReady}>
        {t.languageItem(LOCALE_NAMES[i18n.locale])}
      </button>
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
