import { test, expect } from "@playwright/test";

const conflict = {
  kind: "legacy_normal_conflict",
  token: 41,
  queue_file_items: 3,
  catalog_normal_items: 5,
};

async function capture(page, testInfo, name) {
  const path = testInfo.outputPath(`${testInfo.project.name}-${name}.jpg`);
  await page.screenshot({ path, quality: 75, animations: "disabled", caret: "hide" });
  await testInfo.attach(name, { path, contentType: "image/jpeg" });
}

test("legacy queue recovery requires an explicit choice and refreshes playback state", async ({ page }, testInfo) => {
  await page.goto("/tests/ui/");
  await expect(page.locator("section.library li.row")).toHaveCount(6);
  await page.evaluate(async (status) => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.playbackRecovery = status;
    window.__uiFixture.setReply("resolve_playback_recovery", { kind: "ready" });
  }, conflict);

  const recovery = page.getByRole("region", { name: "Choose the current queue" });
  const start = page.getByRole("button", { name: "Start", exact: true });
  const add = page.getByRole("button", { name: /Add Pulse to/ });
  await expect(recovery).toBeVisible();
  await expect(start).toBeDisabled();
  await expect(add).toBeDisabled();
  await expect(page.locator("section.library li.row")).toHaveCount(6);
  await expect(page.locator("section.library .tag-summary")).toHaveCount(5);
  await capture(page, testInfo, "conflict-card");

  const review = recovery.getByRole("button", { name: "Review saved queues" });
  await review.click();
  let dialog = page.getByRole("dialog", { name: "Choose the current queue" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Player queue (3 items)" })).toBeFocused();
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: viewport.width, height: 320 });
  for (const name of ["Player queue (3 items)", "Playlist-saved queue (5 items)", "Close"]) {
    await dialog.getByRole("button", { name, exact: true }).click({ trial: true });
  }
  await capture(page, testInfo, "short-recovery-dialog");
  await page.setViewportSize(viewport);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(review).toBeFocused();
  await expect(recovery).toBeVisible();

  await review.click();
  dialog = page.getByRole("dialog", { name: "Choose the current queue" });
  await page.evaluate(() => window.__uiFixture.failNext("resolve_playback_recovery", "write failed"));
  await dialog.getByRole("button", { name: "Playlist-saved queue (5 items)" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Could not save that choice. Review the queues and try again.");
  await expect(dialog).toBeVisible();
  const failedRequest = await page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "resolve_playback_recovery").at(-1));
  expect(failedRequest.args).toEqual({ request: { token: 41, choice: "catalog_normal" } });

  await dialog.getByRole("button", { name: "Player queue (3 items)" }).click();
  const resolvedRequest = await page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "resolve_playback_recovery").at(-1));
  expect(resolvedRequest.args).toEqual({ request: { token: 41, choice: "queue_file" } });
  await expect(recovery).toHaveCount(0);
  await expect(start).toBeEnabled();
  await expect(add).toBeEnabled();
  expect(await page.evaluate(() => window.__uiFixture.calls.some((call) => call.command === "start"))).toBe(false);
  await capture(page, testInfo, "resolved");
});

test("transition audition waits for playback recovery", async ({ page }) => {
  await page.goto("/tests/ui/");
  await expect(page.locator("section.library li.row")).toHaveCount(6);
  await page.evaluate(async (status) => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.playbackRecovery = status;
  }, conflict);
  await page.getByRole("tab", { name: "Go to edit mode" }).click();
  await page.locator(".list .row").filter({ hasText: "Pulse" }).getByRole("button").first().click();
  const listen = page.getByRole("button", { name: /Listen to the transition/ });
  await expect(listen).toBeDisabled();
  const results = await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    return [await store.doAuditionTransition("/fixture/music/track-1.mp3", "/fixture/music/track-2.mp3"), await store.doAuditionAgain()];
  });
  expect(results).toEqual([false, false]);
  expect(await page.evaluate(() => window.__uiFixture.calls.filter((call) => ["audition_transition", "audition_again"].includes(call.command)))).toEqual([]);
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.playbackRecovery = { kind: "ready" };
  });
  await expect(listen).toBeEnabled();
});
