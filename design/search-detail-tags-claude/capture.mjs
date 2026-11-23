// Renders the prototype's states to PNG. Run from this directory:
//   node capture.mjs <path-to-node_modules/playwright> [state ...]
// The page loads Google Fonts, so it needs network access.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright");
const only = process.argv.slice(3);
const page0 = pathToFileURL(resolve("index.html")).href;
mkdirSync("shots", { recursive: true });

// state -> extra wait for the mock service (saves take 420 ms)
const STATES = {
  base: 0, a: 0, "a-first": 0, "a-type": 0, "a-amb": 0, "a-funkot": 0, "a-menu": 0, "a-or": 0,
  eight: 0, "eight-edit": 0, zero: 0, long: 0,
  detail: 0, "detail-tech": 0, "detail-moon": 0, "detail-copy": 0,
  edit: 0, "edit-sugg": 0, "edit-year": 0, many: 0, "many-find": 0,
  batch: 0, "batch-year": 0, "batch-scan": 0,
  fail: 700, stale: 700, "stale-reloaded": 1400, identity: 700, "identity-reopen": 1400, saved: 900,
};
const sets = [
  { tag: "desktop", vp: { width: 1280, height: 900 }, dpr: 1, s: Object.keys(STATES) },
  { tag: "desktop-dark", vp: { width: 1280, height: 900 }, dpr: 1, theme: "dark", s: ["a-type", "detail-tech", "many"] },
  { tag: "narrow", vp: { width: 412, height: 915 }, dpr: 2, touch: true, s: Object.keys(STATES).filter((s) => !["a-or", "a-funkot", "batch-scan"].includes(s)) },
  // 1280x900 at 200% is a 640x450 CSS viewport
  { tag: "zoom200", vp: { width: 640, height: 450 }, dpr: 2, s: ["a-type", "detail", "edit", "many"] },
];

const browser = await chromium.launch();
const errors = [];
for (const set of sets) {
  const ctx = await browser.newContext({ viewport: set.vp, deviceScaleFactor: set.dpr, hasTouch: !!set.touch, isMobile: !!set.touch, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${set.tag}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${set.tag}: ${m.text()}`); });
  for (const s of set.s) {
    if (only.length && !only.includes(s)) continue;
    await page.goto(`${page0}?capture=1&s=${s}${set.theme ? "&theme=" + set.theme : ""}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250 + STATES[s]);
    await page.screenshot({ path: `shots/${set.tag}-${s}.png` });
  }
  await ctx.close();
}
await browser.close();
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("ok");
