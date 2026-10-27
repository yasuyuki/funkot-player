const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const detector = path.join(__dirname, 'audio-anomaly-detector.cjs');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const writeJson = (file, value) => write(file, `${JSON.stringify(value, null, 2)}\n`);

function writeWav(file, frames) {
  const bytes = Buffer.alloc(44 + frames * 8);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(48000 * 8, 28); bytes.writeUInt16LE(8, 32); bytes.writeUInt16LE(32, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 8, 40);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < 2; channel++) bytes.writeFloatLE(Math.sin(frame * 0.017 + channel * 0.2) * 0.3, 44 + (frame * 2 + channel) * 4);
  write(file, bytes);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-anomaly-comparison-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const side of ['capture', 'replay']) {
    for (const name of ['source.txt', 'core.bin', 'binary.bin', 'input.bin', 'driver.rs']) write(path.join(root, side, name), `${name}:same`);
    writeJson(path.join(root, side, 'source.json'), { files: [{ file: 'source.txt', sha256: sha(path.join(root, side, 'source.txt')) }] });
    writeJson(path.join(root, side, 'trace.json'), { side });
  }
  const pcm = path.join(root, 'capture', 'capture.wav'), packets = path.join(root, 'capture', 'packets.csv'), callbacks = path.join(root, 'capture', 'callbacks.csv'), calibration = path.join(root, 'capture', 'calibration.json');
  const frames = 50000; writeWav(pcm, frames);
  write(packets, `file_frame,qpc_100ns,frames\n${Array.from({ length: Math.ceil(frames / 480) }, (_, index) => { const frame = index * 480; return `${frame},${Math.round(frame * 10000000 / 48000)},${Math.min(480, frames - frame)}`; }).join('\n')}\n`);
  write(callbacks, 'sequence,callback_qpc_100ns,playback_qpc_100ns,output_frames,engine_start,engine_end,paused,audition,render_lock_miss,trace_dropped\n1,0,0,480,0,1000,0,0,0,0\n');
  writeJson(calibration, { synthetic: true });
  const next = { id: '7', label: 'next-7', source_generation: 9, target_source_generation: 10, active_index: 0, target_index: 1, active_preview: false, active_head_only: false, target_preview: false, target_head_only: false, request_engine_frame: 441, request_active_playhead_frame: 220, plan_generation: 8, plan_engine_frame: 442, plan_start_frame: 430, entry_frame: 12, transition_engine_frame: 500, fade_end_engine_frame: 600, engine_rate: 44100, reason: 'manual', simple: false };
  const endpoint = { backend: 'WASAPI', syntheticEndpoint: 'loopback-a' };
  const capture = {
    schema: 1,
    identities: { source: { manifest: 'capture/source.json' }, core: { file: 'capture/core.bin' }, binary: { file: 'capture/binary.bin' }, input: { file: 'capture/input.bin' } }, core_git: 'synthetic-core-revision',
    trace: { file: 'capture/trace.json' }, header: { file: 'capture/header.json' }, audio: { pcm: { file: 'capture/capture.wav' }, packets: { file: 'capture/packets.csv' }, callbacks: { file: 'capture/callbacks.csv' }, capture_rate: 48000 },
    endpoint, calibration: { file: 'capture/calibration.json', endpoint }
  };
  const markers = [];
  const replay = { schema: 1, identities: { source: { manifest: 'replay/source.json' }, core: { file: 'replay/core.bin' }, input: { file: 'replay/input.bin' } }, trace: { file: 'replay/trace.json' }, replay_executable: { file: 'replay/binary.bin' }, driver_source: { file: 'replay/driver.rs' }, core_git: 'synthetic-core-revision' };
  writeJson(path.join(root, 'capture', 'header.json'), { options: { output_sample_rate: 44100, cache_dir: 'capture-only', loop_playlist: true }, input: { content_hashes: [sha(path.join(root, 'capture', 'input.bin'))] } });
  const trace = [
    { kind: 'requested', request_id: 1, label: 'next-1', action: 'transition_to_next' },
    { kind: 'accepted', generation: 7, action: 'next', render_frame: 441, active_playhead: 220, current_index: 0, source_generation: 9, target_index: 1, target_source_generation: 10, active_preview: false, active_head_only: false, target_preview: false, target_head_only: false },
    { kind: 'plan_applied', generation: 7, render_frame: 442, plan: { generation: 7, start: 430, entry: 12, simple: false, reason: 'manual' } },
    { kind: 'transition_started', generation: 7, render_frame: 500 }, { kind: 'fade_completed', generation: 7, render_frame: 600 },
    { kind: 'capture_end', callback_records_dropped: 0, trace_dropped: 0 }
  ];
  write(path.join(root, 'capture', 'trace.json'), `${trace.map(JSON.stringify).join('\n')}\n`);
  const replayTrace = { navigation_trace: trace.slice(1, -1), navigation_trace_dropped: 0, options: { output_sample_rate: 44100 }, engine_options: { output_sample_rate: 44100, cache_dir: 'replay-only', loop_playlist: false }, input: { content_hashes: [sha(path.join(root, 'replay', 'input.bin'))] }, core_source_sha256: sha(path.join(root, 'replay', 'core.bin')), executable_sha256: sha(path.join(root, 'replay', 'binary.bin')), driver_source_sha256: sha(path.join(root, 'replay', 'driver.rs')), runtime: { core_revision: 'synthetic-core-revision' }, audio: { file: 'capture/capture.wav', sample_rate: 48000, engine_start_frame: 0 } };
  writeJson(path.join(root, 'replay', 'trace.json'), replayTrace);
  const captureFile = path.join(root, 'capture.json'), replayFile = path.join(root, 'replay.json'), scanFile = path.join(root, 'scan.json');
  writeJson(captureFile, capture); writeJson(replayFile, replay);
  writeJson(scanFile, { classification: 'clean', captureFrames: frames, inputSha256: sha(pcm), calibrationSha256: sha(calibration), packetSha256: sha(packets), callbackSha256: sha(callbacks) });
  return { root, capture, captureFile, replay, replayFile, replayTrace, replayTraceFile: path.join(root, 'replay', 'trace.json'), scanFile, markers };
}

function run(input, scan = input.scanFile) {
  const output = path.join(input.root, `result-${Math.random()}.json`);
  execFileSync(process.execPath, [detector, 'compare', input.captureFile, input.replayFile, scan, output], { stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(output, 'utf8'));
}
function save(input) { writeJson(input.captureFile, input.capture); writeJson(input.replayFile, input.replay); }
function saveReplayTrace(input) { writeJson(input.replayTraceFile, input.replayTrace); }

test('independent runs may have different navigation generations and engine origins', t => {
  const input = fixture(t);
  for (const event of input.replayTrace.navigation_trace) {
    event.generation += 13;
    event.render_frame += 7571;
    if (event.plan) event.plan.generation += 13;
  }
  saveReplayTrace(input);
  assert.equal(run(input).classification, 'clean');
});

test('transition timing relative to the accepted request must still match', t => {
  const input = fixture(t);
  input.replayTrace.navigation_trace.find(row => row.kind === 'transition_started').render_frame++;
  saveReplayTrace(input);
  assert.equal(run(input).classification, 'condition_mismatch');
});

test('a plan from a different accepted generation is incomplete', t => {
  const input = fixture(t);
  input.replayTrace.navigation_trace.find(row => row.kind === 'plan_applied').plan.generation++;
  saveReplayTrace(input);
  assert.equal(run(input).classification, 'incomplete');
});

function pauseCallbacks(input, engineRate, advances) {
  const headerFile = path.join(input.root, 'capture', 'header.json');
  const header = JSON.parse(fs.readFileSync(headerFile, 'utf8'));
  header.options.output_sample_rate = engineRate;
  header.transport = 'transport_fade';
  writeJson(headerFile, header);
  input.replayTrace.options.output_sample_rate = engineRate;
  input.replayTrace.engine_options.output_sample_rate = engineRate;
  saveReplayTrace(input);
  let engine = 1000;
  const rows = ['sequence,callback_qpc_100ns,playback_qpc_100ns,output_frames,engine_start,engine_end,paused,audition,render_lock_miss,trace_dropped', '1,0,0,1000,0,1000,0,0,0,0'];
  advances.forEach((advance, index) => {
    rows.push(`${index + 2},${(index + 1) * 100000},${(index + 1) * 100000},480,${engine},${engine + advance},1,0,0,0`);
    engine += advance;
  });
  write(path.join(input.root, 'capture', 'callbacks.csv'), rows.join('\n') + '\n');
}

test('the existing pause envelope may render its tail before the engine freezes', t => {
  for (const rate of [44100, 48000]) {
    const input = fixture(t), tail = Math.round(rate * 0.010);
    pauseCallbacks(input, rate, [192, tail - 192, 0, 0]);
    assert.equal(run(input, '-').classification, 'comparable');
  }
});

test('paused engine advancement beyond the transport tail is a capture fault', t => {
  const input = fixture(t);
  pauseCallbacks(input, 48000, [192, 289]);
  assert.ok(run(input, '-').findings.some(finding => finding.code === 'paused_engine_advanced'));
});

test('a frozen paused engine cannot restart its tail without resume', t => {
  const input = fixture(t);
  pauseCallbacks(input, 48000, [192, 0, 1]);
  assert.ok(run(input, '-').findings.some(finding => finding.code === 'paused_engine_advanced'));
});

test('an unknown pause envelope cannot explain paused engine advancement', t => {
  const input = fixture(t);
  pauseCallbacks(input, 48000, [480, 0]);
  const file = path.join(input.root, 'capture', 'header.json');
  const header = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete header.transport;
  writeJson(file, header);
  assert.equal(run(input, '-').classification, 'incomplete');
});

test('render lock misses cannot produce a comparable run', t => {
  const input = fixture(t), callbacks = path.join(input.root, 'capture', 'callbacks.csv');
  write(callbacks, fs.readFileSync(callbacks, 'utf8').replace('1000,0,0,0,0', '1000,0,0,1,0'));
  assert.equal(run(input, '-').classification, 'capture_fault');
});

test('missing baseline observation is incomplete', t => {
  const input = fixture(t), traceFile = path.join(input.root, 'capture', 'trace.json');
  const rows = fs.readFileSync(traceFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse); delete rows.find(row => row.kind === 'accepted').active_playhead; write(traceFile, `${rows.map(JSON.stringify).join('\n')}\n`);
  assert.equal(run(input).classification, 'incomplete');
});

test('same-condition fixture is comparable but sound quality remains incomplete', t => {
  const input = fixture(t), good = run(input);
  assert.equal(good.pcmAlignment.classification, 'measured', JSON.stringify(good.pcmAlignment));
  assert.deepEqual({ classification: good.classification, soundQuality: good.soundQuality, comparable: good.comparable }, { classification: 'clean', soundQuality: 'incomplete', comparable: true });
  const traceFile = path.join(input.root, 'capture', 'trace.json');
  const rows = fs.readFileSync(traceFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse).filter(row => row.kind !== 'fade_completed'); write(traceFile, `${rows.map(JSON.stringify).join('\n')}\n`);
  assert.equal(run(input).classification, 'incomplete');
});

test('actual next values cannot differ from replay plan', t => {
  const input = fixture(t); input.replayTrace.navigation_trace.find(row => row.kind === 'plan_applied').plan.start++; saveReplayTrace(input);
  assert.equal(run(input).classification, 'condition_mismatch');
});

test('changed raw trace frames cannot agree with a stale replay expectation', t => {
  const input = fixture(t), traceFile = path.join(input.root, 'capture', 'trace.json');
  const rows = fs.readFileSync(traceFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  rows.find(row => row.kind === 'plan_applied').plan.start++;
  write(traceFile, `${rows.map(JSON.stringify).join('\n')}\n`);
  assert.equal(run(input).classification, 'condition_mismatch');
});

test('changed callback QPC cannot agree with stale scan capture hashes', t => {
  const input = fixture(t), callbacks = path.join(input.root, 'capture', 'callbacks.csv');
  const rows = fs.readFileSync(callbacks, 'utf8').trim().split(/\r?\n/);
  rows[1] = rows[1].replace(',0,0,480,', ',0,1000,480,');
  write(callbacks, `${rows.join('\n')}\n`);
  const result = run(input);
  assert.equal(result.classification, 'condition_mismatch');
  assert.ok(result.findings.some(finding => finding.code === 'scan_capture_records'));
});

test('missing operation labels are rejected', t => {
  const input = fixture(t); input.replayTrace.navigation_trace.find(row => row.kind === 'accepted').action = ''; saveReplayTrace(input);
  assert.equal(run(input).classification, 'incomplete');
});

test('zero replay navigation is incomplete', t => {
  const input = fixture(t); input.replayTrace.navigation_trace = []; saveReplayTrace(input);
  assert.equal(run(input).classification, 'incomplete');
});

test('the trace sidecar is the only replay navigation measurement', t => {
  const input = fixture(t); input.replay.navigation_trace = []; save(input);
  assert.equal(run(input).classification, 'clean');
});

test('trace executable fingerprint must bind the replay executable bytes', t => {
  const input = fixture(t); input.replayTrace.executable_sha256 = '0'.repeat(64); saveReplayTrace(input);
  const result = run(input);
  assert.equal(result.classification, 'condition_mismatch');
  assert.ok(result.findings.some(finding => finding.code === 'replay_trace_executable'));
});

test('unmatched requested records are incomplete', t => {
  const input = fixture(t), traceFile = path.join(input.root, 'capture', 'trace.json');
  const rows = fs.readFileSync(traceFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  rows.splice(1, 0, { kind: 'requested', request_id: 2, label: 'next-2', action: 'transition_to_next' });
  write(traceFile, `${rows.map(JSON.stringify).join('\n')}\n`);
  assert.equal(run(input).classification, 'incomplete');
});

test('accepted navigation without its requested record is incomplete', t => {
  const input = fixture(t), traceFile = path.join(input.root, 'capture', 'trace.json');
  const rows = fs.readFileSync(traceFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse).filter(row => row.kind !== 'requested');
  write(traceFile, `${rows.map(JSON.stringify).join('\n')}\n`);
  assert.equal(run(input).classification, 'incomplete');
});

test('capture WAV rate must bind the declared capture rate', t => {
  const input = fixture(t); input.capture.audio.capture_rate = 44100; save(input);
  assert.equal(run(input).classification, 'capture_fault');
});

test('source and core bytes must match replay conditions', t => {
  for (const name of ['source.txt', 'core.bin']) {
    const input = fixture(t); write(path.join(input.root, 'capture', name), 'changed actual bytes');
    if (name === 'source.txt') writeJson(path.join(input.root, 'capture', 'source.json'), { files: [{ file: 'source.txt', sha256: sha(path.join(input.root, 'capture', 'source.txt')) }] });
    assert.equal(run(input).classification, 'condition_mismatch', name);
  }
});

test('changed actual input bytes are not trusted by declared hashes', t => {
  const input = fixture(t); write(path.join(input.root, 'capture', 'input.bin'), 'changed actual input');
  assert.equal(run(input).classification, 'condition_mismatch');
});

test('endpoint and calibration must remain bound', t => {
  const input = fixture(t); input.capture.calibration.endpoint = { backend: 'WASAPI', syntheticEndpoint: 'other' }; save(input);
  assert.equal(run(input).classification, 'condition_mismatch');
});

test('44100 engine frames are not treated as 48000 capture frames', t => {
  const input = fixture(t); writeJson(path.join(input.root, 'capture', 'header.json'), { options: { output_sample_rate: 48000 }, input: { content_hashes: [sha(path.join(input.root, 'capture', 'input.bin'))] } });
  const result = run(input);
  assert.equal(result.classification, 'condition_mismatch');
  assert.ok(result.findings.some(finding => finding.code === 'navigation_value'));
});

test('a run without a calibrated scan remains comparable but has incomplete sound quality', t => {
  const input = fixture(t), result = run(input, '-');
  assert.deepEqual({ classification: result.classification, soundQuality: result.soundQuality, comparable: result.comparable }, { classification: 'comparable', soundQuality: 'incomplete', comparable: true });
});
