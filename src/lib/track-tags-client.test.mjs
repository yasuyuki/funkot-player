import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformWithEsbuild } from "vite";
const source = await readFile(new URL("track-tags-client.ts", import.meta.url), "utf8");
const built = await transformWithEsbuild(source, "track-tags-client.ts", { loader: "ts", format: "esm", target: "esnext" });
const { TrackTagsClient } = await import(`data:text/javascript;base64,${Buffer.from(built.code).toString("base64")}`);
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
test("a late old list cannot roll back a saved manual tag", async () => {
  const old = deferred(); const seen = [];
  const client = new TrackTagsClient({ list: () => old.promise, update: async () => ({snapshot: {revision:"new"}}), changed: x=>seen.push(x.revision), failed: assert.fail });
  const read = client.reload(); await client.save({}); old.resolve({revision:"old"}); await read;
  assert.deepEqual(seen,["new"]);
});
test("scan reload during save waits and duplicate save is refused", async () => {
  const pending = deferred(); const seen=[]; let reads=0;
  const client = new TrackTagsClient({ list: async () => { reads++; return {revision:"scan+new"}; }, update: () => pending.promise, changed:x=>seen.push(x.revision), failed:assert.fail });
  const save = client.save({}); await client.reload(); assert.equal(reads,0);
  await assert.rejects(client.save({}), e=>e.code==="busy");
  pending.resolve({snapshot:{revision:"new"}}); await save;
  assert.deepEqual(seen,["new","scan+new"]); assert.equal(reads,1);
});
test("save failure publishes no success and preserves caller input", async () => {
  const request={targets:[{path:"/a",expected_hash:"a"}],expected_revision:"r",patch:{year_change:{mode:"set",value:2024}}};
  const before=structuredClone(request);
  const client=new TrackTagsClient({list:assert.fail,update:async()=>{throw {code:"persist_failed"};},changed:assert.fail,failed:assert.fail});
  await assert.rejects(client.save(request),e=>e.code==="persist_failed"); assert.deepEqual(request,before);
});
test("only the newest overlapping read is published",async()=>{
  const a=deferred(), b=deferred(),seen=[];let i=0;
  const client=new TrackTagsClient({list:()=>[a,b][i++].promise,update:assert.fail,changed:x=>seen.push(x.revision),failed:assert.fail});
  const first=client.reload(),second=client.reload();b.resolve({revision:"b"});await second;a.resolve({revision:"a"});await first;assert.deepEqual(seen,["b"]);
});
