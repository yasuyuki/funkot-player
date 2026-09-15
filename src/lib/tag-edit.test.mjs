import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

const source = await readFile(new URL("./tag-edit.ts", import.meta.url), "utf8");
const code = (await transform(source, { loader: "ts", format: "esm", target: "esnext" })).code;
const mod = await import(`data:text/javascript,${encodeURIComponent(code)}`);

test("tag targets keep only resolved content hashes and patch omits no-change year", () => {
  const snapshot = { tracks: { "/a": { content_hash: "h" }, "/b": { content_hash: null } } };
  assert.deepEqual(mod.tagTargets([{ path: "/a", content_hash: "h" }, { path: "/b", content_hash: null }], snapshot), [{ path: "/a", expected_hash: "h" }]);
  assert.deepEqual(mod.tagPatch(undefined, [], []), {});
  assert.deepEqual(mod.tagPatch({ mode: "unset" }, [{ kind: "custom", value: "x" }], []), { year_change: { mode: "unset" }, add: [{ kind: "custom", value: "x" }] });
});

test("tag summary uses backend keys and counts each state once", () => {
  const tag = { key: "genre:pop", kind: "genre", value: "Pop", origin: "embedded" };
  assert.deepEqual(mod.summarizeTags([{ effective: [tag, tag] }, { effective: [tag, { key: "custom:x", kind: "custom", value: "x", origin: "manual" }] }]), [{ tag: { key: "custom:x", kind: "custom", value: "x", origin: "manual" }, count: 1 }, { tag, count: 2 }]);
});

test("visible tag selection and queue gate remain independent, preserving hidden queue selection", () => {
  const rows = [
    {path:"a",content_hash:"a",analyzed:true,is_funkot:true},
    {path:"b",content_hash:"b",analyzed:true,is_funkot:false},
    {path:"c",content_hash:"c",analyzed:false,is_funkot:false},
  ];
  const selected = new Set(["a","b","c"]);
  assert.deepEqual(mod.tagEditSelection(rows.slice(1),selected),rows.slice(1));
  assert.deepEqual(mod.enqueueSelection(rows,selected,false),["a","c"]);
  assert.deepEqual(mod.enqueueSelection(rows,selected,true),["a","b","c"]);
  const frozen=mod.tagEditSelection(rows.slice(1),selected);
  selected.clear();
  assert.deepEqual(frozen,rows.slice(1));
});

test("stale snapshot identity cannot be used as an editing target", () => {
  assert.deepEqual(mod.tagTargets([{path:"a",content_hash:"new"}],{tracks:{a:{content_hash:"old"}}}),[]);
});

test("aggregation preserves display sources and separates same-name different-kind tags", () => {
  const embedded={key:"genre:pop",kind:"genre",value:"Pop",origin:"embedded"};
  const manual={...embedded,origin:"manual"};
  const result=mod.summarizeTags([{effective:[embedded]},{effective:[manual,{key:"custom:pop",kind:"custom",value:"Pop",origin:"manual"}]}]);
  assert.equal(result.length,2);
  assert.equal(result.find(x=>x.tag.key==="genre:pop").tag.origin,"both");
  assert.equal(embedded.origin,"embedded");
});
