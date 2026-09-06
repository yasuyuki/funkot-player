import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformWithEsbuild } from "vite";

const libDir = new URL(".", import.meta.url);

async function importTypeScript(name, replacements = []) {
  let source = await readFile(new URL(name, libDir), "utf8");
  for (const [from, to] of replacements) {
    assert.ok(source.includes(from), "expected test replacement in " + name);
    source = source.replace(from, to);
  }
  const transformed = await transformWithEsbuild(source, name, {
    loader: "ts",
    format: "esm",
    target: "esnext",
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(transformed.code).toString("base64")}`
  );
}

const tauriImports = [[
  'import { invoke as nativeInvoke } from "@tauri-apps/api/core";\nimport {\n  listen as nativeListen,\n  type EventCallback,\n  type EventName,\n  type UnlistenFn,\n} from "@tauri-apps/api/event";',
  'type EventName = string;\ntype EventCallback<T> = (event: { event: string; id: number; payload: T }) => void;\ntype UnlistenFn = () => void;\nconst nativeInvoke = async <T>(): Promise<T> => { throw new Error("unconfigured IPC"); };\nconst nativeListen = async <T>(): Promise<UnlistenFn> => () => {};',
]];

test("IPC wrappers preserve Tauri command names and argument shapes", async () => {
  const tauri = await importTypeScript("tauri.ts", tauriImports);
  const calls = [];
  const restore = tauri.installIpcForTesting({
    invoke: async (command, args) => {
      calls.push({ command, args });
      return undefined;
    },
    listen: async () => () => {},
  });
  try {
    await tauri.start("/music", "/cache");
    await tauri.setBars("/music/a.mp3", 4, 8, false);
    await tauri.auditionTransition("/music/a.mp3", "/music/b.mp3", "/music", "/cache");
  } finally {
    restore();
  }
  assert.deepEqual(calls, [
    { command: "start", args: { musicDir: "/music", cacheDir: "/cache" } },
    { command: "set_bars", args: { path: "/music/a.mp3", introBars: 4, outroStructureBars: 8, markManual: false } },
    { command: "audition_transition", args: { fromPath: "/music/a.mp3", toPath: "/music/b.mp3", musicDir: "/music", cacheDir: "/cache" } },
  ]);
});

test("IPC listener wrapper forwards callback and unlisten", async () => {
  const tauri = await importTypeScript("tauri.ts", tauriImports);
  let handler;
  let unlistenCount = 0;
  const restore = tauri.installIpcForTesting({
    invoke: async () => undefined,
    listen: async (_event, nextHandler) => {
      handler = nextHandler;
      return () => { unlistenCount += 1; };
    },
  });
  try {
    const payloads = [];
    const unlisten = await tauri.listen("analysis-progress", (event) => {
      payloads.push(event.payload);
    });
    handler({ event: "analysis-progress", id: 1, payload: { done: 1, total: 2, name: "Track" } });
    unlisten();
    assert.deepEqual(payloads, [{ done: 1, total: 2, name: "Track" }]);
    assert.equal(unlistenCount, 1);
  } finally {
    restore();
  }
});

test("analysis progress preserves visible library order and added order", async () => {
  const { applyAnalysisProgress } = await importTypeScript("library-sort.ts");
  const existing = { path: "/music/a.mp3", title: "Before", added_order: 9 };
  const progress = {
    done: 2, total: 5, name: "After",
    row: { ...existing, title: "After", added_order: null },
  };
  const update = applyAnalysisProgress(
    new Map([
      [existing.path, existing],
      ["/music/b.mp3", { path: "/music/b.mp3", title: "Second", added_order: 8 }],
    ]),
    progress,
  );
  assert.deepEqual(update.analysis, { done: 2, total: 5, name: "After" });
  assert.deepEqual([...update.library.keys()], ["/music/a.mp3", "/music/b.mp3"]);
  assert.deepEqual(update.library.get("/music/a.mp3"), { ...progress.row, added_order: 9 });
});
