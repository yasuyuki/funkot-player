const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { verifyPlayerBuild, cleanEnvironment, frontendConfigPath } = require('./verified-player-build.cjs');
const { readCaptureWitness } = require('./verified-capture.cjs');
const { wav } = require('./audio-anomaly-detector.cjs');
const { callbackCsv, jsonLines } = require('./audio-anomaly-analysis.cjs');
const { validateCycleCallbacks, validateFirstLiveReplay } = require('./verified-cycle-control.cjs');

const references = new WeakMap();
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const descriptor = file => ({ file, sha256: hash(file) });
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function options(value) { const copy = { ...value }; delete copy.cache_dir; return canonical(copy); }
function run(command, args, env, cwd, deadline) {
  const remaining = deadline - Date.now();
  if (!Number.isSafeInteger(remaining) || remaining <= 0) throw new Error('cycle reference deadline expired');
  const result = spawnSync(command, args, { env, cwd, timeout: Math.min(remaining, 2147483647), encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`cycle reference command failed: ${result.stderr || result.error?.message || command}`);
}
function assertFiles(files) {
  if (files.some(item => !fs.lstatSync(item.file).isFile() || fs.lstatSync(item.file).isSymbolicLink() || hash(item.file) !== item.sha256)) {
    throw new Error('cycle reference source, input, or output changed');
  }
}

function prepareCycleReference({ build, inputManifest, workDirectory, header, captureWitness, deadline }) {
  const proof = verifyPlayerBuild(build.buildWitness);
  const capture = readCaptureWitness(captureWitness);
  const navigation = jsonLines(capture.outputs.navigation_jsonl.realpath, 'finite cycle navigation');
  const origins = navigation.filter(row => row.kind === 'cycle_source_started' && row.index === 0);
  if (hash(capture.outputs.navigation_jsonl.realpath) !== capture.outputs.navigation_jsonl.sha256 || origins.length !== 1 ||
      !Number.isSafeInteger(origins[0].entry_frame) || origins[0].entry_frame < 0 || !Number.isSafeInteger(origins[0].engine_frame) || origins[0].engine_frame < 0) {
    throw new Error('finite cycle first-source frame origin is unverified');
  }
  if (canonical(header) !== canonical(capture.header.value)) throw new Error('cycle reference header does not match the observed process');
  const callbacksFile = capture.outputs.callbacks_csv.realpath;
  if (hash(callbacksFile) !== capture.outputs.callbacks_csv.sha256) throw new Error('finite cycle callback evidence changed');
  const firstLive = validateFirstLiveReplay(navigation, validateCycleCallbacks(callbackCsv(callbacksFile)), proof.coreRevision);
  const player = proof.guardedInputs.playerSource.directory, core = proof.guardedInputs.coreDirectory;
  if (header.core_git !== proof.coreRevision || header.options?.output_sample_rate !== 48000) throw new Error('cycle reference conditions do not match the verified build');
  const work = path.join(fs.realpathSync(workDirectory), 'cycle-reference');
  fs.mkdirSync(work);
  const inputs = read(inputManifest).files;
  if (!Array.isArray(inputs) || inputs.length !== 2) throw new Error('cycle reference requires two fixed inputs');
  const inputFiles = inputs.map(item => ({ file: fs.realpathSync(path.resolve(path.dirname(inputManifest), item.file)), sha256: item.sha256 }));
  assertFiles(inputFiles);
  const driver = path.join(player, 'src-tauri/examples/diagnostic_cycle_reference.rs');
  const engine = path.join(core, 'funkot-core/src/engine.rs');
  const guarded = [descriptor(inputManifest), ...inputFiles, descriptor(driver), descriptor(engine)];
  const capturedTrace = [descriptor(capture.outputs.navigation_jsonl.realpath), descriptor(callbacksFile)];
  const headerFile = path.join(work, 'header.json');
  fs.writeFileSync(headerFile, JSON.stringify({ ...header, cycle_origin: origins[0], first_live: firstLive,
    cycle_trace: { callbacks: callbacksFile, navigation: capture.outputs.navigation_jsonl.realpath } }) + '\n', { flag: 'wx' });
  const env = { ...cleanEnvironment(), CARGO_TARGET_DIR: proof.guardedInputs.cargo.target,
    CARGO_BUILD_BUILD_DIR: proof.guardedInputs.cargo.build,
    TAURI_CONFIG: JSON.stringify({ identifier: proof.identifier, build: { frontendDist: frontendConfigPath(player, proof.guardedInputs.frontend.directory) } }) };
  run('cargo', ['build', '--locked', '--release', '--features', 'custom-protocol,verified-capture', '--manifest-path', path.join(player, 'src-tauri/Cargo.toml'), '--example', 'diagnostic_cycle_reference'], env, player, deadline);
  const executable = path.join(env.CARGO_TARGET_DIR, 'release/examples', `diagnostic_cycle_reference${process.platform === 'win32' ? '.exe' : ''}`);
  const binary = descriptor(executable);
  const markers = [...new Set(fs.readFileSync(executable).toString('latin1').match(/FUNKOT_CYCLE_CORE_REVISION:[0-9a-f]{40}:END/g) || [])];
  if (markers.length !== 1 || markers[0] !== `FUNKOT_CYCLE_CORE_REVISION:${proof.coreRevision}:END`) throw new Error('cycle reference executable core revision is unverified');
  const output = path.join(work, 'reference');
  run(executable, [inputManifest, headerFile, path.join(work, 'cache'), output], env, work, deadline);
  const metadataFile = output + '.json', metadata = read(metadataFile), waveFile = output + '.wav';
  const pcm = wav(waveFile);
  if (metadata.startup_model !== 'first_live_engine_v1' || metadata.historical_candidate !== false ||
      metadata.outcome !== null || canonical(metadata.first_live) !== canonical(firstLive) ||
      metadata.runtime?.core_revision !== proof.coreRevision || metadata.executable_sha256 !== binary.sha256 ||
      metadata.driver_source_sha256 !== hash(driver) || metadata.core_source_sha256 !== hash(engine) ||
      metadata.transport_source_sha256 !== hash(path.join(player, 'src-tauri/src/transport_fade.rs')) ||
      canonical(metadata.input_hashes) !== canonical(inputFiles.map(item => item.sha256)) || canonical(metadata.occurrences) !== '[0,1,0]' ||
      canonical(metadata.cycle_origin) !== canonical(origins[0]) || metadata.output?.engine_frame_zero !== 0 || metadata.output.frames !== pcm.frames || metadata.output.sha256 !== hash(waveFile) || options(metadata.engine_options) !== options(header.options)) {
    throw new Error('cycle reference producer does not match the build or fixed inputs');
  }
  assertFiles([...guarded, ...capturedTrace]);
  verifyPlayerBuild(build.buildWitness);
  const handle = Object.freeze({});
  references.set(handle, { buildWitness: build.buildWitness, proof, metadata, header: JSON.parse(JSON.stringify(header)), inputFiles,
    files: [...guarded, binary, descriptor(metadataFile), descriptor(waveFile)], executable, metadataFile, waveFile, work, endpoint: null });
  return handle;
}

function comparableWitness(captured, reference) {
  const stored = references.get(reference);
  if (!stored) throw new Error('cycle reference handle was not issued by this process');
  const witness = readCaptureWitness(captured.captureWitness);
  verifyPlayerBuild(stored.buildWitness);
  assertFiles(stored.files);
  const bound = [witness.header, ...Object.values(witness.outputs)];
  if (bound.some(item => hash(item.realpath) !== item.sha256) || witness.guardFiles.some(item => item.beforeSha256 !== item.afterSha256 || hash(item.realpath) !== item.afterSha256)) {
    throw new Error('fresh cycle capture evidence changed');
  }
  if (!witness.buildProvenance || witness.buildProvenance.binary.sha256 !== stored.proof.binary.sha256 ||
      witness.buildProvenance.coreRevision !== stored.proof.coreRevision || witness.header.value.core_git !== stored.proof.coreRevision ||
      options(witness.header.value.options) !== options(stored.header.options) ||
      canonical(witness.header.value.input?.content_hashes) !== canonical(stored.inputFiles.map(item => item.sha256))) {
    return { classification: 'condition_mismatch', soundQuality: 'incomplete' };
  }
  const endpoint = witness.endpointReceipt;
  if (endpoint.stream.rate !== 48000 || endpoint.stream.channels !== 2 || endpoint.stream.sample_format !== 'f32') {
    return { classification: 'condition_mismatch', soundQuality: 'incomplete' };
  }
  if (stored.endpoint && canonical(endpoint.stream) !== canonical(stored.endpoint)) return { classification: 'condition_mismatch', soundQuality: 'incomplete' };
  stored.endpoint ??= { ...endpoint.stream };
  if (!witness.outputs.cycle_json || !witness.recorder) throw new Error('fresh finite cycle provenance is incomplete');
  const receipt = read(witness.outputs.cycle_json.realpath);
  if (receipt.process_id !== witness.childPid || receipt.natural_end !== true || receipt.cancelled !== false || receipt.output_closed !== true || receipt.occurrences?.length !== 3 ||
      canonical(receipt.occurrences.map(row => row.sha256)) !== canonical([stored.inputFiles[0].sha256, stored.inputFiles[1].sha256, stored.inputFiles[0].sha256])) {
    return { classification: 'condition_mismatch', soundQuality: 'incomplete' };
  }
  let callbacks;
  try { callbacks = validateCycleCallbacks(callbackCsv(witness.outputs.callbacks_csv.realpath)); }
  catch (error) { return { classification: 'capture_fault', soundQuality: 'incomplete', code: 'cycle_callback_fault', detail: error.message }; }
  const navigation = jsonLines(witness.outputs.navigation_jsonl.realpath, 'finite cycle navigation');
  if (navigation.filter(row => row.kind === 'cycle_source_started').map(row => row.index).join(',') !== '0,1,2') {
    throw new Error('finite cycle source observations are incomplete');
  }
  const initial = navigation.filter(row => row.kind === 'cycle_source_started' && row.index === 0);
  if (initial.length !== 1 || !Number.isSafeInteger(initial[0].entry_frame) || initial[0].entry_frame < 0 ||
      !Number.isSafeInteger(initial[0].engine_frame) || initial[0].engine_frame < 0) {
    return { classification: 'condition_mismatch', soundQuality: 'incomplete', code: 'cycle_initial_origin_changed' };
  }
  const firstLive = validateFirstLiveReplay(navigation, callbacks, stored.proof.coreRevision);
  const footer = navigation.at(-1), last = callbacks.at(-1);
  if (navigation.filter(row => row.kind === 'capture_end').length !== 1 || footer.kind !== 'capture_end' ||
      footer.last_callback_sequence !== last.sequence || footer.last_engine_frame !== last.engine_end ||
      footer.last_output_frames !== last.output_frames || footer.last_playback_qpc_100ns !== last.playback_qpc_100ns ||
      footer.trace_dropped !== 0 || footer.callback_records_dropped !== 0 || navigation.some(row => row.kind === 'accepted' || row.kind === 'requested')) {
    return { classification: footer?.trace_dropped || footer?.callback_records_dropped ? 'capture_fault' : 'incomplete',
      soundQuality: 'incomplete', code: 'cycle_final_evidence_incomplete' };
  }
  return { stored, witness, receipt, navigation, firstLive };
}

function compareCycle({ captured, reference, calibrationFile, workDirectory, deadline }) {
  try {
    const checked = comparableWitness(captured, reference);
    if (checked.classification) return checked;
    const { stored, witness, receipt } = checked;
    const capture = wav(witness.recorder.pcm.file);
    if (witness.header.value.silent_render === true) {
      require('./verified-cycle-state.cjs').composeCycle({ witness, reference: stored, workDirectory, deadline, firstLive: checked.firstLive });
      for (let frame = 0; frame < capture.frames; frame++) for (let channel = 0; channel < 2; channel++) {
        if (capture.sample(frame, channel) !== 0) return { classification: 'capture_fault', soundQuality: 'incomplete', first: { frame, reason: 'silent_cycle_nonzero_pcm' } };
      }
      const final = comparableWitness(captured, reference);
      if (final.classification) return final;
      return { classification: 'silent_clean', soundQuality: 'incomplete', natural_end: true, occurrences: receipt.occurrences,
        frameCounts: { audio: 0, intentional: capture.frames, capture_fault: 0, unclassified: 0 },
        reference: { sha256: hash(stored.waveFile), frames: stored.metadata.output.frames }, pcmSha256: witness.recorder.pcm.sha256 };
    }
    const diagnostic = require('./verified-cycle-state.cjs').scanCycle({ witness, reference: stored, calibrationFile, workDirectory, deadline, firstLive: checked.firstLive });
    const final = comparableWitness(captured, reference);
    if (final.classification) return final;
    return { ...diagnostic, guaranteeClass: 'fresh_finite_cycle', comparable: !['incomplete', 'condition_mismatch', 'capture_fault'].includes(diagnostic.classification),
      soundQuality: diagnostic.classification === 'clean' ? 'no_anomaly_detected' : ['pcm_transient', 'dropout', 'timing_glitch'].includes(diagnostic.classification) ? 'anomaly_detected' : 'incomplete' };
  } catch (error) {
    return { classification: ['condition_mismatch', 'incomplete'].includes(error.classification) ? error.classification : 'incomplete',
      soundQuality: 'incomplete', code: error.code || 'cycle_provenance_unverified', detail: error.message };
  }
}

module.exports = { prepareCycleReference, compareCycle };
