// Drives the prototype with real mouse, keyboard and touch input and checks
// the behaviour and the meaning contracts of #173. Run from this directory:
//   node verify.mjs <path-to-node_modules/playwright>
// Writes verify-result.json. The page loads Google Fonts (network).
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright");
const url = pathToFileURL(resolve("index.html")).href;
const results = [];
const check = (id, name, ok, detail = "") => { results.push({ id, name, ok: !!ok, detail: String(detail) }); console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name}${detail ? " — " + detail : ""}`); };
const browser = await chromium.launch();
const errors = [];

async function open(ctxOpts, s = "base") {
  const ctx = await browser.newContext({ reducedMotion: "reduce", ...ctxOpts });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`${url}?capture=1&s=${s}`);
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page };
}
// each block of tests that edits data starts from a freshly loaded page
async function fresh(page, s) { await page.goto(`${url}?capture=1&s=${s}`); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(80); }
const shown = (page) => page.evaluate(() => Number(document.querySelector("#rbCount b").textContent.replace(/,/g, "")));
const expected = (page, mode) => page.evaluate((m) => window.FKP.filterCount(m), mode);
const clauses = (page) => page.evaluate(() => window.FKP.S.clauses.map((c) => ({ kind: c.kind, values: c.values, on: c.on, not: c.not })));
const visibleNames = (page, root) => page.evaluate((r) => {
  const els = [...document.querySelectorAll(`${r} button, ${r} input, ${r} [role=option], ${r} summary, ${r} select`)].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== "hidden"; });
  const nameOf = (e) => (e.getAttribute("aria-label") || e.textContent || (e.labels && e.labels[0] && e.labels[0].textContent) || e.getAttribute("title") || "").trim();
  return { n: els.length, unnamed: els.filter((e) => !nameOf(e)).map((e) => e.outerHTML.slice(0, 80)) };
}, root);
const smallTargets = (page, root, min) => page.evaluate(([r, m]) => [...document.querySelectorAll(`${r} button, ${r} input:not([type=radio]), ${r} [role=option], ${r} summary, ${r} label.ey-opt`)]
  .filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight && (b.height < m - 0.5 || b.width < m - 0.5); })
  .map((e) => `${(e.getAttribute("aria-label") || e.textContent).trim().slice(0, 20)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`), [root, min]);
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

// ================================================================ desktop
{
  const { ctx, page } = await open({ viewport: { width: 1280, height: 900 } });
  check("A0", "初期画面に条件の行も編集面も出ない", await page.isHidden("#summary") && await page.isHidden("#lens"));

  // --- A: first condition, the year/tag 2015 ambiguity
  await page.click("#finderInput");
  await page.keyboard.type("2015");
  const heads = await page.$$eval(".sugg-h span", (xs) => xs.map((x) => x.textContent));
  const amb = await page.textContent(".amb").catch(() => "");
  const first = await page.getAttribute(".sugg[aria-selected=true]", "aria-label");
  const tag2015 = await page.$eval('.sugg[data-kind="custom"][data-v="2015"]', (e) => e.getAttribute("aria-label")).catch(() => null);
  check("A1", "「2015」で制作年とタグが別の見出しに分かれ、両方にあると注意が出る", heads.includes("制作年") && heads.includes("タグ") && /制作年.*タグ/.test(amb), `見出し=${heads.join("/")}`);
  check("A2", "先頭の候補は「制作年 2015年」、タグの2015は「タグ 2015」と読める", /^制作年 2015年/.test(first) && /^タグ 2015、/.test(tag2015 || ""), `${first} | ${tag2015}`);
  await page.keyboard.press("Enter");
  const c1 = await clauses(page);
  const adv = await page.evaluate(() => ({ sw: document.querySelectorAll("#lens [role=switch]").length, tray: document.querySelectorAll("#lens .tray").length, mode: document.querySelectorAll("#lens .mode").length, not: document.querySelectorAll('#lens [data-act="not"]').length }));
  check("A3", "最初の条件は制作年として入る（タグの2015ではない）", c1.length === 1 && c1[0].kind === "year" && c1[0].values[0] === "2015", JSON.stringify(c1));
  check("A4", "最初の条件を足した直後、一時停止・これ以外・組み方の操作は見えない", adv.sw + adv.tray + adv.mode + adv.not === 0, JSON.stringify(adv));
  // second: romaji and a tag that shares a prefix with others
  await page.keyboard.type("日本人");
  const jp = page.locator('.sugg[data-kind="custom"][data-v="日本人トラックメーカー"]');
  const jpHow = await jp.locator(".how").textContent();
  await jp.click();
  await page.keyboard.type("anison");
  const ani = page.locator('.sugg[data-kind="genre"][data-v="アニソンremix"]');
  const aniN = Number((await ani.locator(".sugg-n b").textContent()).replace(/,/g, ""));
  await ani.click();
  const c3 = await clauses(page);
  check("A5", "ローマ字 anison でジャンル アニソンremix が出て、候補に「かつで加わる」と結果件数が先に出る", c3.length === 3 && /かつ/.test(jpHow), `how=${jpHow}`);
  await page.click('#lens .lens-foot .btn.primary');
  const n3 = await shown(page);
  check("A6", "3条件で閉じると件数が条件の照合結果と一致し、候補に出ていた件数とも一致する", n3 === await expected(page) && n3 === aniN, `表示=${n3} 候補=${aniN}`);
  const lineH = await page.$eval("#summary", (e) => e.getBoundingClientRect().height);
  check("A7", "条件は一行（48px以下）に3語で出る", lineH <= 48 && (await page.$$("#summary .term")).length === 3, `${lineH}px`);
  // remove one with its own ×, undo with the toast
  await page.click('#summary .t-x >> nth=2');
  const afterRm = (await clauses(page)).length;
  await page.click("#toast button");
  check("A8", "条件の × 1回で1つ外れ、トーストの「元に戻す」で戻る", afterRm === 2 && (await clauses(page)).length === 3);
  // condition editing: press the term -> the tray for that condition, with counts
  await page.click('#summary .term[data-kind="custom"]');
  const trayN = await page.$$eval("#lens .tray .tray-opt", (xs) => xs.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
  const pausePred = await page.$eval('#lens .tray [data-act="toggle"] .tray-n', (e) => Number(e.textContent.replace(/[^\d]/g, "")));
  await page.click('#lens .tray [data-act="toggle"]');
  const afterPause = await expected(page);
  check("A9", "語を押すとその条件の操作が開き、一時停止の件数は押す前に出ていた数と同じ", trayN.length === 4 && pausePred === afterPause, `予告=${pausePred} 実際=${afterPause}`);
  const st = await page.textContent('#lens .cl.is-off .cl-state');
  check("A10", "一時停止中の条件は文で「一時停止中」と読める", /一時停止中/.test(st));
  await page.click('#lens [data-act="undo"]');
  check("A11", "「一つ戻す」で一時停止の前に戻る", (await clauses(page)).every((c) => c.on));
  await page.click('#lens [data-act="redo"]');
  const redone = (await clauses(page)).some((c) => !c.on);
  await page.click('#lens [data-act="undo"]');
  check("A12", "「やり直す」で一時停止がもう一度かかる", redone);
  // a second year joins the first as an alternative, and says so before the pick
  await page.fill("#finderInput", "2016");
  const y16 = page.locator('.sugg[data-kind="year"][data-v="2016"]');
  const yHow = await y16.locator(".how").textContent();
  const yPred = Number((await y16.locator(".sugg-n b").textContent()).replace(/,/g, ""));
  await y16.click();
  const yc = (await clauses(page)).find((c) => c.kind === "year");
  check("A13", "2つ目の年は「または」で年の条件に加わると先に読め、件数も一致する", /または/.test(yHow) && yc.values.join() === "2015,2016" && yPred === await expected(page), `${yHow} 予告=${yPred}`);
  await page.click('#lens [data-act="undo"]');
  // any / all
  const anyPred = await page.$eval('#lens .mode [data-v="any"] b', (e) => Number(e.textContent.replace(/[^\d]/g, "")));
  await page.click('#lens .mode [data-v="any"]');
  check("A14", "「どれかに当てはまる」の件数は選ぶ前に読め、選ぶと一致する", anyPred === await expected(page) && anyPred > n3, `${anyPred}`);
  await page.click('#lens .mode [data-v="all"]');
  // Escape closes; focus back on the field
  await page.keyboard.press("Escape");
  check("A15", "Esc で編集面が閉じる", await page.isHidden("#lens"));
  // same name in two kinds
  await page.evaluate(() => window.FKP.scenario("base"));
  await page.click("#finderInput");
  await page.keyboard.type("funkot");
  const fk = await page.$$eval('.sugg[data-v="Funkot"]', (xs) => xs.map((x) => x.dataset.kind + ":" + x.querySelector(".sugg-n").textContent));
  await page.click('.sugg[data-kind="custom"][data-v="Funkot"]');
  const fkc = await clauses(page);
  check("A16", "同名の Funkot はジャンルとタグで別の候補・別の件数になり、選んだ種類で条件になる", fk.length === 2 && fk[0] !== fk[1] && fkc[0].kind === "custom", fk.join(" | "));
  await page.keyboard.press("Escape");
  // 9 conditions stay one line
  await page.evaluate(() => window.FKP.scenario("eight"));
  const e9 = await page.evaluate(() => ({ h: document.querySelector("#summary").getBoundingClientRect().height, more: document.querySelector(".t-more")?.textContent, top: document.querySelector(".row").getBoundingClientRect().top }));
  await page.evaluate(() => window.FKP.scenario("a"));
  const a3top = await page.evaluate(() => document.querySelector(".row").getBoundingClientRect().top);
  check("A17", "9条件（一時停止・これ以外・または を含む）でも一行で「ほかNつ」に畳まれ、一覧の開始位置は3条件と同じ", e9.h <= 48 && /ほか\d+つ/.test(e9.more || "") && e9.top === a3top, `${e9.more} top=${e9.top}/${a3top}`);
  await page.evaluate(() => window.FKP.scenario("eight-edit"));
  const e9s = await page.$$eval("#lens .cl", (xs) => xs.length);
  check("A18", "9条件の編集面で9条件すべてが文として並ぶ", e9s === 9, `${e9s}`);
  await page.evaluate(() => window.FKP.scenario("zero"));
  const relax = await page.$$eval(".relax button", (xs) => xs.length);
  check("A19", "0件のとき、外すと何曲になるかの選択肢が出る", relax > 0, `${relax}件`);

  // --- B: detail
  await page.evaluate(() => window.FKP.scenario("a"));
  const scroll0 = await page.$eval("#results", (e) => e.scrollTop);
  const mp3 = await page.evaluate(() => window.FKP.K("after-mp3").id);
  await page.click(`.row[data-id="${mp3}"] .row-main`);
  const det = await page.evaluate((id) => {
    const d = document.querySelector(`.row[data-id="${id}"] .detail`);
    const vis = (sel) => { const e = d.querySelector(sel); return !!e && e.checkVisibility(); };
    return { text: d.querySelector(".credits").textContent, techOpen: d.querySelector(".tech").open, pathVisible: vis(".tech-dl"), twins: d.querySelectorAll(".twin").length, thisRow: !!d.querySelector(".twin.is-this") };
  }, mp3);
  check("B1", "詳細の第一層に版・アーティスト・長さ・形式・制作年とその由来・ジャンル・タグ・状態が読める", ["版", "アーティスト", "長さ", "MP3", "制作年", "ファイルの日付から", "ジャンル", "タグ", "状態"].every((w) => det.text.includes(w)));
  check("B2", "ファイルの場所や埋め込み情報は畳まれた第二層にある（最初は見えない）", !det.techOpen && !det.pathVisible);
  check("B3", "同名ファイル（MP3/FLAC）が形式・場所で並び、この行が示される", det.twins === 2 && det.thisRow);
  await page.click(`.row[data-id="${mp3}"] .tech summary`);
  const tech = await page.evaluate((id) => document.querySelector(`.row[data-id="${id}"] .tech`).textContent, mp3);
  check("B4", "第二層に場所・内容の識別・埋め込み情報（TDRC など）・制作年の決め方がある", ["~/Music/Downloads/", "4b7e0c92d1f6a385", "TIT2", "TDRC", "録音日", "自動の判定"].every((w) => tech.includes(w)));
  await page.focus(`.row[data-id="${mp3}"] .tech summary`);
  const top0 = await page.$eval(`.row[data-id="${mp3}"]`, (e) => e.getBoundingClientRect().top);
  await page.keyboard.press("Escape");
  const fAfter = await page.evaluate(() => document.activeElement.className + "|" + document.activeElement.closest(".row")?.dataset.id);
  check("B5", "詳細の中で Esc を押すと閉じ、フォーカスはその曲の行に戻る", fAfter === `row-main|${mp3}` && !(await page.$(`.row[data-id="${mp3}"] .detail`)));
  const top1 = await page.$eval(`.row[data-id="${mp3}"]`, (e) => e.getBoundingClientRect().top);
  // closing shortens the list, so the browser may clamp the scroll; the row must stay on screen
  check("B6", "詳細を閉じても条件はそのままで、その曲の行は画面内に残る", (await clauses(page)).length === 3 && top1 >= 0 && top1 < 900 - 64, `行の上端 ${Math.round(top0)}→${Math.round(top1)}`);
  await page.evaluate(() => window.FKP.scenario("detail-moon"));
  const moon = await page.evaluate(() => document.querySelector(".row.is-open .detail").textContent);
  check("B7", "自動の年が食い違う曲は「自分で指定」と、食い違いの理由（2015、2016）が読める", /自分で指定/.test(moon) && /異なる年（2015、2016）/.test(moon));
  await page.evaluate(() => window.FKP.scenario("detail-copy"));
  const cp = await page.evaluate(() => document.querySelector(".row.is-open .detail .twins").textContent);
  check("B8", "中身が同じコピーは「中身が同じ・タグを共有」と示される", /中身が同じ・タグを共有/.test(cp));

  // --- C: single edit -> save
  await fresh(page, "detail");
  const digestS0 = await page.evaluate(() => window.FKP.fileDigest());
  await page.click(`.row[data-id="${mp3}"] [data-act="edit-tags"]`);
  const dlg = await page.evaluate(() => ({ role: document.querySelector("#editor .ed").getAttribute("role"), modal: document.querySelector("#editor .ed").getAttribute("aria-modal"), focus: document.activeElement.id, inert: document.querySelector("#app").inert }));
  check("C1", "タグの編集はモーダルの面で開き、入力欄にフォーカスし、背後は操作できない", dlg.role === "dialog" && dlg.modal === "true" && dlg.focus === "edInput" && dlg.inert, JSON.stringify(dlg));
  await page.keyboard.type("コール");
  const es = await page.$$eval("#edSugg .es", (xs) => xs.map((x) => x.querySelector(".es-k").textContent + ":" + x.dataset.v));
  await page.keyboard.press("Enter");
  check("C2", "候補は種類（タグ/ジャンル）付きで出て、Enter で付ける下書きに入る（校正記号の＋）", es[0] === "タグ:コール入り" && !!(await page.$('#editor .tg.is-add[data-k="custom:コール入り"]')), es.slice(0, 3).join(" "));
  await page.click('#editor .tg[data-k="genre:アニソンremix"] [data-act="ed-rm"]');
  const delNote = await page.textContent("#edChips");
  check("C3", "ファイル由来のジャンルを外すと取り消し線になり、ファイルは書き換えないと説明が出る", !!(await page.$('#editor .tg.is-del[data-k="genre:アニソンremix"]')) && /音声ファイルの中身はそのまま/.test(delNote));
  const foc = await page.evaluate(() => document.activeElement.textContent);
  check("C4", "外したあとフォーカスは同じタグの「戻す」にある", foc.trim() === "戻す");
  // focus stays in the dialog
  let escaped = false;
  for (let i = 0; i < 30; i++) { await page.keyboard.press("Tab"); if (!(await page.evaluate(() => !!document.activeElement.closest("#editor")))) escaped = true; }
  check("C5", "Tab を30回押してもフォーカスは編集の面から出ない", !escaped);
  const sum = await page.textContent(".ed-sum");
  check("C6", "未保存の変更の件数と種類が下端に常に出る", /2件の変更/.test(sum.replace(/\s/g, "")));
  const req0 = await page.evaluate(() => window.FKP.LOG.length);
  await page.click(".ed-save");
  await page.waitForSelector("#editor .ed", { state: "detached" });
  const after = await page.evaluate(() => window.FKP.manualOf("after-mp3"));
  const req = await page.evaluate(() => window.FKP.LOG[window.FKP.LOG.length - 1]);
  const toast = await page.textContent("#toast");
  check("C7", "保存は add/remove の差分として送られ、手動の記録だけが変わる", JSON.stringify(req.req.patch) === JSON.stringify({ add: [{ kind: "custom", value: "コール入り" }], remove: [{ kind: "genre", value: "アニソンremix" }] }) && after.add.some((t) => t.value === "コール入り") && after.sup.some((t) => t.value === "アニソンremix") && req0 + 1 === (await page.evaluate(() => window.FKP.LOG.length)), JSON.stringify(after));
  check("C8", "成功は「タグを保存しました」と出る", /タグを保存しました/.test(toast));
  const eff = await page.evaluate(() => window.FKP.effOf("after-mp3"));
  const emb = await page.evaluate(() => [...window.FKP.K("after-mp3").file.embedded.genres]);
  check("C9", "保存後、有効な値からアニソンremixが外れ、埋め込みの値はそのまま残る", !eff.includes("genre:アニソンremix") && eff.includes("custom:コール入り") && emb.includes("アニソンremix"));
  const kept = await page.evaluate((id) => ({ row: !!document.querySelector(`.row[data-id="${id}"].is-kept .detail`), note: document.querySelector(`.row[data-id="${id}"] .st.kept`)?.textContent, saved: document.querySelectorAll(`.row[data-id="${id}"] .tchip.is-saved`).length, focus: document.activeElement.dataset.act }), mp3);
  check("C10", "条件から外れても開いていた曲はその場に残り、理由が出て、保存した値に印が付き、フォーカスは「タグを編集」に戻る", kept.row && /外れました/.test(kept.note || "") && kept.saved === 1 && kept.focus === "edit-tags", JSON.stringify(kept));
  check("C11", "条件は保存の前後で変わらない", (await clauses(page)).length === 3);

  // cancel with a draft -> undo toast brings the draft back
  await page.click(`.row[data-id="${mp3}"] [data-act="edit-tags"]`);
  await page.keyboard.type("多幸感"); await page.keyboard.press("Enter");
  await page.click('[data-act="ed-cancel"]');
  const ct = await page.textContent("#toast");
  await page.click("#toast button");
  check("C12", "キャンセルで下書きを捨て、トーストの「下書きに戻る」で同じ下書きが戻る", /捨てました/.test(ct) && !!(await page.$('#editor .tg.is-add[data-k="custom:多幸感"]')));
  // persist_failed keeps the draft and changes nothing
  const m0 = await page.evaluate(() => JSON.stringify(window.FKP.manualOf("after-mp3")));
  await page.evaluate(() => { window.FKP.SVC.nextFail = "persist_failed"; });
  await page.click(".ed-save");
  await page.waitForSelector(".ed-msg.is-bad");
  const failText = await page.textContent(".ed-msg");
  check("C13", "書き込みに失敗すると理由と「下書きはそのまま」が出て、下書きも記録も変わらない", /保存できませんでした/.test(failText) && /下書きはそのまま/.test(failText) && !!(await page.$('#editor .tg.is-add[data-k="custom:多幸感"]')) && m0 === await page.evaluate(() => JSON.stringify(window.FKP.manualOf("after-mp3"))));
  await page.click('.ed-msg .btn');
  await page.waitForSelector("#editor .ed", { state: "detached" });
  check("C14", "「もう一度保存」で保存できる", (await page.evaluate(() => window.FKP.effOf("after-mp3"))).includes("custom:多幸感"));
  // stale: another window edits while the draft is open
  await page.click(`.row[data-id="${mp3}"] [data-act="edit-tags"]`);
  await page.keyboard.type("ピアノ"); await page.keyboard.press("Enter");
  await page.$eval('#demo [data-sim="other"]', (b) => b.click());
  const staleTxt = await page.textContent(".ed-msg");
  const saveDis = await page.isDisabled(".ed-save");
  check("C15", "開いている間に別の操作で更新されると、保存の前に知らせて保存を止める", /更新されました/.test(staleTxt) && saveDis);
  await page.click('[data-act="ed-reload"]');
  const note = await page.textContent(".ed-msg.is-info");
  check("C16", "「最新の内容を読み込む」で何が変わったかが出て、下書きは残り、保存できる", /サビ早い|コール入り/.test(note) && !!(await page.$('#editor .tg.is-add[data-k="custom:ピアノ"]')) && !(await page.isDisabled(".ed-save")), note.slice(0, 60));
  await page.click(".ed-save");
  await page.waitForSelector("#editor .ed", { state: "detached" });
  // stale at save time -> reload -> the addition is redundant -> no-op
  await page.evaluate(() => window.FKP.scenario("stale"));
  await page.waitForSelector(".ed-msg.is-warn");
  const sv = await page.textContent(".ed-msg");
  await page.click('[data-act="ed-reload"]');
  const red = await page.$('#editor .tg.is-redundant[data-k="custom:コール入り"]');
  await page.click(".ed-save");
  await page.waitForSelector("#editor .ed", { state: "detached" });
  check("C17", "保存時の競合（stale_revision）→ 読み込み → 同じ変更が既にあると下書きが不要と示され、保存は「変更はありませんでした」になる", /stale_revision/.test(sv) && !!red && /変更はありませんでした/.test(await page.textContent("#toast")));
  const digestS1 = await page.evaluate(() => window.FKP.fileDigest());
  check("C31", "保存・取消・書込失敗・競合・no-op を通して、音声ファイルを表すデータ（パス・識別・大きさ・日時・埋め込み情報）は変わらず凍結されたまま", digestS0 === digestS1 && digestS0.endsWith(":true"), `${digestS0} → ${digestS1}`);
  // identity_changed: never applied to the new file
  await page.evaluate(() => window.FKP.scenario("identity"));
  await page.waitForSelector(".ed-msg.is-bad");
  const idTxt = await page.textContent(".ed-msg");
  const newRec = await page.evaluate(() => window.FKP.manualOf("after-mp3"));
  check("C18", "ファイルが変わると（identity_changed）下書きを新しいファイルに保存せず、保存を止める", /ファイルが変わりました/.test(idTxt) && await page.isDisabled(".ed-save") && newRec.add.length === 0 && newRec.sup.length === 0);
  await page.click('[data-act="ed-reopen"]');
  const refs = await page.$$eval(".ed-ref .tg", (xs) => xs.map((x) => x.textContent));
  const dirty = await page.evaluate(() => window.FKP.S.ed.add.length + window.FKP.S.ed.remove.length);
  check("C19", "開き直すと前の下書きと、引き継がれなかった手動タグが「入れる」付きで並び、自動では入らない", refs.length >= 3 && dirty === 0 && refs.some((r) => /前のファイルで付けていた/.test(r)), refs.join(" / "));
  await page.click('.ed-ref [data-act="ed-ref"] >> nth=0');
  check("C20", "「入れる」を押したものだけが下書きに入る", (await page.evaluate(() => window.FKP.S.ed.add.length)) === 1);
  await page.keyboard.press("Escape");
  // year: set, invalid, candidate
  await page.evaluate(() => window.FKP.scenario("edit-year"));
  await page.click('#editor input[name=eyMode][value="unset"]');
  const unsetHead = await page.textContent(".ey-now");
  await page.click('#editor input[name=eyMode][value="set"]');
  await page.fill("#edYearInput", "999");
  const bad = await page.textContent(".ey-err");
  const badDis = await page.isDisabled(".ed-save");
  await page.fill("#edYearInput", "2016");
  const head16 = await page.textContent(".ey-now");
  await page.click('[data-act="ed-year-cand"][data-v="2009"]');
  const head09 = await page.textContent(".ey-now");
  check("C21", "制作年の「年なし」「指定」が見出しで「旧 → 新」と読め、3桁は保存できず、候補から年を選べる", /年なし/.test(unsetHead) && /4桁/.test(bad) && badDis && /2015年→2016年/.test(head16.replace(/\s/g, "")) && /2009年/.test(head09));
  await page.click(".ed-save");
  await page.waitForSelector("#editor .ed", { state: "detached" });
  const moonRec = await page.evaluate(() => window.FKP.manualOf("moon"));
  check("C22", "選んだ候補は手動の年として保存される", moonRec.year.mode === "set" && moonRec.year.value === 2009, JSON.stringify(moonRec.year));
  // many tags
  await page.evaluate(() => window.FKP.scenario("many"));
  const many = await page.evaluate(() => {
    const x = [...document.querySelectorAll('#editor [data-act="ed-rm"]')].filter((b) => b.getBoundingClientRect().height > 0).length;
    const save = document.querySelector(".ed-save").getBoundingClientRect();
    const input = document.querySelector("#edInput").getBoundingClientRect();
    return { x, saveIn: save.bottom <= innerHeight && save.top >= 0, inputIn: input.top >= 0 && input.bottom <= innerHeight, fold: document.querySelector(".tg-fold button")?.textContent };
  });
  check("C23", "46タグの曲でも × は20個以下で、「原曲 30件」に畳まれ、入力欄と保存が画面内にある", many.x <= 20 && /原曲.*30件/.test(many.fold) && many.saveIn && many.inputIn, JSON.stringify(many));
  await page.fill("#edInput", "銀河");
  const found = await page.$$eval("#edChips .tg:not(.is-dim)", (xs) => xs.map((x) => x.dataset.k));
  check("C24", "入力でこの曲のタグを探すと、畳んだ中のタグも見える", found.some((k) => k === "custom:原曲:銀河物語"), found.slice(0, 5).join(" "));
  await page.keyboard.press("Escape"); // clears the input first
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector("#editor .ed", { state: "detached" });
  check("C25", "Ctrl+Enter で保存できる", /タグを保存しました/.test(await page.textContent("#toast")));
  // batch
  await fresh(page, "batch");
  const digestB0 = await page.evaluate(() => window.FKP.fileDigest());
  const b = await page.evaluate(() => ({ title: document.querySelector("#edTitle").textContent, tg: document.querySelector(".ed-targets").textContent, mixed: document.querySelector('#editor .tg.is-mixed[data-k="genre:Happy Hardcore"] .tg-n')?.textContent, year: document.querySelector(".ey-now").textContent, n: window.FKP.S.ed.targets.length }));
  check("C26", "一括編集は表示中で保存できる3曲だけを対象にし、外した理由と、保存するデータが2つであることを示す", b.n === 3 && /3曲/.test(b.title) && /ファイルが見つからない1曲/.test(b.tg) && /データは2つ|保存するデータは2つ/.test(b.tg + (await page.textContent(".ed-targets-btn"))), b.tg.slice(0, 80));
  check("C27", "混在するタグは「2/3」と読め、制作年は既定で変えない", b.mixed === "2/3" && /2015年 3曲/.test(b.year), `${b.mixed} ${b.year}`);
  await page.$eval('#demo [data-sim="scan"]', (b) => b.click());
  const scanned = await page.evaluate(() => ({ n: window.FKP.S.ed.targets.length, msg: document.querySelector(".ed-msg").textContent }));
  check("C28", "編集中にスキャンが起きても対象は3曲のままで、読み込みを促す", scanned.n === 3 && /対象の3曲は変わりません/.test(scanned.msg));
  await page.click('[data-act="ed-reload"]');
  await page.click(".ed-save");
  await page.waitForSelector("#editor .ed", { state: "detached" });
  const breq = await page.evaluate(() => window.FKP.LOG[window.FKP.LOG.length - 1]);
  check("C29", "一括保存の要求は3曲・年の変更なし、応答はデータ単位（2）で数える", breq.req.targets.length === 3 && !breq.req.patch.year_change && breq.res.changed + breq.res.no_op === 2 && /データは2つ/.test(await page.textContent("#toast")), JSON.stringify(breq.res));
  check("C32", "一括保存でも音声ファイルを表すデータは変わらない", digestB0 === await page.evaluate(() => window.FKP.fileDigest()));
  // a selected track hidden by the conditions is not edited
  await fresh(page, "base");
  // select two tracks, then a condition hides one of them
  await page.evaluate(() => { const F = window.FKP; F.S.selectMode = true; ["after-mp3", "after-flac"].forEach((k) => F.S.selected.add(F.K(k).id)); F.render(); });
  await page.evaluate(() => { const F = window.FKP; F.S.clauses = [{ id: 998, kind: "text", values: ["放課後シグナル"], on: true, not: false }, { id: 999, kind: "custom", values: ["2015夏頒布"], on: true, not: false }]; F.update(); });
  const vis = await page.evaluate(() => window.FKP.S.selected.size);
  await page.click(".rb-tagedit");
  const hid = await page.evaluate(() => ({ n: window.FKP.S.ed?.targets.length, note: document.querySelector(".ed-head")?.textContent || "" }));
  check("C30", "選んだ曲のうち条件で隠れた曲は編集対象に入らず、その旨が出る", vis === 2 && hid.n === 1 && /隠れているため/.test(hid.note), JSON.stringify(hid).slice(0, 120));
  await page.keyboard.press("Escape");

  // accessible names
  for (const s of ["a-type", "a-menu", "detail-tech", "edit", "many", "batch", "edit-year", "stale"]) {
    await fresh(page, s);
    await page.waitForTimeout(s === "stale" ? 700 : 50);
    const r = await visibleNames(page, s.startsWith("a") || s.startsWith("detail") ? "#app" : "#editor");
    check("N-" + s, `見えている操作すべてに読み上げ名がある（${s}）`, r.unnamed.length === 0, `${r.n}個${r.unnamed.length ? " 名前なし: " + r.unnamed.join(" ") : ""}`);
  }
  await ctx.close();
  // separate check of the file digest across a fresh page: the identity test replaces one file on purpose
}

// ================================================================ narrow touch
{
  const { ctx, page } = await open({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await page.tap("#finderInput");
  const sheet = await page.$eval("#lens", (e) => { const b = e.getBoundingClientRect(); return b.top === 0 && b.left === 0 && Math.round(b.width) === innerWidth && Math.round(b.height) === innerHeight; });
  check("D1", "狭幅では検索欄のタップで全画面のシートになる", sheet);
  await page.fill("#lensInput", "2015");
  await page.tap('.sugg[data-kind="year"][data-v="2015"]');
  await page.fill("#lensInput", "日本人");
  await page.tap('.sugg[data-kind="custom"][data-v="日本人トラックメーカー"]');
  const small1 = await smallTargets(page, "#lens", 44);
  check("D2", "シートの操作はすべて44px以上", small1.length === 0, small1.join(", "));
  const lensOv = async () => page.evaluate(() => [...document.querySelectorAll("#lens, #lens .lens-col")].map((e) => e.scrollWidth - e.clientWidth).reduce((a, b) => Math.max(a, b), 0));
  const ov1 = await lensOv();
  await page.tap('#lens .cl-more >> nth=1');
  const ov2 = await lensOv();
  await page.tap('#lens .cl-more >> nth=1');
  check("D2b", "シートの中も横にあふれない（条件の操作を開いても）", ov1 <= 0 && ov2 <= 0, `${ov1}px / ${ov2}px`);
  await page.tap("#lens .lens-foot .btn.primary");
  check("D3", "件数のボタンで閉じ、2条件の結果になる", (await shown(page)) === await expected(page) && (await clauses(page)).length === 2);
  const small0 = await smallTargets(page, "#main", 44);
  check("D4", "結果画面で見えている操作はすべて44px以上", small0.length === 0, small0.join(", "));
  for (const s of ["detail-tech", "edit", "many", "batch", "edit-year", "fail", "identity-reopen"]) {
    await fresh(page, s);
    await page.waitForTimeout(["fail", "identity-reopen"].includes(s) ? 1500 : 0);
    const ov = await overflowX(page);
    const root = s.startsWith("detail") ? ".row.is-open" : "#editor";
    const sm = await smallTargets(page, root, 44);
    const foot = s.startsWith("detail") ? true : await page.evaluate(() => { const b = document.querySelector(".ed-save").getBoundingClientRect(); return b.bottom <= innerHeight; });
    check("D-" + s, `狭幅 ${s}: 横あふれなし・操作44px以上・保存が画面内`, ov <= 0 && sm.length === 0 && foot, `${ov}px ${sm.join(", ")}`);
  }
  // narrow edit by touch, end to end
  await fresh(page, "detail");
  const mp3 = await page.evaluate(() => window.FKP.K("after-mp3").id);
  await page.tap(`.row[data-id="${mp3}"] [data-act="edit-tags"]`);
  await page.tap('#editor .tg[data-k="custom:日本人トラックメーカー"] [data-act="ed-rm"]');
  await page.tap(".ed-save");
  await page.waitForSelector("#editor .ed", { state: "detached" });
  check("D5", "狭幅でタップだけでタグを外して保存できる", !(await page.evaluate(() => window.FKP.effOf("after-mp3"))).includes("custom:日本人トラックメーカー"));
  await ctx.close();
}

// ================================================================ 200% (640x450)
{
  const { ctx, page } = await open({ viewport: { width: 640, height: 450 }, deviceScaleFactor: 2 });
  for (const s of ["a-type", "detail", "edit", "many", "batch"]) {
    await page.evaluate((x) => window.FKP.scenario(x), s);
    await page.waitForTimeout(60);
    const ov = await overflowX(page);
    const fit = s.startsWith("a") || s === "detail" ? true : await page.evaluate(() => { const b = document.querySelector(".ed-save").getBoundingClientRect(); const i = document.querySelector("#edInput").getBoundingClientRect(); return b.bottom <= innerHeight && i.top >= 0; });
    check("Z-" + s, `200%（640×450）${s}: 横あふれなし${s.startsWith("a") || s === "detail" ? "" : "・入力欄と保存が画面内"}`, ov <= 0 && fit, `${ov}px`);
  }
  await ctx.close();
}

await browser.close();
check("E0", "ページのエラーなし", errors.length === 0, errors.slice(0, 3).join(" | "));
const passed = results.filter((r) => r.ok).length;
writeFileSync("verify-result.json", JSON.stringify({ passed, total: results.length, results }, null, 2) + "\n");
console.log(`${passed}/${results.length}`);
process.exit(passed === results.length ? 0 : 1);
