import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformWithEsbuild } from "vite";

const url = new URL("./transportMode.ts", import.meta.url);
const transformed = await transformWithEsbuild(await readFile(url, "utf8"), url.pathname, { loader: "ts", format: "esm" });
const { canSkipNext } = await import(`data:text/javascript;base64,${Buffer.from(transformed.code).toString("base64")}`);
const playlistQueue = (statuses, reserved_prepared = false) => ({
  reserved_prepared,
  playlist: { rows: statuses.map(status => ({ status })) },
});

test("a prepared playlist occurrence enables skip without a normal reservation", () => {
  assert.equal(canSkipNext("playing", false, playlistQueue(["prepared", "pending"])), true);
  assert.equal(canSkipNext("paused", false, playlistQueue(["prepared"])), true);
});

test("unprepared, consumed, failed or ended playlist rows cannot borrow normal readiness", () => {
  for (const status of ["pending", "preparing", "current", "played", "missing", "unplayable"]) {
    assert.equal(canSkipNext("playing", false, playlistQueue([status], true)), false, status);
  }
  assert.equal(canSkipNext("playing", false, playlistQueue([], true)), false);
});

test("normal queues retain their readiness gate, including older payloads", () => {
  assert.equal(canSkipNext("playing", false, { playlist: null, reserved_prepared: true }), true);
  assert.equal(canSkipNext("playing", false, { reserved_prepared: true }), true);
  assert.equal(canSkipNext("playing", false, { reserved_prepared: false }), false);
  assert.equal(canSkipNext("playing", false, null), false);
  assert.equal(canSkipNext("playing", false, undefined), false);
});

test("a prepared next never enables idle, failed or audition transport", () => {
  const prepared = playlistQueue(["prepared"]);
  for (const phase of ["idle", "failed"]) assert.equal(canSkipNext(phase, false, prepared), false);
  assert.equal(canSkipNext("playing", true, prepared), false);
});
