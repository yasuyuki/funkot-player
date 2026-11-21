import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const mainPlayerRoot = "C:/Users/flame/work/funkot-player";
const playwrightEntry = pathToFileURL(path.join(mainPlayerRoot, "node_modules/playwright/index.mjs")).href;

const { chromium } = await import(playwrightEntry);

const protoUrl = pathToFileURL(path.join(__dirname, "prototype/index.html")).href;
const capturesDir = path.join(__dirname, "captures");
fs.mkdirSync(capturesDir, { recursive: true });

const report = {
  generatedAt: new Date().toISOString(),
  prototypePath: "proposals/library-ideal-agy/prototype/index.html",
  interactions: {},
  geometryChecks: [],
  captures: []
};

async function measureGeometry(page, label, viewportName) {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const titleEl = document.querySelector(".track-title");
    const addBtn = document.querySelector(".row-add-btn");
    const ledger = document.querySelector(".track-ledger");
    const firstRow = document.querySelector(".track-row");

    const titleStyle = titleEl ? getComputedStyle(titleEl) : null;
    const addStyle = addBtn ? getComputedStyle(addBtn) : null;
    const addRect = addBtn ? addBtn.getBoundingClientRect() : null;
    const ledgerRect = ledger ? ledger.getBoundingClientRect() : null;
    const firstRowRect = firstRow ? firstRow.getBoundingClientRect() : null;

    return {
      clientWidth: doc.clientWidth,
      scrollWidth: doc.scrollWidth,
      horizontalOverflowPx: Math.max(0, doc.scrollWidth - doc.clientWidth),
      titleFontSizePx: titleStyle ? parseFloat(titleStyle.fontSize) : null,
      titleColor: titleStyle ? titleStyle.color : null,
      addBtnWidthPx: addRect ? Math.round(addRect.width) : null,
      addBtnHeightPx: addRect ? Math.round(addRect.height) : null,
      addBtnBg: addStyle ? addStyle.backgroundColor : null,
      ledgerTopPx: ledgerRect ? Math.round(ledgerRect.top) : null,
      firstRowTopPx: firstRowRect ? Math.round(firstRowRect.top) : null,
      visibleRowCount: document.querySelectorAll(".track-row").length
    };
  });

  const check = {
    label,
    viewport: viewportName,
    ...metrics,
    passedNoHorizontalOverflow: metrics.horizontalOverflowPx <= 1,
    passedAddHitTarget44:
      metrics.addBtnWidthPx === null || (metrics.addBtnWidthPx >= 44 && metrics.addBtnHeightPx >= 44),
    passedTitleProminence:
      metrics.titleFontSizePx === null || metrics.titleFontSizePx >= 15
  };
  report.geometryChecks.push(check);
  return check;
}

const browser = await chromium.launch({ headless: true });

try {
  // =========================================================================
  // 1. REAL INTERACTIVE WORKFLOW CHECKS (A, B, C on Desktop + D on Narrow)
  // =========================================================================
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(protoUrl, { waitUntil: "load" });

    // Initial track count
    const initialCount = await page.locator(".track-row").count();

    // (A) Open Facet Studio and build: 2015年 AND 日本人トラックメーカー AND アニソンremix
    await page.click("#btnToggleFacetStudio");
    await page.waitForSelector("#facetStudio:not([hidden])");

    // Pick 2015年 directly
    await page.click('[data-tag-key="year:2015"]');
    // Narrow 3,420 candidates for 日本人
    await page.fill("#facetCandidateInput", "日本人");
    await page.click('[data-tag-key="custom:日本人トラックメーカー"]');
    // Narrow using English synonym "Anime Remix" to verify variant hint recovery
    await page.fill("#facetCandidateInput", "Anime Remix");
    await page.waitForSelector(".variant-pick-btn");
    await page.click(".variant-pick-btn");
    await page.click("#btnCloseFacetStudio");

    const after3TagsCount = await page.locator(".track-row").count();
    const resultsText = await page.textContent("#resultsCount");

    // (B) Edit & remove one condition, then restore it
    await page.click('.condition-pill-remove >> nth=1');
    const afterRemoveCount = await page.locator(".track-row").count();
    await page.click("#btnRestoreCondition");
    const afterRestoreCount = await page.locator(".track-row").count();

    // (C) Add first matched track in 1 click to selected destination & verify Undo
    const destCountBefore = await page.textContent("#dockDestCount");
    await page.click('.row-add-btn >> nth=0');
    const destCountAfterAdd = await page.textContent("#dockDestCount");
    const toastMsg = await page.textContent("#toastMessage");
    await page.click("#btnToastUndo");
    const destCountAfterUndo = await page.textContent("#dockDestCount");

    // Re-add so destination holds added track, then verify playback source remained independent
    await page.click('.row-add-btn >> nth=0');
    const playbackSource = await page.textContent("#playingSource");

    report.interactions.desktopABC = {
      initialCount,
      after3TagsCount,
      resultsText: resultsText?.trim(),
      afterRemoveCount,
      afterRestoreCount,
      destCountBefore: destCountBefore?.trim(),
      destCountAfterAdd: destCountAfterAdd?.trim(),
      toastMsg: toastMsg?.trim(),
      destCountAfterUndo: destCountAfterUndo?.trim(),
      playbackSource: playbackSource?.trim(),
      passed:
        initialCount === 19 &&
        after3TagsCount === 6 &&
        afterRemoveCount === 7 &&
        afterRestoreCount === 6 &&
        destCountBefore?.trim() === "3 曲登録済" &&
        destCountAfterAdd?.trim() === "4 曲登録済" &&
        destCountAfterUndo?.trim() === "3 曲登録済"
    };
    await ctx.close();
  }

  // (D) Narrow/Touch 412x915 interactive flow
  {
    const ctx = await browser.newContext({
      viewport: { width: 412, height: 915 },
      hasTouch: true,
      isMobile: true
    });
    const page = await ctx.newPage();
    await page.goto(protoUrl, { waitUntil: "load" });
    // Force coarse input mode check
    await page.evaluate(() => {
      document.body.dataset.inputKind = "coarse";
    });

    await page.click("#btnToggleFacetStudio");
    await page.click('[data-tag-key="year:2015"]');
    await page.fill("#facetCandidateInput", "日本人");
    await page.click('[data-tag-key="custom:日本人トラックメーカー"]');
    await page.fill("#facetCandidateInput", "アニソン");
    await page.click('[data-tag-key="genre:アニソンremix"]');
    await page.click("#btnCloseFacetStudio");

    const narrowMatchedCount = await page.locator(".track-row").count();
    await page.click('.row-add-btn >> nth=0');
    const narrowDestText = await page.textContent("#narrowDestName");

    // Open Narrow Destination Sheet & switch destination to 再生待ち
    await page.click("#btnOpenNarrowDestSheet");
    await page.waitForSelector("#narrowDestBackdrop:not([hidden])");
    await page.click('[data-dest-id="queue"]');
    const switchedNarrowDestText = await page.textContent("#narrowDestName");
    await page.click("#btnCloseNarrowDestSheet");

    report.interactions.narrowD = {
      narrowMatchedCount,
      narrowDestText: narrowDestText?.trim(),
      switchedNarrowDestText: switchedNarrowDestText?.trim(),
      passed:
        narrowMatchedCount === 6 &&
        narrowDestText?.includes("4曲") &&
        switchedNarrowDestText?.includes("再生待ち")
    };
    await ctx.close();
  }

  // Also test Scale 9-conditions Overflow Drawer wraps cleanly without overflow
  {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await page.goto(`${protoUrl}?preset=scale-9tags`, { waitUntil: "load" });
    await page.click("#btnOverflowConditions");
    await page.waitForSelector("#overflowConditionsDrawer:not([hidden])");
    const overflowDrawerCheck = await measureGeometry(page, "05-overflow-drawer-open", "narrow-412x915");
    report.interactions.scaleOverflowDrawerPassed =
      overflowDrawerCheck.passedNoHorizontalOverflow &&
      (await page.locator("#overflowPillsGrid .condition-pill").count()) === 9;
    await ctx.close();
  }

  // =========================================================================
  // 2. DETERMINISTIC HIGH-RES CAPTURES (Desktop 1280x900 & Narrow 412x915)
  // =========================================================================
  const scenarios = [
    { preset: "default", slug: "01-default" },
    { preset: "facet-open", slug: "02-facet-studio" },
    { preset: "and-3tags", slug: "03-compound-results" },
    { preset: "add-inspect", slug: "04-add-and-inspect" },
    { preset: "scale-9tags", slug: "05-scale-9conditions" },
    { preset: "zero-conflict", slug: "06-exceptions-zero-error" },
    { preset: "zoom-200", slug: "07-zoom-200pct" }
  ];

  const viewports = [
    { name: "desktop-1280x900", width: 1280, height: 900, touch: false },
    { name: "narrow-412x915", width: 412, height: 915, touch: true }
  ];

  for (const vp of viewports) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.touch,
      isMobile: vp.touch,
      deviceScaleFactor: 1
    });
    const page = await ctx.newPage();

    for (const sc of scenarios) {
      const targetUrl = `${protoUrl}?preset=${sc.preset}`;
      await page.goto(targetUrl, { waitUntil: "load" });
      if (vp.touch) {
        await page.evaluate(() => {
          document.body.dataset.inputKind = "coarse";
        });
      }
      await page.waitForTimeout(120);

      const fileName = `${sc.slug}-${vp.name}.png`;
      const outPath = path.join(capturesDir, fileName);
      await page.screenshot({ path: outPath, fullPage: false });

      const geo = await measureGeometry(page, sc.slug, vp.name);
      report.captures.push({
        preset: sc.preset,
        viewport: vp.name,
        file: `proposals/library-ideal-agy/captures/${fileName}`,
        passedNoHorizontalOverflow: geo.passedNoHorizontalOverflow,
        passedAddHitTarget44: geo.passedAddHitTarget44
      });
    }

    await ctx.close();
  }
} finally {
  await browser.close();
}

const reportPath = path.join(__dirname, "verification-report.json");
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

const allPassed =
  report.interactions.desktopABC?.passed &&
  report.interactions.narrowD?.passed &&
  report.interactions.scaleOverflowDrawerPassed &&
  report.geometryChecks.every((g) => g.passedNoHorizontalOverflow && g.passedAddHitTarget44 && g.passedTitleProminence);

console.log(JSON.stringify({ allPassed, interactions: report.interactions, checksCount: report.geometryChecks.length }, null, 2));
if (!allPassed) {
  process.exitCode = 1;
}
