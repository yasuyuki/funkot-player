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

function pcm(frames) {
  return { frames: frames.length, sample: (frame, channel) => frames[frame]?.[channel] };
}
function alignmentInput(segments = [[[1, 11], [2, 12]], [[3, 13], [4, 14]], [[5, 15], [6, 16]]]) {
  const starts = segments.reduce((result, segment) => [...result, result.at(-1) + segment.length], [0]);
  const rows = segments.map((segment, index) => ({
    sequence: index + 1, paused: 0, engine_start: 36000 + index * 100000, engine_end: 36000 + index * 100000 + segment.length,
    output_start: starts[index], output_frames: segment.length
  }));
  return {
    expected: pcm(segments.flat()), rows,
    composition: { sources: segments.map((_, index) => ({ index, engine_frame: index * 100000 })), engine_end_frame: 300000 }
  };
}
function capture(length, writes) {
  const frames = Array.from({ length }, () => [0, 0]);
  for (const { start, frames: source } of writes) source.forEach((frame, index) => { frames[start + index] = frame; });
  return pcm(frames);
}
function align(t, input, target, deadline = Date.now() + 1000) {
  return loadState(t, { calibrationReceipt: () => {}, spawnSync: () => ({ status: 0 }) })
    .alignCycleSources(target, input.expected, input.rows, input.composition, deadline);
}

test('exact common origin ignores a periodic false fit inside the former local neighborhood', t => {
  const input = alignmentInput();
  const result = align(t, input, capture(5010, [
    { start: 800, frames: [[1, 11], [2, 12]] },
    { start: 5000, frames: [[1, 11], [2, 12], [3, 13], [4, 14], [5, 15], [6, 16]] }
  ]));
  assert.equal(result.origin, 5000);
  assert.deepEqual(result.anchors.map(anchor => anchor.capture_frame), [5000, 5002, 5004]);
});

test('alignment rejects absent, corrupted, and disagreed source probes', t => {
  const input = alignmentInput();
  const segments = [[[1, 11], [2, 12]], [[3, 13], [4, 14]], [[5, 15], [6, 16]]];
  assert.throws(() => align(t, input, capture(40, [{ start: 3, frames: segments[0] }, { start: 12, frames: segments[1] }, { start: 21, frames: segments[2] }])), /anchors disagree/);
  assert.throws(() => align(t, input, capture(40, [{ start: 3, frames: segments[0] }, { start: 5, frames: [[3, 13], [999, 14]] }, { start: 7, frames: segments[2] }])), /anchors disagree/);
  assert.throws(() => align(t, input, capture(40, [{ start: 3, frames: segments[0] }, { start: 5, frames: [[3, 13], [4, 999]] }, { start: 7, frames: segments[2] }])), /anchors disagree/);
  assert.throws(() => align(t, input, capture(40, [{ start: 3, frames: segments[0] }, { start: 5, frames: segments[1] }])), /anchors disagree/);
});

test('alignment rejects more than one exact common origin', t => {
  const input = alignmentInput();
  const expected = [[1, 11], [2, 12], [3, 13], [4, 14], [5, 15], [6, 16]];
  assert.throws(() => align(t, input, capture(50, [{ start: 5, frames: expected }, { start: 30, frames: expected }])), /multiple output origins/);
});

test('alignment rejects overlapping repeated active PCM origins', t => {
  const frame = [1, 11];
  const input = alignmentInput([[frame, frame], [frame, frame], [frame, frame]]);
  assert.throws(() => align(t, input, pcm(Array.from({ length: 7 }, () => frame))), /multiple output origins/);
});

test('alignment rejects all-zero probes and accepts numeric signed-zero equality', t => {
  const silent = alignmentInput([[[0, 0]], [[0, 0]], [[0, 0]]]);
  assert.throws(() => align(t, silent, capture(3, [])), /does not contain active PCM/);
  const input = alignmentInput([[[-0, 0], [1, 11]], [[0, -0], [2, 12]], [[-0, -0], [3, 13]]]);
  const expected = [[0, -0], [1, 11], [-0, 0], [2, 12], [0, 0], [3, 13]];
  const result = align(t, input, capture(20, [{ start: 7, frames: expected }]));
  assert.equal(result.origin, 7);
});

test('alignment retains distinct source callback and source-bound requirements', t => {
  const duplicate = alignmentInput();
  duplicate.rows[1].sequence = duplicate.rows[0].sequence;
  assert.throws(() => align(t, duplicate, capture(20, [])), /observations are not distinct/);
  const bounded = alignmentInput();
  bounded.composition.sources[1].engine_frame = 72000;
  assert.throws(() => align(t, bounded, capture(20, [])), /lacks a complete alignment observation/);
});

test('alignment expires after exact matching has begun', t => {
  const input = alignmentInput();
  const deadline = Date.now() + 1000;
  let scanned = false;
  const target = pcm(Array.from({ length: 20 }, () => [0, 0]));
  target.sample = (frame, channel) => { scanned = true; return target.frames && frame < target.frames ? [0, 0][channel] : undefined; };
  t.mock.method(Date, 'now', () => scanned ? deadline : deadline - 1);
  assert.throws(() => align(t, input, target, deadline), /deadline expired/);
  assert.equal(scanned, true);
});
