// Drives the #170 base (Overprint Liner) and this proposal through the same
// tasks and measures steps, choices on screen and list position.
//   node compare.mjs <path-to-node_modules/playwright>
// Writes compare/metrics.json, compare/metrics.md and side-by-side PNGs.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright");
const BASE = pathToFileURL(resolve("../library-general-claude/index.html")).href;
const MINE = pathToFileURL(resolve("index.html")).href;
mkdirSync("compare", { recursive: true });
const browser = await chromium.launch();
const out = { desktop: {}, narrow: {} };

const VIEW = {
  desktop: { viewport: { width: 1280, height: 900 } },
  narrow: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
};
async function pageFor(which, vp, s = "base") {
  const ctx = await browser.newContext({ reducedMotion: "reduce", ...VIEW[vp] });
  const page = await ctx.newPage();
  await page.goto(`${which === "base" ? BASE : MINE}?capture=1&s=${s}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(100);
  return { ctx, page };
}
// controls a person can see and press in a region, inside the viewport
const controls = (page, root) => page.evaluate((r) => [...document.querySelectorAll(`${r} button, ${r} input, ${r} [role=option], ${r} summary, ${r} select`)]
  .filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight && e.checkVisibility() && !e.disabled; }).length, root);
const count = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => e.checkVisibility()).length, sel);
const rowTop = (page) => page.evaluate(() => Math.round(document.querySelector(".row").getBoundingClientRect().top));
const press = async (page, vp, sel) => (vp === "narrow" ? page.tap(sel) : page.click(sel));
const finder = (vp, which) => (vp === "narrow" ? "#lensInput" : "#finderInput");

async function snap(page, name) { await page.screenshot({ path: `compare/_${name}.png` }); }

for (const vp of ["desktop", "narrow"]) {
  const R = (out[vp] = {});
  for (const which of ["base", "mine"]) {
    const r = (R[which] = {});
    const { ctx, page } = await pageFor(which, vp);
    // ---- first condition: tap the field, type 2015, pick, show
    let steps = 0;
    await press(page, vp, "#finderInput"); steps++;
    await page.fill(finder(vp), "2015"); steps++;
    r.typed2015 = {
      choices: await controls(page, "#lens"),
      kindHeaders: await count(page, ".sugg-h"),
      ambiguityNote: await count(page, ".amb"),
    };
    await page.keyboard.press("Enter"); steps++;
    r.afterFirst = {
      choices: await controls(page, "#lens"),
      advanced: await count(page, '#lens [role=switch], #lens [data-act="not"], #lens [data-act="alt"], #lens .seg, #lens .mode, #lens .tray, #lens [data-act="rm-clause"]'),
    };
    await snap(page, `${vp}-${which}-first`);
    // ---- 3 AND conditions
    await page.fill(finder(vp), "日本人"); steps++;
    await press(page, vp, '.sugg[data-kind="custom"][data-v="日本人トラックメーカー"]'); steps++;
    await page.fill(finder(vp), "anison"); steps++;
    r.typedAnison = { choices: await controls(page, "#lens"), joinHint: await count(page, ".sugg .how") };
    await snap(page, `${vp}-${which}-typing`);
    await press(page, vp, '.sugg[data-kind="genre"][data-v="アニソンremix"]'); steps++;
    await press(page, vp, "#lens .lens-foot .btn.primary"); steps++;
    r.threeAnd = { steps, rowTop: await rowTop(page), lineChoices: await controls(page, "#summary"), count: await page.textContent("#rbCount b") };
    // ---- remove one condition
    let rm = 0;
    if (which === "mine" && vp === "desktop") { await press(page, vp, "#summary .t-x >> nth=2"); rm = 1; }
    else {
      await press(page, vp, '#summary .term[data-kind="genre"]:visible, #summary .t-more:visible'); rm++;
      if (which === "base") { await press(page, vp, '#lens .clause:last-of-type [data-act="rm-clause"]'); rm++; }
      else { await press(page, vp, '#lens .cl[data-id] .val button >> nth=-1'); rm++; }
    }
    r.removeOne = { steps: rm, left: await page.evaluate(() => window.FKP.S.clauses.length) };
    await page.goto(`${which === "base" ? BASE : MINE}?capture=1&s=a`); await page.waitForTimeout(80);
    // ---- pause one condition, with or without a count shown before
    await press(page, vp, '#summary .term[data-kind="custom"]');
    const preview = which === "mine" ? await page.$eval('#lens .tray [data-act="toggle"] .tray-n', (e) => e.textContent.trim()).catch(() => null) : null;
    r.editOpen = { choices: await controls(page, "#lens") };
    await snap(page, `${vp}-${which}-edit`);
    if (which === "base") await press(page, vp, '#lens .clause:nth-of-type(2) [role=switch]');
    else await press(page, vp, '#lens .tray [data-act="toggle"]');
    r.pauseOne = { steps: 2, countShownBefore: preview };
    // ---- detail
    await page.goto(`${which === "base" ? BASE : MINE}?capture=1&s=a`); await page.waitForTimeout(80);
    const id = await page.evaluate(() => { const s = window.FK.songs.find((x) => x.title === "放課後シグナル (Funkot Remix)" && x.fmt === "MP3"); return s.id; });
    await page.$eval(`.row[data-id="${id}"]`, (e) => e.scrollIntoView({ block: "start" }));
    await press(page, vp, `.row[data-id="${id}"] .row-main`);
    await page.$eval(`.row[data-id="${id}"]`, (e) => e.scrollIntoView({ block: "start" }));
    const d = `.row[data-id="${id}"] .detail`;
    r.detail = {
      choices: await controls(page, d),
      text: await page.evaluate((s) => { const t = document.querySelector(s).innerText; return { yearSource: /ファイルの日付|埋め込み情報から/.test(t), path: /Music\/Downloads/.test(t), rawFields: /TDRC|TIT2/.test(t), hash: /4b7e0c92/.test(t), candidates: /録音日|制作年の決め方/.test(t) }; }, d),
    };
    await snap(page, `${vp}-${which}-detail`);
    if (which === "mine") {
      await press(page, vp, `${d} .tech summary`);
      r.detail.layer2 = await page.evaluate((s) => { const t = document.querySelector(s).innerText; return { path: /Music\/Downloads/.test(t), rawFields: /TDRC|TIT2/.test(t), hash: /4b7e0c92/.test(t), candidates: /制作年の決め方/.test(t) }; }, d);
    }
    // ---- single tag edit: add one, remove one, save
    let te = 1; // the row was opened above
    await press(page, vp, `${d} [data-act="edit-tags"]`); te++;
    if (which === "base") {
      await page.fill("#tagEdit", "コール入り"); te++;
      await snap(page, `${vp}-${which}-tagedit`);
      await page.keyboard.press("Enter"); te++;
      r.tagEdit = { possible: false, why: "削除と保存の操作がなく、入力して Enter で行に加わるだけ（保存しない）", stepsUntilStuck: te, removeButtons: await count(page, `${d} [aria-label*="外す"]`) };
    } else {
      r.editorOpen = { choices: await controls(page, "#editor") };
      await page.fill("#edInput", "コール"); te++;
      await page.keyboard.press("Enter"); te++;
      await press(page, vp, '#editor .tg[data-k="genre:アニソンremix"] [data-act="ed-rm"]'); te++;
      await snap(page, `${vp}-${which}-tagedit`);
      await press(page, vp, ".ed-save"); te++;
      await page.waitForSelector("#editor .ed", { state: "detached" });
      r.tagEdit = { possible: true, steps: te, saved: (await page.textContent("#toast")).includes("保存しました") };
      // cancel
      await press(page, vp, `${d} [data-act="edit-tags"]`);
      await page.fill("#edInput", "多幸感"); await page.keyboard.press("Enter");
      await press(page, vp, '[data-act="ed-cancel"]');
      r.cancel = { steps: 1, undoOffered: (await page.textContent("#toast")).includes("下書きに戻る") };
      // conflict recovery
      await press(page, vp, "#toast button");
      await page.$eval('#demo [data-sim="other"]', (b) => b.click());
      let cr = 0;
      await press(page, vp, '[data-act="ed-reload"]'); cr++;
      await press(page, vp, ".ed-save"); cr++;
      await page.waitForSelector("#editor .ed", { state: "detached" });
      r.conflict = { steps: cr, draftKept: (await page.evaluate(() => window.FKP.effOf("after-mp3"))).includes("custom:多幸感") };
    }
    // ---- list start in the untouched area (non-target regions keep the base layout)
    for (const s of ["base", "a", "eight"]) { await page.goto(`${which === "base" ? BASE : MINE}?capture=1&s=${s}`); await page.waitForTimeout(80); r["rowTop_" + s] = await rowTop(page); }
    await ctx.close();
  }
}

// ---- side-by-side images
const pairs = ["first", "typing", "edit", "detail", "tagedit"];
const ctx = await browser.newContext({ viewport: { width: 1400, height: 800 } });
const page = await ctx.newPage();
for (const vp of ["desktop", "narrow"]) for (const p of pairs) {
  const w = vp === "desktop" ? 1280 : 412;
  await page.setViewportSize({ width: w * 2 + 60, height: vp === "desktop" ? 960 : 980 });
  writeFileSync("compare/_pair.html", `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#2a2950;font:600 15px system-ui;color:#fff;display:flex;gap:20px;padding:10px 20px">
    <figure style="margin:0;width:${w}px"><figcaption style="padding:4px 0 8px">#170 Overprint Liner（ベース）</figcaption><img src="_${vp}-base-${p}.png" style="width:${w}px;display:block"></figure>
    <figure style="margin:0;width:${w}px"><figcaption style="padding:4px 0 8px">#173 Liner Proof（この案）</figcaption><img src="_${vp}-mine-${p}.png" style="width:${w}px;display:block"></figure></body>`);
  await page.goto(pathToFileURL(resolve("compare/_pair.html")).href);
  await page.waitForTimeout(100);
  const exists = await page.evaluate(() => [...document.images].every((i) => i.naturalWidth > 0));
  if (!exists) throw new Error(`missing capture for ${vp}-${p}`);
  await page.screenshot({ path: `compare/${vp}-${p}.png`, fullPage: true });
}
// the single captures are inputs to the pairs; keep only the pairs
readdirSync("compare").filter((f) => f.startsWith("_")).forEach((f) => unlinkSync(`compare/${f}`));
await browser.close();
writeFileSync("compare/metrics.json", JSON.stringify(out, null, 2) + "\n");

// ---- table
const rows = [];
const v = (x) => (x === undefined || x === null ? "—" : typeof x === "boolean" ? (x ? "あり" : "なし") : x);
for (const vp of ["desktop", "narrow"]) {
  const B = out[vp].base, M = out[vp].mine;
  rows.push(`\n### ${vp === "desktop" ? "desktop 1280×900（マウス）" : "narrow 412×915（タッチ）"}\n`, "| 項目 | ベース | この案 |", "| --- | --- | --- |");
  rows.push(`| 「2015」入力中の操作できる要素 | ${B.typed2015.choices} | ${M.typed2015.choices} |`);
  rows.push(`| 　候補の種類見出し／両方にある注意 | ${B.typed2015.kindHeaders}／${v(!!B.typed2015.ambiguityNote)} | ${M.typed2015.kindHeaders}／${v(!!M.typed2015.ambiguityNote)} |`);
  rows.push(`| 最初の条件を足した直後の操作できる要素 | ${B.afterFirst.choices} | ${M.afterFirst.choices} |`);
  rows.push(`| 　うち一時停止・これ以外・または・削除・組み方 | **${B.afterFirst.advanced}** | **${M.afterFirst.advanced}** |`);
  rows.push(`| 3条件ANDを作る手数（入力を1手） | ${B.threeAnd.steps} | ${M.threeAnd.steps} |`);
  rows.push(`| 　入力中に「かつ／または で加わる」が見える候補 | ${B.typedAnison.joinHint} | ${M.typedAnison.joinHint} |`);
  rows.push(`| 　「anison」入力中の操作できる要素 | ${B.typedAnison.choices} | ${M.typedAnison.choices} |`);
  rows.push(`| 条件を1つ外す手数 | ${B.removeOne.steps} | ${M.removeOne.steps} |`);
  rows.push(`| 条件を一時停止する手数／押す前に件数が見えるか | ${B.pauseOne.steps}／${v(!!B.pauseOne.countShownBefore)} | ${M.pauseOne.steps}／${v(!!M.pauseOne.countShownBefore)}${M.pauseOne.countShownBefore ? `（${M.pauseOne.countShownBefore}）` : ""} |`);
  rows.push(`| 条件の語を押した直後の操作できる要素 | ${B.editOpen.choices} | ${M.editOpen.choices} |`);
  rows.push(`| 詳細の操作できる要素 | ${B.detail.choices} | ${M.detail.choices} |`);
  rows.push(`| 詳細を開いた直後：年の由来／ファイルの場所 | ${v(B.detail.text.yearSource)}／${v(B.detail.text.path)} | ${v(M.detail.text.yearSource)}／${M.detail.text.path ? "同名ファイル欄にフォルダ、完全なパスは第二層" : "第二層"} |`);
  rows.push(`| 埋め込み情報・内容の識別・年の候補 | ${v(B.detail.text.rawFields)}・${v(B.detail.text.hash)}・${v(B.detail.text.candidates)} | ${v(M.detail.layer2.rawFields)}・${v(M.detail.layer2.hash)}・${v(M.detail.layer2.candidates)}（＋1手） |`);
  rows.push(`| 単曲で1つ追加＋1つ外す＋保存 | 不可（${B.tagEdit.why}） | ${M.tagEdit.steps}手${M.tagEdit.saved ? "・保存済み" : ""} |`);
  rows.push(`| タグ編集を開いた直後の操作できる要素 | — | ${M.editorOpen.choices} |`);
  rows.push(`| 取消 | — | ${M.cancel.steps}手・下書きに戻る ${v(M.cancel.undoOffered)} |`);
  rows.push(`| 競合からの復旧（読み込み→保存） | — | ${M.conflict.steps}手・下書き保持 ${v(M.conflict.draftKept)} |`);
  rows.push(`| 一覧の最初の行の上端（通常／3条件／9条件） | ${B.rowTop_base}／${B.rowTop_a}／${B.rowTop_eight} | ${M.rowTop_base}／${M.rowTop_a}／${M.rowTop_eight} |`);
  rows.push(`| 3条件の行の操作できる要素 | ${B.threeAnd.lineChoices} | ${M.threeAnd.lineChoices} |`);
}
writeFileSync("compare/metrics.md", `# #170 ベースとの同条件比較\n\n\`compare.mjs\` が同じデータ・同じ viewport・同じ操作で両方を動かして数えた。「操作できる要素」は、その領域で画面内に見えていて押せるボタン・入力・候補の数。${rows.join("\n")}\n`);
console.log("ok");
