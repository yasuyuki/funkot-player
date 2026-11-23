import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const playwrightRoot = process.argv[2];
if (!playwrightRoot) throw new Error("Playwright package directory is required");
const { chromium } = require(playwrightRoot);
const source = pathToFileURL(resolve("../index.html")).href;
const output = resolve("search-contract.json");
const result = { source: "../index.html", browser: null, viewports: {}, checks: [] };

function note(name, ok, detail = {}) {
  result.checks.push({ name, ok, detail });
}

function number(text) {
  return Number(String(text).replace(/[^0-9]/g, ""));
}

async function waitForUi(page) {
  await page.locator("#indexSearchInput").waitFor();
  await page.evaluate(() => document.fonts.ready);
}

async function reset(page, scenario = "base") {
  await page.goto(`${source}?capture=1&s=${scenario}`);
  await waitForUi(page);
}

async function count(page) {
  return number(await page.locator("#rbCount b").innerText());
}

async function visibleChoices(page) {
  return page.evaluate(() => [...document.querySelectorAll("button, input, select, a[href], [role=option]")].filter((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0 && rect.left < innerWidth && rect.right > 0 && style.visibility !== "hidden" && !element.closest("[hidden]") && !element.closest(".demo");
  }).length);
}

async function typeQuery(page, value) {
  const input = page.locator("#indexSearchInput");
  await input.fill(value);
  await page.waitForTimeout(30);
}

async function suggestionData(page) {
  return page.locator(".index-suggestion").evaluateAll((items) => items.map((item) => ({
    kind: item.querySelector(".index-kind")?.textContent?.trim() || "",
    value: item.querySelector(".index-value")?.textContent?.trim() || "",
    count: item.querySelector(".index-count")?.textContent?.trim() || "",
  })));
}

async function pick(page, predicate, description) {
  const items = await suggestionData(page);
  const index = items.findIndex(predicate);
  if (index < 0) throw new Error(`candidate not found: ${description}; got ${JSON.stringify(items)}`);
  await page.locator(".index-suggestion").nth(index).click();
}

async function buildThree(page) {
  await reset(page);
  await typeQuery(page, "2015");
  await pick(page, (item) => item.kind === "制作年" && item.value.startsWith("2015"), "year 2015");
  await typeQuery(page, "日本人");
  await pick(page, (item) => item.kind === "タグ" && item.value.startsWith("日本人トラックメーカー"), "Japanese trackmaker tag");
  await typeQuery(page, "anison");
  await pick(page, (item) => item.kind === "ジャンル" && item.value.startsWith("アニソンremix"), "anison genre");
  return count(page);
}

async function closePanel(page) {
  const close = page.locator('[data-action="close"]');
  if (await close.count()) await close.click();
}

async function queryMeasurements(page) {
  const measured = {};
  await reset(page);
  for (const query of ["2015", "日本人", "anison"]) {
    await typeQuery(page, query);
    const suggestions = await suggestionData(page);
    measured[query] = {
      suggestions,
      suggestionCount: suggestions.length,
      visibleChoices: await visibleChoices(page),
    };
    if (query === "2015") await pick(page, (item) => item.kind === "制作年" && item.value.startsWith("2015"), "year 2015");
    if (query === "日本人") await pick(page, (item) => item.kind === "タグ" && item.value.startsWith("日本人トラックメーカー"), "Japanese trackmaker tag");
    if (query === "anison") await pick(page, (item) => item.kind === "ジャンル" && item.value.startsWith("アニソンremix"), "anison genre");
  }
  const twentyFifteen = measured["2015"].suggestions;
  note("same-name-2015-namespaces", twentyFifteen.some((item) => item.kind === "制作年" && item.value.startsWith("2015")) && twentyFifteen.some((item) => item.kind === "タグ" && item.value.startsWith("2015")), measured["2015"]);

  await reset(page);
  await typeQuery(page, "Funkot");
  const funkot = await suggestionData(page);
  note("same-name-funkot-namespaces", funkot.some((item) => item.kind === "ジャンル" && item.value.startsWith("Funkot")) && funkot.some((item) => item.kind === "タグ" && item.value.startsWith("Funkot")), { suggestions: funkot });
  const anison = measured.anison.suggestions;
  note("spelling-variants-visible", anison.some((item) => /類似表記\s*[2-9]/.test(item.value)), measured.anison);
  return measured;
}

async function advancedAndHistory(page) {
  const andCount = await buildThree(page);
  await page.locator(".index-advanced-open").click();
  await page.locator('[data-action="mode"]').click();
  const orCount = await count(page);
  const joiner = await page.locator(".index-join").first().innerText();
  note("or-prediction-broadens-results", orCount > andCount && joiner === "または", { andCount, orCount, joiner });

  await page.locator(".index-clause-list button").nth(0).click();
  await page.locator('[data-action="pause"]').click();
  const pausedCount = await count(page);
  const pausedText = await page.locator(".index-clause-list button").first().innerText();
  note("pause-is-visible-and-changes-result", /一時停止/.test(pausedText) && pausedCount > 0 && pausedCount <= orCount, { orCount, pausedCount, pausedText });

  await page.locator(".index-clause-list button").nth(1).click();
  await page.locator('[data-action="negate"]').click();
  const negatedText = await page.locator(".index-clause-list button").nth(1).innerText();
  note("negation-is-visible", /除外/.test(negatedText), { negatedText, resultCount: await count(page) });

  await reset(page);
  await typeQuery(page, "2015");
  await pick(page, (item) => item.kind === "制作年" && item.value.startsWith("2015"), "year 2015");
  await typeQuery(page, "日本人");
  await pick(page, (item) => item.kind === "タグ" && item.value.startsWith("日本人トラックメーカー"), "Japanese trackmaker tag");
  await closePanel(page);
  await page.locator('.index-term [data-action="remove"]').last().click();
  const afterRemoval = await page.locator(".index-term").count();
  const undoVisible = await page.locator(".index-undo").isVisible();
  await page.locator(".index-undo").click();
  const afterUndo = await page.locator(".index-term").count();
  note("undo-restores-removed-condition", undoVisible && afterRemoval === 1 && afterUndo === 2, { afterRemoval, afterUndo });
  const history = page.locator(".index-history button");
  const historyCount = await history.count();
  if (historyCount) await history.first().click();
  const restoredTerms = await page.locator(".index-term").count();
  note("history-restores-a-search", historyCount > 0 && restoredTerms > 0, { historyCount, restoredTerms });
}

async function zeroAndUnset(page) {
  await reset(page, "zero");
  await page.locator("#indexSearchInput").click();
  const beforeRelax = await count(page);
  const relax = page.locator(".index-relaxation button").first();
  const relaxVisible = await relax.isVisible();
  const relaxText = relaxVisible ? await relax.innerText() : await page.locator(".index-relaxation").innerText();
  if (relaxVisible) await relax.click();
  const afterRelax = await count(page);
  note("zero-result-relaxation", beforeRelax === 0 && relaxVisible && afterRelax > 0, { beforeRelax, afterRelax, relaxVisible, relaxText });

  await reset(page);
  await page.locator("#indexSearchInput").click();
  await page.locator(".index-unset").click();
  const unsetOnly = await count(page);
  await typeQuery(page, "Funkot");
  await pick(page, (item) => item.kind === "ジャンル" && item.value.startsWith("Funkot"), "Funkot genre");
  await page.locator(".index-advanced-open").click();
  await page.locator('[data-action="mode"]').click();
  await closePanel(page);
  const unsetAndAny = await count(page);
  const visibleYears = await page.locator(".row .row-meta").evaluateAll((items) => items.map((item) => item.textContent?.trim() || ""));
  note("unset-year-remains-mandatory-in-or", unsetOnly > 0 && unsetAndAny > 0 && unsetAndAny <= unsetOnly && visibleYears.length > 0 && visibleYears.every((text) => text.startsWith("—")), { unsetOnly, unsetAndAny, visibleYears });
}

async function ime(page) {
  await reset(page);
  const before = await page.locator(".index-suggestion").count();
  const during = await page.locator("#indexSearchInput").evaluate((input) => {
    input.focus();
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    input.value = "日本人";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "人", inputType: "insertCompositionText", isComposing: true }));
    return { active: document.activeElement?.id || null, value: input.value, suggestions: document.querySelectorAll(".index-suggestion").length };
  });
  await page.locator("#indexSearchInput").evaluate((input) => input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: input.value })));
  await page.waitForTimeout(50);
  const after = { active: await page.evaluate(() => document.activeElement?.id || null), suggestions: await page.locator(".index-suggestion").count() };
  note("ime-composition-keeps-focus-and-defers-render", during.active === "indexSearchInput" && during.value === "日本人" && during.suggestions === before && after.active === "indexSearchInput" && after.suggestions > 0, { before, during, after, boundary: "synthetic DOM composition events only; no OS IME" });
}

const browser = await chromium.launch({ channel: "msedge" });
result.browser = await browser.version();
for (const viewport of [
  { name: "desktop", width: 1280, height: 900, touch: false },
  { name: "narrow", width: 412, height: 915, touch: true },
]) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, hasTouch: viewport.touch, isMobile: viewport.touch, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  result.viewports[viewport.name] = { width: viewport.width, height: viewport.height, touch: viewport.touch, measurements: null };
  try {
    result.viewports[viewport.name].measurements = await queryMeasurements(page);
    await advancedAndHistory(page);
    await zeroAndUnset(page);
    await ime(page);
  } catch (error) {
    note(`unexpected-${viewport.name}`, false, { message: error.message });
  }
  result.viewports[viewport.name].pageErrors = errors;
  note(`page-errors-${viewport.name}`, errors.length === 0, { errors });
  result.viewports[viewport.name].finalVisibleChoices = await visibleChoices(page);
  await context.close();
}
await browser.close();
result.passed = result.checks.filter((check) => check.ok).length;
result.total = result.checks.length;
writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ passed: result.passed, total: result.total, checks: result.checks }, null, 2));
process.exit(result.passed === result.total ? 0 : 1);
