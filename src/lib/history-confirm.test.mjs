import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "svelte/compiler";
import { transformWithEsbuild } from "vite";

// Execute the component's actual handlers with synthetic data and a stubbed
// confirmation dialog. No native IPC or real history is used.
const source = await readFile(new URL("../components/History.svelte", import.meta.url), "utf8");
const ast = parse(source);
const handlers = ast.instance.content.body.filter((node) =>
  node.type === "FunctionDeclaration" &&
  ["clearCurrentTrackPlayCount", "removeCurrentPlayLogEntry"].includes(node.id.name),
);
assert.equal(handlers.length, 2);

for (const [name, kind, mutation, key] of [
  ["clearCurrentTrackPlayCount", "track", "doClearTrackPlayCount", "track_hash"],
  ["removeCurrentPlayLogEntry", "log", "doRemovePlayLogEntry", "at_ms"],
]) {
  const node = handlers.find((entry) => entry.id.name === name);
  const { code } = await transformWithEsbuild(source.slice(node.start, node.end), "handler.ts", { loader: "ts" });
  const create = new Function("menu", "window", "store", "t", "toast", "formatPlayedAt", `${code}; return ${name};`);
  const target = { kind, title: "Synthetic song", track_hash: "synthetic-hash", at_ms: 1234 };
  const translations = {
    confirmClearTrackPlayCount: (title) => `count: ${title}`,
    confirmRemovePlayLogEntry: (title, time) => `entry: ${title}, ${time}`,
    clearedTrackPlayCount: "cleared",
    removedTrackFromPlayLog: "removed",
    clearTrackPlayCountFailed: "clear failed",
    removeTrackFromPlayLogFailed: "remove failed",
  };

  for (const accepted of [false, true]) {
    test(`${name}: ${accepted ? "confirmation deletes only the selected target" : "cancel preserves history"}`, async () => {
      const events = [];
      const run = create(target, {
        confirm: (message) => { events.push(["confirm", message]); return accepted; },
      }, {
        [mutation]: async (value) => { events.push(["delete", value]); return true; },
      }, translations, { notify: (message) => events.push(["toast", message]) }, (value) => `time ${value}`);
      await run();
      assert.deepEqual(events[0], ["confirm", kind === "track" ? "count: Synthetic song" : "entry: Synthetic song, time 1234"]);
      assert.deepEqual(events.slice(1), accepted ? [["delete", target[key]], ["toast", kind === "track" ? "cleared" : "removed"]] : []);
    });
  }

  test(`${name}: absent or wrong menu target never prompts or deletes`, async () => {
    for (const menu of [null, { ...target, kind: kind === "track" ? "log" : "track" }]) {
      const unexpected = () => assert.fail("unexpected side effect");
      await create(menu, { confirm: unexpected }, { [mutation]: unexpected }, translations, { notify: unexpected }, unexpected)();
    }
  });

  test(`${name}: a failed deletion reports the error after confirmation`, async () => {
    const messages = [];
    await create(target, { confirm: () => true }, {
      [mutation]: async () => false,
      lastError: "synthetic failure",
    }, translations, { notify: (message) => messages.push(message) }, String)();
    assert.deepEqual(messages, ["synthetic failure"]);
  });
}
