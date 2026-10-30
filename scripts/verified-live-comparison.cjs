const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildVerifiedPlayer } = require('./verified-player-build.cjs');
const { superviseFreshCapture, readCaptureWitness } = require('./verified-capture.cjs');
const { compileWindowsRouteObserver } = require('./windows-route-observer.cjs');
const { compareEvidence } = require('./audio-anomaly-comparison.cjs');
const { recorderSources, archiveHash, prepareRecorder } = require('./verified-recorder.cjs');
const cycleReplay = require('./verified-cycle-replay.cjs');

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const event = name => process.stderr.write(JSON.stringify({ event: name }) + '\n');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

async function acquire(file, url, expected, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('live comparison deadline expired');
  const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(remaining, 2147483647)) });
  if (!response.ok) throw new Error(`public recorder download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('public recorder download hash does not match');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { flag: 'wx' });
}

function regularFile(file, name) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new Error(`${name} does not exist`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${name} must be a regular non-link file`);
  return fs.realpathSync(file);
}

function directory(file, name) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new Error(`${name} does not exist`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${name} must be a non-link directory`);
  return fs.realpathSync(file);
}

function isInside(file, root) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function writeDurableJson(file, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'wx');
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  if (!fs.readFileSync(file).equals(bytes)) throw new Error('durable JSON read-back failed');
}

function requireInteger(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a safe integer at least ${minimum}`);
  return value;
}

function resolveRecipePath(recipe, base, name, { required = true } = {}) {
  if (!own(recipe, name)) {
    if (!required) return null;
    throw new Error(`live cycle recipe requires ${name}`);
  }
  if (typeof recipe[name] !== 'string' || !recipe[name]) throw new Error(`live cycle recipe requires ${name}`);
  return path.resolve(base, recipe[name]);
}

function validateWorkDirectory(work, playerRoot, coreRoot) {
  const stat = fs.lstatSync(work);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(work).length) throw new Error('live cycle work directory must be empty and non-link');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('live cycle work directory is not owned by this user');
  const realWork = fs.realpathSync(work);
  if ([playerRoot, coreRoot].some(root => isInside(realWork, root))) throw new Error('live cycle work directory must be outside source checkouts');
  return realWork;
}

function readCycleInputs(inputManifest) {
  regularFile(inputManifest, 'live cycle input manifest');
  const input = JSON.parse(fs.readFileSync(inputManifest, 'utf8'));
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.files) || input.files.length !== 2) {
    throw new Error('live cycle requires exactly two fixed inputs');
  }
  const files = input.files.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.file !== 'string' || !entry.file ||
        typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256)) throw new Error(`live cycle input ${index} is invalid`);
    const requested = path.resolve(path.dirname(inputManifest), entry.file);
    const file = regularFile(requested, `live cycle input ${index}`);
    if (sha(file).toLowerCase() !== entry.sha256.toLowerCase()) throw new Error('fixed input hash does not match');
    return { file, sha256: entry.sha256.toLowerCase() };
  });
  if (files[0].file === files[1].file || files[0].sha256 === files[1].sha256) throw new Error('live cycle requires distinct A and B180 inputs');
  const inputDirectory = fs.realpathSync(path.dirname(files[0].file));
  if (files.some(item => fs.realpathSync(path.dirname(item.file)) !== inputDirectory) || fs.readdirSync(inputDirectory).length !== 2) {
    throw new Error('fixed inputs must be the only two regular files in one directory');
  }
  return { files, inputDirectory };
}

function validateCycleRecipe(recipeFile) {
  const recipe = JSON.parse(fs.readFileSync(recipeFile, 'utf8'));
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe) || recipe.schema !== 1) throw new Error('live cycle recipe schema must be 1');
  requireInteger(recipe.max_cycles, 'max_cycles', 1);
  requireInteger(recipe.deadline_ms, 'deadline_ms', 1);
  requireInteger(recipe.retain_clean_cycles, 'retain_clean_cycles');
  if (recipe.retain_clean_cycles > recipe.max_cycles) throw new Error('retain_clean_cycles must not exceed max_cycles');
  if (recipe.mode !== 'silent' && recipe.mode !== 'audible') throw new Error('live cycle recipe requires an explicit silent or audible mode');
  const base = path.dirname(path.resolve(recipeFile));
  const work = resolveRecipePath(recipe, base, 'work_directory');
  const inputManifest = resolveRecipePath(recipe, base, 'input_manifest');
  const calibrationFile = regularFile(resolveRecipePath(recipe, base, 'calibration_file'), 'live cycle calibration_file');
  const stopFile = resolveRecipePath(recipe, base, 'stop_file');
  const playerRoot = fs.realpathSync(path.resolve(__dirname, '..'));
  const coreRoot = fs.realpathSync(path.resolve(playerRoot, '..', 'funkot-autodj-for-ui'));
  const realWork = validateWorkDirectory(work, playerRoot, coreRoot);
  const { files, inputDirectory } = readCycleInputs(inputManifest);
  let soundAuthorization;
  let deadlineMs = recipe.deadline_ms;
  if (recipe.mode === 'audible') {
    soundAuthorization = recipe.sound_authorization;
    if (!soundAuthorization || typeof soundAuthorization !== 'object' || Array.isArray(soundAuthorization) ||
        typeof soundAuthorization.endpoint_id !== 'string' || !soundAuthorization.endpoint_id ||
        !Number.isFinite(soundAuthorization.volume_percent) || soundAuthorization.volume_percent < 0 || soundAuthorization.volume_percent > 100 ||
        !Number.isSafeInteger(soundAuthorization.max_wall_ms) || soundAuthorization.max_wall_ms <= 0 || soundAuthorization.max_wall_ms > recipe.deadline_ms ||
        typeof soundAuthorization.stop_file !== 'string' || !soundAuthorization.stop_file ||
        path.resolve(base, soundAuthorization.stop_file) !== stopFile) {
      throw new Error('audible live cycle requires a bound explicit sound authorization');
    }
    deadlineMs = Math.min(deadlineMs, soundAuthorization.max_wall_ms);
  }
  return { recipe, base, work: realWork, inputManifest: fs.realpathSync(inputManifest), calibrationFile, stopFile, files, inputDirectory, deadlineMs, soundAuthorization };
}

async function acquireRecorder({ recipe, base, work, deadline }) {
  let recorderSource = recipe.recorder_source_directory ? resolveRecipePath(recipe, base, 'recorder_source_directory') : null;
  let powershellArchive = recipe.powershell_archive ? resolveRecipePath(recipe, base, 'powershell_archive') : null;
  if (!recorderSource) {
    recorderSource = path.join(work, 'recorder-source');
    for (const [name, expected] of recorderSources()) {
      await acquire(path.join(recorderSource, name), `https://raw.githubusercontent.com/jasonulbright/pwshDoom/68719ae9ebe1446a13ac09eb2481c8f91f859960/${name}`, expected, deadline);
    }
  } else recorderSource = directory(recorderSource, 'recorder_source_directory');
  if (!powershellArchive) {
    powershellArchive = path.join(work, 'PowerShell-7.6.9-win-x64.zip');
    await acquire(powershellArchive, 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.9/PowerShell-7.6.9-win-x64.zip', archiveHash, deadline);
  } else powershellArchive = regularFile(powershellArchive, 'powershell_archive');
  return { recorderSource, powershellArchive };
}

function cancellationSignal(signal, stopFile) {
  const controller = new AbortController();
  let reason = null;
  const stop = value => {
    if (!controller.signal.aborted) {
      reason = value;
      controller.abort();
    }
  };
  const external = () => stop('signal');
  signal?.addEventListener('abort', external, { once: true });
  if (signal?.aborted) external();
  const timer = setInterval(() => { if (fs.existsSync(stopFile)) stop('stop_file'); }, 25);
  return { signal: controller.signal, cancelled: () => reason, close: () => { clearInterval(timer); signal?.removeEventListener('abort', external); } };
}

function stableResult(result, mode) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.classification !== 'string') {
    return { classification: 'incomplete', detail: 'cycle comparison returned an invalid result' };
  }
  if (result.classification === 'clean') {
    if (mode !== 'audible' || result.soundQuality !== 'no_anomaly_detected') {
      return { classification: 'condition_mismatch', detail: 'clean requires an actual calibrated audible comparison' };
    }
  } else if (result.classification === 'silent_clean') {
    if (mode !== 'silent' || result.soundQuality !== 'incomplete') {
      return { classification: 'condition_mismatch', detail: 'silent_clean requires incomplete silent sound quality' };
    }
  }
  if (result.classification === 'no_anomaly_detected') return { classification: 'incomplete', detail: 'no_anomaly_detected is not a finite-cycle result' };
  return result;
}

function resultSummary({ cycle, resultFile, outcome }) {
  return { ...JSON.parse(fs.readFileSync(resultFile, 'utf8')), classification: outcome.classification, result_sha256: sha(resultFile) };
}

function persistCycleResult({ cycleDirectory, summariesDirectory, cycle, outcome, mode, runToken, captured }) {
  const resultFile = path.join(cycleDirectory, 'cycle-result.json');
  const document = { schema: 1, cycle, run_token: runToken, mode, outcome,
    ...(captured ? { conditions: { header: captured.header, stream: captured.stream, endpoint_receipt: captured.endpointReceipt, executable_sha256: captured.executableSha256,
      outputs: Object.fromEntries(Object.entries(captured.outputs).map(([name, value]) => [name, value.sha256])) } } : {}) };
  writeDurableJson(resultFile, document);
  const summaryFile = path.join(summariesDirectory, `cycle-${String(cycle).padStart(6, '0')}.json`);
  writeDurableJson(summaryFile, resultSummary({ cycle, resultFile, outcome }));
  return { resultFile, summaryFile };
}

function pruneCleanCycles({ retained, retainCount, cyclesRoot }) {
  while (retained.length > retainCount) {
    const obsolete = retained.shift();
    if (!isInside(obsolete.directory, cyclesRoot) || fs.realpathSync(path.dirname(obsolete.directory)) !== cyclesRoot) {
      throw new Error('clean cycle directory escapes its owned root');
    }
    fs.rmSync(obsolete.directory, { recursive: true, force: false, maxRetries: 0 });
  }
}

async function runLiveCycles(recipeFile, { signal } = {}) {
  const configuration = validateCycleRecipe(recipeFile);
  const deadline = Date.now() + configuration.deadlineMs;
  if (!Number.isSafeInteger(deadline)) throw new Error('live cycle deadline is invalid');
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error('live cycle deadline expired');
    return value;
  };
  const cancellation = cancellationSignal(signal, configuration.stopFile);
  const runToken = crypto.randomBytes(16).toString('hex');
  const cycles = [];
  const retained = [];
  let reference;
  let stopReason = 'max_cycles';
  const cyclesRoot = path.join(configuration.work, 'cycles');
  const summariesDirectory = path.join(configuration.work, 'summaries');
  try {
    if (cancellation.cancelled()) return { schema: 1, run_token: runToken, mode: configuration.recipe.mode, cycles, stop_reason: 'cancelled', actual_cycle_count: 0, clean_cycle_count: 0, click_fixed_claim: false };
    fs.mkdirSync(cyclesRoot);
    fs.mkdirSync(summariesDirectory);
    const { recorderSource, powershellArchive } = await acquireRecorder({ ...configuration, deadline });
    if (cancellation.cancelled()) stopReason = 'cancelled';
    if (stopReason === 'cancelled') return { schema: 1, run_token: runToken, mode: configuration.recipe.mode, cycles, stop_reason: stopReason, actual_cycle_count: 0, clean_cycle_count: 0, click_fixed_claim: false };
    const buildDirectory = path.join(configuration.work, 'player-build');
    const observerDirectory = path.join(configuration.work, 'observer');
    const preparedDirectory = path.join(configuration.work, 'prepared-recorder');
    for (const value of [buildDirectory, observerDirectory, preparedDirectory]) fs.mkdirSync(value);
    event('building_player');
    const build = buildVerifiedPlayer({ workDirectory: buildDirectory, deadlineMs: remaining() });
    writeDurableJson(path.join(configuration.work, 'build-provenance.json'), { schema: 1,
      core_revision: build.coreRevision, identifier: build.identifier, binary: build.binary, inputs: build.guardedInputs });
    const observer = compileWindowsRouteObserver(observerDirectory);
    const prepared = prepareRecorder({ workDirectory: preparedDirectory, sourceDirectory: recorderSource, powershellArchive, deadline, format: 'f32_48000' });
    const { prepareCycleReference, compareCycle } = cycleReplay;
    for (let cycle = 1; cycle <= configuration.recipe.max_cycles; cycle++) {
      if (cancellation.cancelled()) { stopReason = 'cancelled'; break; }
      const cycleDirectory = path.join(cyclesRoot, `cycle-${String(cycle).padStart(6, '0')}`);
      fs.mkdirSync(cycleDirectory);
      const planPath = path.join(cycleDirectory, 'cycle-plan.json');
      writeDurableJson(planPath, { schema: 1, run_token: runToken, cycle, inputs: configuration.files, occurrences: [0, 1, 0] });
      let outcome;
      let captured;
      let stage = 'capture';
      try {
        captured = await superviseFreshCapture({
          build: () => ({ command: build.binary.file, args: [], buildWitness: build.buildWitness }),
          captureDirectory: cycleDirectory,
          guardFiles: [configuration.inputManifest, ...configuration.files.map(item => item.file), planPath],
          trustedObserver: observer,
          autoInputDirectory: configuration.inputDirectory,
          recorder: { prepared, format: 'f32_48000' },
          captureKind: 'finite_cycle',
          cyclePlanPath: planPath,
          deadlineMs: remaining(),
          signal: cancellation.signal,
          soundAuthorization: configuration.recipe.mode === 'audible' ? configuration.soundAuthorization : undefined,
          control: { requestGracefulQuit: async () => { fs.writeFileSync(path.join(cycleDirectory, 'QUIT'), 'quit', { flag: 'wx' }); } }
        });
        stage = 'reference';
        if (!captured || !captured.captureWitness) throw new Error('fresh finite cycle did not issue a capture witness');
        if (!reference) reference = await prepareCycleReference({ build, inputManifest: configuration.inputManifest, workDirectory: configuration.work, header: captured.header, captureWitness: captured.captureWitness, deadline });
        outcome = stableResult(await compareCycle({ captured, reference, calibrationFile: configuration.calibrationFile, workDirectory: cycleDirectory, deadline }), configuration.recipe.mode);
      } catch (error) {
        outcome = cancellation.cancelled()
          ? { classification: 'cancelled_incomplete', detail: error.message }
          : { classification: ['capture_fault', 'condition_mismatch', 'incomplete'].includes(error.classification) ? error.classification : stage === 'capture' ? 'capture_fault' : 'incomplete',
            ...(error.code ? { code: error.code } : {}), detail: error.message };
      }
      let persisted;
      try {
        persisted = persistCycleResult({ cycleDirectory, summariesDirectory, cycle, outcome, mode: configuration.recipe.mode, runToken, captured });
      } catch (error) {
        cycles.push({ cycle, classification: 'storage_failure', detail: error.message, directory: cycleDirectory });
        stopReason = 'storage_failure';
        break;
      }
      cycles.push({ cycle, classification: outcome.classification, result: persisted.resultFile, summary: persisted.summaryFile, directory: cycleDirectory });
      const continueCycle = outcome.classification === 'clean' || (configuration.recipe.mode === 'silent' && outcome.classification === 'silent_clean');
      if (!continueCycle) {
        stopReason = outcome.classification;
        break;
      }
      retained.push({ directory: cycleDirectory, cycle });
      try {
        pruneCleanCycles({ retained, retainCount: configuration.recipe.retain_clean_cycles, cyclesRoot });
      } catch (error) {
        cycles[cycles.length - 1] = { ...cycles.at(-1), classification: 'storage_failure', detail: error.message };
        stopReason = 'storage_failure';
        break;
      }
    }
  } finally {
    cancellation.close();
  }
  const cleanCycleCount = cycles.filter(value => value.classification === 'clean' || value.classification === 'silent_clean').length;
  return { schema: 1, run_token: runToken, mode: configuration.recipe.mode, cycles, stop_reason: stopReason,
    actual_cycle_count: cycles.length, clean_cycle_count: cleanCycleCount, click_fixed_claim: false };
}

async function compareLive(recipeFile) {
  const recipe = JSON.parse(fs.readFileSync(recipeFile, 'utf8'));
  if (!recipe || recipe.schema !== 1 || !Number.isSafeInteger(recipe.deadline_ms) || recipe.deadline_ms <= 0) throw new Error('live comparison requires a positive deadline');
  const deadline = Date.now() + recipe.deadline_ms;
  if (!Number.isSafeInteger(deadline)) throw new Error('live comparison deadline is invalid');
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error('live comparison deadline expired');
    return value;
  };
  const base = path.dirname(path.resolve(recipeFile));
  const resolve = name => {
    if (typeof recipe[name] !== 'string' || !recipe[name]) throw new Error(`live comparison requires ${name}`);
    return path.resolve(base, recipe[name]);
  };
  const work = resolve('work_directory'), inputManifest = resolve('input_manifest');
  let recorderSource = recipe.recorder_source_directory ? resolve('recorder_source_directory') : null;
  let powershellArchive = recipe.powershell_archive ? resolve('powershell_archive') : null;
  const stat = fs.lstatSync(work);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(work).length) throw new Error('live comparison work directory must be empty and non-link');
  const realWork = fs.realpathSync(work), playerRoot = fs.realpathSync(path.resolve(__dirname, '..'));
  const coreRoot = fs.realpathSync(path.resolve(playerRoot, '..', 'funkot-autodj-for-ui'));
  for (const source of [playerRoot, coreRoot]) {
    const relative = path.relative(source, realWork);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('live comparison work directory must be outside source checkouts');
  }
  const input = JSON.parse(fs.readFileSync(inputManifest, 'utf8'));
  if (!Array.isArray(input.files) || input.files.length !== 2) throw new Error('live comparison requires exactly two fixed inputs');
  const files = input.files.map(entry => {
    if (!entry || typeof entry.file !== 'string' || typeof entry.sha256 !== 'string') throw new Error('invalid fixed input');
    const file = fs.realpathSync(path.resolve(path.dirname(inputManifest), entry.file));
    if (sha(file) !== entry.sha256) throw new Error('fixed input hash does not match');
    return file;
  });
  const inputDirectory = fs.realpathSync(path.dirname(files[0]));
  if (files.some(file => fs.realpathSync(path.dirname(file)) !== inputDirectory) || fs.readdirSync(inputDirectory).length !== 2 ||
      files.some(file => !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw new Error('fixed inputs must be the only two regular files in one directory');
  const entries = input.files.map(item => ({ file: item.file, sha256: item.sha256 })).sort((a, b) => a.file.localeCompare(b.file));
  const inputIdentity = crypto.createHash('sha256').update(canonical(entries)).digest('hex');
  if (!recorderSource) {
    recorderSource = path.join(work, 'recorder-source');
    for (const [name, expected] of recorderSources()) {
      await acquire(path.join(recorderSource, name), `https://raw.githubusercontent.com/jasonulbright/pwshDoom/68719ae9ebe1446a13ac09eb2481c8f91f859960/${name}`, expected, deadline);
    }
  }
  if (!powershellArchive) {
    powershellArchive = path.join(work, 'PowerShell-7.6.9-win-x64.zip');
    await acquire(powershellArchive, 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.9/PowerShell-7.6.9-win-x64.zip', archiveHash, deadline);
  }
  const buildDirectory = path.join(work, 'player-build'), captureDirectory = path.join(work, 'capture'), observerDirectory = path.join(work, 'observer');
  for (const directory of [buildDirectory, captureDirectory, observerDirectory]) fs.mkdirSync(directory);
  event('building_player');
  const build = buildVerifiedPlayer({ workDirectory: buildDirectory, deadlineMs: remaining() });
  const observer = compileWindowsRouteObserver(observerDirectory);
  event('waiting_for_player_start');
  const captured = await superviseFreshCapture({
    build: () => ({ command: build.binary.file, args: [], buildWitness: build.buildWitness }),
    captureDirectory, guardFiles: [inputManifest, ...files], trustedObserver: observer, autoInputDirectory: inputDirectory,
    recorder: { sourceDirectory: recorderSource, powershellArchive }, deadlineMs: remaining(),
    control: {
      performOperation: async () => { fs.writeFileSync(path.join(captureDirectory, 'NEXT'), 'next', { flag: 'wx' }); },
      requestGracefulQuit: async () => { fs.writeFileSync(path.join(captureDirectory, 'QUIT'), 'quit', { flag: 'wx' }); }
    }
  });
  const witness = readCaptureWitness(captured.captureWitness);
  const player = path.resolve(__dirname, '..'), core = path.resolve(player, '..', 'funkot-autodj-for-ui');
  const sources = [path.join(core, 'funkot-core/src/engine.rs'), path.join(core, 'funkot-core/examples/manual_nav_acceptance.rs'),
    path.join(player, 'src-tauri/src/lib.rs'), path.join(player, 'src-tauri/src/navigation_capture.rs'), path.join(player, 'funkot-core.commit')];
  const sourceManifest = path.join(work, 'sources.json');
  write(sourceManifest, { files: sources.map(file => ({ file, sha256: sha(file) })) });
  const sourceReceipt = path.join(work, 'source-receipt.json');
  const inputHashes = input.files.map(item => item.sha256);
  write(sourceReceipt, { schema: 1, mode: 'fixed_input', run_id: witness.header.value.run_id,
    before: { input_sha256: inputIdentity, revision: build.coreRevision },
    after: { input_sha256: inputIdentity, revision: build.coreRevision }, source_edits: 0, ordered_input_hashes: inputHashes });
  const manifest = path.join(work, 'capture.json'), replayRecipe = path.join(work, 'replay-recipe.json');
  write(manifest, { schema: 1, core_git: build.coreRevision,
    identities: { source: { manifest: sourceManifest }, core: { file: sources[0] }, binary: { file: build.binary.file }, input: { manifest: inputManifest } },
    header: { file: witness.header.realpath }, trace: { file: witness.outputs.navigation_jsonl.realpath },
    audio: { pcm: { file: witness.recorder.pcm.file }, packets: { file: witness.recorder.packets.file },
      callbacks: { file: witness.outputs.callbacks_csv.realpath }, capture_rate: 44100 },
    source_receipt: { file: sourceReceipt, sha256: sha(sourceReceipt) } });
  write(replayRecipe, { schema: 2, work_directory: 'replay-work' });
  event('comparing');
  const result = compareEvidence({ captureManifestPath: manifest, replayPath: replayRecipe, scanPath: '-', captureWitness: captured.captureWitness, deadline });
  write(path.join(work, 'comparison.json'), result);
  return result;
}

module.exports = { compareLive, runLiveCycles };

if (require.main === module) {
  const [command, recipeFile] = process.argv.slice(2);
  if (command !== 'cycles' || !recipeFile || process.argv.length !== 4) {
    process.stderr.write('usage: node scripts/verified-live-comparison.cjs cycles <recipe.json>\n');
    process.exitCode = 2;
  } else {
    runLiveCycles(recipeFile).then(result => process.stdout.write(JSON.stringify(result) + '\n'), error => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
  }
}
