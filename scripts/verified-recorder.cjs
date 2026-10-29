const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const sourceHashes = new Map([
  ['scripts/Record-ProcessAudio.ps1', 'f50876284d3e3958f2183cb483f13179fabaf45b87b8bcc221ba7f7113ef38cd'],
  ['src/ProcessAudioCapture.ps1', 'a747786a2428f71c907f86ad631983548aae8c6450f422f64144d367b8e9e321'],
  ['src/CaptureClock.ps1', 'ced03d531f7c129d9e079f1f3b548dd436efd81782974a3752d4689fa3e45dfb']
]);
const powershellHash = '2a6769a3330dc1084d0154bfde7d164ab750ca7f700f313f9d417c1be78b2233';
const archiveHash = 'ce7484804c0f0ad4dda10c958e71acdaf7eebfb22505c1b480f89e0e9f1da94d';

function fail(message) { throw new Error(`recorder evidence: ${message}`); }
function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`invalid ${name}`);
  return value;
}

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function regularFile(file) {
  if (!path.isAbsolute(file)) fail('recorder path must be absolute');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('recorder input must be a regular file');
  return fs.realpathSync(file);
}

function verifyGuards(guards) {
  for (const { file, sha256 } of guards) {
    if (regularFile(file) !== file || hash(file) !== sha256) fail('recorder input changed');
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function inventory(directory) {
  const files = [];
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail('recorder runtime contains a link');
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) files.push({ file: fs.realpathSync(file), sha256: hash(file) });
      else fail('recorder runtime contains a non-regular file');
    }
  }
  visit(directory);
  return files;
}

async function startRecorder({ root, sourceDirectory, powershellArchive, playerPid, deadline, signal }) {
  if (process.platform !== 'win32') fail('process loopback requires Windows');
  integer(playerPid, 'player PID', 1);
  const archive = regularFile(powershellArchive);
  if (hash(archive) !== archiveHash) fail('PowerShell archive does not match the pinned official release');
  const runtime = path.join(root, 'recorder-runtime');
  fs.mkdirSync(runtime);
  const tar = regularFile(path.join(process.env.SystemRoot, 'System32', 'tar.exe'));
  const extracted = spawnSync(tar, ['-xf', archive, '-C', runtime], { windowsHide: true, stdio: 'ignore', timeout: Math.max(1, deadline - Date.now()) });
  if (extracted.error || extracted.status !== 0 || hash(archive) !== archiveHash) fail('PowerShell archive extraction failed');
  const runtimeFiles = inventory(runtime);
  const executable = regularFile(path.join(runtime, 'pwsh.exe'));
  if (hash(executable) !== powershellHash) fail('PowerShell executable does not match the pinned official release');
  const guards = [{ file: archive, sha256: archiveHash }, ...runtimeFiles];
  let recorderScript;
  for (const [name, expected] of sourceHashes) {
    const file = regularFile(path.resolve(sourceDirectory, name));
    if (hash(file) !== expected) fail('recorder source does not match pinned public revision');
    guards.push({ file, sha256: expected });
    if (name === 'scripts/Record-ProcessAudio.ps1') recorderScript = file;
  }
  const prefix = path.join(root, 'process-loopback');
  const readyFile = `${prefix}.ready`, stopFile = `${prefix}.stop`, reportFile = `${prefix}.json`, wavFile = `${prefix}.wav`, packetsFile = `${prefix}.csv`;
  for (const file of [readyFile, stopFile, reportFile, wavFile, packetsFile]) if (fs.existsSync(file)) fail('recorder output already exists');
  const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-File', recorderScript,
    '-TargetProcessId', String(playerPid), '-OutputPrefix', prefix, '-ReadyFile', readyFile,
    '-StopFile', stopFile, '-Seconds', '660'], { cwd: root, windowsHide: true, stdio: 'ignore' });
  const state = { child, playerPid, readyFile, stopFile, reportFile, wavFile, packetsFile, guards, runtime, runtimeFiles, deadline, error: null };
  child.once('error', error => { state.error = error; });
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) fail('recorder startup aborted');
      if (state.error || child.exitCode !== null || child.signalCode !== null) fail('recorder exited before ready');
      if (fs.existsSync(readyFile)) {
        let ready;
        try { ready = readJson(regularFile(readyFile)); } catch { await pause(20); continue; }
        if (ready.TargetProcessId !== playerPid || ready.CaptureProcessId !== child.pid) fail('recorder ready process does not match');
        verifyGuards(guards);
        state.ready = ready;
        state.readyHash = hash(readyFile);
        return state;
      }
      await pause(20);
    }
    fail('recorder did not become ready');
  } catch (error) {
    await abortRecorder(state);
    throw error;
  }
}

async function finishRecorder(state, deadline, signal, callbacksFile) {
  if (state.error || state.child.exitCode !== null || state.child.signalCode !== null) fail('recorder exited before stop');
  const beforeStop = fs.statSync(regularFile(state.wavFile)).size;
  while (Date.now() < deadline) {
    if (signal?.aborted) fail('recorder completion aborted');
    if (state.error || state.child.exitCode !== null || state.child.signalCode !== null) fail('recorder exited before final packet');
    if (fs.statSync(regularFile(state.wavFile)).size > beforeStop) break;
    await pause(20);
  }
  if (Date.now() >= deadline) fail('recorder did not advance after capture completion');
  fs.writeFileSync(state.stopFile, 'stop', { flag: 'wx' });
  while (state.child.exitCode === null && state.child.signalCode === null && Date.now() < deadline) {
    if (signal?.aborted) fail('recorder completion aborted');
    await pause(20);
  }
  if (state.child.exitCode !== 0 || state.child.signalCode !== null) fail('recorder did not exit successfully');
  verifyGuards(state.guards);
  if (hash(regularFile(state.readyFile)) !== state.readyHash) fail('recorder ready evidence changed');
  const reportFile = regularFile(state.reportFile), wavFile = regularFile(state.wavFile);
  const report = readJson(reportFile);
  let callbackEvidence;
  let earliestRequiredQpc;
  if (callbacksFile) {
    const file = regularFile(callbacksFile);
    const callbacks = require('./audio-anomaly-analysis.cjs').callbackCsv(file);
    const advancing = callbacks.filter(callback => callback.engine_start !== null && callback.engine_end > callback.engine_start);
    if (!advancing.length) fail('rendered callback evidence is missing');
    earliestRequiredQpc = advancing.reduce((earliest, callback) => Math.min(earliest,
      integer(callback.callback_qpc_100ns, 'callback QPC', 1), integer(callback.playback_qpc_100ns, 'playback QPC', 1)), Infinity);
    callbackEvidence = { file, sha256: hash(file) };
  }
  const value = validateRecorderEvidence({ ready: state.ready, report, wav: fs.readFileSync(wavFile), playerPid: state.playerPid, recorderPid: state.child.pid, earliestRequiredQpc });
  fs.writeFileSync(state.packetsFile, value.packetsCsv, { flag: 'wx' });
  return { playerPid: state.playerPid, recorderPid: state.child.pid, guards: state.guards, runtime: state.runtime, runtimeFiles: state.runtimeFiles,
    ...(callbackEvidence ? { callbacks: callbackEvidence, prefixGaps: value.prefixGaps, earliestRequiredQpc } : {}),
    ready: { file: state.readyFile, sha256: state.readyHash },
    report: { file: reportFile, sha256: hash(reportFile) },
    pcm: { file: wavFile, sha256: value.sha256, frames: value.frames },
    packets: { file: regularFile(state.packetsFile), sha256: hash(state.packetsFile) } };
}

async function abortRecorder(state) {
  if (!state || state.child.exitCode !== null || state.child.signalCode !== null) return;
  const child = state.child;
  const closed = new Promise(resolve => child.once('close', resolve));
  const taskkill = path.join(process.env.SystemRoot, 'System32', 'taskkill.exe');
  const result = spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  if ((result.error || result.status !== 0) && child.exitCode === null && child.signalCode === null) {
    fail('recorder process tree could not be stopped');
  }
  if (child.exitCode === null && child.signalCode === null) {
    let timer;
    const completed = await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), Math.max(1, state.deadline - Date.now())); })]);
    clearTimeout(timer);
    if (!completed) fail('recorder process did not close before deadline');
  }
}

function verifyRecorderEvidence(recorder) {
  verifyGuards(recorder.guards);
  if (JSON.stringify(inventory(recorder.runtime)) !== JSON.stringify(recorder.runtimeFiles)) fail('recorder runtime inventory changed');
  for (const entry of [recorder.ready, recorder.report, recorder.pcm, recorder.packets, ...(recorder.callbacks ? [recorder.callbacks] : [])]) {
    if (regularFile(entry.file) !== entry.file || hash(entry.file) !== entry.sha256) fail('recorder output changed');
  }
}

// This validates the recorder's finished bytes; it does not issue a witness.
// The caller must itself own and observe the recorder and player processes.
function validateRecorderEvidence({ ready, report, wav, playerPid, recorderPid, earliestRequiredQpc }) {
  integer(playerPid, 'player PID', 1);
  integer(recorderPid, 'recorder PID', 1);
  if (!ready || ready.TargetProcessId !== playerPid || ready.CaptureProcessId !== recorderPid ||
      !report || report.TargetProcessId !== playerPid) fail('process identity does not match');
  if (report.Error != null || report.Closed !== true || report.StopReason !== 'StopFile') fail('recorder did not close after explicit stop');
  if (report.Rate !== 44100 || report.Channels !== 2 || report.Bits !== 16) fail('unexpected capture format');
  if (!Array.isArray(report.Sources) || report.Sources.length !== sourceHashes.size) fail('source inventory is incomplete');
  const sources = new Map(report.Sources.map(source => [source.Path, String(source.Sha256).toLowerCase()]));
  if (sources.size !== sourceHashes.size || [...sourceHashes].some(([name, hash]) => sources.get(name) !== hash)) fail('source identity does not match');
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' ||
      wav.toString('ascii', 8, 16) !== 'WAVEfmt ' || wav.readUInt32LE(16) !== 16 ||
      wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 2 || wav.readUInt32LE(24) !== 44100 ||
      wav.readUInt32LE(28) !== 176400 || wav.readUInt16LE(32) !== 4 || wav.readUInt16LE(34) !== 16 ||
      wav.toString('ascii', 36, 40) !== 'data' || wav.readUInt32LE(4) !== wav.length - 8 ||
      wav.readUInt32LE(40) !== wav.length - 44 || (wav.length - 44) % 4) fail('invalid WAV layout');
  const frames = (wav.length - 44) / 4;
  if (!frames || report.Frames !== frames) fail('WAV frame count does not match');
  const hash = crypto.createHash('sha256').update(wav).digest('hex');
  if (typeof report.WavSha256 !== 'string' || report.WavSha256.toLowerCase() !== hash) fail('WAV hash does not match');
  if (!Array.isArray(report.Packets) || report.Packets.length < 2) fail('packet evidence is incomplete');
  let frame = 0;
  let previous;
  let prefixGaps = 0;
  const rows = ['file_frame,qpc_100ns,frames'];
  for (const [index, packet] of report.Packets.entries()) {
    if (!packet || integer(packet.Index, 'packet index') !== index || integer(packet.OutputFrame, 'packet frame') !== frame) fail('packet order is discontinuous');
    integer(packet.Frames, 'packet length', 1);
    integer(packet.Qpc100ns, 'packet QPC', 1);
    if (![0, 2].includes(integer(packet.Flags, 'packet flags'))) fail('packet discontinuity or timestamp error');
    if (previous) {
      const delta = BigInt(packet.Qpc100ns) - BigInt(previous.Qpc100ns);
      if (delta <= 0n) fail('packet QPC is not increasing');
      const error = delta * 44100n - BigInt(previous.Frames) * 10000000n;
      // Both timestamps are quantized to 100 ns; their difference can err by less than one tick.
      if (error <= -44100n || error >= 44100n) {
        if (error < 0n || !Number.isSafeInteger(earliestRequiredQpc) || packet.Qpc100ns > earliestRequiredQpc) fail('packet time is discontinuous');
        prefixGaps++;
      }
    }
    rows.push(`${packet.OutputFrame},${packet.Qpc100ns},${packet.Frames}`);
    frame += packet.Frames;
    if (!Number.isSafeInteger(frame)) fail('packet frame count overflow');
    previous = packet;
  }
  if (frame !== frames) fail('packet coverage does not match WAV');
  return { frames, sha256: hash, packetsCsv: rows.join('\n') + '\n', prefixGaps };
}

module.exports = { validateRecorderEvidence, startRecorder, finishRecorder, abortRecorder, verifyRecorderEvidence,
  recorderSources: () => [...sourceHashes], archiveHash };
