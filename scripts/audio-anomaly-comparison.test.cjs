const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const detector = path.join(__dirname, 'audio-anomaly-detector.cjs');
const { compareEvidence } = require('./audio-anomaly-comparison.cjs');
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
function copyWav(file, source, delta) {
  const bytes = Buffer.from(fs.readFileSync(source));
  bytes.writeFloatLE(bytes.readFloatLE(44) + delta, 44);
  write(file, bytes);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-anomaly-comparison-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const side of ['capture', 'replay']) {
    for (const name of ['source.txt', 'core.bin', 'binary.bin', 'input.bin', 'driver.rs']) write(path.join(root, side, name), `${name}:same`);
    write(path.join(root, side, 'input2.bin'), `input2.bin:same`);
    writeJson(path.join(root, side, 'source.json'), { files: [{ file: 'source.txt', sha256: sha(path.join(root, side, 'source.txt')) }] });
    writeJson(path.join(root, side, 'input.json'), { files: ['input.bin', 'input2.bin'].map(file => ({ file, sha256: sha(path.join(root, side, file)) })) });
    writeJson(path.join(root, side, 'trace.json'), { side });
  }
  const pcm = path.join(root, 'capture', 'capture.wav'), packets = path.join(root, 'capture', 'packets.csv'), callbacks = path.join(root, 'capture', 'callbacks.csv'), calibration = path.join(root, 'capture', 'calibration.json');
  const frames = 50000; writeWav(pcm, frames);
  write(packets, `file_frame,qpc_100ns,frames\n${Array.from({ length: Math.ceil(frames / 480) }, (_, index) => { const frame = index * 480; return `${frame},${Math.round(frame * 10000000 / 48000)},${Math.min(480, frames - frame)}`; }).join('\n')}\n`);
  write(callbacks, 'sequence,callback_qpc_100ns,playback_qpc_100ns,output_frames,engine_start,engine_end,paused,audition,render_lock_miss,trace_dropped\n1,0,0,480,0,1000,0,0,0,0\n2,100000,100000,480,1000,2000,0,0,0,0\n');
  const calibrationPackets = path.join(root, 'capture', 'calibration-packets.csv'), calibrationCallbacks = path.join(root, 'capture', 'calibration-callbacks.csv');
  write(calibrationPackets, fs.readFileSync(packets)); write(calibrationCallbacks, fs.readFileSync(callbacks));
  const next = { id: '7', label: 'next-7', source_generation: 9, target_source_generation: 10, active_index: 0, target_index: 1, active_preview: false, active_head_only: false, target_preview: false, target_head_only: false, request_engine_frame: 441, request_active_playhead_frame: 220, plan_generation: 8, plan_engine_frame: 442, plan_start_frame: 430, entry_frame: 12, transition_engine_frame: 500, fade_end_engine_frame: 600, engine_rate: 48000, reason: 'manual', simple: false };
  const endpointReceipt = path.join(root, 'capture', 'endpoint-receipt.json');
  writeJson(endpointReceipt, { schema: 1, run_id: 'capture-run', process_id: 42, stream: { endpoint_id: 'loopback-a', rate: 48000, channels: 2, sample_format: 'f32' }, session: { before: { process_id: 42, endpoint_id: 'loopback-a', rate: 48000, channels: 2, sample_format: 'f32', session_id: 'session-a' }, after: { process_id: 42, endpoint_id: 'loopback-a', rate: 48000, channels: 2, sample_format: 'f32', session_id: 'session-a' } } });
  const endpoint = { file: 'capture/endpoint-receipt.json', sha256: sha(endpointReceipt) };
  const inputHashes = ['input.bin', 'input2.bin'].map(file => sha(path.join(root, 'capture', file)));
  const inputHash = crypto.createHash('sha256').update(JSON.stringify(['input.bin', 'input2.bin'].map((file, index) => ({ file, sha256: inputHashes[index] })))).digest('hex');
  const negativeReference = path.join(root, 'capture', 'negative-reference.wav'), secondReference = path.join(root, 'capture', 'second-reference.wav');
  copyWav(negativeReference, pcm, 0.001); copyWav(secondReference, pcm, 0.002);
  const transientPcm = path.join(root, 'capture', 'control-pcm_transient.wav'), dropoutPcm = path.join(root, 'capture', 'control-dropout.wav');
  copyWav(transientPcm, pcm, 0.003); copyWav(dropoutPcm, pcm, 0.004);
  const descriptor = file => ({ file: path.basename(file), sha256: sha(file) });
  const provenance = () => ({ capture: descriptor(pcm), reference: descriptor(negativeReference), packets: descriptor(calibrationPackets), callbacks: descriptor(calibrationCallbacks), endpoint_receipt: descriptor(endpointReceipt), runId: 'capture-run', processId: 42 });
  writeJson(calibration, { schema: 3, rate: 48000, windowFrames: 96, baseline: { aSha256: sha(negativeReference), bSha256: sha(secondReference) }, provenance: { detectorSha256: sha(detector), a: provenance(), b: { ...provenance(), reference: descriptor(secondReference) } } });
  const makeScan = (classification, audioPcm, reference, firstFrame = 0) => ({ schema: 1, classification, ...(classification === 'clean' ? {} : { first: { classification, frame: firstFrame } }), captureFrames: frames, inputSha256: sha(audioPcm), calibrationSha256: sha(calibration), packetSha256: sha(packets), callbackSha256: sha(callbacks), endpointReceiptSha256: endpoint.sha256, referenceSha256: sha(reference), coverage: { total_windows: 1, audio_windows: 1, intentional_windows: 0, unclassified_windows: 0, complete: true, ranges: [{ start: 0, end: frames, kind: 'audio' }] } });
  const controls = [];
  for (const [kind, classification, controlPcm] of [['negative', 'clean', pcm], ['pcm_transient', 'pcm_transient', transientPcm], ['dropout', 'dropout', dropoutPcm]]) {
    const control = path.join(root, 'capture', `control-${kind}.json`), audio = { pcm: descriptor(controlPcm), reference: descriptor(negativeReference), packets: descriptor(calibrationPackets), callbacks: descriptor(calibrationCallbacks) };
    writeJson(control, { ...makeScan(classification, controlPcm, negativeReference), packetSha256: sha(calibrationPackets), callbackSha256: sha(calibrationCallbacks) });
    const item = { kind, scan: descriptor(control), audio };
    if (kind !== 'negative') { const injection = path.join(root, 'capture', `injection-${kind}.json`); writeJson(injection, { schema: 1, type: kind === 'dropout' ? 'dropout24' : kind, frame: 0, amplitude: 0.5, input_sha256: sha(pcm), output_sha256: sha(controlPcm) }); item.injection = descriptor(injection); }
    controls.push(item);
  }
  const calibrationReceipt = path.join(root, 'capture', 'calibration-receipt.json');
  writeJson(calibrationReceipt, { schema: 1, detector_calibration_sha256: sha(calibration), endpoint_receipt: { file: 'endpoint-receipt.json', sha256: sha(endpointReceipt) }, controls });
  const sourceReceipt = path.join(root, 'capture', 'source-receipt.json');
  writeJson(sourceReceipt, { schema: 1, mode: 'fixed_input', run_id: 'capture-run', before: { input_sha256: inputHash, revision: 'fixed-revision' }, after: { input_sha256: inputHash, revision: 'fixed-revision' }, source_edits: 0, ordered_input_hashes: inputHashes });
  const capture = {
    schema: 1,
    identities: { source: { manifest: 'capture/source.json' }, core: { file: 'capture/core.bin' }, binary: { file: 'capture/binary.bin' }, input: { manifest: 'capture/input.json' } }, core_git: 'synthetic-core-revision',
    trace: { file: 'capture/trace.json' }, header: { file: 'capture/header.json' }, audio: { pcm: { file: 'capture/capture.wav' }, packets: { file: 'capture/packets.csv' }, callbacks: { file: 'capture/callbacks.csv' }, capture_rate: 48000 },
    endpoint_receipt: endpoint, calibration: { file: 'capture/calibration.json', sha256: sha(calibration), receipt: { file: 'capture/calibration-receipt.json', sha256: sha(calibrationReceipt) } }, source_receipt: { file: 'capture/source-receipt.json', sha256: sha(sourceReceipt) }
  };
  const markers = [];
  const replay = { schema: 1, identities: { source: { manifest: 'replay/source.json' }, core: { file: 'replay/core.bin' }, input: { manifest: 'replay/input.json' } }, trace: { file: 'replay/trace.json' }, replay_executable: { file: 'replay/binary.bin' }, driver_source: { file: 'replay/driver.rs' }, core_git: 'synthetic-core-revision' };
  writeJson(path.join(root, 'capture', 'header.json'), { run_id: 'capture-run', process_id: 42, options: { output_sample_rate: 48000, cache_dir: 'capture-only', loop_playlist: true }, input: { content_hashes: inputHashes } });
  const trace = [
    { kind: 'requested', request_id: 1, label: 'next-1', action: 'transition_to_next' },
    { kind: 'accepted', generation: 7, action: 'next', render_frame: 441, active_playhead: 220, current_index: 0, source_generation: 9, target_index: 1, target_source_generation: 10, active_preview: false, active_head_only: false, target_preview: false, target_head_only: false },
    { kind: 'plan_applied', generation: 7, source_generation: 9, target_source_generation: 10, current_index: 0, target_index: 1, render_frame: 442, plan: { generation: 7, start: 430, entry: 12, simple: false, reason: 'manual' } },
    { kind: 'transition_started', generation: 7, source_generation: 9, target_source_generation: 10, current_index: 0, target_index: 1, render_frame: 500 }, { kind: 'fade_completed', generation: 7, source_generation: 9, target_source_generation: 10, current_index: 0, target_index: 1, render_frame: 600 },
    { kind: 'capture_end', callback_records_dropped: 0, trace_dropped: 0, last_callback_sequence: 2, last_playback_qpc_100ns: 100000, last_output_frames: 480, last_engine_frame: 2000 }
  ];
  write(path.join(root, 'capture', 'trace.json'), `${trace.map(JSON.stringify).join('\n')}\n`);
  const replayTrace = { navigation_trace: trace.slice(1, -1), navigation_trace_dropped: 0, options: { output_sample_rate: 48000 }, engine_options: { output_sample_rate: 48000, cache_dir: 'replay-only', loop_playlist: false }, input: { content_hashes: inputHashes }, core_source_sha256: sha(path.join(root, 'replay', 'core.bin')), executable_sha256: sha(path.join(root, 'replay', 'binary.bin')), driver_source_sha256: sha(path.join(root, 'replay', 'driver.rs')), runtime: { core_revision: 'synthetic-core-revision' }, audio: { file: 'capture/capture.wav', sample_rate: 48000, engine_start_frame: 0 } };
  writeJson(path.join(root, 'replay', 'trace.json'), replayTrace);
  const captureFile = path.join(root, 'capture.json'), replayFile = path.join(root, 'replay.json'), scanFile = path.join(root, 'scan.json');
  writeJson(captureFile, capture); writeJson(replayFile, replay);
  writeJson(scanFile, makeScan('clean', pcm, pcm));
  return { root, capture, captureFile, replay, replayFile, replayTrace, replayTraceFile: path.join(root, 'replay', 'trace.json'), scanFile, markers };
}

function run(input, scan = input.scanFile) {
  const output = path.join(input.root, `result-${Math.random()}.json`);
  execFileSync(process.execPath, [detector, 'compare', input.captureFile, input.replayFile, scan, output], { stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(output, 'utf8'));
}
function compare(input, scan = input.scanFile) { return compareEvidence({ captureManifestPath: input.captureFile, replayPath: input.replayFile, scanPath: scan }); }
function save(input) { writeJson(input.captureFile, input.capture); writeJson(input.replayFile, input.replay); }
function saveReplayTrace(input) { writeJson(input.replayTraceFile, input.replayTrace); }

test('an empty endpoint object cannot establish a clean comparison', t => {
  const input = fixture(t);
  const baseline = compare(input);
  assert.equal(baseline.classification, 'comparable', JSON.stringify(baseline));
  delete input.capture.endpoint_receipt;
  input.capture.endpoint = {};
  input.capture.calibration.endpoint = {};
  save(input);
  const result = compare(input);
  assert.equal(result.classification, 'incomplete', JSON.stringify(result));
});

test('the endpoint receipt run must bind the capture header', t => {
  const input = fixture(t), headerFile = path.join(input.root, 'capture', 'header.json');
  const header = JSON.parse(fs.readFileSync(headerFile, 'utf8'));
  header.run_id = 'old-run';
  writeJson(headerFile, header);
  assert.equal(compare(input).classification, 'condition_mismatch');
});

test('the endpoint receipt process must bind the capture header', t => {
  const input = fixture(t), headerFile = path.join(input.root, 'capture', 'header.json');
  const header = JSON.parse(fs.readFileSync(headerFile, 'utf8'));
  header.process_id = 99;
  writeJson(headerFile, header);
  assert.equal(compare(input).classification, 'condition_mismatch');
});

test('independent runs may have different navigation generations and engine origins', t => {
  const input = fixture(t);
  for (const event of input.replayTrace.navigation_trace) {
    event.generation += 13;
    event.render_frame += 7571;
    if (event.plan) event.plan.generation += 13;
  }
  saveReplayTrace(input);
  assert.equal(run(input).classification, 'comparable');
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
  const traceFile = path.join(input.root, 'capture', 'trace.json');
  const trace = fs.readFileSync(traceFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  Object.assign(trace.at(-1), { last_callback_sequence: advances.length + 1, last_playback_qpc_100ns: advances.length * 100000, last_output_frames: 480, last_engine_frame: engine });
  write(traceFile, `${trace.map(JSON.stringify).join('\n')}\n`);
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

test('same-condition fixture has a measured no-anomaly sound result', t => {
  const input = fixture(t), good = run(input);
  assert.equal(good.pcmMeasurement.classification, 'measured', JSON.stringify(good.pcmMeasurement));
  assert.deepEqual({ classification: good.classification, soundQuality: good.soundQuality, comparable: good.comparable }, { classification: 'comparable', soundQuality: 'no_anomaly_detected', comparable: true });
  const traceFile = path.join(input.root, 'capture', 'trace.json');
  const rows = fs.readFileSync(traceFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse).filter(row => row.kind !== 'fade_completed'); write(traceFile, `${rows.map(JSON.stringify).join('\n')}\n`);
  assert.equal(run(input).classification, 'incomplete');
});

test('a deliberate 44100-to-48000 mapping remains comparable but cannot pass sound quality', t => {
  const input = fixture(t), headerFile = path.join(input.root, 'capture', 'header.json');
  const header = JSON.parse(fs.readFileSync(headerFile, 'utf8'));
  header.options.output_sample_rate = 44100;
  writeJson(headerFile, header);
  input.replayTrace.options.output_sample_rate = 44100;
  input.replayTrace.engine_options.output_sample_rate = 44100;
  saveReplayTrace(input);
  const result = compare(input);
  assert.equal(result.classification, 'comparable');
  assert.equal(result.soundQuality, 'incomplete');
  assert.ok(result.soundQualityFindings.some(finding => finding.code === 'same_condition_pcm_scope'));
});

test('the target scan binds the measured replay WAV instead of calibration raw baselines', t => {
  const input = fixture(t);
  const calibration = JSON.parse(fs.readFileSync(path.join(input.root, 'capture', 'calibration.json'), 'utf8'));
  const scan = JSON.parse(fs.readFileSync(input.scanFile, 'utf8'));
  const result = compare(input);
  assert.notEqual(scan.referenceSha256, calibration.baseline.aSha256);
  assert.equal(scan.referenceSha256, result.pcmMeasurement.replayWavSha256);
  assert.equal(result.classification, 'comparable');
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
  const result = compare(input);
  assert.equal(result.classification, 'condition_mismatch');
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
  assert.equal(run(input).classification, 'comparable');
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
  assert.notEqual(run(input).classification, 'comparable');
});

test('endpoint and calibration must remain bound', t => {
  const input = fixture(t), receiptFile = path.join(input.root, 'capture', 'calibration-receipt.json');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  const endpointFile = path.join(input.root, 'capture', 'other-endpoint.json');
  writeJson(endpointFile, { schema: 1, run_id: 'calibration-run', process_id: 42, stream: { endpoint_id: 'other', rate: 48000, channels: 2, sample_format: 'f32' }, session: { before: { process_id: 42, endpoint_id: 'other', rate: 48000, channels: 2, sample_format: 'f32', session_id: 'session-b' }, after: { process_id: 42, endpoint_id: 'other', rate: 48000, channels: 2, sample_format: 'f32', session_id: 'session-b' } } });
  receipt.endpoint_receipt = { file: 'other-endpoint.json', sha256: sha(endpointFile) };
  writeJson(receiptFile, receipt); input.capture.calibration.receipt.sha256 = sha(receiptFile); save(input);
  const result = compare(input);
  assert.equal(result.classification, 'comparable');
  assert.equal(result.soundQuality, 'incomplete');
});

test('44100 engine frames are not treated as 48000 capture frames', t => {
  const input = fixture(t); writeJson(path.join(input.root, 'capture', 'header.json'), { run_id: 'capture-run', process_id: 42, options: { output_sample_rate: 44100 }, input: { content_hashes: [sha(path.join(input.root, 'capture', 'input.bin'))] } });
  const result = run(input);
  assert.equal(result.classification, 'condition_mismatch');
});

test('a run without a calibrated scan remains comparable but has incomplete sound quality', t => {
  const input = fixture(t), result = run(input, '-');
  assert.deepEqual({ classification: result.classification, soundQuality: result.soundQuality, comparable: result.comparable }, { classification: 'comparable', soundQuality: 'incomplete', comparable: true });
});

test('missing calibration preserves independently verified plan and PCM evidence', t => {
  const input = fixture(t);
  delete input.capture.calibration;
  save(input);
  const result = compare(input, '-');
  assert.equal(result.classification, 'comparable');
  assert.equal(result.soundQuality, 'incomplete');
  assert.equal(result.calibration.classification, 'incomplete');
  assert.equal(result.pcmMeasurement.classification, 'measured');
  assert.equal(result.pcmAlignment.classification, 'measured');
});

test('a malformed supplied scan fails closed even when calibration is unavailable', t => {
  const input = fixture(t);
  delete input.capture.calibration;
  save(input);
  writeJson(input.scanFile, { schema: 2 });
  const result = compare(input);
  assert.equal(result.classification, 'incomplete');
  assert.equal(result.soundQuality, 'incomplete');
  assert.equal(result.comparable, false);
});

test('a partial scan cannot produce a sound-quality result', t => {
  const input = fixture(t), scan = JSON.parse(fs.readFileSync(input.scanFile, 'utf8'));
  scan.coverage.complete = false;
  writeJson(input.scanFile, scan);
  const result = compare(input);
  assert.equal(result.classification, 'incomplete');
  assert.equal(result.soundQuality, 'incomplete');
});

test('a schema-valid incomplete state scan preserves plan and PCM evidence', t => {
  const input = fixture(t), scan = JSON.parse(fs.readFileSync(input.scanFile, 'utf8'));
  scan.classification = 'incomplete';
  scan.first = { classification: 'incomplete', problems: [{ code: 'callback_coverage' }] };
  scan.coverage = { total_windows: 0, audio_windows: 0, intentional_windows: 0, unclassified_windows: 1, complete: false, ranges: [{ start: 0, end: 50000, kind: 'unclassified' }] };
  writeJson(input.scanFile, scan);
  const result = compare(input);
  assert.equal(result.classification, 'comparable');
  assert.equal(result.soundQuality, 'incomplete');
  assert.equal(result.pcmMeasurement.classification, 'measured');
  assert.equal(result.scanObservation.classification, 'incomplete');
  assert.equal(result.scanObservation.coverage.unclassified_windows, 1);
});

test('a clean scan with anomaly evidence is not a no-anomaly result', t => {
  const input = fixture(t), scan = JSON.parse(fs.readFileSync(input.scanFile, 'utf8'));
  scan.first = { classification: 'pcm_transient' };
  writeJson(input.scanFile, scan);
  assert.equal(compare(input).soundQuality, 'incomplete');
});

test('a scan first classification cannot contradict its top-level classification', t => {
  const input = fixture(t), scan = JSON.parse(fs.readFileSync(input.scanFile, 'utf8'));
  scan.classification = 'dropout';
  scan.first = { classification: 'pcm_transient' };
  writeJson(input.scanFile, scan);
  const result = compare(input);
  assert.equal(result.classification, 'incomplete');
  assert.equal(result.soundQuality, 'incomplete');
});

test('a measured dropout scan reports an anomaly', t => {
  const input = fixture(t), scan = JSON.parse(fs.readFileSync(input.scanFile, 'utf8'));
  scan.classification = 'dropout';
  scan.first = { classification: 'dropout' };
  writeJson(input.scanFile, scan);
  assert.equal(compare(input).soundQuality, 'anomaly_detected');
});

test('a capture-fault scan cannot become a sound-quality pass', t => {
  const input = fixture(t), scan = JSON.parse(fs.readFileSync(input.scanFile, 'utf8'));
  scan.classification = 'capture_fault';
  writeJson(input.scanFile, scan);
  const result = compare(input);
  assert.equal(result.classification, 'capture_fault');
  assert.equal(result.soundQuality, 'incomplete');
});

test('a scan reference must bind a calibrated raw baseline', t => {
  const input = fixture(t), scan = JSON.parse(fs.readFileSync(input.scanFile, 'utf8'));
  scan.referenceSha256 = '0'.repeat(64);
  writeJson(input.scanFile, scan);
  assert.equal(compare(input).classification, 'condition_mismatch');
});

test('a missing calibration control is incomplete', t => {
  const input = fixture(t), receiptFile = path.join(input.root, 'capture', 'calibration-receipt.json');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  receipt.controls.pop();
  writeJson(receiptFile, receipt); input.capture.calibration.receipt.sha256 = sha(receiptFile); save(input);
  const result = compare(input);
  assert.equal(result.classification, 'comparable');
  assert.equal(result.soundQuality, 'incomplete');
});

test('a transient calibration control requires matching first evidence', t => {
  const input = fixture(t), controlFile = path.join(input.root, 'capture', 'control-pcm_transient.json');
  const control = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
  delete control.first;
  writeJson(controlFile, control);
  const receiptFile = path.join(input.root, 'capture', 'calibration-receipt.json');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  receipt.controls.find(item => item.kind === 'pcm_transient').scan.sha256 = sha(controlFile);
  writeJson(receiptFile, receipt); input.capture.calibration.receipt.sha256 = sha(receiptFile); save(input);
  const result = compare(input);
  assert.equal(result.classification, 'comparable');
  assert.equal(result.soundQuality, 'incomplete');
});

test('a positive calibration control cannot alias the negative capture', t => {
  const input = fixture(t), receiptFile = path.join(input.root, 'capture', 'calibration-receipt.json');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  const negative = receipt.controls.find(item => item.kind === 'negative');
  receipt.controls.find(item => item.kind === 'pcm_transient').audio.pcm = negative.audio.pcm;
  writeJson(receiptFile, receipt); input.capture.calibration.receipt.sha256 = sha(receiptFile); save(input);
  const result = compare(input);
  assert.equal(result.classification, 'comparable');
  assert.equal(result.soundQuality, 'incomplete');
});

test('a control descriptor hash must match its PCM bytes', t => {
  const input = fixture(t), pcmFile = path.join(input.root, 'capture', 'control-dropout.wav');
  copyWav(pcmFile, pcmFile, 0.01);
  const result = compare(input);
  assert.equal(result.classification, 'comparable');
  assert.equal(result.soundQuality, 'incomplete');
});

test('a duplicate fixed-input content occurrence is incomplete', t => {
  const input = fixture(t), receiptFile = path.join(input.root, 'capture', 'source-receipt.json');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  receipt.ordered_input_hashes[1] = receipt.ordered_input_hashes[0];
  writeJson(receiptFile, receipt); input.capture.source_receipt.sha256 = sha(receiptFile); save(input);
  assert.equal(compare(input).classification, 'incomplete');
});

test('a changed fixed-input revision is incomplete', t => {
  const input = fixture(t), receiptFile = path.join(input.root, 'capture', 'source-receipt.json');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  receipt.after.revision = 'changed-revision';
  writeJson(receiptFile, receipt); input.capture.source_receipt.sha256 = sha(receiptFile); save(input);
  assert.equal(compare(input).classification, 'incomplete');
});

test('a fixed-input receipt that records edits is incomplete', t => {
  const input = fixture(t), receiptFile = path.join(input.root, 'capture', 'source-receipt.json');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  receipt.source_edits = 1;
  writeJson(receiptFile, receipt); input.capture.source_receipt.sha256 = sha(receiptFile); save(input);
  assert.equal(compare(input).classification, 'incomplete');
});

test('a capture without its end record is incomplete', t => {
  const input = fixture(t), traceFile = path.join(input.root, 'capture', 'trace.json');
  const rows = fs.readFileSync(traceFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse).filter(row => row.kind !== 'capture_end');
  write(traceFile, `${rows.map(JSON.stringify).join('\n')}\n`);
  assert.equal(compare(input).classification, 'incomplete');
});

test('a capture ending after the fade but outside packet coverage is incomplete', t => {
  const input = fixture(t), callbacksFile = path.join(input.root, 'capture', 'callbacks.csv'), traceFile = path.join(input.root, 'capture', 'trace.json');
  const callbacks = fs.readFileSync(callbacksFile, 'utf8').trim().split(/\r?\n/);
  callbacks[2] = callbacks[2].replace(',100000,100000,480,', ',100000,20000000,480,');
  write(callbacksFile, `${callbacks.join('\n')}\n`);
  const trace = fs.readFileSync(traceFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  trace.at(-1).last_playback_qpc_100ns = 20000000;
  write(traceFile, `${trace.map(JSON.stringify).join('\n')}\n`);
  assert.equal(compare(input, '-').classification, 'incomplete');
});

test('changed production source mapping in a transition is incomplete', t => {
  const input = fixture(t), traceFile = path.join(input.root, 'capture', 'trace.json');
  const trace = fs.readFileSync(traceFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  trace.find(row => row.kind === 'transition_started').target_index = 0;
  write(traceFile, `${trace.map(JSON.stringify).join('\n')}\n`);
  assert.equal(compare(input, '-').classification, 'incomplete');
});

test('a cancelled generation makes fixed-input navigation incomplete', t => {
  const input = fixture(t), traceFile = path.join(input.root, 'capture', 'trace.json');
  const trace = fs.readFileSync(traceFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  trace.splice(-1, 0, { kind: 'cancelled', generation: 6 });
  write(traceFile, `${trace.map(JSON.stringify).join('\n')}\n`);
  assert.equal(compare(input, '-').classification, 'incomplete');
});

test('unavailable real PCM alignment leaves sound quality incomplete', t => {
  const input = fixture(t);
  delete input.replayTrace.audio;
  saveReplayTrace(input);
  const result = compare(input);
  assert.equal(result.classification, 'comparable');
  assert.equal(result.soundQuality, 'incomplete');
});
