<script lang="ts">
  import { store } from "../../lib/state.svelte";
  import { toast, BULK_DISMISS_MS } from "../../lib/toast.svelte";
  import ChipEditor from "./ChipEditor.svelte";
  import type { TrackRow } from "../../lib/tauri";
  import { i18n } from "../../lib/i18n.svelte";
  import { enqueueManyMessage } from "../../lib/messages";

  let t = $derived(i18n.t);

  /// At most one inline chip editor: `"path\\tintro|outro"` (legacy `openChipKey`).
  let openChipKey = $state<string | null>(null);
  let editorOpener: HTMLButtonElement | null = null;
  let busy = $state(false);

  let rows = $derived(store.libraryList);
  let labelingPath = $derived(store.labelingPath);

  type FolderGroup = {
    key: string;
    title: string;
    absDir: string;
    tracks: TrackRow[];
  };

  /// First path segment of `relName` (`/`-normalized). Root files → `""`.
  function topSegment(rel: string): string {
    const i = rel.indexOf("/");
    if (i < 0) return "";
    return rel.slice(0, i);
  }

  function folderAbsDir(firstPath: string, segment: string): string {
    const musicDir = store.dirs?.music_dir;
    if (!musicDir) return "";
    if (!segment) return musicDir;
    const after = firstPath.slice(musicDir.length);
    const sep = after.startsWith("\\") ? "\\" : "/";
    return `${musicDir}${sep}${segment}`;
  }

  function rootHeading(): string {
    const md = store.dirs?.music_dir;
    if (!md) return t.rootFolder;
    return store.pathBasename(md) || t.rootFolder;
  }

  /// Exactly one group per top-level segment, ordered by where that segment
  /// first appears in scan order.
  ///
  /// Must not group by *runs* of `rows`: `scan_tracks` sorts whole paths, so a
  /// root-level file sorts among the directory *names* rather than beside the
  /// other root-level files (`music/Bbb.mp3` lands between `music/AlbumB/` and
  /// `music/Cccc/`). Runs therefore emit the `""` group several times, handing
  /// `{#each}` the same key twice — Svelte throws `each_key_duplicate` there,
  /// and in a production build that error carries no message, so the table
  /// silently rendered nothing and the throw took the rest of the flush
  /// (other panels' handlers, the scan/analysis progress line) with it.
  let groups = $derived.by(() => {
    const byKey = new Map<string, FolderGroup>();
    for (const row of rows) {
      const seg = topSegment(store.relName(row.path));
      let group = byKey.get(seg);
      if (!group) {
        group = {
          key: seg,
          title: seg || rootHeading(),
          absDir: folderAbsDir(row.path, seg),
          tracks: [],
        };
        byKey.set(seg, group);
      }
      group.tracks.push(row);
    }
    return Array.from(byKey.values());
  });

  function cellMark(manual: boolean, low: boolean): string {
    if (manual) return "*";
    if (low) return "!";
    return "";
  }

  function toggleChip(path: string, kind: "intro" | "outro", opener: HTMLButtonElement) {
    editorOpener = opener;
    const key = `${path}\t${kind}`;
    if (openChipKey === key) {
      openChipKey = null;
      return;
    }
    const row = store.libraryList.find((r) => r.path === path);
    if (!row || !row.analyzed) return;
    openChipKey = key;
  }

  function openKind(path: string): "intro" | "outro" | null {
    if (!openChipKey || !openChipKey.startsWith(`${path}\t`)) return null;
    const kind = openChipKey.slice(path.length + 1);
    return kind === "intro" || kind === "outro" ? kind : null;
  }

  function closeEditor() {
    openChipKey = null;
    editorOpener?.focus();
  }

  function toggleCard(path: string, opener: HTMLButtonElement) {
    editorOpener = opener;
    if (openKind(path)) closeEditor();
    else openChipKey = `${path}\tintro`;
  }

  function chipRow(path: string): TrackRow | null {
    return store.libraryList.find((r) => r.path === path) ?? null;
  }

  function labelText(row: TrackRow): string {
    if (row.label === true) return t.funkot;
    if (row.label === false) return t.notFunkot;
    return t.noLabel;
  }

  async function onChipPick(path: string, kind: "intro" | "outro", value: number) {
    const row = chipRow(path);
    if (!row) return;
    const prevIntro = row.intro_bars;
    const prevOutro = row.outro_structure_bars;
    const prevManual =
      kind === "intro" ? row.intro_manual : row.outro_manual;
    const updated = await store.doSetBars(
      path,
      kind === "intro" ? value : null,
      kind === "outro" ? value : null,
    );
    if (!updated) return;
    // The path-keyed editor survives refresh; do not steal a newer selection.
    toast.show(t.changed, async () => {
      const restored = await store.doSetBars(
        path,
        kind === "intro" ? prevIntro : null,
        kind === "outro" ? prevOutro : null,
        prevManual,
      );
      return restored !== null;
    });
  }

  async function onToggleLabel(row: TrackRow) {
    if (busy) return;
    busy = true;
    const prevLabel = row.label;
    const next = !(row.label ?? row.is_funkot);
    try {
      const updated = await store.doSetLabel(row.path, next);
      if (!updated) return;
      toast.show(next ? t.labeledFunkot : t.labeledNotFunkot, async () => {
        const restored = await store.doSetLabel(row.path, prevLabel);
        return restored !== null;
      });
    } finally {
      busy = false;
    }
  }

  async function onFolderLabel(
    absDir: string,
    verdict: boolean,
    tracks: TrackRow[],
    rootOnly: boolean,
  ) {
    if (busy || (!rootOnly && !absDir)) return;
    busy = true;
    try {
      // Root heading is music_dir; `set_folder_label` would recurse the whole
      // library. Label only the root-level files in this group, one call each,
      // and undo them the same way — the host's bulk undo snapshot belongs to
      // `set_folder_label`, which this branch never reaches.
      let n: number | null;
      let undo: () => Promise<boolean>;
      if (rootOnly) {
        const prev = tracks.map((t) => ({ path: t.path, label: t.label }));
        const results = await Promise.all(
          tracks.map((t) => store.doSetLabel(t.path, verdict)),
        );
        n = results.every((r) => r !== null) ? tracks.length : null;
        undo = async () => {
          for (const p of prev) {
            const ok = await store.doSetLabel(p.path, p.label);
            if (!ok) return false;
          }
          return true;
        };
      } else {
        n = await store.doSetFolderLabel(absDir, verdict);
        undo = () => store.doUndoLastFolderLabel();
      }
      if (n === null) return;
      toast.show(t.bulkLabeled(n, verdict), undo, BULK_DISMISS_MS);
    } finally {
      busy = false;
    }
  }

  async function onAdd(path: string) {
    if (busy) return;
    const destination = store.destinationLabel;
    busy = true;
    try {
      const result = await store.doEnqueue(path);
      if (result) toast.notify(t.playlistAddResult(enqueueManyMessage(t, result), destination));
      else toast.notify(t.playlistError(store.lastError ?? "busy"));
    } finally {
      busy = false;
    }
  }

  function isNonFunkot(row: TrackRow): boolean {
    return row.analyzed && !row.is_funkot;
  }

  function addDisabled(row: TrackRow): boolean {
    return busy || !store.canAddToSource || (isNonFunkot(row) && !store.allowNonFunkot);
  }
</script>

<svelte:window onkeydown={(event) => {
  if (event.key === "Escape" && openChipKey && editorOpener?.getClientRects().length) {
    event.preventDefault();
    closeEditor();
  }
}} />

<div class="wrap">
  <p class="destination">{t.playlistDestination(store.destinationLabel || t.playlistNormal)}</p>
  <p class="destination">{t.editImmediate}</p>
  <table class="table">
    <thead>
      <tr>
        <th>track</th>
        <th>{t.colLabel}</th>
        <th>intro</th>
        <th>outro</th>
        <th>mix</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      {#each groups as group (group.key)}
        <tr class="folder-row">
          <td class="folder-name" colspan="1">{group.title}</td>
          <td class="folder-acts" colspan="5">
            <button
              type="button"
              class="quiet folder-btn"
              disabled={busy || (group.key !== "" && !group.absDir)}
              onclick={() =>
                onFolderLabel(group.absDir, true, group.tracks, group.key === "")}
            >{t.funkot}</button>
            <button
              type="button"
              class="quiet folder-btn"
              disabled={busy || (group.key !== "" && !group.absDir)}
              onclick={() =>
                onFolderLabel(group.absDir, false, group.tracks, group.key === "")}
            >{t.notFunkot}</button>
          </td>
        </tr>
        {#each group.tracks as row (row.path)}
          <tr
            class:non-funkot={isNonFunkot(row)}
            class:current={row.path === labelingPath}
          >
            <td class="name" title={row.path}>
              {#if row.played_at_ms != null}
                <span class="played">✓</span>
              {/if}
              <strong>{row.title}</strong>
              <span class="metadata">
                {#if row.artist}<span class="artist">{row.artist}</span><span aria-hidden="true">·</span>{/if}
                <span class="path">{store.relName(row.path)}</span>
              </span>
            </td>
            <td class="label-cell">
              <button
                type="button"
                class="quiet label-btn"
                disabled={busy}
                onclick={() => onToggleLabel(row)}
              >{labelText(row)}</button>
            </td>
            <td>
              {#if row.intro_bars === null}
                -
              {:else}
                <button
                  type="button"
                  class="quiet bars"
                  class:low={row.intro_low_confidence && !row.intro_manual}
                  onclick={(event) => toggleChip(row.path, "intro", event.currentTarget)}
                >{row.intro_bars}{cellMark(row.intro_manual, row.intro_low_confidence)}</button>
              {/if}
            </td>
            <td>
              {#if row.outro_structure_bars === null}
                -
              {:else}
                <button
                  type="button"
                  class="quiet bars"
                  class:low={row.outro_low_confidence && !row.outro_manual}
                  onclick={(event) => toggleChip(row.path, "outro", event.currentTarget)}
                >{row.outro_structure_bars}{cellMark(row.outro_manual, row.outro_low_confidence)}</button>
              {/if}
            </td>
            <td class="mix">{row.outro_bars ?? ""}</td>
            <td class="act">
              <button
                type="button"
                class="icon-button add"
                disabled={addDisabled(row)}
                onclick={() => onAdd(row.path)}
                aria-label={t.playlistAddLabel(row.title, store.destinationLabel || t.playlistNormal)}
                title={t.playlistAddLabel(row.title, store.destinationLabel || t.playlistNormal)}
              >+</button>
            </td>
          </tr>
          {#if openKind(row.path)}
            {@const kind = openKind(row.path)}
            {@const live = chipRow(row.path)}
            {#if kind && live}
              <tr class="chip-row">
                <td colspan="6">
                  <ChipEditor
                    {kind}
                    current={kind === "intro" ? live.intro_bars : live.outro_structure_bars}
                    manual={kind === "intro" ? live.intro_manual : live.outro_manual}
                    onPick={(v) => onChipPick(row.path, kind, v)}
                  />
                </td>
              </tr>
            {/if}
          {/if}
        {/each}
      {/each}
    </tbody>
  </table>
  <div class="cards">
    {#each groups as group (group.key)}
      <section class="group">
        <details aria-label={t.folderActions}>
          <summary>{group.title} · {t.folderActions}</summary>
          <div class="folder-actions">
            <button type="button" class="quiet" disabled={busy || (group.key !== "" && !group.absDir)} onclick={() => onFolderLabel(group.absDir, true, group.tracks, group.key === "")}>{t.funkot}</button>
            <button type="button" class="quiet" disabled={busy || (group.key !== "" && !group.absDir)} onclick={() => onFolderLabel(group.absDir, false, group.tracks, group.key === "")}>{t.notFunkot}</button>
          </div>
        </details>
        {#each group.tracks as row (row.path)}
          <article class:non-funkot={isNonFunkot(row)} class:current={row.path === labelingPath} class="card">
            <div class="track-copy" title={row.path}>
              <strong>{row.title}</strong>
              <span class="metadata">
                {#if row.artist}<span class="artist">{row.artist}</span><span aria-hidden="true">·</span>{/if}
                <span class="path">{store.relName(row.path)}</span>
              </span>
            </div>
            <div class="card-status">
              <span class="card-values"><span>{labelText(row)}</span>
              <span class:low={row.intro_low_confidence && !row.intro_manual}>{t.intro} {row.intro_bars ?? "-"}{cellMark(row.intro_manual, row.intro_low_confidence)}</span>
              <span class:low={row.outro_low_confidence && !row.outro_manual}>{t.outro} {row.outro_structure_bars ?? "-"}{cellMark(row.outro_manual, row.outro_low_confidence)}</span>
              <span>mix {row.outro_bars ?? "-"}</span></span>
              <button type="button" class="quiet" aria-pressed={openKind(row.path) !== null} onclick={(event) => toggleCard(row.path, event.currentTarget)}>{t.editTrack}</button>
              <button type="button" class="icon-button" disabled={addDisabled(row)} onclick={() => onAdd(row.path)} aria-label={t.playlistAddLabel(row.title, store.destinationLabel || t.playlistNormal)} title={t.playlistAddLabel(row.title, store.destinationLabel || t.playlistNormal)}>+</button>
            </div>
            {#if openKind(row.path)}
              {@const live = chipRow(row.path)}
              {#if live}
                <div class="card-editor" tabindex="-1" aria-label={t.editTrack}>
                  <button type="button" class="quiet" disabled={busy} onclick={() => onToggleLabel(live)}>{labelText(live)}</button>
                  {#if live.intro_bars !== null}<ChipEditor kind="intro" current={live.intro_bars} manual={live.intro_manual} onPick={(v) => onChipPick(row.path, "intro", v)} />{/if}
                  {#if live.outro_structure_bars !== null}<ChipEditor kind="outro" current={live.outro_structure_bars} manual={live.outro_manual} onPick={(v) => onChipPick(row.path, "outro", v)} />{/if}
                  <div class="edit-footer"><button type="button" class="quiet" onclick={closeEditor}>{t.close}</button></div>
                </div>
              {/if}
            {/if}
          </article>
        {/each}
      </section>
    {/each}
  </div>
</div>

<style>
  .wrap {
    margin-top: var(--space-md);
    overflow-x: auto;
  }
  .destination { margin: 0 0 var(--space-sm); color: var(--color-text-dim); font-size: var(--font-size-sm); overflow-wrap: anywhere; }

  .table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--font-size-sm);
  }

  th,
  td {
    text-align: left;
    padding: var(--space-xs) var(--space-sm);
    border-bottom: 1px solid var(--color-border);
    vertical-align: middle;
  }

  th {
    color: var(--color-text-dim);
    font-weight: 600;
  }

  tr.non-funkot {
    opacity: 0.45;
    color: var(--color-text-dim);
  }

  tr.current {
    background: var(--color-queue-reserved-bg);
  }

  .folder-row td {
    background: var(--color-tab-bg);
    border-bottom: 1px solid var(--color-border);
    padding-top: var(--space-sm);
    padding-bottom: var(--space-sm);
  }

  .folder-name {
    font-weight: 600;
    color: var(--color-text);
    max-width: 10rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .folder-acts {
    white-space: nowrap;
  }

  .folder-btn + .folder-btn {
    margin-left: var(--space-xs);
  }

  .name {
    min-width: 16rem;
    overflow-wrap: anywhere;
  }

  .name strong, .track-copy strong { display: block; color: var(--color-text); font-size: var(--font-size-md); font-weight: 600; }
  .metadata { display: flex; flex-wrap: wrap; gap: 0 var(--space-xs); color: var(--color-text-dim); font-size: var(--font-size-sm); }
  .artist, .path { min-width: 0; overflow-wrap: anywhere; }

  .played {
    color: var(--color-text-dim);
    margin-right: 0.25em;
  }

  .label-cell {
    width: 1%;
    white-space: nowrap;
  }

  .mix {
    color: var(--color-text-dimmer);
    width: 1%;
  }

  .act {
    width: 1%;
  }

  .bars.low {
    color: var(--color-flagged-warn);
  }

  .chip-row td {
    padding: var(--space-xs) var(--space-sm) var(--space-md);
  }

  .cards { display: none; }

  @media (max-width: 47.99rem) {
    .table { display: none; }
    .wrap { overflow: visible; }
    .cards { display: grid; gap: var(--space-md); }
    .group { border: 1px solid var(--color-border); }
    summary { cursor: pointer; padding: var(--space-sm) var(--space-md); font-weight: 600; }
    .folder-actions { display: flex; flex-wrap: wrap; gap: var(--space-sm); padding: var(--space-sm) var(--space-md); }
    .card-status { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-sm); padding: 0 var(--space-sm) var(--space-xs); }
    .card-values { flex: 1 1 auto; display: flex; flex-wrap: wrap; gap: var(--space-xs); font-size: var(--font-size-sm); color: var(--color-text-dim); }
    .card { border-top: 1px solid var(--color-border); }
    .track-copy { padding: var(--space-sm) var(--space-sm) 0; overflow-wrap: anywhere; }
    .card.current { background: var(--color-queue-reserved-bg); }
    .card-editor { padding: 0 var(--space-md) var(--space-md); }
  }
</style>
