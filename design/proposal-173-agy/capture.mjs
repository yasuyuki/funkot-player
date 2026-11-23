// Renders all Overprint Index (#173 agy) prototype states to PNG.
// Usage: node capture.mjs [path-to-playwright]
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const pwPath = process.argv[2] || "C:/Users/flame/work/funkot-player/node_modules/playwright";
const { chromium } = require(pwPath);
const page0 = pathToFileURL(resolve("index.html")).href;
mkdirSync("shots", { recursive: true });

const desktopStates = [
  "base", "search-basic", "search-disambig", "a", "eight", "eight-manage", "zero",
  "detail", "detail-tech", "detail-many",
  "edit-single", "edit-many", "edit-year-conflict", "edit-bulk", "edit-conflict", "edit-identity", "edit-readonly",
  "a-select", "loading", "error",
];
const narrowStates = [
  "base", "search-basic", "search-disambig", "a", "eight", "eight-manage", "zero",
  "detail", "detail-many",
  "edit-single", "edit-many", "edit-year-conflict", "edit-bulk", "edit-conflict",
];
const sets = [
  { tag: "desktop", vp: { width: 1280, height: 900 }, dpr: 1, s: desktopStates },
  { tag: "desktop-dark", vp: { width: 1280, height: 900 }, dpr: 1, theme: "dark", s: ["a", "eight-manage", "detail", "edit-single"] },
  { tag: "narrow", vp: { width: 412, height: 915 }, dpr: 2, touch: true, s: narrowStates },
  { tag: "zoom200", vp: { width: 640, height: 450 }, dpr: 2, s: ["a", "detail", "edit-single", "edit-conflict"] },
];

const browser = await chromium.launch();
const errors = [];
for (const set of sets) {
  const ctx = await browser.newContext({
    viewport: set.vp,
    deviceScaleFactor: set.dpr,
    hasTouch: !!set.touch,
    isMobile: !!set.touch,
    reducedMotion: "reduce",
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${set.tag}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${set.tag}: ${m.text()}`); });
  for (const s of set.s) {
    await page.goto(`${page0}?capture=1&s=${s}${set.theme ? "&theme=" + set.theme : ""}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(120);
    if (s === "detail-tech") {
      await page.evaluate(() => document.querySelector("#inspTechDetails")?.scrollIntoView({ block: "start" }));
    }
    await page.screenshot({ path: `shots/${set.tag}-${s}.png` });
  }
  await ctx.close();
}
await browser.close();
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("Captured all screenshots cleanly.");
