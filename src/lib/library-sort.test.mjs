import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { transformWithEsbuild } from "vite";

const sourceUrl = new URL("./library-sort.ts", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const transformed = await transformWithEsbuild(source, sourceUrl.pathname, {
  loader: "ts",
  format: "esm",
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString("base64")}`;
const { nextLibrarySortKey, preserveLibraryAddedOrder, sortLibraryRows } =
  await import(moduleUrl);

function row(path, title, artist, addedOrder) {
  return { path, title, artist, added_order: addedOrder };
}

test("recent puts newer batches first and missing orders last", () => {
  const rows = [
    row("/old", "Old", "", 1),
    row("/missing", "Missing", "", null),
    row("/new", "New", "", 2),
  ];
  assert.deepEqual(
    sortLibraryRows(rows, "recent").map((r) => r.path),
    ["/new", "/old", "/missing"],
  );
});

test("recent breaks a scan-batch tie by title then path", () => {
  const stamp = 2;
  const rows = [
    row("/z", "Beta", "", stamp),
    row("/b", "Alpha", "", stamp),
    row("/a", "Alpha", "", stamp),
  ];
  assert.deepEqual(
    sortLibraryRows(rows, "recent").map((r) => r.path),
    ["/a", "/b", "/z"],
  );
});

test("sort control cycles recent, title, artist", () => {
  assert.equal(nextLibrarySortKey("recent"), "title");
  assert.equal(nextLibrarySortKey("title"), "artist");
  assert.equal(nextLibrarySortKey("artist"), "recent");
});

test("partial row replacement preserves a known addition time", () => {
  const previous = row("/a", "Before", "", 2);
  const incoming = row("/a", "After", "", null);
  const merged = preserveLibraryAddedOrder(previous, incoming);
  assert.equal(merged.title, "After");
  assert.equal(merged.added_order, previous.added_order);

  const authoritative = row("/a", "Newest", "", 3);
  assert.equal(
    preserveLibraryAddedOrder(previous, authoritative).added_order,
    authoritative.added_order,
  );
});
