const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function loadState(t, { calibrationReceipt, spawnSync }) {
  const target = require.resolve('./verified-cycle-state.cjs');
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (parent?.filename === target && request === './audio-anomaly-analysis.cjs') return { calibrationReceipt, callbackCsv: () => [], jsonLines: () => [] };
    if (parent?.filename === target && request === './audio-anomaly-detector.cjs') return { RATE: 48000, wav: () => { throw new Error('WAV parsing must not run'); }, localOffset: () => ({}) };
    if (parent?.filename === target && request === './verified-player-build.cjs') return { cleanEnvironment: () => ({}) };
    if (parent?.filename === target && request === 'node:child_process') return { spawnSync };
    return original.call(this, request, parent, isMain);
  };
  delete require.cache[target];
  try { return require(target); }
  finally {
    Module._load = original;
    t.after(() => { delete require.cache[target]; });
  }
}

function work(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-cycle-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calibrationFile = path.join(directory, 'calibration.json');
  fs.writeFileSync(calibrationFile, '{}');
  fs.writeFileSync(path.join(directory, 'calibration-receipt.json'), '{}');
  return { directory, calibrationFile };
}

test('a calibration mismatch is a raw condition mismatch and never a sound-quality pass', t => {
  const input = work(t);
  let compositions = 0;
  const { scanCycle } = loadState(t, {
    calibrationReceipt: (_base, _calibration, _endpoint, findings) => findings.push({ code: 'endpoint_calibration' }),
    spawnSync: () => { compositions++; return { status: 0 }; }
  });
  const result = scanCycle({ witness: { endpointReceipt: { stream: {} } }, reference: {}, calibrationFile: input.calibrationFile,
    workDirectory: input.directory, deadline: Date.now() + 1000 });
  assert.equal(result.classification, 'condition_mismatch');
  assert.equal(result.soundQuality, 'incomplete');
  assert.deepEqual(result.findings, [{ code: 'endpoint_calibration' }]);
  assert.equal(compositions, 0);
});

test('a callback composition failure stops diagnosis before it can report sound quality', t => {
  const input = work(t);
  const { scanCycle } = loadState(t, {
    calibrationReceipt: () => {},
    spawnSync: () => ({ status: 1, stderr: 'composer rejected callback evidence' })
  });
  assert.throws(() => scanCycle({
    witness: { endpointReceipt: { stream: {} }, outputs: { navigation_jsonl: { realpath: 'trace' }, callbacks_csv: { realpath: 'callbacks' } } },
    reference: { executable: 'composer', waveFile: 'reference.wav', metadataFile: 'reference.json' }, calibrationFile: input.calibrationFile,
    workDirectory: input.directory, deadline: Date.now() + 1000
  }), /finite cycle analysis failed: composer rejected callback evidence/);
});
