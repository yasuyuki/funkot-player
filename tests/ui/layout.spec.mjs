import { test, expect } from "@playwright/test";

async function controlIssues(page, scope = "body") {
  return page.locator(scope).evaluate(root => {
    const css = getComputedStyle(document.documentElement);
    const font = parseFloat(css.fontSize) * parseFloat(css.getPropertyValue("--font-size-md"));
    return [...root.querySelectorAll('button, input:not([type="checkbox"]):not([type="radio"]), select')]
      .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden")
      .flatMap(el => {
        const s = getComputedStyle(el), b = el.getBoundingClientRect();
        const failures = [];
        if (Math.abs(parseFloat(s.fontSize) - font) > 0.01) failures.push(`font=${s.fontSize}`);
        if (Math.abs(parseFloat(s.lineHeight) - font * 1.5) > 0.01) failures.push(`line=${s.lineHeight}`);
        if (b.height < 44 || b.width < 44) failures.push(`target=${b.width}x${b.height}`);
        return failures.length ? [{ control: el.getAttribute("aria-label") || el.textContent.trim(), failures }] : [];
      });
  });
}

async function capture(page, testInfo, name) {
  await page.mouse.move(0, 0);
  const path = testInfo.outputPath(`${name}.jpg`);
  await page.screenshot({ path, quality: 75, animations: "disabled", caret: "hide" });
  await testInfo.attach(name, { path, contentType: "image/jpeg" });
}

test("shared controls, dense browsing, history and playback retain readable targets", async ({ page }, testInfo) => {
  await page.goto("/tests/ui/");
  await expect(page.locator("section.library li.row")).toHaveCount(6);
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const rows = Array.from({ length: 24 }, (_, i) => ({ ...store.libraryList[i % 6], path: `/fixture/music/dense-${i}.mp3`, content_hash: String(i).padStart(64, "0") }));
    store.library = new Map(rows.map(row => [row.path, row]));
    window.__uiFixture.setReply("refresh_library", rows);
    store.playHistory = { log: [], log_total: 0, tracks: rows.map((row, i) => ({ ...row, track_hash: row.content_hash, count: i + 1, last_played_ms: 1767225600000, missing: false })) };
    window.__uiFixture.setReply("list_play_history", store.playHistory);
    store.player = { ...store.player, phase: "playing", now_playing: rows[1].path, duration_secs: 257, position_secs: 60 };
    window.__uiFixture.setReply("player_state", store.player);
  });
  await expect(page.locator("section.library li.row")).toHaveCount(24);
  expect(await controlIssues(page)).toEqual([]);
  await capture(page, testInfo, "dense-library");
  // A local size regression must actually fail the same computed-style check.
  const add = page.locator("section.library .add").first();
  await add.evaluate(el => el.style.fontSize = "30px");
  expect((await controlIssues(page)).some(issue => issue.failures.includes("font=30px"))).toBe(true);
  await add.evaluate(el => el.style.removeProperty("font-size"));

  if (testInfo.project.name === "narrow") await page.getByRole("tab", { name: "History", exact: true }).click();
  await expect(page.locator("section.history li.row")).toHaveCount(24);
  expect(await controlIssues(page)).toEqual([]);
  await capture(page, testInfo, "dense-history");
  await page.locator("section.history li.row").last().scrollIntoViewIfNeeded();
  await expect(page.locator(".minibar")).toBeInViewport();
  for (const button of await page.locator(".minibar button").all()) {
    await expect(button).toBeInViewport({ ratio: 1 });
    await button.click({ trial: true });
  }
  expect(await controlIssues(page, ".minibar")).toEqual([]);
  await capture(page, testInfo, "playing-minibar");
  await page.evaluate(() => document.documentElement.style.fontSize = "200%");
  expect(await controlIssues(page, ".minibar")).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capture(page, testInfo, "text-enlarged");
  await page.evaluate(() => document.documentElement.style.removeProperty("font-size"));

  if (testInfo.project.name === "narrow") await page.getByRole("tab", { name: "Up next", exact: true }).click();
  const queue = page.locator("section.queue");
  await expect(queue).toBeVisible();
  const footer = queue.locator(".edit-footer");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: 0 } });
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--playback-dock-height", "0px");
    document.documentElement.style.setProperty("--toast-height", "0px");
  });
  await queue.getByRole("button", { name: "Select Pulse", exact: true }).first().click();
  await expect(footer).toBeVisible();
  await expect.poll(() => footer.evaluate(element => getComputedStyle(element).bottom)).toBe("0px");
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: 34 } });
  await expect.poll(() => footer.evaluate(element => getComputedStyle(element).bottom)).toBe("34px");
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--playback-dock-height", "90px");
    document.documentElement.style.setProperty("--toast-height", "50px");
  });
  await expect.poll(() => footer.evaluate(element => getComputedStyle(element).bottom)).toBe("140px");
  expect(await controlIssues(page, "section.queue .edit-footer")).toEqual([]);
  await capture(page, testInfo, "queue-footer-safe-area");
  await cdp.detach();
});

test("ja/en/id browsing and tag controls stay reachable with a short viewport", async ({ page }, testInfo) => {
  await page.goto("/tests/ui/");
  await expect(page.locator("section.library li.row")).toHaveCount(6);
  for (const locale of ["ja", "en", "id"]) {
    await page.evaluate(async locale => (await import("/src/lib/i18n.svelte.ts")).i18n.setLocale(locale), locale);
    expect(await controlIssues(page)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capture(page, testInfo, `browse-${locale}`);
  }
  await page.evaluate(async () => (await import("/src/lib/i18n.svelte.ts")).i18n.setLocale("en"));
  const library = page.locator("section.library");
  await library.getByRole("button", { name: "Tags", exact: true }).click();
  expect(await controlIssues(page, "section.library")).toEqual([]);
  await capture(page, testInfo, "tag-filter-controls");
  await library.getByRole("button", { name: "Tags", exact: true }).click();
  await library.getByRole("button", { name: "Select several tracks" }).click();
  await library.getByLabel("Select Pulse", { exact: true }).check();
  await library.getByRole("button", { name: "Edit visible selected (1)" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Edit tags: Pulse", exact: true })).toBeVisible();
  await capture(page, testInfo, "tag-editor-selected-single");
  expect(await controlIssues(page, "dialog")).toEqual([]);
  await page.setViewportSize({ width: testInfo.project.use.viewport.width, height: 400 });
  const value = dialog.getByLabel("Tag", { exact: true });
  await value.fill("Keep this draft after failure");
  await value.scrollIntoViewIfNeeded();
  await expect(value).toBeInViewport({ ratio: 1 });
  await value.click({ trial: true });
  await page.evaluate(() => {
    window.__uiFixture.setReply("update_track_tags", null);
    window.__uiFixture.failNext("update_track_tags", { code: "persist_failed", message: "synthetic failure" });
  });
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeInViewport({ ratio: 1 });
  await save.click();
  await expect(value).toHaveValue("Keep this draft after failure");
  await expect(dialog.getByRole("alert")).toContainText("save");
  await expect(save).toBeInViewport({ ratio: 1 });
  await value.scrollIntoViewIfNeeded();
  await expect(value).toBeInViewport({ ratio: 1 });
  await value.click({ trial: true });
  const payload = await page.evaluate(() => window.__uiFixture.calls.find(call => call.command === "update_track_tags").args.request);
  expect(payload.targets).toEqual([{ path: "/fixture/music/track-1.mp3", expected_hash: "1".repeat(64) }]);
  expect(payload.patch.add).toContainEqual({ kind: "genre", value: "Keep this draft after failure" });
  await capture(page, testInfo, "tag-failed-short-viewport");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(library.getByRole("button", { name: "Edit visible selected (1)" })).toBeFocused();
});

test("two-column boundary and overflow menu preserve controls and focus", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One representative two-column boundary");
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/tests/ui/");
  await expect(page.locator("section.library li.row")).toHaveCount(6);
  const columns = await page.locator(".panes").evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" "));
  expect(columns).toHaveLength(2);
  expect(await controlIssues(page)).toEqual([]);
  await capture(page, testInfo, "browse-1024");
  const menu = page.getByRole("button", { name: "menu", exact: true });
  await menu.click();
  expect(await controlIssues(page, ".overflow")).toEqual([]);
  await page.locator(".overflow .menu button").last().scrollIntoViewIfNeeded();
  await page.locator(".overflow .menu button").last().click({ trial: true });
  await capture(page, testInfo, "menu-1024");
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
});

test("editor controls preserve shared geometry with translated and enlarged labels", async ({ page }, testInfo) => {
  await page.goto("/tests/ui/");
  await expect(page.locator("section.library li.row")).toHaveCount(6);
  await page.getByRole("tab", { name: "Go to edit mode" }).click();
  await page.getByRole("tab", { name: "All tracks", exact: true }).click();
  expect(await controlIssues(page, ".wrap")).toEqual([]);
  await page.getByRole("tab", { name: "Transitions to fix" }).click();
  await page.locator(".list .row").filter({ hasText: "Pulse" }).getByRole("button").first().click();
  await page.getByRole("combobox").selectOption("partner-missing");
  await expect(page.locator(".selected-partner button")).toBeDisabled();
  await page.getByRole("combobox").selectOption("partner-long");
  for (const locale of ["ja", "id"]) {
    await page.evaluate(async locale => (await import("/src/lib/i18n.svelte.ts")).i18n.setLocale(locale), locale);
    expect(await controlIssues(page)).toEqual([]);
    await capture(page, testInfo, `flagged-${locale}`);
  }
  await page.evaluate(() => document.documentElement.style.fontSize = "200%");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await controlIssues(page)).toEqual([]);
  await page.locator(".chip-editor button").first().click({ trial: true });
  await page.locator(".actions button").last().click({ trial: true });
  await capture(page, testInfo, "flagged-enlarged");
});
