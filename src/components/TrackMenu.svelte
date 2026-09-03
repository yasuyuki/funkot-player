<script lang="ts">
  // The row menu: pick Funkot or 非Funkot for one track, from wherever the
  // track is listed. Opened by right-click or long press (`createLongPress`
  // in the panes), so it is drawn at the pointer rather than under a button.
  //
  // What it writes is the *human* label — the same `set_label` the now-playing
  // badge and the edit pane's label column write, with the same undo toast.
  // The label also moves `is_funkot`, which is what greys a library row out
  // and what the non-Funkot gate reads, so the answer is visible immediately.
  import { store } from "../lib/state.svelte";
  import { toast } from "../lib/toast.svelte";
  import { i18n } from "../lib/i18n.svelte";
  import { clampMenuPosition, shownVerdict, type MenuPoint } from "../lib/track-menu";

  let {
    path,
    at,
    onclose,
  }: { path: string; at: MenuPoint; onclose: () => void } = $props();

  let t = $derived(i18n.t);
  let row = $derived(store.trackForPath(path));
  let current = $derived(shownVerdict(row));
  let title = $derived(store.titleForPath(path));
  let busy = $state(false);
  let menuEl = $state<HTMLDivElement | null>(null);
  /// Null until the popup has been measured — its size depends on the track
  /// title, so where it fits cannot be worked out before it is in the DOM.
  /// Hidden rather than mispositioned for that one frame.
  let pos = $state<{ left: number; top: number } | null>(null);

  $effect(() => {
    const el = menuEl;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    pos = clampMenuPosition(
      at,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
  });

  // Closed by a press *outside* it, not by a click: on Android the finger
  // that opened the menu is still down, and the click its release produces
  // would shut the menu in the same moment it appeared. Every real outside
  // interaction starts with a pointerdown, so nothing is lost.
  $effect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (menuEl && target instanceof Node && menuEl.contains(target)) return;
      onclose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onclose();
    };
    // Fixed to the viewport: after a scroll it would be hanging over an
    // unrelated row, still holding the first row's path.
    const onScroll = () => onclose();
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll);
    };
  });

  async function pick(verdict: boolean) {
    if (busy) return;
    busy = true;
    // Read before the await: `row` follows the store, which this call moves.
    const previous = row?.label ?? null;
    try {
      const updated = await store.doSetLabel(path, verdict);
      if (!updated) return;
      toast.show(verdict ? t.labeledFunkot : t.labeledNotFunkot, async () => {
        const restored = await store.doSetLabel(path, previous);
        return restored !== null;
      });
    } finally {
      busy = false;
      onclose();
    }
  }
</script>

<div
  class="menu"
  role="menu"
  aria-label={t.labelMenuLabel}
  bind:this={menuEl}
  style:left={`${pos?.left ?? at.x}px`}
  style:top={`${pos?.top ?? at.y}px`}
  style:visibility={pos === null ? "hidden" : "visible"}
>
  <!-- Which track this is about. The menu covers whatever it is drawn over,
       including the row it came from. -->
  <p class="for">{title}</p>
  <button
    type="button"
    role="menuitemradio"
    aria-checked={current === true}
    disabled={busy}
    onclick={() => pick(true)}
  >
    <span class="tick" aria-hidden="true">{current === true ? "✓" : ""}</span>
    {t.funkot}
  </button>
  <button
    type="button"
    role="menuitemradio"
    aria-checked={current === false}
    disabled={busy}
    onclick={() => pick(false)}
  >
    <span class="tick" aria-hidden="true">{current === false ? "✓" : ""}</span>
    {t.notFunkot}
  </button>
</div>

<style>
  /* Fixed, not absolute: the coordinates come from a pointer event, and the
     panes it is opened from are inside the centred `#app` column. */
  .menu {
    position: fixed;
    z-index: 20;
    min-width: 10rem;
    max-width: 16rem;
    padding: var(--space-xs);
    background: var(--color-menu-bg);
    border: 1px solid var(--color-menu-border);
    border-radius: var(--radius-sm);
  }

  .for {
    margin: 0;
    padding: var(--space-xs) var(--space-md);
    font-size: var(--font-size-sm);
    color: var(--color-text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Same item shape as OverflowMenu's, including the `:active` fill that
     stands in for tokens.css's brightness filter on a transparent button. */
  .menu button {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    width: 100%;
    font-size: var(--font-size-md);
    padding: var(--space-sm) var(--space-md);
    background: transparent;
    color: var(--color-text);
    text-align: left;
    border-radius: var(--radius-sm);
  }

  .menu button:active {
    background: var(--color-transport-secondary-bg);
  }

  /* Fixed width so both items' text starts at the same place, ticked or not. */
  .tick {
    flex: 0 0 auto;
    width: 1rem;
    color: var(--color-accent-text);
  }
</style>
