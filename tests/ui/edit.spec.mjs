import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

async function openEdit(page) {
  await page.goto("/tests/ui/");
  await expect(page.locator(".library li.row")).toHaveCount(6, { timeout: 15000 });
  await page.getByRole("tab", { name: "Go to edit mode" }).click();
}

test("all-tracks retains its target, applies bars and Undo, and returns focus", async ({ page }, testInfo) => {
  await openEdit(page);
  await page.getByRole("tab", { name: "All tracks" }).click();
  const all = page.locator(".wrap");
  const target = testInfo.project.name === "narrow"
    ? all.locator(".card").filter({ hasText: "Midnight on the coast" })
    : all.locator("tbody tr").filter({ hasText: "Midnight on the coast" });
  const opener = testInfo.project.name === "narrow"
    ? target.getByRole("button", { name: "Edit track" })
    : target.locator(".bars").first();
  await opener.click();
  const chips = all.locator(".chip-editor:visible").first();
  await chips.getByRole("button", { name: "48", exact: true }).click();
  await expect(chips.getByRole("button", { name: "48*", exact: true })).toBeVisible();
  const write = await page.evaluate(() => window.__uiFixture.calls.filter(call => call.command === "set_bars").at(-1).args);
  expect(write).toMatchObject({ path: "/fixture/music/track-2.mp3", introBars: 48 });
  await page.locator(".toast button").click();
  await expect(chips.getByRole("button", { name: "32", exact: true })).toHaveClass(/current/);
  const undo = await page.evaluate(() => window.__uiFixture.calls.filter(call => call.command === "set_bars").at(-1).args);
  expect(undo).toMatchObject({ path: "/fixture/music/track-2.mp3", introBars: 32, markManual: false });
  await page.evaluate(() => window.__uiFixture.failNext("set_bars", "synthetic persistence failure"));
  await chips.getByRole("button", { name: "64", exact: true }).click();
  await expect(chips.getByRole("button", { name: "32", exact: true })).toHaveClass(/current/);
  await expect.poll(() => page.evaluate(async () => (await import("/src/lib/state.svelte.ts")).store.lastError)).toContain("synthetic");
  await page.screenshot({ path: testInfo.outputPath("all-tracks-edit-viewport.png"), fullPage: false });
  if (testInfo.project.name === "narrow") {
    await page.keyboard.press("Escape");
    await expect(opener).toBeFocused();
    await expect(target.locator(".card-editor")).toHaveCount(0);
    await expect(opener).toBeInViewport();
  }
});

test("all-tracks compares duplicate names and continues editing without losing the target", async ({ page }, testInfo) => {
  await openEdit(page);
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const rows = Array.from({ length: 24 }, (_, i) => ({ ...store.libraryList[i % 6],
      path: `/fixture/music/track-${i + 1}.mp3`, content_hash: String(i + 1).padStart(64, "0") }));
    store.library = new Map(rows.map(row => [row.path, row]));
    window.__uiFixture.setReply("refresh_library", rows);
  });
  await page.getByRole("tab", { name: "All tracks", exact: true }).click();
  const narrow = testInfo.project.name === "narrow";
  const rows = page.locator(narrow ? ".cards .card" : ".table tbody tr:not(.folder-row):not(.chip-row)");
  await expect(rows).toHaveCount(24);
  const first = rows.filter({ has: page.locator(".path", { hasText: /^track-1\.mp3$/ }) });
  const duplicate = rows.filter({ has: page.locator(".path", { hasText: /^track-7\.mp3$/ }) });
  await expect(first.locator("strong")).toHaveText("Pulse");
  await expect(duplicate.locator("strong")).toHaveText("Pulse");
  const observations = [];
  for (const number of [7, 8]) {
    const row = rows.filter({ has: page.locator(".path", { hasText: new RegExp(`^track-${number}\\.mp3$`) }) });
    const opener = narrow ? row.getByRole("button", { name: "Edit track" }) : row.locator(".bars").first();
    const before = { scrollY: await page.evaluate(() => scrollY), opener: await opener.boundingBox() };
    await opener.click();
    const editingScrollY = await page.evaluate(() => scrollY);
    const chips = page.locator(".chip-editor:visible").first();
    await chips.getByRole("button", { name: "48", exact: true }).click();
    await chips.getByRole("button", { name: "64", exact: true }).click();
    await expect(chips.getByRole("button", { name: "64*", exact: true })).toHaveClass(/current/);
    const writes = await page.evaluate(() => window.__uiFixture.calls.filter(call => call.command === "set_bars").slice(-2).map(call => call.args));
    expect(writes).toEqual([
      expect.objectContaining({ path: `/fixture/music/track-${number}.mp3`, introBars: 48 }),
      expect.objectContaining({ path: `/fixture/music/track-${number}.mp3`, introBars: 64 }),
    ]);
    await page.keyboard.press("Escape");
    await expect(page.locator(".chip-editor:visible")).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(opener).toBeInViewport({ ratio: 1 });
    await expect(row).toContainText("64*");
    observations.push({ track: number, before, editingScrollY, returnedScrollY: await page.evaluate(() => scrollY), returnedOpener: await opener.boundingBox() });
  }
  await expect(first).not.toContainText("64*");
  const metricsPath = testInfo.outputPath("continued-edit-metrics.json");
  await writeFile(metricsPath, JSON.stringify(observations, null, 2) + "\n");
  await testInfo.attach("continued-edit-metrics", { path: metricsPath, contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("all-tracks-continued-edit.png"), fullPage: false });
  await page.evaluate(async () => {
    (await import("/src/lib/i18n.svelte.ts")).i18n.setLocale("ja");
    document.documentElement.style.fontSize = "200%";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await rows.nth(7).scrollIntoViewIfNeeded();
  const clipped = await rows.locator("strong, .artist, .path").evaluateAll(elements =>
    elements.filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent));
  expect(clipped).toEqual([]);
  const enlargedOpener = rows.nth(7).locator(narrow ? ".card-status button" : ".bars").first();
  await enlargedOpener.click();
  await page.locator(".chip-editor:visible button").first().click({ trial: true });
  await page.keyboard.press("Escape");
  await expect(enlargedOpener).toBeFocused();
  await expect(enlargedOpener).toBeInViewport({ ratio: 1 });
  await enlargedOpener.click({ trial: true });
  await page.screenshot({ path: testInfo.outputPath("all-tracks-enlarged.png"), fullPage: false });
});

test("flagged detail selects one partner and distinguishes back, cancel, and confirm", async ({ page }, testInfo) => {
  await openEdit(page);
  const row = page.locator(".list .row").filter({ hasText: "Pulse" });
  await row.getByRole("button").first().click();
  await expect(page.getByText("Outgoing · 3×")).toBeVisible();
  await page.getByRole("combobox", { name: "Transition partner" }).selectOption("partner-dawn");
  const listen = page.getByRole("button", { name: /Listen to the transition into “Dawn”/ });
  await listen.click();
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "audition_transition").length)).toBe(1);
  await page.getByRole("button", { name: "48" }).click();
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "set_bars").length)).toBe(1);
  await expect(page.getByRole("button", { name: "〔Cancel〕" })).toBeEnabled();
  await page.getByRole("button", { name: "〔Cancel〕" }).click();
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "set_bars").length)).toBe(2);
  const cancelWrite = await page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "set_bars").at(-1).args);
  expect(cancelWrite).toMatchObject({ path: "/fixture/music/track-1.mp3", outroStructureBars: 32, markManual: false });

  await expect(page.locator(".list")).toBeVisible();
  await row.getByRole("button").first().click();
  await page.getByRole("button", { name: "48" }).click();
  await expect(page.getByRole("button", { name: "48*", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "← Back to list" }).click();
  await expect(page.locator(".list")).toBeVisible();
  await row.getByRole("button").first().click();
  await expect(page.getByRole("button", { name: "48*", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "〔Confirm〕" })).toBeEnabled();
  await page.getByRole("button", { name: "〔Confirm〕" }).click();
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "dismiss_flags").length)).toBe(1);
  await expect(page.locator(".list")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("flagged-list-viewport.png"), fullPage: false });
});

test("cancel without a local edit preserves a refreshed value", async ({ page }) => {
  await openEdit(page);
  await page.locator(".list .row").filter({ hasText: "Pulse" }).getByRole("button").first().click();
  await expect(page.getByRole("button", { name: "32", exact: true })).toHaveClass(/current/);
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.flaggedRows = store.flaggedRows.map(row => row.path === "/fixture/music/track-1.mp3"
      ? { ...row, outro_structure_bars: 64, outro_manual: true } : row);
    window.__uiFixture.setReply("list_flagged_tracks", store.flaggedRows);
  });
  await expect(page.getByRole("button", { name: "64*", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "〔Cancel〕" }).click();
  await expect(page.locator(".list")).toBeVisible();
  expect(await page.evaluate(() => window.__uiFixture.calls.filter(call => call.command === "set_bars"))).toEqual([]);
});
