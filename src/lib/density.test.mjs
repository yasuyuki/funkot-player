import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { transformWithEsbuild } from "vite";

const url = new URL("./density.ts", import.meta.url);
const transformed = await transformWithEsbuild(await readFile(url, "utf8"), url.pathname, { loader: "ts", format: "esm" });
const { DENSITY_STORAGE_KEY, applyDensity, readDensityPreference, saveDensityPreference } =
  await import(`data:text/javascript;base64,${Buffer.from(transformed.code).toString("base64")}`);

function storageWith(value) {
  const values = new Map(value === undefined ? [] : [[DENSITY_STORAGE_KEY, value]]);
  return { getItem: key => values.get(key) ?? null, setItem: (key, next) => values.set(key, next), values };
}

test("an absent, unknown or unreadable preference follows the pointer", () => {
  assert.equal(readDensityPreference(storageWith(undefined)), "auto");
  assert.equal(readDensityPreference(storageWith("compact")), "auto");
  assert.equal(readDensityPreference({ getItem() { throw new Error("blocked"); } }), "auto");
  assert.equal(readDensityPreference(null), "auto");
});

test("a stored override is read back", () => {
  assert.equal(readDensityPreference(storageWith("mouse")), "mouse");
  assert.equal(readDensityPreference(storageWith("touch")), "touch");
});

test("an override marks the root and auto removes the mark", () => {
  const root = { dataset: {} };
  applyDensity(root, "touch");
  assert.equal(root.dataset.density, "touch");
  applyDensity(root, "auto");
  assert.equal("density" in root.dataset, false);
});

test("saving stores the choice and applies it even when storage fails", () => {
  const root = { dataset: {} };
  const storage = storageWith(undefined);
  saveDensityPreference(root, storage, "mouse");
  assert.equal(storage.values.get(DENSITY_STORAGE_KEY), "mouse");
  assert.equal(root.dataset.density, "mouse");
  saveDensityPreference(root, { setItem() { throw new Error("full"); } }, "touch");
  assert.equal(root.dataset.density, "touch");
});
