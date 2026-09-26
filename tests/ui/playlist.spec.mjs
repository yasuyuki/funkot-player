import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/ui/");
  await expect(page.locator(".library li.row")).toHaveCount(6, { timeout: 15000 });
});

test("a delayed add keeps its clicked source target across a switch", async ({ page }) => {
  await page.evaluate(() => {
    window.__uiFixture.delayNext("playlist_command");
  });
  await page.locator("section.library li.row").first().getByRole("button", { name: /Add Pulse to Night set/ }).click();
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "playlist_command").length)).toBe(1);
  const target = await page.evaluate(() => window.__uiFixture.calls.find((call) => call.command === "playlist_command").args.request.target);
  expect(target).toEqual({ playlist_id: "night", generation: 2, revision: 4 });
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const normal = { ...store.queue, source: { playlist_id: null, generation: 3, revision: 5 }, playlist: null };
    window.__uiFixture.setReply("queue_state", normal);
    store.queue = normal;
    window.__uiFixture.resolve("playlist_command", { created_id: null, undo_id: null, added: 1, rejected: 0, skipped: 0 });
  });
  await expect.poll(() => page.evaluate(async () => (await import("/src/lib/state.svelte.ts")).store.queue?.source?.playlist_id)).toBeNull();
  await expect(page.getByText(/^To Night set with an intentionally very long name:/)).toBeVisible();
});

test("a late browse response cannot replace a newer inactive list", async ({ page }) => {
  await page.evaluate(() => {
    window.__uiFixture.delayNext("playlist_entries");
    void import("/src/lib/state.svelte.ts").then(({ store }) => store.browsePlaylist("night"));
  });
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "playlist_entries").length)).toBe(1);
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    await store.browsePlaylist("empty");
    window.__uiFixture.resolve("playlist_entries", { id: "night", name: "Late night", revision: 4, run_id: 2, total: 0, ended: false, skipped: 0, rows: [] });
  });
  await expect.poll(() => page.evaluate(async () => (await import("/src/lib/state.svelte.ts")).store.browsedPlaylist?.id)).toBe("empty");
});

test("creation reports a refused source switch while preserving the created list", async ({ page }, testInfo) => {
  if (testInfo.project.name === "narrow") await page.getByRole("tab", { name: "Up next" }).click();
  const queue = page.locator("section.queue");
  await queue.locator(".source .choose").click();
  await queue.getByRole("textbox", { name: "New playlist name" }).fill("Saved set");
  await page.evaluate(() => {
    window.__uiFixture.delayNext("playlist_command");
  });
  await queue.getByRole("button", { name: "Create and use" }).click();
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "playlist_command").length)).toBe(1);
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    window.__uiFixture.failNext("playlist_command", { code: "transition_in_progress", message: "transition" });
    window.__uiFixture.setReply("queue_state", { ...store.queue, catalog_revision: 5 });
    window.__uiFixture.setReply("playlist_catalog", { ...store.catalog, revision: 5, lists: [...store.catalog.lists, { id: "saved", name: "Saved set", revision: 1, total: 0, remaining: 0 }] });
    window.__uiFixture.resolve("playlist_command", { created_id: "saved", undo_id: null, added: 0, rejected: 0, skipped: 0 });
  });
  await expect(page.getByText(/Created “Saved set”, but could not switch/)).toBeVisible();
  const actions = await page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "playlist_command").map((call) => call.args.request.action));
  expect(actions).toEqual([{ kind: "create", name: "Saved set" }, { kind: "select", id: "saved" }]);
  await expect(queue.getByRole("button", { name: /^Saved set / })).toBeVisible();
  await expect(queue.getByRole("dialog", { name: "Choose what plays next" })).toBeVisible();
});

test("inactive full editor changes its own occurrences without switching the source", async ({ page }, testInfo) => {
  await page.evaluate(() => window.__uiFixture.setReply("playlist_entries_empty", {
    id: "empty", name: "Other set", revision: 1, run_id: 1, total: 2, ended: false, skipped: 0,
    rows: [
      { entry_id: "first", path: "/fixture/music/track-1.mp3", title: "Pulse", artist: "DJ Example", status: "played", reason: null },
      { entry_id: "again", path: "/fixture/music/track-1.mp3", title: "Pulse", artist: "DJ Example", status: "current", reason: null },
    ],
  }));
  const queue = page.locator("section.queue");
  const pickerHost = testInfo.project.name === "narrow" ? page.locator("section.library") : queue;
  await pickerHost.locator(".source .choose").click();
  await pickerHost.getByRole("button", { name: "Browse Empty list" }).click();
  await expect(queue).toBeVisible();
  await expect(queue.locator("li.row")).toHaveCount(2);
  await queue.locator("li.row").first().getByRole("button", { name: "Move down" }).click();
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "playlist_command").length)).toBe(1);
  const action = await page.evaluate(() => window.__uiFixture.calls.find((call) => call.command === "playlist_command").args.request.action);
  expect(action).toEqual({ kind: "move", id: "empty", entry_id: "first", to: 1, scope: "all" });
  await expect.poll(() => page.evaluate(async () => (await import("/src/lib/state.svelte.ts")).store.queue.source.playlist_id)).toBe("night");
  await queue.getByRole("button", { name: "Playlist actions" }).click();
  await queue.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(queue.getByRole("dialog", { name: "Delete" })).toBeVisible();
  await queue.getByRole("textbox").fill("Other set");
  await queue.getByRole("dialog", { name: "Delete" }).getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "playlist_command").length)).toBe(2);
  const actions = await page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "playlist_command").map((call) => call.args.request.action));
  expect(actions[1]).toEqual({ kind: "delete", id: "empty", confirm_name: "Other set" });
  expect(actions.some((item) => item.kind === "select")).toBe(false);
});

test("normal queue stays addable when playlist data is read-only", async ({ page }, testInfo) => {
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.queue = { ...store.queue, source: { playlist_id: null, generation: 3, revision: 5 }, playlist: null, playlist_store_status: "corrupt" };
    store.catalog = { ...store.catalog, active_id: null, store_status: "corrupt" };
    window.__uiFixture.setReply("queue_state", store.queue);
    window.__uiFixture.setReply("playlist_catalog", store.catalog);
  });
  if (testInfo.project.name === "narrow") await page.getByRole("tab", { name: "Library" }).click();
  await expect(page.locator(".library li.row").first().getByRole("button", { name: "Add Pulse to Queue" })).toBeEnabled();
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.queue = { ...store.queue, source: { playlist_id: "night", generation: 4, revision: 6 }, playlist_store_status: "corrupt" };
    window.__uiFixture.setReply("queue_state", store.queue);
  });
  await expect(page.locator(".library li.row").first().getByRole("button", { name: /Add Pulse to/ })).toBeDisabled();
});

test("rename dialog keeps the list it opened for when browse changes", async ({ page }, testInfo) => {
  if (testInfo.project.name === "narrow") await page.getByRole("tab", { name: "Up next" }).click();
  const queue = page.locator("section.queue");
  await queue.locator(".source .choose").click();
  await queue.getByRole("button", { name: "Browse Empty list" }).click();
  await expect(queue.getByText("Browse all tracks: Empty list")).toBeVisible();
  await queue.getByRole("button", { name: "Playlist actions" }).click();
  await queue.getByRole("button", { name: "Rename" }).click();
  await queue.getByRole("dialog", { name: "Rename" }).getByRole("textbox").fill("Renamed other set");
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.browsedPlaylist = store.activePlaylist;
  });
  await queue.getByRole("dialog", { name: "Rename" }).getByRole("button", { name: "Save" }).click();
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "playlist_command").length)).toBe(1);
  const action = await page.evaluate(() => window.__uiFixture.calls.find((call) => call.command === "playlist_command").args.request.action);
  expect(action).toEqual({ kind: "rename", id: "empty", name: "Renamed other set" });
});

test("source label and add target stay normal while a stale catalog reply is delayed", async ({ page }, testInfo) => {
  if (testInfo.project.name === "narrow") await page.getByRole("tab", { name: "Library" }).click();
  const baseline = await page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "playlist_catalog").length);
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    window.__uiFixture.delayNext("playlist_catalog");
    store.queue = { ...store.queue, playlist: null, source: { playlist_id: null, generation: 3, revision: 5 }, catalog_revision: 5 };
    window.__uiFixture.setReply("queue_state", store.queue);
  });
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "playlist_catalog").length)).toBeGreaterThan(baseline);
  const add = page.locator("section.library li.row").first().getByRole("button", { name: "Add Pulse to Queue" });
  await expect(add).toBeEnabled();
  await add.click();
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "playlist_command").length)).toBe(1);
  const target = await page.evaluate(() => window.__uiFixture.calls.find((call) => call.command === "playlist_command").args.request.target);
  expect(target.playlist_id).toBeNull();
  await expect(page.getByText(/^To Queue:/)).toBeVisible();
  await page.evaluate(() => window.__uiFixture.resolve("playlist_catalog", { revision: 4, active_id: "night", generation: 2, store_status: "ready", lists: [{ id: "night", name: "Old night", revision: 4, total: 5, remaining: 2 }] }));
  await expect(add).toBeEnabled();
});

test("full-list edits use the browsed revision and reload after stale refusal", async ({ page }, testInfo) => {
  if (testInfo.project.name === "narrow") await page.getByRole("tab", { name: "Up next" }).click();
  const queue = page.locator("section.queue");
  await queue.getByRole("button", { name: "Playlist actions" }).click();
  await queue.getByRole("button", { name: "Show and edit all tracks" }).click();
  await expect(queue.locator(".playlist-row")).toHaveCount(5);
  const initialReads = await page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "playlist_entries").length);
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    window.__uiFixture.setReply("playlist_entries", { ...store.browsedPlaylist, revision: 5 });
    store.queue = { ...store.queue, source: { playlist_id: "night", generation: 2, revision: 5 }, catalog_revision: 5 };
    window.__uiFixture.setReply("queue_state", store.queue);
    window.__uiFixture.failNext("playlist_command", { code: "stale", message: "stale" });
  });
  await queue.locator(".playlist-row").first().getByRole("button", { name: "Move down" }).click();
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "playlist_command").length)).toBe(1);
  const target = await page.evaluate(() => window.__uiFixture.calls.find((call) => call.command === "playlist_command").args.request.target);
  expect(target).toEqual({ playlist_id: "night", generation: 2, revision: 4 });
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "playlist_entries").length)).toBeGreaterThan(initialReads);
  await expect.poll(() => page.evaluate(async () => (await import("/src/lib/state.svelte.ts")).store.browsedPlaylist?.revision)).toBe(5);
  await expect(page.getByText("This list changed. Refreshed it for review.")).toBeVisible();
});


test("a prepared playlist enables both next controls without a normal reservation", async ({ page }, testInfo) => {
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.player = { ...store.player, phase: "playing", now_playing: "/fixture/music/track-3.mp3", position_secs: 12, duration_secs: 274 };
    window.__uiFixture.setReply("player_state", store.player);
    window.__uiFixture.setReply("skip_next", null);
  });
  const next = page.locator(".transport").getByRole("button", { name: /Next track/ });
  // This is the native playlist shape: reserved=null/false, but a playlist
  // occurrence is prepared. The normal queue flag must not disable Next.
  await expect(next).toBeEnabled();
  await next.click();
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter(c => c.command === "skip_next").length)).toBe(1);
  await page.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}-playlist-next-ready.jpg`), quality: 70, fullPage: true, animations: "disabled" });

  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.queue = { ...store.queue, playlist: { ...store.queue.playlist, rows: store.queue.playlist.rows.map(row => ({ ...row, status: "preparing" })) } };
    window.__uiFixture.setReply("queue_state", store.queue);
  });
  await expect(next).toBeDisabled();
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.queue = { ...store.queue, playlist: { ...store.queue.playlist, rows: store.queue.playlist.rows.map((row, i) => ({ ...row, status: i === 0 ? "prepared" : "pending" })) } };
    window.__uiFixture.setReply("queue_state", store.queue);
  });
  await page.locator(".mode-switch").getByRole("tab").nth(1).click();
  const miniNext = page.locator(".minibar").getByRole("button", { name: "Next track", exact: true });
  await expect(miniNext).toBeVisible();
  await expect(miniNext).toBeEnabled();
  await miniNext.click();
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter(c => c.command === "skip_next").length)).toBe(2);
  await page.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}-playlist-next-minibar.jpg`), quality: 70, fullPage: true, animations: "disabled" });
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.labelingMode = true;
    await store.doLabelAndSkip(null);
  });
  await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter(c => c.command === "skip_next").length)).toBe(3);
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.queue = { ...store.queue, playlist: { ...store.queue.playlist, rows: [], ended: true } };
    window.__uiFixture.setReply("queue_state", store.queue);
  });
  await expect(miniNext).toBeDisabled();
  await page.locator(".mode-switch").getByRole("tab").first().click();
  await expect(next).toBeDisabled();
});
