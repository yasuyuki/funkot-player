// Issue #168 comparison run. The same fixture, viewports and selectors run on
// the base commit and on the proposal, so before/after numbers come from one script.
import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

async function dense(page) {
  await page.clock.setFixedTime(new Date("2026-01-01T00:00:00Z"));
  await page.goto("/tests/ui/");
  await expect(page.locator("section.library li.row")).toHaveCount(6, { timeout: 15000 });
  await page.evaluate(async () => {
    const { store } = await import("/src/lib/state.svelte.ts");
    // 24 rows: the six fixture tracks repeated (duplicate names), plus one with no artist.
    const rows = Array.from({ length: 24 }, (_, i) => ({ ...store.libraryList[i % 6], path: `/fixture/music/dense-${i}.mp3`, content_hash: String(i).padStart(64, "0"), added_order: 24 - i }));
    rows[6] = { ...rows[6], artist: "", title: "Untitled bootleg" };
    store.library = new Map(rows.map(row => [row.path, row]));
    window.__uiFixture.setReply("refresh_library", { rows, persistence_error: null });
    const tags = { ...store.trackTags, tracks: Object.fromEntries(rows.map((row, i) => [row.path, { ...Object.values(store.trackTags.tracks)[i % 6], content_hash: row.content_hash }])) };
    store.trackTags = tags;
    window.__uiFixture.setReply("list_track_tags", tags);
    store.playHistory = { log: [], log_total: 0, tracks: rows.map((row, i) => ({ ...row, track_hash: row.content_hash, count: i + 1, last_played_ms: 1767225600000, missing: false })) };
    window.__uiFixture.setReply("list_play_history", store.playHistory);
    store.player = { ...store.player, phase: "playing", now_playing: rows[1].path, playback_started_frames: 48000, duration_secs: 257, position_secs: 60, last_transition: { from: rows[0].path, to: rows[1].path, seconds_ago: 42 } };
    window.__uiFixture.setReply("player_state", store.player);
    const queue = { ...store.queue, playlist: { ...store.queue.playlist, rows: [
      { entry_id: "q1", path: rows[2].path, title: rows[2].title, artist: rows[2].artist, status: "prepared", reason: null },
      { entry_id: "q2", path: rows[3].path, title: rows[3].title, artist: rows[3].artist, status: "pending", reason: null },
    ] } };
    store.queue = queue;
    window.__uiFixture.setReply("queue_state", queue);
  });
  await expect(page.locator("section.library li.row")).toHaveCount(24);
  await page.evaluate(() => document.fonts.ready);
}

function measure(page) {
  return page.evaluate(() => {
    const lib = document.querySelector("section.library");
    const pane = lib.closest(".pane") ?? lib;
    const paneRect = pane.getBoundingClientRect();
    const bottom = Math.min(document.querySelector(".playback-bar").getBoundingClientRect().top, paneRect.bottom);
    const rowEls = [...lib.querySelectorAll("li.row")].filter(e => e.getClientRects().length);
    const visible = rowEls.filter(e => { const r = e.getBoundingClientRect(); return r.top >= paneRect.top - 1 && r.bottom <= bottom + 1; });
    const cut = sel => visible.map(e => e.querySelector(sel)).filter(Boolean);
    const truncated = els => els.filter(e => e.scrollWidth > e.clientWidth + 1).length;
    const avgWidth = els => els.length ? Math.round(els.reduce((s, e) => s + e.getBoundingClientRect().width, 0) / els.length) : 0;
    const titles = cut(".title-text"), artists = cut(".artist");
    const first = rowEls[0].getBoundingClientRect();
    const add = lib.querySelector("li.row .add")?.getBoundingClientRect();
    const choose = [...document.querySelectorAll(".choose")].find(e => e.getClientRects().length)?.getBoundingClientRect();
    const controlsAbove = [...lib.querySelectorAll("button, select, input")].filter(e => e.getClientRects().length && e.getBoundingClientRect().bottom <= first.top + 1).length;
    return {
      viewport: `${innerWidth}x${innerHeight}`,
      libraryPaneWidth: Math.round(paneRect.width),
      listTop: Math.round(first.top),
      toolsHeight: Math.round(first.top - paneRect.top),
      rowHeight: Math.round(first.height),
      rowsFullyVisible: visible.length,
      controlsAboveList: controlsAbove,
      titleAvgWidth: avgWidth(titles), titlesTruncated: `${truncated(titles)}/${titles.length}`,
      artistAvgWidth: avgWidth(artists), artistsTruncated: `${truncated(artists)}/${artists.length}`,
      addToTargetDistance: add && choose ? Math.round(Math.hypot((choose.left + choose.width / 2) - (add.left + add.width / 2), (choose.top + choose.height / 2) - (add.top + add.height / 2))) : null,
    };
  });
}

const tab = (page, name) => page.getByRole("tab", { name, exact: true });

async function shot(page, testInfo, name) {
  await page.mouse.move(0, 0);
  const path = testInfo.outputPath(`${testInfo.project.name}-${name}.png`);
  await page.screenshot({ path, fullPage: false, animations: "disabled", caret: "hide" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("library comparison: density, readability and three tasks", async ({ page }, testInfo) => {
  const narrow = testInfo.project.name === "narrow";
  const variant = process.env.PROPOSAL_VARIANT ?? "unknown";
  await dense(page);
  if (narrow) await tab(page, "Library").click();
  const out = { variant, project: testInfo.project.name, library: await measure(page) };
  await shot(page, testInfo, `${variant}-library`);

  // Task 1: find a track by search. Count the actions from the first keypress to the row.
  const library = page.locator("section.library");
  await page.getByRole("searchbox").fill("midnight");
  await expect(library.locator("li.row")).toHaveCount(4);
  out.search = await measure(page);
  await shot(page, testInfo, `${variant}-search`);

  // Task 2: add the found track to the current target with the row's own control.
  const calls = () => page.evaluate(() => window.__uiFixture.calls.filter(c => c.command === "playlist_command").length);
  const before = await calls();
  const add = library.locator("li.row").first().locator(".add");
  out.addLabel = await add.getAttribute("aria-label");
  await add.click();
  await expect.poll(calls).toBe(before + 1);

  // Task 3: reach the row's secondary actions. Right-click / long-press is the base path.
  await library.locator("li.row").nth(1).click({ button: "right" });
  await expect(page.getByRole("menuitem").first()).toBeVisible();
  out.menuItems = await page.getByRole("menuitem").allTextContents();
  await shot(page, testInfo, `${variant}-row-menu`);
  await page.keyboard.press("Escape");

  // Proposal only: the row text opens the row's details in place, by pointer or keyboard.
  const opener = library.locator("li.row").nth(1).locator("button.text");
  if (await opener.count()) {
    await page.getByRole("searchbox").fill("");
    await page.getByRole("searchbox").fill("midnight");
    await opener.click();
    const detail = library.getByRole("group", { name: /^Midnight on the coast/ });
    await expect(detail).toBeVisible();
    await expect(opener).toHaveAttribute("aria-expanded", "true");
    out.detailActions = await detail.getByRole("button").or(detail.getByRole("radio")).allTextContents();
    await shot(page, testInfo, `${variant}-details`);
    await detail.getByRole("radio", { name: "Non-Funkot" }).click();
    await expect.poll(() => page.evaluate(() => window.__uiFixture.calls.filter(c => c.command === "set_label").length)).toBe(1);
    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);
    await expect(opener).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(detail).toBeVisible();
    await detail.getByRole("button", { name: "Edit tags" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    out.detailFlow = "click/Enter opens, label request sent, Escape closes and returns focus, Edit tags opens the editor";
  }

  // Keyboard reach: can Tab land on something inside a row that opens its actions?
  await page.getByRole("searchbox").focus();
  const keyboard = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    keyboard.push(await page.evaluate(() => {
      const el = document.activeElement;
      return el?.closest("li.row") ? `row:${el.getAttribute("aria-label") ?? el.textContent.trim().slice(0, 30)}` : `${el?.tagName}:${el?.getAttribute("aria-label") ?? el?.textContent?.trim().slice(0, 20)}`;
    }));
  }
  out.tabOrder = keyboard;
  await page.getByRole("searchbox").fill("");
  await expect(library.locator("li.row")).toHaveCount(24);

  const file = testInfo.outputPath(`${variant}-metrics.json`);
  await writeFile(file, JSON.stringify(out, null, 2));
  await testInfo.attach("metrics", { path: file, contentType: "application/json" });
});
