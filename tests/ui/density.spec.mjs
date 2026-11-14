import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

async function dense(page) {
  await page.goto("/tests/ui/");
  await expect(page.locator("section.library li.row")).toHaveCount(6, { timeout: 15000 });
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    const rows = Array.from({ length: 24 }, (_, i) => ({ ...store.libraryList[i % 6], path: `/fixture/music/dense-${i}.mp3`, content_hash: String(i).padStart(64, "0") }));
    store.library = new Map(rows.map(row => [row.path, row]));
    window.__uiFixture.setReply("refresh_library", { rows, persistence_error: null });
    store.playHistory = { log: [], log_total: 0, tracks: rows.map((row, i) => ({ ...row, track_hash: row.content_hash, count: i + 1, last_played_ms: 1767225600000, missing: false })) };
    window.__uiFixture.setReply("list_play_history", store.playHistory);
    store.player = { ...store.player, phase: "playing", now_playing: rows[1].path, playback_started_frames: 48000, duration_secs: 257, position_secs: 60, last_transition: { from: rows[0].path, to: rows[1].path, seconds_ago: 42 } };
    window.__uiFixture.setReply("player_state", store.player);
  });
  await expect(page.locator("section.library li.row")).toHaveCount(24);
}

function measure(page, rowSelector) {
  return page.evaluate((rowSelector) => {
    const bottom = document.querySelector(".playback-bar").getBoundingClientRect().top;
    const rows = [...document.querySelectorAll(rowSelector)].filter(e => e.getClientRects().length).map(e => e.getBoundingClientRect());
    const controls = [...document.querySelectorAll("button, select, input:not([type=checkbox])")]
      .filter(e => e.getClientRects().length).map(e => e.getBoundingClientRect()).filter(r => r.bottom > 0 && r.top < innerHeight);
    return {
      viewport: `${innerWidth}x${innerHeight}`,
      listTop: Math.round(rows[0].top),
      rowHeight: Math.round(rows[0].height),
      rowsFullyVisible: rows.filter(r => r.top >= 0 && r.bottom <= bottom).length,
      controlHeightMin: Math.min(...controls.map(r => Math.round(r.height))),
    };
  }, rowSelector);
}

const tab = (page, name) => page.getByRole("tab", { name, exact: true });

test("lists start near the top and controls match the input kind", async ({ page }, testInfo) => {
  const narrow = testInfo.project.name === "narrow";
  await dense(page);
  await page.mouse.move(0, 0);
  const out = { library: await measure(page, "section.library li.row") };
  if (narrow) await tab(page, "History").click();
  out.history = await measure(page, "section.history li.row");
  if (narrow) await tab(page, "Up next").click();
  out.upNext = await measure(page, "section.queue li");
  await tab(page, "Go to edit mode").click();
  await tab(page, "All tracks").click();
  out.allTracks = await measure(page, narrow ? ".wrap .card" : ".wrap tbody tr");
  const file = testInfo.outputPath("density.json");
  await writeFile(file, JSON.stringify(out, null, 2));
  await testInfo.attach("density", { path: file, contentType: "application/json" });

  for (const list of [out.library, out.history]) {
    expect(list.listTop).toBeLessThanOrEqual(narrow ? 116 : 88);
    expect(list.rowsFullyVisible).toBeGreaterThanOrEqual(narrow ? 14 : 19);
  }
  expect(out.upNext.listTop).toBeLessThanOrEqual(narrow ? 138 : 110);
  for (const list of Object.values(out)) expect(list.controlHeightMin).toBe(narrow ? 44 : 28);
});

test("the control size override replaces the pointer default and persists", async ({ page }) => {
  await dense(page);
  const add = page.locator("section.library .add").first();
  const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  const [auto, other, choice] = coarse ? [44, 28, "mouse"] : [28, 44, "touch"];
  expect((await add.boundingBox()).height).toBe(auto);
  await page.getByRole("button", { name: "menu" }).click();
  await page.getByLabel("Control size").selectOption(choice);
  await page.keyboard.press("Escape");
  expect((await add.boundingBox()).height).toBe(other);
  await page.reload();
  await expect(page.locator("section.library li.row").first()).toBeVisible();
  expect((await add.boundingBox()).height).toBe(other);
  await page.getByRole("button", { name: "menu" }).click();
  await expect(page.getByLabel("Control size")).toHaveValue(choice);
  await page.getByLabel("Control size").selectOption("auto");
  await page.keyboard.press("Escape");
  expect((await add.boundingBox()).height).toBe(auto);
});

test("every pane and the add target stay reachable across the column boundaries", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Widths are set explicitly");
  const reachable = locator => locator.evaluateAll(nodes => nodes.some(node => {
    const r = node.getBoundingClientRect();
    if (!r.width || r.bottom <= 0 || r.top >= innerHeight) return false;
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!top && (node.contains(top) || top.contains(node));
  }));
  for (const [width, columns] of [[767, 1], [768, 2], [1151, 2], [1152, 3]]) {
    await page.setViewportSize({ width, height: 900 });
    await dense(page);
    expect((await page.locator(".panes").evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" "))).length, `${width}px columns`).toBe(columns);
    for (const [name, pane] of [["Library", "section.library"], ["History", "section.history"], ["Up next", "section.queue"]]) {
      if (await tab(page, name).isVisible()) await tab(page, name).click();
      expect(await reachable(page.locator(`${pane} li`)), `${width}px ${name}`).toBe(true);
      expect(await reachable(page.locator(".choose")), `${width}px add target on ${name}`).toBe(true);
    }
    const bar = page.getByRole("toolbar", { name: "Playback controls" });
    for (const name of [/Pause/, "Next track", /This transition is wrong/]) {
      expect(await reachable(bar.getByRole("button", { name })), `${width}px ${name}`).toBe(true);
    }
  }
});

test("a fractional width just below the two-column boundary is still one column with every tab", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Widths are set explicitly");
  await page.setViewportSize({ width: 768, height: 900 });
  await dense(page);
  await page.locator("#app").evaluate(el => el.style.width = "767.9px");
  expect((await page.locator(".panes").evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" "))).length).toBe(1);
  await expect(tab(page, "Up next")).toBeVisible();
  await expect(tab(page, "Go to playback mode")).toBeHidden();
  await expect(page.locator("section.library .choose")).toBeVisible();
});

test("a pane keeps its scroll position while another tab is shown", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "narrow", "Tabs replace panes only below two columns");
  await dense(page);
  const pane = page.locator(".pane.library");
  await pane.evaluate(el => el.scrollTop = 300);
  await tab(page, "History").click();
  await tab(page, "Library").click();
  expect(await pane.evaluate(el => el.scrollTop)).toBe(300);
});

test("the new-arrivals action is offered on every playback tab", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "narrow", "Tabs replace panes only below two columns");
  await dense(page);
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    store.arrivals = [0, 1].map(i => ({ path: `/fixture/music/dense-${i}.mp3`, first_seen: `2026-09-01T00:00:0${i}Z` }));
    window.__uiFixture.setReply("list_new_arrivals", store.arrivals);
  });
  const banner = page.locator(".banner").getByRole("button");
  for (const name of ["Library", "History", "Up next"]) {
    await tab(page, name).click();
    await expect(banner).toBeInViewport({ ratio: 1 });
  }
});
