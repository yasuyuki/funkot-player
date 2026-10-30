const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { verifyPlayerBuild } = require('./verified-player-build.cjs');

const captureWitnesses = new WeakMap();

class CaptureVerificationError extends Error {
  constructor(message, classification, code) { super(message); this.name = 'CaptureVerificationError'; this.classification = classification; this.code = code; }
}

const fail = (message, classification = 'capture_fault', code = 'capture_verification_failed') => { throw new CaptureVerificationError(message, classification, code); };
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
}

function positive(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${name} must be a positive safe integer`);
  return value;
}

function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} must be a non-empty string`);
  return value;
}

function json(file, name) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { fail(`${name} is unreadable: ${error.message}`); }
}

function realDirectory(directory, name) {
  const absolute = path.resolve(directory);
  let stat;
  try { stat = fs.lstatSync(absolute); } catch { fail(`${name} does not exist`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${name} must be a non-link directory`);
  return fs.realpathSync(absolute);
}

function regularFile(file, name) {
  const absolute = path.resolve(file);
  let stat;
  try { stat = fs.lstatSync(absolute); } catch { fail(`${name} does not exist`); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${name} must be a regular non-link file`);
  return fs.realpathSync(absolute);
}

function inside(file, root) {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function captureFile(root, name, required = true) {
  const file = path.join(root, name);
  if (!inside(file, root)) fail(`capture ${name} escapes its root`);
  if (!fs.existsSync(file)) {
    if (required) fail(`capture ${name} is missing`);
    return file;
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`capture ${name} must be a regular non-link file`);
  return file;
}

function route(value, name) {
  object(value, name);
  return {
    endpoint_id: text(value.endpoint_id, `${name}.endpoint_id`),
    rate: positive(value.rate, `${name}.rate`),
    channels: positive(value.channels, `${name}.channels`),
    sample_format: text(value.sample_format, `${name}.sample_format`)
  };
}

function sameRoute(left, right) {
  return ['endpoint_id', 'rate', 'channels', 'sample_format'].every(field => left[field] === right[field]);
}

function session(value, name, processId, expectedRoute) {
  object(value, name);
  if (positive(value.process_id, `${name}.process_id`) !== processId) fail(`${name}.process_id does not match child`);
  const observed = { process_id: processId, ...route(value, name), session_id: text(value.session_id, `${name}.session_id`) };
  if (!sameRoute(observed, expectedRoute)) fail(`${name} does not match stream`);
  return observed;
}

function singleJsonLine(file, name) {
  const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) fail(`${name} must contain exactly one JSON record`);
  try { return JSON.parse(lines[0]); } catch (error) { fail(`${name} is unreadable: ${error.message}`); }
}

function headerAndStream(root, childPid, expectedSilentRender = true) {
  const headerFile = captureFile(root, 'navigation-header.json');
  const header = json(headerFile, 'navigation header');
  if (header.schema_version !== 1 || typeof header.silent_render !== 'boolean' || header.silent_render !== expectedSilentRender) fail('navigation header does not declare the expected render mode');
  const runId = text(header.run_id, 'navigation header.run_id');
  if (positive(header.process_id, 'navigation header.process_id') !== childPid) fail('navigation header process does not match child');
  const outputFile = captureFile(root, 'output-stream.jsonl');
  const output = singleJsonLine(outputFile, 'output stream');
  if (output.schema !== 1 || text(output.run_id, 'output stream.run_id') !== runId) fail('output stream does not match navigation header');
  if (positive(output.process_id, 'output stream.process_id') !== childPid) fail('output stream process does not match child');
  const stream = route(output.stream, 'output stream.stream');
  if (output.endpoint_id !== stream.endpoint_id) fail('output stream endpoint does not match stream');
  return { header, headerFile, outputFile, runId, stream };
}

function rejectRootEndpointJson(root) {
  for (const name of ['endpoint-before.json', 'endpoint-receipt.json']) {
    if (fs.existsSync(captureFile(root, name, false))) fail(`child-controlled ${name} is not endpoint authority`);
  }
}

function observerApi(observer) {
  object(observer, 'trustedObserver');
  if (typeof observer.observe !== 'function') fail('trustedObserver.observe must be an integration-owned function');
  return observer;
}

function controlApi(control, verified) {
  object(control, 'control');
  for (const method of verified ? ['requestGracefulQuit'] : ['waitForOperation', 'requestGracefulQuit']) {
    if (typeof control[method] !== 'function') fail(`control.${method} must be an integration-owned function`);
  }
  return control;
}

function liveChild(child, childFailure, message) {
  if (childFailure.error) fail(`capture child failed to start: ${childFailure.error.message}`);
  if (child.exitCode !== null || child.signalCode !== null) fail(message);
}

function observerCall(observer, observed, deadline, signal) {
  if (signal?.aborted) fail('capture supervision aborted');
  const remaining = deadline - Date.now();
  if (remaining <= 0) fail('trusted observer did not observe the capture before deadline');
  return new Promise((resolve, reject) => {
    let done = false;
    let timer;
    let onAbort;
    const finish = (callback, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    timer = setTimeout(() => finish(reject, new CaptureVerificationError('trusted observer exceeded the capture deadline')), remaining);
    onAbort = () => finish(reject, new CaptureVerificationError('capture supervision aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    Promise.resolve().then(() => observer.observe({
      processId: observed.childPid,
      stream: { ...observed.stream },
      deadlineMs: remaining,
      signal
    })).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

function controlCall(control, method, observed, deadline, signal) {
  if (signal?.aborted) fail('capture supervision aborted');
  const remaining = deadline - Date.now();
  if (remaining <= 0) fail(`trusted control ${method} exceeded the capture deadline`);
  return new Promise((resolve, reject) => {
    let done = false;
    let timer;
    let onAbort;
    const finish = (callback, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    timer = setTimeout(() => finish(reject, new CaptureVerificationError(`trusted control ${method} exceeded the capture deadline`)), remaining);
    onAbort = () => finish(reject, new CaptureVerificationError('capture supervision aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    Promise.resolve().then(() => control[method]({
      processId: observed.childPid,
      runId: observed.runId,
      stream: { ...observed.stream },
      deadlineMs: remaining,
      signal
    })).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

async function controlStep(control, method, observed, child, deadline, signal, childFailure) {
  liveChild(child, childFailure, `capture child exited before trusted control ${method}`);
  try {
    const value = await controlCall(control, method, observed, deadline, signal);
    if (signal?.aborted) fail('capture supervision aborted');
    liveChild(child, childFailure, `capture child exited during trusted control ${method}`);
    return value;
  } catch (error) {
    if (error instanceof CaptureVerificationError) throw error;
    fail(`trusted control ${method} failed: ${error?.message || String(error)}`);
  }
}

function operationReceipt(value) {
  object(value, 'control.waitForOperation result');
  if (value.operation_complete !== true || value.recorder_complete !== true) {
    fail('trusted control did not verify completed operation and recorder');
  }
  return { operation_complete: true, recorder_complete: true };
}

async function observedSession(observer, observed, deadline, signal) {
  const value = await observerCall(observer, observed, deadline, signal);
  return session(value, 'trustedObserver.observe', observed.childPid, observed.stream);
}

async function waitForObserver(observer, observed, child, deadline, signal, childFailure) {
  while (Date.now() < deadline) {
    if (signal?.aborted) fail('capture supervision aborted');
    liveChild(child, childFailure, 'capture child exited before trusted observation');
    try {
      const value = await observedSession(observer, observed, deadline, signal);
      if (signal?.aborted) fail('capture supervision aborted');
      liveChild(child, childFailure, 'capture child exited during trusted observation');
      return value;
    }
    catch (error) {
      if (error instanceof CaptureVerificationError) throw error;
      if (error?.code !== 'FUNKOT_OBSERVER_NO_SESSION') fail(`trusted observer failed: ${error?.message || String(error)}`);
    }
    await delay(Math.min(20, Math.max(0, deadline - Date.now())));
  }
  fail('trusted observer did not observe the capture before deadline');
}

function completion(root) {
  const value = json(captureFile(root, 'navigation-complete.json'), 'capture completion');
  if (value.complete !== true) fail('capture completion is not complete');
}

function writeExclusiveControlFile(root, name, value) {
  const file = captureFile(root, name, false);
  if (fs.existsSync(file)) fail(`capture ${name} already exists before parent control`);
  try { fs.writeFileSync(file, value, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) { fail(`could not create capture ${name}: ${error.message}`); }
  return file;
}

function completionAbsent(root) {
  if (fs.existsSync(captureFile(root, 'navigation-complete.json', false))) {
    fail('capture completion exists before parent STOP control');
  }
}

function captureRoot(directory, cyclePlanPath) {
  const root = realDirectory(directory, 'capture directory');
  const names = fs.readdirSync(root);
  if (cyclePlanPath) {
    if (names.length !== 1 || names[0] !== 'cycle-plan.json' || regularFile(cyclePlanPath, 'cycle plan') !== fs.realpathSync(path.join(root, names[0]))) {
      fail('finite capture directory must contain only its owned cycle plan');
    }
  } else if (names.length !== 0) fail('capture directory must be empty and freshly owned');
  return root;
}

function buildChild(build) {
  if (typeof build !== 'function') fail('build must be an integration-owned function');
  const child = build();
  object(child, 'build result');
  const command = regularFile(text(child.command, 'build result.command'), 'built executable');
  if (!Array.isArray(child.args) || child.args.some(arg => typeof arg !== 'string')) fail('build result.args must be strings');
  return { command, args: child.args, buildWitness: child.buildWitness };
}

function snapshot(files) {
  if (!Array.isArray(files) || !files.length) fail('guardFiles must name the built executable and capture inputs');
  const paths = files.map((file, index) => regularFile(text(file, `guardFiles[${index}]`), `guardFiles[${index}]`));
  return paths.map(file => ({ file, sha256: digest(file) }));
}

function unchanged(snapshotValue) {
  return snapshotValue.every(({ file, sha256 }) => fs.existsSync(file) && regularFile(file, 'guarded file') === file && digest(file) === sha256);
}

function evidenceSnapshot(files) {
  return files.map((file, index) => ({ file: regularFile(file, `capture evidence[${index}]`), sha256: digest(file) }));
}

function outputEvidence(root) {
  const navigation = captureFile(root, 'navigation.jsonl');
  const callbacks = captureFile(root, 'callbacks.csv');
  return {
    navigation_jsonl: { realpath: navigation, sha256: digest(navigation) },
    callbacks_csv: { realpath: callbacks, sha256: digest(callbacks) }
  };
}

function guardedEvidence(before) {
  return before.map(({ file, sha256 }) => ({ realpath: file, beforeSha256: sha256, afterSha256: digest(file) }));
}

function immutable(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function issueWitness(value, buildWitness) {
  const witness = immutable(JSON.parse(JSON.stringify(value)));
  const handle = Object.freeze({});
  captureWitnesses.set(handle, { witness, buildWitness });
  return handle;
}

function readCaptureWitness(handle) {
  if (!handle || typeof handle !== 'object' || !captureWitnesses.has(handle)) {
    fail('capture witness handle was not issued by this process', 'incomplete', 'capture_witness_unverified');
  }
  const entry = captureWitnesses.get(handle);
  if (entry.buildWitness) verifyPlayerBuild(entry.buildWitness);
  if (entry.witness.recorder) require('./verified-recorder.cjs').verifyRecorderEvidence(entry.witness.recorder);
  return entry.witness;
}

function requiredEnvironment(extra, root, automation, audible) {
  object(extra, 'childEnv');
  const reserved = ['FUNKOT_NAVIGATION_CAPTURE_DIR', 'FUNKOT_NAVIGATION_REQUIRE_START_SIGNAL', 'FUNKOT_NAVIGATION_SILENT_RENDER',
    'FUNKOT_NAVIGATION_AUTOMATION_INPUT_DIR', 'FUNKOT_NAVIGATION_AUTOMATION_APP_ID', 'FUNKOT_NAVIGATION_AUTOMATION_TIMEOUT_MS',
    'FUNKOT_NAVIGATION_AUTOMATION_CYCLE_PLAN', 'FUNKOT_NAVIGATION_AUTOMATION_AUDIBLE'];
  const inherited = { ...process.env };
  for (const key of Object.keys(extra)) {
    if (reserved.includes(key.toUpperCase()) || key.toUpperCase().startsWith('WEBVIEW2_')) fail(`childEnv must not override ${key}`);
  }
  for (const key of Object.keys(inherited)) {
    if (reserved.includes(key.toUpperCase()) || key.toUpperCase().startsWith('WEBVIEW2_')) delete inherited[key];
  }
  return {
    ...inherited,
    ...extra,
    FUNKOT_NAVIGATION_CAPTURE_DIR: root,
    FUNKOT_NAVIGATION_REQUIRE_START_SIGNAL: '1',
    ...(audible ? { FUNKOT_NAVIGATION_AUTOMATION_AUDIBLE: '1' } : { FUNKOT_NAVIGATION_SILENT_RENDER: '1' }),
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview-profile'),
    ...(automation ? {
      FUNKOT_NAVIGATION_AUTOMATION_INPUT_DIR: automation.inputDirectory,
      FUNKOT_NAVIGATION_AUTOMATION_APP_ID: automation.identifier,
      FUNKOT_NAVIGATION_AUTOMATION_TIMEOUT_MS: String(automation.timeoutMs),
      ...(automation.cyclePlanPath ? { FUNKOT_NAVIGATION_AUTOMATION_CYCLE_PLAN: automation.cyclePlanPath } : {})
    } : {})
  };
}

async function waitFor(predicate, child, deadline, signal, childFailure) {
  while (Date.now() < deadline) {
    if (signal?.aborted) fail('capture supervision aborted');
    if (childFailure.error) fail(`capture child failed to start: ${childFailure.error.message}`);
    if (child.exitCode !== null || child.signalCode !== null) fail('capture child exited before required evidence');
    try { return await predicate(); }
    catch (error) {
      if (!(error instanceof CaptureVerificationError) || !/is missing|is unreadable/.test(error.message)) throw error;
    }
    await delay(20);
  }
  fail('capture supervision timed out');
}

function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32') { child.kill(); return; }
  const taskkill = path.join(process.env.SystemRoot, 'System32', 'taskkill.exe');
  const result = spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    child.kill();
    fail('capture process tree could not be stopped');
  }
}

async function closeBounded(child, deadline) {
  const remaining = Math.max(1, deadline - Date.now());
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise(resolve => {
    const timer = setTimeout(() => { child.removeListener('close', onClose); resolve(null); }, remaining);
    function onClose(code, signal) { clearTimeout(timer); resolve({ code, signal }); }
    child.once('close', onClose);
  });
}

async function waitForSuccessfulExit(child, root, deadline, signal, childFailure) {
  while (Date.now() < deadline) {
    if (signal?.aborted) fail('capture supervision aborted');
    if (childFailure.error) fail(`capture child failed to start: ${childFailure.error.message}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      if (child.exitCode !== 0 || child.signalCode !== null) fail('capture child did not exit successfully');
      completion(root);
      return;
    }
    await delay(20);
  }
  fail('capture supervision timed out');
}

async function waitForCompletionWhileLive(child, root, deadline, signal, childFailure) {
  return waitFor(() => {
    completion(root);
    return true;
  }, child, deadline, signal, childFailure);
}

/**
 * Runs the integration-owned fresh build result under capture supervision.
 * This module intentionally exposes no CLI or manifest format that accepts an
 * executable path. `build` must be the caller's same-invocation build action.
 * `trustedObserver` is integration code that obtains OS/collector observations
 * in memory. Capture-root JSON is deliberately never endpoint authority. The
 * caller must establish isolated player/WebView profiles before calling it.
 * This cannot defend the trusted observer itself from a malicious concurrent
 * process running with the same OS identity; that is an integration boundary.
 */
async function superviseFreshCapture({ build, captureDirectory, childEnv = {}, guardFiles, trustedObserver, control, recorder: recorderOptions, autoInputDirectory, deadlineMs, signal, captureKind = 'single_next', cyclePlanPath, soundAuthorization }) {
  if (!['single_next', 'finite_cycle'].includes(captureKind)) fail('unsupported capture kind');
  const finiteCycle = captureKind === 'finite_cycle';
  if (finiteCycle !== Boolean(cyclePlanPath)) fail('finite capture requires its cycle plan');
  if (soundAuthorization && (!finiteCycle || !Number.isFinite(soundAuthorization.volume_percent) || soundAuthorization.volume_percent < 0 || soundAuthorization.volume_percent > 100 ||
      !Number.isSafeInteger(soundAuthorization.max_wall_ms) || soundAuthorization.max_wall_ms < deadlineMs || typeof soundAuthorization.stop_file !== 'string' || !soundAuthorization.stop_file)) {
    fail('audible cycle requires explicit bounded sound authorization');
  }
  const audible = Boolean(soundAuthorization);
  const deadline = Date.now() + positive(deadlineMs, 'deadlineMs');
  const root = captureRoot(captureDirectory, cyclePlanPath);
  const observer = observerApi(trustedObserver);
  const built = buildChild(build);
  const buildProof = built.buildWitness ? verifyPlayerBuild(built.buildWitness) : null;
  if (finiteCycle && (!buildProof || !autoInputDirectory)) fail('finite cycle requires an isolated verified player build');
  const trustedControl = controlApi(control, Boolean(buildProof));
  if (buildProof && !recorderOptions) fail('verified capture requires an owned recorder');
  if (!buildProof && recorderOptions) fail('owned recorder requires a verified player build');
  if (autoInputDirectory && !buildProof) fail('automated capture requires a verified player build');
  const same = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (buildProof && (!same(built.command, buildProof.binary.file) || built.args.length !== 0)) fail('capture executable does not match the verified player build');
  const guarded = snapshot([...guardFiles, built.command]);
  const automation = autoInputDirectory ? { inputDirectory: realDirectory(autoInputDirectory, 'automated input directory'), identifier: buildProof.identifier, timeoutMs: Math.max(1, deadline - Date.now()), cyclePlanPath } : null;
  const errorLog = fs.openSync(path.join(root, 'player-stderr.log'), 'wx');
  let child;
  try {
    child = spawn(built.command, built.args, {
      cwd: root, env: requiredEnvironment(childEnv, root, automation, audible), stdio: ['ignore', 'ignore', errorLog], windowsHide: true
    });
  } finally { fs.closeSync(errorLog); }
  const childFailure = { error: null };
  child.once('error', error => { childFailure.error = error; });
  let recorderState;
  try {
    if (!child.pid) fail('capture child has no process id');
    const observedHeader = await waitFor(() => headerAndStream(root, child.pid, !audible), child, deadline, signal, childFailure);
    rejectRootEndpointJson(root);
    const observed = { ...observedHeader, childPid: child.pid };
    const before = await waitForObserver(observer, observed, child, deadline, signal, childFailure);
    if (audible && (before.endpoint_id !== soundAuthorization.endpoint_id || observed.header.silent_render !== false)) fail('authorized sound endpoint or mode does not match', 'condition_mismatch', 'sound_authorization_mismatch');
    if (finiteCycle && observed.stream.rate !== 48000) fail('finite cycle requires the calibrated 48 kHz stream', 'condition_mismatch', 'capture_stream_mismatch');
    const evidence = evidenceSnapshot([observed.headerFile, observed.outputFile]);
    if (!unchanged(guarded)) fail('built executable or guarded capture input changed before authorization', 'condition_mismatch', 'capture_input_changed');
    if (buildProof) {
      recorderState = await require('./verified-recorder.cjs').startRecorder({
        ...recorderOptions, root,
        playerPid: child.pid, deadline, signal
      });
      liveChild(child, childFailure, 'capture child exited while recorder became ready');
    }
    const start = path.join(root, 'START.json');
    if (fs.existsSync(start)) fail('capture START already exists');
    fs.writeFileSync(start, JSON.stringify({
      schema: 1, run_id: observed.runId, process_id: child.pid,
      stream: observed.stream, session: before,
      user_sound_signal: audible, silent_render_signal: !audible
    }), { encoding: 'utf8', flag: 'wx' });
    if (!finiteCycle && typeof trustedControl.performOperation === 'function') {
      await controlStep(trustedControl, 'performOperation', observed, child, deadline, signal, childFailure);
    }
    const { waitForVerifiedNavigation } = require('./verified-navigation-control.cjs');
    const navigation = finiteCycle
      ? await require('./verified-cycle-control.cjs').waitForVerifiedCycle({ captureDirectory: root, cyclePlanPath, child, deadline, signal })
      : await waitForVerifiedNavigation({ captureDirectory: root, child, deadline, signal });
    const operation = buildProof
      ? { navigation, operation_complete: true, recorder_complete: false }
      : { navigation, ...operationReceipt(await controlStep(trustedControl, 'waitForOperation', observed, child, deadline, signal, childFailure)) };
    completionAbsent(root);
    writeExclusiveControlFile(root, 'STOP', 'stop');
    await waitForCompletionWhileLive(child, root, deadline, signal, childFailure);
    if (finiteCycle) require('./verified-cycle-control.cjs').validateCycleCallbacks(require('./audio-anomaly-analysis.cjs').callbackCsv(captureFile(root, 'callbacks.csv')));
    let recorder;
    if (recorderState) {
      recorder = await require('./verified-recorder.cjs').finishRecorder(recorderState, deadline, signal, captureFile(root, 'callbacks.csv'));
      liveChild(child, childFailure, 'capture child exited while recorder finished');
      operation.recorder_complete = true;
    }
    rejectRootEndpointJson(root);
    const after = await waitForObserver(observer, observed, child, deadline, signal, childFailure);
    if (after.session_id !== before.session_id) fail('trusted observer session changed during capture', 'condition_mismatch', 'capture_session_changed');
    const receipt = { schema: 1, run_id: observed.runId, process_id: child.pid, stream: observed.stream, session: { before, after } };
    await controlStep(trustedControl, 'requestGracefulQuit', observed, child, deadline, signal, childFailure);
    await waitForSuccessfulExit(child, root, deadline, signal, childFailure);
    rejectRootEndpointJson(root);
    if (!unchanged(evidence)) fail('capture header or stream evidence changed during capture', 'condition_mismatch', 'capture_metadata_changed');
    if (!unchanged(guarded)) fail('built executable or guarded capture input changed during capture', 'condition_mismatch', 'capture_input_changed');
    if (built.buildWitness) verifyPlayerBuild(built.buildWitness);
    if (recorder) require('./verified-recorder.cjs').verifyRecorderEvidence(recorder);
    const outputs = outputEvidence(root);
    if (finiteCycle) outputs.cycle_json = { realpath: navigation.file, sha256: navigation.sha256 };
    const executable = { realpath: built.command, sha256: guarded.at(-1).sha256 };
    const header = { realpath: observed.headerFile, sha256: digest(observed.headerFile), value: observed.header };
    const guardEvidence = guardedEvidence(guarded);
    const witness = {
      childPid: child.pid, executable, captureDirectory: root, header,
      outputStream: { realpath: observed.outputFile, sha256: digest(observed.outputFile), value: observed.stream },
      outputs, endpointReceipt: receipt, operation, guardFiles: guardEvidence,
      ...(buildProof ? { buildProvenance: buildProof, recorder } : {})
    };
    const captureWitness = issueWitness(witness, built.buildWitness);
    return {
      captureDirectory: root,
      childPid: child.pid,
      executableSha256: executable.sha256,
      executableRealpath: executable.realpath,
      header: observed.header,
      headerSha256: header.sha256,
      stream: observed.stream,
      endpointReceipt: receipt,
      operation,
      outputs,
      guardFiles: guarded,
      captureWitness
    };
  } catch (error) {
    let terminationError;
    try { terminate(child); } catch (cleanupError) { terminationError = cleanupError; }
    if (finiteCycle && signal?.aborted) {
      try { writeExclusiveControlFile(root, 'CANCEL', 'cancel'); } catch {}
    }
    let recorderError;
    try { if (recorderState) await require('./verified-recorder.cjs').abortRecorder(recorderState); }
    catch (cleanupError) { recorderError = cleanupError; }
    const exit = await closeBounded(child, deadline);
    if (!exit) fail(`capture supervision failed and child did not close before deadline: ${error.message}`);
    if (recorderError) fail(`capture supervision failed: ${error.message}; recorder cleanup failed: ${recorderError.message}`);
    if (terminationError) fail(`capture supervision failed: ${error.message}; process cleanup failed: ${terminationError.message}`);
    throw error;
  }
}

module.exports = { CaptureVerificationError, superviseFreshCapture, readCaptureWitness };
