import { createRequire } from "node:module";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const playwrightRoot = process.argv[2];
if (!playwrightRoot) throw new Error("Playwright package directory is required");
const { chromium } = require(playwrightRoot);
const out = resolve(".");
const source = pathToFileURL(resolve("../../library-general-claude/index.html")).href;
const tag = "\u65e5\u672c\u4eba\u30c8\u30e9\u30c3\u30af\u30e1\u30fc\u30ab\u30fc";
const genre = "\u30a2\u30cb\u30bd\u30f3remix";
const scenarios = ["base", "a", "a-edit", "a-detail", "a-select", "eight", "eight-edit", "error"];

mkdirSync(out, { recursive: true });

function pngDimensions(path) {
  const header = require("node:fs").readFileSync(path).subarray(16, 24);
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
}

function visibleMetrics() {
  const visible = (element) => {
    const r = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0 && style.visibility !== "hidden" && !element.closest("[hidden]") && !element.closest(".demo");
  };
  const controls = [...document.querySelectorAll("button, input, select, a[href], [role=option]")].filter(visible);
  const first = document.querySelector(".row")?.getBoundingClientRect();
  const results = document.querySelector("#results");
  const lens = document.querySelector("#lens:not([hidden])");
  const summary = document.querySelector("#summary");
  return {
    visibleChoices: controls.length,
    visibleCandidateChoices: [...document.querySelectorAll(".sugg")].filter(visible).length,
    firstRowTop: first ? Math.round(first.top) : null,
    resultScrollHeight: results ? Math.round(results.scrollHeight) : null,
    resultClientHeight: results ? Math.round(results.clientHeight) : null,
    pageHorizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    conditionSummaryHeight: summary && !summary.hidden ? Math.round(summary.getBoundingClientRect().height) : 0,
    editorOpen: Boolean(lens),
    editorIsFullViewport: Boolean(lens && lens.getBoundingClientRect().height >= innerHeight - 2),
    focusedId: document.activeElement?.id || null,
    focusedAction: document.activeElement?.getAttribute("data-act") || null,
  };
}

async function load(page, state) {
  await page.goto(`${source}?capture=1&s=${state}`);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => FKP.render());
  await page.waitForTimeout(150);
}

async function trial(page, isNarrow) {
  await load(page, "base");
  const input = isNarrow ? page.locator("#lensInput") : page.locator("#finderInput");
  if (isNarrow) await page.locator("#finderInput").tap();
  else await page.keyboard.press("/");
  const searchFocus = await page.evaluate(() => document.activeElement?.id);
  await input.fill("2015");
  const yearChoices = await page.locator(".sugg").count();
  await page.keyboard.press("Enter");
  await input.fill("\u65e5\u672c\u4eba");
  const tagChoices = await page.locator(".sugg").count();
  await page.locator(`.sugg[data-v="${tag}"]`).click();
  await input.fill("anison");
  const genreChoices = await page.locator(".sugg").count();
  await page.locator(`.sugg[data-v="${genre}"]`).click();
  const afterThree = {
    clauses: await page.evaluate(() => FKP.S.clauses.length),
    mode: await page.evaluate(() => FKP.S.mode),
    metrics: await page.evaluate(visibleMetrics),
  };
  await page.locator(".lens-foot .btn.primary").click();
  const resultsMetrics = await page.evaluate(visibleMetrics);
  const term = page.locator("#terms .term").first();
  if (isNarrow) await term.tap(); else await term.click();
  await page.waitForTimeout(50);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(50);
  const conditionEditEscape = await page.evaluate(() => ({
    editorOpen: !document.querySelector("#lens")?.hidden,
    focusedId: document.activeElement?.id || null,
  }));
  await page.locator(".row-main").first().click();
  const detailFocus = {
    active: await page.evaluate(() => document.activeElement?.className || null),
    metrics: await page.evaluate(visibleMetrics),
  };
  await page.locator('[data-act="edit-tags"]').click();
  const draftFocus = {
    active: await page.evaluate(() => document.activeElement?.id || null),
    metrics: await page.evaluate(visibleMetrics),
  };
  await page.locator("#tagEdit").fill("baseline-probe");
  await page.keyboard.press("Enter");
  const tagMutationToast = await page.locator("#toast span").textContent();
  return {
    searchFocus,
    candidateChoices: { year2015: yearChoices, japaneseTag: tagChoices, romanizedGenre: genreChoices },
    threeConditions: afterThree,
    afterReturningToResults: resultsMetrics,
    conditionEditEscape,
    detail: detailFocus,
    tagDraft: draftFocus,
    tagMutationToast,
  };
}

const browser = await chromium.launch({ channel: "msedge" });
const report = { source: "../../library-general-claude/index.html", browser: await browser.version(), viewports: {}, captures: [] };
for (const viewport of [
  { name: "desktop", width: 1280, height: 900, touch: false },
  { name: "narrow", width: 412, height: 915, touch: true },
]) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, hasTouch: viewport.touch, isMobile: viewport.touch, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  report.viewports[viewport.name] = { width: viewport.width, height: viewport.height, touch: viewport.touch, trial: await trial(page, viewport.touch), errors, staticStates: {} };
  for (const state of scenarios) {
    await load(page, state);
    const filename = `${viewport.name}-${state}.png`;
    const path = resolve(out, filename);
    await page.screenshot({ path, fullPage: false });
    report.captures.push({ file: filename, ...pngDimensions(path), bytes: statSync(path).size });
    report.viewports[viewport.name].staticStates[state] = await page.evaluate(visibleMetrics);
  }
  await load(page, "a-detail");
  await page.locator('[data-act="edit-tags"]').click();
  const tagFilename = `${viewport.name}-tag-draft.png`;
  const tagPath = resolve(out, tagFilename);
  await page.screenshot({ path: tagPath, fullPage: false });
  report.captures.push({ file: tagFilename, ...pngDimensions(tagPath), bytes: statSync(tagPath).size });
  report.viewports[viewport.name].staticStates.tagDraft = await page.evaluate(visibleMetrics);
  await context.close();
}
await browser.close();
writeFileSync(resolve(out, "baseline-metrics.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ browser: report.browser, captures: report.captures }, null, 2));
