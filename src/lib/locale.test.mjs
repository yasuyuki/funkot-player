import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { transformWithEsbuild } from "vite";

const localeUrl = new URL("./locale.ts", import.meta.url);
const source = await readFile(localeUrl, "utf8");
const transformed = await transformWithEsbuild(source, localeUrl.pathname, {
  loader: "ts",
  format: "esm",
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString("base64")}`;
const { detectLocale, nextLocale, isLocale } = await import(moduleUrl);

test("detectLocale strips the region subtag", () => {
  assert.equal(detectLocale("ja-JP"), "ja");
  assert.equal(detectLocale("id-ID"), "id");
  assert.equal(detectLocale("en-GB"), "en");
  assert.equal(detectLocale("en_US"), "en");
});

test("detectLocale accepts Indonesian's superseded `in` code", () => {
  // Java normalises `id` to `in`, so an Android WebView can report either.
  assert.equal(detectLocale("in"), "id");
  assert.equal(detectLocale("in-ID"), "id");
});

test("detectLocale falls back to English", () => {
  assert.equal(detectLocale("fr-FR"), "en");
  assert.equal(detectLocale(""), "en");
  assert.equal(detectLocale(null), "en");
  assert.equal(detectLocale(undefined), "en");
});

test("detectLocale is case-insensitive", () => {
  assert.equal(detectLocale("JA-JP"), "ja");
  assert.equal(detectLocale("ID"), "id");
});

test("nextLocale cycles through every locale and wraps", () => {
  const seen = [nextLocale("en"), nextLocale("ja"), nextLocale("id")];
  assert.deepEqual(seen, ["ja", "id", "en"]);
});

test("isLocale rejects unsupported tags", () => {
  assert.equal(isLocale("ja"), true);
  assert.equal(isLocale("ja-JP"), false);
  assert.equal(isLocale("fr"), false);
  assert.equal(isLocale(null), false);
});
