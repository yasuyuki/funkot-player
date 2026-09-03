import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { transformWithEsbuild } from "vite";

const sourceUrl = new URL("./track-menu.ts", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const transformed = await transformWithEsbuild(source, sourceUrl.pathname, {
  loader: "ts",
  format: "esm",
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString("base64")}`;
const {
  LONG_PRESS_MS,
  LONG_PRESS_MOVE_PX,
  MENU_GAP_PX,
  clampMenuPosition,
  createLongPress,
  shownVerdict,
} = await import(moduleUrl);

const MENU = { width: 200, height: 120 };
const VIEWPORT = { width: 400, height: 800 };

test("the popup hangs off the pointer when there is room", () => {
  const pos = clampMenuPosition({ x: 30, y: 40 }, MENU, VIEWPORT);
  assert.deepEqual(pos, { left: 30 + MENU_GAP_PX, top: 40 + MENU_GAP_PX });
});

test("it flips to the other side of the pointer near an edge", () => {
  // 380 + gap + 200 is past the right edge, 790 + gap + 120 past the bottom.
  const pos = clampMenuPosition({ x: 380, y: 790 }, MENU, VIEWPORT);
  assert.deepEqual(pos, {
    left: 380 - MENU_GAP_PX - MENU.width,
    top: 790 - MENU_GAP_PX - MENU.height,
  });
});

test("a menu wider than the viewport is clamped, not pushed off screen", () => {
  const pos = clampMenuPosition({ x: 10, y: 10 }, { width: 600, height: 120 }, VIEWPORT);
  assert.equal(pos.left, MENU_GAP_PX);
  assert.equal(pos.top, 10 + MENU_GAP_PX);
});

test("the human label wins over analysis, and analysis fills in for no label", () => {
  assert.equal(shownVerdict({ is_funkot: true, label: false }), false);
  assert.equal(shownVerdict({ is_funkot: false, label: true }), true);
  assert.equal(shownVerdict({ is_funkot: false, label: null }), false);
  assert.equal(shownVerdict({ is_funkot: true, label: null }), true);
  // "No such row" rather than "unlabeled": the caller draws nothing.
  assert.equal(shownVerdict(undefined), null);
  assert.equal(shownVerdict(null), null);
});

test("a held finger opens the menu once, at the point it went down", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const opened = [];
  const press = createLongPress((key, at) => opened.push([key, at]));

  press.down({ clientX: 5, clientY: 6, pointerType: "touch" }, "/a");
  t.mock.timers.tick(LONG_PRESS_MS - 1);
  assert.deepEqual(opened, []);
  t.mock.timers.tick(1);
  assert.deepEqual(opened, [["/a", { x: 5, y: 6 }]]);

  // Android sends `contextmenu` for the same press; it must not open a second.
  let prevented = false;
  press.cancel();
  press.context({ clientX: 5, clientY: 6, preventDefault: () => (prevented = true) }, "/a");
  assert.equal(prevented, true);
  assert.equal(opened.length, 1);
});

test("a mouse is left to contextmenu, which opens the menu itself", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const opened = [];
  const press = createLongPress((key, at) => opened.push([key, at]));

  press.down({ clientX: 1, clientY: 2, pointerType: "mouse" }, "/a");
  t.mock.timers.tick(LONG_PRESS_MS * 2);
  assert.deepEqual(opened, []);

  press.context({ clientX: 7, clientY: 8, preventDefault: () => {} }, "/a");
  assert.deepEqual(opened, [["/a", { x: 7, y: 8 }]]);
});

test("scrolling away from the press cancels it, a steady finger does not", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const opened = [];
  const press = createLongPress((key, at) => opened.push([key, at]));

  press.down({ clientX: 0, clientY: 0, pointerType: "touch" }, "/a");
  press.move({ clientX: 0, clientY: LONG_PRESS_MOVE_PX });
  t.mock.timers.tick(LONG_PRESS_MS);
  assert.equal(opened.length, 1, "within tolerance the press still counts");

  press.down({ clientX: 0, clientY: 0, pointerType: "touch" }, "/b");
  press.move({ clientX: 0, clientY: LONG_PRESS_MOVE_PX + 1 });
  t.mock.timers.tick(LONG_PRESS_MS);
  assert.equal(opened.length, 1, "past tolerance it is a scroll");
});

test("a release before the threshold is a tap, and opens nothing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const opened = [];
  const press = createLongPress((key, at) => opened.push([key, at]));

  press.down({ clientX: 0, clientY: 0, pointerType: "touch" }, "/a");
  t.mock.timers.tick(LONG_PRESS_MS - 50);
  press.cancel();
  t.mock.timers.tick(LONG_PRESS_MS);
  assert.deepEqual(opened, []);
});

test("contextmenu arriving first drops the pending timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const opened = [];
  const press = createLongPress((key, at) => opened.push([key, at]));

  // Chrome's own long-press threshold can beat ours to it.
  press.down({ clientX: 3, clientY: 4, pointerType: "touch" }, "/a");
  t.mock.timers.tick(LONG_PRESS_MS - 100);
  press.context({ clientX: 3, clientY: 4, preventDefault: () => {} }, "/a");
  t.mock.timers.tick(LONG_PRESS_MS);
  assert.deepEqual(opened, [["/a", { x: 3, y: 4 }]]);
});
