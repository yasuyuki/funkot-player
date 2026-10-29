/*
 * Builds the desktop player only from this checkout and its pinned sibling.
 * This module deliberately has no recipe or command-line interface: callers
 * receive the produced executable, not a way to choose one.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const verifiedBuildWitnesses = new WeakMap();

class PlayerBuildVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlayerBuildVerificationError';
  }
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function immutableSnapshot(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableSnapshot));
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[key] = immutableSnapshot(item);
    return Object.freeze(copy);
  }
  return value;
}

function readVerifiedPlayerBuild(buildWitness) {
  if (!buildWitness || typeof buildWitness !== 'object' || !verifiedBuildWitnesses.has(buildWitness)) {
    throw new PlayerBuildVerificationError('verified player build witness was not issued by this process');
  }
  return verifiedBuildWitnesses.get(buildWitness);
}

function verifyPlayerBuild(buildWitness) {
  const snapshot = readVerifiedPlayerBuild(buildWitness);
  const playerDirectory = snapshot.guardedInputs.playerSource.directory;
  const coreDirectory = snapshot.guardedInputs.coreDirectory;
  const execution = { cwd: playerDirectory, env: cleanEnvironment(), deadline: undefined };
  const currentSource = capturePlayerInputInventory(playerDirectory, execution);
  if (!sameInventory(snapshot.guardedInputs.playerSource, currentSource)) {
    throw new PlayerBuildVerificationError('player tracked or untracked source changed after the verified build');
  }
  if (verifyPinnedCore(playerDirectory, coreDirectory, execution) !== snapshot.coreRevision) {
    throw new PlayerBuildVerificationError('pinned funkot-core revision changed after the verified build');
  }
  const currentFrontend = captureGeneratedInventory(snapshot.guardedInputs.frontend.directory, 'generated frontend');
  if (!sameInventory(snapshot.guardedInputs.frontend, currentFrontend)) {
    throw new PlayerBuildVerificationError('generated frontend changed after the verified build');
  }
  let binary;
  try {
    const stat = fs.lstatSync(snapshot.binary.file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
    binary = fs.realpathSync(snapshot.binary.file);
  } catch {
    throw new PlayerBuildVerificationError('verified player executable is no longer a regular file');
  }
  if (!samePath(binary, snapshot.binary.file) || sha256(binary) !== snapshot.binary.sha256) {
    throw new PlayerBuildVerificationError('verified player executable changed after the verified build');
  }
  // Callers supply and authorize capture/replay inputs; this check only rebinds the build inputs and executable.
  return snapshot;
}

function cleanEnvironment(base = process.env) {
  const environment = { ...base };
  for (const key of Object.keys(environment)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('GIT_') || upper.startsWith('VITE_') || upper.startsWith('CARGO_') || upper.startsWith('RUST') || upper === 'TAURI_CONFIG' || upper === 'NODE_OPTIONS' || upper === 'NODE_PATH' || upper === 'FUNKOT_CORE_CANDIDATE_SHA' || ['CC', 'CXX', 'AR', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS'].includes(upper)) delete environment[key];
  }
  return environment;
}

function requireDirectory(directory, description) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    throw new PlayerBuildVerificationError(`${description} does not exist`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PlayerBuildVerificationError(`${description} must be a real directory`);
  return fs.realpathSync(directory);
}

function run(command, args, { cwd, env, deadline }) {
  const remaining = deadline === undefined ? undefined : deadline - Date.now();
  if (remaining !== undefined && (!Number.isFinite(remaining) || remaining <= 0)) throw new PlayerBuildVerificationError('verified player build exceeded its caller-provided deadline');
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    ...(remaining === undefined ? {} : { timeout: Math.ceil(remaining) }),
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    throw new PlayerBuildVerificationError(`verified player build command failed: ${command}`);
  }
  return result.stdout;
}

function git(directory, args, execution) {
  return run('git', ['-C', directory, ...args], execution).trim();
}

function readPin(playerDirectory) {
  const pin = fs.readFileSync(path.join(playerDirectory, 'funkot-core.commit'), 'utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(pin)) throw new PlayerBuildVerificationError('funkot-core.commit must be a lowercase 40-character commit ID');
  return pin;
}

function verifyPinnedCore(playerDirectory, coreDirectory, execution) {
  const core = requireDirectory(coreDirectory, 'pinned funkot-core checkout');
  const pin = readPin(playerDirectory);
  const topLevel = fs.realpathSync(git(core, ['rev-parse', '--show-toplevel'], execution));
  const head = git(core, ['rev-parse', 'HEAD'], execution);
  const status = git(core, ['status', '--porcelain', '--untracked-files=all'], execution);
  if (!samePath(topLevel, core) || head !== pin || status !== '') {
    throw new PlayerBuildVerificationError('pinned funkot-core checkout must remain clean and at funkot-core.commit');
  }
  return pin;
}

function capturePlayerInputInventory(playerDirectory, execution) {
  const player = requireDirectory(playerDirectory, 'player checkout');
  const topLevel = fs.realpathSync(git(player, ['rev-parse', '--show-toplevel'], execution));
  if (!samePath(topLevel, player)) throw new PlayerBuildVerificationError('selected player directory is not its Git checkout root');
  const listed = run('git', ['-C', player, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], execution);
  const names = listed.split('\0').filter(Boolean).sort();
  const files = names.map(name => {
    const file = path.resolve(player, name);
    if (!isInside(file, player)) throw new PlayerBuildVerificationError('player source inventory escaped its checkout');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new PlayerBuildVerificationError(`player source inventory requires regular files: ${name}`);
    if (!isInside(fs.realpathSync(file), player)) throw new PlayerBuildVerificationError(`player source inventory follows a linked ancestor: ${name}`);
    return { path: name.replaceAll(path.sep, '/'), sha256: sha256(file), bytes: stat.size };
  });
  const digest = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return { directory: player, files, sha256: digest };
}

function captureGeneratedInventory(directory, description) {
  const root = requireDirectory(directory, description);
  const files = [];
  const visit = (current, relative = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const file = path.join(current, entry.name);
      const name = path.join(relative, entry.name).replaceAll(path.sep, '/');
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new PlayerBuildVerificationError(`${description} must not contain links: ${name}`);
      if (stat.isDirectory()) visit(file, name);
      else if (stat.isFile()) {
        if (!isInside(fs.realpathSync(file), root)) throw new PlayerBuildVerificationError(`${description} escaped its task-owned directory: ${name}`);
        files.push({ path: name, sha256: sha256(file), bytes: stat.size });
      } else throw new PlayerBuildVerificationError(`${description} must contain only regular files and directories: ${name}`);
    }
  };
  visit(root);
  return { directory: root, files, sha256: crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

function sameInventory(left, right) {
  return left.sha256 === right.sha256 && JSON.stringify(left.files) === JSON.stringify(right.files);
}

function assertEmptyTaskRoot(workDirectory, playerDirectory, coreDirectory) {
  const work = requireDirectory(workDirectory, 'task-owned build directory');
  if (isInside(work, playerDirectory) || isInside(work, coreDirectory)) {
    throw new PlayerBuildVerificationError('task-owned build directory must be outside both source checkouts');
  }
  if (fs.readdirSync(work).length !== 0) throw new PlayerBuildVerificationError('task-owned build directory must be empty');
  return work;
}

function assertCargoDirectoriesInside(metadata, workDirectory) {
  if (!metadata || typeof metadata.target_directory !== 'string' || typeof metadata.build_directory !== 'string') {
    throw new PlayerBuildVerificationError('Cargo metadata did not report target and build directories');
  }
  const work = requireDirectory(workDirectory, 'task-owned build directory');
  let target;
  let build;
  try {
    target = fs.realpathSync(path.resolve(metadata.target_directory));
    build = fs.realpathSync(path.resolve(metadata.build_directory));
  } catch {
    throw new PlayerBuildVerificationError('Cargo metadata output directory does not exist');
  }
  if (!isInside(target, work) || !isInside(build, work)) {
    throw new PlayerBuildVerificationError('Cargo metadata output directories are outside the task-owned build directory');
  }
  return { target, build };
}

function freshIdentifier(playerDirectory) {
  const config = JSON.parse(fs.readFileSync(path.join(playerDirectory, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const base = config.identifier;
  if (typeof base !== 'string' || !/^[A-Za-z][A-Za-z0-9.-]*$/.test(base)) {
    throw new PlayerBuildVerificationError('player Tauri identifier is invalid');
  }
  return `${base}.verified${crypto.randomUUID().replaceAll('-', '')}`;
}

function frontendConfigPath(playerDirectory, frontend) {
  const relative = path.relative(path.join(playerDirectory, 'src-tauri'), frontend);
  if (!relative || path.isAbsolute(relative)) throw new PlayerBuildVerificationError('frontend must be addressable by a relative Tauri path');
  return relative.replaceAll('\\', '/');
}

function buildVerifiedPlayer({ workDirectory, deadlineMs }) {
  if (deadlineMs !== undefined && (!Number.isFinite(deadlineMs) || deadlineMs <= 0)) throw new PlayerBuildVerificationError('the build deadline must be positive when provided');
  const playerDirectory = requireDirectory(path.resolve(__dirname, '..'), 'player checkout');
  const coreDirectory = requireDirectory(path.resolve(playerDirectory, '..', 'funkot-autodj-for-ui'), 'pinned funkot-core checkout');
  const work = assertEmptyTaskRoot(workDirectory, playerDirectory, coreDirectory);
  const deadline = deadlineMs === undefined ? undefined : Date.now() + deadlineMs;
  const environment = cleanEnvironment();
  const execution = { cwd: playerDirectory, env: environment, deadline };
  const pin = verifyPinnedCore(playerDirectory, coreDirectory, execution);
  const before = capturePlayerInputInventory(playerDirectory, execution);
  const frontend = path.join(work, 'frontend');
  const target = path.join(work, 'target');
  const build = path.join(work, 'build');
  fs.mkdirSync(frontend);
  fs.mkdirSync(target);
  fs.mkdirSync(build);
  const vite = path.join(playerDirectory, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(vite)) throw new PlayerBuildVerificationError('the checked-out Vite entry is unavailable; dependency installation is outside this builder');
  run(process.execPath, [vite, 'build', '--outDir', frontend], execution);
  const frontendBeforeCargo = captureGeneratedInventory(frontend, 'generated frontend');
  const identifier = freshIdentifier(playerDirectory);
  const cargoEnvironment = {
    ...environment,
    CARGO_TARGET_DIR: target,
    CARGO_BUILD_BUILD_DIR: build,
    TAURI_CONFIG: JSON.stringify({ identifier, build: { frontendDist: frontendConfigPath(playerDirectory, frontend) } })
  };
  const cargoExecution = { cwd: playerDirectory, env: cargoEnvironment, deadline };
  const manifest = path.join(playerDirectory, 'src-tauri', 'Cargo.toml');
  const metadata = JSON.parse(run('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1', '--manifest-path', manifest], cargoExecution));
  const isolated = assertCargoDirectoriesInside(metadata, work);
  run('cargo', ['build', '--locked', '--release', '--features', 'custom-protocol,verified-capture', '--manifest-path', manifest], cargoExecution);
  const binary = path.join(isolated.target, 'release', `funkot-player${process.platform === 'win32' ? '.exe' : ''}`);
  if (!fs.existsSync(binary) || !fs.lstatSync(binary).isFile() || fs.lstatSync(binary).isSymbolicLink()) throw new PlayerBuildVerificationError('Cargo did not produce the expected player executable');
  const actualBinary = fs.realpathSync(binary);
  if (!isInside(actualBinary, isolated.target)) throw new PlayerBuildVerificationError('produced player executable escaped the isolated Cargo target directory');
  const after = capturePlayerInputInventory(playerDirectory, execution);
  if (!sameInventory(before, after)) throw new PlayerBuildVerificationError('player tracked or untracked source changed during the verified build');
  const frontendAfterCargo = captureGeneratedInventory(frontend, 'generated frontend');
  if (!sameInventory(frontendBeforeCargo, frontendAfterCargo)) throw new PlayerBuildVerificationError('generated frontend changed during the verified build');
  if (verifyPinnedCore(playerDirectory, coreDirectory, execution) !== pin) throw new PlayerBuildVerificationError('pinned funkot-core revision changed during the verified build');
  const binarySha256 = sha256(actualBinary);
  if (sha256(actualBinary) !== binarySha256) throw new PlayerBuildVerificationError('produced player executable changed before it could be returned');
  const snapshot = immutableSnapshot({
    binary: { file: actualBinary, sha256: binarySha256 },
    binarySha256,
    identifier,
    coreRevision: pin,
    guardedInputs: {
      playerSource: { directory: playerDirectory, ...before },
      corePin: { file: path.join(playerDirectory, 'funkot-core.commit'), sha256: sha256(path.join(playerDirectory, 'funkot-core.commit')) },
      coreDirectory,
      frontend: frontendAfterCargo,
      cargo: isolated
    }
  });
  const buildWitness = Object.freeze(Object.create(null));
  verifiedBuildWitnesses.set(buildWitness, snapshot);
  return Object.freeze({ ...snapshot, buildWitness });
}

module.exports = {
  PlayerBuildVerificationError,
  assertCargoDirectoriesInside,
  assertEmptyTaskRoot,
  capturePlayerInputInventory,
  captureGeneratedInventory,
  cleanEnvironment,
  frontendConfigPath,
  readPin,
  verifyPinnedCore,
  buildVerifiedPlayer,
  readVerifiedPlayerBuild,
  verifyPlayerBuild
};
