import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { transformWithEsbuild } from "vite";

const arrivalsUrl = new URL("./arrivals.ts", import.meta.url);
const source = await readFile(arrivalsUrl, "utf8");
const transformed = await transformWithEsbuild(source, arrivalsUrl.pathname, {
  loader: "ts",
  format: "esm",
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString("base64")}`;
const { actionableArrivals } = await import(moduleUrl);

const arrivals = [
  { path: "/music/new-a.wav", first_seen: "2026-08-30T00:00:00Z" },
  { path: "/music/new-b.wav", first_seen: "2026-08-30T00:00:01Z" },
];
const library = new Map();

test("engine hand-off keeps an arrival excluded while reserved advances", () => {
  const afterManualEnqueue = actionableArrivals(
    arrivals,
    library,
    true,
    null,
    null,
    ["/music/new-a.wav"],
    [],
  );
  assert.deepEqual(afterManualEnqueue.map((a) => a.path), ["/music/new-b.wav"]);

  // Starting playback consumes new-a from pending. The durable hand-off list
  // keeps it excluded even after `reserved` advances to another track.
  const afterPlaybackStarts = actionableArrivals(
    arrivals,
    library,
    true,
    "/music/new-a.wav",
    "/music/base-a.wav",
    [],
    ["/music/new-a.wav", "/music/base-a.wav"],
  );
  assert.deepEqual(afterPlaybackStarts.map((a) => a.path), ["/music/new-b.wav"]);
});

test("reserved closes the gap before the hand-off list is updated", () => {
  const duringHandOff = actionableArrivals(
    arrivals,
    library,
    true,
    "/music/new-a.wav",
    "/music/new-b.wav",
    [],
    ["/music/new-a.wav"],
  );
  assert.deepEqual(duringHandOff, []);
});

test("an arrival stays excluded after reserved advances past it", () => {
  const afterRunwayAdvances = actionableArrivals(
    arrivals,
    library,
    true,
    "/music/new-a.wav",
    "/music/base-b.wav",
    [],
    [
      "/music/new-a.wav",
      "/music/new-b.wav",
      "/music/base-b.wav",
    ],
  );
  assert.deepEqual(afterRunwayAdvances, []);
});
