import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";

const dir = "proposals/library-ui-cursor";

async function shot(page, name) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${dir}/${name}.png`, animations: "disabled", caret: "hide" });
}

test("library proposal keeps find, add, and row actions usable", async ({ page }, testInfo) => {
  await mkdir(dir, { recursive: true });
  const project = testInfo.project.name;
  await page.goto("/tests/ui/");
  const library = page.locator("section.library");
  await expect(library.locator("li.row")).toHaveCount(6, { timeout: 15000 });
  await expect(page.getByLabel("Sort the library")).toBeVisible();
  await expect(page.getByLabel("Search the library")).toBeVisible();
  if (project === "narrow") {
    await expect(library.getByRole("button", { name: "New only", exact: true })).toBeHidden();
    await expect(library.locator(".destination")).toBeVisible();
  } else {
    await expect(library.getByRole("button", { name: "New only", exact: true })).toBeVisible();
  }

  const longTitle = library.locator(".title-text", { hasText: "very long title" });
  await expect(longTitle).toBeVisible();
  const titleClipped = await longTitle.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(titleClipped).toBe(project === "narrow");

  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const source = store.libraryList;
    const rows = Array.from({ length: 24 }, (_, i) => ({
      ...source[i % source.length],
      path: `/fixture/music/dense-${i}.mp3`,
      content_hash: String(i).padStart(64, "0"),
    }));
    store.library = new Map(rows.map((row) => [row.path, row]));
    window.__uiFixture.setReply("refresh_library", { rows, persistence_error: null });
    store.player = {
      ...store.player,
      phase: "playing",
      now_playing: rows[1].path,
      playback_started_frames: 48000,
      duration_secs: 257,
      position_secs: 60,
    };
    window.__uiFixture.setReply("player_state", store.player);
  });
  await expect(library.locator("li.row")).toHaveCount(24);
  await expect(library.locator("li.row.sounding")).toHaveCount(1);
  await expect(library.locator(".file").first()).toBeVisible();
  const bottom = page.locator(".playback-bar");
  const visibleRows = await library.locator("li.row").evaluateAll((nodes) => {
    const bar = document.querySelector(".playback-bar").getBoundingClientRect().top;
    return nodes.filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.height > 0 && rect.top >= 0 && rect.bottom <= bar;
    }).length;
  });
  expect(visibleRows).toBeGreaterThanOrEqual(project === "narrow" ? 13 : 19);
  await expect(bottom).toBeVisible();
  await shot(page, `${project}-library`);

  await page.getByLabel("Search the library").fill("Midnight");
  await expect(library.locator("li.row")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Clear search", exact: true })).toBeVisible();
  await shot(page, `${project}-search`);
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(library.locator("li.row")).toHaveCount(24);
  await expect(page.getByLabel("Search the library")).toHaveValue("");

  await page.reload();
  await expect(library.locator("li.row")).toHaveCount(6);
  await library.getByRole("button", { name: "Filter", exact: true }).click();
  if (project === "narrow") {
    await expect(library.getByRole("button", { name: "New only", exact: true })).toBeVisible();
  }
  await library.getByLabel("Tag candidate", { exact: true }).selectOption("genre:funkot");
  await library.getByRole("button", { name: "Add condition", exact: true }).click();
  await expect(library.locator("li.row")).toHaveCount(5);
  await shot(page, `${project}-filter`);
  await library.getByRole("button", { name: /^Filter/ }).click();

  const add = library.locator("li.row").first().locator(".add");
  await add.click();
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.some((call) => call.command === "playlist_command"))).toBe(true);
  const added = await page.evaluate(() => window.__uiFixture.calls.find((call) => call.command === "playlist_command").args.request);
  expect(added.action.kind).toBe("append");
  expect(added.action.tracks).toHaveLength(1);

  const dawn = library.locator("li.row").filter({ hasText: "Dawn" });
  await dawn.scrollIntoViewIfNeeded();
  await dawn.click({ button: "right" });
  const editTags = page.getByRole("menuitem", { name: "Edit tags", exact: true });
  await expect(editTags).toBeVisible();
  await shot(page, `${project}-menu`);
  await page.keyboard.press("Escape");
  await expect(editTags).toBeHidden();
});
