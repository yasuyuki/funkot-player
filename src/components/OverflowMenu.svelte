<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { openMusicDir, shareFeedback } from "../lib/tauri";
  import { toast } from "../lib/toast.svelte";
  import { ui } from "../lib/ui.svelte";
  import { sessionActive } from "../lib/transportMode";
  import { i18n } from "../lib/i18n.svelte";
  import { LOCALE_NAMES, nextLocale } from "../lib/locale";
  import { musicDirErrorMessage } from "../lib/messages";
  import { getThemeController, parseThemePreference } from "../lib/theme.svelte";

  let t = $derived(i18n.t);
  const theme = getThemeController();
  let themePreference = $state(theme.preference);

  let scanBusy = $state(false);
  let openMusicBusy = $state(false);
  let feedbackBusy = $state(false);
  let musicDirBusy = $state(false);
  let allowNonFunkotBusy = $state(false);
  let labelingModeBusy = $state(false);
  let clearLabelsBusy = $state(false);
  let clearPlayLogBusy = $state(false);
  let clearPlayCountsBusy = $state(false);
  let localeBusy = $state(false);
  let menuButton: HTMLButtonElement;

  let musicDirNeeded = $derived(!!store.dirs?.music_dir_needed);
  let musicDirConfigurable = $derived(!!store.dirs?.music_dir_configurable);
  let labelingModePending = $derived(
    sessionActive(store.player?.phase ?? "idle", store.player?.auditioning ?? false) &&
      store.activeLabelingMode !== null &&
      store.activeLabelingMode !== store.labelingMode,
  );

  function onThemePreferenceChange(event: Event) {
    const target = event.currentTarget;
    if (!(target instanceof HTMLSelectElement)) return;
    const preference = parseThemePreference(target.value);
    theme.setPreference(preference);
    themePreference = preference;
  }

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
      const saved = await store.doSetAllowNonFunkot(!store.allowNonFunkot);
      if (saved) toast.notify(t.allowNonFunkotToast(store.allowNonFunkot));
      else toast.notify(store.lastError ?? t.playlistError("busy"));
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

  async function onClearLabels() {
    if (clearLabelsBusy) return;
    if (!window.confirm(t.confirmClearLabels)) return;
    clearLabelsBusy = true;
    ui.menuOpen = false;
    try {
      const ok = await store.doClearLabels();
      if (ok) {
        toast.notify(t.clearedLabels);
      } else {
        toast.notify(store.lastError ?? t.clearLabelsFailed);
      }
    } finally {
      clearLabelsBusy = false;
    }
  }

  async function onClearPlayLog() {
    if (clearPlayLogBusy) return;
    if (!window.confirm(t.confirmClearPlayLog)) return;
    clearPlayLogBusy = true;
    ui.menuOpen = false;
    try {
      const ok = await store.doClearPlayLog();
      if (ok) {
        toast.notify(t.clearedPlayLog);
      } else {
        toast.notify(store.lastError ?? t.clearPlayLogFailed);
      }
    } finally {
      clearPlayLogBusy = false;
    }
  }

  async function onClearPlayCounts() {
    if (clearPlayCountsBusy) return;
    if (!window.confirm(t.confirmClearPlayCounts)) return;
    clearPlayCountsBusy = true;
    ui.menuOpen = false;
    try {
      const ok = await store.doClearPlayCounts();
      if (ok) {
        toast.notify(t.clearedPlayCounts);
      } else {
        toast.notify(store.lastError ?? t.clearPlayCountsFailed);
      }
    } finally {
      clearPlayCountsBusy = false;
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

  $effect(() => {
    if (!ui.menuOpen) return;
    const onDocClick = () => {
      ui.menuOpen = false;
    };
    document.addEventListener("click", onDocClick);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        ui.menuOpen = false;
        menuButton?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  });
</script>

<div class="overflow">
  <button type="button" class="menu-btn" bind:this={menuButton} aria-label="menu" aria-expanded={ui.menuOpen} onclick={toggleMenu}>⋮</button>
  {#if ui.menuOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="menu" onclick={(event) => event.stopPropagation()}>
      <label class="theme-control">
        <span>{t.themePreferenceLabel}</span>
        <select value={themePreference} onchange={onThemePreferenceChange}>
          <option value="dark">{t.themeDark}</option>
          <option value="light">{t.themeLight}</option>
          <option value="system">{t.themeSystem}</option>
        </select>
      </label>
      <button class="menu-item" type="button" onclick={onRescan} disabled={scanBusy}>{t.rescan}</button>
      {#if musicDirConfigurable && musicDirNeeded}
        <button class="menu-item" type="button" onclick={onSetMusicDir} disabled={musicDirBusy}>{t.pickMusicFolder}</button>
      {/if}
      {#if musicDirConfigurable && !musicDirNeeded}
        <button class="menu-item" type="button" onclick={onSetMusicDir} disabled={musicDirBusy}>{t.changeMusicFolder}</button>
        <button class="menu-item" type="button" onclick={onOpenMusicDir} disabled={openMusicBusy}>{t.openMusicFolder}</button>
      {/if}
      <button class="menu-item" type="button" onclick={onToggleAllowNonFunkot} disabled={allowNonFunkotBusy}>
        {t.allowNonFunkotItem(store.allowNonFunkot)}
      </button>
      {#if musicDirConfigurable}
        <button class="menu-item" type="button" onclick={onToggleLabelingMode} disabled={labelingModeBusy}>
          {t.labelingModeItem(store.labelingMode, labelingModePending)}
        </button>
      {/if}
      <button class="menu-item" type="button" onclick={onClearLabels} disabled={clearLabelsBusy}>
        {t.clearLabelsItem}
      </button>
      <button class="menu-item" type="button" onclick={onClearPlayLog} disabled={clearPlayLogBusy}>
        {t.clearPlayLogItem}
      </button>
      <button class="menu-item" type="button" onclick={onClearPlayCounts} disabled={clearPlayCountsBusy}>
        {t.clearPlayCountsItem}
      </button>
      <button class="menu-item" type="button" onclick={onShowLog}>{t.showLog}</button>
      <button class="menu-item" type="button" onclick={onShareFeedback} disabled={feedbackBusy}>{t.sendFeedback}</button>
      <button class="menu-item" type="button" onclick={onCycleLocale} disabled={localeBusy || !store.localeReady}>
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
    min-width: min(20rem, calc(100vw - 2rem));
    max-width: calc(100vw - 2rem);
    max-height: calc(100dvh - 5rem);
    overflow-y: auto;
  }
  .theme-control {
    display: grid;
    gap: var(--space-xs);
    padding: var(--space-sm) var(--space-md);
  }
  .theme-control select {
    width: 100%;
  }
  .menu button {
    width: 100%;
    text-align: left;
  }
  .menu button:active {
    background: var(--color-transport-secondary-bg);
    color: var(--color-transport-secondary-text);
  }
</style>
