const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  NavigationVerificationError,
  inspectVerifiedNavigation,
  waitForVerifiedNavigation
} = require('./verified-navigation-control.cjs');

const callbackHeader = 'sequence,callback_qpc_100ns,playback_qpc_100ns,output_frames,engine_start,engine_end,paused,audition,render_lock_miss,trace_dropped\n';
const liveChild = () => ({ exitCode: null, signalCode: null });

function write(file, value) {
  fs.writeFileSync(file, value);
}

function fixture(t, { trace, callbacks, header = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-navigation-control-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (header) write(path.join(root, 'navigation-header.json'), JSON.stringify({ options: { output_sample_rate: 48000 } }) + '\n');
  if (trace !== undefined) write(path.join(root, 'navigation.jsonl'), trace);
  if (callbacks !== undefined) write(path.join(root, 'callbacks.csv'), callbacks);
  return root;
}

function rows({ duplicate = false, mismatch = false, footer = false } = {}) {
  const trace = [
    { kind: 'requested', request_id: 7, label: 'next-7', action: 'transition_to_next' },
    { kind: 'accepted', generation: 7, action: 'transition_to_next', source_generation: 9, target_source_generation: 10, current_index: 0, target_index: 1, active_preview: false, active_head_only: false, target_preview: false, target_head_only: false, render_frame: 440, active_playhead: 220 },
    { kind: 'plan_applied', generation: 7, target_source_generation: 10, target_index: 1, render_frame: 442, plan: { generation: mismatch ? 8 : 7, start: 430, entry: 12, simple: false, reason: 'manual' } },
    { kind: 'transition_started', generation: 7, source_generation: 10, target_source_generation: 10, current_index: 1, target_index: 1, render_frame: 500 },
    { kind: 'fade_completed', generation: 7, source_generation: 10, target_source_generation: 10, current_index: 1, target_index: 1, render_frame: 600 }
  ];
  if (duplicate) trace.push({ ...trace[4] });
  if (footer) trace.push({ kind: 'capture_end' });
  return `${trace.map(JSON.stringify).join('\n')}\n`;
}

function callbacks({ end = 600, missing = false, dropped = false, lockMiss = false } = {}) {
  const values = [
    '1,0,0,480,0,400,0,0,0,0',
    `2,100000,100000,480,400,${end},0,0,${lockMiss ? 1 : 0},${dropped ? 1 : 0}`
  ];
  return callbackHeader + (missing ? values.slice(0, 1) : values).join('\n') + '\n';
}

test('returns the completed operation after callback coverage reaches fade end', t => {
  const root = fixture(t, { trace: rows(), callbacks: callbacks() });
  const result = inspectVerifiedNavigation({ captureDirectory: root, child: liveChild() });
  assert.equal(result.state, 'ready');
  assert.equal(result.operation.id, '7');
  assert.equal(result.operation.fade_end_engine_frame, 600);
});

test('accepts a complete flushed header without requiring a trailing newline', t => {
  const root = fixture(t, { trace: rows(), callbacks: callbacks() });
  write(path.join(root, 'navigation-header.json'), JSON.stringify({ options: { output_sample_rate: 48000 } }));
  assert.equal(inspectVerifiedNavigation({ captureDirectory: root, child: liveChild() }).state, 'ready');
  write(path.join(root, 'navigation-header.json'), '{"options":');
  assert.equal(inspectVerifiedNavigation({ captureDirectory: root, child: liveChild() }).state, 'pending');
});

test('requires live child state before it can report readiness', t => {
  const root = fixture(t, { trace: rows(), callbacks: callbacks() });
  assert.throws(() => inspectVerifiedNavigation({ captureDirectory: root }), /child state is required/);
});

test('holds partial rows and insufficient callback coverage pending', t => {
  const root = fixture(t, { trace: rows().slice(0, -1), callbacks: callbacks({ end: 500 }) });
  assert.deepEqual(inspectVerifiedNavigation({ captureDirectory: root, child: liveChild() }), { state: 'pending' });
  write(path.join(root, 'navigation.jsonl'), rows());
  assert.deepEqual(inspectVerifiedNavigation({ captureDirectory: root, child: liveChild() }), { state: 'pending' });
});

test('uses only complete callback rows when the writer has a buffered partial tail', t => {
  const complete = fixture(t, { trace: rows(), callbacks: callbacks() + '3,200' });
  assert.equal(inspectVerifiedNavigation({ captureDirectory: complete, child: liveChild() }).state, 'ready');
  const incomplete = fixture(t, { trace: rows(), callbacks: callbacks({ end: 500 }) + '3,200' });
  assert.equal(inspectVerifiedNavigation({ captureDirectory: incomplete, child: liveChild() }).state, 'pending');
});

test('rejects duplicate, malformed, and mismatched navigation records', t => {
  const duplicate = fixture(t, { trace: rows({ duplicate: true }), callbacks: callbacks() });
  assert.throws(() => inspectVerifiedNavigation({ captureDirectory: duplicate, child: liveChild() }), /navigation_trace_duplicate/);
  const malformed = fixture(t, { trace: '{not json}\n', callbacks: callbacks() });
  assert.throws(() => inspectVerifiedNavigation({ captureDirectory: malformed, child: liveChild() }), /invalid JSON/);
  const mismatch = fixture(t, { trace: rows({ mismatch: true }), callbacks: callbacks() });
  assert.throws(() => inspectVerifiedNavigation({ captureDirectory: mismatch, child: liveChild() }), /plan_generation_unmatched/);
});

test('rejects missing callback continuity and capture drops', t => {
  const missing = fixture(t, { trace: rows(), callbacks: callbackHeader });
  assert.deepEqual(inspectVerifiedNavigation({ captureDirectory: missing, child: liveChild() }), { state: 'pending' });
  const discontinuous = fixture(t, { trace: rows(), callbacks: callbacks().replace('2,100000', '3,100000') });
  assert.throws(() => inspectVerifiedNavigation({ captureDirectory: discontinuous, child: liveChild() }), /discontinuous/);
  const dropped = fixture(t, { trace: rows(), callbacks: callbacks({ dropped: true }) });
  assert.throws(() => inspectVerifiedNavigation({ captureDirectory: dropped, child: liveChild() }), /dropped/);
});

test('rejects a render lock miss and terminal capture evidence', t => {
  const lock = fixture(t, { trace: rows(), callbacks: callbacks({ lockMiss: true }) });
  assert.throws(() => inspectVerifiedNavigation({ captureDirectory: lock, child: liveChild() }), /lock miss/);
  const footer = fixture(t, { trace: rows({ footer: true }), callbacks: callbacks() });
  assert.throws(() => inspectVerifiedNavigation({ captureDirectory: footer, child: liveChild() }), /ended/);
  const stopped = fixture(t, { trace: rows(), callbacks: callbacks() });
  write(path.join(stopped, 'STOP'), 'stop');
  assert.throws(() => inspectVerifiedNavigation({ captureDirectory: stopped, child: liveChild() }), /STOP/);
  const exited = fixture(t, { trace: rows(), callbacks: callbacks() });
  assert.throws(() => inspectVerifiedNavigation({ captureDirectory: exited, child: { exitCode: 0, signalCode: null } }), /child exited/);
});

test('waits only until its caller-supplied deadline', async t => {
  const root = fixture(t, { trace: rows(), callbacks: callbacks({ end: 500 }) });
  await assert.rejects(
    waitForVerifiedNavigation({ captureDirectory: root, child: liveChild(), deadline: Date.now() + 15, pollIntervalMs: 1 }),
    error => error instanceof NavigationVerificationError && /timed out/.test(error.message)
  );
});

test('honors abort while evidence is incomplete', async t => {
  const root = fixture(t, { trace: rows(), callbacks: callbacks({ end: 500 }) });
  const controller = new AbortController();
  const waiting = waitForVerifiedNavigation({ captureDirectory: root, child: liveChild(), deadline: Date.now() + 1000, pollIntervalMs: 20, signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, /aborted/);
});
