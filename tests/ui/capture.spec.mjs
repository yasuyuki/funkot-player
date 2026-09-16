import { test, expect } from "@playwright/test";

test("Library and tag review states", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.clock.setFixedTime(new Date("2026-01-01T00:00:00Z"));
  await page.goto("/tests/ui/");
  const library = page.locator(".library");
  await expect(library.locator("li.row")).toHaveCount(6);
  await expect(library.getByRole("button", { name: "View 1 more tags" })).toHaveCount(2);
  await page.evaluate(() => document.fonts.ready);

  async function capture(name) {
    await page.mouse.move(0, 0);
    await page.evaluate(() => window.scrollTo(0, 0));
    const path = testInfo.outputPath(`${testInfo.project.name}-${name}.jpg`);
    await page.screenshot({ path, quality: 70, fullPage: true, animations: "disabled", caret: "hide" });
    await testInfo.attach(name, { path, contentType: "image/jpeg" });
  }
  await capture("library");
  await library.getByText("Filter by tags", { exact: true }).click();
  await library.getByLabel("Tag candidate", { exact: true }).selectOption("genre:funkot");
  await library.getByRole("button", { name: "Add condition", exact: true }).click();
  await expect(library.locator("li.row")).toHaveCount(5);
  await capture("tag-filter");
  await library.getByRole("button", { name: "Clear tag conditions", exact: true }).click();
  await library.getByText("Filter by tags", { exact: true }).click();
  await library.getByRole("button", { name: "View 1 more tags" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await capture("tag-editor");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});
