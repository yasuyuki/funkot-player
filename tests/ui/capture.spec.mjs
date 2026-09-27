import { test, expect } from "@playwright/test";

test("Library and tag review states", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.clock.setFixedTime(new Date("2026-01-01T00:00:00Z"));
  await page.goto("/tests/ui/");
  const library = page.locator("section.library");
  await expect(library.locator("li.row")).toHaveCount(6, { timeout: 15000 });
  await expect(library.locator(".tag-summary")).toHaveCount(5);
  await expect(library.locator(".tag-summary button")).toHaveCount(0);
  const toggle = library.getByRole("button", { name: /^Tags/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(library.getByLabel("Match selected tags", { exact: true })).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);

  async function capture(name) {
    await page.mouse.move(0, 0);
    await page.evaluate(() => window.scrollTo(0, 0));
    const path = testInfo.outputPath(`${testInfo.project.name}-${name}.jpg`);
    await page.screenshot({ path, quality: 70, fullPage: true, animations: "disabled", caret: "hide" });
    await testInfo.attach(name, { path, contentType: "image/jpeg" });
  }
  await capture("library");
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const arrivals = [1, 2, 3, 4].map((i) => ({ path: `/fixture/music/track-${i}.mp3`, first_seen: `2026-09-01T00:00:0${i}Z` }));
    const active = {
      ...store.queue,
      playlist: {
        ...store.queue.playlist,
        rows: [
          { entry_id: "prepared-arrival", path: arrivals[0].path, title: "Pulse", artist: "DJ Example", status: "prepared", reason: null },
          { entry_id: "pending-arrival", path: arrivals[1].path, title: "Midnight", artist: "DJ Example", status: "pending", reason: null },
        ],
      },
    };
    store.arrivals = arrivals;
    store.queue = active;
    window.__uiFixture.setReply("list_new_arrivals", arrivals);
    window.__uiFixture.setReply("playlist_command", { created_id: null, undo_id: null, added: 2, rejected: 0, skipped: 0 });
    window.__uiFixture.setReply("queue_state", active);
  });
  const arrivalsBanner = page.getByRole("button", { name: /Append 2 new tracks to Night set/ });
  await expect(arrivalsBanner).toBeVisible();
  await capture("arrivals-playlist");
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const normal = { ...store.queue, source: { playlist_id: null, generation: 3, revision: 5 }, playlist: null };
    store.queue = normal;
    window.__uiFixture.setReply("queue_state", normal);
  });
  await expect(page.getByRole("button", { name: "Put 4 new tracks at the front of the queue" })).toBeVisible();
  await capture("arrivals-normal");
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const preAdd = { ...store.queue, source: { playlist_id: "night", generation: 2, revision: 4 }, playlist: {
      id: "night", name: "Night set with an intentionally very long name", revision: 4, run_id: 2, total: 5, ended: false, skipped: 0,
      rows: [
        { entry_id: "prepared-arrival", path: "/fixture/music/track-1.mp3", title: "Pulse", artist: "DJ Example", status: "prepared", reason: null },
        { entry_id: "pending-arrival", path: "/fixture/music/track-2.mp3", title: "Midnight", artist: "DJ Example", status: "pending", reason: null },
      ],
    } };
    store.queue = preAdd;
    window.__uiFixture.setReply("queue_state", preAdd);
  });
  await expect(arrivalsBanner).toBeVisible();
  await page.evaluate(() => window.__uiFixture.delayNext("playlist_command"));
  await arrivalsBanner.click();
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "playlist_command").length)).toBe(1);
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    window.__uiFixture.setReply("queue_state", {
      ...store.queue,
      playlist: {
        ...store.queue.playlist,
        rows: [...store.queue.playlist.rows,
          { entry_id: "added-c", path: "/fixture/music/track-3.mp3", title: "Dawn", artist: "A", status: "pending", reason: null },
          { entry_id: "added-d", path: "/fixture/music/track-4.mp3", title: "Afterglow", artist: "Studio Example", status: "pending", reason: null },
        ],
      },
    });
    window.__uiFixture.resolve("playlist_command", { created_id: null, undo_id: null, added: 2, rejected: 0, skipped: 0 });
  });
  await expect(arrivalsBanner).toHaveCount(0);
  await capture("arrivals-added");
  const queue = page.locator("section.queue");
  if (testInfo.project.name === "narrow") await page.getByRole("tab", { name: "Up next" }).click();
  await expect(queue).toBeVisible();
  await capture("playlist-active");
  if (testInfo.project.name === "desktop") {
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(library).toBeVisible();
    await expect(queue).toBeVisible();
    const left = await library.boundingBox(), right = await queue.boundingBox();
    expect(left && right && left.x + left.width <= right.x).toBeTruthy();
    await capture("playlist-two-column");
    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.locator("section.history")).toBeVisible();
    await page.getByRole("tab", { name: "Library" }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  await queue.getByRole("button", { name: "Playlist actions" }).click();
  await queue.getByRole("button", { name: "Show and edit all tracks" }).click();
  await expect(queue.getByText(/Played/)).toBeVisible();
  await expect(queue.getByText("The file is missing.")).toBeVisible();
  await capture("playlist-full-edit");
  await queue.getByRole("button", { name: "Close" }).click();
  await queue.locator(".source .choose").click();
  await queue.getByRole("button", { name: "Browse Empty list" }).click();
  await expect(queue.getByText("Browse all tracks: Empty list")).toBeVisible();
  await capture("playlist-inactive-edit");
  await queue.getByRole("button", { name: "Close" }).click();
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.queue = { ...store.queue, playlist: { ...store.queue.playlist, rows: [], ended: true, skipped: 2 } };
    store.catalog = { ...store.catalog, active_id: "night" };
    window.__uiFixture.setReply("queue_state", store.queue);
    window.__uiFixture.setReply("playlist_catalog", store.catalog);
  });
  await expect(queue.getByRole("button", { name: "Start over (current song keeps playing)" })).toBeVisible();
  await capture("playlist-ended-empty");
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.queue = { ...store.queue, playlist: null, source: { playlist_id: null, generation: 3, revision: 5 } };
    store.catalog = { ...store.catalog, active_id: null };
    window.__uiFixture.setReply("queue_state", store.queue);
    window.__uiFixture.setReply("playlist_catalog", store.catalog);
  });
  await expect(queue.getByText("Queue is empty — auto-select keeps going", { exact: true })).toBeVisible();
  await queue.getByRole("button", { name: "Playlist actions" }).click();
  await queue.getByRole("button", { name: "Save queue as playlist" }).click();
  await expect(queue.getByRole("textbox")).toBeVisible();
  await expect(queue.getByText(/The current song is excluded/)).toBeVisible();
  await capture("playlist-normal-save");
  await page.keyboard.press("Escape");
  if (testInfo.project.name === "narrow") {
    await page.getByRole("tab", { name: "Library" }).click();
    await library.locator(".source .choose").click();
    await expect(page.getByRole("dialog", { name: "Choose what plays next" })).toBeVisible();
    await capture("playlist-selector");
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "Up next" }).click();
  }
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.catalog = { ...store.catalog, store_status: "corrupt" };
    store.queue = { ...store.queue, playlist_store_status: "corrupt" };
    window.__uiFixture.setReply("queue_state", store.queue);
    window.__uiFixture.setReply("playlist_catalog", store.catalog);
  });
  await expect(queue.getByRole("alert")).toContainText("read-only");
  await capture("playlist-save-error");
  if (testInfo.project.name === "narrow") await page.getByRole("tab", { name: "Library" }).click();
  await toggle.click();
  await library.getByLabel("Tag candidate", { exact: true }).selectOption("genre:funkot");
  await library.getByRole("button", { name: "Add condition", exact: true }).click();
  await expect(library.locator("li.row")).toHaveCount(5);
  await capture("tag-filter");
  await toggle.click();
  await expect(toggle).toHaveText("Tags (1)");
  await expect(library.getByLabel("Tag candidate", { exact: true })).toHaveCount(0);
  await expect(library.locator("li.row")).toHaveCount(5);
  await toggle.click();
  // Exercise combined predicates and removal through the single toolbar entry.
  await library.getByLabel("Production year unset", { exact: true }).check();
  await expect(library.locator("li.row")).toHaveCount(3);
  await library.getByLabel("Tag candidate", { exact: true }).selectOption("year:2024");
  await library.getByRole("button", { name: "Add condition", exact: true }).click();
  await expect(library.locator("li.row")).toHaveCount(0);
  await library.getByLabel("Match selected tags", { exact: true }).selectOption("any");
  await expect(library.locator("li.row")).toHaveCount(3);
  await library.getByRole("button", { name: "Remove condition Production year: 2024", exact: true }).click();
  await library.getByRole("button", { name: "Remove condition Genre: Funkot", exact: true }).click();
  await expect(library.locator("li.row")).toHaveCount(4);
  await library.getByRole("button", { name: "Clear tag conditions", exact: true }).click();
  await toggle.click();
  await library.locator("li.row").filter({ hasText: "Midnight on the coast" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit tags", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await capture("tag-editor");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "〔Cancel〕", exact: true })).toBeInViewport();
  await dialog.getByRole("button", { name: "Remove Genre: Funkot", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Undo: Genre: Funkot", exact: true })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Undo: Genre: Funkot", exact: true }).click();
  await dialog.getByLabel("Tag", { exact: true }).fill("Warm up");
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "Undo: Genre: Warm up", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Undo: Genre: Warm up", exact: true }).click();
  await dialog.getByLabel("Production year", { exact: true }).selectOption("set");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Check the tag value.");
  await expect(dialog.getByRole("alert")).toBeInViewport();
  await dialog.getByLabel("Set year", { exact: true }).fill("2025");
  await dialog.getByLabel("Production year", { exact: true }).selectOption("auto");
  await dialog.getByLabel("Production year", { exact: true }).selectOption("unset");
  await dialog.getByLabel("Production year", { exact: true }).selectOption("unchanged");
  // Exercise warnings through the existing store seam; no persistence is mocked.
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.trackTags = { ...store.trackTags, revision: "changed-elsewhere", store_status: "invalid" };
  });
  await expect(dialog.getByRole("alert", { name: "" }).filter({ hasText: "read-only" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(dialog.getByText("Tags changed elsewhere", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Reload tags", exact: true }).click();
  await expect(dialog.getByText("Tags reloaded", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await dialog.locator("summary").click();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
  await dialog.getByRole("button", { name: "Save", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByLabel("Production year", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(library.locator("li.row").filter({ hasText: "Midnight on the coast" })).toBeFocused();
  await library.getByRole("button", { name: "Select several tracks", exact: true }).click();
  await library.getByRole("checkbox", { name: "Select Pulse", exact: true }).check();
  await library.getByRole("checkbox", { name: "Select Dawn", exact: true }).check();
  await library.getByRole("button", { name: "Edit visible selected (2)", exact: true }).click();
  await expect(dialog.getByText("2 displayed selected tracks", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Production year", { exact: true })).toHaveValue("unchanged");
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});
