const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { RATE, wav, localOffset } = require('./audio-anomaly-detector.cjs');
const { readCaptureWitness } = require('./verified-capture.cjs');

const QPC_PER_SECOND = 10000000n;
const navigationFields = [
  'source_generation', 'target_source_generation', 'active_index', 'target_index', 'active_preview', 'active_head_only', 'target_preview', 'target_head_only',
  'request_active_playhead_frame', 'plan_engine_frame',
  'plan_start_frame', 'entry_frame',
  'transition_engine_frame', 'fade_end_engine_frame', 'engine_rate', 'reason', 'simple'
];
const relativeEngineFrames = new Set(['plan_engine_frame', 'transition_engine_frame', 'fade_end_engine_frame']);

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
function sha256(value, name) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(`${name} must be a SHA-256 digest`);
  return value;
}
function checkedFile(base, descriptor, name) {
  object(descriptor, name);
  const actual = file(base, descriptor, name);
  if (sha256(descriptor.sha256, `${name}.sha256`) !== actual.sha256) fail(`${name} hash does not match ${descriptor.file}`);
  return actual;
}
function nonempty(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} is required`);
  return value;
}
function positive(value, name) {
  integer(value, name);
  if (!value) fail(`${name} must be positive`);
  return value;
}
function endpointObservation(value, name, processId, stream) {
  object(value, name);
  if (positive(value.process_id, `${name}.process_id`) !== processId) fail(`${name}.process_id does not match receipt`);
  const observed = {
    endpoint_id: nonempty(value.endpoint_id, `${name}.endpoint_id`),
    rate: positive(value.rate, `${name}.rate`),
    channels: positive(value.channels, `${name}.channels`),
    sample_format: nonempty(value.sample_format, `${name}.sample_format`),
    session_id: nonempty(value.session_id, `${name}.session_id`)
  };
  for (const field of ['endpoint_id', 'rate', 'channels', 'sample_format']) if (observed[field] !== stream[field]) fail(`${name}.${field} does not match stream`);
  return observed;
}
function endpointReceipt(base, descriptor, name) {
  const receiptFile = checkedFile(base, descriptor, name);
  const receipt = json(receiptFile.file, name);
  return endpointReceiptValue(receipt, receiptFile, name);
}
function endpointReceiptValue(receipt, receiptFile, name) {
  if (receipt.schema !== 1) fail(`${name}.schema is unsupported`);
  const processId = positive(receipt.process_id, `${name}.process_id`);
  const streamValue = object(receipt.stream, `${name}.stream`);
  const stream = {
    endpoint_id: nonempty(streamValue.endpoint_id, `${name}.stream.endpoint_id`),
    rate: positive(streamValue.rate, `${name}.stream.rate`),
    channels: positive(streamValue.channels, `${name}.stream.channels`),
    sample_format: nonempty(streamValue.sample_format, `${name}.stream.sample_format`)
  };
  const before = endpointObservation(receipt.session?.before, `${name}.session.before`, processId, stream);
  const after = endpointObservation(receipt.session?.after, `${name}.session.after`, processId, stream);
  if (before.session_id !== after.session_id) fail(`${name}.session changed`);
  return { file: receiptFile, runId: nonempty(receipt.run_id, `${name}.run_id`), processId, route: stream };
}
function sameRoute(left, right) {
  return ['endpoint_id', 'rate', 'channels', 'sample_format'].every(field => left[field] === right[field]);
}
function captureEndpointBinding(endpoint, header, findings) {
  try {
    if (nonempty(header.run_id, 'navigation header.run_id') !== endpoint.runId || positive(header.process_id, 'navigation header.process_id') !== endpoint.processId) record(findings, 'condition_mismatch', 'endpoint_capture_operation');
  } catch {
    record(findings, 'incomplete', 'endpoint_capture_operation_unverified');
  }
}
function coverage(value, captureFrames, name, allowIncomplete = false) {
  object(value, name);
  const total = integer(value.total_windows, `${name}.total_windows`);
  const audio = integer(value.audio_windows, `${name}.audio_windows`);
  const intentional = integer(value.intentional_windows, `${name}.intentional_windows`);
  const unclassified = integer(value.unclassified_windows, `${name}.unclassified_windows`);
  if (total !== audio + intentional || (!allowIncomplete && (unclassified !== 0 || value.complete !== true)) || (allowIncomplete && value.complete !== false)) fail(`${name} is incomplete`);
  if (!Array.isArray(value.ranges) || !value.ranges.length) fail(`${name}.ranges is required`);
  let expected = 0, audioRanges = 0, intentionalRanges = 0, unclassifiedRanges = 0;
  for (const [index, range] of value.ranges.entries()) {
    object(range, `${name}.ranges[${index}]`);
    const start = integer(range.start, `${name}.ranges[${index}].start`), end = integer(range.end, `${name}.ranges[${index}].end`);
    if (start !== expected || end <= start || !['audio', 'intentional', ...(allowIncomplete ? ['unclassified'] : [])].includes(range.kind)) fail(`${name}.ranges is not contiguous`);
    expected = end;
    if (range.kind === 'audio') audioRanges++; else if (range.kind === 'intentional') intentionalRanges++; else unclassifiedRanges++;
  }
  if (expected !== captureFrames || audio !== audioRanges || intentional !== intentionalRanges || (allowIncomplete && unclassified < unclassifiedRanges)) fail(`${name}.ranges does not match window counts`);
}
function scanEvidence(scan, name, options) {
  object(scan, name);
  if (scan.schema !== 1) fail(`${name}.schema is unsupported`);
  if (!['clean', 'pcm_transient', 'dropout', 'timing_glitch', 'capture_fault', 'incomplete'].includes(scan.classification)) fail(`${name}.classification is unsupported`);
  const frames = integer(scan.captureFrames, `${name}.captureFrames`);
  if (options.captureFrames !== undefined && frames !== options.captureFrames) fail(`${name}.captureFrames does not match capture`);
  for (const field of ['inputSha256', 'calibrationSha256', 'packetSha256', 'callbackSha256', 'endpointReceiptSha256', 'referenceSha256']) sha256(scan[field], `${name}.${field}`);
  if (options.pcmSha256 && scan.inputSha256 !== options.pcmSha256) fail(`${name}.inputSha256 does not match PCM`);
  if (options.calibrationSha256 && scan.calibrationSha256 !== options.calibrationSha256) fail(`${name}.calibrationSha256 does not match calibration`);
  if (options.packetsSha256 && scan.packetSha256 !== options.packetsSha256) fail(`${name}.packetSha256 does not match packets`);
  if (options.callbacksSha256 && scan.callbackSha256 !== options.callbacksSha256) fail(`${name}.callbackSha256 does not match callbacks`);
  if (options.endpointReceiptSha256 && scan.endpointReceiptSha256 !== options.endpointReceiptSha256) fail(`${name}.endpointReceiptSha256 does not match endpoint receipt`);
  if (options.referenceHashes && !options.referenceHashes.includes(scan.referenceSha256)) fail(`${name}.referenceSha256 does not match expected reference`);
  coverage(scan.coverage, frames, `${name}.coverage`, scan.classification === 'incomplete');
  scanConsistency(scan, name);
  return scan;
}
function scanConsistency(scan, name) {
  const candidates = scan.pcmCandidates;
  if (candidates !== undefined && (!Number.isSafeInteger(candidates) || candidates < 0)) fail(`${name}.pcmCandidates is invalid`);
  const first = scan.first;
  if (first !== undefined && first !== null) {
    object(first, `${name}.first`);
    if (!['pcm_transient', 'dropout', 'timing_glitch', 'capture_fault', 'incomplete'].includes(first.classification)) fail(`${name}.first.classification is invalid`);
    if (first.classification !== scan.classification) fail(`${name}.classification contradicts first`);
  }
  if (['pcm_transient', 'dropout', 'timing_glitch'].includes(scan.classification) && (!first || first.classification !== scan.classification)) fail(`${name}.first is required for ${scan.classification}`);
  if (scan.classification === 'clean' && (first || candidates > 0)) fail(`${name}.clean classification has anomaly evidence`);
}
function scanSignals(scan) {
  return Boolean(scan.first) || (Number.isSafeInteger(scan.pcmCandidates) && scan.pcmCandidates > 0);
}
function calibrationReceipt(base, calibration, endpoint, findings) {
  const calibrationFile = checkedFile(base, calibration, 'capture.calibration');
  const receiptFile = checkedFile(base, calibration.receipt, 'capture.calibration.receipt');
  const receipt = json(receiptFile.file, 'capture.calibration.receipt');
  if (receipt.schema !== 1) fail('capture.calibration.receipt.schema is unsupported');
  if (sha256(receipt.detector_calibration_sha256, 'capture.calibration.receipt.detector_calibration_sha256') !== calibrationFile.sha256) fail('calibration receipt does not bind calibration');
  const calibrationEndpoint = endpointReceipt(path.dirname(receiptFile.file), receipt.endpoint_receipt, 'capture.calibration.receipt.endpoint_receipt');
  if (!sameRoute(endpoint.route, calibrationEndpoint.route)) record(findings, 'condition_mismatch', 'endpoint_calibration');
  const calibrationData = json(calibrationFile.file, 'calibration');
  if (calibrationData.schema !== 3) fail('calibration.schema is unsupported');
  if (sha256(calibrationData.provenance?.detectorSha256, 'calibration.provenance.detectorSha256') !== hash(path.join(__dirname, 'audio-anomaly-detector.cjs'))) fail('calibration detector does not match comparator detector');
  const baseline = object(calibrationData.baseline, 'calibration.baseline');
  const referenceHashes = [sha256(baseline.aSha256, 'calibration.baseline.aSha256'), sha256(baseline.bSha256, 'calibration.baseline.bSha256')];
  const windowFrames = positive(calibrationData.windowFrames, 'calibration.windowFrames');
  const baselineArtifacts = ['a', 'b'].map(label => {
    const provenance = object(calibrationData.provenance?.[label], `calibration.provenance.${label}`);
    const artifacts = {};
    for (const name of ['capture', 'reference', 'packets', 'callbacks', 'endpoint_receipt']) artifacts[name] = checkedFile(path.dirname(calibrationFile.file), provenance[name], `calibration.provenance.${label}.${name}`);
    const observedEndpoint = endpointReceipt(path.dirname(calibrationFile.file), provenance.endpoint_receipt, `calibration.provenance.${label}.endpoint_receipt`);
    if (nonempty(provenance.runId, `calibration.provenance.${label}.runId`) !== observedEndpoint.runId || positive(provenance.processId, `calibration.provenance.${label}.processId`) !== observedEndpoint.processId || !sameRoute(calibrationEndpoint.route, observedEndpoint.route)) fail(`calibration.provenance.${label} does not bind calibration endpoint`);
    return artifacts;
  });
  if (!Array.isArray(receipt.controls)) fail('capture.calibration.receipt.controls is required');
  const controls = new Map();
  for (const [index, control] of receipt.controls.entries()) {
    object(control, `capture.calibration.receipt.controls[${index}]`);
    if (!['negative', 'pcm_transient', 'dropout'].includes(control.kind) || controls.has(control.kind)) fail('calibration control kind is invalid');
    const controlName = `capture.calibration.receipt.controls[${index}]`;
    const controlFile = checkedFile(path.dirname(receiptFile.file), control.scan, `${controlName}.scan`);
    const audio = object(control.audio, `${controlName}.audio`), artifacts = {};
    for (const name of ['pcm', 'reference', 'packets', 'callbacks']) artifacts[name] = checkedFile(path.dirname(receiptFile.file), audio[name], `${controlName}.audio.${name}`);
    const pcmInfo = wavInfo(artifacts.pcm.file, `${controlName} PCM`);
    wavInfo(artifacts.reference.file, `${controlName} reference`);
    packetAnchors(numericCsv(artifacts.packets.file, ['file_frame', 'qpc_100ns', 'frames'], `${controlName} packets`), pcmInfo.frames);
    callbackCsv(artifacts.callbacks.file);
    const controlScan = scanEvidence(json(controlFile.file, `calibration control ${control.kind}`), `calibration control ${control.kind}`, { captureFrames: pcmInfo.frames, pcmSha256: artifacts.pcm.sha256, calibrationSha256: calibrationFile.sha256, packetsSha256: artifacts.packets.sha256, callbacksSha256: artifacts.callbacks.sha256, endpointReceiptSha256: calibrationEndpoint.file.sha256, referenceHashes: [artifacts.reference.sha256] });
    if (controlScan.classification !== (control.kind === 'negative' ? 'clean' : control.kind)) fail(`calibration control ${control.kind} classification does not match`);
    if (control.kind === 'negative' && control.injection) fail('negative calibration control must not have injection evidence');
    controls.set(control.kind, { artifacts, scan: controlScan, injection: control.injection, controlName });
  }
  if (controls.size !== 3) fail('calibration controls are incomplete');
  const negative = controls.get('negative');
  if (!baselineArtifacts.some((artifacts, index) => artifacts.capture.sha256 === negative.artifacts.pcm.sha256 && artifacts.reference.sha256 === negative.artifacts.reference.sha256 && referenceHashes[index] === negative.artifacts.reference.sha256)) fail('negative calibration control does not bind baseline recording');
  for (const kind of ['pcm_transient', 'dropout']) {
    const control = controls.get(kind);
    if (control.artifacts.pcm.sha256 === negative.artifacts.pcm.sha256) fail(`${kind} calibration control aliases negative PCM`);
    const injectionFile = checkedFile(path.dirname(receiptFile.file), control.injection, `${control.controlName}.injection`);
    const injection = json(injectionFile.file, `${control.controlName}.injection`);
    if (injection.schema !== 1 || injection.type !== (kind === 'dropout' ? 'dropout24' : kind)) fail(`${kind} calibration injection type is invalid`);
    const frame = integer(injection.frame, `${kind} calibration injection frame`);
    if (!Number.isFinite(injection.amplitude) || sha256(injection.input_sha256, `${kind} calibration injection input_sha256`) !== negative.scan.inputSha256 || sha256(injection.output_sha256, `${kind} calibration injection output_sha256`) !== control.artifacts.pcm.sha256) fail(`${kind} calibration injection does not bind PCM`);
    if (!control.scan.first || !Number.isSafeInteger(control.scan.first.frame) || Math.abs(control.scan.first.frame - frame) > windowFrames) fail(`${kind} calibration scan first frame does not bind injection`);
  }
  return { file: calibrationFile, receipt: receiptFile, referenceHashes };
}
function sourceReceipt(base, descriptor, endpoint, input, headerHashes, derived) {
  const receiptFile = checkedFile(base, descriptor, 'capture.source_receipt');
  const receipt = json(receiptFile.file, 'capture.source_receipt');
  if (receipt.schema !== 1 || receipt.mode !== 'fixed_input') fail('capture.source_receipt is not a fixed-input receipt');
  if (nonempty(receipt.run_id, 'capture.source_receipt.run_id') !== endpoint.runId) fail('capture.source_receipt.run_id does not match endpoint receipt');
  const hashes = identityHashes(input);
  if (!Array.isArray(receipt.ordered_input_hashes) || !receipt.ordered_input_hashes.length) fail('capture.source_receipt.ordered_input_hashes is invalid');
  receipt.ordered_input_hashes.forEach((value, index) => sha256(value, `capture.source_receipt.ordered_input_hashes[${index}]`));
  if (new Set(receipt.ordered_input_hashes).size !== receipt.ordered_input_hashes.length) fail('capture.source_receipt has duplicate input content');
  if (canonical(receipt.ordered_input_hashes) !== canonical(hashes) || canonical(headerHashes) !== canonical(hashes)) fail('capture.source_receipt input hashes do not match identities');
  if (receipt.source_edits !== 0) fail('capture.source_receipt records source edits');
  const before = object(receipt.before, 'capture.source_receipt.before'), after = object(receipt.after, 'capture.source_receipt.after');
  const revision = nonempty(before.revision, 'capture.source_receipt.before.revision');
  if (nonempty(after.revision, 'capture.source_receipt.after.revision') !== revision || sha256(before.input_sha256, 'capture.source_receipt.before.input_sha256') !== input.sha256 || sha256(after.input_sha256, 'capture.source_receipt.after.input_sha256') !== input.sha256) fail('capture.source_receipt changed input or revision');
  for (const operation of derived.operations) for (const field of ['active_index', 'target_index']) if (!Number.isSafeInteger(operation[field]) || operation[field] < 0 || operation[field] >= hashes.length) fail(`capture source ${field} is outside fixed input`);
  return receiptFile;
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
  });
  const canonicalEntries = [...entries].sort((left, right) => left.file.localeCompare(right.file));
  return { sha256: crypto.createHash('sha256').update(canonical(canonicalEntries)).digest('hex'), manifestSha256: manifest.sha256, files: entries };
}
function identityHashes(identityValue) { return identityValue.files ? identityValue.files.map(file => file.sha256) : [identityValue.sha256]; }
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
function callbackCsvContent(content) {
  const required = ['sequence', 'callback_qpc_100ns', 'playback_qpc_100ns', 'output_frames', 'engine_start', 'engine_end', 'paused', 'audition', 'render_lock_miss', 'trace_dropped'];
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (!lines.length || lines.shift() !== required.join(',')) fail('callbacks headers are invalid');
  return lines.map((line, index) => {
    const values = line.split(',');
    if (values.length !== required.length || values.some(value => value !== '' && !/^\d+$/.test(value))) fail(`callbacks row ${index + 2} is not numeric CSV`);
    if ((values[4] === '') !== (values[5] === '')) fail(`callbacks row ${index + 2} has one engine bound`);
    return Object.fromEntries(required.map((name, column) => [name, values[column] === '' ? null : Number(values[column])]));
  });
}
function callbackCsv(fileName) { return callbackCsvContent(fs.readFileSync(fileName, 'utf8')); }
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
    if (kind === 'cancelled') { record(findings, 'incomplete', 'navigation_cancelled'); continue; }
    if (kind === 'accepted') {
      acceptedCount++;
      if (['next', 'transition_to_next'].includes(String(event.action).toLowerCase())) groups.set(id, { accepted: event });
    }
    else if (!groups.has(id) || !['plan_applied', 'transition_started', 'fade_completed'].includes(kind)) record(findings, 'incomplete', 'navigation_trace_stale', { id, kind });
    else if (groups.get(id)[kind]) record(findings, 'incomplete', 'navigation_trace_duplicate', { id, kind });
    else groups.get(id)[kind] = event;
  }
  const navigation = [];
  for (const [id, group] of groups) {
    const { accepted, plan_applied: applied, transition_started: transition, fade_completed: fade } = group;
    if (!applied || !transition || !fade) { record(findings, 'incomplete', 'navigation_trace_missing', { id }); continue; }
    const plan = field(applied, 'plan');
    if (plan.generation !== accepted.generation) record(findings, 'incomplete', 'plan_generation_unmatched', { id });
    for (const event of [accepted, applied, transition, fade]) integer(event.render_frame, 'navigation render frame');
    const operation = { id, label: `next-${navigation.length + 1}`, ...(requestLabels.has(id) ? { requestLabel: requestLabels.get(id) } : {}), source_generation: field(accepted, 'source_generation'), target_source_generation: field(accepted, 'target_source_generation'), active_index: field(accepted, 'current_index'), target_index: field(accepted, 'target_index'), active_preview: field(accepted, 'active_preview'), active_head_only: field(accepted, 'active_head_only'), target_preview: field(accepted, 'target_preview'), target_head_only: field(accepted, 'target_head_only'), request_engine_frame: field(accepted, 'render_frame'), request_active_playhead_frame: field(accepted, 'active_playhead'), plan_generation: field(plan, 'generation'), plan_engine_frame: field(applied, 'render_frame'), plan_start_frame: field(plan, 'start'), entry_frame: field(plan, 'entry'), transition_engine_frame: field(transition, 'render_frame'), fade_end_engine_frame: field(fade, 'render_frame'), engine_rate: engineRate, reason: field(plan, 'reason'), simple: field(plan, 'simple') };
    const phaseFields = [
      [applied, ['target_index', 'target_source_generation']],
      [transition, ['current_index', 'source_generation', 'target_index', 'target_source_generation']],
      [fade, ['current_index', 'source_generation', 'target_index', 'target_source_generation']]
    ];
    const phaseValues = {
      target_index: accepted.target_index,
      target_source_generation: accepted.target_source_generation,
      current_index: accepted.target_index,
      source_generation: accepted.target_source_generation
    };
    for (const [event, names] of phaseFields) for (const name of names) {
      if (!(name in event)) record(findings, 'incomplete', 'navigation_source_observation_missing', { id, name });
      else if (event[name] !== phaseValues[name]) record(findings, 'incomplete', 'navigation_source_observation_changed', { id, name });
    }
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
  const pauseTailFrames = Math.max(2, Math.round(engineRate * 0.010));
  let pausedFrames = 0, pausedFrozen = false;
  for (const [index, callback] of callbacks.entries()) {
    if ((index && callback.sequence !== previousSequence + 1) || ![0, 1].includes(callback.paused) || ![0, 1].includes(callback.render_lock_miss) || callback.trace_dropped !== 0) record(findings, 'incomplete', 'callback_observation_invalid');
    if (callback.render_lock_miss) record(findings, 'capture_fault', 'render_lock_miss');
    if (!callback.paused) { pausedFrames = 0; pausedFrozen = false; }
    else if (callback.engine_start !== null) {
      const advance = callback.engine_end - callback.engine_start;
      if (advance && header.transport !== 'transport_fade') record(findings, 'incomplete', 'pause_envelope_unverified');
      pausedFrames += advance;
      if (advance < 0 || (pausedFrozen && advance !== 0) || pausedFrames > pauseTailFrames) record(findings, 'capture_fault', 'paused_engine_advanced');
      if (advance === 0) pausedFrozen = true;
    }
    if (callback.engine_start !== null && callback.engine_end > callback.engine_start) clock.push({ engine_start_frame: callback.engine_start, engine_end_frame: callback.engine_end, playback_qpc_100ns: callback.playback_qpc_100ns });
    if (index && callback.paused !== previousPaused) transport.push({ id: `${callback.paused ? 'pause' : 'resume'}-${callback.sequence}`, label: callback.paused ? 'pause' : 'resume', playback_qpc_100ns: callback.playback_qpc_100ns });
    previousPaused = callback.paused;
    previousSequence = callback.sequence;
  }
  const rows = jsonLines(traceFile, 'navigation trace'), footer = rows.pop();
  if (!footer || footer.kind !== 'capture_end') fail('navigation trace footer is missing');
  if (footer.callback_records_dropped !== 0 || footer.trace_dropped !== 0) record(findings, 'incomplete', 'trace_dropped');
  const last = callbacks.at(-1);
  for (const [field, value] of [['last_callback_sequence', last.sequence], ['last_playback_qpc_100ns', last.playback_qpc_100ns], ['last_output_frames', last.output_frames], ['last_engine_frame', last.engine_end]]) if (!(field in footer) || footer[field] !== value) record(findings, 'incomplete', 'capture_end_unverified', { field });
  return { operations: navigationOperations(rows, engineRate, findings, requestedLabels(rows, findings)), callback_clock: clock, transport, finalCallback: last };
}
function wavInfo(fileName, name) {
  const bytes = fs.readFileSync(fileName);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') fail(`${name} is not a WAV file`);
  let format, channels, rate, bits, dataSize;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + size > bytes.length) fail(`${name} has a truncated chunk`);
    if (id === 'fmt ' && size >= 16) {
      format = bytes.readUInt16LE(offset + 8); channels = bytes.readUInt16LE(offset + 10); rate = bytes.readUInt32LE(offset + 12); bits = bytes.readUInt16LE(offset + 22);
      if (format === 0xfffe && size >= 40 && bytes.subarray(offset + 32, offset + 48).equals(Buffer.from('0300000000001000800000aa00389b71', 'hex'))) format = 3;
    }
    if (id === 'data') dataSize = size;
    offset += 8 + size + size % 2;
  }
  if (!channels || !rate || !bits || dataSize === undefined || bits % 8 || dataSize % (channels * (bits / 8))) fail(`${name} has an invalid PCM layout`);
  return { frames: dataSize / (channels * (bits / 8)), rate, format, channels, bits };
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
function finalCallbackCoverage(packets, callback, outputRate, captureRate, captureFrames, findings) {
  try {
    const playbackEnd = addFraction(fraction(BigInt(callback.playback_qpc_100ns)), fraction(BigInt(callback.output_frames) * QPC_PER_SECOND, BigInt(outputRate)));
    const last = packets.at(-1);
    const lastStart = fraction(BigInt(last.qpc_100ns));
    const lastEnd = addFraction(lastStart, fraction(BigInt(last.frames) * QPC_PER_SECOND, BigInt(captureRate)));
    if (compareFraction(playbackEnd, lastStart) >= 0 && compareFraction(playbackEnd, lastEnd) <= 0) return;
    if (compareFraction(qpcToCaptureFrame(packets, playbackEnd), fraction(BigInt(captureFrames))) > 0) record(findings, 'incomplete', 'final_callback_not_covered');
  } catch {
    record(findings, 'incomplete', 'final_callback_not_covered');
  }
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
    if (observed.label !== expected.label) record(findings, 'condition_mismatch', 'operation_label_or_order', { index });
    if (observed.label.startsWith('next-')) {
      if (typeof observed.requestLabel !== 'string' || !/^next-\d+$/.test(observed.requestLabel)) record(findings, 'incomplete', 'request_label_missing', { index });
      for (const field of navigationFields) {
        if (!(field in observed) || !(field in expected)) { record(findings, 'incomplete', 'navigation_observation_missing', { index, field }); continue; }
        const observedValue = relativeEngineFrames.has(field) ? observed[field] - observed.request_engine_frame : observed[field];
        const expectedValue = relativeEngineFrames.has(field) ? expected[field] - expected.request_engine_frame : expected[field];
        if (observedValue !== expectedValue) record(findings, 'condition_mismatch', 'navigation_value', { index, field });
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
  const referenceInfo = wavInfo(audio.file, 'replay WAV');
  if (audio.sampleRate !== referenceInfo.rate) return { classification: 'incomplete', reason: 'replay_audio_rate_mismatch', replayWavSha256: hash(audio.file), replayRate: referenceInfo.rate };
  if (captureRate !== referenceInfo.rate) return { classification: 'incomplete', reason: 'cross_rate_pcm_alignment', replayWavSha256: hash(audio.file), captureRate, replayRate: referenceInfo.rate };
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
function sameConditionScope(endpoint, header, capturePcm, replayTrace, replayBase, soundQualityFindings) {
  try {
    const captureEngineRate = positive(header.options?.output_sample_rate, 'navigation header engine rate');
    const replayEngineRate = positive(replayTrace.engine_options?.output_sample_rate, 'replay engine rate');
    const replay = replayAudio(replayBase, replayTrace);
    if (!replay) fail('replay audio is missing');
    const replayPcm = wavInfo(replay.file, 'replay WAV');
    const f32Stereo = pcm => pcm.format === 3 && pcm.channels === 2 && pcm.bits === 32;
    if (endpoint.rate !== captureEngineRate || captureEngineRate !== capturePcm.rate || capturePcm.rate !== replayEngineRate || replayEngineRate !== replayPcm.rate || replay.sampleRate !== replayPcm.rate || endpoint.channels !== 2 || endpoint.sample_format !== 'f32' || !f32Stereo(capturePcm) || !f32Stereo(replayPcm)) record(soundQualityFindings, 'incomplete', 'same_condition_pcm_scope');
  } catch {
    record(soundQualityFindings, 'incomplete', 'same_condition_pcm_scope_unverified');
  }
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
  else if (canonical(inputHashes) !== canonical(identityHashes(identities.replay.input))) record(findings, 'condition_mismatch', 'replay_trace_input_hashes');
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
function analyzeEvidence({ captureManifestPath, replayPath, scanPath, observed, captureWitness }) {
  const findings = [];
  const soundQualityFindings = [];
  try {
    const witness = captureWitness ? readCaptureWitness(captureWitness) : null;
    const capture = json(captureManifestPath, 'capture manifest'), replay = observed ? observed.replay : json(replayPath, 'replay');
    const captureBase = path.dirname(captureManifestPath), replayBase = observed ? observed.work : path.dirname(replayPath);
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
    if (identities.capture.input && identities.replay.input && canonical(identityHashes(identities.capture.input)) !== canonical(identityHashes(identities.replay.input))) record(findings, 'condition_mismatch', 'input_order');
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
    const expectedTrace = observed ? observed.raw : json(replayTrace.file, 'replay trace');
    if (observed && replayTrace.sha256 !== observed.rawHash) record(findings, 'incomplete', 'replay_trace_changed');
    const captureHeaderData = json(captureHeader.file, 'navigation header');
    if (captureHeaderData.silent_render === true) record(soundQualityFindings, 'incomplete', 'silent_render');
    else if (captureHeaderData.silent_render !== undefined && captureHeaderData.silent_render !== false) record(findings, 'incomplete', 'silent_render_invalid');
    let endpoint;
    if (witness) {
      const receiptHash = crypto.createHash('sha256').update(JSON.stringify(witness.endpointReceipt)).digest('hex');
      endpoint = endpointReceiptValue(witness.endpointReceipt, { sha256: receiptHash }, 'observed endpoint receipt');
      if (!witness.recorder?.callbacks || witness.recorder.playerPid !== witness.childPid) record(findings, 'incomplete', 'capture_recorder_unverified');
      else {
        const recorded = witness.recorder;
        const recorderMatches = (actual, expected) => expected && fs.realpathSync(actual.file) === expected.file && actual.sha256 === expected.sha256;
        if (!recorderMatches(pcm, recorded.pcm) || !recorderMatches(packetsFile, recorded.packets) || !recorderMatches(callbacks, recorded.callbacks)) record(findings, 'condition_mismatch', 'capture_recorder');
      }
      if (!witness.buildProvenance) record(findings, 'incomplete', 'capture_build_unverified');
      const same = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
      const matches = (actual, expected) => actual && same(fs.realpathSync(actual.file), expected.realpath) && actual.sha256 === expected.sha256;
      if (!matches(captureHeader, witness.header) || !matches(captureTrace, witness.outputs.navigation_jsonl) || !matches(callbacks, witness.outputs.callbacks_csv) || !matches(identities.capture.binary, witness.executable)) record(findings, 'condition_mismatch', 'capture_witness');
      if (endpoint.processId !== witness.childPid || witness.guardFiles.some(guard => guard.beforeSha256 !== guard.afterSha256 || hash(guard.realpath) !== guard.afterSha256)) record(findings, 'incomplete', 'capture_witness_changed');
    } else endpoint = endpointReceipt(captureBase, capture.endpoint_receipt, 'capture.endpoint_receipt');
    captureEndpointBinding(endpoint, captureHeaderData, findings);
    let calibrationEvidence = null;
    let calibration = { classification: 'incomplete', reason: 'calibration_missing' };
    if (capture.calibration) try {
      calibrationEvidence = calibrationReceipt(captureBase, object(capture.calibration, 'capture.calibration'), endpoint, soundQualityFindings);
      calibration = { classification: 'verified', receiptSha256: calibrationEvidence.receipt.sha256 };
    } catch {
      calibration = { classification: 'incomplete', reason: 'calibration_unverified' };
      record(soundQualityFindings, 'incomplete', 'calibration_unverified');
    }
    if (!calibrationEvidence) record(soundQualityFindings, 'incomplete', calibration.reason);
    const calibrationFile = calibrationEvidence?.file;
    const headerInputHashes = json(captureHeader.file, 'navigation header').input?.content_hashes;
    if (!Array.isArray(headerInputHashes) || headerInputHashes.some((value, index) => { try { sha256(value, `header.input.content_hashes[${index}]`); return false; } catch { return true; } })) record(findings, 'incomplete', 'header_input_hashes_missing');
    const coreRevisions = [capture.core_git, captureHeaderData.core_git, replay.core_git, expectedTrace.runtime?.core_revision];
    if (coreRevisions.some(value => typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value))) record(findings, 'incomplete', 'core_git_unverified');
    else if (coreRevisions.some(value => value !== coreRevisions[0])) record(findings, 'condition_mismatch', 'core_git');
    if (!expectedTrace.engine_options) record(findings, 'incomplete', 'replay_trace_engine_options_missing');
    else if (canonical(comparableOptions(captureHeaderData.options)) !== canonical(comparableOptions(expectedTrace.engine_options))) record(findings, 'condition_mismatch', 'engine_options');
    traceBinding(expectedTrace, replay, replayBase, identities, replayExecutable, findings);
    const packets = numericCsv(packetsFile.file, ['file_frame', 'qpc_100ns', 'frames'], 'packets');
    const pcmInfo = wavInfo(pcm.file, 'capture PCM');
    if (integer(audio.capture_rate, 'capture.audio.capture_rate') !== pcmInfo.rate) record(findings, 'capture_fault', 'capture_rate');
    const scan = scanPath === '-' ? null : json(scanPath, 'scan result');
    packetAnchors(packets, pcmInfo.frames);
    const derived = captureOperations(captureTrace.file, callbacks.file, captureHeader.file, findings);
    finalCallbackCoverage(packets, derived.finalCallback, endpoint.route.rate, pcmInfo.rate, pcmInfo.frames, findings);
    const sourceReceiptFile = sourceReceipt(captureBase, capture.source_receipt, endpoint, identities.capture.input, headerInputHashes, derived);
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
    const pcmMeasurement = sameRateAlignment(pcm.file, pcmInfo.rate, expectedTrace, path.dirname(replayTrace.file), navigation, replayOperations, mapped);
    sameConditionScope(endpoint.route, captureHeaderData, pcmInfo, expectedTrace, path.dirname(replayTrace.file), soundQualityFindings);
    let scanEvidenceValue = null;
    if (scan) {
      if (!calibrationEvidence) record(soundQualityFindings, 'incomplete', 'scan_calibration_unverified');
      if (pcmMeasurement.classification !== 'measured') record(soundQualityFindings, 'incomplete', 'scan_reference_unmeasured');
      scanEvidenceValue = scanEvidence(scan, 'scan', {
        captureFrames: pcmInfo.frames,
        pcmSha256: pcm.sha256,
        ...(calibrationFile ? { calibrationSha256: calibrationFile.sha256 } : {}),
        packetsSha256: packetsFile.sha256,
        callbacksSha256: callbacks.sha256,
        endpointReceiptSha256: endpoint.file.sha256,
        ...(pcmMeasurement.classification === 'measured' ? { referenceHashes: [pcmMeasurement.replayWavSha256] } : {})
      });
      if (scanEvidenceValue.classification === 'capture_fault') record(findings, 'capture_fault', 'scan_capture_fault');
    }
    if (observed && hash(observed.wavPath) !== observed.wavHash) record(findings, 'incomplete', 'replay_audio_changed');
    const kinds = new Set(findings.map(item => item.kind));
    const classification = kinds.has('capture_fault') ? 'capture_fault' : kinds.has('incomplete') ? 'incomplete' : kinds.has('condition_mismatch') ? 'condition_mismatch' : 'comparable';
    let soundQuality = 'incomplete';
    if (classification === 'comparable' && calibrationEvidence && !soundQualityFindings.length && scanEvidenceValue && pcmMeasurement.classification === 'measured') {
      if (scanEvidenceValue.classification === 'clean' && !scanSignals(scanEvidenceValue)) soundQuality = 'no_anomaly_detected';
      else if (['pcm_transient', 'dropout', 'timing_glitch'].includes(scanEvidenceValue.classification)) soundQuality = 'anomaly_detected';
    }
    const scanObservation = scanEvidenceValue ? { classification: scanEvidenceValue.classification, coverage: scanEvidenceValue.coverage, ...(scanEvidenceValue.first ? { first: scanEvidenceValue.first } : {}) } : null;
    return { schema: 1, classification, soundQuality, soundQualityScope: 'fixed_input_only', comparable: classification === 'comparable', findings, soundQualityFindings, calibration, identities, files: { pcmSha256: pcm.sha256, packetsSha256: packetsFile.sha256, callbacksSha256: callbacks.sha256, captureTraceSha256: captureTrace.sha256, replayTraceSha256: replayTrace.sha256, replayExecutableSha256: replayExecutable.sha256, ...(calibrationFile ? { calibrationSha256: calibrationFile.sha256 } : {}), endpointReceiptSha256: endpoint.file.sha256, sourceReceiptSha256: sourceReceiptFile.sha256 }, mappedCaptureFrames: mapped, transportCoverage, pcmMeasurement, pcmAlignment: pcmMeasurement, scanClassification: scanEvidenceValue?.classification ?? null, scanObservation };
  } catch (error) {
    const mismatch = /does not match|input hashes/.test(error.message);
    const incomplete = !mismatch && /verified replay|witness|missing|empty|incomplete|contradicts|has anomaly|outside callback playback coverage|must be|required|unsupported|receipt|coverage|baseline|schema|endpoint|source_receipt/.test(error.message);
    const kind = mismatch ? 'condition_mismatch' : incomplete ? 'incomplete' : 'capture_fault';
    return { schema: 1, classification: kind, soundQuality: 'incomplete', comparable: false, findings: [...findings, { kind, code: 'evidence_unreadable', detail: error.message }] };
  }
}

module.exports = { analyzeEvidence, callbackCsv, callbackCsvContent, jsonLines, navigationOperations, requestedLabels, calibrationReceipt };
