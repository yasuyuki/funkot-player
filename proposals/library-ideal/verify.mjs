import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = pathToFileURL(path.join(dir, "index.html")).href;
const shots = path.join(dir, "shots");
await mkdir(shots, { recursive: true });

const browser = await chromium.launch();
const report = { errors: [], flow: [], axe: [], overflow: [], type: [] };

async function open(width, height, hash = "") {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: "ja-JP" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${html}${hash}`, { waitUntil: "load" });
  await page.evaluate(async () => { await document.fonts.ready; });
  report.errors.push(...errors.map((error) => `${width} ${hash} ${error}`));
  return page;
}

function shot(page, name) {
  return page.screenshot({ path: path.join(shots, name), animations: "disabled" });
}

async function measure(page, label) {
  const box = await page.evaluate(() => {
    const root = document.documentElement;
    const title = document.querySelector(".hero, .title");
    const add = document.querySelector(".add, .quiet-act");
    const titleSize = title ? parseFloat(getComputedStyle(title).fontSize) : 0;
    const addSize = add ? parseFloat(getComputedStyle(add).fontSize) : 0;
    const titleWeight = title ? getComputedStyle(title).fontWeight : "";
    return {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      titleSize,
      addSize,
      titleWeight,
      result: document.querySelector("[data-result]")?.textContent || "",
      hits: document.querySelectorAll(".hits button").length
    };
  });
  report.overflow.push({ label, scrollWidth: box.scrollWidth, clientWidth: box.clientWidth, overflow: box.scrollWidth > box.clientWidth + 1 });
  report.type.push({ label, titleSize: box.titleSize, addSize: box.addSize, titleWeight: box.titleWeight, result: box.result, hits: box.hits });
  return box;
}

async function axe(page, label) {
  const result = await new AxeBuilder({ page }).analyze();
  const violations = result.violations.filter((item) => item.impact === "serious" || item.impact === "critical");
  report.axe.push({ label, violations: violations.map((item) => ({ id: item.id, impact: item.impact, help: item.help, nodes: item.nodes.length })) });
}

const desktop = await open(1280, 900);
await shot(desktop, "desktop-library.png");
await measure(desktop, "desktop-library");
await axe(desktop, "desktop-library");

await desktop.getByRole("button", { name: "条件を足す" }).click();
await desktop.getByLabel("年、ジャンル、タグを探す").fill("2015");
await desktop.locator('button[data-act="hit"][data-kind="year"][data-value="2015"]').click();
await desktop.getByLabel("年、ジャンル、タグを探す").fill("日本人トラック");
await desktop.locator('button[data-act="hit"][data-kind="custom"][data-value="日本人トラックメーカー"]').click();
await desktop.getByLabel("年、ジャンル、タグを探す").fill("アニソンremix");
await desktop.locator('button[data-act="hit"][data-kind="custom"][data-value="アニソンremix"]').click();
await shot(desktop, "desktop-flow-results.png");
const andText = await desktop.locator("[data-result]").innerText();
report.flow.push({ step: "three-and", text: andText });

await desktop.locator('button[data-act="junction"][data-index="1"]').click();
const orText = await desktop.locator("[data-result]").innerText();
const orWord = await desktop.locator('button[data-act="junction"][data-index="1"]').innerText();
report.flow.push({ step: "toggle-or", text: orText, word: orWord });
await shot(desktop, "desktop-flow-or.png");
await desktop.locator('button[data-act="junction"][data-index="1"]').click();

await desktop.locator('.row[data-track="long"]').click();
const hero = await desktop.locator(".hero").innerText();
const heroSize = await desktop.locator(".hero").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
const addSize = await desktop.locator('button[data-act="add"][data-id="long"]').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
report.flow.push({ step: "judge", hero: hero.slice(0, 24), heroSize, addSize });
await shot(desktop, "desktop-flow-judge.png");
await desktop.locator('button[data-act="add"][data-id="long"]').click();
const added = await desktop.locator(".confirm").innerText();
report.flow.push({ step: "add", added });
await desktop.getByRole("button", { name: "再生待ち", exact: true }).click();
const queued = await desktop.locator(".plain-list .title").allInnerTexts();
report.flow.push({ step: "queue-has-long", queued: queued.some((title) => title.startsWith("誰も知らない")) });
await desktop.getByRole("button", { name: "ライブラリ", exact: true }).click();
await desktop.getByRole("button", { name: "外す" }).first().click();
const afterRemove = await desktop.locator("[data-result]").innerText();
report.flow.push({ step: "removed-one", text: afterRemove });

await desktop.context().close();

const narrow = await open(412, 915);
await narrow.getByRole("button", { name: "条件を足す" }).click();
await narrow.getByLabel("年、ジャンル、タグを探す").fill("2015");
await narrow.locator('button[data-act="hit"][data-kind="year"][data-value="2015"]').click();
await narrow.getByLabel("年、ジャンル、タグを探す").fill("アニソンremix");
await narrow.locator('button[data-act="hit"][data-kind="custom"][data-value="アニソンremix"]').click();
await narrow.locator(".row").first().click();
await narrow.locator(".row.is-focus button[data-act='add']").click();
const narrowAdded = await narrow.locator(".confirm").innerText();
report.flow.push({ step: "narrow-add", added: narrowAdded });
await measure(narrow, "narrow-flow");
await shot(narrow, "narrow-flow.png");
await narrow.context().close();

const views = [
  ["desktop-finder", 1280, 900, "#finder"],
  ["desktop-results", 1280, 900, "#results"],
  ["desktop-judge", 1280, 900, "#judge"],
  ["desktop-eight", 1280, 900, "#eight"],
  ["desktop-empty", 1280, 900, "#empty"],
  ["desktop-error", 1280, 900, "#error"],
  ["desktop-loading", 1280, 900, "#loading"],
  ["desktop-or", 1280, 900, "#or"],
  ["desktop-scale", 1280, 900, "#scale"],
  ["desktop-blocked", 1280, 900, "#blocked"],
  ["desktop-zoom", 1280, 900, "#zoom"],
  ["desktop-queue", 1280, 900, "#queue"],
  ["narrow-library", 412, 915, ""],
  ["narrow-finder", 412, 915, "#finder"],
  ["narrow-results", 412, 915, "#results"],
  ["narrow-judge", 412, 915, "#judge"],
  ["narrow-eight", 412, 915, "#eight"],
  ["narrow-empty", 412, 915, "#empty"],
  ["narrow-scale", 412, 915, "#scale"],
  ["narrow-blocked", 412, 915, "#blocked"],
  ["narrow-zoom", 412, 915, "#zoom"]
];

for (const [name, width, height, hash] of views) {
  const page = await open(width, height, hash);
  await shot(page, `${name}.png`);
  await measure(page, name);
  if (["desktop-results", "desktop-finder", "desktop-eight", "narrow-results", "desktop-zoom", "narrow-judge"].includes(name)) {
    await axe(page, name);
  }
  await page.context().close();
}

await writeFile(path.join(shots, "report.json"), JSON.stringify(report, null, 2));
await browser.close();
console.log(JSON.stringify(report, null, 2));
