const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { compareLive } = require('./verified-live-comparison.cjs');

function recipe(t, deadline = 10000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-comparison-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, 'work'); fs.mkdirSync(work);
  const inputs = path.join(root, 'inputs'); fs.mkdirSync(inputs);
  const entries = ['first', 'second'].map(name => {
    const file = path.join(inputs, name); fs.writeFileSync(file, name);
    return { file, sha256: crypto.createHash('sha256').update(name).digest('hex') };
  });
  const input = path.join(root, 'inputs.json'); fs.writeFileSync(input, JSON.stringify({ files: entries }));
  const recipe = path.join(root, 'recipe.json');
  fs.writeFileSync(recipe, JSON.stringify({ schema: 1, work_directory: work, input_manifest: input, deadline_ms: deadline }));
  return { recipe, work };
}

test('public recorder download with altered bytes cannot begin a build', async t => {
  const { recipe: recipeFile, work } = recipe(t);
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from('altered public source') });
  t.after(() => { globalThis.fetch = previous; });
  await assert.rejects(compareLive(recipeFile), /download hash does not match/);
  assert.deepEqual(fs.readdirSync(work), []);
});

test('a stalled public download is aborted at the requested deadline', async t => {
  const { recipe: recipeFile, work } = recipe(t, 100);
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    const pending = setTimeout(() => reject(new Error('download was not aborted')), 1000);
    signal.addEventListener('abort', () => { clearTimeout(pending); reject(new Error('download aborted')); }, { once: true });
  });
  t.after(() => { globalThis.fetch = previous; });
  await assert.rejects(compareLive(recipeFile), /download aborted/);
  assert.deepEqual(fs.readdirSync(work), []);
});
