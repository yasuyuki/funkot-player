<script lang="ts">
  import { i18n } from "../lib/i18n.svelte";
  import type { TagChoice, TagIndex } from "../lib/tag-filter";
  let { candidates, selected, mode, yearUnset, onchoose, onremove, onmode, onunset, onclear }: {
    candidates: TagIndex["candidates"];
    selected: readonly TagChoice[];
    mode: "all" | "any";
    yearUnset: boolean;
    onchoose: (tag: TagChoice) => void;
    onremove: (key: string) => void;
    onmode: (mode: "all" | "any") => void;
    onunset: (enabled: boolean) => void;
    onclear: () => void;
  } = $props();
  let t = $derived(i18n.t);
  let candidateKey = $state("");
  let expanded = $state(false);
  let activeCount = $derived(selected.length + Number(yearUnset));
  let quickCandidates = $derived(candidates.slice(0, 8));
  function kindLabel(kind: string) { return kind === "year" ? t.tagYear : kind === "genre" ? t.tagGenre : t.tagCustom; }
  function isSelected(key: string) { return selected.some(item => item.key === key); }
  function toggleQuick(tag: TagChoice) {
    if (isSelected(tag.key)) onremove(tag.key);
    else onchoose(tag);
  }
  function choose() {
    const candidate = candidates.find(tag => tag.key === candidateKey);
    if (candidate) onchoose(candidate);
    candidateKey = "";
  }
</script>

<button type="button" class="toggle" class:active={activeCount > 0}
  aria-expanded={expanded} aria-controls="tag-filter-panel" onclick={() => expanded = !expanded}>
  {t.tagFilterToggle}{activeCount ? ` (${activeCount})` : ""}
</button>
{#if expanded}
<div class="tag-filter" id="tag-filter-panel" role="group" aria-label={t.tagFilterTitle}>
  {#if quickCandidates.length > 0}
    <div class="quick-candidates" role="group" aria-label={t.tagFilterPick}>
      {#each quickCandidates as tag (tag.key)}
        {@const active = isSelected(tag.key)}
        <button
          type="button"
          class="quick-tag"
          class:primary={active}
          aria-pressed={active}
          aria-label={`${kindLabel(tag.kind)}: ${tag.value} · ${t.tagCandidateCount(tag.count)}`}
          onclick={() => toggleQuick(tag)}
        >{tag.value} <span class="quick-count">{tag.count}</span></button>
      {/each}
    </div>
  {/if}
  <div class="candidate">
    <label>{t.tagFilterCandidate}<select aria-label={t.tagFilterCandidate} bind:value={candidateKey}>
      <option value="">{t.tagFilterPick}</option>
      {#each ["year", "genre", "custom"] as kind}
        <optgroup label={kindLabel(kind)}>
          {#each candidates.filter(tag => tag.kind === kind) as tag (tag.key)}
            <option value={tag.key} disabled={selected.some(item => item.key === tag.key)}>{tag.value} · {t.tagCandidateCount(tag.count)}</option>
          {/each}
        </optgroup>
      {/each}
    </select></label>
    <button type="button" disabled={!candidateKey} onclick={choose}>{t.tagFilterAdd}</button>
  </div>
  <div class="conditions">
    <label>{t.tagFilterMode}<select aria-label={t.tagFilterMode} value={mode} onchange={event => onmode(event.currentTarget.value as "all" | "any")}>
      <option value="all">{t.tagMatchAll}</option><option value="any">{t.tagMatchAny}</option>
    </select></label>
    <label class="unset"><input type="checkbox" checked={yearUnset} onchange={event => onunset(event.currentTarget.checked)} />{t.tagFilterUnset}</label>
  </div>
  {#if selected.length || yearUnset}
    <div class="selected" aria-label={t.tagSelectedFilters}>
      {#each selected as tag (tag.key)}
        <button type="button" aria-label={t.tagFilterRemove(kindLabel(tag.kind),tag.value)} onclick={() => onremove(tag.key)}>{kindLabel(tag.kind)}: {tag.value} ×</button>
      {/each}
      {#if yearUnset}<button type="button" aria-label={t.tagFilterRemove(t.tagYear,t.tagUnset)} onclick={() => onunset(false)}>{t.tagFilterUnset} ×</button>{/if}
      <button type="button" class="clear" onclick={onclear}>{t.tagFilterClear}</button>
    </div>
  {/if}
  {#if selected.filter(tag => tag.kind === "year").length > 1 && mode === "all"}<p class="hint">{t.tagYearsAllHint}</p>{/if}
</div>
{:else if selected.length || yearUnset}
<div class="active-filter-strip" aria-label={t.tagSelectedFilters}>
  {#each selected as tag (tag.key)}
    <button type="button" class="active-chip" aria-label={t.tagFilterRemove(kindLabel(tag.kind),tag.value)} onclick={() => onremove(tag.key)}>{kindLabel(tag.kind)}: {tag.value} ×</button>
  {/each}
  {#if yearUnset}<button type="button" class="active-chip" aria-label={t.tagFilterRemove(t.tagYear,t.tagUnset)} onclick={() => onunset(false)}>{t.tagFilterUnset} ×</button>{/if}
  <button type="button" class="clear quiet" onclick={onclear}>{t.tagFilterClear}</button>
</div>
{/if}

<style>
  .toggle { flex: 0 0 auto; }
  .toggle.active { outline: 2px solid var(--color-accent-text); outline-offset: -2px; }
  .tag-filter { flex-basis: 100%; display: grid; gap: var(--space-sm); min-width: 0; padding: var(--space-sm); background: var(--color-panel-bg); border: 1px solid var(--color-border); border-radius: var(--radius-sm); }
  .quick-candidates { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
  .quick-tag { display: inline-flex; align-items: center; gap: 0.35rem; }
  .quick-count { font-family: var(--font-mono); font-variant-numeric: tabular-nums; opacity: 0.85; }
  .active-filter-strip { flex-basis: 100%; order: 5; display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); }
  label { display: grid; gap: var(--space-xs); min-width: 0; font-size: var(--font-size-sm); }
  select { min-width: 0; width: 100%; }
  .candidate { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: end; gap: var(--space-xs); }
  .conditions { display: flex; align-items: end; flex-wrap: wrap; gap: var(--space-sm); }
  .unset { display: flex; align-items: center; padding: var(--space-xs) 0; }
  .unset input { width: auto; }
  .selected { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
  .clear { color: var(--color-text-dim); }
  .hint { margin: var(--space-xs) 0; font-size: var(--font-size-sm); color: var(--color-text-dim); }
</style>
