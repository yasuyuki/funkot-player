import { test, expect } from "@playwright/test";

// Tauri on Android draws edge-to-edge: the status bar and the navigation bar
// cover the page, and a touch on them goes to the system. Chromium reports
// those bars as safe-area insets, which the override below stands in for.
const INSETS = { top: 48, bottom: 40, left: 0, right: 0 };

test.beforeEach(async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: INSETS });
  await page.goto("/tests/ui/");
  await expect(page.locator(".library li.row")).toHaveCount(6, { timeout: 15000 });
});

async function expectInsideSafeArea(page, locator) {
  const box = await locator.boundingBox();
  const { height } = page.viewportSize();
  expect(box.y).toBeGreaterThanOrEqual(INSETS.top);
  expect(box.y + box.height).toBeLessThanOrEqual(height - INSETS.bottom);
}

// A control is usable only when a press at its centre reaches it.
async function expectPressable(locator) {
  expect(await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBe(true);
}

test("the playlist picker stays below the status bar and above the navigation bar", async ({ page }, testInfo) => {
  const pickerHost = testInfo.project.name === "narrow" ? page.locator("section.library") : page.locator("section.queue");
  if (testInfo.project.name === "narrow") await page.getByRole("tab", { name: "Library" }).click();
  await pickerHost.locator(".source .choose").click();
  const picker = page.getByRole("dialog", { name: "Choose what plays next" });
  await expect(picker).toBeVisible();
  await expectInsideSafeArea(page, picker);
  for (const control of [
    picker.getByRole("button", { name: "Close" }),
    picker.getByRole("textbox", { name: "Search playlists" }),
  ]) {
    await expect(control).toBeInViewport();
    await expectPressable(control);
    expect((await control.boundingBox()).y).toBeGreaterThanOrEqual(INSETS.top);
  }
  await page.screenshot({ path: testInfo.outputPath("playlist-picker-with-insets.png") });
});

test("a modal dialog is centred inside the safe area", async ({ page }, testInfo) => {
  if (testInfo.project.name === "narrow") await page.getByRole("tab", { name: "Up next" }).click();
  const queue = page.locator("section.queue");
  await queue.locator(".source .choose").click();
  await queue.getByRole("button", { name: "Browse Empty list" }).click();
  await queue.getByRole("button", { name: "Playlist actions" }).click();
  await queue.getByRole("button", { name: "Rename" }).click();
  const dialog = queue.getByRole("dialog", { name: "Rename" });
  await expect(dialog).toBeVisible();
  // Content taller than the screen: the dialog keeps to the safe area and scrolls inside.
  await dialog.evaluate((element) => element.prepend(Object.assign(document.createElement("div"), { style: "height: 3000px" })));
  await expectInsideSafeArea(page, dialog);
  expect(await dialog.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
});

test("the track menu opened near the top edge stays below the status bar", async ({ page }, testInfo) => {
  if (testInfo.project.name === "narrow") await page.getByRole("tab", { name: "Library" }).click();
  const row = page.locator("section.library li.row").first();
  const box = await row.boundingBox();
  await page.evaluate(({ x }) => {
    const row = document.querySelector("section.library li.row");
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: 2 }));
  }, { x: box.x + 20 });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expectInsideSafeArea(page, menu);
});
