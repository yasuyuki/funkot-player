import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

async function openEdit(page) {
  await page.goto("/tests/ui/");
  await expect(page.locator(".library li.row")).toHaveCount(6, { timeout: 15000 });
  await page.getByRole("tab", { name: "Go to edit mode" }).click();
}

function allTracksTarget(page, project, title) {
  const all = page.locator(".wrap");
  return project === "narrow"
    ? all.locator(".card").filter({ hasText: title })
    : all.locator("tbody tr").filter({ hasText: title });
}

test("rejected label write shows the durable library snapshot without Undo", async ({ page }, testInfo) => {
  await openEdit(page);
  await page.getByRole("tab", { name: "All tracks", exact: true }).click();
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const before = store.libraryList.map((row, index) => index === 0
      ? { ...row, label: true, is_funkot: true }
      : row);
    const durable = before.map((row, index) => index === 0
      ? { ...row, label: false, is_funkot: true }
      : row);
    store.library = new Map(before.map(row => [row.path, row]));
    window.__uiFixture.setReply("refresh_library", { rows: durable, persistence_error: null });
    window.__uiFixture.failNext("set_label", "synthetic label rejection");
  });
  const target = allTracksTarget(page, testInfo.project.name, "Pulse");
  const label = testInfo.project.name === "narrow"
    ? target.getByRole("button", { name: "Edit track" })
    : target.locator(".label-btn");
  if (testInfo.project.name === "narrow") {
    await label.click();
    await target.locator(".card-editor button").first().click();
  } else {
    await label.click();
  }
  if (testInfo.project.name === "narrow") {
    await expect(target.locator(".card-values")).toContainText("Non-Funkot");
  } else {
    await expect(target.locator(".label-btn")).toHaveText("Non-Funkot");
  }
  await expect.poll(() => page.evaluate(async () => (await import("/src/lib/state.svelte.ts")).store.lastError)).toContain("synthetic label rejection");
  const write = await page.evaluate(() => window.__uiFixture.calls.filter(call => call.command === "set_label").at(-1).args);
  expect(write).toMatchObject({ path: "/fixture/music/track-1.mp3", verdict: false });
  expect(await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const row = store.trackForPath("/fixture/music/track-1.mp3");
    return { label: row?.label, isFunkot: row?.is_funkot };
  })).toEqual({ label: false, isFunkot: true });
  expect(await page.evaluate(() => window.__uiFixture.calls.filter(call => call.command === "refresh_library").at(-1).args)).toEqual({ kickAnalysis: false });
  await expect(page.locator(".toast .message")).toHaveText("synthetic label rejection");
  await expect(page.locator(".toast .undo")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("label-rejection-viewport.png"), fullPage: false });
});

test("rejected folder label clears Undo and shows the durable library snapshot", async ({ page }, testInfo) => {
  await openEdit(page);
  await page.getByRole("tab", { name: "All tracks", exact: true }).click();
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const before = store.libraryList.map((row, index) => ({
      ...row, path: `/fixture/music/folder/track-${index + 1}.mp3`, label: true, is_funkot: true,
    }));
    const durable = before.map(row => ({ ...row, label: false, is_funkot: true }));
    store.library = new Map(before.map(row => [row.path, row]));
    window.__uiFixture.setReply("refresh_library", { rows: durable, persistence_error: null });
    window.__uiFixture.failNext("set_folder_label", "synthetic folder rejection");
  });
  const all = page.locator(".wrap");
  const folder = testInfo.project.name === "narrow"
    ? all.locator("details[aria-label='Folder actions']")
    : all.locator(".folder-row").filter({ hasText: "folder" });
  if (testInfo.project.name === "narrow") await folder.locator("summary").click();
  await folder.getByRole("button", { name: "Non-Funkot" }).click();
  const target = allTracksTarget(page, testInfo.project.name, "Pulse");
  if (testInfo.project.name === "narrow") {
    await expect(target.locator(".card-values")).toContainText("Non-Funkot");
  } else {
    await expect(target.locator(".label-btn")).toHaveText("Non-Funkot");
  }
  await expect.poll(() => page.evaluate(async () => (await import("/src/lib/state.svelte.ts")).store.lastError)).toContain("synthetic folder rejection");
  const write = await page.evaluate(() => window.__uiFixture.calls.filter(call => call.command === "set_folder_label").at(-1).args);
  expect(write).toMatchObject({ dir: "/fixture/music/folder", verdict: false });
  expect(await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    return store.libraryList.map(row => ({ label: row.label, isFunkot: row.is_funkot }));
  })).toEqual(Array.from({ length: 6 }, () => ({ label: false, isFunkot: true })));
  expect(await page.evaluate(() => window.__uiFixture.calls.filter(call => call.command === "refresh_library").at(-1).args)).toEqual({ kickAnalysis: false });
  expect(await page.evaluate(async () => (await import("/src/lib/state.svelte.ts")).store.doUndoLastFolderLabel())).toBe(false);
  expect(await page.evaluate(() => window.__uiFixture.calls.filter(call => call.command === "undo_last_folder_label"))).toEqual([]);
  await expect(page.locator(".toast .message")).toHaveText("synthetic folder rejection");
  await expect(page.locator(".toast .undo")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("folder-label-rejection-viewport.png"), fullPage: false });
});

test("rejected bars write shows the durable library snapshot without Undo", async ({ page }, testInfo) => {
  await openEdit(page);
  await page.getByRole("tab", { name: "All tracks", exact: true }).click();
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const rows = store.libraryList.map((row, index) => index === 1
      ? { ...row, intro_bars: 64, intro_manual: true }
      : row);
    window.__uiFixture.setReply("refresh_library", { rows, persistence_error: null });
    window.__uiFixture.failNext("set_bars", "synthetic bars rejection");
  });
  const target = allTracksTarget(page, testInfo.project.name, "Midnight on the coast");
  const opener = testInfo.project.name === "narrow"
    ? target.getByRole("button", { name: "Edit track" })
    : target.locator(".bars").first();
  await opener.click();
  const chips = page.locator(".chip-editor:visible").first();
  await chips.getByRole("button", { name: "64", exact: true }).click();
  await expect(chips.getByRole("button", { name: "64*", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await import("/src/lib/state.svelte.ts")).store.lastError)).toContain("synthetic bars rejection");
  const write = await page.evaluate(() => window.__uiFixture.calls.filter(call => call.command === "set_bars").at(-1).args);
  expect(write).toMatchObject({ path: "/fixture/music/track-2.mp3", introBars: 64 });
  expect(await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const row = store.trackForPath("/fixture/music/track-2.mp3");
    return { introBars: row?.intro_bars, introManual: row?.intro_manual };
  })).toEqual({ introBars: 64, introManual: true });
  expect(await page.evaluate(() => window.__uiFixture.calls.filter(call => call.command === "refresh_library").at(-1).args)).toEqual({ kickAnalysis: false });
  await expect(page.locator(".toast .message")).toHaveText("synthetic bars rejection");
  await expect(page.locator(".toast .undo")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("bars-rejection-viewport.png"), fullPage: false });
});

test("rejected label keeps its mutation error when reconciliation fails", async ({ page }, testInfo) => {
  await openEdit(page);
  await page.getByRole("tab", { name: "All tracks", exact: true }).click();
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const rows = store.libraryList.map((row, index) => index === 0
      ? { ...row, label: true, is_funkot: true }
      : row);
    store.library = new Map(rows.map(row => [row.path, row]));
    window.__uiFixture.failNext("set_label", "synthetic label rejection");
    window.__uiFixture.failNext("refresh_library", "synthetic refresh rejection");
  });
  const target = allTracksTarget(page, testInfo.project.name, "Pulse");
  if (testInfo.project.name === "narrow") {
    await target.getByRole("button", { name: "Edit track" }).click();
    await target.locator(".card-editor button").first().click();
  } else {
    await target.locator(".label-btn").click();
  }
  await expect.poll(() => page.evaluate(async () => (await import("/src/lib/state.svelte.ts")).store.lastError)).toBe("synthetic label rejection");
  expect(await page.evaluate(() => window.__uiFixture.calls.filter(call => call.command === "refresh_library").at(-1).args)).toEqual({ kickAnalysis: false });
  await expect(page.locator(".toast .message")).toHaveText("synthetic label rejection");
  await expect(page.locator(".toast .undo")).toHaveCount(0);
});

test("rejected label reconciles after a busy refresh fails", async ({ page }, testInfo) => {
  await openEdit(page);
  await page.getByRole("tab", { name: "All tracks", exact: true }).click();
  const setup = await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const before = store.libraryList.map((row, index) => index === 0
      ? { ...row, label: true, is_funkot: true }
      : row);
    const durable = before.map((row, index) => index === 0
      ? { ...row, label: false, is_funkot: true }
      : row);
    store.library = new Map(before.map(row => [row.path, row]));
    window.__uiFixture.setReply("refresh_library", { rows: durable, persistence_error: null });
    const refreshes = window.__uiFixture.calls.filter(call => call.command === "refresh_library").length;
    window.__uiFixture.delayNext("refresh_library");
    void store.doRefreshLibrary();
    window.__uiFixture.failNext("set_label", "synthetic label rejection");
    return { refreshes };
  });
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter(call => call.command === "refresh_library").length)).toBe(setup.refreshes + 1);
  const target = allTracksTarget(page, testInfo.project.name, "Pulse");
  if (testInfo.project.name === "narrow") {
    await target.getByRole("button", { name: "Edit track" }).click();
    await target.locator(".card-editor button").first().click();
  } else {
    await target.locator(".label-btn").click();
  }
  await page.evaluate(() => window.__uiFixture.reject("refresh_library", "synthetic overlapping refresh failure"));
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter(call => call.command === "refresh_library").length)).toBe(setup.refreshes + 2);
  expect(await page.evaluate((refreshes) => window.__uiFixture.calls.filter(call => call.command === "refresh_library").slice(refreshes).map(call => call.args), setup.refreshes)).toEqual([
    { kickAnalysis: true },
    { kickAnalysis: false },
  ]);
  await expect.poll(() => page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const row = store.trackForPath("/fixture/music/track-1.mp3");
    return { label: row?.label, isFunkot: row?.is_funkot, error: store.lastError };
  })).toEqual({ label: false, isFunkot: true, error: "synthetic label rejection" });
  await expect(page.locator(".toast .message")).toHaveText("synthetic label rejection");
  await expect(page.locator(".toast .undo")).toHaveCount(0);
});

test("failed busy reconciliation is bounded and keeps its mutation error", async ({ page }) => {
  await openEdit(page);
  const setup = await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const rows = store.libraryList.map((row, index) => index === 0
      ? { ...row, label: true, is_funkot: true }
      : row);
    store.library = new Map(rows.map(row => [row.path, row]));
    const refreshes = window.__uiFixture.calls.filter(call => call.command === "refresh_library").length;
    window.__uiFixture.delayNext("refresh_library");
    void store.doRefreshLibrary();
    window.__uiFixture.failNext("set_label", "synthetic label rejection");
    return { refreshes };
  });
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter(call => call.command === "refresh_library").length)).toBe(setup.refreshes + 1);
  expect(await page.evaluate(async () => (await import("/src/lib/state.svelte.ts")).store.doSetLabel("/fixture/music/track-1.mp3", false))).toBeNull();
  await page.evaluate(() => {
    window.__uiFixture.failNext("refresh_library", "synthetic quiet refresh failure");
    window.__uiFixture.reject("refresh_library", "synthetic overlapping refresh failure");
  });
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter(call => call.command === "refresh_library").length)).toBe(setup.refreshes + 2);
  expect(await page.evaluate((refreshes) => window.__uiFixture.calls.filter(call => call.command === "refresh_library").slice(refreshes).map(call => call.args), setup.refreshes)).toEqual([
    { kickAnalysis: true },
    { kickAnalysis: false },
  ]);
  await expect.poll(() => page.evaluate(async () => (await import("/src/lib/state.svelte.ts")).store.lastError)).toBe("synthetic label rejection");
  await expect(page.locator(".toast .message")).toHaveText("synthetic label rejection");
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__uiFixture.calls.filter(call => call.command === "refresh_library").length)).toBe(setup.refreshes + 2);
});

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
    window.__uiFixture.setReply("refresh_library", { rows, persistence_error: null });
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

test("rejected flagged bars write shows the durable bars without Undo", async ({ page }, testInfo) => {
  await openEdit(page);
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const rows = store.libraryList.map((row, index) => index === 0
      ? { ...row, outro_structure_bars: 64, outro_manual: true }
      : row);
    window.__uiFixture.setReply("refresh_library", { rows, persistence_error: null });
    window.__uiFixture.failNext("set_bars", "synthetic flagged bars rejection");
  });
  await page.locator(".list .row").filter({ hasText: "Pulse" }).getByRole("button").first().click();
  const chips = page.locator(".chip-editor:visible").first();
  await chips.getByRole("button", { name: "64", exact: true }).click();
  await expect(chips.getByRole("button", { name: "64*", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await import("/src/lib/state.svelte.ts")).store.lastError)).toBe("synthetic flagged bars rejection");
  expect(await page.evaluate(() => window.__uiFixture.calls.filter(call => call.command === "set_bars").at(-1).args)).toMatchObject({
    path: "/fixture/music/track-1.mp3", outroStructureBars: 64,
  });
  await expect(page.locator(".toast .message")).toHaveText("synthetic flagged bars rejection");
  await expect(page.locator(".toast .undo")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("flagged-bars-rejection-viewport.png"), fullPage: false });
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
