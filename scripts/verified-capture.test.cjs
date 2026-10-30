const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { superviseFreshCapture, CaptureVerificationError, readCaptureWitness } = require('./verified-capture.cjs');

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function fixture(t, mode = 'valid') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-capture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const capture = path.join(root, 'capture');
  fs.mkdirSync(capture);
  const guard = path.join(root, 'guard.bin');
  write(guard, 'guard');
  const child = path.join(root, 'child.cjs');
  const grandchild = path.join(root, 'grandchild.cjs');
  write(grandchild, 'setInterval(() => {}, 1000);\n');
  write(child, `
const fs=require('node:fs'), path=require('node:path');
const root=process.env.FUNKOT_NAVIGATION_CAPTURE_DIR, mode=process.env.TEST_MODE;
if(mode==='tree-stall') { const c=require('node:child_process').spawn(process.execPath,[process.env.GRANDCHILD],{stdio:'ignore',windowsHide:true}); fs.writeFileSync(path.join(root,'descendant-pid'),String(c.pid)); }
fs.writeFileSync(path.join(root,'child-env.json'), JSON.stringify({webviewFolder:process.env.WEBVIEW2_USER_DATA_FOLDER, webviewArgs:process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, automationInput:process.env.FUNKOT_NAVIGATION_AUTOMATION_INPUT_DIR}));
const stream={endpoint_id:'endpoint',rate:48000,channels:2,sample_format:'f32'};
if(mode==='early') process.exit(0);
const header={schema_version:1,run_id:'run',process_id:process.pid,silent_render:true,options:{output_sample_rate:48000}};
if(mode==='header-audible') header.silent_render=false;
if(mode==='header-missing') delete header.silent_render;
if(mode==='header-nonboolean') header.silent_render='false';
fs.writeFileSync(path.join(root,'navigation-header.json'),JSON.stringify(header)+'\\n');
fs.writeFileSync(path.join(root,'output-stream.jsonl'),JSON.stringify({schema:1,run_id:'run',process_id:process.pid,endpoint_id:'endpoint',stream})+'\\n');
let completed=false;
const trace=()=>[ {kind:'requested',request_id:7,label:'next-7',action:'transition_to_next'}, {kind:'accepted',generation:7,action:'transition_to_next',source_generation:9,target_source_generation:10,current_index:0,target_index:1,active_preview:false,active_head_only:false,target_preview:false,target_head_only:false,render_frame:440,active_playhead:220}, {kind:'plan_applied',generation:7,target_source_generation:10,target_index:1,render_frame:442,plan:{generation:7,start:430,entry:12,simple:false,reason:'manual'}}, {kind:'transition_started',generation:7,source_generation:10,target_source_generation:10,current_index:1,target_index:1,render_frame:500}, {kind:'fade_completed',generation:7,source_generation:10,target_source_generation:10,current_index:1,target_index:1,render_frame:600} ];
const callbackHeader='sequence,callback_qpc_100ns,playback_qpc_100ns,output_frames,engine_start,engine_end,paused,audition,render_lock_miss,trace_dropped\\n';
const timer=setInterval(()=>{ const start=path.join(root,'START.json'); if(!fs.existsSync(start) || mode==='stall' || mode==='tree-stall') return; if(mode==='mutate') fs.writeFileSync(process.env.GUARD,'changed'); if(mode==='fake-root-json') fs.writeFileSync(path.join(root,'endpoint-receipt.json'),'{}'); if(mode==='rewrite-header') fs.writeFileSync(path.join(root,'navigation-header.json'),JSON.stringify({schema_version:1,run_id:'run',process_id:process.pid,silent_render:true,options:{output_sample_rate:48000},rewritten:true})+'\\n'); if(mode==='unverified-operation') { fs.writeFileSync(path.join(root,'navigation-complete.json'),JSON.stringify({complete:true})); return; } if(mode!=='missing-navigation'&&!fs.existsSync(path.join(root,'navigation.jsonl'))) { fs.writeFileSync(path.join(root,'navigation.jsonl'),trace().map(JSON.stringify).join('\\n')+'\\n'); fs.writeFileSync(path.join(root,'callbacks.csv'),callbackHeader+'1,0,0,480,0,400,0,0,0,0\\n2,100000,100000,480,400,600,0,0,0,0\\n'); } if(!fs.existsSync(path.join(root,'operation-trace.json'))) fs.writeFileSync(path.join(root,'operation-trace.json'),JSON.stringify({operation_complete:true,recorder_complete:true})); if(!fs.existsSync(path.join(root,'STOP')) || completed || mode==='no-completion') return; completed=true; fs.writeFileSync(path.join(root,'navigation-complete.json'),JSON.stringify({complete:true})); const finish=setInterval(()=>{if(!fs.existsSync(path.join(root,'QUIT'))) return; if(mode==='late-root-json') fs.writeFileSync(path.join(root,'endpoint-receipt.json'),'{}'); clearInterval(finish); clearInterval(timer); process.exit(0);},5); },5);
`);
  return { capture, guard, child, grandchild, mode };
}

function observer(mode = 'valid', capture) {
  let attempts = 0;
  const session = context => ({ process_id: mode === 'bad-pid' ? context.childPid + 1 : context.childPid, ...context.stream, session_id: mode === 'changed-session' ? 'changed' : 'session' });
  return { observe: async context => {
    attempts++;
    if (mode === 'delayed' && attempts < 3) {
      const error = new Error('session not observed yet');
      error.code = 'FUNKOT_OBSERVER_NO_SESSION';
      throw error;
    }
    const result = session({ childPid: context.processId, stream: context.stream });
    if (capture && fs.existsSync(path.join(capture, 'navigation-complete.json'))) write(path.join(capture, 'observer-done'), 'done');
    return result;
  } };
}

function control(mode = 'valid', capture) {
  return {
    waitForOperation: async ({ deadlineMs, signal }) => {
      if (mode === 'operation-failure') throw new Error('operation recorder failed');
      const deadline = Date.now() + deadlineMs;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error('aborted');
        const trace = path.join(capture, 'operation-trace.json');
        if (fs.existsSync(trace)) return JSON.parse(fs.readFileSync(trace, 'utf8'));
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error('operation was not verified');
    },
    requestGracefulQuit: async () => {
      if (mode === 'quit-failure') throw new Error('quit failed');
      if (!fs.existsSync(path.join(capture, 'observer-done'))) throw new Error('after observation was not complete');
      write(path.join(capture, 'QUIT'), 'quit');
    }
  };
}

function supervise(input, trustedObserver = observer('valid', input.capture), trustedControl = control('valid', input.capture)) {
  return superviseFreshCapture({
    build: () => ({ command: process.execPath, args: [input.child] }),
    captureDirectory: input.capture,
    childEnv: { TEST_MODE: input.mode, GUARD: input.guard, GRANDCHILD: input.grandchild },
    guardFiles: [input.guard],
    trustedObserver,
    control: trustedControl,
    deadlineMs: 1500
  });
}

test('supervisor binds a fresh silent child to header stream and endpoint receipt', async t => {
  const input = fixture(t);
  const result = await supervise(input);
  assert.equal(result.childPid, result.header.process_id);
  assert.equal(result.header.silent_render, true);
  assert.equal(result.stream.endpoint_id, 'endpoint');
  assert.equal(result.operation.navigation.id, '7');
  assert.equal(result.operation.recorder_complete, true);
  const start = JSON.parse(fs.readFileSync(path.join(input.capture, 'START.json'), 'utf8'));
  assert.equal(start.user_sound_signal, false);
  assert.equal(start.silent_render_signal, true);
  assert.equal(start.process_id, result.childPid);
  assert.equal(start.session.process_id, result.childPid);
  const witness = readCaptureWitness(result.captureWitness);
  assert.equal(witness.executable.realpath, result.executableRealpath);
  assert.equal(witness.header.sha256, result.headerSha256);
  assert.equal(witness.outputs.navigation_jsonl.sha256.length, 64);
  assert.ok(Object.isFrozen(witness));
  assert.throws(() => readCaptureWitness({}), /was not issued/);
});

for (const mode of ['header-audible', 'header-missing', 'header-nonboolean']) {
  test(`supervisor rejects ${mode} without sound authorization before START`, async t => {
    const input = fixture(t, mode);
    await assert.rejects(supervise(input), /does not declare the expected render mode/);
    assert.equal(fs.existsSync(path.join(input.capture, 'START.json')), false);
  });
}

test('capture isolates WebView data from inherited and caller overrides', async t => {
  const input = fixture(t);
  const previousFolder = process.env.WEBVIEW2_USER_DATA_FOLDER;
  const previousArgs = process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
  const previousAutomation = process.env.FUNKOT_NAVIGATION_AUTOMATION_INPUT_DIR;
  process.env.WEBVIEW2_USER_DATA_FOLDER = 'unrelated-profile';
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--user-data-dir=unrelated-profile';
  process.env.FUNKOT_NAVIGATION_AUTOMATION_INPUT_DIR = 'unrelated-input';
  t.after(() => {
    if (previousFolder === undefined) delete process.env.WEBVIEW2_USER_DATA_FOLDER; else process.env.WEBVIEW2_USER_DATA_FOLDER = previousFolder;
    if (previousArgs === undefined) delete process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS; else process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = previousArgs;
    if (previousAutomation === undefined) delete process.env.FUNKOT_NAVIGATION_AUTOMATION_INPUT_DIR; else process.env.FUNKOT_NAVIGATION_AUTOMATION_INPUT_DIR = previousAutomation;
  });
  await supervise(input);
  const environment = JSON.parse(fs.readFileSync(path.join(input.capture, 'child-env.json'), 'utf8'));
  assert.equal(environment.webviewFolder, path.join(input.capture, 'webview-profile'));
  assert.equal(environment.webviewArgs, undefined);
  assert.equal(environment.automationInput, undefined);
});

test('capture rejects caller-provided WebView overrides', async t => {
  const input = fixture(t);
  await assert.rejects(superviseFreshCapture({
    build: () => ({ command: process.execPath, args: [input.child] }),
    captureDirectory: input.capture,
    childEnv: { WebView2_User_Data_Folder: 'unrelated-profile' },
    guardFiles: [input.guard], trustedObserver: observer('valid', input.capture),
    control: control('valid', input.capture), deadlineMs: 1500
  }), /childEnv must not override/);
});

test('failed Windows capture stops its spawned process tree', { skip: process.platform !== 'win32' }, async t => {
  const input = fixture(t, 'tree-stall');
  let descendant;
  t.after(() => { if (descendant) { try { process.kill(descendant); } catch {} } });
  const base = observer('valid', input.capture);
  const observing = { observe: async context => {
    descendant = Number(fs.readFileSync(path.join(input.capture, 'descendant-pid'), 'utf8'));
    process.kill(descendant, 0);
    return base.observe(context);
  } };
  await assert.rejects(supervise(input, observing), /timed out|deadline|did not close/);
  assert.ok(Number.isSafeInteger(descendant) && descendant > 0);
  assert.throws(() => process.kill(descendant, 0), error => error.code === 'ESRCH');
  descendant = null;
});

test('supervisor rejects a forged player build witness before launch', async t => {
  const input = fixture(t);
  await assert.rejects(superviseFreshCapture({
    build: () => ({ command: process.execPath, args: [input.child], buildWitness: {} }),
    captureDirectory: input.capture, childEnv: { TEST_MODE: input.mode, GUARD: input.guard },
    guardFiles: [input.guard], trustedObserver: observer('valid', input.capture),
    control: control('valid', input.capture), deadlineMs: 1500
  }), /build witness was not issued/);
  assert.deepEqual(fs.readdirSync(input.capture), []);
});

test('supervisor rejects a trusted observer that names another process', async t => {
  await assert.rejects(supervise(fixture(t), observer('bad-pid')), CaptureVerificationError);
});

test('supervisor retries an unavailable trusted observer before authorizing', async t => {
  const input = fixture(t);
  const result = await supervise(input, observer('delayed', input.capture));
  assert.equal(result.endpointReceipt.session.before.session_id, 'session');
});

test('supervisor rejects a non-retryable observer failure', async t => {
  await assert.rejects(supervise(fixture(t), { observe: async () => { throw new Error('observer unavailable'); } }), /trusted observer failed/);
});

test('supervisor bounds a hung observer by the capture deadline', async t => {
  const input = fixture(t);
  await assert.rejects(superviseFreshCapture({
    build: () => ({ command: process.execPath, args: [input.child] }), captureDirectory: input.capture,
    childEnv: { TEST_MODE: input.mode, GUARD: input.guard }, guardFiles: [input.guard],
    trustedObserver: { observe: async () => new Promise(() => {}) }, control: control('valid', input.capture), deadlineMs: 200
  }), /trusted observer exceeded the capture deadline|trusted observer did not observe the capture before deadline|did not close before deadline/);
  assert.equal(fs.existsSync(path.join(input.capture, 'START.json')), false);
});

test('supervisor rejects a changed guarded input', async t => {
  await assert.rejects(supervise(fixture(t, 'mutate')), error => error.classification === 'condition_mismatch' && error.code === 'capture_input_changed' && /guarded capture input changed during capture/.test(error.message));
});

test('supervisor rejects a header replaced after observation', async t => {
  await assert.rejects(supervise(fixture(t, 'rewrite-header')), /evidence changed during capture/);
});

test('supervisor rejects endpoint evidence written immediately before exit', async t => {
  await assert.rejects(supervise(fixture(t, 'late-root-json')), /child-controlled endpoint-receipt/);
});

test('supervisor rejects endpoint JSON written by the child', async t => {
  await assert.rejects(supervise(fixture(t, 'fake-root-json')), /not endpoint authority/);
});

test('supervisor rejects an early child exit', async t => {
  await assert.rejects(supervise(fixture(t, 'early')), /exited before required evidence/);
});

test('supervisor rejects a child that never completes after STOP', async t => {
  const input = fixture(t, 'no-completion');
  await assert.rejects(superviseFreshCapture({
    build: () => ({ command: process.execPath, args: [input.child] }), captureDirectory: input.capture,
    childEnv: { TEST_MODE: input.mode, GUARD: input.guard }, guardFiles: [input.guard], trustedObserver: observer(), control: control('valid', input.capture), deadlineMs: 400
  }), /capture supervision timed out|did not close before deadline/);
});

test('supervisor rejects an aborted capture', async t => {
  const input = fixture(t, 'stall'), controller = new AbortController();
  controller.abort();
  await assert.rejects(superviseFreshCapture({
    build: () => ({ command: process.execPath, args: [input.child] }), captureDirectory: input.capture,
    childEnv: { TEST_MODE: input.mode, GUARD: input.guard }, guardFiles: [input.guard], trustedObserver: observer(), control: control('valid', input.capture), deadlineMs: 1500,
    signal: controller.signal
  }), /aborted/);
});

test('supervisor passes cancellation to an in-flight observer', async t => {
  const input = fixture(t, 'stall'), controller = new AbortController();
  let seenSignal;
  await assert.rejects(superviseFreshCapture({
    build: () => ({ command: process.execPath, args: [input.child] }), captureDirectory: input.capture,
    childEnv: { TEST_MODE: input.mode, GUARD: input.guard }, guardFiles: [input.guard], deadlineMs: 1500,
    trustedObserver: { observe: async ({ signal }) => { seenSignal = signal; controller.abort(); return new Promise(() => {}); } }, control: control('valid', input.capture),
    signal: controller.signal
  }), /aborted/);
  assert.equal(seenSignal, controller.signal);
});

test('supervisor rejects a nonempty capture root before launching a child', async t => {
  const input = fixture(t);
  write(path.join(input.capture, 'stale'), 'stale');
  await assert.rejects(supervise(input), /must be empty/);
});

test('supervisor rejects a case-variant reserved capture environment override', async t => {
  const input = fixture(t);
  await assert.rejects(superviseFreshCapture({
    build: () => ({ command: process.execPath, args: [input.child] }), captureDirectory: input.capture,
    childEnv: { funkot_navigation_silent_render: '0' }, guardFiles: [input.guard], trustedObserver: observer(), control: control('valid', input.capture), deadlineMs: 100
  }), /must not override/);
});

test('supervisor rejects a completion that lacks trusted operation verification', async t => {
  const input = fixture(t, 'unverified-operation');
  await assert.rejects(supervise(input), /capture completed before navigation readiness|did not close before deadline/);
  assert.equal(fs.existsSync(path.join(input.capture, 'STOP')), false);
});

test('supervisor does not write STOP when a fake control receipt lacks navigation evidence', async t => {
  const input = fixture(t, 'missing-navigation');
  await assert.rejects(superviseFreshCapture({
    build: () => ({ command: process.execPath, args: [input.child] }), captureDirectory: input.capture,
    childEnv: { TEST_MODE: input.mode, GUARD: input.guard }, guardFiles: [input.guard], trustedObserver: observer(),
    control: { waitForOperation: async () => ({ operation_complete: true, recorder_complete: true }), requestGracefulQuit: async () => {} }, deadlineMs: 1500
  }), /navigation readiness timed out|did not close before deadline/);
  assert.equal(fs.existsSync(path.join(input.capture, 'START.json')), true);
  assert.equal(fs.existsSync(path.join(input.capture, 'STOP')), false);
});

test('supervisor rejects a control operation receipt without recorder completion', async t => {
  const input = fixture(t);
  await assert.rejects(supervise(input, observer('valid', input.capture), {
    waitForOperation: async () => ({ operation_complete: true, recorder_complete: false }),
    requestGracefulQuit: async () => {}
  }), /did not verify completed operation and recorder/);
});
