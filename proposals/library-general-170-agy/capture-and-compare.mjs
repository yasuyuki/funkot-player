// Captures all PNG states for Issue #170 visual review AND records side-by-side
// quantitative metrics comparing Claude Original (6b2eaa1) vs Overprint Quiet.
// Usage: node capture-and-compare.mjs [--baseline <path-to-claude-index.html>]
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const nm = "C:/Users/flame/work/funkot-player/node_modules";
const { chromium } = require(resolve(nm, "playwright"));

const args = process.argv.slice(2);
const baseIdx = args.indexOf("--baseline");
const baselinePath = baseIdx >= 0 ? args[baseIdx + 1] : "C:/Users/flame/work/funkot-player.slots/4/design/library-ideal-claude/index.html";
const newUrl = pathToFileURL(resolve("index.html")).href;
const baseUrl = pathToFileURL(resolve(baselinePath)).href;

mkdirSync("shots", { recursive: true });

const captureSets = [
  { tag: "desktop", vp: { width: 1280, height: 900 }, dpr: 1,
    s: ["base", "a-browse", "a-edit", "a", "a-added", "a-detail", "a-select", "eight", "eight-edit", "zero", "loading", "error", "long"] },
  { tag: "desktop-dark", vp: { width: 1280, height: 900 }, dpr: 1, theme: "dark", s: ["a", "a-edit"] },
  { tag: "narrow", vp: { width: 412, height: 915 }, dpr: 2, touch: true,
    s: ["base", "a-browse", "a-edit", "a", "a-added", "a-detail", "a-dest", "eight", "zero"] },
  { tag: "zoom200", vp: { width: 640, height: 450 }, dpr: 2, s: ["a", "a-edit", "a-detail"] },
];

const browser = await chromium.launch();
const errors = [];

// 1. Capture all screenshots for the new integrated design
for (const set of captureSets) {
  const ctx = await browser.newContext({ viewport: set.vp, deviceScaleFactor: set.dpr, hasTouch: !!set.touch, isMobile: !!set.touch, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${set.tag}: ${e.message}`));
  for (const s of set.s) {
    await page.goto(`${newUrl}?capture=1&s=${s}${set.theme ? "&theme=" + set.theme : ""}`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.waitForTimeout(120);
    if (s === "a-detail" || s === "long") await page.evaluate(() => document.querySelector(".row.is-open")?.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: `shots/${set.tag}-${s}.png` });
  }
  await ctx.close();
}

// Also capture 1280x900 with 200% root font scaling
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(`${newUrl}?capture=1&s=a`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; FKP.render(); });
  await page.waitForTimeout(120);
  await page.screenshot({ path: "shots/zoom200-font-desktop.png" });
  await ctx.close();
}

// 2. Measure identical conditions across Claude Original vs Overprint Quiet
async function measure(targetUrl, label, vp, touch, scn) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: touch ? 2 : 1, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(`${targetUrl}?capture=1&s=${scn}`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(120);
  const m = await page.evaluate(() => {
    const vh = innerHeight;
    const vw = innerWidth;
    const firstRow = document.querySelector(".row");
    const firstTitle = firstRow?.querySelector(".row-title");
    const addBtn = firstRow?.querySelector(".add");
    const addCircle = firstRow?.querySelector(".add i");
    const nowBar = document.querySelector("#now");
    const nowTop = nowBar ? nowBar.getBoundingClientRect().top : vh;
    const rows = [...document.querySelectorAll(".row")];
    const fullyVisibleRows = rows.filter((r) => {
      const b = r.getBoundingClientRect();
      return b.top >= 0 && b.bottom <= nowTop + 1;
    }).length;
    const partiallyVisibleRows = rows.filter((r) => {
      const b = r.getBoundingClientRect();
      return b.bottom > 0 && b.top < nowTop;
    }).length;

    // Count permanently visible interactive controls (excluding rows/list items)
    const isVis = (el) => {
      if (!el || el.hidden) return false;
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.left < vw && r.right > 0 && r.top < vh && r.bottom > 0;
    };
    const countInteractive = (sel) => [...document.querySelectorAll(`${sel} button, ${sel} a, ${sel} input, ${sel} select`)].filter(isVis).length;
    const railCtrls = countInteractive(".rail");
    const queryCtrls = countInteractive(".query");
    const resultsBarCtrls = countInteractive(".results-bar");
    const dockCtrls = countInteractive(".dock");
    const nowCtrls = countInteractive(".now");

    const stampsEl = document.querySelector("#stamps") || document.querySelector("#condBar");
    const stampsHeight = stampsEl && !stampsEl.hidden ? Math.round(stampsEl.getBoundingClientRect().height) : 0;
    const nowSrc = document.querySelector(".now-src");
    const nowSrcVisible = nowSrc ? isVis(nowSrc) : false;

    const tb = firstTitle?.getBoundingClientRect();
    const ab = addCircle?.getBoundingClientRect();
    const hb = addBtn?.getBoundingClientRect();
    const rb = firstRow?.getBoundingClientRect();

    return {
      firstRowTopPx: rb ? Math.round(rb.top) : null,
      rowHeightPx: rb ? Math.round(rb.height) : null,
      titleReadableWidthPx: tb ? Math.round(tb.width) : null,
      titleFontSizePx: firstTitle ? parseFloat(getComputedStyle(firstTitle).fontSize) : null,
      fullyVisibleRows,
      partiallyVisibleRows,
      condAreaHeightPx: stampsHeight,
      addHitWidthPx: hb ? Math.round(hb.width) : null,
      addHitHeightPx: hb ? Math.round(hb.height) : null,
      addVisualDiameterPx: ab ? Math.round(ab.width) : null,
      titleToAddVisualAreaRatio: (tb && ab) ? Number(((tb.width * tb.height) / (ab.width * ab.height)).toFixed(1)) : null,
      permanentChromeControls: {
        rail: railCtrls,
        query: queryCtrls,
        resultsBar: resultsBarCtrls,
        dock: dockCtrls,
        now: nowCtrls,
        total: railCtrls + queryCtrls + resultsBarCtrls + dockCtrls + nowCtrls,
      },
      rowMetadataTokensPerRow: firstRow ? firstRow.querySelectorAll(".row-why > span, .row-twin").length + (firstRow.querySelector(".row-artist") ? 1 : 0) : 0,
      narrowPlaybackSourceVisible: nowSrcVisible,
      horizontalOverflowPx: document.documentElement.scrollWidth - vw,
    };
  });
  await ctx.close();
  return { design: label, viewport: `${vp.width}x${vp.height}`, scenario: scn, ...m };
}

const matrix = [
  { vp: { width: 1280, height: 900 }, touch: false, scn: "base" },
  { vp: { width: 1280, height: 900 }, touch: false, scn: "a" },
  { vp: { width: 1280, height: 900 }, touch: false, scn: "eight" },
  { vp: { width: 412, height: 915 }, touch: true, scn: "base" },
  { vp: { width: 412, height: 915 }, touch: true, scn: "a" },
  { vp: { width: 412, height: 915 }, touch: true, scn: "eight" },
];

const report = [];
for (const c of matrix) {
  const before = await measure(baseUrl, "claude-original", c.vp, c.touch, c.scn);
  const after = await measure(newUrl, "overprint-quiet-170", c.vp, c.touch, c.scn);
  report.push({ condition: `${c.vp.width}x${c.vp.height}:${c.scn}`, before, after });
}

writeFileSync("comparison-report.json", JSON.stringify({ generatedAt: new Date().toISOString(), errors, report }, null, 2));
await browser.close();
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("capture-and-compare complete:", report.length, "comparisons written to comparison-report.json");
