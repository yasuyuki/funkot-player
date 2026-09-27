import { test, expect } from "@playwright/test";

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
