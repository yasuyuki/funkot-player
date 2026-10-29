const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { superviseFreshCapture } = require('./verified-capture.cjs');
const { compileWindowsRouteObserver } = require('./windows-route-observer.cjs');

const source = path.join(__dirname, 'windows-route-observer.cs');
const windowsOnly = process.platform !== 'win32';
const compiler = process.platform === 'win32'
  ? path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  : null;

function compiled(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-route-observer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'observer.exe');
  const build = spawnSync(compiler, ['/nologo', `/out:${executable}`, source], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  assert.ok(fs.statSync(executable).isFile());
  return executable;
}

test('observer fails closed for a nonexistent process id', { skip: windowsOnly }, t => {
  const executable = compiled(t);
  const result = spawnSync(executable, ['4294967295'], { encoding: 'utf8' });
  assert.ok([1, 3, 4].includes(result.status), result.stderr);
  assert.equal(result.stdout.trim(), '');
  if (result.status === 1) assert.match(result.stderr, /failed/);
  else assert.match(result.stderr, /no active render session/);
});

test('observer rejects a malformed process id', { skip: windowsOnly }, t => {
  const executable = compiled(t);
  const result = spawnSync(executable, ['not-a-pid'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stdout.trim(), '');
  assert.match(result.stderr, /usage/);
});

test('real observer never authorizes a fabricated stream without an OS session', { skip: windowsOnly }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-route-binding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const capture = path.join(root, 'capture'), observerDirectory = path.join(root, 'observer');
  fs.mkdirSync(capture); fs.mkdirSync(observerDirectory);
  const child = path.join(root, 'fake.cjs');
  fs.writeFileSync(child, `
const fs=require('node:fs'),path=require('node:path');
const root=process.env.FUNKOT_NAVIGATION_CAPTURE_DIR;
const stream={endpoint_id:'fabricated',rate:48000,channels:2,sample_format:'f32'};
fs.writeFileSync(path.join(root,'navigation-header.json'),JSON.stringify({schema_version:1,run_id:'fake',process_id:process.pid,silent_render:true}));
fs.writeFileSync(path.join(root,'output-stream.jsonl'),JSON.stringify({schema:1,run_id:'fake',process_id:process.pid,endpoint_id:'fabricated',stream})+'\\n');
setInterval(()=>{},100);
`);
  const trustedObserver = compileWindowsRouteObserver(observerDirectory);
  await assert.rejects(superviseFreshCapture({
    build: () => ({ command: process.execPath, args: [child] }), captureDirectory: capture,
    guardFiles: [child], trustedObserver,
    control: { waitForOperation: async () => ({ operation_complete: true, recorder_complete: true }), requestGracefulQuit: async () => {} },
    deadlineMs: 1500
  }), /trusted observer failed|did not observe|did not close before deadline/);
  assert.ok(fs.existsSync(path.join(capture, 'navigation-header.json')));
  assert.ok(fs.existsSync(path.join(capture, 'output-stream.jsonl')));
  assert.equal(fs.existsSync(path.join(capture, 'START.json')), false);
});
