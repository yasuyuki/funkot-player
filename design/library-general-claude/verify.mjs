// Drives the #170 flows through real input events and checks the outcome.
//   node verify.mjs <path-to-node_modules/playwright>
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright");
const url = pathToFileURL(resolve("index.html")).href + "?capture=1";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };
const state = (p) => p.evaluate(() => ({
  clauses: FKP.S.clauses.map((c) => ({ kind: c.kind, values: c.values, on: c.on, not: c.not })),
  mode: FKP.S.mode,
  count: Number(document.querySelector("#rbCount b")?.textContent.replace(/[^0-9]/g, "") || -1),
  queue: Number(document.querySelector('.dest[data-id="queue"] .n').textContent),
  fri: Number(document.querySelector('.dest[data-id="fri"] .n').textContent),
  toast: document.querySelector("#toast").hidden ? "" : document.querySelector("#toast span").textContent,
  dest: FKP.S.dest,
}));
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

const browser = await chromium.launch();

// ---- desktop 1280x900, mouse and keyboard
{
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(url);
  await p.evaluate(() => document.fonts.ready);
  check("S1 opening screen: no condition line, the list starts under one search field", await p.locator("#summary").isHidden() && (await p.locator(".row").count()) > 0);

  // A: candidates -> 2015 AND 日本人トラックメーカー AND アニソンremix
  await p.keyboard.press("/");
  check("A0 / focuses the search field", await p.evaluate(() => document.activeElement.id === "finderInput"));
  await p.keyboard.type("2015");
  const first = await p.locator(".sugg").first().innerText();
  check("A1 typing 2015 offers the year with its count", /2015/.test(first) && /制作年/.test(first) && /加えると/.test(first), first.replace(/\s+/g, " "));
  await p.keyboard.press("Enter");
  await p.keyboard.type("日本人");
  check("A2 several candidates for 日本人", (await p.locator(".sugg").count()) >= 4);
  await p.locator('.sugg[data-v="日本人トラックメーカー"]').click();
  await p.locator("#finderInput").fill("");
  await p.locator("#finderInput").type("anison");
  check("A3 romaji finds アニソンremix and lists spelling variants", (await p.locator(".sugg-variants").count()) > 0 && (await p.locator('.sugg[data-v="アニソンremix"]').count()) === 1);
  await p.locator('.sugg[data-v="アニソンremix"]').click();
  let s = await state(p);
  check("A4 three AND conditions", s.clauses.length === 3 && s.mode === "all", s.clauses.map((c) => c.values[0]).join(" + "));
  check("A5 the editor is a separate surface with its own exit", await p.locator("#lens").isVisible() && await p.locator("#summary").isHidden() && await p.locator(".lens-foot .btn.primary").isVisible());
  await p.locator(".lens-foot .btn.primary").click();
  s = await state(p);
  const n = s.count;
  check("A6 back to results: count shown, one condition line with three terms", n > 0 && (await p.locator("#lens").isHidden()) && (await p.locator("#terms .term:visible").count()) === 3, `${n}曲`);
  const geo = await p.evaluate(() => ({ sum: document.querySelector("#summary").getBoundingClientRect().height, first: document.querySelector(".row").getBoundingClientRect().top }));
  check("A7 the condition line is one line (≤ 48px)", geo.sum <= 48, JSON.stringify(geo));

  // B: edit, pause, remove, undo, OR, clear and restore
  await p.locator("#terms .term").nth(1).click();
  check("B0 a term opens the editor", await p.locator("#lens").isVisible());
  await p.locator(".clause .switch").nth(1).click();
  s = await state(p);
  check("B1 pausing widens the result", !s.clauses[1].on && FKP_count(s) > n, `${n} → ${s.count}`);
  await p.locator(".clause .switch").nth(1).click();
  s = await state(p);
  check("B2 resuming restores it", s.clauses[1].on && s.count === n);
  await p.locator('.clause [data-act="rm-clause"]').nth(2).click();
  s = await state(p);
  check("B3 removing offers undo", s.clauses.length === 2 && /外しました/.test(s.toast), s.toast);
  await p.locator("#toast button").click();
  s = await state(p);
  check("B4 undo puts it back in place", s.clauses.length === 3 && s.clauses[2].values[0] === "アニソンremix");
  await p.locator('.seg [data-v="any"]').click();
  s = await state(p);
  check("B5 どれかに一致 widens and the joiners read または", s.mode === "any" && s.count > n && (await p.locator(".clause-join").nth(1).innerText()) === "または", `${n} → ${s.count}`);
  await p.locator('.seg [data-v="all"]').click();
  await p.keyboard.press("Escape");
  check("B6 Escape closes the editor and returns focus to the field", (await p.locator("#lens").isHidden()) && await p.evaluate(() => document.activeElement.id === "finderInput"));
  await p.locator(".sum-clear").click();
  s = await state(p);
  check("B7 × clears all conditions and offers undo", s.clauses.length === 0 && /すべて外しました/.test(s.toast));
  await p.locator("#toast button").click();
  s = await state(p);
  check("B8 undo restores all three", s.clauses.length === 3 && s.count === n);
  await p.locator(".sum-clear").click();
  await p.locator("#finderInput").click();
  const recent = p.locator(".recent button").first();
  const rText = await recent.innerText();
  await recent.click();
  s = await state(p);
  check("B9 the recent list restores the cleared conditions", s.clauses.length === 3 && s.count === n, rText.replace(/\s+/g, " "));
  await p.keyboard.press("Escape");

  // C: identify, add in one action, see where it went, change destination
  s = await state(p);
  const q0 = s.queue;
  const target = p.locator(".row", { hasText: "鋼鉄商店街ダンスホール" });
  check("C0 the add control names its destination", /再生待ちに追加/.test(await target.locator(".add").getAttribute("aria-label")));
  await target.locator(".add").click();
  s = await state(p);
  check("C1 one click adds to the shown destination", s.queue === q0 + 1 && /再生待ちの\d+番目に追加/.test(s.toast), s.toast);
  check("C2 the row says where it landed", /再生待ちの\d+番目/.test(await target.locator(".st.in").innerText()));
  check("C3 the dock tail shows it before the automatic picks", (await p.locator(".tail li.is-new", { hasText: "鋼鉄商店街ダンスホール" }).count()) === 1);
  check("C4 the destination list is folded until asked", await p.locator("#dests").isHidden());
  await p.locator(".dock-change").click();
  await p.locator('.dest[data-id="fri"]').click();
  const plusLabel = await target.locator(".add").getAttribute("aria-label");
  check("C5 after switching, the row action names the new destination", /金曜の夜に追加/.test(plusLabel) && (await p.locator("#dests").isHidden()), plusLabel);
  const fri0 = (await state(p)).fri;
  await target.locator(".add").click();
  s = await state(p);
  check("C6 adds to 金曜の夜", s.fri === fri0 + 1, `fri=${s.fri}`);
  await p.locator(".row", { hasText: "微熱パレード" }).locator(".add").click({ force: true });
  s = await state(p);
  check("C7 a missing file cannot be added and says why", s.fri === fri0 + 1 && /見つからない/.test(s.toast), s.toast);
  await p.locator(".row-main").nth(1).focus();
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("a");
  s = await state(p);
  check("C8 keyboard: arrow to a row and press A", s.fri === fri0 + 2, `fri=${s.fri}`);
  const sizes = await p.evaluate(() => {
    const r = document.querySelectorAll(".row")[2]; const t = r.querySelector(".row-title"); const a = r.querySelector(".add svg");
    const tb = t.getBoundingClientRect(), ab = a.getBoundingClientRect(), hb = r.querySelector(".add").getBoundingClientRect();
    return { titlePx: parseFloat(getComputedStyle(t).fontSize), titleArea: Math.round(tb.width * tb.height), glyphArea: Math.round(ab.width * ab.height), hit: [hb.width, hb.height] };
  });
  check("C9 add: ≥ 28px mouse target, glyph far smaller than the title", sizes.hit[0] >= 28 && sizes.glyphArea * 10 < sizes.titleArea, JSON.stringify(sizes));

  // scale: 9 conditions stay on one line
  await p.evaluate(() => FKP.scenario("eight"));
  await p.evaluate(() => FKP.render());
  const g9 = await p.evaluate(() => ({ sum: document.querySelector("#summary").getBoundingClientRect().height, first: document.querySelector(".row").getBoundingClientRect().top, more: document.querySelector(".t-more")?.textContent }));
  check("E1 nine conditions: still one line, the rest folds into ほかN, list does not move", g9.sum <= 48 && /ほか\d+つ/.test(g9.more || "") && Math.abs(g9.first - geo.first) < 2, JSON.stringify(g9));
  await p.locator(".t-more").click();
  check("E2 ほかN opens the editor with all nine", (await p.locator(".clause").count()) === 9);
  check("desktop has no page errors", errs.length === 0, errs.join("; "));
  await p.close();
}
function FKP_count(s) { return s.count; }

// ---- narrow 412x915 touch
{
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(url);
  await p.evaluate(() => document.fonts.ready);
  await p.locator("#finderInput").tap();
  check("D1 tapping search opens the full-screen condition sheet", await p.locator("#lens").isVisible() && await p.locator("#lensInput").isVisible());
  for (const [typed, k, v] of [["2015", "year", "2015"], ["日本人", "custom", "日本人トラックメーカー"], ["アニソン", "genre", "アニソンremix"]]) {
    await p.locator("#lensInput").fill(typed);
    await p.locator(`.sugg[data-kind="${k}"][data-v="${v}"]`).tap();
  }
  let s = await state(p);
  check("D2 three conditions built by tapping", s.clauses.length === 3);
  await p.locator(".lens-foot .btn.primary").tap();
  check("D3 the sheet closes on its count button", await p.locator("#lens").isHidden());
  check("D4 no horizontal overflow at 412px", await noOverflow(p));
  const q0 = s.queue;
  const tgt = p.locator(".row", { hasText: "鋼鉄商店街ダンスホール" });
  await tgt.locator(".add").tap();
  s = await state(p);
  check("D5 one tap adds to 再生待ち", s.queue === q0 + 1, s.toast);
  await p.locator(".dest-chip").tap();
  check("D6 the destination chip opens the sheet with every destination", await p.locator("#dests").isVisible() && (await p.locator(".dest").count()) === 5);
  await p.locator('.dest[data-id="anison"]').tap();
  s = await state(p);
  check("D7 destination switched", s.dest === "anison" && (await p.locator(".dest-chip .nm").innerText()) === "アニソン縛り 2015");
  await p.locator("#terms .term").first().tap();
  await p.locator('.clause [data-act="rm-clause"]').first().tap();
  s = await state(p);
  check("D8 a condition removed in the sheet", s.clauses.length === 2);
  const small = await p.evaluate(() => [...document.querySelectorAll(".lens button, .lens .sugg, .lens input")].filter((b) => b.offsetParent).map((b) => b.getBoundingClientRect()).filter((r) => r.height < 44).length);
  check("D9 sheet controls are at least 44px tall", small === 0, `${small} smaller`);
  await p.locator(".lens-foot .btn.primary").tap();
  const smallMain = await p.evaluate(() => [...document.querySelectorAll("button, a.tab, input, select")].filter((b) => b.offsetParent && !b.closest(".demo") && !b.closest("[hidden]")).map((b) => [b.getBoundingClientRect(), b.className]).filter(([r]) => r.width > 0 && r.top < innerHeight && r.bottom > 0 && (r.height < 44 || r.width < 44)).map(([, c]) => c));
  check("D10 every visible control on the results screen is ≥ 44px", smallMain.length === 0, smallMain.join(", "));
  check("narrow has no page errors", errs.length === 0, errs.join("; "));
  await ctx.close();
}

// ---- 200%: 1280x900 at 200% is a 640x450 CSS viewport
{
  const p = await browser.newPage({ viewport: { width: 640, height: 450 }, deviceScaleFactor: 2 });
  await p.goto(url + "&s=a");
  await p.evaluate(() => document.fonts.ready);
  await p.evaluate(() => FKP.render());
  const z = await p.evaluate(() => ({ first: document.querySelector(".row").getBoundingClientRect().top, add: document.querySelector(".row .add").getBoundingClientRect().right, w: innerWidth }));
  check("Z1 200%: no horizontal overflow, first row and its add control on screen", (await noOverflow(p)) && z.first < 300 && z.add <= z.w, JSON.stringify(z));
  await p.close();
}

// ---- accessibility names
{
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await p.goto(url + "&s=a");
  const unnamed = await p.evaluate(() => [...document.querySelectorAll("button, input, select, a")].filter((b) => b.offsetParent && !b.closest(".demo")).filter((b) => !(b.getAttribute("aria-label") || b.textContent.trim() || (b.id && document.querySelector(`label[for="${b.id}"]`)))).map((b) => b.outerHTML.slice(0, 80)));
  check("N1 every visible control has an accessible name", unnamed.length === 0, unnamed.join(" | "));
  const row = await p.locator(".row-main").first().getAttribute("aria-label");
  check("N2 a row reads as title and artist", /微熱パレード.*鉄塔ガールズ/.test(row), row);
  await p.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok).length;
writeFileSync("verify-result.json", JSON.stringify({ passed: results.length - failed, total: results.length, results }, null, 1) + "\n");
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
