import { test, expect } from "@playwright/test";

test("a scan persistence warning keeps readable tracks visible and leaves a retry available", async ({ page }, testInfo) => {
  await page.goto("/tests/ui/");
  await expect(page.locator("section.library li.row")).toHaveCount(6);
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const rows = [{ ...store.libraryList[0], path: "/synthetic/readable.wav", title: "Readable after failed save", added_order: null }];
    window.__uiFixture.setReply("refresh_library", { rows, persistence_error: "cannot save hash-index.json: synthetic write failure" });
  });
  await page.getByRole("button", { name: "menu", exact: true }).click();
  await page.getByRole("button", { name: "Rescan", exact: true }).click();
  await expect(page.locator("section.library li.row")).toHaveCount(1);
  await expect(page.locator("section.library")).toContainText("Readable after failed save");
  expect(await page.evaluate(async () => (await import("/src/lib/state.svelte.ts")).store.lastError))
    .toContain("synthetic write failure");
  await page.getByRole("button", { name: "menu", exact: true }).click();
  await page.locator(".overflow > .menu").getByRole("button", { name: "Show log", exact: true }).click();
  await expect(page.locator(".error")).toContainText("synthetic write failure");
  const path = testInfo.outputPath("readable-library-with-save-warning.png");
  await page.screenshot({ path });
  await testInfo.attach("save-warning", { path, contentType: "image/png" });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    window.__uiFixture.setReply("refresh_library", { rows: store.libraryList, persistence_error: null });
  });
  await page.getByRole("button", { name: "menu", exact: true }).click();
  await page.getByRole("button", { name: "Rescan", exact: true }).click();
  await expect(page.locator("section.library li.row")).toHaveCount(1);
  expect(await page.evaluate(async () => (await import("/src/lib/state.svelte.ts")).store.lastError))
    .toBeNull();
});
