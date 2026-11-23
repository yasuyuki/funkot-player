// Flows, screenshots, and a same-condition comparison against Overprint.
//   node verify.mjs <path-to-playwright-package>
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright");
const shotDir = resolve(here, "shots");
await mkdir(shotDir, { recursive: true });

const lineup = pathToFileURL(resolve(here, "index.html")).href;
const claude = pathToFileURL(resolve(here, "../library-ideal-claude/index.html")).href;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const measure = (kind) => ({
  row: kind === "claude" ? ".row" : ".track",
  title: kind === "claude" ? ".row-title" : ".t",
  list: kind === "claude" ? ".results" : ".list",
  add: kind === "claude" ? ".add" : ".add",
});

async function readMetrics(page, kind) {
  const sel = measure(kind);
  return page.evaluate((sel) => {
    const visible = (el) => {
      if (!el || el.closest("[hidden], .demo")) return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    };
    const list = document.querySelector(sel.list);
    const lr = list.getBoundingClientRect();
    const rows = [...document.querySelectorAll(sel.row)].filter((el) => {
      const r = el.getBoundingClientRect();
      return Math.min(r.bottom, lr.bottom) - Math.max(r.top, lr.top) > 28;
    });
    const title = document.querySelector(sel.title);
    const add = document.querySelector(sel.add);
    const glyph = add?.querySelector("svg");
    const chrome = [...document.querySelectorAll("button, a, input")].filter((el) => {
      if (el.closest(sel.row + ", .demo")) return false;
      return visible(el);
    });
    const summary = document.querySelector(".summary, .stamps, .query");
    return {
      firstRowTop: rows[0] ? Math.round(rows[0].getBoundingClientRect().top) : null,
      titleWidth: title ? Math.round(title.getBoundingClientRect().width) : null,
      titleFont: title ? getComputedStyle(title).fontSize : null,
      visibleTracks: rows.length,
      chromeControls: chrome.length,
      chromeNames: chrome.map((el) => (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40)),
      summaryHeight: summary ? Math.round(summary.getBoundingClientRect().height) : null,
      addHit: add ? Math.round(add.getBoundingClientRect().width) : null,
      addGlyph: glyph ? Math.round(glyph.getBoundingClientRect().width) : null,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  }, sel);
}

async function prep(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector(".track, .row, .empty");
}

const browser = await chromium.launch();
const metrics = { lineup: {}, claude: {} };

{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(lineup + "?capture=1");
  await prep(page);
  metrics.lineup.desktopBase = await readMetrics(page, "lineup");
  await page.screenshot({ path: resolve(shotDir, "desktop-base.png") });

  await page.keyboard.press("/");
  await page.keyboard.type("2015");
  await page.waitForSelector(".cand");
  const first = (await page.locator(".cand").first().innerText()).replace(/\s+/g, " ");
  check("A1 2015は制作年の候補が先", /制作年/.test(first) && /2015年/.test(first), first);
  await page.keyboard.press("Enter");
  await page.keyboard.type("日本人");
  await page.locator(".cand", { hasText: "日本人トラックメーカー" }).first().click();
  await page.locator("#q").fill("");
  await page.keyboard.type("anison");
  await page.waitForSelector(".bundle");
  const hasTag = await page.locator(".cand", { hasText: "アニソンremix" }).count();
  check("A2 ローマ字でアニソンremixと表記ゆれ", hasTag === 1 && await page.locator(".bundle").count() > 0);
  await page.locator(".cand", { hasText: "アニソンremix" }).first().click();
  await page.keyboard.press("Escape");
  const clauses = await page.evaluate(() => FKP.S.clauses.map((c) => c.values[0]));
  check("A3 3条件のAND", clauses.join("|") === "2015|日本人トラックメーカー|アニソンremix", clauses.join(" / "));
  const count = await page.locator("#count").innerText();
  const n = Number(count.replace(/[^0-9]/g, ""));
  check("A4 件数と曲名が見える", n > 0 && await page.locator(".t").count() > 0, count);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  metrics.lineup.desktopA = await readMetrics(page, "lineup");
  await page.screenshot({ path: resolve(shotDir, "desktop-a.png") });

  await page.locator("#sumBtn").click();
  await page.locator('[data-act="pause"]').nth(1).click();
  const paused = Number((await page.locator("#count").innerText()).replace(/[^0-9]/g, ""));
  const pausedOn = await page.evaluate(() => FKP.S.clauses[1].on);
  check("B1 一時停止で結果が広がる", pausedOn === false && paused > n, `${n} → ${paused}`);
  await page.locator('[data-act="pause"]').nth(1).click();
  const resumed = Number((await page.locator("#count").innerText()).replace(/[^0-9]/g, ""));
  check("B2 再開で戻る", resumed === n, String(resumed));
  await page.locator('[data-act="rm"]').nth(2).click();
  check("B3 外すと取り消しが出る", /外しました/.test(await page.locator("#toast").innerText()));
  await page.locator("#toastAct").click();
  const back = await page.evaluate(() => FKP.S.clauses.map((c) => c.values[0]));
  check("B4 元に戻す", back[2] === "アニソンremix", back.join(" / "));
  await page.locator('[data-act="or"]').nth(2).click();
  await page.keyboard.type("電波");
  await page.keyboard.press("Enter");
  const orVals = await page.evaluate(() => FKP.S.clauses[2].values.join("|"));
  check("B5 またはは同じ条件に入る", orVals === "アニソンremix|電波remix", orVals);
  await page.keyboard.press("Escape");

  const before = await page.locator(".ticket .nm").innerText();
  await page.locator(".track", { hasText: "鋼鉄商店街ダンスホール" }).locator(".add").click();
  const toast = await page.locator("#toast").innerText();
  check("C1 1操作で追加先が見える", before === "再生待ち" && /再生待ちの\d+番目/.test(toast), toast.replace(/\s+/g, " "));
  await page.goto(lineup + "?capture=1&s=added");
  await prep(page);
  metrics.lineup.desktopAdded = await readMetrics(page, "lineup");
  await page.screenshot({ path: resolve(shotDir, "desktop-added.png") });
  await page.locator("#destBtn").click();
  await page.locator('[data-act="dest"][data-id="fri"]').click();
  check("C2 追加先を変えられる", (await page.locator(".ticket .nm").innerText()) === "金曜の夜");
  const add = page.locator(".track", { hasText: "月面行進曲" }).locator(".add");
  await add.focus();
  await page.keyboard.press("Enter");
  check("C3 キーボードで追加", /金曜の夜の/.test(await page.locator("#toast").innerText()));
  const hit = metrics.lineup.desktopA.addHit;
  const glyph = metrics.lineup.desktopA.addGlyph;
  check("C4 当たりは44px以上、印は曲名より小さい", hit >= 44 && glyph <= 18, `hit ${hit} glyph ${glyph}`);

  await page.goto(lineup + "?capture=1&s=a-edit");
  await prep(page);
  await page.screenshot({ path: resolve(shotDir, "desktop-edit.png") });
  await page.goto(lineup + "?capture=1&s=eight");
  await prep(page);
  metrics.lineup.desktopEight = await readMetrics(page, "lineup");
  const eightText = await page.locator("#sumBtn").innerText();
  check("E1 9条件は1行の要約", /9条件/.test(eightText) && metrics.lineup.desktopEight.summaryHeight <= 40, `${eightText} h=${metrics.lineup.desktopEight.summaryHeight}`);
  check("E2 9条件でも最初の曲が見える", metrics.lineup.desktopEight.visibleTracks >= 6 && metrics.lineup.desktopEight.firstRowTop != null, JSON.stringify(metrics.lineup.desktopEight));
  await page.screenshot({ path: resolve(shotDir, "desktop-eight.png") });
  await page.goto(lineup + "?capture=1&s=detail");
  await prep(page);
  await page.screenshot({ path: resolve(shotDir, "desktop-detail.png") });
  await page.goto(lineup + "?capture=1&s=zero");
  await page.waitForSelector(".empty");
  check("Z1 0件は外すと何曲かを示す", /外すと/.test(await page.locator(".empty").innerText()));
  await page.screenshot({ path: resolve(shotDir, "desktop-zero.png") });
  await page.goto(lineup + "?capture=1&s=error");
  await prep(page);
  check("Z2 失敗は条件を残して再試行", /照合できませんでした/.test(await page.locator("[role=alert]").innerText()));
  await page.screenshot({ path: resolve(shotDir, "desktop-error.png") });
  await page.goto(lineup + "?capture=1&s=zoom");
  await prep(page);
  const zoom = await readMetrics(page, "lineup");
  check("Z3 文字200%で横にはみ出さない", zoom.overflow <= 1 && zoom.visibleTracks >= 1, `overflow ${zoom.overflow} tracks ${zoom.visibleTracks}`);
  await page.screenshot({ path: resolve(shotDir, "desktop-zoom.png") });
  check("ページ例外なし", errors.length === 0, errors.join(" | "));
  await page.close();
}

{
  const page = await browser.newPage({ viewport: { width: 412, height: 915 }, hasTouch: true });
  await page.goto(lineup + "?capture=1");
  await prep(page);
  metrics.lineup.narrowBase = await readMetrics(page, "lineup");
  await page.screenshot({ path: resolve(shotDir, "narrow-base.png") });
  await page.tap("#q");
  await page.keyboard.type("2015");
  await page.waitForSelector(".cand");
  await page.tap(".cand");
  await page.keyboard.type("日本人トラックメーカー");
  await page.locator(".cand", { hasText: "日本人トラックメーカー" }).first().tap();
  await page.locator("#q").fill("");
  await page.keyboard.type("anison");
  await page.locator(".cand", { hasText: "アニソンremix" }).first().tap();
  await page.keyboard.press("Escape");
  const n = Number((await page.locator("#count").innerText()).replace(/[^0-9]/g, ""));
  check("D1 狭幅でも3条件", n > 0);
  metrics.lineup.narrowA = await readMetrics(page, "lineup");
  await page.screenshot({ path: resolve(shotDir, "narrow-a.png") });
  const row = page.locator(".track", { hasText: "月面行進曲" }).locator(".add");
  await row.tap();
  check("D2 狭幅で1タップ追加", /番目に追加/.test(await page.locator("#toast").innerText()));
  await page.screenshot({ path: resolve(shotDir, "narrow-added.png") });
  await page.goto(lineup + "?capture=1&s=a-edit");
  await prep(page);
  await page.screenshot({ path: resolve(shotDir, "narrow-edit.png") });
  await page.goto(lineup + "?capture=1&s=eight");
  await prep(page);
  metrics.lineup.narrowEight = await readMetrics(page, "lineup");
  await page.screenshot({ path: resolve(shotDir, "narrow-eight.png") });
  await page.goto(lineup + "?capture=1&s=detail");
  await prep(page);
  await page.screenshot({ path: resolve(shotDir, "narrow-detail.png") });
  await page.goto(lineup + "?capture=1&s=zero");
  await page.waitForSelector(".empty");
  await page.screenshot({ path: resolve(shotDir, "narrow-zero.png") });
  await page.goto(lineup + "?capture=1&s=error");
  await prep(page);
  await page.screenshot({ path: resolve(shotDir, "narrow-error.png") });
  check("D3 狭幅で横にはみ出さない", metrics.lineup.narrowBase.overflow <= 1 && metrics.lineup.narrowA.overflow <= 1 && metrics.lineup.narrowEight.overflow <= 1);
  check("D4 狭幅の追加先が読める", (await page.locator(".ticket .nm").innerText()).length > 0);
  await page.close();
}

for (const [label, vp, query] of [
  ["desktopBase", { width: 1280, height: 900 }, "s=base"],
  ["desktopA", { width: 1280, height: 900 }, "s=a"],
  ["desktopEight", { width: 1280, height: 900 }, "s=eight"],
  ["narrowBase", { width: 412, height: 915 }, "s=base"],
  ["narrowA", { width: 412, height: 915 }, "s=a"],
  ["narrowEight", { width: 412, height: 915 }, "s=eight"],
]) {
  const page = await browser.newPage({ viewport: vp });
  await page.goto(`${claude}?capture=1&${query}`);
  await prep(page);
  metrics.claude[label] = await readMetrics(page, "claude");
  await page.close();
}

const delta = (key) => {
  const a = metrics.claude[key];
  const b = metrics.lineup[key];
  if (!a || !b) return null;
  return {
    firstRowTop: [a.firstRowTop, b.firstRowTop],
    titleWidth: [a.titleWidth, b.titleWidth],
    visibleTracks: [a.visibleTracks, b.visibleTracks],
    chromeControls: [a.chromeControls, b.chromeControls],
    summaryHeight: [a.summaryHeight, b.summaryHeight],
  };
};
const compare = {
  desktopBase: delta("desktopBase"),
  desktopA: delta("desktopA"),
  desktopEight: delta("desktopEight"),
  narrowBase: delta("narrowBase"),
  narrowA: delta("narrowA"),
  narrowEight: delta("narrowEight"),
};
console.log(JSON.stringify(compare, null, 2));
check("比較 狭幅の初期画面で曲名が上に来る", compare.narrowBase && compare.narrowBase.firstRowTop[1] < compare.narrowBase.firstRowTop[0] - 40, JSON.stringify(compare.narrowBase));
check("比較 狭幅の検索後も曲一覧が広い", compare.narrowA && compare.narrowA.visibleTracks[1] > compare.narrowA.visibleTracks[0], JSON.stringify(compare.narrowA));
check("比較 常設操作が少ない", compare.desktopBase && compare.desktopBase.chromeControls[1] < compare.desktopBase.chromeControls[0], JSON.stringify(compare.desktopBase));

await writeFile(resolve(here, "verification.json"), JSON.stringify({ results, metrics, compare }, null, 2));
await browser.close();
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n${failed.length} failed`);
  process.exit(1);
}
console.log(`\n${results.length} passed`);
