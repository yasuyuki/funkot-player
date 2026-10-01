import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

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

test("normal queue clears ambiguous duplicates and keeps an unswappable reservation protected", async ({
  page,
}) => {
  const queue = page.locator("section.queue");
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const shared = { path: "/fixture/music/track-1.mp3", origin: "manual" };
    store.browsedPlaylist = null;
    store.queue = {
      ...store.queue,
      source: { playlist_id: null, generation: 7, revision: 2 },
      playlist: null,
      reserved: null,
      pending: [shared, shared],
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
    expect: { path: "/fixture/music/track-1.mp3", origin: "manual" },
  });
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
    expect: { path: "/fixture/music/track-1.mp3", origin: "manual" },
  });
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const shared = { path: "/fixture/music/track-1.mp3", origin: "manual" };
    store.queue = { ...store.queue, pending: [shared, shared, shared] };
    window.__uiFixture.setReply("queue_state", store.queue);
  });
  await expect(duplicateToolbar).toHaveCount(0);

  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.queue = {
      ...store.queue,
      reserved: { path: "/fixture/music/track-1.mp3", origin: "manual" },
      pending: [{ path: "/fixture/music/track-2.mp3", origin: "manual" }],
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

test("queue save dialog text meets contrast target", async ({ page }, testInfo) => {
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const { i18n } = await import("/src/lib/i18n.svelte.ts");
    i18n.setLocale("ja");
    store.queue = {
      ...store.queue,
      source: { playlist_id: null, generation: 3, revision: 5 },
      playlist: null,
      reserved: { path: "/fixture/music/track-1.mp3", origin: "manual" },
      pending: [{ path: "/fixture/music/track-2.mp3", origin: "automatic" }],
    };
    window.__uiFixture.setReply("queue_state", store.queue);
  });
  const queue = page.locator("section.queue");
  await queue.getByRole("button", { name: "プレイリスト操作" }).click();
  await queue.getByRole("button", { name: "再生待ちをプレイリストとして保存" }).click();
  const dialog = queue.getByRole("dialog", { name: "再生待ちをプレイリストとして保存" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "保存" })).toBeDisabled();
  const measured = await dialog.evaluate((element) => {
    const background = getComputedStyle(element).backgroundColor;
    const channel = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
    const luminance = (value) => {
      const linear = channel(value).map((v) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const measure = (selector) => {
      const color = getComputedStyle(element.querySelector(selector)).color;
      const [a, b] = [luminance(color), luminance(background)].sort((x, y) => y - x);
      return { color, background, ratio: (a + 0.05) / (b + 0.05) };
    };
    return { heading: measure("h3"), label: measure("label") };
  });
  const path = testInfo.outputPath(`${testInfo.project.name}-save-dialog-contrast.png`);
  await page.screenshot({ path, fullPage: false, animations: "disabled" });
  await testInfo.attach("save-dialog-contrast", { path, contentType: "image/png" });
  expect(measured.heading.ratio, JSON.stringify(measured)).toBeGreaterThanOrEqual(7);
  expect(measured.label.ratio, JSON.stringify(measured)).toBeGreaterThanOrEqual(7);
});


test("queue save dialog has no axe color contrast failures", async ({ page }, testInfo) => {
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.queue = {
      ...store.queue,
      source: { playlist_id: null, generation: 3, revision: 5 },
      playlist: null,
      reserved: { path: "/fixture/music/track-1.mp3", origin: "manual" },
      pending: [{ path: "/fixture/music/track-2.mp3", origin: "automatic" }],
    };
    window.__uiFixture.setReply("queue_state", store.queue);
  });
  for (const preference of ["dark", "light"]) {
    await page.getByRole("button", { name: "menu" }).click();
    await page.getByLabel("Theme").selectOption(preference);
    await page.getByRole("button", { name: "menu" }).click();
    const queue = page.locator("section.queue");
    await queue.getByRole("button", { name: "Playlist actions" }).click();
    await queue.getByRole("button", { name: "Save queue as playlist" }).click();
    const dialog = queue.getByRole("dialog", { name: "Save queue as playlist" });
    await expect(dialog).toBeVisible();
    const capture = testInfo.outputPath(`${testInfo.project.name}-${preference}-save-dialog.jpg`);
    await page.screenshot({ path: capture, quality: 80, animations: "disabled" });
    await testInfo.attach(`${preference}-save-dialog`, { path: capture, contentType: "image/jpeg" });
    const result = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
    await testInfo.attach(`axe-${preference}`, {
      body: JSON.stringify({ violations: result.violations, incomplete: result.incomplete }, null, 2),
      contentType: "application/json",
    });
    expect(result.violations, `${preference} color contrast violations`).toEqual([]);
    const incomplete = result.incomplete.filter((item) => item.id === "color-contrast");
    expect(incomplete, `${preference} incomplete targets`).toHaveLength(1);
    expect(incomplete[0].nodes.map((node) => node.target)).toEqual([[".save-scope"]]);
    expect(incomplete[0].nodes[0].any[0].data.messageKey).toBe("elmPartiallyObscuring");
    const scope = await dialog.evaluate((element) => {
      const paragraph = element.querySelector(".save-scope");
      const label = element.querySelector("label");
      const color = getComputedStyle(paragraph).color;
      const background = getComputedStyle(element).backgroundColor;
      const luminance = (value) => {
        const linear = value.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const ratio = (foreground) => {
        const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
        return (a + 0.05) / (b + 0.05);
      };
      return {
        color,
        background,
        ratio: ratio(color),
        headingRatio: ratio(getComputedStyle(element.querySelector("h3")).color),
        labelRatio: ratio(getComputedStyle(label).color),
        paragraphBottom: paragraph.getBoundingClientRect().bottom,
        labelTop: label.getBoundingClientRect().top,
      };
    });
    await testInfo.attach(`axe-reviewed-incomplete-${preference}`, { body: JSON.stringify(scope), contentType: "application/json" });
    expect(scope.paragraphBottom).toBeLessThanOrEqual(scope.labelTop);
    expect(scope.headingRatio, `${preference} save heading ${JSON.stringify(scope)}`).toBeGreaterThanOrEqual(7);
    expect(scope.labelRatio, `${preference} save label ${JSON.stringify(scope)}`).toBeGreaterThanOrEqual(7);
    expect(scope.ratio, `${preference} save scope ${JSON.stringify(scope)}`).toBeGreaterThanOrEqual(4.5);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
});


test("queue save input, actions, and focus stay legible without changing queue behavior", async ({ page }) => {
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.queue = {
      ...store.queue,
      source: { playlist_id: null, generation: 3, revision: 5 },
      playlist: null,
      reserved: { path: "/fixture/music/track-1.mp3", origin: "manual" },
      pending: [{ path: "/fixture/music/track-2.mp3", origin: "automatic" }],
    };
    window.__uiFixture.setReply("queue_state", store.queue);
  });
  const queue = page.locator("section.queue");
  for (const preference of ["dark", "light"]) {
    await page.getByRole("button", { name: "menu" }).click();
    await page.getByLabel("Theme").selectOption(preference);
    await page.getByRole("button", { name: "menu" }).click();
    const trigger = queue.getByRole("button", { name: "Playlist actions" });
    await trigger.click();
    await queue.getByRole("button", { name: "Save queue as playlist" }).click();
    const dialog = queue.getByRole("dialog", { name: "Save queue as playlist" });
    const input = dialog.getByRole("textbox", { name: "New playlist name" });
    const save = dialog.getByRole("button", { name: "Save" });
    await expect(save).toBeDisabled();
    const contrast = await dialog.evaluate((element) => {
      const ratio = (foreground, background) => {
        const luminance = (value) => {
          const linear = value.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
            const channel = v / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
        };
        const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
        return (a + 0.05) / (b + 0.05);
      };
      const panel = getComputedStyle(element);
      const field = getComputedStyle(element.querySelector("input"));
      const button = getComputedStyle(element.querySelector("button[type=submit]"));
      return {
        inputText: ratio(field.color, field.backgroundColor),
        inputBorder: ratio(field.borderColor, panel.backgroundColor),
        disabledText: ratio(button.color, button.backgroundColor),
      };
    });
    expect(contrast.inputText, `${preference} input ${JSON.stringify(contrast)}`).toBeGreaterThanOrEqual(7);
    expect(contrast.inputBorder, `${preference} border ${JSON.stringify(contrast)}`).toBeGreaterThanOrEqual(3);
    expect(contrast.disabledText, `${preference} disabled ${JSON.stringify(contrast)}`).toBeGreaterThanOrEqual(3);
    await input.fill("  Evening mix  ");
    await expect(save).toBeEnabled();
    const enabledContrast = await save.evaluate((element) => {
      const style = getComputedStyle(element);
      const luminance = (value) => {
        const linear = value.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
          const channel = v / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const [a, b] = [luminance(style.color), luminance(style.backgroundColor)].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    });
    expect(enabledContrast, `${preference} enabled Save`).toBeGreaterThanOrEqual(4.5);
    await page.keyboard.press("Tab");
    const focus = await dialog.evaluate((element) => {
      const target = document.activeElement;
      const outline = getComputedStyle(target);
      return { inside: element.contains(target), style: outline.outlineStyle, width: parseFloat(outline.outlineWidth) };
    });
    expect(focus.inside, `${preference} focus stays in dialog`).toBe(true);
    expect(focus.style, `${preference} focus outline`).toBe("solid");
    expect(focus.width, `${preference} focus width`).toBeGreaterThanOrEqual(2);
    await save.click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    const requests = await page.evaluate(() => window.__uiFixture.calls.filter((call) => call.command === "playlist_command"));
    expect(requests.at(-1).args.request.action).toEqual({ kind: "save_queue", name: "Evening mix" });
    await expect(queue.getByRole("button", { name: "Select Pulse" })).toHaveCount(1);
    await expect(queue.getByRole("button", { name: /Select Midnight/ })).toHaveCount(1);
  }
});


test("save dialog remains usable with a long Japanese name, delayed save, and failure", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 412, height: 300 });
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const { i18n } = await import("/src/lib/i18n.svelte.ts");
    i18n.setLocale("ja");
    store.queue = {
      ...store.queue,
      source: { playlist_id: null, generation: 3, revision: 5 },
      playlist: null,
      reserved: { path: "/fixture/music/track-1.mp3", origin: "manual" },
      pending: [{ path: "/fixture/music/track-2.mp3", origin: "automatic" }],
    };
    window.__uiFixture.setReply("queue_state", store.queue);
  });
  await page.getByRole("tab", { name: "次に再生" }).click();
  const queue = page.locator("section.queue");
  const trigger = queue.getByRole("button", { name: "プレイリスト操作" });
  const open = async () => {
    await trigger.click();
    await queue.getByRole("button", { name: "再生待ちをプレイリストとして保存" }).click();
    return queue.getByRole("dialog", { name: "再生待ちをプレイリストとして保存" });
  };
  let dialog = await open();
  const input = dialog.getByRole("textbox", { name: "新しいプレイリスト名" });
  await input.fill("長い日本語のプレイリスト名".repeat(8));
  const buttons = dialog.locator(".dialog-actions");
  await expect(buttons).toBeVisible();
  const box = await buttons.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(300);
  const path = testInfo.outputPath(`${testInfo.project.name}-short-save-dialog.jpg`);
  await page.screenshot({ path, quality: 80, animations: "disabled" });
  await testInfo.attach("short-save-dialog", { path, contentType: "image/jpeg" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  dialog = await open();
  await dialog.locator("input").fill("Failed mix");
  await page.evaluate(() => window.__uiFixture.failNext("playlist_command", "save refused"));
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("status")).toContainText("プレイリストを更新できませんでした");
  await expect(dialog.getByRole("button", { name: "保存" })).toBeEnabled();

  await page.evaluate(() => window.__uiFixture.delayNext("playlist_command"));
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog.getByRole("button", { name: "保存" })).toBeDisabled();
  await page.evaluate(() => window.__uiFixture.resolve("playlist_command", { created_id: "saved", undo_id: null, added: 2, rejected: 0, skipped: 0 }));
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
