const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { RATE, wav, localOffset } = require('./audio-anomaly-detector.cjs');

const QPC_PER_SECOND = 10000000n;
const navigationFields = [
  'source_generation', 'target_source_generation', 'active_index', 'target_index', 'active_preview', 'active_head_only', 'target_preview', 'target_head_only',
  'request_engine_frame', 'request_active_playhead_frame', 'plan_generation',
  'plan_start_frame', 'entry_frame',
  'transition_engine_frame', 'fade_end_engine_frame', 'engine_rate', 'reason', 'simple'
];

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fail(message) { throw new Error(message); }
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
}
function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a non-negative safe integer`);
  return value;
}
function json(file, name) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`${name} is unreadable: ${error.message}`); }
}
function file(base, descriptor, name) {
  object(descriptor, name);
  if (typeof descriptor.file !== 'string' || !descriptor.file) fail(`${name}.file is required`);
  const resolved = path.resolve(base, descriptor.file);
  if (!fs.statSync(resolved).isFile()) fail(`${name}.file is not a file`);
  return { sha256: hash(resolved), file: resolved };
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }
function fraction(numerator, denominator = 1n) {
  if (denominator <= 0n) fail('invalid rational denominator');
  if (numerator === 0n) return { numerator: '0', denominator: '1' };
  const divisor = gcd(numerator < 0n ? -numerator : numerator, denominator);
  return { numerator: (numerator / divisor).toString(), denominator: (denominator / divisor).toString() };
}
function addFraction(left, right) {
  return fraction(BigInt(left.numerator) * BigInt(right.denominator) + BigInt(right.numerator) * BigInt(left.denominator), BigInt(left.denominator) * BigInt(right.denominator));
}
function subtractFraction(left, right) {
  return fraction(BigInt(left.numerator) * BigInt(right.denominator) - BigInt(right.numerator) * BigInt(left.denominator), BigInt(left.denominator) * BigInt(right.denominator));
}
function compareFraction(left, right) {
  return BigInt(left.numerator) * BigInt(right.denominator) - BigInt(right.numerator) * BigInt(left.denominator);
}
function identity(base, descriptor, name) {
  object(descriptor, name);
  if (descriptor.file) return file(base, descriptor, name);
  if (typeof descriptor.manifest !== 'string' || !descriptor.manifest) fail(`${name} requires file or manifest`);
  const manifest = file(base, { file: descriptor.manifest }, `${name}.manifest`);
  const contents = json(manifest.file, `${name}.manifest`);
  if (!Array.isArray(contents.files) || !contents.files.length) fail(`${name}.manifest.files is required`);
  const entries = contents.files.map((entry, index) => {
    object(entry, `${name}.manifest.files[${index}]`);
    if (typeof entry.file !== 'string' || typeof entry.sha256 !== 'string') fail(`${name}.manifest.files[${index}] requires file and sha256`);
    const actual = file(path.dirname(manifest.file), entry, `${name}.manifest.files[${index}]`);
    if (actual.sha256 !== entry.sha256) fail(`${name}.manifest hash does not match ${entry.file}`);
    return { file: entry.file, sha256: actual.sha256 };
  }).sort((left, right) => left.file.localeCompare(right.file));
  return { sha256: crypto.createHash('sha256').update(canonical(entries)).digest('hex'), manifestSha256: manifest.sha256, files: entries };
}
function identityHashes(identityValue) { return identityValue.files ? identityValue.files.map(file => file.sha256).sort() : [identityValue.sha256]; }
function numericCsv(fileName, required, name) {
  const lines = fs.readFileSync(fileName, 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#'));
  if (!lines.length) fail(`${name} is empty`);
  const headers = lines.shift().split(',');
  if (headers.length !== new Set(headers).size || required.some(column => !headers.includes(column))) fail(`${name} headers are invalid`);
  return lines.map((line, index) => {
    const values = line.split(',');
    if (values.length !== headers.length || values.some(value => !/^\d+$/.test(value))) fail(`${name} row ${index + 2} is not numeric CSV`);
    return Object.fromEntries(headers.map((header, column) => [header, Number(values[column])]));
  });
}
function callbackCsv(fileName) {
  const required = ['sequence', 'callback_qpc_100ns', 'playback_qpc_100ns', 'output_frames', 'engine_start', 'engine_end', 'paused', 'audition', 'render_lock_miss', 'trace_dropped'];
  const lines = fs.readFileSync(fileName, 'utf8').split(/\r?\n/).filter(Boolean);
  if (!lines.length || lines.shift() !== required.join(',')) fail('callbacks headers are invalid');
  return lines.map((line, index) => {
    const values = line.split(',');
    if (values.length !== required.length || values.some(value => value !== '' && !/^\d+$/.test(value))) fail(`callbacks row ${index + 2} is not numeric CSV`);
    if ((values[4] === '') !== (values[5] === '')) fail(`callbacks row ${index + 2} has one engine bound`);
    return Object.fromEntries(required.map((name, column) => [name, values[column] === '' ? null : Number(values[column])]));
  });
}
function jsonLines(fileName, name) {
  const lines = fs.readFileSync(fileName, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines.map((line, index) => { try { return JSON.parse(line); } catch (error) { fail(`${name} row ${index + 1} is invalid JSON: ${error.message}`); } });
}
function field(record, name) { if (!(name in record)) fail(`navigation event ${record.kind} is missing ${name}`); return record[name]; }
function requestedLabels(rows, findings) {
  const requests = [], accepted = [];
  for (const event of rows) {
    if (event.kind === 'requested') {
      if (!Number.isSafeInteger(event.request_id) || typeof event.label !== 'string' || event.label !== `next-${event.request_id}` || event.action !== 'transition_to_next') record(findings, 'incomplete', 'request_record_invalid');
      else requests.push(event);
    }
    if (event.kind === 'accepted') {
      if (!['next', 'transition_to_next'].includes(String(event.action).toLowerCase())) record(findings, 'incomplete', 'accepted_action_not_next');
      accepted.push(event);
    }
  }
  if (requests.length !== 1 || accepted.length !== 1) record(findings, 'incomplete', 'representative_next_ambiguous');
  const labels = new Map();
  if (requests.length === 1 && accepted.length === 1) labels.set(String(accepted[0].generation), requests[0].label);
  return labels;
}
function navigationOperations(rows, engineRate, findings, requestLabels = new Map()) {
  const groups = new Map();
  let acceptedCount = 0;
  for (const event of rows) {
    if (event.kind === 'requested') continue;
    if (typeof event.kind !== 'string' || !('generation' in event)) fail('navigation trace event is malformed');
    const id = String(event.generation), kind = event.kind.toLowerCase();
    if (kind === 'accepted') {
      acceptedCount++;
      if (['next', 'transition_to_next'].includes(String(event.action).toLowerCase())) groups.set(id, { accepted: event });
    }
    else if (groups.has(id)) groups.get(id)[kind] = event;
  }
  const navigation = [];
  for (const [id, group] of groups) {
    const { accepted, plan_applied: applied, transition_started: transition, fade_completed: fade } = group;
    if (!applied || !transition || !fade) { record(findings, 'incomplete', 'navigation_trace_missing', { id }); continue; }
    const plan = field(applied, 'plan');
    const operation = { id, label: `next-${id}`, ...(requestLabels.has(id) ? { requestLabel: requestLabels.get(id) } : {}), source_generation: field(accepted, 'source_generation'), target_source_generation: field(accepted, 'target_source_generation'), active_index: field(accepted, 'current_index'), target_index: field(accepted, 'target_index'), active_preview: field(accepted, 'active_preview'), active_head_only: field(accepted, 'active_head_only'), target_preview: field(accepted, 'target_preview'), target_head_only: field(accepted, 'target_head_only'), request_engine_frame: field(accepted, 'render_frame'), request_active_playhead_frame: field(accepted, 'active_playhead'), plan_generation: field(plan, 'generation'), plan_engine_frame: field(applied, 'render_frame'), plan_start_frame: field(plan, 'start'), entry_frame: field(plan, 'entry'), transition_engine_frame: field(transition, 'render_frame'), fade_end_engine_frame: field(fade, 'render_frame'), engine_rate: engineRate, reason: field(plan, 'reason'), simple: field(plan, 'simple') };
    if (operation.plan_engine_frame > operation.transition_engine_frame) record(findings, 'incomplete', 'plan_after_transition', { id });
    navigation.push(operation);
  }
  if (acceptedCount !== 1 || navigation.length !== 1) record(findings, 'incomplete', navigation.length ? 'representative_next_ambiguous' : 'navigation_missing');
  return navigation;
}
function captureOperations(traceFile, callbackFile, headerFile, findings) {
  const header = json(headerFile, 'navigation header'), engineRate = header.options?.output_sample_rate;
  integer(engineRate, 'navigation header engine rate');
  const callbacks = callbackCsv(callbackFile), clock = [], transport = [];
  if (!callbacks.length) fail('callbacks are empty');
  let previousPaused = callbacks[0].paused, previousSequence = callbacks[0].sequence;
  for (const [index, callback] of callbacks.entries()) {
    if ((index && callback.sequence !== previousSequence + 1) || ![0, 1].includes(callback.paused) || ![0, 1].includes(callback.render_lock_miss) || callback.trace_dropped !== 0) record(findings, 'incomplete', 'callback_observation_invalid');
    if (callback.render_lock_miss) record(findings, 'capture_fault', 'render_lock_miss');
    if (callback.paused && callback.engine_start !== null && callback.engine_end !== callback.engine_start) record(findings, 'capture_fault', 'paused_engine_advanced');
    if (callback.engine_start !== null && callback.engine_end > callback.engine_start) clock.push({ engine_start_frame: callback.engine_start, engine_end_frame: callback.engine_end, playback_qpc_100ns: callback.playback_qpc_100ns });
    if (index && callback.paused !== previousPaused) transport.push({ id: `${callback.paused ? 'pause' : 'resume'}-${callback.sequence}`, label: callback.paused ? 'pause' : 'resume', playback_qpc_100ns: callback.playback_qpc_100ns });
    previousPaused = callback.paused;
    previousSequence = callback.sequence;
  }
  const rows = jsonLines(traceFile, 'navigation trace'), footer = rows.pop();
  if (!footer || footer.kind !== 'capture_end') fail('navigation trace footer is missing');
  if (footer.callback_records_dropped !== 0 || footer.trace_dropped !== 0) record(findings, 'incomplete', 'trace_dropped');
  return { operations: navigationOperations(rows, engineRate, findings, requestedLabels(rows, findings)), callback_clock: clock, transport };
}
function wavInfo(fileName, name) {
  const bytes = fs.readFileSync(fileName);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') fail(`${name} is not a WAV file`);
  let channels, rate, bits, dataSize;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + size > bytes.length) fail(`${name} has a truncated chunk`);
    if (id === 'fmt ' && size >= 16) { channels = bytes.readUInt16LE(offset + 10); rate = bytes.readUInt32LE(offset + 12); bits = bytes.readUInt16LE(offset + 22); }
    if (id === 'data') dataSize = size;
    offset += 8 + size + size % 2;
  }
  if (!channels || !rate || !bits || dataSize === undefined || bits % 8 || dataSize % (channels * (bits / 8))) fail(`${name} has an invalid PCM layout`);
  return { frames: dataSize / (channels * (bits / 8)), rate };
}
function packetAnchors(packets, captureFrames) {
  if (packets.length < 2) fail('at least two packet anchors are required');
  let expected = 0;
  for (const [index, packet] of packets.entries()) {
    integer(packet.file_frame, `packets[${index}].file_frame`);
    integer(packet.frames, `packets[${index}].frames`);
    integer(packet.qpc_100ns, `packets[${index}].qpc_100ns`);
    if (packet.file_frame !== expected) fail('packet file_frame is discontinuous');
    if (index && packet.qpc_100ns <= packets[index - 1].qpc_100ns) fail('packet QPC is not increasing');
    expected += packet.frames;
  }
  if (expected !== captureFrames) fail('packet coverage does not match scan captureFrames');
}
function qpcToCaptureFrame(packets, qpc) {
  for (let index = 0; index + 1 < packets.length; index++) {
    const start = packets[index], end = packets[index + 1];
    const startQpc = fraction(BigInt(start.qpc_100ns));
    const endQpc = fraction(BigInt(end.qpc_100ns));
    if (compareFraction(qpc, startQpc) < 0 || compareFraction(qpc, endQpc) > 0) continue;
    const deltaQpc = subtractFraction(qpc, startQpc);
    const period = BigInt(end.qpc_100ns - start.qpc_100ns);
    return addFraction(fraction(BigInt(start.file_frame)), fraction(BigInt(end.file_frame - start.file_frame) * BigInt(deltaQpc.numerator), period * BigInt(deltaQpc.denominator)));
  }
  fail('QPC is outside a bounded packet interval');
}
function callbackQpc(clock, engineFrame, engineRate, name) {
  for (const [index, callback] of clock.entries()) {
    const start = integer(callback.engine_start_frame, `callback_clock[${index}].engine_start_frame`);
    const end = integer(callback.engine_end_frame, `callback_clock[${index}].engine_end_frame`);
    const qpc = integer(callback.playback_qpc_100ns, `callback_clock[${index}].playback_qpc_100ns`);
    if (end < start) fail(`callback_clock[${index}] is reversed`);
    if (engineFrame >= start && engineFrame <= end) return fraction(BigInt(qpc) * BigInt(engineRate) + BigInt(engineFrame - start) * QPC_PER_SECOND, BigInt(engineRate));
  }
  fail(`${name} is outside callback playback coverage`);
}
function mapFrameMarker(packets, clock, marker, operation, name) {
  const engineFrame = integer(marker.engine_frame, `${name}.engine_frame`);
  const qpc = callbackQpc(clock, engineFrame, integer(operation.engine_rate, `${name}.engine_rate`), name);
  const lower = qpcToCaptureFrame(packets, qpc);
  const upper = qpcToCaptureFrame(packets, qpc);
  if (compareFraction(lower, upper) > 0) fail(`${name} mapping is reversed`);
  return { lower, upper, uncertaintyFrames: subtractFraction(upper, lower), playbackQpc: qpc };
}
function record(findings, kind, code, detail) { findings.push({ kind, code, ...(detail ? { detail } : {}) }); }
function compareOperations(capture, replay, findings) {
  if (!Array.isArray(capture.operations) || !Array.isArray(replay.operations)) { record(findings, 'incomplete', 'operations_missing'); return []; }
  if (capture.operations.length !== replay.operations.length) record(findings, 'condition_mismatch', 'operation_count');
  const matching = [];
  for (let index = 0; index < Math.min(capture.operations.length, replay.operations.length); index++) {
    const observed = capture.operations[index], expected = replay.operations[index];
    if (!observed || !expected || typeof observed !== 'object' || typeof expected !== 'object') { record(findings, 'incomplete', 'operation_invalid', { index }); continue; }
    if (typeof observed.id !== 'string' || typeof observed.label !== 'string' || !observed.id || !observed.label || typeof expected.label !== 'string' || !expected.label) { record(findings, 'incomplete', 'operation_identity_missing', { index }); continue; }
    if (observed.label !== expected.label || (observed.label.startsWith('next-') && observed.id !== expected.id)) record(findings, 'condition_mismatch', 'operation_label_or_order', { index });
    if (observed.label.startsWith('next-')) {
      if (typeof observed.requestLabel !== 'string' || !/^next-\d+$/.test(observed.requestLabel)) record(findings, 'incomplete', 'request_label_missing', { index });
      for (const field of navigationFields) {
        if (!(field in observed) || !(field in expected)) { record(findings, 'incomplete', 'navigation_observation_missing', { index, field }); continue; }
        if (observed[field] !== expected[field]) record(findings, 'condition_mismatch', 'navigation_value', { index, field });
      }
      matching.push(observed);
    }
  }
  return matching;
}
function replayAudio(base, replay) {
  if (!replay.audio || typeof replay.audio.file !== 'string') return null;
  let directory = base;
  while (true) {
    const candidate = path.resolve(directory, replay.audio.file);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { file: candidate, sampleRate: replay.audio.sample_rate, engineStartFrame: replay.audio.engine_start_frame };
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
function fractionNumber(value) { return Number(BigInt(value.numerator)) / Number(BigInt(value.denominator)); }
function sameRateAlignment(captureFile, captureRate, replayTrace, replayBase, liveOperations, replayOperations, mapped) {
  const audio = replayAudio(replayBase, replayTrace);
  if (!audio) return { classification: 'incomplete', reason: 'replay_audio_missing' };
  if (!Number.isSafeInteger(audio.sampleRate) || !Number.isSafeInteger(audio.engineStartFrame)) return { classification: 'incomplete', reason: 'replay_audio_metadata_missing', replayWavSha256: hash(audio.file) };
  if (captureRate !== audio.sampleRate) return { classification: 'incomplete', reason: 'cross_rate_pcm_alignment', replayWavSha256: hash(audio.file), captureRate, replayRate: audio.sampleRate };
  if (captureRate !== RATE) return { classification: 'incomplete', reason: 'unsupported_same_rate', replayWavSha256: hash(audio.file), captureRate };
  const target = wav(captureFile), reference = wav(audio.file), windows = [];
  for (const field of ['request_engine_frame', 'transition_engine_frame', 'fade_end_engine_frame']) {
    const live = liveOperations[0], replayOperation = replayOperations[0], interval = mapped[`${live?.id}\u0000${field === 'request_engine_frame' ? 'accepted' : field === 'transition_engine_frame' ? 'transition_started' : 'fade_completed'}`];
    if (!live || !replayOperation || !interval) continue;
    const targetFrame = Math.round(fractionNumber(interval.lower));
    const referenceFrame = replayOperation[field] - audio.engineStartFrame;
    if (targetFrame < 0 || referenceFrame < 0 || targetFrame + RATE * 3 / 4 >= target.frames || referenceFrame + RATE * 3 / 4 >= reference.frames) continue;
    const match = localOffset(target, reference, targetFrame, referenceFrame);
    if (Number.isFinite(match.correlation)) windows.push({ field, captureFrame: targetFrame, replayFrame: referenceFrame, matchedReplayFrame: match.referenceFrame, correlation: match.correlation, offsetFrames: match.referenceFrame - referenceFrame });
  }
  if (windows.length < 2) return { classification: 'incomplete', reason: 'insufficient_local_windows', replayWavSha256: hash(audio.file), windows };
  const offsets = windows.map(window => window.offsetFrames);
  return { classification: 'measured', replayWavSha256: hash(audio.file), windows, residualFrames: { lower: Math.min(...offsets), upper: Math.max(...offsets), span: Math.max(...offsets) - Math.min(...offsets) } };
}
function comparableOptions(value) {
  object(value, 'engine options');
  const copy = { ...value };
  delete copy.cache_dir;
  delete copy.loop_playlist;
  return copy;
}
function traceBinding(trace, replay, replayBase, identities, replayExecutable, findings) {
  const inputHashes = trace.input?.content_hashes;
  if (!Array.isArray(inputHashes) || inputHashes.some(value => typeof value !== 'string')) record(findings, 'incomplete', 'replay_trace_input_hashes_missing');
  else if (canonical([...inputHashes].sort()) !== canonical(identityHashes(identities.replay.input))) record(findings, 'condition_mismatch', 'replay_trace_input_hashes');
  if (typeof trace.core_source_sha256 !== 'string') record(findings, 'incomplete', 'replay_trace_core_source_missing');
  else if (trace.core_source_sha256 !== identities.replay.core.sha256) record(findings, 'condition_mismatch', 'replay_trace_core_source');
  if (typeof trace.executable_sha256 !== 'string') record(findings, 'incomplete', 'replay_trace_executable_missing');
  else if (trace.executable_sha256 !== replayExecutable.sha256) record(findings, 'condition_mismatch', 'replay_trace_executable');
  if (!replay.driver_source) record(findings, 'incomplete', 'replay_driver_source_missing');
  else {
    const driver = identity(replayBase, replay.driver_source, 'replay.driver_source');
    if (typeof trace.driver_source_sha256 !== 'string') record(findings, 'incomplete', 'replay_trace_driver_source_missing');
    else if (trace.driver_source_sha256 !== driver.sha256) record(findings, 'condition_mismatch', 'replay_trace_driver_source');
  }
}
function compareEvidence({ captureManifestPath, replayPath, scanPath }) {
  const findings = [];
  try {
    const capture = json(captureManifestPath, 'capture manifest'), replay = json(replayPath, 'replay');
    const captureBase = path.dirname(captureManifestPath), replayBase = path.dirname(replayPath);
    if (capture.schema !== 1 || replay.schema !== 1) record(findings, 'incomplete', 'schema');
    object(capture.identities, 'capture.identities'); object(replay.identities, 'replay.identities');
    const identities = { capture: {}, replay: {} };
    for (const name of ['source', 'core', 'input']) {
      try {
        identities.capture[name] = identity(captureBase, capture.identities[name], `capture.identities.${name}`);
        identities.replay[name] = identity(replayBase, replay.identities[name], `replay.identities.${name}`);
        if (identities.capture[name].sha256 !== identities.replay[name].sha256) record(findings, 'condition_mismatch', 'identity', { name });
      } catch (error) { record(findings, 'incomplete', 'identity_unverified', { name, error: error.message }); }
    }
    try { identities.capture.binary = identity(captureBase, capture.identities.binary, 'capture.identities.binary'); }
    catch (error) { record(findings, 'incomplete', 'identity_unverified', { name: 'binary', error: error.message }); }
    const replayExecutable = identity(replayBase, replay.replay_executable, 'replay.replay_executable');
    const audio = object(capture.audio, 'capture.audio');
    const pcm = file(captureBase, audio.pcm, 'capture.audio.pcm');
    const packetsFile = file(captureBase, audio.packets, 'capture.audio.packets');
    const callbacks = file(captureBase, audio.callbacks, 'capture.audio.callbacks');
    const captureTrace = file(captureBase, capture.trace, 'capture.trace');
    const captureHeader = file(captureBase, capture.header, 'capture.header');
    const replayTrace = file(replayBase, replay.trace, 'replay.trace');
    const expectedTrace = json(replayTrace.file, 'replay trace');
    const calibration = object(capture.calibration, 'capture.calibration');
    const calibrationFile = file(captureBase, calibration, 'capture.calibration');
    try {
      object(capture.endpoint, 'capture.endpoint');
      object(calibration.endpoint, 'capture.calibration.endpoint');
      if (canonical(capture.endpoint) !== canonical(calibration.endpoint)) record(findings, 'condition_mismatch', 'endpoint_calibration');
    } catch (error) { record(findings, 'incomplete', 'endpoint_calibration_unverified', { error: error.message }); }
    const headerInputHashes = json(captureHeader.file, 'navigation header').input?.content_hashes;
    if (!Array.isArray(headerInputHashes) || headerInputHashes.some(value => typeof value !== 'string')) record(findings, 'incomplete', 'header_input_hashes_missing');
    else if (canonical([...headerInputHashes].sort()) !== canonical(identityHashes(identities.capture.input))) record(findings, 'condition_mismatch', 'header_input_hashes');
    const captureHeaderData = json(captureHeader.file, 'navigation header');
    const coreRevisions = [capture.core_git, replay.core_git, expectedTrace.runtime?.core_revision];
    if (coreRevisions.some(value => value !== undefined)) {
      if (coreRevisions.some(value => typeof value !== 'string')) record(findings, 'incomplete', 'core_git_unverified');
      else if (capture.core_git !== replay.core_git || replay.core_git !== expectedTrace.runtime.core_revision) record(findings, 'condition_mismatch', 'core_git');
    }
    if (!expectedTrace.engine_options) record(findings, 'incomplete', 'replay_trace_engine_options_missing');
    else if (canonical(comparableOptions(captureHeaderData.options)) !== canonical(comparableOptions(expectedTrace.engine_options))) record(findings, 'condition_mismatch', 'engine_options');
    traceBinding(expectedTrace, replay, replayBase, identities, replayExecutable, findings);
    const packets = numericCsv(packetsFile.file, ['file_frame', 'qpc_100ns', 'frames'], 'packets');
    const pcmInfo = wavInfo(pcm.file, 'capture PCM');
    if (integer(audio.capture_rate, 'capture.audio.capture_rate') !== pcmInfo.rate) record(findings, 'capture_fault', 'capture_rate');
    const scan = scanPath === '-' ? null : json(scanPath, 'scan result');
    if (scan) {
      integer(scan.captureFrames, 'scan.captureFrames');
      if (scan.captureFrames !== pcmInfo.frames) record(findings, 'capture_fault', 'scan_pcm_frames');
      packetAnchors(packets, pcmInfo.frames);
      if (scan.inputSha256 !== pcm.sha256) record(findings, 'condition_mismatch', 'scan_pcm');
      if (scan.calibrationSha256 !== calibrationFile.sha256) record(findings, 'condition_mismatch', 'scan_calibration');
      if (scan.packetSha256 !== packetsFile.sha256 || scan.callbackSha256 !== callbacks.sha256) record(findings, 'condition_mismatch', 'scan_capture_records');
    } else {
      packetAnchors(packets, pcmInfo.frames);
    }
    const derived = captureOperations(captureTrace.file, callbacks.file, captureHeader.file, findings);
    if (expectedTrace.navigation_trace_dropped !== 0) record(findings, 'incomplete', 'replay_trace_dropped');
    const replayOperations = navigationOperations(expectedTrace.navigation_trace, expectedTrace.options?.output_sample_rate, findings);
    const normalizedReplay = { operations: replayOperations };
    const navigation = compareOperations({ ...capture, operations: derived.operations }, normalizedReplay, findings);
    const mapped = {};
    try {
      mapped.capture_start = { lower: fraction(BigInt(packets[0].file_frame)), upper: fraction(BigInt(packets[0].file_frame)), uncertaintyFrames: fraction(0n) };
      const lastAnchor = packets.at(-1);
      mapped.capture_end = { lower: fraction(BigInt(lastAnchor.file_frame)), upper: fraction(BigInt(lastAnchor.file_frame)), uncertaintyFrames: fraction(0n) };
    } catch (error) { record(findings, 'incomplete', 'capture_packet_coverage_missing', { error: error.message }); }
    for (const operation of navigation) {
      const expectedMarkers = [
        ['accepted', 'request_engine_frame'], ['plan_applied', 'plan_engine_frame'],
        ['transition_started', 'transition_engine_frame'], ['fade_completed', 'fade_end_engine_frame']
      ];
      for (const [kind, field] of expectedMarkers) {
        try {
          mapped[`${operation.id}\u0000${kind}`] = mapFrameMarker(packets, derived.callback_clock, { engine_frame: operation[field] }, operation, `${operation.id}/${kind}`);
        }
        catch (error) { record(findings, 'incomplete', 'marker_unmapped', { operation: operation.id, kind, error: error.message }); }
      }
    }
    const transportCoverage = [];
    for (const operation of derived.transport) if (operation.label === 'pause' || operation.label === 'resume') {
      try { mapped[`${operation.id}\u0000${operation.label}`] = { lower: qpcToCaptureFrame(packets, fraction(BigInt(operation.playback_qpc_100ns))), upper: qpcToCaptureFrame(packets, fraction(BigInt(operation.playback_qpc_100ns))), uncertaintyFrames: fraction(0n) }; }
      catch (error) { record(findings, 'incomplete', 'transport_marker_unmapped', { operation: operation.id, error: error.message }); }
      transportCoverage.push({ id: operation.id, label: operation.label, mapped: Boolean(mapped[`${operation.id}\u0000${operation.label}`]) });
    }
    const last = navigation.at(-1), finalFade = last && mapped[`${last.id}\u0000fade_completed`];
    if (finalFade && mapped.capture_end && compareFraction(mapped.capture_end.lower, finalFade.upper) < 0) record(findings, 'incomplete', 'fade_not_covered');
    if (navigation[0] && mapped.capture_start && mapped[`${navigation[0].id}\u0000accepted`] && compareFraction(mapped.capture_start.upper, mapped[`${navigation[0].id}\u0000accepted`].lower) > 0) record(findings, 'incomplete', 'request_not_covered');
    const pcmAlignment = sameRateAlignment(pcm.file, pcmInfo.rate, expectedTrace, path.dirname(replayTrace.file), navigation, replayOperations, mapped);
    const kinds = new Set(findings.map(item => item.kind));
    const scanClassification = scan?.classification ?? null;
    const classification = kinds.has('capture_fault') ? 'capture_fault' : kinds.has('incomplete') ? 'incomplete' : kinds.has('condition_mismatch') ? 'condition_mismatch' : scanClassification === null ? 'comparable' : scanClassification;
    return { schema: 1, classification, soundQuality: 'incomplete', comparable: !kinds.size, findings, identities, files: { pcmSha256: pcm.sha256, packetsSha256: packetsFile.sha256, callbacksSha256: callbacks.sha256, captureTraceSha256: captureTrace.sha256, replayTraceSha256: replayTrace.sha256, replayExecutableSha256: replayExecutable.sha256, calibrationSha256: calibrationFile.sha256 }, mappedCaptureFrames: mapped, transportCoverage, pcmAlignment, scanClassification };
  } catch (error) {
    const incomplete = /missing|empty|outside callback playback coverage/.test(error.message);
    return { schema: 1, classification: incomplete ? 'incomplete' : 'capture_fault', soundQuality: 'incomplete', comparable: false, findings: [...findings, { kind: incomplete ? 'incomplete' : 'capture_fault', code: 'evidence_unreadable', detail: error.message }] };
  }
}

module.exports = { compareEvidence };
