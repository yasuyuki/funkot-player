const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { compareLive } = require('./verified-live-comparison.cjs');

function cycleRecipe(t, { maxCycles = 3, retainCleanCycles = 1 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-cycles-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, 'work'); fs.mkdirSync(work);
  const inputs = path.join(root, 'inputs'); fs.mkdirSync(inputs);
  const entries = ['A', 'B180'].map(name => {
    const file = path.join(inputs, name); fs.writeFileSync(file, name);
    return { file, sha256: crypto.createHash('sha256').update(name).digest('hex') };
  });
  const input = path.join(root, 'inputs.json'); fs.writeFileSync(input, JSON.stringify({ files: entries }));
  const calibration = path.join(root, 'calibration.json'); fs.writeFileSync(calibration, '{}');
  const recorderSource = path.join(root, 'recorder-source'); fs.mkdirSync(recorderSource);
  const archive = path.join(root, 'PowerShell.zip'); fs.writeFileSync(archive, 'synthetic archive');
  const recipeFile = path.join(root, 'recipe.json');
  fs.writeFileSync(recipeFile, JSON.stringify({ schema: 1, max_cycles: maxCycles, deadline_ms: 10000,
    retain_clean_cycles: retainCleanCycles, mode: 'silent', work_directory: work, input_manifest: input,
    calibration_file: calibration, stop_file: path.join(root, 'STOP'), recorder_source_directory: recorderSource,
    powershell_archive: archive }));
  return { root, work, recipeFile };
}

function loadCycleController(t, behavior = {}) {
  const Module = require('node:module');
  const target = require.resolve('./verified-live-comparison.cjs');
  const original = Module._load;
  const calls = { build: 0, observer: 0, prepare: 0, capture: [], reference: 0, compare: 0 };
  const outcomes = [...(behavior.outcomes || [])];
  Module._load = function(request, parent, isMain) {
    if (request === './verified-player-build.cjs') return { buildVerifiedPlayer: options => {
      calls.build++; return { binary: { file: path.join(options.workDirectory, 'synthetic-player.exe') }, buildWitness: { issued: true }, identifier: 'synthetic-build' };
    } };
    if (request === './windows-route-observer.cjs') return { compileWindowsRouteObserver: () => { calls.observer++; return { observe: async () => ({}) }; } };
    if (request === './verified-recorder.cjs') return { recorderSources: () => [], archiveHash: '0'.repeat(64), prepareRecorder: options => {
      calls.prepare++; return { opaque: true, options };
    } };
    if (request === './verified-capture.cjs') return {
      readCaptureWitness: value => value,
      superviseFreshCapture: async options => {
        calls.capture.push({ ...options, plan: JSON.parse(fs.readFileSync(options.cyclePlanPath, 'utf8')) });
        fs.writeFileSync(path.join(options.captureDirectory, 'raw-evidence'), 'synthetic');
        if (behavior.capture) return behavior.capture(options, calls);
        return { captureWitness: { issued: true }, header: { schema: 1, cycle: calls.capture.length }, stream: {}, outputs: {}, executableSha256: 'verified-build-sha' };
      }
    };
    if (request === './verified-cycle-replay.cjs') return {
      prepareCycleReference: async options => { calls.reference++; return { opaque: true, header: options.header }; },
      compareCycle: async options => {
        calls.compare++;
        if (behavior.compare) return behavior.compare(options, calls);
        return outcomes.shift() || { classification: 'silent_clean', soundQuality: 'incomplete' };
      }
    };
    if (request === './audio-anomaly-comparison.cjs') return { compareEvidence: () => ({ classification: 'incomplete' }) };
    return original.call(this, request, parent, isMain);
  };
  delete require.cache[target];
  let controller;
  try { controller = require('./verified-live-comparison.cjs'); }
  finally { Module._load = original; }
  t.after(() => { delete require.cache[target]; });
  return { ...controller, calls };
}

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

test('finite silent cycles reuse prepared live dependencies and retain only the configured clean evidence', async t => {
  const { recipeFile, work } = cycleRecipe(t, { maxCycles: 3, retainCleanCycles: 1 });
  const { runLiveCycles, calls } = loadCycleController(t);
  const result = await runLiveCycles(recipeFile);
  assert.equal(result.stop_reason, 'max_cycles');
  assert.equal(result.actual_cycle_count, 3);
  assert.equal(result.clean_cycle_count, 3);
  assert.equal(result.click_fixed_claim, false);
  assert.deepEqual(calls.build, 1);
  assert.deepEqual(calls.observer, 1);
  assert.deepEqual(calls.prepare, 1);
  assert.equal(calls.capture.length, 3);
  assert.equal(calls.reference, 1);
  assert.equal(calls.compare, 3);
  assert.deepEqual(calls.capture.map(call => call.plan.occurrences), [[0, 1, 0], [0, 1, 0], [0, 1, 0]]);
  assert.equal(fs.existsSync(path.join(work, 'cycles', 'cycle-000001')), false);
  assert.equal(fs.existsSync(path.join(work, 'cycles', 'cycle-000002')), false);
  assert.equal(fs.existsSync(path.join(work, 'cycles', 'cycle-000003', 'raw-evidence')), true);
  assert.equal(fs.readdirSync(path.join(work, 'summaries')).length, 3);
});

test('the first anomaly stops and preserves its raw cycle evidence', async t => {
  const { recipeFile, work } = cycleRecipe(t);
  const { runLiveCycles, calls } = loadCycleController(t, { outcomes: [{ classification: 'pcm_transient', soundQuality: 'actual_calibrated' }] });
  const result = await runLiveCycles(recipeFile);
  assert.equal(result.stop_reason, 'pcm_transient');
  assert.equal(calls.capture.length, 1);
  const cycle = path.join(work, 'cycles', 'cycle-000001');
  assert.equal(fs.existsSync(path.join(cycle, 'raw-evidence')), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cycle, 'cycle-result.json'), 'utf8')).outcome.classification, 'pcm_transient');
});

for (const classification of ['incomplete', 'capture_fault', 'condition_mismatch']) {
  test(`${classification} is a terminal finite-cycle outcome`, async t => {
    const { recipeFile, work } = cycleRecipe(t);
    const { runLiveCycles, calls } = loadCycleController(t, { outcomes: [{ classification, soundQuality: 'incomplete' }] });
    const result = await runLiveCycles(recipeFile);
    assert.equal(result.stop_reason, classification);
    assert.equal(calls.capture.length, 1);
    assert.equal(fs.existsSync(path.join(work, 'cycles', 'cycle-000001', 'raw-evidence')), true);
  });
}

test('a supervised input-condition change stays distinct from a collector fault', async t => {
  const { recipeFile, work } = cycleRecipe(t);
  const { runLiveCycles } = loadCycleController(t, { capture: async () => {
    throw Object.assign(new Error('guarded input changed'), { classification: 'condition_mismatch', code: 'capture_input_changed' });
  } });
  const result = await runLiveCycles(recipeFile);
  assert.equal(result.stop_reason, 'condition_mismatch');
  const saved = JSON.parse(fs.readFileSync(path.join(work, 'cycles/cycle-000001/cycle-result.json')));
  assert.equal(saved.outcome.code, 'capture_input_changed');
  assert.equal(fs.existsSync(path.join(work, 'cycles/cycle-000001/raw-evidence')), true);
});

test('an AbortSignal cancels in-flight supervision and preserves its partial cycle directory', async t => {
  const { recipeFile, work } = cycleRecipe(t);
  let entered;
  const enteredCapture = new Promise(resolve => { entered = resolve; });
  const { runLiveCycles } = loadCycleController(t, { capture: async options => {
    entered();
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    throw new Error('capture supervision aborted');
  } });
  const abort = new AbortController();
  const running = runLiveCycles(recipeFile, { signal: abort.signal });
  await enteredCapture;
  abort.abort();
  const result = await running;
  assert.equal(result.stop_reason, 'cancelled_incomplete');
  assert.equal(result.cycles[0].classification, 'cancelled_incomplete');
  assert.equal(fs.existsSync(path.join(work, 'cycles', 'cycle-000001', 'raw-evidence')), true);
});

test('a result write failure fails closed without deleting raw evidence', async t => {
  const { recipeFile, work } = cycleRecipe(t);
  const { runLiveCycles } = loadCycleController(t);
  const original = fs.openSync;
  fs.openSync = function(file, ...rest) {
    if (String(file).endsWith('cycle-result.json')) throw new Error('synthetic result storage failure');
    return original.call(this, file, ...rest);
  };
  let result;
  try { result = await runLiveCycles(recipeFile); }
  finally { fs.openSync = original; }
  assert.equal(result.stop_reason, 'storage_failure');
  assert.equal(result.cycles[0].classification, 'storage_failure');
  assert.equal(fs.existsSync(path.join(work, 'cycles', 'cycle-000001', 'raw-evidence')), true);
});

test('a retention failure preserves the verified clean cycle evidence', async t => {
  const { recipeFile, work } = cycleRecipe(t, { maxCycles: 2, retainCleanCycles: 0 });
  const { runLiveCycles } = loadCycleController(t);
  const original = fs.rmSync;
  fs.rmSync = function(file, options) {
    if (String(file).includes(`${path.sep}cycles${path.sep}cycle-000001`)) throw new Error('synthetic retention failure');
    return original.call(this, file, options);
  };
  let result;
  try { result = await runLiveCycles(recipeFile); }
  finally { fs.rmSync = original; }
  assert.equal(result.stop_reason, 'storage_failure');
  assert.equal(result.cycles[0].classification, 'storage_failure');
  assert.equal(fs.existsSync(path.join(work, 'cycles', 'cycle-000001', 'raw-evidence')), true);
});
