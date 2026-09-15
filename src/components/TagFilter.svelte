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
  function kindLabel(kind: string) { return kind === "year" ? t.tagYear : kind === "genre" ? t.tagGenre : t.tagCustom; }
  function choose() {
    const candidate = candidates.find(tag => tag.key === candidateKey);
    if (candidate) onchoose(candidate);
    candidateKey = "";
  }
</script>

<div class="tag-filter">
  <details bind:open={expanded}>
    <summary>{t.tagFilterTitle}</summary>
    {#if expanded}
      <p class="hint">{t.tagCandidatePopulation}</p>
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
    {/if}
  </details>
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

<style>
  .tag-filter { display: grid; gap: var(--space-sm); margin-bottom: var(--space-md); min-width: 0; }
  summary { cursor: pointer; font-size: var(--font-size-sm); color: var(--color-text-dim); }
  label { display: grid; gap: var(--space-xs); min-width: 0; font-size: var(--font-size-sm); }
  select { box-sizing: border-box; min-width: 0; max-width: 100%; width: 100%; padding: var(--space-xs); background: var(--color-menu-bg); color: var(--color-text); border: 1px solid var(--color-border); }
  .candidate { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: end; gap: var(--space-xs); }
  .conditions { display: flex; align-items: end; flex-wrap: wrap; gap: var(--space-sm); }
  .unset { display: flex; align-items: center; padding: var(--space-xs) 0; }
  .unset input { width: auto; }
  .selected { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
  button { width: auto; max-width: 100%; padding: var(--space-xs) var(--space-sm); background: var(--color-menu-bg); color: var(--color-text); border: 1px solid var(--color-border); font-size: var(--font-size-sm); overflow-wrap: anywhere; }
  .clear { color: var(--color-text-dim); }
  .hint { margin: var(--space-xs) 0; font-size: var(--font-size-sm); color: var(--color-text-dim); }
</style>
