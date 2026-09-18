import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

const source = await readFile(new URL("./tag-filter.ts", import.meta.url), "utf8");
const code = (await transform(source, { loader: "ts", format: "esm", target: "esnext" })).code;
const { buildTagIndex, matchesTagFilter } = await import(`data:text/javascript,${encodeURIComponent(code)}`);
const tag = (kind, value) => ({ key: `${kind}:${value}`, kind, value, origin: "embedded" });
const state = (effective, extra = {}) => ({ content_hash: extra.hash ?? "h", effective, manual: { year: extra.year ?? { mode: "auto" }, manual_additions: [], suppressed_auto_tags: [] }, metadata_status: extra.status ?? "ready", ...extra });
const row = (path, hash = "h") => ({ path, content_hash: hash });
const filter = (keys = [], mode = "all", yearUnset = false) => ({ keys, mode, yearUnset });

const rows = [row("A", "a"), row("B", "b"), row("C", "c"), row("D", "d"), row("E", "e")];
const snapshot = { tracks: {
  A: state([tag("year", "2024"), tag("genre", "funkot"), tag("custom", "配信候補")], { hash: "a" }),
  B: state([tag("year", "2023"), tag("genre", "funkot"), tag("custom", "練習")], { hash: "b" }),
  C: state([tag("year", "2024"), tag("genre", "pop"), tag("custom", "配信候補")], { hash: "c" }),
  D: state([tag("genre", "funkot")], { hash: "d" }), E: state([], { hash: "e" }),
} };
const matched = (index, f) => rows.filter((r) => matchesTagFilter(index, r.path, f)).map((r) => r.path);

test("A-E truth table uses one global all/any set", () => {
  const index = buildTagIndex(rows, snapshot);
  assert.deepEqual(matched(index, filter(["year:2024", "genre:funkot"])), ["A"]);
  assert.deepEqual(matched(index, filter(["year:2024", "genre:funkot"], "any")), ["A", "B", "C", "D"]);
  assert.deepEqual(matched(index, filter(["genre:funkot", "custom:配信候補"])), ["A"]);
  assert.deepEqual(matched(index, filter([], "all", true)), ["D", "E"]);
  assert.deepEqual(matched(index, filter()), ["A", "B", "C", "D", "E"]);
  assert.deepEqual(matched(index, filter([], "any")), ["A", "B", "C", "D", "E"]);
  assert.deepEqual(matched(index, filter(["year:2023", "year:2024"])), []);
  assert.deepEqual(matched(index, filter(["year:2023", "year:2024"], "any")), ["A","B","C"]);
  assert.deepEqual(matched(index, filter(["year:2024"], "any", true)), []);
});
test("keys are exact, kind-specific, and stale selections are retained as zero matches", () => {
  const index = buildTagIndex(rows, snapshot);
  assert.deepEqual(matched(index, filter(["genre:pop"])), ["C"]);
  assert.deepEqual(matched(index, filter(["genre:popcorn"])), []);
  assert.deepEqual(matched(index, filter(["custom:2024"])), []);
  assert.deepEqual(matched(index, filter(["year:2099"])), []);
});
test("stale rows, duplicates, pending and known missing states stay distinct", () => {
  const index = buildTagIndex([...rows, row("gone", "different"), row("pending", "p"), row("error", "x"), row("unset", "u")], { tracks: { ...snapshot.tracks, gone: state([tag("genre", "funkot")], { hash: "old" }), pending: state([], { hash: "p", status: "pending" }), error: state([], { hash: "x", status: "error" }), unset: state([], { hash: "u", status: "pending", year: { mode: "unset" } }) } });
  assert.equal(index.tracks.get("gone").state, null);
  assert.equal(matchesTagFilter(index, "pending", filter([], "all", true)), false);
  assert.equal(matchesTagFilter(index, "error", filter([], "all", true)), true);
  assert.equal(matchesTagFilter(index, "unset", filter([], "all", true)), true);
  assert.equal(index.candidates.find((x) => x.key === "genre:funkot").count, 3);
});
test("measured 10k row build and filter", () => {
  const many = Array.from({ length: 10_000 }, (_, i) => row(`p${i}`, `h${i}`));
  const manySnapshot = { tracks: Object.fromEntries(many.map((r, i) => [r.path, state([tag("year", i % 2 ? "2024" : "2023"),tag("genre", i % 2 ? "funkot" : "pop"),tag("custom", `group${i % 10}`)], { hash: r.content_hash })])) };
  const start = performance.now(); const index = buildTagIndex(many, manySnapshot); const built = performance.now() - start;
  const query = filter(["genre:funkot", "year:2024"]);
  const filteredStart = performance.now(); const count = many.filter((r) => matchesTagFilter(index, r.path, query)).length; const filtered = performance.now() - filteredStart;
  console.log(`tag-filter measurement rows=${many.length} tags_per_row=3 candidates=${index.candidates.length} build_ms=${built.toFixed(2)} filter_ms=${filtered.toFixed(2)} matches=${count} ipc=0`);
  assert.equal(count, 5000);
});

test("whole-library candidate counts dedupe each row, include duplicate hash paths, and exclude removed roots", () => {
  const funkot=tag("genre","funkot");
  const input={tracks:{a:state([funkot,funkot,tag("custom","funkot")]),b:state([{...funkot,value:"Funkot"}]),removed:state([tag("genre","removed")])}};
  const index=buildTagIndex([row("a"),row("b")],input);
  assert.deepEqual(index.candidates,[{key:"genre:funkot",kind:"genre",value:"Funkot",count:2},{key:"custom:funkot",kind:"custom",value:"funkot",count:1}]);
  assert.equal(index.tracks.has("removed"),false);
  assert.deepEqual(buildTagIndex([row("b"),row("a")],input).candidates,index.candidates);
  assert.equal(matchesTagFilter(index,"a",filter(["custom:funkot"])),true);
  assert.equal(matchesTagFilter(index,"b",filter(["custom:funkot"])),false);
});

test("missing snapshots and unknown hashes are pending, not known year-unset", () => {
  const index=buildTagIndex([row("a"),row("unknown",null)],null);
  assert.equal(matchesTagFilter(index,"a",filter()),true);
  assert.equal(matchesTagFilter(index,"a",filter([],"all",true)),false);
  assert.equal(matchesTagFilter(index,"unknown",filter([],"any",true)),false);
  assert.deepEqual(index.candidates,[]);
});
