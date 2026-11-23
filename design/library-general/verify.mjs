// Evidence generator for #170. It measures the Claude starting point and the
// integrated proposal in one browser/runtime, and drives the important flow.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright");
const root = resolve("..");
const pages = {
  claude: resolve(root, "library-ideal-claude", "index.html"),
  integrated: resolve(root, "library-general", "index.html"),
};
const output = resolve(root, "library-general", "evidence");
mkdirSync(output, { recursive: true });
const findings = [];
const record = (name, passed, detail = "") => {
  findings.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

function url(path, scenario) {
  return `${pathToFileURL(path).href}?capture=1&s=${scenario}`;
}

async function metrics(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return false;
      const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
      const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
      return element.contains(document.elementFromPoint(x, y));
    };
    const rows = [...document.querySelectorAll(".row")];
    const first = rows.find(visible);
    const rowRect = first?.getBoundingClientRect();
    const titleRect = first?.querySelector(".row-title, .track-title")?.getBoundingClientRect();
    // Ranges are measured down the centre of the song column. Side panels
    // do not count as vertical chrome; fixed footers and clipping do.
    let listBottom = rowRect ? Math.floor(rowRect.top) : 0;
    if(rowRect) {
      const x = rowRect.left + rowRect.width / 2;
      const list = first.parentElement;
      for(let y=Math.max(0,Math.ceil(rowRect.top));y<innerHeight;y++){
        if(list.contains(document.elementFromPoint(x,y)))listBottom = y+1;
      }
    }
    const controls = [...document.querySelectorAll("button, a[href], input, select, summary, [role=button]")].filter(visible);
    const rowControls = controls.filter((control) => control.closest(".row"));
    return {
      firstRowY: Math.round(rowRect?.top ?? -1),
      titleColumnWidth: Math.round(titleRect?.width ?? -1),
      fullyVisibleRows: rows.filter((row) => {
        const rect = row.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > innerHeight) return false;
        const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
        const points = [rect.top + 3, rect.bottom - 3];
        return points.every((y) => row.contains(document.elementFromPoint(x,y)));
      }).length,
      visibleFixedControls: controls.length - rowControls.length,
      visibleRowControls: rowControls.length,
      songColumnBottom: listBottom,
      firstRowToScreenBottomOcclusion: rowRect ? Math.round(innerHeight-listBottom) : null,
      visibleSongListAreaPx2: rowRect ? Math.round(rowRect.width*Math.max(0,listBottom-Math.max(0,rowRect.top))) : 0,
      firstRowActionSize: Math.round(first?.querySelector(".add")?.getBoundingClientRect().width ?? -1),
    };
  });
}

const browser = await chromium.launch();
const browserVersion = browser.version();
const variants = [
  { key: "desktop", viewport: { width: 1280, height: 900 }, hasTouch: false },
  { key: "narrow", viewport: { width: 412, height: 915 }, hasTouch: true },
];
const scenarios = ["base", "a", "a-edit", "a-detail", "eight", "zero", "loading", "error"];
const evidence = { browser: "Chromium "+browserVersion+" via Playwright", scenarios, metrics: {}, checks: findings };

for (const [proposal, path] of Object.entries(pages)) {
  evidence.metrics[proposal] = {};
  for (const variant of variants) {
    const context = await browser.newContext({ viewport: variant.viewport, hasTouch: variant.hasTouch, isMobile: variant.hasTouch, reducedMotion:"reduce", deviceScaleFactor: variant.hasTouch ? 2 : 1 });
    await context.route("https://fonts.**", route => route.abort());
    const page = await context.newPage();
    evidence.metrics[proposal][variant.key] = {};
    for (const scenario of scenarios) {
      await page.goto(url(path, scenario));
      if(proposal==="claude" && scenario==="a-detail") await page.locator(".row.is-open").scrollIntoViewIfNeeded();
      await page.waitForTimeout(100);
      await page.screenshot({ path: resolve(output, `${proposal}-${variant.key}-${scenario}.png`) });
      evidence.metrics[proposal][variant.key][scenario] = await metrics(page);
    }
    await context.close();
  }
}

// The comparison includes the post-add result in both original viewports.
for (const variant of variants) {
  const context = await browser.newContext({ viewport: variant.viewport, hasTouch: variant.hasTouch, isMobile: variant.hasTouch, reducedMotion:"reduce", deviceScaleFactor: variant.hasTouch ? 2 : 1 });
  const page = await context.newPage();
  await page.goto(url(pages.claude, "a"));
  const row = page.locator(".row", { hasText: "鋼鉄商店街ダンスホール" });
  const add = row.locator(".add");
  if (variant.hasTouch) await add.tap(); else await add.click();
  await page.screenshot({ path: resolve(output, `claude-${variant.key}-after-add.png`) });
  await context.close();
}

// Drive the requested discovery -> three AND conditions -> identify -> add flow.
const desktop = await browser.newPage({ reducedMotion:"reduce", viewport: { width: 1280, height: 900 } });
const errors = [];
desktop.on("pageerror", (error) => errors.push(error.message));
await desktop.goto(url(pages.integrated, "base"));
await desktop.keyboard.press("/");
record("slash focuses the global finder", await desktop.locator("#finderInput").evaluate((input) => document.activeElement === input));
await desktop.locator("#filterBtn").click();
await desktop.locator("#conditionInput").fill("2015");
record("year candidate is discoverable", await desktop.getByRole("option", { name: /2015.*制作年/ }).count() === 1);
await desktop.getByRole("option", { name: /2015.*制作年/ }).click();
await desktop.locator("#conditionInput").fill("日本人");
const japaneseProducer = desktop.getByRole("option", { name: /^日本人トラックメーカー タグ/ });
record("thousands-tag candidate narrows by text", await japaneseProducer.count() === 1);
await japaneseProducer.click();
await desktop.locator("#conditionInput").fill("アニソン");
const anisonRemix = desktop.getByRole("option", { name: /^アニソンremix ジャンル/ });
record("spelling variant is discoverable", await anisonRemix.count() === 1);
await anisonRemix.click();
const advanced = await desktop.evaluate(() => ({
  clauses: Number(document.querySelector("#activeNumber")?.textContent),
  rows: document.querySelectorAll(".row").length,
  count: document.querySelector("#count")?.textContent ?? "",
}));
record("three active AND conditions yield the exact 53 results", advanced.clauses === 3 && advanced.rows === 53 && advanced.count === "53 曲", JSON.stringify(advanced));
const countText = async () => Number((await desktop.locator("#count").innerText()).replace(/[^0-9]/g, ""));
await desktop.locator(".editor-condition .pause").first().click();
const pausedCount = await countText();
record("a condition can be paused without removal", pausedCount > 53, `${pausedCount} results`);
await desktop.locator(".editor-condition .pause").first().click();
record("resuming restores the three-condition result", await countText() === 53);
await desktop.locator(".editor-condition .negate").first().click();
record("a condition can be negated", (await countText()) !== 53 && Number(await desktop.locator("#activeNumber").innerText()) === 3, `${await countText()} results`);
await desktop.locator("#undoCondition").click();
record("condition history restores the pre-negation search", await countText() === 53);
await desktop.locator("#toggleJoiner").click();
record("OR interpretation remains available for the same conditions", await countText() === 10525, `${await countText()} results`);
await desktop.locator("#toggleJoiner").click();
await desktop.locator("#closeLens").click();
record("editing closes before result actions", !(await desktop.locator("#lens").isVisible()));
const firstAdd = desktop.locator('.row[data-song-id="24820"] .add').first();
const addedSongId = Number(await firstAdd.evaluate((button) => button.closest(".row")?.dataset.songId));
const label = await firstAdd.getAttribute("aria-label");
const size = await firstAdd.evaluate((button) => Math.round(button.getBoundingClientRect().width));
record("mouse add target is named and reaches 28px", Boolean(label) && size >= 28, `${label}, ${size}px`);
await firstAdd.click();
record("one action adds to displayed destination", await desktop.locator("#toast").isVisible() && await desktop.evaluate((id) => window.FKS?.getCollectionIds("queue").includes(id), addedSongId));
await desktop.screenshot({ path: resolve(output, "integrated-desktop-after-add.png") });
await firstAdd.focus();
await desktop.keyboard.press("Enter");
record("keyboard row add remains available", await desktop.locator("#toast").isVisible());
await desktop.goto(url(pages.integrated, "eight"));
const eight = await desktop.evaluate(() => ({
  clauses: document.querySelectorAll(".editor-condition").length,
  summary: document.querySelector("#summary")?.textContent ?? "",
  editor: Boolean(document.querySelector("#lens")),
}));
record("8+ conditions have a bounded summary and editor", eight.clauses >= 8 && Number(eight.summary.match(/\d+/)?.[0]) >= 8 && eight.editor, JSON.stringify(eight));
await desktop.goto(url(pages.integrated, "error"));
record("error scenario is explicitly rendered", await desktop.locator("#status").isVisible() && /失敗/.test(await desktop.locator("#count").innerText()));
record("no JavaScript errors in desktop flow", errors.length === 0, errors.join(" | "));
await desktop.close();

const zoom = await browser.newPage({ reducedMotion:"reduce", viewport: { width: 640, height: 450 } });
await zoom.goto(url(pages.integrated, "a"));
record("200% equivalent keeps search reachable without horizontal overflow", await zoom.locator("#finderInput").isVisible() && await zoom.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await zoom.close();
const largeText = await browser.newPage({viewport:{width:412,height:915},hasTouch:true,reducedMotion:"reduce"});
await largeText.goto(url(pages.integrated,"a"));
const titleSize = () => largeText.locator(".track-title").first().evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
const initialSize = await titleSize();
await largeText.addStyleTag({content:"html {font-size:200% !important}"});
const enlargedSize = await titleSize();
record("root text enlargement doubles title at 412px", enlargedSize===initialSize*2 && await largeText.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),initialSize+" to "+enlargedSize+"px");
await largeText.screenshot({path:resolve(output,"integrated-narrow-text200.png")});
await largeText.locator("#filterBtn").tap();
await largeText.locator("#conditionInput").fill("2016");
await largeText.getByRole("option",{name:/^2016 制作年/}).tap();
await largeText.locator("#closeLens").tap();
record("enlarged-text user can edit conditions and return", !(await largeText.locator("#lens").isVisible()));
await largeText.close();
const touch = await browser.newContext({ reducedMotion:"reduce", viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
const touchPage = await touch.newPage();
await touchPage.goto(url(pages.integrated, "base"));
await touchPage.locator("#filterBtn").tap();
for (const [query, candidate] of [["2015", /^2015.*制作年/], ["日本人", /^日本人トラックメーカー タグ/], ["アニソン", /^アニソンremix ジャンル/]]) {
  await touchPage.locator("#conditionInput").fill(query);
  await touchPage.getByRole("option", { name: candidate }).tap();
}
record("touch builds the same three structured AND conditions", Number(await touchPage.locator("#activeNumber").innerText()) === 3 && await touchPage.locator("#count").innerText() === "53 曲");
await touchPage.locator("#closeLens").tap();
const touchAdd = touchPage.locator('.row[data-song-id="24820"] .add').first();
record("touch add target reaches 44px", await touchAdd.evaluate((button) => Math.min(button.getBoundingClientRect().width, button.getBoundingClientRect().height)) >= 44, `${await touchAdd.evaluate((button) => `${Math.round(button.getBoundingClientRect().width)}×${Math.round(button.getBoundingClientRect().height)}`)}px`);
await touchAdd.tap();
record("touch adds in one operation", await touchPage.locator("#toast").isVisible());
await touchPage.screenshot({ path: resolve(output, "integrated-narrow-after-add.png") });
await touch.close();
await browser.close();

evidence.checks = findings;
writeFileSync(resolve(output, "measurements.json"), `${JSON.stringify(evidence, null, 2)}\n`);
const failed = findings.filter((finding) => !finding.passed).length;
console.log(`${findings.length - failed}/${findings.length} acceptance checks passed`);
process.exit(failed ? 1 : 0);
