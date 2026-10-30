const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { validateRecorderEvidence, startRecorder, verifyRecorderEvidence } = require('./verified-recorder.cjs');

function privateAdapter() {
  const file = path.join(__dirname, 'verified-recorder.cjs');
  const module = { exports: {} };
  vm.runInNewContext(`${fs.readFileSync(file, 'utf8')}\nmodule.exports.__testDerive = deriveF32Source;`, {
    Buffer, clearTimeout, console, module, process, require, setTimeout, __dirname, __filename: file
  }, { filename: file });
  return module.exports.__testDerive;
}

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

function f32Fixture() {
  const frames = 882, wav = Buffer.alloc(44 + frames * 8);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(384000, 28); wav.writeUInt16LE(8, 32);
  wav.writeUInt16LE(32, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  wav.writeFloatLE(0.25, 44); wav.writeFloatLE(-0.25, 48);
  const report = fixture().report;
  report.Rate = 48000; report.Bits = 32; report.Frames = frames;
  report.Sources = [
    { Path: 'scripts/Record-ProcessAudio.ps1', Sha256: '3ad7b2ca7ca58163604e17852b2129be9903a1104a9d63cda7dcdc50557197d5' },
    { Path: 'src/ProcessAudioCapture.ps1', Sha256: '384c22bc5e1869570fe26e9d350660542ba536d70480ab13f331adc9ec11dfaa' },
    { Path: 'src/CaptureClock.ps1', Sha256: 'ced03d531f7c129d9e079f1f3b548dd436efd81782974a3752d4689fa3e45dfb' }
  ];
  report.Packets = [
    { Index: 0, OutputFrame: 0, Frames: 441, Flags: 0, Qpc100ns: 1000000 },
    { Index: 1, OutputFrame: 441, Frames: 441, Flags: 2, Qpc100ns: 1091875 }
  ];
  report.WavSha256 = crypto.createHash('sha256').update(wav).digest('hex');
  return { playerPid: 31, recorderPid: 32, wav, ready: { TargetProcessId: 31, CaptureProcessId: 32 }, report };
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

test('qualifies 48 kHz stereo IEEE float packets without conversion', () => {
  const normal = f32Fixture();
  assert.equal(normal.wav.readFloatLE(44), 0.25);
  assert.equal(normal.wav.readFloatLE(52), 0);
  assert.equal(validateRecorderEvidence({ ...normal, format: 'f32_48000' }).frames, 882);
  const silence = f32Fixture();
  silence.wav.fill(0, 44);
  silence.report.WavSha256 = crypto.createHash('sha256').update(silence.wav).digest('hex');
  assert.equal(validateRecorderEvidence({ ...silence, format: 'f32_48000' }).frames, 882);
});

test('adapts each pinned PCM16 recorder source deterministically and rejects source tampering', () => {
  const adapt = privateAdapter();
  const processSource = Buffer.from('Rate=44100;BufferFrames $format.Tag=1;$format.Channels=2;$format.Rate=44100;$format.BytesPerSecond=176400;$format.Align=4;$format.Bits=16 $bytes=[byte[]]::new($frames*4)');
  assert.equal(adapt('src/ProcessAudioCapture.ps1', processSource).toString(), 'Rate=48000;BufferFrames $format.Tag=3;$format.Channels=2;$format.Rate=48000;$format.BytesPerSecond=384000;$format.Align=8;$format.Bits=32 $bytes=[byte[]]::new($frames*8)');
  const scriptSource = Buffer.from('$writer.Write([uint16]1);$writer.Write([uint16]2);$writer.Write([uint32]44100);$writer.Write([uint32]176400);$writer.Write([uint16]4);$writer.Write([uint16]16) Rate=44100;Channels=2;Bits=16; fixed 44.1 kHz stereo PCM16');
  assert.equal(adapt('scripts/Record-ProcessAudio.ps1', scriptSource).toString(), '$writer.Write([uint16]3);$writer.Write([uint16]2);$writer.Write([uint32]48000);$writer.Write([uint32]384000);$writer.Write([uint16]8);$writer.Write([uint16]32) Rate=48000;Channels=2;Bits=32; fixed 48 kHz stereo IEEE float32');
  assert.throws(() => adapt('src/ProcessAudioCapture.ps1', Buffer.from('Rate=44100;BufferFrames')), /source adaptation/);
  assert.throws(() => adapt('scripts/Record-ProcessAudio.ps1', Buffer.concat([scriptSource, scriptSource])), /source adaptation/);
});

test('f32 mode rejects PCM16, wrong derived sources, headers, layout, flags, and missing frames', () => {
  for (const change of [
    x => { const old = fixture(); Object.assign(x, old); },
    x => { x.report.Sources[0].Sha256 = '0'.repeat(64); },
    x => { x.wav.writeUInt16LE(1, 20); },
    x => { x.wav.writeUInt32LE(44100, 24); },
    x => { x.wav.writeUInt16LE(4, 32); },
    x => { x.report.Packets[1].Flags = 1; },
    x => { x.report.Frames--; x.wav = x.wav.subarray(0, x.wav.length - 8); x.wav.writeUInt32LE(x.wav.length - 8, 4); x.wav.writeUInt32LE(x.wav.length - 44, 40); x.report.WavSha256 = crypto.createHash('sha256').update(x.wav).digest('hex'); }
  ]) {
    const input = f32Fixture(); change(input);
    assert.throws(() => validateRecorderEvidence({ ...input, format: 'f32_48000' }), /recorder evidence/);
  }
});

test('rejects a forged prepared recorder before Windows execution', async () => {
  await assert.rejects(startRecorder({ root: process.cwd(), playerPid: 1, deadline: Date.now() + 1000, format: 'f32_48000', prepared: {} }), /recorder preparation is not valid/);
  await assert.rejects(startRecorder({ root: process.cwd(), playerPid: 1, deadline: Date.now() + 1000, format: 'f32_48000', prepared: Object.freeze({ executable: process.execPath, recorderScript: __filename, guards: [] }) }), /recorder preparation is not valid/);
  await assert.rejects(startRecorder({ root: process.cwd(), playerPid: 1, deadline: Date.now() + 1000, format: 'pcm16_44100', prepared: {} }), /prepared recorder format does not match/);
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
