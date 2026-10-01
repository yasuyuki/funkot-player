import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { transformWithEsbuild } from "vite";

const themeUrl = new URL("./theme.svelte.ts", import.meta.url);
const source = await readFile(themeUrl, "utf8");
const transformed = await transformWithEsbuild(source, themeUrl.pathname, {
  loader: "ts",
  format: "esm",
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString("base64")}`;
const {
  THEME_STORAGE_KEY,
  createThemeController,
  parseThemePreference,
  readThemePreference,
  resolveTheme,
} = await import(moduleUrl);

function createRoot() {
  const classes = new Set();
  return {
    dataset: {},
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
        return Boolean(force);
      },
      contains(name) {
        return classes.has(name);
      },
    },
    style: { colorScheme: "" },
  };
}

function createMedia(matches) {
  let listener;
  return {
    matches,
    addEventListener(type, nextListener) {
      assert.equal(type, "change");
      listener = nextListener;
    },
    change(nextMatches) {
      this.matches = nextMatches;
      listener();
    },
  };
}

test("theme preferences validate and resolve with dark as the fallback", () => {
  assert.equal(parseThemePreference("light"), "light");
  assert.equal(parseThemePreference("unknown"), "dark");
  assert.equal(parseThemePreference(null), "dark");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
});

test("unreadable storage falls back to dark", () => {
  assert.equal(readThemePreference({ getItem: () => "unknown" }), "dark");
  assert.equal(readThemePreference({ getItem: () => { throw new Error("blocked"); } }), "dark");
});

test("system changes apply only while system is selected", () => {
  const root = createRoot();
  const media = createMedia(true);
  const stored = new Map([[THEME_STORAGE_KEY, "system"]]);
  const controller = createThemeController({
    root,
    storage: {
      getItem: key => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
    },
    colorSchemeMedia: media,
  });

  assert.equal(root.dataset.theme, "dark");
  assert.equal(root.classList.contains("dark"), true);
  assert.equal(root.style.colorScheme, "dark");
  media.change(false);
  assert.equal(root.dataset.theme, "light");

  controller.setPreference("dark");
  media.change(false);
  assert.equal(root.dataset.theme, "dark");
  assert.equal(stored.get(THEME_STORAGE_KEY), "dark");
});

test("a failed write still applies the selected theme", () => {
  const root = createRoot();
  const controller = createThemeController({
    root,
    storage: {
      getItem: () => null,
      setItem: () => { throw new Error("blocked"); },
    },
    colorSchemeMedia: createMedia(false),
  });

  controller.setPreference("light");
  assert.equal(root.dataset.theme, "light");
  assert.equal(root.classList.contains("dark"), false);
  assert.equal(root.style.colorScheme, "light");
});
