const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  PlayerBuildVerificationError,
  assertCargoDirectoriesInside,
  assertEmptyTaskRoot,
  capturePlayerInputInventory,
  cleanEnvironment,
  frontendConfigPath,
  readPin,
  readVerifiedPlayerBuild,
  verifyPlayerBuild,
  verifyPinnedCore
} = require('./verified-player-build.cjs');

test('Tauri receives a relative frontend directory rather than a file URL', () => {
  const player = path.resolve('player'), frontend = path.resolve('capture-work', 'frontend');
  const configured = frontendConfigPath(player, frontend);
  assert.equal(path.isAbsolute(configured), false);
  assert.equal(path.resolve(player, 'src-taauri', configured), frontend);
  assert.doesNotMatch(configured, /^[a-z]:/i);
});

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function temporaryRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(__dirname, prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return root;
}

function command(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

function syntheticRepository(t) {
  const root = temporaryRoot(t, '.verified-player-build-');
  command('git', ['init', '--quiet'], root);
  command('git', ['config', 'user.email', 'synthetic@example.invalid'], root);
  command('git', ['config', 'user.name', 'Synthetic'], root);
  write(path.join(root, 'tracked.txt'), 'tracked');
  command('git', ['add', 'tracked.txt'], root);
  command('git', ['commit', '--quiet', '-m', 'synthetic'], root);
  return root;
}

function execution() {
  return { cwd: process.cwd(), env: cleanEnvironment(), deadline: Date.now() + 5000 };
}

test('source inventory binds both tracked and untracked synthetic inputs', t => {
  const source = syntheticRepository(t);
  write(path.join(source, 'untracked.txt'), 'untracked');
  const before = capturePlayerInputInventory(source, execution());
  assert.equal(before.directory, fs.realpathSync(source));
  assert.deepEqual(before.files.map(file => file.path), ['tracked.txt', 'untracked.txt']);
  write(path.join(source, 'untracked.txt'), 'changed');
  const after = capturePlayerInputInventory(source, execution());
  assert.notEqual(after.sha256, before.sha256);
});

test('source inventory rejects a directory below, rather than at, the selected checkout root', t => {
  const source = syntheticRepository(t);
  const nested = path.join(source, 'nested');
  fs.mkdirSync(nested);
  assert.throws(() => capturePlayerInputInventory(nested, execution()), /checkout root/);
});

test('core verification requires matching lowercase pin and a clean sibling checkout', t => {
  const player = temporaryRoot(t, '.verified-player-pin-');
  const core = syntheticRepository(t);
  const head = commandOutput('git', ['rev-parse', 'HEAD'], core).trim();
  write(path.join(player, 'funkot-core.commit'), head + '\n');
  assert.equal(verifyPinnedCore(player, core, execution()), head);
  write(path.join(core, 'dirty.txt'), 'dirty');
  assert.throws(() => verifyPinnedCore(player, core, execution()), PlayerBuildVerificationError);
  write(path.join(player, 'funkot-core.commit'), head.toUpperCase());
  assert.throws(() => readPin(player), /lowercase/);
});

function commandOutput(commandName, args, cwd) {
  const result = spawnSync(commandName, args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

test('task root and Cargo metadata cannot escape the caller-owned build directory', t => {
  const root = temporaryRoot(t, '.verified-player-root-');
  const player = path.join(root, 'player');
  const core = path.join(root, 'core');
  const work = path.join(root, 'work');
  fs.mkdirSync(player); fs.mkdirSync(core); fs.mkdirSync(work);
  const actual = assertEmptyTaskRoot(work, player, core);
  fs.mkdirSync(path.join(actual, 'target'));
  fs.mkdirSync(path.join(actual, 'build'));
  assertCargoDirectoriesInside({ target_directory: path.join(actual, 'target'), build_directory: path.join(actual, 'build') }, actual);
  fs.mkdirSync(path.join(root, 'elsewhere'));
  assert.throws(() => assertCargoDirectoriesInside({ target_directory: path.join(root, 'elsewhere'), build_directory: path.join(actual, 'build') }, actual), /outside/);
  write(path.join(work, 'stale'), 'stale');
  assert.throws(() => assertEmptyTaskRoot(work, player, core), /empty/);
});

test('inherited source and toolchain configuration cannot steer the verified build', () => {
  const environment = cleanEnvironment({ Git_Dir: 'forged', GIT_WORK_TREE: 'forged', VITE_TOKEN: 'forged', TAURI_CONFIG: 'forged', NODE_OPTIONS: 'forged', NODE_PATH: 'forged', RUSTFLAGS: 'forged', CARGO_ENCODED_RUSTFLAGS: 'forged', RUSTC_WRAPPER: 'forged', FUNKOT_CORE_CANDIDATE_SHA: 'forged', CC: 'forged', KEEP: 'ok' });
  assert.deepEqual(environment, { KEEP: 'ok' });
});

test('only this process can read an issued build witness', () => {
  const forged = Object.freeze(Object.create(null));
  assert.throws(() => readVerifiedPlayerBuild(forged), /not issued by this process/);
  assert.throws(() => readVerifiedPlayerBuild(JSON.parse(JSON.stringify(forged))), /not issued by this process/);
  assert.throws(() => readVerifiedPlayerBuild({ binary: { file: 'old.exe', sha256: 'forged' } }), /not issued by this process/);
  assert.throws(() => verifyPlayerBuild(forged), /not issued by this process/);
});
