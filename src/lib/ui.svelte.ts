// Screen-only UI state: menu open, log panel open, and the temporary
// strip/transport order toggle (plan section 3b). None of this is playback
// state, so it lives here rather than in `state.svelte.ts` -- there is
// nothing here that needs the poll loop or its "what changed since last
// time" guard.
//
// `stripFirst` exists only so plan section 3b's TransitionStrip-vs-Transport
// order can be compared on a real device without a rebuild. Once that
// decision is made, delete this flag, the ⋮ menu item that flips it
// (`OverflowMenu.svelte`), and hard-code the chosen order in `App.svelte`.

const STRIP_FIRST_KEY = "funkot.layout.stripFirst";

/// Reads the persisted layout choice. Wrapped in try/catch: `localStorage`
/// can throw (private/restricted WebView contexts) rather than just being
/// absent, and a screen-order preference is not worth crashing the app over
/// -- fall back to the default (strip above transport) on any failure.
function loadStripFirst(): boolean {
  try {
    const stored = localStorage.getItem(STRIP_FIRST_KEY);
    if (stored === null) return true;
    return stored === "true";
  } catch {
    return true;
  }
}

function saveStripFirst(value: boolean): void {
  try {
    localStorage.setItem(STRIP_FIRST_KEY, String(value));
  } catch {
    // See `loadStripFirst`: losing the persisted choice is fine, crashing
    // is not.
  }
}

class UiStore {
  menuOpen = $state(false);
  logOpen = $state(false);
  /// Whether TransitionStrip renders above Transport. See file header.
  stripFirst = $state(loadStripFirst());

  toggleStripFirst(): void {
    this.stripFirst = !this.stripFirst;
    saveStripFirst(this.stripFirst);
  }
}

export const ui = new UiStore();
