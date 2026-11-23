// Measures the original Overprint (#169) and this proposal under the same
// data, viewport and state, and writes side-by-side images.
//   node compare.mjs <path-to-node_modules/playwright>
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright");
const designs = {
  before: pathToFileURL(resolve("../library-ideal-claude/index.html")).href,
  after: pathToFileURL(resolve("index.html")).href,
};
const states = ["base", "a", "a-edit", "added", "eight", "a-detail"];
const widths = [
  { tag: "desktop", vp: { width: 1280, height: 900 }, dpr: 1 },
  { tag: "narrow", vp: { width: 412, height: 915 }, dpr: 2, touch: true },
];
mkdirSync("compare", { recursive: true });

// Read in the page: geometry of what a person sees in the first viewport.
const measure = () => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && cs.visibility !== "hidden" && !e.closest("[hidden]") && !e.closest(".demo"); };
  const results = document.querySelector("#results").getBoundingClientRect();
  const now = document.querySelector("#now").getBoundingClientRect();
  const bottom = Math.min(results.bottom, now.top, innerHeight);
  const sheet = document.querySelector("#lens:not([hidden])");
  const sheetCovers = sheet && sheet.getBoundingClientRect().height >= innerHeight - 2;
  const rows = [...document.querySelectorAll("#rows > .row")];
  const first = rows[0]?.getBoundingClientRect();
  const fullRows = sheetCovers ? 0 : rows.filter((r) => { const b = r.getBoundingClientRect(); return b.top >= results.top - 1 && b.bottom <= bottom + 1; }).length;
  const ctrlSel = "button, input, select, a[href], [role=option]";
  const controls = [...document.querySelectorAll(ctrlSel)].filter(vis);
  const outside = controls.filter((c) => !c.closest("#rows"));
  const nav = outside.filter((c) => c.closest(".rail, .tabs, .top"));
  const firstRowCtrls = rows[0] ? [...rows[0].querySelectorAll(ctrlSel)].filter(vis).length : 0;
  const t = rows[0]?.querySelector(".row-title");
  const main = rows[0]?.querySelector(".row-main");
  const add = rows.find((r) => !r.querySelector('.add[aria-disabled="true"]'))?.querySelector(".add i");
  const cond = document.querySelector("#stamps, #summary");
  const condRect = cond && !cond.hidden && cond.offsetParent ? cond.getBoundingClientRect() : null;
  // the strongest ink on screen: area painted with the fluorescent pink
  let pink = 0;
  for (const e of document.querySelectorAll("body *")) {
    if (!vis(e)) continue;
    const bg = getComputedStyle(e).backgroundColor;
    if (/rgb\(255, 62, 165\)/.test(bg)) { const r = e.getBoundingClientRect(); pink += r.width * r.height; }
  }
  return {
    firstRowTop: sheetCovers || !first ? null : Math.round(first.top),
    titleWidth: main ? Math.round(main.getBoundingClientRect().width) : null,
    titlePx: t ? parseFloat(getComputedStyle(t).fontSize) : null,
    fullRows,
    controlsOutsideList: outside.length,
    navControls: nav.length,
    otherControls: outside.length - nav.length,
    controlsPerRow: firstRowCtrls,
    conditionHeight: condRect ? Math.round(condRect.height) : 0,
    addMarkPx: add ? Math.round(add.getBoundingClientRect().width) : null,
    addOutlinedAtRest: add ? getComputedStyle(add).boxShadow !== "none" : null,
    pinkArea: Math.round(pink),
    sheet: !!sheetCovers,
    hOverflow: document.documentElement.scrollWidth > innerWidth,
  };
};

const browser = await chromium.launch();
const out = {};
for (const w of widths) {
  const ctx = await browser.newContext({ viewport: w.vp, deviceScaleFactor: w.dpr, hasTouch: !!w.touch, isMobile: !!w.touch, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  for (const s of states) {
    const shots = {};
    for (const [name, base] of Object.entries(designs)) {
      const scn = s === "added" ? "a" : s;
      await page.goto(`${base}?capture=1&s=${scn}`);
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => (window.FKP.render ? FKP.render() : null));
      await page.waitForTimeout(120);
      if (s === "added") {
        await page.locator(".row", { hasText: "鋼鉄商店街ダンスホール" }).locator(".add").click();
        await page.mouse.move(2, 2);
        await page.waitForTimeout(150);
      }
      if (s === "a-detail") await page.evaluate(() => document.querySelector(".row.is-open")?.scrollIntoView({ block: "start" }));
      out[`${w.tag}/${s}/${name}`] = await page.evaluate(measure);
      shots[name] = (await page.screenshot()).toString("base64");
    }
    const W = w.vp.width, H = w.vp.height;
    const cmp = await browser.newPage({ viewport: { width: W * 2 + 48, height: H + 44 }, deviceScaleFactor: w.dpr === 2 ? 1 : 1 });
    await cmp.setContent(`<body style="margin:0;background:#2a2850;font:600 15px system-ui;color:#fff;display:flex;gap:16px;padding:8px 16px">
      ${["before", "after"].map((k) => `<figure style="margin:0"><figcaption style="height:24px">${k === "before" ? "#169 Overprint（元案）" : "#170 Overprint Liner（統合案）"}　${w.tag} ${s}</figcaption><img style="width:${W}px;height:${H}px;display:block" src="data:image/png;base64,${shots[k]}"></figure>`).join("")}</body>`);
    await cmp.screenshot({ path: `compare/${w.tag}-${s}.png` });
    await cmp.close();
  }
  await ctx.close();
}
await browser.close();
writeFileSync("compare/metrics.json", JSON.stringify(out, null, 1) + "\n");

const keys = ["firstRowTop", "titleWidth", "fullRows", "navControls", "otherControls", "controlsPerRow", "conditionHeight", "pinkArea", "addMarkPx", "addOutlinedAtRest"];
let md = `| 幅 | 状態 | ${keys.join(" | ")} |\n|${"---|".repeat(keys.length + 2)}\n`;
for (const w of widths) for (const s of states) {
  const b = out[`${w.tag}/${s}/before`], a = out[`${w.tag}/${s}/after`];
  md += `| ${w.tag} | ${s} | ${keys.map((k) => `${b[k] ?? "—"} → ${a[k] ?? "—"}`).join(" | ")} |\n`;
}
writeFileSync("compare/metrics.md", md);
console.log(md);
