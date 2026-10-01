import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const themeKey = "funkot-player:theme-preference";

async function chooseTheme(page, value) {
  const trigger = page.getByRole("button", { name: "menu" });
  await trigger.click();
  await page.getByLabel("Theme").selectOption(value);
  return trigger;
}

test("theme choice persists, system follows the OS, and manual choice wins", async ({ page }) => {
  await page.goto("/tests/ui/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.locator("html").evaluate((element) => getComputedStyle(element).colorScheme)).toBe("dark");
  const trigger = await chooseTheme(page, "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate((key) => localStorage.getItem(key), themeKey)).toBe("light");
  expect(await page.locator("html").evaluate((element) => getComputedStyle(element).colorScheme)).toBe("light");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await chooseTheme(page, "system");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "menu" }).click();
  await chooseTheme(page, "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.evaluate((key) => localStorage.setItem(key, "unexpected"), themeKey);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await expect.poll(() => page.evaluate(async () => (await import("/src/lib/state.svelte.ts")).store.localeReady)).toBe(true);
  await page.evaluate(async () => (await import("/src/lib/i18n.svelte.ts")).i18n.setLocale("ja"));
  await expect(page.getByRole("tab", { name: "再生モードへ" })).toBeVisible();
  await page.getByRole("button", { name: "menu" }).click();
  await expect(page.getByLabel("テーマ")).toBeVisible();
  await expect(page.getByRole("option", { name: "システム" })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.evaluate(async () => (await import("/src/lib/i18n.svelte.ts")).i18n.setLocale("id"));
  await expect(page.getByRole("tab", { name: "Ke mode pemutaran" })).toBeVisible();
  await page.getByRole("button", { name: "menu" }).click();
  await expect(page.getByLabel("Tema")).toBeVisible();
  await expect(page.getByRole("option", { name: "Sistem" })).toHaveCount(1);
});

test("visible library, queue, and theme menu have no axe contrast violations", async ({ page }, testInfo) => {
  await page.goto("/tests/ui/");
  for (const preference of ["dark", "light"]) {
    await chooseTheme(page, preference);
    const menu = await new AxeBuilder({ page }).include(".overflow > .menu").withRules(["color-contrast"]).analyze();
    expect(menu.violations, `${preference} theme menu`).toEqual([]);
    expect(menu.incomplete, `${preference} theme menu incomplete`).toEqual([]);
    const path = testInfo.outputPath(`${testInfo.project.name}-${preference}-theme-menu.jpg`);
    await page.screenshot({ path, quality: 80, animations: "disabled" });
    await testInfo.attach(`${preference}-theme-menu`, { path, contentType: "image/jpeg" });
    await page.getByRole("button", { name: "menu" }).click();
    const library = await new AxeBuilder({ page }).include("section.library").withRules(["color-contrast"]).analyze();
    expect(library.violations, `${preference} library`).toEqual([]);
    expect(library.incomplete, `${preference} library incomplete`).toEqual([]);
    if (testInfo.project.name === "narrow") await page.getByRole("tab", { name: "Up next" }).click();
    const queue = await new AxeBuilder({ page }).include("section.queue").withRules(["color-contrast"]).analyze();
    expect(queue.violations, `${preference} queue`).toEqual([]);
    const queueIncomplete = queue.incomplete.filter((item) => item.id === "color-contrast");
    expect(queueIncomplete, `${preference} queue incomplete`).toHaveLength(1);
    expect(queueIncomplete[0].nodes.map((node) => node.target)).toEqual([[".menu"]]);
    expect(queueIncomplete[0].nodes[0].any[0].data.messageKey).toBe("nonBmp");
    const iconContrast = await page.locator("section.queue button.menu").evaluate((element) => {
      const color = getComputedStyle(element).color;
      const background = getComputedStyle(element).backgroundColor;
      const bodyBackground = getComputedStyle(document.body).backgroundColor;
      const luminance = (value) => {
        const linear = value.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
          const channel = v / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const [a, b] = [luminance(color), luminance(background === "rgba(0, 0, 0, 0)" ? bodyBackground : background)].sort((x, y) => y - x);
      return { color, background, bodyBackground, ratio: (a + 0.05) / (b + 0.05) };
    });
    expect(iconContrast.ratio, `${preference} queue menu icon ${JSON.stringify(iconContrast)}`).toBeGreaterThanOrEqual(3);
    await page.locator("section.queue").getByRole("button", { name: "Select Pulse" }).first().click();
    const selectedContrast = await page.locator("section.queue .row.selected").evaluate((element) => {
      const foreground = getComputedStyle(element).outlineColor;
      const background = getComputedStyle(document.body).backgroundColor;
      const luminance = (value) => {
        const linear = value.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
          const channel = v / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
      return { foreground, background, ratio: (a + 0.05) / (b + 0.05) };
    });
    expect(selectedContrast.ratio, `${preference} selected row ${JSON.stringify(selectedContrast)}`).toBeGreaterThanOrEqual(3);
    const disabled = await page.getByRole("button", { name: /Next track/ }).evaluate((element) => {
      const style = getComputedStyle(element);
      const luminance = (value) => {
        const linear = value.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
          const channel = v / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const [a, b] = [luminance(style.color), luminance(style.backgroundColor)].sort((x, y) => y - x);
      return { color: style.color, background: style.backgroundColor, ratio: (a + 0.05) / (b + 0.05) };
    });
    expect(disabled.ratio, `${preference} disabled next ${JSON.stringify(disabled)}`).toBeGreaterThanOrEqual(3);
    if (testInfo.project.name === "narrow") await page.getByRole("tab", { name: "Library" }).click();
  }
});


test("hover, pressed, focus, and Windows high contrast keep visible states", async ({ page }, testInfo) => {
  await page.goto("/tests/ui/");
  for (const preference of ["dark", "light"]) {
    await chooseTheme(page, preference);
    const menuAction = page.locator(".overflow > .menu").getByRole("button", { name: "Show log" });
    const menuBounds = await menuAction.boundingBox();
    await page.mouse.move(menuBounds.x + menuBounds.width / 2, menuBounds.y + menuBounds.height / 2);
    await page.mouse.down();
    const menuPressed = await menuAction.evaluate((element) => {
      const style = getComputedStyle(element);
      const luminance = (value) => {
        const linear = value.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
          const channel = v / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const [a, b] = [luminance(style.color), luminance(style.backgroundColor)].sort((x, y) => y - x);
      return { color: style.color, background: style.backgroundColor, ratio: (a + 0.05) / (b + 0.05) };
    });
    expect(menuPressed.ratio, `${preference} menu pressed ${JSON.stringify(menuPressed)}`).toBeGreaterThanOrEqual(4.5);
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await page.keyboard.press("Escape");
    await expect(page.locator(".overflow > .menu")).toHaveCount(0);
    const button = page.getByRole("button", { name: "Start" });
    const idle = await button.evaluate((element) => getComputedStyle(element).backgroundColor);
    await button.hover();
    const hover = await button.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(hover, `${preference} hover`).not.toBe(idle);
    const bounds = await button.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    const pressed = await button.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(pressed, `${preference} pressed`).not.toBe(hover);
    await page.mouse.up();
    await button.focus();
    await page.keyboard.press("Space");
    const outline = await button.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: parseFloat(style.outlineWidth), kind: style.outlineStyle };
    });
    expect(outline, `${preference} keyboard focus`).toEqual({ width: 2, kind: "solid" });
  }
  const search = page.getByRole("searchbox", { name: "Search the library" });
  const normalBorder = await search.evaluate((element) => getComputedStyle(element).borderColor);
  await page.emulateMedia({ contrast: "more" });
  const stronger = await search.evaluate((element) => ({
    enabled: matchMedia("(prefers-contrast: more)").matches,
    border: getComputedStyle(element).borderColor,
  }));
  expect(stronger.enabled).toBe(true);
  expect(stronger.border).not.toBe(normalBorder);
  await page.emulateMedia({ forcedColors: "active", contrast: "more" });
  if (testInfo.project.name === "narrow") await page.getByRole("tab", { name: "Up next" }).click();
  const queue = page.locator("section.queue");
  await queue.getByRole("button", { name: "Select Pulse" }).first().click();
  const selected = queue.locator(".row.selected");
  await expect(selected).toBeVisible();
  const colors = await selected.evaluate((element) => {
    const row = getComputedStyle(element);
    const button = getComputedStyle(element.querySelector("button"));
    return { forced: matchMedia("(forced-colors: active)").matches, outline: row.outlineStyle, width: parseFloat(row.outlineWidth), buttonColor: button.color, buttonBackground: button.backgroundColor };
  });
  expect(colors.forced).toBe(true);
  expect(colors.outline).toBe("solid");
  expect(colors.width).toBeGreaterThanOrEqual(2);
  expect(colors.buttonColor).not.toBe(colors.buttonBackground);
  const path = testInfo.outputPath(`${testInfo.project.name}-forced-colors.png`);
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach("forced-colors", { path, contentType: "image/png" });
});


test("the whole visible player meets axe color contrast", async ({ page }, testInfo) => {
  await page.goto("/tests/ui/");
  for (const preference of ["dark", "light"]) {
    await chooseTheme(page, preference);
    await page.getByRole("button", { name: "menu" }).click();
    const result = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
    await testInfo.attach(`${preference}-whole-player-axe`, {
      body: JSON.stringify({ violations: result.violations, incomplete: result.incomplete }, null, 2),
      contentType: "application/json",
    });
    expect(result.violations, `${preference} player contrast`).toEqual([]);
    const incomplete = result.incomplete.filter((item) => item.id === "color-contrast");
    expect(incomplete, `${preference} unmeasured icons`).toHaveLength(1);
    const expectedIcons = [{ target: [".menu-btn"], reason: "nonBmp" }];
    if (testInfo.project.name === "desktop") expectedIcons.push({ target: [".menu"], reason: "nonBmp" });
    expect(incomplete[0].nodes.map((node) => ({ target: node.target, reason: node.any[0]?.data?.messageKey }))).toEqual(expectedIcons);
    const menuIcon = await page.locator(".overflow .menu-btn").evaluate((element) => {
      const color = getComputedStyle(element).color;
      const background = getComputedStyle(document.body).backgroundColor;
      const luminance = (value) => {
        const linear = value.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
          const channel = v / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const [a, b] = [luminance(color), luminance(background)].sort((x, y) => y - x);
      return { color, background, ratio: (a + 0.05) / (b + 0.05) };
    });
    expect(menuIcon.ratio, `${preference} overflow icon ${JSON.stringify(menuIcon)}`).toBeGreaterThanOrEqual(3);
  }
});


test("saved theme is applied before the app module runs", async ({ page }) => {
  await page.addInitScript((key) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, "light"); }, themeKey);
  await page.route("**/src/main.ts", (route) => route.fulfill({ body: "" }));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  expect(await page.locator("html").evaluate((element) => element.style.colorScheme)).toBe("light");
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate((key) => localStorage.setItem(key, "system"), themeKey);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await page.locator("html").evaluate((element) => element.style.colorScheme)).toBe("dark");
});
