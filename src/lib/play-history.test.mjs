import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { transformWithEsbuild } from "vite";

const sourceUrl = new URL("./play-history.ts", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const transformed = await transformWithEsbuild(source, sourceUrl.pathname, {
  loader: "ts",
  format: "esm",
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString("base64")}`;
const { calendarDaysAgo, groupPlaysByDay, playedOnly, selectablePaths } =
  await import(moduleUrl);

/// Local time, so the assertions do not depend on the runner's zone.
function at(y, m, d, hh, mm) {
  return new Date(y, m - 1, d, hh, mm).getTime();
}

function row(atMs, path = "/a", missing = false) {
  return { at_ms: atMs, path: missing ? null : path, missing };
}

test("groupPlaysByDay splits on the local day boundary", () => {
  const rows = [
    row(at(2026, 9, 3, 10, 0)),
    row(at(2026, 9, 3, 9, 0)),
    row(at(2026, 9, 2, 23, 30)),
  ];
  const days = groupPlaysByDay(rows);
  assert.deepEqual(days.map((d) => d.key), ["2026-09-03", "2026-09-02"]);
  assert.equal(days[0].rows.length, 2);
  assert.equal(days[1].rows.length, 1);
});

test("groupPlaysByDay keeps the order it was given", () => {
  // The host sorts; a second opinion here is how the two drift apart.
  const rows = [row(at(2026, 9, 3, 9, 0)), row(at(2026, 9, 3, 10, 0))];
  const [day] = groupPlaysByDay(rows);
  assert.deepEqual(day.rows.map((r) => r.at_ms), rows.map((r) => r.at_ms));
});

test("groupPlaysByDay on nothing is no days", () => {
  assert.deepEqual(groupPlaysByDay([]), []);
});

test("calendarDaysAgo counts days, not elapsed hours", () => {
  // Two minutes apart on the clock, but a day apart to a reader.
  assert.equal(
    calendarDaysAgo(at(2026, 9, 2, 23, 59), at(2026, 9, 3, 0, 1)),
    1,
  );
  assert.equal(calendarDaysAgo(at(2026, 9, 3, 0, 1), at(2026, 9, 3, 23, 59)), 0);
  assert.equal(calendarDaysAgo(at(2026, 8, 31, 12, 0), at(2026, 9, 3, 12, 0)), 3);
});

test("playedOnly drops tracks with no recorded play", () => {
  const tracks = [
    { track_hash: "a", last_played_ms: 5 },
    { track_hash: "b", last_played_ms: 0 },
  ];
  assert.deepEqual(playedOnly(tracks).map((t) => t.track_hash), ["a"]);
});

test("selectablePaths returns a repeated track once", () => {
  const rows = [row(1, "/a"), row(2, "/b"), row(3, "/a")];
  assert.deepEqual(selectablePaths(rows), ["/a", "/b"]);
});

test("selectablePaths skips a track whose file is gone", () => {
  const rows = [row(1, "/a"), row(2, null, true)];
  assert.deepEqual(selectablePaths(rows), ["/a"]);
});
