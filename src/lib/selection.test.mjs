import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { transformWithEsbuild } from "vite";

const sourceUrl = new URL("./selection.ts", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const transformed = await transformWithEsbuild(source, sourceUrl.pathname, {
  loader: "ts",
  format: "esm",
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString("base64")}`;
const { addAll, clearSelection, selectAllState, selectedInOrder, toggleSelected } =
  await import(moduleUrl);

test("toggle adds then removes, and returns a new set each time", () => {
  const empty = new Set();
  const one = toggleSelected(empty, "/a");
  assert.deepEqual([...one], ["/a"]);
  // The caller reassigns, so the original must be untouched.
  assert.equal(empty.size, 0);
  assert.equal(toggleSelected(one, "/a").size, 0);
});

test("addAll is idempotent and keeps what was already selected", () => {
  const selected = addAll(new Set(["/a"]), ["/a", "/b"]);
  assert.deepEqual([...selected].sort(), ["/a", "/b"]);
});

test("clearSelection empties it", () => {
  assert.equal(clearSelection().size, 0);
});

test("selectedInOrder follows the list, not the click order", () => {
  const selected = new Set(["/c", "/a"]);
  assert.deepEqual(selectedInOrder(selected, ["/a", "/b", "/c"]), ["/a", "/c"]);
});

test("selectedInOrder drops a selection that is no longer listed", () => {
  // A track that left the library cannot be queued.
  assert.deepEqual(selectedInOrder(new Set(["/gone", "/a"]), ["/a"]), ["/a"]);
});

test("selectedInOrder returns a repeated path once", () => {
  // The history log lists the same track on every play.
  assert.deepEqual(selectedInOrder(new Set(["/a"]), ["/a", "/b", "/a"]), ["/a"]);
});

test("selectAllState reports none, some, all", () => {
  const visible = ["/a", "/b"];
  assert.equal(selectAllState(new Set(), visible), "none");
  assert.equal(selectAllState(new Set(["/a"]), visible), "some");
  assert.equal(selectAllState(new Set(["/a", "/b"]), visible), "all");
});

test("selectAllState counts a repeated path once", () => {
  assert.equal(selectAllState(new Set(["/a"]), ["/a", "/a"]), "all");
});

test("selectAllState is none when nothing is on screen", () => {
  // Otherwise an empty, filtered-to-nothing list would offer to deselect.
  assert.equal(selectAllState(new Set(["/a"]), []), "none");
});

test("selectAllState ignores selections that are filtered out", () => {
  assert.equal(selectAllState(new Set(["/a", "/hidden"]), ["/a"]), "all");
});
