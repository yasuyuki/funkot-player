// Drives the required flows through real input events and checks the outcome.
//   node verify.mjs <path-to-node_modules/playwright>
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright");
const url = pathToFileURL(resolve("index.html")).href + "?capture=1";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };
const state = (p) => p.evaluate(() => ({
  clauses: FKP.S.clauses.map((c) => ({ kind: c.kind, values: c.values, on: c.on, not: c.not })),
  count: document.querySelector(".query-top").dataset.count,
  queue: document.querySelector('.dest[data-id="queue"] .n').textContent,
  fri: document.querySelector('.dest[data-id="fri"] .n').textContent,
  toast: document.querySelector("#toast").hidden ? "" : document.querySelector("#toast span").textContent,
  dest: FKP.S.dest,
}));

const browser = await chromium.launch();

// ---- desktop: A, B, C with mouse and keyboard
{
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(url);
  // A: build 2015 AND 日本人トラックメーカー AND アニソンremix from candidates
  await p.keyboard.press("/");
  await p.keyboard.type("2015");
  const first = await p.locator(".sugg").first().innerText();
  check("A1 typing 2015 offers the year first", /2015/.test(first) && /制作年/.test(first), first.replace(/\s+/g, " "));
  await p.keyboard.press("Enter");
  await p.keyboard.type("日本人");
  const cands = await p.locator(".sugg").count();
  check("A2 several candidates for 日本人", cands >= 4, `${cands} candidates`);
  await p.locator('.sugg[data-v="日本人トラックメーカー"]').click();
  await p.locator("#finderInput").fill("");
  await p.locator("#finderInput").type("anison");
  const variants = await p.locator(".sugg-variants").count();
  check("A3 romaji input finds アニソンremix and lists its spelling variants", variants > 0 && (await p.locator('.sugg[data-v="アニソンremix"]').count()) === 1);
  await p.locator('.sugg[data-v="アニソンremix"]').click();
  let s = await state(p);
  check("A4 three AND conditions", s.clauses.length === 3 && s.clauses.every((c) => c.on), JSON.stringify(s.clauses.map((c) => c.values[0])));
  await p.locator(".row").first().click({ position: { x: 300, y: 30 } }); // click into results closes the lens
  const n = Number(s.count.replace(/[^0-9]/g, ""));
  const rows = await p.locator(".row").count();
  check("A5 results count shown and rows rendered", n > 0 && rows > 0, `${s.count}, ${rows} rows`);
  const stamps = await p.locator("#stamps .stamp:visible").count();
  check("A6 conditions printed as stamps in the header", stamps === 3);

  // B: pause, resume, remove, undo, add an alternative
  await p.locator(".stamp-open").first().click();
  await p.locator('.clause .switch').nth(1).click();
  s = await state(p);
  const paused = Number(s.count.replace(/[^0-9]/g, ""));
  check("B1 pausing a condition widens the result", !s.clauses[1].on && paused > n, `${n} → ${paused}`);
  await p.locator('.clause .switch').nth(1).click();
  s = await state(p);
  check("B2 resuming restores it", s.clauses[1].on && Number(s.count.replace(/[^0-9]/g, "")) === n);
  await p.locator('.clause [data-act="rm-clause"]').nth(2).click();
  s = await state(p);
  check("B3 removing drops the condition and offers undo", s.clauses.length === 2 && /外しました/.test(s.toast), s.toast);
  await p.locator("#toast button").click();
  s = await state(p);
  check("B4 undo puts it back in place", s.clauses.length === 3 && s.clauses[2].values[0] === "アニソンremix");
  await p.locator('.clause [data-act="alt"]').nth(2).click();
  await p.keyboard.type("電波");
  await p.keyboard.press("Enter");
  s = await state(p);
  check("B5 an alternative joins the same condition as OR", s.clauses[2].values.join("|") === "アニソンremix|電波remix", s.clauses[2].values.join(" / "));
  const widened = Number(s.count.replace(/[^0-9]/g, ""));
  check("B6 OR widens, does not narrow", widened >= n, `${n} → ${widened}`);
  await p.locator('.clause [data-act="rm-val"][data-v="電波remix"]').click();
  await p.keyboard.press("Escape");

  // C: identify and add in one action, then change destination
  s = await state(p);
  const q0 = Number(s.queue);
  const target = p.locator(".row", { hasText: "鋼鉄商店街ダンスホール" });
  await target.locator(".add").click();
  s = await state(p);
  check("C1 one click adds to the shown destination", Number(s.queue) === q0 + 1 && /再生待ちの\d+番目に追加/.test(s.toast), s.toast);
  const tailHas = await p.locator(".tail li.is-new", { hasText: "鋼鉄商店街ダンスホール" }).count();
  check("C2 the dock shows where it landed, before the automatic picks", tailHas === 1 && (await p.locator(".tail li").filter({ hasText: "鋼鉄商店街" }).locator("xpath=following-sibling::li[contains(@class,'boundary')]").count()) === 1);
  await p.locator('.dest[data-id="fri"]').click();
  const plusLabel = await target.locator(".add").getAttribute("aria-label");
  check("C3 the row action names the new destination", /金曜の夜に追加/.test(plusLabel), plusLabel);
  await target.locator(".add").click();
  s = await state(p);
  check("C4 adds to 金曜の夜", s.fri === "24", `fri=${s.fri}`);
  const missing = p.locator(".row", { hasText: "微熱パレード" });
  await missing.locator(".add").click({ force: true }); // aria-disabled still answers a click with the reason
  s = await state(p);
  check("C5 a missing file cannot be added and says why", s.fri === "24" && /見つからない/.test(s.toast), s.toast);
  // keyboard: focus a row, arrow down, press a
  await p.locator(".row-main").nth(1).focus();
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("a");
  s = await state(p);
  check("C6 keyboard: arrow to a row and press A to add", s.fri === "25", `fri=${s.fri}`);
  // multi-select
  await p.locator('[data-act="sel-start"]').click();
  await p.locator(".row-check").nth(1).click();
  await p.locator(".row-check").nth(2).click();
  await p.locator('[data-act="add-sel"]').click();
  s = await state(p);
  check("C7 two selected songs added together", s.fri === "27" && /2曲を/.test(s.toast), s.toast);
  // the title stays the strongest element in a row
  const sizes = await p.evaluate(() => {
    const r = document.querySelector(".row"); const t = r.querySelector(".row-title"); const a = r.querySelector(".add i");
    const tb = t.getBoundingClientRect(), ab = a.getBoundingClientRect();
    return { titlePx: parseFloat(getComputedStyle(t).fontSize), titleArea: Math.round(tb.width * tb.height), addArea: Math.round(ab.width * ab.height), hit: r.querySelector(".add").getBoundingClientRect().width };
  });
  check("C8 add control: 44px+ target, drawn smaller than the title", sizes.hit >= 44 && sizes.addArea * 4 < sizes.titleArea, JSON.stringify(sizes));
  check("desktop has no page errors", errs.length === 0, errs.join("; "));
  await p.close();
}

// ---- narrow touch: D
{
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(url);
  await p.locator("#finderInput").tap();
  check("D1 tapping search opens the full-screen condition sheet", await p.locator("#lens").isVisible() && await p.locator("#lensInput").isVisible());
  for (const [typed, k, v] of [["2015", "year", "2015"], ["日本人", "custom", "日本人トラックメーカー"], ["アニソン", "genre", "アニソンremix"]]) {
    await p.locator("#lensInput").fill(typed);
    await p.locator(`.sugg[data-kind="${k}"][data-v="${v}"]`).tap();
  }
  let s = await state(p);
  check("D2 three conditions built by tapping candidates", s.clauses.length === 3, s.clauses.map((c) => c.values[0]).join(" + "));
  const btn = await p.locator(".lens-foot .btn.primary").innerText();
  await p.locator(".lens-foot .btn.primary").tap();
  check("D3 the sheet closes on its count button", !(await p.locator("#lens").isVisible()), btn);
  const vw = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  check("D4 no horizontal overflow at 412px", vw[0] <= vw[1], vw.join(" vs "));
  const q0 = Number(s.queue);
  await p.locator(".row", { hasText: "鋼鉄商店街ダンスホール" }).locator(".add").tap();
  s = await state(p);
  check("D5 one tap adds to 再生待ち", Number(s.queue) === q0 + 1, s.toast);
  await p.locator("#dockPill").tap();
  await p.locator('.dest[data-id="anison"]').tap();
  s = await state(p);
  const pill = await p.locator("#dockPill .nm").innerText();
  check("D6 destination switched from the bottom bar", s.dest === "anison" && pill === "アニソン縛り 2015", pill);
  await p.locator(".stamp-open").first().tap();
  await p.locator('.clause [data-act="rm-clause"]').first().tap();
  s = await state(p);
  check("D7 a condition removed in the sheet", s.clauses.length === 2);
  const tgt = await p.evaluate(() => [...document.querySelectorAll(".lens button, .lens .sugg")].filter((b) => b.offsetParent).map((b) => b.getBoundingClientRect()).filter((r) => r.height < 36).length);
  check("D8 sheet controls are at least 36px tall", tgt === 0, `${tgt} smaller`);
  check("narrow has no page errors", errs.length === 0, errs.join("; "));
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
