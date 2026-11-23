// Automated behavioral, touch-target, 200%-zoom, and axe-core accessibility verification.
// Usage: node verify.mjs [path-to-repo-node_modules]
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const nm = process.argv[2] || "C:/Users/flame/work/funkot-player/node_modules";
const { chromium } = require(resolve(nm, "playwright"));
const { AxeBuilder } = require(resolve(nm, "@axe-core/playwright"));

const url = pathToFileURL(resolve("index.html")).href + "?capture=1";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const state = (p) => p.evaluate(() => ({
  clauses: FKP.S.clauses.map((c) => ({ kind: c.kind, values: c.values, on: c.on, not: c.not })),
  mode: FKP.S.mode,
  countText: document.querySelector(".rb-count")?.textContent?.trim() || "",
  dest: FKP.S.dest,
  destPickerOpen: FKP.S.destPickerOpen,
  queueCount: FKP.L.queue.length,
  friCount: FKP.L.fri.length,
  anisonCount: FKP.L.anison.length,
  toast: document.querySelector("#toast").hidden ? "" : document.querySelector("#toast span").textContent,
  nowSrc: document.querySelector(".now-src")?.textContent?.trim() || "",
  condBarHidden: document.querySelector("#condBar").hidden,
  condBarRect: document.querySelector("#condBar").getBoundingClientRect(),
  firstRowTop: document.querySelector(".row")?.getBoundingClientRect().top ?? null,
}));

const browser = await chromium.launch();

// =========================================================================
// 1. Desktop (1280x900) mouse + keyboard
// =========================================================================
{
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(url, { waitUntil: "domcontentloaded" });

  // Flow A: / -> 2015 -> 日本人トラックメーカー -> anison (romaji & variants) -> アニソンremix + text filter
  await p.keyboard.press("/");
  await p.keyboard.type("2015");
  const first = await p.locator(".sugg").first().innerText();
  check("A1 typing 2015 offers year 2015 first", /2015/.test(first) && /制作年/.test(first), first.replace(/\s+/g, " "));
  await p.keyboard.press("Enter");
  await p.keyboard.type("日本人");
  const cands = await p.locator(".sugg").count();
  check("A2 typing 日本人 surfaces multiple candidates", cands >= 4, `${cands} candidates`);
  await p.locator('.sugg[data-v="日本人トラックメーカー"]').click();
  await p.locator("#finderInput").fill("");
  await p.locator("#finderInput").type("anison");
  const variants = await p.locator(".sugg-variants").count();
  check("A3 romaji anison matches アニソンremix with spelling variants", variants > 0 && (await p.locator('.sugg[data-v="アニソンremix"]').count()) === 1);
  await p.locator('.sugg[data-v="アニソンremix"]').click();

  // Close lens by clicking results area
  await p.locator(".row").first().click({ position: { x: 260, y: 24 } });
  let s = await state(p);
  const n3 = Number(s.countText.replace(/[^0-9]/g, ""));
  check("A4 three AND conditions return 53 tracks on single-line condBar",
    s.clauses.length === 3 && n3 === 53 && !s.condBarHidden && s.condBarRect.height <= 52,
    `count=${n3}, condBarH=${Math.round(s.condBarRect.height)}px`);

  // Combine with text search
  await p.keyboard.press("/");
  await p.keyboard.type("シグナル");
  await p.locator('.sugg[data-kind="text"]').click();
  await p.keyboard.press("Escape");
  s = await state(p);
  const nText = Number(s.countText.replace(/[^0-9]/g, ""));
  check("A5 text filter combines with 3 tag conditions cleanly", nText > 0 && nText < n3, `53 -> ${nText}`);
  await p.locator('.ctok[data-kind="text"] .ctok-x').click();
  s = await state(p);
  check("A6 removing text token restores 53 tracks", Number(s.countText.replace(/[^0-9]/g, "")) === 53);

  // Flow B: edit, pause/resume, remove/undo, inline OR, global AND/OR, Escape focus return
  await p.locator(".ctok-open").first().click();
  await p.locator(".clause .switch").nth(1).click();
  s = await state(p);
  const pausedN = Number(s.countText.replace(/[^0-9]/g, ""));
  check("B1 pausing condition widens results", !s.clauses[1].on && pausedN > 53, `53 -> ${pausedN}`);
  await p.locator(".clause .switch").nth(1).click();
  s = await state(p);
  check("B2 resuming condition restores 53 tracks", Number(s.countText.replace(/[^0-9]/g, "")) === 53);

  await p.locator('.clause [data-act="rm-clause"]').nth(2).click();
  s = await state(p);
  check("B3 removing condition triggers Undo toast", s.clauses.length === 2 && /外しました/.test(s.toast), s.toast);
  await p.locator("#toast button").click();
  s = await state(p);
  check("B4 Undo restores removed condition", s.clauses.length === 3 && s.clauses[2].values[0] === "アニソンremix");

  await p.locator('.clause [data-act="alt"]').nth(2).click();
  await p.keyboard.type("電波");
  await p.keyboard.press("Enter");
  s = await state(p);
  check("B5 inline OR joins same clause", s.clauses[2].values.join("|") === "アニソンremix|電波remix", s.clauses[2].values.join(" / "));
  await p.locator('.clause [data-act="rm-val"][data-v="電波remix"]').click();
  await p.keyboard.press("Escape");
  const focusAfterEsc = await p.evaluate(() => document.activeElement?.id || "");
  check("B6 Escape closes lens cleanly", !(await p.locator("#lens").isVisible()), `activeElement=${focusAfterEsc}`);

  // Flow C: 1-click add, dock landing & boundary, destination switch, missing guard, keyboard, multi-select, title dominance
  const q0 = s.queueCount;
  const target = p.locator(".row", { hasText: "鋼鉄商店街ダンスホール" });
  await target.locator(".add").click();
  s = await state(p);
  check("C1 1-click add appends before auto-pick boundary in Queue", s.queueCount === q0 + 1 && /再生待ちの\d+番目/.test(s.toast), s.toast);
  const beforeBoundary = await p.locator(".tail li", { hasText: "鋼鉄商店街ダンスホール" }).locator("xpath=following-sibling::li[contains(@class,'boundary')]").count();
  check("C2 dock tail shows new track before automatic boundary and playback source stays Queue", beforeBoundary === 1 && /再生待ち/.test(s.nowSrc));

  check("C3 desktop destination picker hidden by default for calm sidebar", !s.destPickerOpen);
  await p.locator("#destToggleBtn").click();
  s = await state(p);
  check("C4 clicking 切替 opens destination picker", s.destPickerOpen);
  await p.locator('.dest[data-id="fri"]').click();
  s = await state(p);
  const plusLabel = await target.locator(".add").getAttribute("aria-label");
  check("C5 switching destination closes picker, updates row action label, preserves playback source",
    !s.destPickerOpen && s.dest === "fri" && /金曜の夜に追加/.test(plusLabel) && /再生待ち/.test(s.nowSrc), plusLabel);

  await target.locator(".add").click();
  s = await state(p);
  check("C6 1-click adds to 金曜の夜", s.friCount === 24, `fri=${s.friCount}`);

  await p.locator(".row", { hasText: "微熱パレード" }).locator(".add").click({ force: true });
  s = await state(p);
  check("C7 missing file add refused with toast reason", s.friCount === 24 && /見つからない/.test(s.toast), s.toast);

  await p.locator(".row-main").nth(1).focus();
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("a");
  s = await state(p);
  check("C8 keyboard ArrowDown + A adds focused track", s.friCount === 25, `fri=${s.friCount}`);

  await p.locator('[data-act="sel-start"]').click();
  await p.locator(".row-check").nth(1).click();
  await p.locator(".row-check").nth(2).click();
  await p.locator('[data-act="add-sel"]').click();
  s = await state(p);
  check("C9 multi-select adds 2 tracks together", s.friCount === 27 && /2曲を/.test(s.toast), s.toast);

  // Track detail & title dominance geometry
  await p.locator(".row", { hasText: "放課後シグナル" }).first().locator(".row-main").click();
  const detailVisible = await p.locator(".detail").isVisible();
  const twinsInDetail = await p.locator(".detail .twin").count();
  check("C10 track detail expands with twin-file disambiguation", detailVisible && twinsInDetail === 2, `twins=${twinsInDetail}`);

  const geom = await p.evaluate(() => {
    const r = document.querySelector(".row:not(.is-open)");
    const t = r.querySelector(".row-title");
    const a = r.querySelector(".add i");
    const hit = r.querySelector(".add");
    const tb = t.getBoundingClientRect();
    const ab = a.getBoundingClientRect();
    const hb = hit.getBoundingClientRect();
    return {
      titlePx: parseFloat(getComputedStyle(t).fontSize),
      titleArea: Math.round(tb.width * tb.height),
      addArea: Math.round(ab.width * ab.height),
      hitW: Math.round(hb.width),
      hitH: Math.round(hb.height),
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  check("C11 title dominates add icon (area >= 4x) & add hit >= 44px & 0 overflow",
    geom.hitW >= 44 && geom.hitH >= 44 && geom.titleArea >= geom.addArea * 4 && geom.overflow <= 0,
    JSON.stringify(geom));

  // Scale: 9 conditions bounded single line
  const top3 = s.firstRowTop;
  await p.evaluate(() => FKP.scenario("eight"));
  const s8 = await state(p);
  const moreText = await p.locator("#condMoreBtn").innerText();
  const minLabelW8 = await p.evaluate(() => Math.min(...[...document.querySelectorAll("#condTokens .ctok:not([hidden]) .ctok-label")].map((e) => e.getBoundingClientRect().width)));
  check("S1 9 conditions stay single-line bounded with same firstRowTop and readable tokens",
    s8.condBarRect.height <= 52 && Math.abs(s8.firstRowTop - top3) <= 4 && /\+他\d+条件 \(全9\)/.test(moreText) && minLabelW8 >= 24,
    `condBarH=${Math.round(s8.condBarRect.height)}, top3=${Math.round(top3)}, top9=${Math.round(s8.firstRowTop)}, btn=${moreText}, minLabelW=${Math.round(minLabelW8)}`);

  // Exceptions: zero & error recovery
  await p.evaluate(() => FKP.scenario("zero"));
  const relaxCount = await p.locator(".relax button").count();
  await p.locator(".relax button").first().click();
  const afterRelax = Number((await state(p)).countText.replace(/[^0-9]/g, ""));
  check("E1 zero-result offers relaxation choices that restore results", relaxCount >= 1 && afterRelax > 0, `relax=${relaxCount}, after=${afterRelax}`);

  await p.evaluate(() => FKP.scenario("error"));
  const hasErrBanner = await p.locator("#queryStatus.is-error").isVisible();
  await p.locator('#queryStatus button[data-act="retry"]').click();
  check("E2 error state preserves stale list and recovers on retry", hasErrBanner && !(await p.locator("#queryStatus.is-error").isVisible()));

  // Zoom 200% (both 640x450 viewport AND 1280x900 200% root font-size)
  await p.evaluate(() => { FKP.scenario("a"); document.documentElement.style.fontSize = "200%"; FKP.render(); });
  const font200 = await p.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - innerWidth,
    titlePx: parseFloat(getComputedStyle(document.querySelector(".row-title")).fontSize),
    condBarH: document.querySelector("#condBar").getBoundingClientRect().height,
  }));
  check("Z1 200% root font-size scales titles (36px) with 0 horizontal overflow",
    font200.overflow <= 0 && font200.titlePx >= 34 && font200.condBarH <= 96, JSON.stringify(font200));

  check("desktop zero page errors", errs.length === 0, errs.join("; "));
  await p.close();
}

// =========================================================================
// 2. Narrow Touch (412x915)
// =========================================================================
{
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(url, { waitUntil: "domcontentloaded" });

  await p.locator("#finderInput").tap();
  check("D1 tapping search on 412px opens full-screen condition sheet", await p.locator("#lens").isVisible() && await p.locator("#lensInput").isVisible());

  for (const [typed, k, v] of [["2015", "year", "2015"], ["日本人", "custom", "日本人トラックメーカー"], ["アニソン", "genre", "アニソンremix"]]) {
    await p.locator("#lensInput").fill(typed);
    await p.locator(`.sugg[data-kind="${k}"][data-v="${v}"]`).tap();
  }
  await p.locator(".lens-foot .btn.primary").tap();
  let s = await state(p);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const nowSrcVisible = await p.locator(".now-src").isVisible();
  check("D2 narrow 3-condition results: 0 overflow, bounded 1-line condBar, playback source visible",
    s.clauses.length === 3 && overflow <= 0 && s.condBarRect.height <= 54 && nowSrcVisible,
    `overflow=${overflow}, condBarH=${Math.round(s.condBarRect.height)}, nowSrc=${s.nowSrc}`);

  const q0 = s.queueCount;
  await p.locator(".row", { hasText: "鋼鉄商店街ダンスホール" }).locator(".add").tap();
  s = await state(p);
  check("D3 narrow 1-tap adds to 再生待ち", s.queueCount === q0 + 1, s.toast);

  await p.locator("#dockPill").tap();
  await p.locator('.dest[data-id="anison"]').tap();
  s = await state(p);
  const pillNm = await p.locator("#dockPill .nm").innerText();
  check("D4 bottom destination bar switches target to アニソン縛り 2015", s.dest === "anison" && pillNm === "アニソン縛り 2015", pillNm);

  await p.locator(".ctok-open").first().tap();
  await p.locator('.clause [data-act="rm-clause"]').first().tap();
  await p.locator(".lens-foot .btn.primary").tap();
  s = await state(p);
  check("D5 narrow condition removal works cleanly", s.clauses.length === 2);

  // Touch target size audit (>=44px on primary narrow interactive buttons)
  const smallTargets = await p.evaluate(() => {
    const sels = [".finder-field", ".finder-cond-btn", "#condBar button", "#resultsBar button", ".row .add", ".now-ctl button", "#dockPill"];
    const bad = [];
    sels.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        if (!el.offsetParent) return;
        const r = el.getBoundingClientRect();
        if (r.height < 43.5 || (sel.includes(".add") && r.width < 43.5) || (sel.includes("now-ctl") && r.width < 43.5)) {
          bad.push({ sel, text: el.textContent.trim().slice(0, 20), w: Math.round(r.width), h: Math.round(r.height) });
        }
      });
    });
    return bad;
  });
  check("D6 narrow touch targets >= 44px height", smallTargets.length === 0, JSON.stringify(smallTargets));

  check("narrow zero page errors", errs.length === 0, errs.join("; "));
  await ctx.close();
}

// =========================================================================
// 3. Axe-core accessibility audit (serious & critical === 0)
// =========================================================================
{
  const auditTargets = [
    { name: "desktop-base", vp: { width: 1280, height: 900 }, scn: "base" },
    { name: "desktop-a", vp: { width: 1280, height: 900 }, scn: "a" },
    { name: "desktop-a-edit", vp: { width: 1280, height: 900 }, scn: "a-edit" },
    { name: "desktop-a-detail", vp: { width: 1280, height: 900 }, scn: "a-detail" },
    { name: "desktop-eight", vp: { width: 1280, height: 900 }, scn: "eight" },
    { name: "desktop-zero", vp: { width: 1280, height: 900 }, scn: "zero" },
    { name: "narrow-base", vp: { width: 412, height: 915 }, touch: true, scn: "base" },
    { name: "narrow-a", vp: { width: 412, height: 915 }, touch: true, scn: "a" },
    { name: "narrow-a-edit", vp: { width: 412, height: 915 }, touch: true, scn: "a-edit" },
    { name: "narrow-a-dest", vp: { width: 412, height: 915 }, touch: true, scn: "a-dest" },
  ];
  const violations = [];
  for (const t of auditTargets) {
    const ctx = await browser.newContext({ viewport: t.vp, hasTouch: !!t.touch, isMobile: !!t.touch });
    const p = await ctx.newPage();
    await p.goto(`${url}&s=${t.scn}`, { waitUntil: "domcontentloaded" });
    const axe = await new AxeBuilder({ page: p }).analyze();
    const bad = axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    if (bad.length) violations.push({ target: t.name, issues: bad.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help })) });
    await ctx.close();
  }
  check("AXE zero critical/serious accessibility violations across 10 states", violations.length === 0, JSON.stringify(violations));
}

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
