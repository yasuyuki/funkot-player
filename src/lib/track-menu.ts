/// How long a finger stays down before the menu opens. Chrome's own
/// long-press threshold is about this, so a phone user already expects it.
export const LONG_PRESS_MS = 500;

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

/// The viewport edges covered by system bars or a cutout (`--safe-*` in tokens.css).
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

export function clampMenuPosition(
  at: MenuPoint,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  insets: Insets = NO_INSETS,
  gap: number = MENU_GAP_PX,
): { left: number; top: number } {
  const minLeft = insets.left + gap;
  const minTop = insets.top + gap;
  const maxRight = viewport.width - insets.right - gap;
  const maxBottom = viewport.height - insets.bottom - gap;
  const right = at.x + gap;
  const below = at.y + gap;
  const left = right + menu.width > maxRight ? at.x - gap - menu.width : right;
  const top = below + menu.height > maxBottom ? at.y - gap - menu.height : below;
  return {
    left: Math.max(minLeft, Math.min(left, maxRight - menu.width)),
    top: Math.max(minTop, Math.min(top, maxBottom - menu.height)),
  };
}

export function shownVerdict(
  row: { is_funkot: boolean; label: boolean | null } | null | undefined,
): boolean | null {
  if (!row) return null;
  return row.label ?? row.is_funkot;
}

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
