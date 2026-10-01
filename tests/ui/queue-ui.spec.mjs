import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }, testInfo) => {
  await page.goto("/tests/ui/");
  if (testInfo.project.name === "narrow") await page.getByRole("tab", { name: "Up next" }).click();
  await expect(page.locator("section.queue")).toBeVisible();
});

test("a repeated playlist occurrence keeps its entry id and the clicked move control focused", async ({
  page,
}) => {
  const queue = page.locator("section.queue");
  await queue
    .locator(".playlist-row")
    .nth(1)
    .getByRole("button", { name: "Select Pulse" })
    .click();
  const toolbar = queue.locator(".selection-toolbar");
  const up = toolbar.getByRole("button", { name: "Move up" });
  await up.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__uiFixture.calls.filter(
            (call) => call.command === "playlist_command",
          ).length,
      ),
    )
    .toBe(1);
  await expect(up).toBeFocused();
  expect(
    await page.evaluate(
      () =>
        window.__uiFixture.calls.filter(
          (call) => call.command === "playlist_command",
        )[0].args.request.action,
    ),
  ).toEqual({
    kind: "move",
    id: "night",
    entry_id: "a-again",
    to: 0,
    scope: "remaining",
  });

  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const rows = [...store.queue.playlist.rows];
    store.queue = {
      ...store.queue,
      playlist: { ...store.queue.playlist, rows: [rows[1], rows[0]] },
    };
  });
  await expect(toolbar).toContainText("Pulse");
});

test("playlist removal keeps Undo and a poll retains the selected occurrence", async ({
  page,
}, testInfo) => {
  const queue = page.locator("section.queue");
  await queue
    .locator(".playlist-row")
    .first()
    .getByRole("button", { name: "Select Pulse" })
    .click();
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.queue = {
      ...store.queue,
      playlist: { ...store.queue.playlist, revision: 5 },
    };
  });
  await expect(queue.locator(".selection-toolbar")).toContainText("Pulse");
  await queue
    .locator(".selection-toolbar")
    .getByRole("button", { name: "Remove Pulse from this playlist" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__uiFixture.calls.filter(
            (call) => call.command === "playlist_command",
          ).length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () =>
        window.__uiFixture.calls.filter(
          (call) => call.command === "playlist_command",
        )[0].args.request.action,
    ),
  ).toEqual({ kind: "remove", id: "night", entry_id: "a" });
  await page.getByRole("button", { name: "Undo" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__uiFixture.calls.filter(
            (call) => call.command === "playlist_command",
          ).length,
      ),
    )
    .toBe(2);
  expect(
    await page.evaluate(
      () =>
        window.__uiFixture.calls.filter(
          (call) => call.command === "playlist_command",
        )[1].args.request.action,
    ),
  ).toEqual({ kind: "undo_remove", undo_id: "undo-1" });
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
  const path = testInfo.outputPath(`${testInfo.project.name}-playlist-undo.jpg`);
  await page.screenshot({ path, quality: 70, fullPage: false, animations: "disabled" });
  await testInfo.attach("playlist-undo", { path, contentType: "image/jpeg" });
});

test("normal queue keeps same-path occurrences selected and protects an unswappable reservation", async ({
  page,
}) => {
  const queue = page.locator("section.queue");
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const first = { entry_id: "first", path: "/fixture/music/track-1.mp3", origin: "manual" };
    const second = { entry_id: "second", path: "/fixture/music/track-1.mp3", origin: "manual" };
    store.browsedPlaylist = null;
    store.queue = {
      ...store.queue,
      source: { playlist_id: null, generation: 7, revision: 2 },
      playlist: null,
      reserved: null,
      pending: [first, second],
    };
    window.__uiFixture.setReply("queue_state", store.queue);
  });
  await queue.getByRole("button", { name: "Select Pulse" }).first().click();
  const duplicateToolbar = queue.locator(".selection-toolbar");
  const duplicateDown = duplicateToolbar.getByRole("button", { name: "Move down" });
  await duplicateDown.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__uiFixture.calls.filter(
            (call) => call.command === "playlist_command",
          ).length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () =>
        window.__uiFixture.calls.filter(
          (call) => call.command === "playlist_command",
        )[0].args.request.action,
    ),
  ).toEqual({
    kind: "queue_move",
    from: 0,
    to: 1,
    expect: { entry_id: "first", path: "/fixture/music/track-1.mp3", origin: "manual" },
  });
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.queue = { ...store.queue, pending: [store.queue.pending[1], store.queue.pending[0]] };
    window.__uiFixture.setReply("queue_state", store.queue);
  });
  await expect(duplicateToolbar).toContainText("Pulse");
  const duplicateUp = duplicateToolbar.getByRole("button", { name: "Move up" });
  await duplicateUp.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__uiFixture.calls.filter(
            (call) => call.command === "playlist_command",
          ).length,
      ),
    )
    .toBe(2);
  expect(
    await page.evaluate(
      () =>
        window.__uiFixture.calls.filter(
          (call) => call.command === "playlist_command",
        )[1].args.request.action,
    ),
  ).toEqual({
    kind: "queue_move",
    from: 1,
    to: 0,
    expect: { entry_id: "first", path: "/fixture/music/track-1.mp3", origin: "manual" },
  });

  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.queue = {
      ...store.queue,
      reserved: { entry_id: "reserved", path: "/fixture/music/track-1.mp3", origin: "manual" },
      pending: [{ entry_id: "pending", path: "/fixture/music/track-2.mp3", origin: "manual" }],
      reserved_swappable: false,
    };
    window.__uiFixture.setReply("queue_state", store.queue);
  });
  await queue.getByRole("button", { name: "Select Pulse" }).click();
  const toolbar = queue.locator(".selection-toolbar");
  await expect(toolbar).toBeVisible();
  await expect(
    toolbar.getByRole("button", { name: "Move down" }),
  ).toBeDisabled();
  await expect(toolbar.getByRole("button", { name: "Remove" })).toBeDisabled();
});

test("the source picker stays reachable in a short Japanese viewport and Escape restores its trigger", async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 300 });
  await page.evaluate(async () => {
    const { i18n } = await import("/src/lib/i18n.svelte.ts");
    i18n.setLocale("ja");
  });
  await page.getByRole("tab", { name: "次に再生" }).click();
  const choose = page.locator("section.queue .source .choose");
  expect((await choose.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await choose.click();
  const picker = page.locator("section.queue .picker");
  await expect(picker).toBeVisible();
  const box = await picker.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(300);
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(choose).toBeFocused();
});
