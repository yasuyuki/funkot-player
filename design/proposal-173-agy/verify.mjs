// Verifies Areas A, B, and C end-to-end against real user events, semantics,
// stress conditions, accessibility, and tag-service safety contracts.
// Usage: node verify.mjs [path-to-playwright]
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const pwPath = process.argv[2] || "C:/Users/flame/work/funkot-player/node_modules/playwright";
const { chromium } = require(pwPath);
const url = pathToFileURL(resolve("index.html")).href + "?capture=1";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

const browser = await chromium.launch();

// =========================================================================
// 1. Desktop 1280x900 — Area A, Area B, Area C, Stress, Safety Contracts
// =========================================================================
{
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => {
    if (m.type() === "error" && !/ERR_NAME_NOT_RESOLVED/.test(m.text())) errs.push(m.text());
  });

  await p.goto(url);
  await p.evaluate(() => document.fonts.ready);

  // S1–S2: Opening state parity & scale
  const init = await p.evaluate(() => ({
    songs: FKP.songs.length,
    tags: window.FK.tagIndex.size,
    sumHidden: document.querySelector("#summary").hidden,
    rows: document.querySelectorAll(".row").length,
    firstTop: document.querySelector(".row").getBoundingClientRect().top,
  }));
  check("S1 opening state: 24,823 songs, 2,600+ tags, no condition bar",
    init.songs === 24823 && init.tags >= 2600 && init.sumHidden && init.rows > 0,
    JSON.stringify(init));

  // A1: Beginner first search hides advanced logic (no AND/OR, pause, NOT, +OR)
  await p.keyboard.press("/");
  const focusedId = await p.evaluate(() => document.activeElement?.id);
  check("A1 / focuses search field and opens palette", focusedId === "finderInput" && await p.locator("#lens").isVisible());
  const beginnerAdv = await p.evaluate(() => {
    const txt = document.querySelector("#lens").innerText;
    return /すべてに一致|どれかに一致|これ以外|一時停止|＋または/.test(txt);
  });
  check("A2 beginner search hides advanced concepts on first open", !beginnerAdv);

  // A3: Kind disambiguation ("2015" distinguishes year vs custom tag vs text)
  await p.keyboard.type("2015");
  const disambig = await p.evaluate(() => {
    const items = [...document.querySelectorAll(".sugg")].map((el) => ({
      kind: el.dataset.kind,
      val: el.dataset.v,
      text: el.innerText.replace(/\s+/g, " "),
    }));
    const hasYear = items.some((x) => x.kind === "year" && x.val === "2015");
    const hasCustom = items.some((x) => x.kind === "custom" && x.val === "2015");
    const hasText = items.some((x) => x.kind === "text");
    const banner = document.querySelector(".disambig-note")?.innerText || "";
    return { hasYear, hasCustom, hasText, banner: !!banner };
  });
  check("A3 typing 2015 disambiguates year vs custom tag vs text",
    disambig.hasYear && disambig.hasCustom && disambig.hasText && disambig.banner,
    JSON.stringify(disambig));

  // Pick year:2015 via Enter, verify beginner strip still hides advanced switches
  await p.keyboard.press("Enter");
  const afterFirst = await p.evaluate(() => ({
    clauses: FKP.S.clauses.length,
    advInAdd: /すべてに一致|これ以外/.test(document.querySelector("#lens").innerText),
    hasAdjustLink: !!document.querySelector('[data-act="to-manage"]'),
  }));
  check("A4 after 1st condition, add mode stays calm with optional link to adjust",
    afterFirst.clauses === 1 && !afterFirst.advInAdd && afterFirst.hasAdjustLink,
    JSON.stringify(afterFirst));

  // Add 2nd & 3rd conditions (romaji + variant)
  await p.keyboard.type("日本人");
  await p.locator('.sugg[data-v="日本人トラックメーカー"]').click();
  await p.locator("#finderInput").fill("");
  await p.locator("#finderInput").type("anison");
  const hasVariants = (await p.locator(".sugg-variants").count()) > 0;
  const predictedAnison = await p.locator('.sugg[data-kind="genre"][data-v="アニソンremix"] .sugg-n b').innerText();
  await p.locator('.sugg[data-kind="genre"][data-v="アニソンremix"]').click();
  await p.locator(".lens-foot .btn.primary").click();

  const three = await p.evaluate(() => ({
    count: Number(document.querySelector("#rbCount b").textContent.replace(/[^0-9]/g, "")),
    sumH: document.querySelector("#summary").getBoundingClientRect().height,
    firstTop: document.querySelector(".row").getBoundingClientRect().top,
    terms: [...document.querySelectorAll("#terms .term")].filter((el) => !el.closest("[hidden]") && el.getBoundingClientRect().width > 0).length,
  }));
  check("A5 3-condition AND + romaji + variants + live prediction exact match + 1-line summary",
    hasVariants && Number(predictedAnison) === three.count && three.sumH <= 48 && three.terms === 3,
    `predicted=${predictedAnison}, actual=${three.count}, sumH=${three.sumH}`);

  // A6: Desktop 1-click single-condition removal + Undo
  await p.locator('.term-x').nth(2).click();
  const afterRm = await p.evaluate(() => ({ clauses: FKP.S.clauses.length, toast: document.querySelector("#toast")?.innerText || "" }));
  await p.locator("#toast button").click();
  const afterUndo = await p.evaluate(() => FKP.S.clauses.length);
  check("A6 desktop 1-click condition removal and Undo restore",
    afterRm.clauses === 2 && /外しました/.test(afterRm.toast) && afterUndo === 3);

  // A7: 9-condition scale & Condition Ledger without vertical crowding
  await p.evaluate(() => FKP.scenario("eight"));
  const nineClosed = await p.evaluate(() => ({
    sumH: document.querySelector("#summary").getBoundingClientRect().height,
    firstTop: document.querySelector(".row").getBoundingClientRect().top,
    more: document.querySelector(".t-more")?.textContent || "",
  }));
  check("A7 9 conditions stay 1-line with paused indicator in ほかN",
    nineClosed.sumH <= 48 && Math.abs(nineClosed.firstTop - three.firstTop) < 2 && /停止/.test(nineClosed.more),
    JSON.stringify(nineClosed));

  await p.locator(".t-more").click();
  const ledgerMetrics = await p.evaluate(() => {
    const rows = [...document.querySelectorAll(".ledger-row")];
    const body = document.querySelector("#lensBody");
    const br = body.getBoundingClientRect();
    const visibleWithoutScroll = rows.filter((r) => {
      const rr = r.getBoundingClientRect();
      return rr.top >= br.top - 1 && rr.bottom <= br.bottom + 1;
    }).length;
    return { total: rows.length, visibleWithoutScroll, hasPreview: !!document.querySelector(".logic-preview") };
  });
  check("A8 Condition Ledger shows 9 clauses cleanly (≥7 visible without scroll)",
    ledgerMetrics.total === 9 && ledgerMetrics.visibleWithoutScroll >= 7 && ledgerMetrics.hasPreview,
    JSON.stringify(ledgerMetrics));

  // Test pause/resume + OR + yearUnset always-AND semantics
  await p.locator('.ledger-row .switch').first().click();
  await p.locator('.ledger-row .switch').first().click();
  await p.locator('.seg [data-v="any"]').click();
  await p.locator('[data-act="toggle-unset"]').first().click();
  const unsetSemantics = await p.evaluate(() => {
    const resIds = [...document.querySelectorAll(".row")].map((r) => Number(r.dataset.id));
    const allHaveNullYear = resIds.every((id) => FKP.byId.get(id).year === null);
    const pendingExcluded = !resIds.includes(FKP.songs.find((s) => s.title === "真夜中の未スキャン曲").id);
    const manualUnsetIncluded = resIds.includes(FKP.songs.find((s) => s.title === "年未設定を手動固定した曲").id);
    return { allHaveNullYear, pendingExcluded, manualUnsetIncluded };
  });
  check("A9 yearUnset applies as AND even in OR mode, excludes pending, includes manual unset",
    unsetSemantics.allHaveNullYear && unsetSemantics.pendingExcluded && unsetSemantics.manualUnsetIncluded,
    JSON.stringify(unsetSemantics));

  // A10: Escape closes lens and returns focus to finderInput without reopening
  await p.locator(".lens-foot .btn.primary").click();
  await p.keyboard.press("/");
  await p.keyboard.press("Escape");
  check("A10 Escape closes palette and returns focus to #finderInput cleanly",
    await p.locator("#lens").isHidden() && await p.evaluate(() => document.activeElement?.id === "finderInput"));

  // A11: Zero-result relaxation (pause & remove + contradictory years)
  await p.evaluate(() => FKP.scenario("zero"));
  const zeroBtns = await p.locator(".relax-item").count();
  await p.locator('.relax-item [data-act="pause-clause"]').first().click();
  const afterPauseZero = await p.locator(".row").count();
  check("A11 0-result relaxation can pause a clause while preserving it", zeroBtns > 0 && afterPauseZero > 0);

  // B1–B7: Area B Track Detail Inspector
  await p.evaluate(() => FKP.scenario("a"));
  const signalRow = p.locator(".row", { hasText: "放課後シグナル" }).first();
  await signalRow.locator(".row-main").click();
  const detailInfo = await p.evaluate(() => {
    const insp = document.querySelector("#inspector");
    const tech = document.querySelector("#inspTechDetails");
    const txt = insp.innerText;
    return {
      visible: !insp.hidden,
      dockVisible: document.querySelector("#dock").getBoundingClientRect().width > 200,
      fullTitle: /放課後シグナル/.test(txt),
      techCollapsed: tech && !tech.open,
      noFakeBpmOrCover: !/BPM|カバー画像|波形/.test(txt),
      twinsShown: document.querySelectorAll(".twin-card").length === 2,
    };
  });
  check("B1 Inspector opens beside list & dock, tech details collapsed, twins clear, no fake media",
    detailInfo.visible && detailInfo.dockVisible && detailInfo.fullTitle && detailInfo.techCollapsed && detailInfo.noFakeBpmOrCover && detailInfo.twinsShown,
    JSON.stringify(detailInfo));

  // B2: Expanding tech details reveals full untruncated path & content_hash
  await p.locator("#inspTechDetails summary").click();
  const techOpen = await p.evaluate(() => {
    const txt = document.querySelector("#inspTechDetails").innerText;
    return /Music\/Downloads\/放課後シグナル \(Funkot Remix\)\.mp3/.test(txt) && /h-signal-mp3-2c91/.test(txt);
  });
  check("B2 Tech details reveal full untruncated path and content_hash", techOpen);

  // B3: 32-tag track detail folds cleanly and filters inline
  await p.evaluate(() => FKP.scenario("detail-many"));
  const manyFold = await p.evaluate(() => ({
    initialChips: document.querySelectorAll("#inspector .insp-chips .chip").length,
    hasExpand: !!document.querySelector('[data-act="insp-expand-tags"]'),
  }));
  await p.locator('[data-act="insp-expand-tags"]').click();
  await p.locator("#inspTagFilter").fill("深夜");
  const manyFiltered = await p.locator('#inspector .insp-chips [data-kind="custom"]').count();
  check("B3 32-tag track folds initially, expands, and filters tags inline",
    manyFold.initialChips <= 15 && manyFold.hasExpand && manyFiltered === 1,
    `init=${manyFold.initialChips}, filteredCustom=${manyFiltered}`);

  // B4: Clicking a tag in Detail adds filter, Escape closes Detail and restores focus to row
  await p.locator('#inspector [data-act="pick-from-detail"]').first().click();
  const clausesAfterDetailPick = await p.evaluate(() => FKP.S.clauses.length);
  await p.keyboard.press("Escape");
  await p.waitForTimeout(40);
  const afterEscDetail = await p.evaluate(() => ({
    hidden: document.querySelector("#inspector").hidden,
    focusedRowId: document.activeElement?.closest(".row")?.dataset.id,
  }));
  check("B4 Tag click in Detail filters library; Esc closes Detail and restores row focus",
    clausesAfterDetailPick === 4 && afterEscDetail.hidden && !!afterEscDetail.focusedRowId,
    JSON.stringify(afterEscDetail));

  // C1–C12: Area C Tag Editing & Safety Contracts
  // C1: Single track edit (year auto -> set 2016, add tag via autocomplete, suppress embedded genre)
  await p.evaluate(() => FKP.scenario("a"));
  const revBefore = await p.evaluate(() => FKP.tagService.revision);
  await p.locator(".row", { hasText: "放課後シグナル" }).nth(1).locator(".row-main").click(); // FLAC
  await p.locator('#inspector [data-act="open-tag-editor"]').click();
  check("C1 Tag Editor modal opens with role=dialog and sticky Save/Cancel",
    await p.locator('.tag-modal[role="dialog"]').isVisible() && await p.locator('[data-act="tm-save"]').isVisible());

  // C2: No-op Save does NOT increment revision and shows distinct no-op toast
  await p.locator('[data-act="tm-save"]').click();
  const noopRes = await p.evaluate((r0) => ({
    revAfter: FKP.tagService.revision,
    sameRev: FKP.tagService.revision === r0,
    toast: document.querySelector("#toast")?.innerText || "",
  }), revBefore);
  check("C2 No-op save keeps revision unchanged and notifies clearly",
    noopRes.sameRev && /変更はありませんでした/.test(noopRes.toast), JSON.stringify(noopRes));

  // C3: Edit year + add tag + suppress embedded genre -> Save updates Detail & preserves audio files
  await p.locator('#inspector [data-act="open-tag-editor"]').click();
  await p.locator('[data-act="tm-year-mode"][data-v="set"]').click();
  await p.locator("#tmYearInput").fill("2016");
  await p.locator("#tmAddInput").fill("テスト追加タグ");
  await p.locator('[data-act="tm-add-btn"]').click();
  await p.locator('.tm-chip[data-kind="genre"][data-v="Funkot"]').click(); // suppress embedded Funkot
  await p.locator('[data-act="tm-save"]').click();

  const afterSave = await p.evaluate(() => {
    const flac = FKP.songs.find((s) => s.content_hash === "h-signal-flac-8a4f");
    return {
      year: flac.year,
      hasAdded: flac.tags.includes("テスト追加タグ"),
      funkotSuppressed: !flac.genres.includes("Funkot") && flac.manual.suppressed_auto_tags.some((t) => t.value === "Funkot"),
      audioUntouched: FKP.tagService.verifyAudioFilesUntouched(),
    };
  });
  check("C3 Single-track edit updates effective tags, suppresses auto genre, leaves audio files untouched",
    afterSave.year === 2016 && afterSave.hasAdded && afterSave.funkotSuppressed && afterSave.audioUntouched.ok,
    JSON.stringify(afterSave));

  // C4: Simulated rescan keeps suppressed auto tag suppressed; 1-click restore brings it back
  await p.evaluate(() => FKP.simulateRescan());
  const stillSuppressed = await p.evaluate(() => !FKP.songs.find((s) => s.content_hash === "h-signal-flac-8a4f").genres.includes("Funkot"));
  await p.locator('#inspector [data-act="open-tag-editor"]').click();
  await p.locator('[data-act="tm-restore-sup"]').first().click();
  await p.locator('[data-act="tm-save"]').click();
  const restored = await p.evaluate(() => FKP.songs.find((s) => s.content_hash === "h-signal-flac-8a4f").genres.includes("Funkot"));
  check("C4 Suppressed auto tag survives rescan and restores in 1 click", stillSuppressed && restored);

  // C5: 32-tag editor filters and shows 変更 tab, footer stays visible
  await p.evaluate(() => FKP.scenario("edit-many"));
  await p.locator("#tmFilterInput").fill("深夜");
  const filteredEditRows = await p.locator(".tm-tag-row").count();
  await p.locator("#tmFilterInput").fill("");
  await p.locator("#tmAddInput").fill("整理テスト");
  await p.locator('[data-act="tm-add-btn"]').click();
  await p.locator('[data-act="tm-tab"][data-tab="changed"]').click();
  const changedTabCount = await p.locator(".tm-tag-row").count();
  const footVisible = await p.evaluate(() => {
    const r = document.querySelector(".tm-foot").getBoundingClientRect();
    return r.bottom <= innerHeight + 1 && r.height > 40;
  });
  check("C5 32-tag editor filters inline, isolates diff in 変更 tab, keeps footer visible",
    filteredEditRows === 1 && changedTabCount === 1 && footVisible);

  // C6: Year conflict surfaces adoptable candidates
  await p.evaluate(() => FKP.scenario("edit-year-conflict"));
  const conflictBtns = await p.locator('[data-act="tm-adopt-year"]').count();
  await p.locator('[data-act="tm-adopt-year"]').first().click();
  const adoptedYear = await p.locator("#tmYearInput").inputValue();
  check("C6 Year conflict surfaces valid adoptable candidates and sets manual year",
    conflictBtns >= 2 && adoptedYear === "2014", `btns=${conflictBtns}, year=${adoptedYear}`);

  // C7: Bulk edit defaults to 不変更, distinguishes common vs mixed, shared hash count, locked targets
  await p.evaluate(() => FKP.scenario("edit-bulk"));
  const bulkCheck = await p.evaluate(() => {
    const txt = document.querySelector(".tag-modal").innerText;
    const yearUnchanged = document.querySelector('[data-act="tm-year-mode"][data-v="unchanged"]')?.getAttribute("aria-checked") === "true";
    return {
      yearUnchanged,
      hasUniqueBanner: /実データ.*2曲分/.test(txt),
      hasScopeBanner: /フィルタ外の.*1曲は変更しません/.test(txt),
      hasCommonAndMixed: /全3曲共通/.test(txt) && /混在/.test(txt),
    };
  });
  check("C7 Bulk edit defaults year to 不変更, explains shared-hash & filter scope, shows common/mixed",
    bulkCheck.yearUnchanged && bulkCheck.hasUniqueBanner && bulkCheck.hasScopeBanner && bulkCheck.hasCommonAndMixed,
    JSON.stringify(bulkCheck));

  // C8: stale_revision keeps draft, reloads without losing draft, then saves cleanly
  await p.evaluate(() => FKP.scenario("edit-conflict"));
  const errDraftBefore = await p.evaluate(() => ({
    errText: document.querySelector('.tm-banner.bad')?.innerText || "",
    yearVal: document.querySelector("#tmYearInput")?.value,
    pendingAdd: FKP.S.tagModal?.add.map((a) => a.value),
  }));
  await p.locator('[data-act="tm-reload"]').click();
  const afterReloadDraft = await p.evaluate(() => ({
    okBanner: !!document.querySelector(".tm-banner.ok"),
    yearVal: document.querySelector("#tmYearInput")?.value,
    pendingAdd: FKP.S.tagModal?.add.map((a) => a.value),
  }));
  await p.locator('[data-act="tm-save"]').click();
  const savedAfterReload = await p.evaluate(() => {
    const flac = FKP.songs.find((s) => s.content_hash === "h-signal-flac-8a4f");
    return !document.querySelector(".tag-modal") && flac.year === 2016 && flac.tags.includes("ライブ定番");
  });
  check("C8 stale_revision keeps draft -> Reload preserves draft -> retry Save succeeds",
    /古い状態への誤保存/.test(errDraftBefore.errText) &&
    afterReloadDraft.okBanner &&
    afterReloadDraft.yearVal === "2016" &&
    afterReloadDraft.pendingAdd.includes("ライブ定番") &&
    savedAfterReload);

  // C9: identity_changed prevents Save and never mutates replacement track
  await p.evaluate(() => FKP.scenario("edit-identity"));
  const idBlocked = await p.evaluate(() => ({
    saveDisabled: document.querySelector('[data-act="tm-save"]')?.disabled,
    alertText: document.querySelector('.tm-banner.bad')?.innerText || "",
  }));
  check("C9 identity_changed blocks Save and never applies draft to replacement track",
    idBlocked.saveDisabled && /別の曲への誤適用を防ぐ/.test(idBlocked.alertText));

  // C10: store_read_only disables controls cleanly
  await p.evaluate(() => FKP.scenario("edit-readonly"));
  const roBlocked = await p.evaluate(() => ({
    saveDisabled: document.querySelector('[data-act="tm-save"]')?.disabled,
    alertText: document.querySelector('.tm-banner.bad')?.innerText || "",
  }));
  check("C10 store_read_only disables edits while allowing inspection",
    roBlocked.saveDisabled && /読み取り専用/.test(roBlocked.alertText));

  // C11: Unresolved identity & non-Funkot track behavior in Selection mode
  await p.evaluate(() => FKP.scenario("base"));
  const unresolvedId = await p.evaluate(() => FKP.songs.find((s) => s.content_hash === null).id);
  const nonFunkotId = await p.evaluate(() => FKP.songs.find((s) => s.analyzed && !s.funkot && s.content_hash).id);
  await p.evaluate(([uId, nfId]) => {
    FKP.S.selectMode = true;
    FKP.S.selected = new Set([uId]);
    FKP.render();
  }, [unresolvedId, nonFunkotId]);
  const unresolvedEditDisabled = await p.locator('[data-act="edit-selected-tags"]').isDisabled();
  await p.evaluate(([uId, nfId]) => {
    FKP.S.selected = new Set([nfId]);
    FKP.render();
  }, [unresolvedId, nonFunkotId]);
  const nonFunkotState = await p.evaluate(() => ({
    editEnabled: !document.querySelector('[data-act="edit-selected-tags"]').disabled,
    addDisabled: document.querySelector('[data-act="add-sel"]').disabled,
  }));
  check("C11 Unresolved identity disables tag edit; non-Funkot allows tag edit while keeping queue gated",
    unresolvedEditDisabled && nonFunkotState.editEnabled && nonFunkotState.addDisabled,
    JSON.stringify(nonFunkotState));

  // C12: Focus trap (Tab / Shift+Tab) + Cancel discards draft cleanly
  await p.evaluate(() => FKP.scenario("edit-single"));
  await p.locator("#tmAddInput").fill("破棄されるべきタグ");
  await p.locator('[data-act="tm-add-btn"]').click();
  await p.keyboard.press("Tab");
  const focusStillInModal = await p.evaluate(() => !!document.activeElement?.closest(".tag-modal"));
  await p.locator('[data-act="tm-close"]').first().click();
  const discarded = await p.evaluate(() => {
    const flac = FKP.songs.find((s) => s.content_hash === "h-signal-flac-8a4f");
    return !document.querySelector(".tag-modal") && !flac.tags.includes("破棄されるべきタグ");
  });
  check("C12 Modal keeps Tab focus inside and Cancel discards draft cleanly", focusStillInModal && discarded);

  // Accessibility: every visible control has an accessible name
  await p.evaluate(() => FKP.scenario("a"));
  const unnamedMain = await p.evaluate(() => [...document.querySelectorAll("button, input, select, a")]
    .filter((b) => b.offsetParent && !b.closest(".demo") && !b.closest("[hidden]"))
    .filter((b) => !(b.getAttribute("aria-label") || b.textContent.trim() || (b.id && document.querySelector(`label[for="${b.id}"]`))))
    .map((b) => b.outerHTML.slice(0, 80)));
  check("N1 every visible control has an accessible name", unnamedMain.length === 0, unnamedMain.join(" | "));
  check("N2 desktop run had zero page or console errors", errs.length === 0, errs.join("; "));

  await p.close();
}

// =========================================================================
// 2. Narrow 412x915 Touch — Overflow & >= 44px Target Checks across A, B, C
// =========================================================================
{
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(url);
  await p.evaluate(() => document.fonts.ready);

  await p.locator("#finderInput").tap();
  for (const [typed, k, v] of [["2015", "year", "2015"], ["日本人", "custom", "日本人トラックメーカー"], ["アニソン", "genre", "アニソンremix"]]) {
    await p.locator("#lensInput").fill(typed);
    await p.locator(`.sugg[data-kind="${k}"][data-v="${v}"]`).tap();
  }
  const smallLens = await p.evaluate(() => [...document.querySelectorAll(".lens button, .lens .sugg, .lens input")]
    .filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44)
    .map((b) => b.className));
  await p.locator(".lens-foot .btn.primary").tap();
  const narrowSearchOk = (await noOverflow(p)) && smallLens.length === 0 && (await p.locator("#lens").isHidden());
  check("D1 Narrow touch 3-condition search has no overflow and all lens targets ≥ 44px",
    narrowSearchOk, smallLens.join(","));

  // Check 9-condition manage sheet on narrow
  await p.evaluate(() => FKP.scenario("eight-manage"));
  const narrowManageOverflow = !(await noOverflow(p));
  const smallManage = await p.evaluate(() => [...document.querySelectorAll(".lens button, .lens input")]
    .filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44)
    .map((b) => b.className));
  check("D2 Narrow 9-condition ledger has zero horizontal overflow and targets ≥ 44px",
    !narrowManageOverflow && smallManage.length === 0, smallManage.join(","));

  // Detail & Tag Editor on narrow
  await p.evaluate(() => FKP.scenario("detail-many"));
  const narrowDetailOverflow = !(await noOverflow(p));
  await p.locator('#inspector [data-act="open-tag-editor"]').tap();
  const modalNarrow = await p.evaluate(() => {
    const foot = document.querySelector(".tm-foot").getBoundingClientRect();
    const small = [...document.querySelectorAll(".tag-modal button, .tag-modal input")]
      .filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44)
      .map((b) => b.className);
    return { overflow: document.documentElement.scrollWidth > innerWidth, footVisible: foot.bottom <= innerHeight + 1, small };
  });
  check("D3 Narrow Detail & 32-tag Editor: zero overflow, sticky footer visible, targets ≥ 44px",
    !narrowDetailOverflow && !modalNarrow.overflow && modalNarrow.footVisible && modalNarrow.small.length === 0,
    JSON.stringify(modalNarrow));

  check("D4 Narrow run had zero page errors", errs.length === 0, errs.join("; "));
  await ctx.close();
}

// =========================================================================
// 3. 200% Zoom (640x450 CSS viewport) across A, B, C
// =========================================================================
{
  const p = await browser.newPage({ viewport: { width: 640, height: 450 }, deviceScaleFactor: 2 });
  for (const scn of ["a", "search-basic", "detail", "edit-single", "edit-conflict"]) {
    await p.goto(url + "&s=" + scn);
    await p.evaluate(() => document.fonts.ready);
    const ok = await noOverflow(p);
    let extra = true;
    if (scn === "edit-single" || scn === "edit-conflict") {
      extra = await p.evaluate(() => document.querySelector('[data-act="tm-save"]').getBoundingClientRect().bottom <= innerHeight + 1);
    }
    check(`Z-${scn} 200% zoom: zero overflow & primary controls reachable`, ok && extra);
  }
  await p.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok).length;
writeFileSync("verify-result.json", JSON.stringify({ passed: results.length - failed, total: results.length, results }, null, 1) + "\n");
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
