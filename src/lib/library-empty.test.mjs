import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { transformWithEsbuild } from "vite";

const sourceUrl = new URL("./library-empty.ts", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const transformed = await transformWithEsbuild(source, sourceUrl.pathname, {
  loader: "ts",
  format: "esm",
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString("base64")}`;
const { showLibraryEmpty } = await import(moduleUrl);

test("a finished empty listing shows no-tracks", () => {
  assert.equal(showLibraryEmpty(0, false, null), true);
});

test("walking with found 0 is not an empty library", () => {
  assert.equal(
    showLibraryEmpty(0, false, { phase: "walking", found: 0, done: 0 }),
    false,
  );
});

test("hashing hides no-tracks even before rows land", () => {
  assert.equal(
    showLibraryEmpty(0, false, { phase: "hashing", found: 3, done: 1 }),
    false,
  );
});

test("a listing that already has rows is never empty", () => {
  assert.equal(showLibraryEmpty(1, false, null), false);
  assert.equal(
    showLibraryEmpty(1, false, { phase: "walking", found: 0, done: 0 }),
    false,
  );
});

test("the music-folder gate owns the empty pane instead", () => {
  assert.equal(showLibraryEmpty(0, true, null), false);
});
