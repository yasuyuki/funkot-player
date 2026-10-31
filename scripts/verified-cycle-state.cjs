const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { callbackCsv, calibrationReceipt } = require('./audio-anomaly-analysis.cjs');
const { wav, RATE } = require('./audio-anomaly-detector.cjs');
const { cleanEnvironment } = require('./verified-player-build.cjs');

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const descriptor = file => ({ file, sha256: hash(file) });
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
function execute(command, args, deadline) {
  const remaining = deadline - Date.now();
  if (!Number.isSafeInteger(remaining) || remaining <= 0) throw new Error('finite cycle analysis deadline expired');
  const result = spawnSync(command, args, { env: cleanEnvironment(), timeout: Math.min(remaining, 2147483647), encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`finite cycle analysis failed: ${result.stderr || result.error?.message || command}`);
}
function requireDeadline(deadline) {
  const remaining = deadline - Date.now();
  if (!Number.isSafeInteger(remaining) || remaining <= 0) throw new Error('finite cycle analysis deadline expired');
}
function sameFrame(a, aFrame, b, bFrame) {
  const left = a.sample(aFrame, 0), right = a.sample(aFrame, 1);
  const expectedLeft = b.sample(bFrame, 0), expectedRight = b.sample(bFrame, 1);
  return typeof left === 'number' && typeof right === 'number' && typeof expectedLeft === 'number' && typeof expectedRight === 'number' &&
    left === expectedLeft && right === expectedRight;
}
function sameSamples(a, aFrame, b, bFrame, count, deadline) {
  let active = false;
  for (let frame = 0; frame < count; frame++) {
    requireDeadline(deadline);
    if (!sameFrame(a, aFrame + frame, b, bFrame + frame)) return false;
    active ||= b.sample(bFrame + frame, 0) !== 0 || b.sample(bFrame + frame, 1) !== 0;
  }
  return active;
}
function activeProbe(expected, probe, deadline) {
  if (!Number.isSafeInteger(probe.output_frames) || probe.output_frames <= 0) throw new Error('cycle source alignment probe has an invalid frame count');
  let active = false;
  for (let frame = 0; frame < probe.output_frames; frame++) {
    requireDeadline(deadline);
    const left = expected.sample(probe.output_start + frame, 0), right = expected.sample(probe.output_start + frame, 1);
    if (typeof left !== 'number' || typeof right !== 'number') throw new Error('cycle source alignment probe is not numeric PCM');
    active ||= left !== 0 || right !== 0;
  }
  if (!active) throw new Error('cycle source alignment probe does not contain active PCM');
}
function prefixTable(expected, probe, deadline) {
  const prefix = new Uint32Array(probe.output_frames);
  for (let frame = 1, matched = 0; frame < probe.output_frames; frame++) {
    requireDeadline(deadline);
    while (matched > 0 && !sameFrame(expected, probe.output_start + frame, expected, probe.output_start + matched)) matched = prefix[matched - 1];
    if (sameFrame(expected, probe.output_start + frame, expected, probe.output_start + matched)) matched++;
    prefix[frame] = matched;
  }
  return prefix;
}
function* originsForProbe(target, expected, probe, deadline) {
  const prefix = prefixTable(expected, probe, deadline);
  for (let frame = 0, matched = 0; frame < target.frames; frame++) {
    requireDeadline(deadline);
    while (matched > 0 && !sameFrame(target, frame, expected, probe.output_start + matched)) matched = prefix[matched - 1];
    if (sameFrame(target, frame, expected, probe.output_start + matched)) matched++;
    if (matched === probe.output_frames) {
      yield frame - probe.output_frames + 1 - probe.output_start;
      matched = prefix[matched - 1];
    }
  }
}
function nextOrigin(iterator) {
  const next = iterator.next();
  return next.done ? undefined : next.value;
}
function uniqueCommonOrigin(iterators) {
  let heads = iterators.map(nextOrigin);
  let origin;
  while (heads.every(value => value !== undefined)) {
    const highest = Math.max(...heads);
    if (heads.every(value => value === highest)) {
      if (origin !== undefined) throw new Error('cycle source alignment has multiple output origins');
      origin = highest;
      heads = iterators.map(nextOrigin);
    } else heads = heads.map((value, index) => value < highest ? nextOrigin(iterators[index]) : value);
  }
  if (origin === undefined) throw new Error('cycle source anchors disagree on the output origin');
  return origin;
}
function alignCycleSources(target, expected, rows, composition, deadline) {
  const probeFrames = RATE * 3 / 4;
  const probes = [];
  for (const [index, source] of composition.sources.entries()) {
    const nextBoundary = composition.sources[index + 1]?.engine_frame ?? composition.engine_end_frame;
    const probe = rows.find(row => row.paused === 0 && row.engine_start !== null && row.engine_start >= source.engine_frame + probeFrames &&
      row.engine_start + probeFrames < nextBoundary && row.engine_end <= nextBoundary && row.engine_end - row.engine_start === row.output_frames);
    if (!probe) throw new Error('cycle source lacks a complete alignment observation');
    if (probes.some(existing => existing.sequence === probe.sequence)) throw new Error('cycle source alignment observations are not distinct');
    activeProbe(expected, probe, deadline);
    probes.push(probe);
  }
  const origin = uniqueCommonOrigin(probes.map(probe => originsForProbe(target, expected, probe, deadline)));
  const anchors = probes.map(probe => {
    const captureFrame = origin + probe.output_start;
    if (captureFrame < 0 || captureFrame + probe.output_frames > target.frames ||
        !sameSamples(target, captureFrame, expected, probe.output_start, probe.output_frames, deadline)) {
      throw new Error('cycle source anchor PCM is not an exact independent match');
    }
    return { sequence: probe.sequence, capture_frame: captureFrame, output_frame: probe.output_start, frames: probe.output_frames };
  });
  return { origin, anchors };
}
function mergeRanges(ranges) {
  const result = [];
  for (const range of ranges) {
    const previous = result.at(-1);
    if (previous && previous.end === range.start && previous.kind === range.kind && previous.reason === range.reason &&
        (range.kind !== 'audio' || previous.reference_start + previous.end - previous.start === range.reference_start)) {
      previous.end = range.end;
      if (range.last_sequence !== undefined) previous.last_sequence = range.last_sequence;
    } else result.push({ ...range });
  }
  return result;
}

function scanCycle({ witness, reference, calibrationFile, workDirectory, deadline }) {
  const findings = [];
  const receiptFile = path.join(path.dirname(calibrationFile), 'calibration-receipt.json');
  calibrationReceipt(path.dirname(calibrationFile), { ...descriptor(calibrationFile), receipt: descriptor(receiptFile) }, { route: witness.endpointReceipt.stream }, findings);
  if (findings.length) return { classification: 'condition_mismatch', soundQuality: 'incomplete', findings };
  const trace = witness.outputs.navigation_jsonl.realpath, callbacksFile = witness.outputs.callbacks_csv.realpath;
  const composedPrefix = path.join(workDirectory, 'expected-callback-output');
  execute(reference.executable, ['--compose', reference.waveFile, reference.metadataFile, callbacksFile, trace, composedPrefix], deadline);
  const composition = read(composedPrefix + '.json');
  const expectedFile = composedPrefix + '.wav', captureFile = witness.recorder.pcm.file;
  if (composition.outcome !== null || composition.runtime?.core_revision !== reference.proof.coreRevision ||
      composition.callbacks_sha256 !== hash(callbacksFile) || composition.trace_sha256 !== hash(trace) ||
      composition.reference_sha256 !== hash(reference.waveFile) || composition.output?.sha256 !== hash(expectedFile) ||
      composition.driver_source_sha256 !== reference.metadata.driver_source_sha256 ||
      composition.transport_source_sha256 !== reference.metadata.transport_source_sha256) {
    throw new Error('cycle expected output does not match its observed inputs');
  }
  const target = wav(captureFile), expected = wav(expectedFile), callbackRows = callbackCsv(callbacksFile);
  let cursor = 0;
  const rows = callbackRows.map(row => { const value = { ...row, output_start: cursor }; cursor += row.output_frames; return value; });
  if (expected.frames !== cursor || !Array.isArray(composition.sources) || composition.sources.map(row => row.index).join(',') !== '0,1,2') throw new Error('cycle expected output coverage is incomplete');
  const { origin, anchors } = alignCycleSources(target, expected, rows, composition, deadline);
  const ranges = [];
  if (origin > 0) ranges.push({ start: 0, end: Math.min(origin, target.frames), kind: 'intentional', reason: 'capture_preroll' });
  for (const span of composition.spans) {
    const start = Math.max(0, origin + span.start), end = Math.min(target.frames, origin + span.end);
    if (end <= start) continue;
    ranges.push({ ...span, start, end, ...(span.kind === 'audio' ? { reference_start: start - origin } : {}) });
  }
  const coveredEnd = origin + expected.frames;
  if (coveredEnd < target.frames) ranges.push({ start: Math.max(0, coveredEnd), end: target.frames, kind: 'intentional', reason: 'capture_postroll' });
  const merged = mergeRanges(ranges);
  let end = 0;
  for (const range of merged) { if (range.start !== end) throw new Error('cycle state partition has a gap or overlap'); end = range.end; }
  if (end !== target.frames) throw new Error('cycle state partition does not cover the capture');
  const alignment = path.join(workDirectory, 'callback-alignment.json');
  save(alignment, { schema: 1, origin_frame: origin, capture_sha256: hash(captureFile), reference_sha256: hash(expectedFile),
    packets_sha256: hash(witness.recorder.packets.file), callbacks_sha256: hash(callbacksFile), anchors });
  const endpoint = path.join(workDirectory, 'verified-endpoint.json');
  save(endpoint, witness.endpointReceipt);
  const route = witness.endpointReceipt.stream;
  const stateFile = path.join(workDirectory, 'cycle-state.json');
  save(stateFile, { schema: 1, routehash: crypto.createHash('sha256').update(JSON.stringify({ endpoint_id: route.endpoint_id, rate: route.rate, channels: route.channels, sample_format: route.sample_format })).digest('hex'),
    capture: descriptor(captureFile), reference: descriptor(expectedFile), packets: descriptor(witness.recorder.packets.file), callbacks: descriptor(callbacksFile), endpoint_receipt: descriptor(endpoint),
    callback_alignment: descriptor(alignment), engine_start_frame: composition.engine_start_frame, engine_end_frame: composition.engine_end_frame, output_closed: true, ranges: merged });
  const scanFile = path.join(workDirectory, 'cycle-scan.json');
  execute(process.execPath, [path.join(__dirname, 'audio-anomaly-detector.cjs'), 'scan-state', stateFile, calibrationFile, scanFile], deadline);
  const scan = read(scanFile);
  const totals = { audio: 0, intentional: 0, capture_fault: 0, unclassified: 0 };
  for (const range of merged) totals[range.kind] += range.end - range.start;
  return { classification: scan.classification, soundQuality: 'incomplete', guaranteeClass: 'pcm_only', first: scan.first, frameCounts: totals,
    scan: descriptor(scanFile), state: descriptor(stateFile), callbackOrigin: origin, captureFrames: target.frames, coverage: scan.coverage };
}

module.exports = { alignCycleSources, scanCycle };
