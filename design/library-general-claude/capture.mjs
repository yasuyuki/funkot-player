// Renders the prototype's states to PNG. Run from this directory:
//   node capture.mjs <path-to-node_modules/playwright>
// The page loads Google Fonts, so it needs network access.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright");
const page0 = pathToFileURL(resolve("index.html")).href;
mkdirSync("shots", { recursive: true });

const states = ["base", "a", "a-browse", "a-edit", "added", "a-detail", "a-or", "eight", "eight-edit", "zero", "loading", "error", "long"];
const sets = [
  { tag: "desktop", vp: { width: 1280, height: 900 }, dpr: 1, s: [...states, "eight-dest", "a-select"] },
  { tag: "desktop-dark", vp: { width: 1280, height: 900 }, dpr: 1, theme: "dark", s: ["a", "a-edit"] },
  { tag: "narrow", vp: { width: 412, height: 915 }, dpr: 2, touch: true, s: [...states, "a-dest", "a-select"] },
  // 1280x900 at 200% text/zoom is a 640x450 CSS viewport
  { tag: "zoom200", vp: { width: 640, height: 450 }, dpr: 2, s: ["a", "a-edit", "a-detail", "added"] },
];

const browser = await chromium.launch();
const errors = [];
for (const set of sets) {
  const ctx = await browser.newContext({ viewport: set.vp, deviceScaleFactor: set.dpr, hasTouch: !!set.touch, isMobile: !!set.touch, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${set.tag}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${set.tag}: ${m.text()}`); });
  for (const s of set.s) {
    await page.goto(`${page0}?capture=1&s=${s}${set.theme ? "&theme=" + set.theme : ""}`);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => FKP.render());
    await page.waitForTimeout(120);
    if (s === "a-detail" || s === "long") await page.evaluate(() => document.querySelector(".row.is-open")?.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: `shots/${set.tag}-${s}.png` });
  }
  await ctx.close();
}
await browser.close();
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("ok");
