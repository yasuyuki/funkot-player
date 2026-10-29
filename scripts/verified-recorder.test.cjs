const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateRecorderEvidence, verifyRecorderEvidence } = require('./verified-recorder.cjs');

function fixture() {
  const wav = Buffer.alloc(44 + 882 * 4);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(176400, 28); wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  return {
    playerPid: 31, recorderPid: 32, wav,
    ready: { TargetProcessId: 31, CaptureProcessId: 32 },
    report: {
      TargetProcessId: 31, Error: null, Closed: true, StopReason: 'StopFile', Rate: 44100, Channels: 2, Bits: 16,
      Frames: 882, WavSha256: crypto.createHash('sha256').update(wav).digest('hex'),
      Sources: [
        { Path: 'scripts/Record-ProcessAudio.ps1', Sha256: 'f50876284d3e3958f2183cb483f13179fabaf45b87b8bcc221ba7f7113ef38cd' },
        { Path: 'src/ProcessAudioCapture.ps1', Sha256: 'a747786a2428f71c907f86ad631983548aae8c6450f422f64144d367b8e9e321' },
        { Path: 'src/CaptureClock.ps1', Sha256: 'ced03d531f7c129d9e079f1f3b548dd436efd81782974a3752d4689fa3e45dfb' }
      ],
      Packets: [
        { Index: 0, OutputFrame: 0, Frames: 441, Flags: 0, Qpc100ns: 1000000 },
        { Index: 1, OutputFrame: 441, Frames: 441, Flags: 2, Qpc100ns: 1100000 }
      ]
    }
  };
}

test('qualifies complete 44.1 kHz packets and emits exact anchors', () => {
  const result = validateRecorderEvidence(fixture());
  assert.equal(result.frames, 882);
  assert.equal(result.packetsCsv, 'file_frame,qpc_100ns,frames\n0,1000000,441\n441,1100000,441\n');
});

test('rejects unflagged QPC gaps as well as explicit discontinuity and unknown flags', () => {
  for (const change of [
    x => { x.report.Packets[1].Qpc100ns += 100000; },
    x => { x.report.Packets[1].Flags = 1; },
    x => { x.report.Packets[1].Flags = 4; },
    x => { x.report.Packets[1].Flags = 2 ** 32; },
    x => { x.report.Packets[1].OutputFrame++; },
    x => { x.report.Packets[1].Qpc100ns = x.report.Packets[0].Qpc100ns; }
  ]) {
    const input = fixture(); change(input);
    assert.throws(() => validateRecorderEvidence(input), /recorder evidence/);
  }
});

test('allows a forward gap only before the first rendered callback', () => {
  const input = fixture();
  input.report.Packets[1].Qpc100ns += 100000;
  assert.throws(() => validateRecorderEvidence(input), /packet time is discontinuous/);
  input.earliestRequiredQpc = 1300000;
  assert.equal(validateRecorderEvidence(input).prefixGaps, 1);
  input.earliestRequiredQpc = 1199999;
  assert.throws(() => validateRecorderEvidence(input), /packet time is discontinuous/);
  input.earliestRequiredQpc = 1300000;
  input.report.Packets[1].Qpc100ns = 1050000;
  assert.throws(() => validateRecorderEvidence(input), /packet time is discontinuous/);
});

test('rejects mismatched process, source, finalization, and WAV bytes', () => {
  for (const change of [
    x => { x.ready.CaptureProcessId++; },
    x => { x.report.TargetProcessId++; },
    x => { x.report.Sources[0].Sha256 = '0'.repeat(64); },
    x => { x.report.StopReason = 'Duration'; },
    x => { x.report.Closed = false; },
    x => { x.report.Error = 'capture failed'; },
    x => { x.report.Rate = 48000; },
    x => { x.wav[44] ^= 1; },
    x => { x.report.Frames--; }
  ]) {
    const input = fixture(); change(input);
    assert.throws(() => validateRecorderEvidence(input), /recorder evidence/);
  }
});

test('evidence recheck rejects changed recorder output or a new runtime file', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime'); fs.mkdirSync(runtime);
  const descriptor = name => {
    const file = path.join(root, name); fs.writeFileSync(file, name);
    return { file: fs.realpathSync(file), sha256: crypto.createHash('sha256').update(name).digest('hex') };
  };
  const ready = descriptor('ready'), report = descriptor('report'), pcm = descriptor('pcm'), packets = descriptor('packets');
  const value = { guards: [], runtime, runtimeFiles: [], ready, report, pcm, packets };
  verifyRecorderEvidence(value);
  fs.appendFileSync(pcm.file, 'changed');
  assert.throws(() => verifyRecorderEvidence(value), /output changed/);
  fs.writeFileSync(pcm.file, 'pcm');
  fs.writeFileSync(path.join(runtime, 'new.dll'), 'changed');
  assert.throws(() => verifyRecorderEvidence(value), /runtime inventory changed/);
});
