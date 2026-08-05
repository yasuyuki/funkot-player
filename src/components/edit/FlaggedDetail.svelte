<script lang="ts">
  import { store } from "../../lib/state.svelte";
  import { ui } from "../../lib/ui.svelte";
  import { toast } from "../../lib/toast.svelte";
  import ChipEditor from "./ChipEditor.svelte";
  import type { FlaggedTrackRow } from "../../lib/tauri";

  let busy = $state(false);

  let key = $derived(ui.flaggedDetailKey);
  let row = $derived.by((): FlaggedTrackRow | null => {
    const k = key;
    if (!k) return null;
    return (
      store.flaggedRows.find(
        (r) => r.track_hash === k.trackHash && r.role === k.role,
      ) ?? null
    );
  });

  // Baseline captured when the detail opens — cancel restores these values
  // and the corresponding manual flags (so auto-analysed tracks lose `*`).
  // Re-open after 「← 一覧へ」 re-captures from the (already edited) row,
  // matching legacy `showFlaggedDetail`.
  let baselineIntro = $state<number | null>(null);
  let baselineOutro = $state<number | null>(null);
  let baselineIntroManual = $state(false);
  let baselineOutroManual = $state(false);
  let dirty = $state(false);
  let openedKey = $state<string | null>(null);

  $effect(() => {
    const r = row;
    const k = key;
    if (!r || !k) return;
    const id = `${k.trackHash}:${k.role}`;
    if (openedKey === id) return;
    openedKey = id;
    baselineIntro = r.intro_bars;
    baselineOutro = r.outro_structure_bars;
    baselineIntroManual = r.intro_manual;
    baselineOutroManual = r.outro_manual;
    dirty = false;
  });

  let kind = $derived<"intro" | "outro">(
    row?.role === "outgoing" ? "outro" : "intro",
  );
  let roleLabel = $derived(row?.role === "outgoing" ? "出る側" : "入る側");
  let partnersText = $derived.by(() => {
    const r = row;
    if (!r) return "";
    return r.partners
      .map((p) => {
        const left = r.role === "outgoing" ? r.title : p.title;
        const right = r.role === "outgoing" ? p.title : r.title;
        const mul = p.count > 1 ? `×${p.count}` : "";
        return `${left} → ${right}${mul}`;
      })
      .join(" / ");
  });

  let auditioning = $derived(store.player?.auditioning ?? false);
  let auditionHasPair = $derived(
    !!(store.player?.audition_from && store.player?.audition_to),
  );
  let againEnabled = $derived(auditioning || auditionHasPair);

  function goList() {
    ui.closeFlaggedDetail();
  }

  async function onChipPick(value: number) {
    const r = row;
    if (!r?.path) {
      store.lastError = "no path for this track";
      return;
    }
    const prevIntro = r.intro_bars;
    const prevOutro = r.outro_structure_bars;
    const prevManual =
      kind === "intro" ? r.intro_manual : r.outro_manual;
    const introBars = kind === "intro" ? value : null;
    const outroStructureBars = kind === "outro" ? value : null;
    const updated = await store.doSetBars(r.path, introBars, outroStructureBars);
    if (!updated) return;
    dirty = true;
    const path = r.path;
    toast.show("変更しました", async () => {
      const restored = await store.doSetBars(
        path,
        kind === "intro" ? prevIntro : null,
        kind === "outro" ? prevOutro : null,
        prevManual,
      );
      return restored !== null;
    });
  }

  async function listenPartner(partnerPath: string | null, outgoing: boolean) {
    const r = row;
    if (!r?.path || !partnerPath || busy) return;
    busy = true;
    try {
      const fromPath = outgoing ? r.path : partnerPath;
      const toPath = outgoing ? partnerPath : r.path;
      await store.doAuditionTransition(fromPath, toPath);
    } finally {
      busy = false;
    }
  }

  async function onAgain() {
    if (busy || !againEnabled) return;
    busy = true;
    try {
      await store.doAuditionAgain();
    } finally {
      busy = false;
    }
  }

  async function onConfirm() {
    const r = row;
    if (!r || busy) return;
    busy = true;
    try {
      if (!r.path) {
        store.lastError = "no path for this track";
        return;
      }
      const introBars = r.role === "outgoing" ? null : r.intro_bars;
      const outroStructureBars = r.role === "outgoing" ? r.outro_structure_bars : null;
      const updated = await store.doSetBars(r.path, introBars, outroStructureBars);
      if (!updated) return;
      const n = await store.doDismissFlags(r.track_hash, r.role);
      // Legacy stays on detail when dismiss_flags throws; do not close on null.
      if (n === null) return;
      ui.closeFlaggedDetail();
      if (n) {
        toast.show("削除しました", () => store.doUndoLastDismiss());
      }
    } finally {
      busy = false;
    }
  }

  async function onCancel() {
    const r = row;
    if (!r || busy) return;
    busy = true;
    try {
      // Drop chip undo toast first so 「取消」cannot rewrite bars after
      // baseline restore (legacy `hideFlagToast` before set_bars).
      toast.dismiss();
      if (dirty) {
        if (!r.path) {
          store.lastError = "no path for this track";
          return;
        }
        const introBars = kind === "intro" ? baselineIntro : null;
        const outroStructureBars = kind === "outro" ? baselineOutro : null;
        const markManual =
          kind === "intro" ? baselineIntroManual : baselineOutroManual;
        const restored = await store.doSetBars(
          r.path,
          introBars,
          outroStructureBars,
          markManual,
        );
        // Legacy stays on detail when baseline restore throws.
        if (!restored) return;
      }
      ui.closeFlaggedDetail();
    } finally {
      busy = false;
    }
  }
</script>

{#if row}
  <button type="button" class="linkish" onclick={goList}>← 一覧へ</button>

  <div class="meta">
    <div>
      <strong>{row.title}</strong>
      {#if row.artist}<span class="artist"> {row.artist}</span>{/if}
    </div>
    <div>
      {roleLabel} · {row.count}回
      {#if row.low_confidence}<span class="warn"> ⚠</span>{/if}
    </div>
    <div>{partnersText}</div>
  </div>

  <ChipEditor
    {kind}
    current={kind === "outro" ? row.outro_structure_bars : row.intro_bars}
    manual={kind === "outro" ? row.outro_manual : row.intro_manual}
    onPick={onChipPick}
  />

  <div class="actions">
    {#each row.partners as partner (partner.track_hash)}
      {@const outgoing = row.role === "outgoing"}
      {@const disabled = !!(partner.missing || !partner.path || !row.path)}
      <button
        type="button"
        disabled={disabled || busy}
        onclick={() => listenPartner(partner.path, outgoing)}
      >
        {outgoing
          ? `「${partner.title}」へのつなぎを聴く`
          : `「${partner.title}」からのつなぎを聴く`}
      </button>
    {/each}
    <button
      type="button"
      class="again"
      disabled={!againEnabled || busy}
      onclick={onAgain}
    >もう一度聴く</button>
  </div>

  <div class="actions">
    <button type="button" class="confirm" disabled={busy} onclick={onConfirm}>
      〔確定〕
    </button>
    <button type="button" class="cancel" disabled={busy} onclick={onCancel}>
      〔キャンセル〕
    </button>
  </div>
{/if}

<style>
  .linkish {
    width: auto;
    font-size: inherit;
    padding: 0;
    background: transparent;
    color: var(--color-link);
    text-decoration: underline;
    border-radius: 0;
    margin-top: var(--space-md);
  }

  .meta {
    font-size: var(--font-size-md);
    color: var(--color-text-dim);
    margin: var(--space-sm) 0 var(--space-lg);
  }

  .artist {
    color: var(--color-text-dim);
    font-size: var(--font-size-sm);
  }

  .warn {
    color: var(--color-flagged-warn);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-md);
    margin-top: var(--space-lg);
  }

  .actions button {
    width: auto;
    font-size: var(--font-size-md);
    padding: var(--space-md) var(--space-lg);
    background: var(--color-tab-bg);
    color: var(--color-text);
  }

  .actions button:disabled {
    background: var(--color-transport-disabled-bg);
    color: var(--color-transport-disabled-text);
  }

  .confirm {
    background: var(--color-transport-secondary-bg) !important;
    color: var(--color-transport-secondary-text) !important;
  }
</style>
