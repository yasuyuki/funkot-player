// The right-click / long-press track menu, minus the DOM.
//
// Two things the library and the history pane both need and neither should
// own: the gesture that opens the menu, and where the popup lands once it is
// open. A mouse right-click arrives as one `contextmenu` event and needs
// nothing; a finger has to be timed, and told apart from the start of a
// scroll. Keeping both here is what makes the two panes behave identically —
// and, being rune-free, testable under the repo's node:test harness.

/// How long a finger stays down before the menu opens. Chrome's own
/// long-press threshold is about this, so a phone user already expects it.
export const LONG_PRESS_MS = 500;

/// Movement that turns a press into a scroll. A list of rows is scrolled far
/// more often than it is long-pressed, so the press loses ties.
export const LONG_PRESS_MOVE_PX = 10;

/// Distance between the pointer and the popup's near corner.
///
/// Not zero, and not decoration: on Android the menu appears while the finger
/// is still down, and the release afterwards produces a click at that same
/// point. With the corner under the finger that click can land on a menu
/// item, which would label a track the listener only meant to look at.
export const MENU_GAP_PX = 12;

export interface MenuPoint {
  x: number;
  y: number;
}

/// Where to draw the popup so it stays on screen.
///
/// The pointer is the near corner (offset by [`MENU_GAP_PX`]); when that
/// would overflow, the menu flips to the other side of the pointer instead of
/// being nudged, which is what keeps it from covering the row it belongs to.
/// The clamp afterwards is for the case where neither side fits.
export function clampMenuPosition(
  at: MenuPoint,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  gap: number = MENU_GAP_PX,
): { left: number; top: number } {
  const right = at.x + gap;
  const below = at.y + gap;
  const left = right + menu.width > viewport.width ? at.x - gap - menu.width : right;
  const top = below + menu.height > viewport.height ? at.y - gap - menu.height : below;
  return {
    left: Math.max(gap, Math.min(left, viewport.width - menu.width - gap)),
    top: Math.max(gap, Math.min(top, viewport.height - menu.height - gap)),
  };
}

/// What the menu shows as the current answer: the human label when there is
/// one, else what analysis decided. Same rule as the now-playing badge
/// (`shownFunkot` in `NowCard.svelte`), so the two never disagree about the
/// same track. `null` is "no such row", not "unlabeled".
export function shownVerdict(
  row: { is_funkot: boolean; label: boolean | null } | null | undefined,
): boolean | null {
  if (!row) return null;
  return row.label ?? row.is_funkot;
}

/// The subset of `PointerEvent` the gesture reads. Narrow on purpose: a real
/// event satisfies it, and so does a plain object in a test.
interface PressPoint {
  clientX: number;
  clientY: number;
}

interface PointerPress extends PressPoint {
  pointerType?: string;
}

interface ContextPress extends PressPoint {
  preventDefault(): void;
}

export interface LongPress<Key> {
  down(event: PointerPress, key: Key): void;
  move(event: PressPoint): void;
  cancel(): void;
  context(event: ContextPress, key: Key): void;
}

/// Gesture recogniser for one pane. `open` is called exactly once per
/// gesture, whichever way the gesture arrives.
///
/// A mouse is left to `contextmenu` — holding the left button down over a row
/// is not a request for anything. A finger runs the timer, and Android's
/// WebView *also* fires `contextmenu` for the same press: whichever comes
/// first wins and the other is swallowed, which is why `opened` outlives the
/// timer.
export function createLongPress<Key>(
  open: (key: Key, at: MenuPoint) => void,
): LongPress<Key> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: PressPoint | null = null;
  let opened = false;

  function stop(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    start = null;
  }

  return {
    down(event, key) {
      stop();
      opened = false;
      if (event.pointerType === "mouse") return;
      const at = { x: event.clientX, y: event.clientY };
      start = { clientX: at.x, clientY: at.y };
      timer = setTimeout(() => {
        timer = null;
        start = null;
        opened = true;
        open(key, at);
      }, LONG_PRESS_MS);
    },

    move(event) {
      if (start === null) return;
      const dx = event.clientX - start.clientX;
      const dy = event.clientY - start.clientY;
      if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_PX) stop();
    },

    cancel() {
      // Deliberately leaves `opened` alone: the release that ends a long
      // press is a `pointerup`, and the `contextmenu` Android sends for that
      // same press arrives after it.
      stop();
    },

    context(event, key) {
      // Always ours. The WebView's own menu has nothing to offer over a row,
      // and on Android this is the gesture the timer may already have served.
      event.preventDefault();
      const already = opened;
      stop();
      opened = false;
      if (already) return;
      open(key, { x: event.clientX, y: event.clientY });
    },
  };
}
