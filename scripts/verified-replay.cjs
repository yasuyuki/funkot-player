const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readCaptureWitness } = require('./verified-capture.cjs');
const { cleanEnvironment } = require('./verified-player-build.cjs');
const { callbackCsv } = require('./audio-anomaly-analysis.cjs');

const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
function inside(file, root) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const relative = path.relative(normalize(root), normalize(file));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function timeoutOptions(deadline) {
  if (deadline === undefined) return {};
  const remaining = deadline - Date.now();
  if (!Number.isSafeInteger(remaining) || remaining <= 0) throw new Error('verified replay deadline expired');
  return { timeout: Math.min(remaining, 2147483647) };
}

function run(command, args, options, deadline) {
  const result = spawnSync(command, args, { ...options, ...timeoutOptions(deadline), encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`verified replay command failed: ${command}`);
  return result.stdout;
}

function validateCaptureSources(descriptor, captureBase, player, core, buildProvenance) {
  const engine = path.join(core, 'funkot-core', 'src', 'engine.rs');
  const driver = path.join(core, 'funkot-core', 'examples', 'manual_nav_acceptance.rs');
  const playerSources = ['src-tauri/src/lib.rs', 'src-tauri/src/navigation_capture.rs', 'funkot-core.commit'];
  const expectedSources = [engine, driver, ...playerSources.map(name => path.join(player, name))];
  const sourceManifest = path.resolve(captureBase, descriptor.manifest);
  const sourceEntries = readJson(sourceManifest).files;
  if (!Array.isArray(sourceEntries) || sourceEntries.length !== expectedSources.length) throw new Error('capture source manifest does not match the verified build');
  const unmatchedSources = expectedSources.map(file => fs.realpathSync(file));
  for (const entry of sourceEntries) {
    if (!entry || typeof entry.file !== 'string' || typeof entry.sha256 !== 'string') throw new Error('capture source manifest is invalid');
    const file = path.resolve(path.dirname(sourceManifest), entry.file);
    const index = unmatchedSources.findIndex(expected => expected && samePath(fs.realpathSync(file), expected));
    if (index < 0 || digest(file) !== entry.sha256) throw new Error('capture source manifest does not match the verified build');
    unmatchedSources[index] = null;
  }
  const playerInventory = buildProvenance.guardedInputs.playerSource.files;
  if (playerSources.some(name => !playerInventory.some(file => file.path === name && file.sha256 === digest(path.join(player, name))))) throw new Error('capture player source does not match the verified build');
  return { engine, driver, sourceManifest, playerSources };
}

function validateProducerRevision(raw, pin) {
  const value = raw?.runtime?.core_revision;
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new Error('fresh replay core revision is missing or invalid');
  if (value !== pin) throw new Error('fresh replay core revision does not match the player pin');
}

function replayExtent(navigation, callbacks) {
  const accepted = navigation.filter(row => row.kind === 'accepted');
  const footer = navigation.at(-1), last = callbacks.at(-1);
  const frame = value => Number.isSafeInteger(value) && value >= 0;
  if (accepted.length !== 1 || accepted[0].action !== 'transition_to_next' ||
      !frame(accepted[0].active_playhead) || !frame(accepted[0].render_frame)) {
    throw new Error('verified replay requires one accepted next request');
  }
  if (navigation.filter(row => row.kind === 'capture_end').length !== 1 || footer?.kind !== 'capture_end' || !last ||
      !frame(footer.last_engine_frame) || footer.last_engine_frame !== last.engine_end ||
      footer.last_callback_sequence !== last.sequence || footer.last_output_frames !== last.output_frames ||
      footer.last_playback_qpc_100ns !== last.playback_qpc_100ns ||
      callbacks.some((row, index) => index && row.sequence !== callbacks[index - 1].sequence + 1)) {
    throw new Error('verified replay requires the observed final callback');
  }
  const request = accepted[0];
  const end = request.active_playhead + (footer.last_engine_frame - request.render_frame);
  if (footer.last_engine_frame <= request.render_frame || !frame(end) || end <= request.active_playhead) {
    throw new Error('verified replay capture endpoint is invalid');
  }
  return { requestFrame: request.active_playhead, endFrame: end };
}

function freshReplay(capturePath, recipePath, captureWitness, deadline) {
  timeoutOptions(deadline);
  const player = fs.realpathSync(path.resolve(__dirname, '..'));
  const core = fs.realpathSync(path.resolve(player, '..', 'funkot-autodj-for-ui'));
  const recipeBase = fs.realpathSync(path.dirname(path.resolve(recipePath)));
  const captureBase = path.dirname(path.resolve(capturePath));
  const capture = readJson(capturePath), recipe = readJson(recipePath);
  if (recipe.schema !== 2 || Object.keys(recipe).sort().join(',') !== 'schema,work_directory' || typeof recipe.work_directory !== 'string' || !recipe.work_directory || path.basename(recipe.work_directory) !== recipe.work_directory || ['.', '..'].includes(recipe.work_directory)) throw new Error('verified replay recipe requires only a new work_directory');
  const workRoot = path.join(recipeBase, recipe.work_directory);
  if (inside(workRoot, player) || inside(workRoot, core)) throw new Error('verified replay work_directory must be outside source checkouts');
  const headerPath = path.resolve(captureBase, capture.header.file);
  const header = readJson(headerPath);
  const pin = fs.readFileSync(path.join(player, 'funkot-core.commit'), 'utf8').trim();
  if ([pin, header.core_git, capture.core_git].some(value => typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value))) throw new Error('capture core revision is missing or invalid');
  if (header.core_git !== pin || capture.core_git !== pin) throw new Error('capture core revision does not match the player pin');
  if (typeof header.silent_render !== 'boolean') throw new Error('capture silent render mode is missing or invalid');
  const witness = readCaptureWitness(captureWitness);
  if (!witness.buildProvenance) throw new Error('capture player build is unverified');
  if (witness.buildProvenance.coreRevision !== pin) throw new Error('capture player build core revision does not match the pin');
  const real = file => fs.realpathSync(file);
  const observedFile = (file, expected, expectedHash) => samePath(real(file), real(expected)) && digest(file) === expectedHash;
  const guardsMatch = () => witness.guardFiles.every(guard => guard.beforeSha256 === guard.afterSha256 && digest(guard.realpath) === guard.afterSha256);
  if (!guardsMatch()) throw new Error('capture guarded inputs changed after observation');
  if (header.process_id !== witness.childPid || witness.endpointReceipt.process_id !== witness.childPid || !observedFile(headerPath, witness.header.realpath, witness.header.sha256)) throw new Error('capture header does not match the observed process');
  const captureBinary = real(path.resolve(captureBase, capture.identities.binary.file));
  if (!samePath(captureBinary, witness.executable.realpath) || !samePath(captureBinary, witness.buildProvenance.binary.file) || digest(captureBinary) !== witness.executable.sha256 || witness.executable.sha256 !== witness.buildProvenance.binary.sha256) throw new Error('capture binary does not match the verified player build');
  const tracePath = path.resolve(captureBase, capture.trace.file);
  const callbacksPath = path.resolve(captureBase, capture.audio.callbacks.file);
  if (!observedFile(tracePath, witness.outputs.navigation_jsonl.realpath, witness.outputs.navigation_jsonl.sha256) || !observedFile(callbacksPath, witness.outputs.callbacks_csv.realpath, witness.outputs.callbacks_csv.sha256)) throw new Error('capture trace or callbacks do not match the observed process');
  const env = cleanEnvironment();
  const git = args => run('git', ['-C', core, ...args], { env }, deadline).trim();
  const clean = () => samePath(fs.realpathSync(git(['rev-parse', '--show-toplevel'])), core) && git(['rev-parse', 'HEAD']) === pin && git(['status', '--porcelain', '--untracked-files=all']) === '';
  if (!clean()) throw new Error('core checkout is not the clean pinned revision');
  const { engine, driver, sourceManifest, playerSources } = validateCaptureSources(capture.identities.source, captureBase, player, core, witness.buildProvenance);
  const inputsManifest = path.resolve(captureBase, capture.identities.input.manifest);
  const inputsData = readJson(inputsManifest);
  if (!Array.isArray(inputsData.files) || inputsData.files.length !== 2) throw new Error('verified replay requires two fixed input files');
  const inputs = inputsData.files.map(entry => path.resolve(path.dirname(inputsManifest), entry.file));
  const inputHashes = inputs.map(digest);
  if (inputsData.files.some((entry, index) => entry.sha256 !== inputHashes[index]) || JSON.stringify(header.input?.content_hashes) !== JSON.stringify(inputHashes)) throw new Error('capture input hashes do not match actual inputs');
  const guarded = file => witness.guardFiles.some(guard => samePath(real(file), guard.realpath) && guard.beforeSha256 === guard.afterSha256 && digest(file) === guard.afterSha256);
  if (![inputsManifest, ...inputs].every(guarded)) throw new Error('capture inputs were not guarded by the observed process');
  const navigation = fs.readFileSync(tracePath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const extent = replayExtent(navigation, callbackCsv(callbacksPath));
  const guardedInputs = [headerPath, tracePath, inputsManifest, engine, driver, ...inputs, callbacksPath, captureBinary, capturePath, sourceManifest, ...playerSources.map(name => path.join(player, name))];
  const before = guardedInputs.map(digest);
  if (!fs.existsSync(workRoot)) fs.mkdirSync(workRoot, { mode: 0o700 });
  const rootInfo = fs.lstatSync(workRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('verified replay work_directory must be a directory without a link');
  const actualWorkRoot = fs.realpathSync(workRoot);
  if (inside(actualWorkRoot, player) || inside(actualWorkRoot, core)) throw new Error('verified replay work_directory must be outside source checkouts');
  const work = fs.mkdtempSync(path.join(actualWorkRoot, 'replay-'));
  const headerCopy = path.join(work, 'capture-header.json');
  fs.copyFileSync(headerPath, headerCopy, fs.constants.COPYFILE_EXCL);
  env.CARGO_TARGET_DIR = path.join(work, 'target');
  env.CARGO_BUILD_BUILD_DIR = path.join(work, 'build');
  const metadata = JSON.parse(run('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1', '--manifest-path', path.join(core, 'Cargo.toml')], { env, cwd: core }, deadline));
  if (![metadata.target_directory, metadata.build_directory].every(directory => directory && inside(path.resolve(directory), work))) throw new Error('Cargo output directories are not isolated');
  const log = fs.openSync(path.join(work, 'build.log'), 'wx');
  try {
    const result = spawnSync('cargo', ['build', '--locked', '--release', '-p', 'funkot-core', '--example', 'manual_nav_acceptance', '--manifest-path', path.join(core, 'Cargo.toml')], { env, cwd: core, stdio: ['ignore', log, log], ...timeoutOptions(deadline) });
    if (result.error || result.status !== 0) throw new Error('verified replay build failed');
  } finally { fs.closeSync(log); }
  const executable = path.join(env.CARGO_TARGET_DIR, 'release', 'examples', `manual_nav_acceptance${process.platform === 'win32' ? '.exe' : ''}`);
  const binaryHash = digest(executable);
  const output = path.join(work, 'replay');
  run(executable, [...inputs, '--cache-dir', path.join(work, 'cache'), '--output', output, '--at-frame', String(extent.requestFrame), '--full-until-frame', String(extent.endFrame), '--sample-rate', String(header.options.output_sample_rate), '--engine-options', headerCopy], { env, cwd: work }, deadline);
  const rawPath = output + '.json', wavPath = output + '.wav';
  const rawBytes = fs.readFileSync(rawPath);
  const raw = JSON.parse(rawBytes.toString('utf8'));
  validateProducerRevision(raw, pin);
  if (raw.output_wav?.wav_frame_zero_render_frame !== 0 || raw.positions?.request_frame !== extent.requestFrame ||
      raw.positions?.capture_end_limit_frame !== extent.endFrame || raw.positions?.rendered_end_frame !== extent.endFrame) {
    throw new Error('fresh replay does not cover the observed capture endpoint');
  }
  if (raw.executable_sha256 !== binaryHash || raw.core_source_sha256 !== before[3] || raw.driver_source_sha256 !== before[4] || JSON.stringify(raw.input?.content_hashes) !== JSON.stringify(inputHashes) || path.resolve(raw.audio?.file || '') !== wavPath || raw.outcome !== null || raw.navigation_trace_dropped !== 0) throw new Error('fresh replay producer evidence does not match its build or inputs');
  if (digest(executable) !== binaryHash || digest(headerCopy) !== before[0] || !clean() || !guardsMatch() || guardedInputs.some((file, index) => digest(file) !== before[index])) throw new Error('verified replay inputs changed during execution');
  readCaptureWitness(captureWitness);
  const wavHash = digest(wavPath), rawHash = crypto.createHash('sha256').update(rawBytes).digest('hex');
  const source = { ...capture.identities.source };
  if (source.file) source.file = path.resolve(captureBase, source.file);
  if (source.manifest) source.manifest = path.resolve(captureBase, source.manifest);
  const replay = { schema: 1, core_git: pin, identities: { source, core: { file: engine }, input: { manifest: inputsManifest } }, trace: { file: rawPath }, replay_executable: { file: executable }, driver_source: { file: driver } };
  const manifest = path.join(work, 'verified-replay.json');
  fs.writeFileSync(manifest, JSON.stringify(replay, null, 2), { flag: 'wx' });
  return { replay, raw, work, rawHash, wavPath, wavHash };
}

module.exports = { freshReplay, validateCaptureSources, validateProducerRevision, replayExtent };
