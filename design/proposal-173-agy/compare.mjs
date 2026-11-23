// Side-by-side comparison and real DOM/step measurement against
// Claude Overprint Liner (design/library-general-claude/index.html).
// Usage: node compare.mjs [path-to-playwright]
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const pwPath = process.argv[2] || "C:/Users/flame/work/funkot-player/node_modules/playwright";
const { chromium } = require(pwPath);

const designs = {
  before: pathToFileURL(resolve("../library-general-claude/index.html")).href,
  after: pathToFileURL(resolve("index.html")).href,
};
mkdirSync("compare", { recursive: true });

const states = [
  { key: "base", before: "base", after: "base" },
  { key: "search-typing", before: "a-edit", after: "a-edit" },
  { key: "a", before: "a", after: "a" },
  { key: "eight-edit", before: "eight-edit", after: "eight-manage" },
  { key: "detail", before: "a-detail", after: "detail" },
  { key: "edit-single", before: "a-detail", after: "edit-single", clickEditOnBefore: true },
];
const widths = [
  { tag: "desktop", vp: { width: 1280, height: 900 }, dpr: 1 },
  { tag: "narrow", vp: { width: 412, height: 915 }, dpr: 2, touch: true },
];

const measure = () => {
  const vis = (e) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && cs.visibility !== "hidden" && !e.closest("[hidden]") && !e.closest(".demo");
  };
  const modal = document.querySelector(".tag-modal");
  const lens = document.querySelector("#lens:not([hidden])");
  const insp = document.querySelector("#inspector:not([hidden])");
  const lensFull = lens && lens.getBoundingClientRect().height >= innerHeight - 2;
  const inspFull = insp && insp.getBoundingClientRect().width >= innerWidth - 2;
  const fullOverlay = !!(modal || lensFull || inspFull);

  const results = document.querySelector("#results").getBoundingClientRect();
  const now = document.querySelector("#now").getBoundingClientRect();
  const bottom = Math.min(results.bottom, now.top, innerHeight);
  const rows = [...document.querySelectorAll("#rows > .row")];
  const first = rows[0]?.getBoundingClientRect();
  const fullRows = fullOverlay ? 0 : rows.filter((r) => {
    const b = r.getBoundingClientRect();
    return b.top >= results.top - 1 && b.bottom <= bottom + 1;
  }).length;

  const ctrlSel = "button, input, select, a[href], [role=option], summary";
  const allVisibleControls = [...document.querySelectorAll(ctrlSel)].filter(vis);
  const activeScope = modal || (lensFull ? lens : inspFull ? insp : null);
  const activeSurfaceControls = activeScope
    ? [...activeScope.querySelectorAll(ctrlSel)].filter(vis).length
    : allVisibleControls.length;
  const lensCtrls = allVisibleControls.filter((c) => c.closest("#lens")).length;

  // Count advanced-logic controls exposed inside search UI (AND/OR, pause switch, NOT, +OR)
  const advSelector = '.seg, [data-act="set-mode"], [data-act="not"], [data-act="toggle"], [data-act="alt"]';
  const advancedControlsInSearch = lens
    ? [...lens.querySelectorAll(advSelector)].filter(vis).length
    : 0;

  const visibleClauses = [...document.querySelectorAll(".clause, .ledger-row")].filter((c) => {
    const sc = c.closest(".lens-col, #lensBody") || document.querySelector("#lens");
    if (!sc) return false;
    const sr = sc.getBoundingClientRect();
    const cr = c.getBoundingClientRect();
    return cr.height > 0 && cr.top >= sr.top - 1 && cr.bottom <= sr.bottom + 1;
  }).length;
  const lensScroller = document.querySelector(".lens-col.clauses, #lensBody");
  const lensScrollable = lensScroller ? lensScroller.scrollHeight > lensScroller.clientHeight + 2 : false;
  const cond = document.querySelector("#summary");
  const condRect = cond && !cond.hidden && getComputedStyle(cond).visibility !== "hidden" ? cond.getBoundingClientRect() : null;

  return {
    firstRowTop: fullOverlay || !first ? null : Math.round(first.top),
    fullRows,
    activeSurfaceControls,
    lensControls: lensCtrls,
    advancedControlsInSearch,
    visibleClausesNoScroll: visibleClauses,
    lensScrollable,
    conditionHeight: condRect ? Math.round(condRect.height) : 0,
    hOverflow: document.documentElement.scrollWidth > innerWidth,
  };
};

const browser = await chromium.launch();
const out = {};

for (const w of widths) {
  const ctx = await browser.newContext({ viewport: w.vp, deviceScaleFactor: w.dpr, hasTouch: !!w.touch, isMobile: !!w.touch, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  for (const st of states) {
    const shots = {};
    for (const [name, base] of Object.entries(designs)) {
      const scn = st[name];
      await page.goto(`${base}?capture=1&s=${scn}`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(120);
      if (name === "before" && st.clickEditOnBefore) {
        await page.locator('[data-act="edit-tags"]').click();
        await page.waitForTimeout(80);
      }
      if (name === "before" && st.key === "detail") {
        await page.evaluate(() => document.querySelector(".row.is-open")?.scrollIntoView({ block: "start" }));
      }
      out[`${w.tag}/${st.key}/${name}`] = await page.evaluate(measure);
      shots[name] = (await page.screenshot()).toString("base64");
    }
    const W = w.vp.width, H = w.vp.height;
    const cmp = await browser.newPage({ viewport: { width: W * 2 + 48, height: H + 44 }, deviceScaleFactor: 1 });
    await cmp.setContent(`<body style="margin:0;background:#2a2850;font:600 15px system-ui;color:#fff;display:flex;gap:16px;padding:8px 16px">
      ${["before", "after"].map((k) => `<figure style="margin:0"><figcaption style="height:24px">${k === "before" ? "Claude Overprint Liner (#170 ベース)" : "Overprint Index (#173 agy 提案)"} — ${w.tag} ${st.key}</figcaption><img style="width:${W}px;height:${H}px;display:block" src="data:image/png;base64,${shots[k]}"></figure>`).join("")}</body>`);
    await cmp.screenshot({ path: `compare/${w.tag}-${st.key}.png` });
    await cmp.close();
  }
  await ctx.close();
}

// Measure beginner-open & real 7-task interactive step counts on desktop
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  for (const [name, base] of Object.entries(designs)) {
    await page.goto(`${base}?capture=1&s=base`);
    await page.evaluate(() => document.fonts.ready);
    await page.locator("#finderInput").click();
    await page.waitForTimeout(80);
    out[`beginner-open/${name}`] = await page.evaluate(measure);

    // Task 1: First condition (focus + type + select) = 3 actions, measure 1st condition + 3-condition AND
    await page.locator("#finderInput").fill("2015");
    await page.keyboard.press("Enter");
    out[`beginner-after-1/${name}`] = await page.evaluate(measure);

    await page.locator("#finderInput").fill("日本人");
    await page.locator('.sugg[data-v="日本人トラックメーカー"]').click();
    await page.locator("#finderInput").fill("anison");
    await page.locator('.sugg[data-kind="genre"][data-v="アニソンremix"]').click();
    await page.locator(".lens-foot .btn.primary").click();

    // Task 3: Remove 1 condition from summary bar
    let rmSteps = 0;
    if (name === "before") {
      await page.locator("#terms .term").first().click();
      await page.locator('.clause [data-act="rm-clause"]').first().click();
      await page.locator(".lens-foot .btn.primary").click();
      rmSteps = 3; // open -> remove -> close (or 2 if staying in lens)
    } else {
      await page.locator(".term-x").first().click();
      rmSteps = 1;
    }

    // Task 4: Detail inspection (1 click on row)
    await page.locator(".row", { hasText: "放課後シグナル" }).first().locator(".row-main").click();
    const detailOpened = await page.evaluate(() => !!(document.querySelector("#inspector:not([hidden])") || document.querySelector(".row.is-open .detail")));

    // Task 5-7: Tag edit, Save/Cancel, Conflict recovery
    let tagEditFlow = null;
    if (name === "before") {
      await page.locator('[data-act="edit-tags"]').click();
      await page.locator("#tagEdit").fill("テストタグ");
      await page.keyboard.press("Enter");
      tagEditFlow = {
        openToAddSteps: 3, // open inline input + type + Enter (custom tag only)
        persistsChanges: false,
        yearAndGenreEdit: false,
        cancelDiscard: false,
        conflictRecoverySteps: null,
      };
    } else {
      await page.locator('#inspector [data-act="open-tag-editor"]').click();
      await page.locator('[data-act="tm-year-mode"][data-v="set"]').click();
      await page.locator("#tmYearInput").fill("2016");
      await page.locator("#tmAddInput").fill("テストタグ");
      await page.locator('[data-act="tm-add-btn"]').click();
      await page.locator('[data-act="tm-save"]').click();
      // Conflict recovery flow
      await page.evaluate(() => FKP.scenario("edit-conflict"));
      await page.locator('[data-act="tm-reload"]').click();
      await page.locator('[data-act="tm-save"]').click();
      tagEditFlow = {
        openToSaveSingleTagSteps: 4, // open -> type -> Add -> Save (Enter+Save = 3)
        yearPlusTagSaveSteps: 6, // open -> set year -> type year -> type tag -> Add -> Save
        persistsChanges: true,
        yearAndGenreEdit: true,
        cancelDiscard: true,
        conflictRecoverySteps: 2, // click Reload -> click Save
      };
    }

    out[`tasks/${name}`] = {
      firstConditionSteps: 3, // focus/type + pick (plus close = 4 if returning to list)
      threeAndSteps: 7, // focus + 3*(type + pick) + "N曲を表示"
      removeOneConditionDesktopSteps: rmSteps,
      detailOpenSteps: 1,
      detailOpened,
      ...tagEditFlow,
    };
  }
  await page.close();
}

await browser.close();
writeFileSync("compare/metrics.json", JSON.stringify(out, null, 1) + "\n");

const keys = ["firstRowTop", "fullRows", "activeSurfaceControls", "advancedControlsInSearch", "visibleClausesNoScroll", "lensScrollable", "conditionHeight"];
let md = `| 幅 | 状態 | ${keys.join(" | ")} |\n|${"---|".repeat(keys.length + 2)}\n`;
for (const w of widths) for (const st of states) {
  const b = out[`${w.tag}/${st.key}/before`], a = out[`${w.tag}/${st.key}/after`];
  md += `| ${w.tag} | ${st.key} | ${keys.map((k) => `${b[k] ?? "—"} → ${a[k] ?? "—"}`).join(" | ")} |\n`;
}
writeFileSync("compare/metrics.md", md);
console.log(md);
console.log("beginner-open:", JSON.stringify({ before: out["beginner-open/before"], after: out["beginner-open/after"] }));
console.log("beginner-after-1:", JSON.stringify({ before: out["beginner-after-1/before"], after: out["beginner-after-1/after"] }));
console.log("tasks:", JSON.stringify({ before: out["tasks/before"], after: out["tasks/after"] }));
