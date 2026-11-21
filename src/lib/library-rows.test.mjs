import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { transformWithEsbuild } from "vite";

const sourceUrl = new URL("./library-rows.ts", import.meta.url);
const transformed = await transformWithEsbuild(await readFile(sourceUrl, "utf8"), sourceUrl.pathname, { loader: "ts", format: "esm" });
const { upNextPositions, ambiguousPaths } = await import(`data:text/javascript;base64,${Buffer.from(transformed.code).toString("base64")}`);

const entry = (path, status) => ({ entry_id: `${path}-${status}`, path, title: "", artist: "", status, reason: null });

test("a playlist's waiting rows give the up-next order, first appearance wins", () => {
  const queue = { reserved: null, pending: [], playlist: { rows: [entry("/played", "played"), entry("/now", "current"), entry("/a", "prepared"), entry("/b", "pending"), entry("/a", "pending"), entry("/gone", "missing")] } };
  assert.deepEqual([...upNextPositions(queue)], [["/a", 1], ["/b", 2]]);
});

test("without a playlist the reserved track comes before the pending ones", () => {
  const queue = { reserved: { entry_id: "r", path: "/r", origin: "manual" }, pending: [{ entry_id: "p", path: "/p", origin: "automatic" }], playlist: null };
  assert.deepEqual([...upNextPositions(queue)], [["/r", 1], ["/p", 2]]);
  assert.equal(upNextPositions(null).size, 0);
});

test("only rows sharing both title and artist are ambiguous", () => {
  const rows = [
    { path: "/1", title: "Pulse", artist: "DJ" },
    { path: "/2", title: "Pulse", artist: "DJ" },
    { path: "/3", title: "Pulse", artist: "Other" },
  ];
  assert.deepEqual([...ambiguousPaths(rows)].sort(), ["/1", "/2"]);
});
