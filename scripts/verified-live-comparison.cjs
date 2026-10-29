const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildVerifiedPlayer } = require('./verified-player-build.cjs');
const { superviseFreshCapture, readCaptureWitness } = require('./verified-capture.cjs');
const { compileWindowsRouteObserver } = require('./windows-route-observer.cjs');
const { compareEvidence } = require('./audio-anomaly-comparison.cjs');
const { recorderSources, archiveHash } = require('./verified-recorder.cjs');

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const event = name => process.stderr.write(JSON.stringify({ event: name }) + '\n');
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

module.exports = { compareLive };
