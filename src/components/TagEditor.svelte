<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "../lib/state.svelte";
  import { i18n } from "../lib/i18n.svelte";
  import { toast } from "../lib/toast.svelte";
  import { tagPatch, summarizeTags } from "../lib/tag-edit";
  import type { Tag, TagKind, TagTarget, TagYear, TrackTagState } from "../lib/tauri";

  let { targets, revision, title, initialStates, opener, onclose }: {
    targets: TagTarget[];
    revision: string;
    title: string;
    initialStates: TrackTagState[];
    opener: HTMLElement | null;
    onclose: () => void;
  } = $props();
  let t = $derived(i18n.t);
  let expectedRevision = $state("");
  let displayed = $state<TrackTagState[]>([]);
  let mode = $state<"unchanged" | "auto" | "unset" | "set">("unchanged");
  let yearValue = $state<number | undefined>(undefined);
  let kind = $state<TagKind>("genre");
  let value = $state("");
  let add = $state<Tag[]>([]);
  let remove = $state<Tag[]>([]);
  let saving = $state(false);
  let reloading = $state(false);
  let error = $state<string | null>(null);
  let reloaded = $state(false);
  let dialog: HTMLDialogElement;
  let tags = $derived(summarizeTags(displayed));
  let yearValues = $derived(new Set(displayed.map(state => state.effective.find(tag => tag.kind === "year")?.value ?? null)));
  let commonYear = $derived(yearValues.size === 1 ? [...yearValues][0] : undefined);
  let manualModes = $derived(new Set(displayed.map(state => state.manual.year.mode === "set" ? `set:${state.manual.year.value}` : state.manual.year.mode)));
  let uniqueCount = $derived(new Set(targets.map(target => target.expected_hash)).size);
  let changedElsewhere = $derived(!!expectedRevision && store.trackTags?.revision !== expectedRevision);
  let readOnly = $derived(!!store.trackTags && !["ready", "missing"].includes(store.trackTags.store_status));
  let busy = $derived(saving || reloading);

  onMount(() => {
    expectedRevision = revision;
    // Opening data is deliberately frozen. Only explicit reload replaces it.
    displayed = initialStates;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("select, input")?.focus();
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  });

  function labelKind(tagKind: string): string {
    return tagKind === "genre" ? t.tagGenre : tagKind === "custom" ? t.tagCustom : t.tagYear;
  }
  function same(a: Tag, b: Tag): boolean { return a.kind === b.kind && a.value === b.value; }
  function queueAdd(tag: Tag) {
    remove = remove.filter(item => !same(item, tag));
    if (!add.some(item => same(item, tag))) add = [...add, { ...tag }];
  }
  function addTag() {
    if (!value.trim()) return;
    queueAdd({ kind, value }); // Backend performs normalization and validation.
    value = "";
  }
  function toggleRemove(tag: Tag) {
    add = add.filter(item => !same(item, tag));
    remove = remove.some(item => same(item, tag))
      ? remove.filter(item => !same(item, tag)) : [...remove, { ...tag }];
  }
  function candidateYear(raw: string): number | null {
    const match = /^(\d{4})(?:$|[-T])/.exec(raw.trim());
    const year = match ? Number(match[1]) : 0;
    return year >= 1000 && year <= 9999 ? year : null;
  }
  function close() { if (!busy) onclose(); }
  function stopShortcut(event: KeyboardEvent) {
    // Native dialog owns Tab/Enter/Escape. Player F/J/Space shortcuts must not
    // label or skip a track when the focus is on a dialog button.
    if (["f", "F", "j", "J", " "].includes(event.key)) event.stopPropagation();
    if (event.key === "Tab") {
      const controls = [...dialog.querySelectorAll<HTMLElement>("input:enabled,button:enabled,select:enabled,summary")]
        .filter(element => element.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first && last) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last && first) {
        event.preventDefault(); first.focus();
      }
    }
  }
  async function save() {
    if (busy || readOnly) return;
    error = null;
    if (mode === "set" && (!Number.isInteger(yearValue) || yearValue! < 1000 || yearValue! > 9999)) {
      error = "invalid_input";
      return;
    }
    const year: TagYear | undefined = mode === "unchanged" ? undefined
      : mode === "set" ? { mode, value: yearValue! } : { mode };
    // Save also includes text still in the add field; it never silently loses it.
    const additions = value.trim() ? [...add, { kind, value }] : add;
    saving = true;
    try {
      const result = await store.saveTrackTags({
        targets,
        expected_revision: expectedRevision,
        patch: tagPatch(year, additions, remove),
      });
      toast.notify(result.changed ? t.tagSaved(result.changed) : t.tagNoop);
      onclose();
    } catch (cause) {
      error = String((cause as { code?: string })?.code ?? "persist_failed");
    } finally { saving = false; }
  }
  async function reload() {
    if (busy) return;
    reloading = true;
    reloaded = false;
    try {
      await store.reloadTrackTags();
      if (store.trackTagsError) {
        error = String((store.trackTagsError as { code?: string })?.code ?? "persist_failed");
        return;
      }
      const snapshot = store.trackTags;
      if (!snapshot?.ready || !targets.every(target => snapshot.tracks[target.path]?.content_hash === target.expected_hash)) {
        error = "identity_changed";
        return;
      }
      displayed = targets.map(target => JSON.parse(JSON.stringify(snapshot.tracks[target.path])));
      expectedRevision = snapshot.revision;
      error = null;
      reloaded = true;
    } finally { reloading = false; }
  }
</script>

<dialog bind:this={dialog} aria-label={t.tagEditorTitle(title)} onkeydown={stopShortcut}
  oncancel={(event) => { event.preventDefault(); close(); }}>
  <form onsubmit={(event) => { event.preventDefault(); void save(); }}>
    <header>
      <h2 title={t.tagEditorTitle(title)}>{t.tagEditorTitle(title)}</h2>
      <p>{t.tagEditorScope(targets.length)}</p>
    </header>
    {#if readOnly}<p role="alert">{t.tagError("store_read_only")}</p>{/if}
    {#if changedElsewhere}<p role="status">{t.tagSnapshotChanged}</p>{/if}
    {#if changedElsewhere && !error}<button class="secondary" type="button" disabled={busy} onclick={reload}>{reloading ? t.tagReloading : t.tagReload}</button>{/if}
    <section aria-label={t.tagEffectiveYear}>
      <h3>{t.tagEffectiveYear}: {commonYear === undefined ? t.tagMixed : commonYear ?? t.tagUnset}</h3>
      <fieldset class="year-controls" disabled={busy || readOnly}>
        <legend>{t.tagYear}</legend>
        <select aria-label={t.tagYear} bind:value={mode}>
          <option value="unchanged">{t.tagNoChange}</option>
          <option value="auto">{t.tagYearAuto}</option>
          <option value="unset">{t.tagYearUnset}</option>
          <option value="set">{t.tagYearSet}</option>
        </select>
        {#if mode === "set"}
          <label class="year-input">{t.tagYearSet}<input type="number" inputmode="numeric" min="1000" max="9999" step="1" bind:value={yearValue} /></label>
        {/if}
      </fieldset>
    </section>
    {#if displayed.some(state => state.metadata_status !== "ready" || !["resolved", "missing"].includes(state.year_status))}
      <section class="warning" aria-label={t.tagDiagnostics}>
        {#each displayed as state, index}
          {#if state.metadata_status !== "ready" || !["resolved", "missing"].includes(state.year_status)}
            <p role="status">{displayed.length > 1 ? `${index + 1}. ` : ""}{t.tagMetadataStatus(state.metadata_status)} · {t.tagYearStatus(state.year_status)}</p>
          {/if}
        {/each}
      </section>
    {/if}
    <section aria-label={t.tagCurrentTags}>
      <h3>{t.tagCurrentTags}</h3>
      {#if !tags.length}<p>{t.tagEmpty}</p>{/if}
      <div class="chips">
        {#each tags as item (item.tag.key)}
          {@const tag = { kind: item.tag.kind as TagKind, value: item.tag.value }}
          {@const removing = remove.some(value => same(value, tag))}
          <button type="button" class:removing disabled={busy || readOnly} aria-pressed={removing}
            aria-label={removing ? `${t.tagUndo}: ${labelKind(tag.kind)}: ${tag.value}` : t.tagRemove(`${labelKind(tag.kind)}: ${tag.value}`)}
            onclick={() => toggleRemove(tag)}>
            {labelKind(tag.kind)}: {tag.value}
            {#if displayed.length > 1}<small>{t.tagPresent(item.count, displayed.length)}</small>{/if}
            <span aria-hidden="true">{removing ? "↶" : "×"}</span>
          </button>
        {/each}
      </div>
    </section>
    <fieldset disabled={busy || readOnly}>
      <legend>{t.tagAdd}</legend>
      <div class="add-fields">
        <label>{t.tagKind}<select aria-label={t.tagKind} bind:value={kind}><option value="genre">{t.tagGenre}</option><option value="custom">{t.tagCustom}</option></select></label>
        <label>{t.tagValue}<input bind:value onkeydown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTag(); } }} /></label>
        <button type="button" onclick={addTag}>{t.tagAdd}</button>
      </div>
      <p class="hint">{t.tagLimits}</p>
      {#if add.length}
        <p class="hint">{t.tagPendingAdds}</p>
        <div class="chips">{#each add as tag, index}<button type="button" onclick={() => add = add.filter((_, i) => i !== index)} aria-label={`${t.tagUndo}: ${labelKind(tag.kind)}: ${tag.value}`}>+ {labelKind(tag.kind)}: {tag.value} ×</button>{/each}</div>
      {/if}
    </fieldset>
    <details class="details">
      <summary>{t.tagDiagnostics}</summary>
      <p class="hint">{t.tagFileUntouched}</p>
      {#if uniqueCount !== targets.length}<p>{t.tagSharedIdentity(uniqueCount)}</p>{/if}
      <p>{manualModes.size === 1 ? t.tagManualMode([...manualModes][0].split(":")[0]) : t.tagMixed}</p>
      <h4>{t.tagCurrentTags}</h4>
      {#each tags as item (item.tag.key)}
        <p class="hint">{labelKind(item.tag.kind)}: {item.tag.value} · {t.tagOrigin(item.tag.origin)}</p>
      {/each}
      {#each displayed as state, index}
        {#if displayed.length === 1 || state.metadata_status !== "ready" || !["resolved", "missing"].includes(state.year_status)}
          <p class="hint">{displayed.length > 1 ? `${index + 1}. ` : ""}{t.tagMetadataStatus(state.metadata_status)} · {t.tagYearStatus(state.year_status)}</p>
        {/if}
      {/each}
      {#if displayed.length === 1}
        <h4>{t.tagYearCandidates}</h4>
        {#if !displayed[0].candidates.length}<p>{t.tagEmpty}</p>{/if}
        {#each displayed[0].candidates as candidate}
          {@const year = candidateYear(candidate.raw_value)}
          <div class="candidate">
            <span>{t.tagSemantic(candidate.semantic)} · {candidate.raw_key}: {candidate.raw_value}</span>
            {#if year}<button type="button" disabled={busy || readOnly} onclick={() => { mode = "set"; yearValue = year; }}>{t.tagAdoptYear(year)}</button>{/if}
          </div>
        {/each}
        {#if displayed[0].manual.suppressed_auto_tags.length}
          <h4>{t.tagSuppressed}</h4>
          <div class="chips">
            {#each displayed[0].manual.suppressed_auto_tags as tag}
              <button type="button" disabled={busy || readOnly} onclick={() => queueAdd(tag)}>{t.tagRestore}: {labelKind(tag.kind)}: {tag.value}</button>
            {/each}
          </div>
        {/if}
      {/if}
      {#if displayed.some(state => state.diagnostics.length)}
        <h4>{t.tagDiagnostics}</h4>
        {#each displayed as state}{#each state.diagnostics as diagnostic}<p>{diagnostic}</p>{/each}{/each}
      {/if}
    </details>
    <footer>
      {#if error}<p class="feedback" role="alert">{t.tagError(error)}</p>{/if}
      {#if reloaded}<p class="feedback" role="status">{t.tagReloaded}</p>{/if}
      {#if error}<button class="secondary" type="button" disabled={busy} onclick={reload}>{reloading ? t.tagReloading : t.tagReload}</button>{/if}
      <button class="secondary" type="button" onclick={close} disabled={busy}>{t.cancelAction}</button>
      <button type="submit" class="save" disabled={busy || readOnly}>{saving ? t.tagSaving : t.tagSave}</button>
    </footer>
  </form>
</dialog>

<style>
  dialog { box-sizing: border-box; width: min(38rem, calc(100vw - 1.5rem)); max-height: calc(100dvh - 1.5rem); overflow-y: auto; padding: var(--space-lg); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg); color: var(--color-text); }
  dialog::backdrop { background: #000a; }
  form { display: grid; gap: var(--space-md); min-width: 0; }
  h2,h3,h4,p { margin: 0; overflow-wrap: anywhere; }
  h2 { display: -webkit-box; overflow: hidden; font-size: var(--font-size-lg); line-clamp: 2; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  h3,h4 { font-size: var(--font-size-sm); }
  header,section,fieldset { display: grid; gap: var(--space-sm); min-width: 0; }
  fieldset { border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: var(--space-md); }
  legend { padding: 0 var(--space-xs); }
  label { display: grid; gap: var(--space-xs); min-width: 0; }
  input,select { box-sizing: border-box; min-width: 0; width: 100%; }
  .year-controls { display: grid; grid-template-columns: minmax(0, 1fr) minmax(8rem, 12rem); align-items: end; gap: var(--space-sm); }
  .year-controls > select { grid-column: 1; }
  .year-controls .year-input { grid-column: 2; grid-row: 1; }
  .year-input { max-width: 12rem; }
  .hint,small { font-size: var(--font-size-sm); color: var(--color-text-dim); }
  .add-fields { display: grid; grid-template-columns: auto minmax(0,1fr); gap: var(--space-sm); }
  .add-fields button { grid-column: 1 / -1; }
  .chips { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
  button { width: auto; overflow-wrap: anywhere; max-width: 100%; background: var(--color-menu-bg); color: var(--color-text); border: 1px solid var(--color-border); font-size: var(--font-size-sm); padding: var(--space-sm) var(--space-md); }
  .chips button { display: inline-flex; flex-wrap: wrap; gap: var(--space-xs); align-items: center; padding: var(--space-sm); text-align: start; font-size: var(--font-size-sm); }
  .chips small { flex-basis: 100%; }
  .removing { text-decoration: line-through; }
  .candidate { display: grid; gap: var(--space-xs); margin-top: var(--space-sm); overflow-wrap: anywhere; }
  .warning { border-inline-start: 3px solid var(--color-border); padding-inline-start: var(--space-sm); }
  .details[open] { display: grid; gap: var(--space-sm); }
  summary { cursor: pointer; }
  footer { position: sticky; bottom: calc(var(--space-lg) * -1); display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-sm); margin-top: var(--space-sm); padding: var(--space-md) 0 var(--space-lg); background: var(--color-bg); border-top: 1px solid var(--color-border); }
  .feedback { flex-basis: 100%; }
  .save { background: var(--color-accent-bg); color: var(--color-accent-text); }
  @media (max-width: 30rem) {
    .year-controls { grid-template-columns: 1fr; }
    .year-controls .year-input { grid-column: 1; grid-row: auto; }
    footer { justify-content: stretch; }
    footer button { flex: 1; }
  }
</style>
