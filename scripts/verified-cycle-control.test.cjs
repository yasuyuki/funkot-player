const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { inspectVerifiedCycle, validateCycleCallbacks, waitForVerifiedCycle, preparedStartupMismatch } = require('./verified-cycle-control.cjs');

const callbackHeader = 'sequence,callback_qpc_100ns,playback_qpc_100ns,output_frames,engine_start,engine_end,paused,audition,render_lock_miss,trace_dropped\n';
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('an observed preview upgrade cannot pass a full-prepared startup reference', () => {
  assert.equal(preparedStartupMismatch([{ kind: 'cycle_source_started', index: 0 }, { kind: 'capture_end' }]), null);
  const observed = { kind: 'cycle_preview_upgrade', count: 1, playlist_index: 0, playhead: 1440, preview_frames: 960000, main_callback_frame: 1920 };
  for (const event of [observed, { kind: 'cycle_preview_upgrade' }]) {
    const result = preparedStartupMismatch([{ kind: 'cycle_source_started', index: 0 }, event, { kind: 'capture_end' }]);
    assert.equal(result.classification, 'condition_mismatch');
    assert.equal(result.soundQuality, 'incomplete');
    assert.equal(result.code, 'cycle_preview_upgrade_unmodeled');
  }
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-cycle-control-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = path.join(root, 'cycle-plan.json');
  const receipt = path.join(root, 'cycle-complete.json');
  const input = [{ sha256: 'a'.repeat(64) }, { sha256: 'b'.repeat(64) }];
  fs.writeFileSync(plan, JSON.stringify({ schema: 1, cycle: 4, inputs: input, occurrences: [0, 1, 0] }) + '\n');
  fs.writeFileSync(receipt, JSON.stringify({ schema: 1, plan_sha256: sha256(plan), cycle: 4, process_id: 42,
    playlist_run_id: 0, playlist_id: 'aba', natural_end: true, cancelled: false, output_closed: true,
    occurrences: [0, 1, 0].map((source, ordinal) => ({ ordinal, entry_id: `entry-${ordinal}`, status: 'played', sha256: input[source].sha256 })),
    observed_entries: ['entry-0', 'entry-1', 'entry-2'] }) + '\n');
  fs.writeFileSync(path.join(root, 'callbacks.csv'), callbackHeader +
    '1,100,100,480,0,480,0,0,0,0\n2,200,200,480,480,960,0,0,0,0\n');
  return { root, plan, receipt, child: { pid: 42, exitCode: null, signalCode: null } };
}

test('a receipt only completes for the bound ABA plan and a closed continuous callback stream', t => {
  const input = fixture(t);
  const result = inspectVerifiedCycle({ captureDirectory: input.root, cyclePlanPath: input.plan, child: input.child });
  assert.equal(result.receipt.cycle, 4);
  assert.equal(result.receipt.occurrences.map(row => row.sha256).join(','), `${'a'.repeat(64)},${'b'.repeat(64)},${'a'.repeat(64)}`);
  assert.equal(result.sha256, sha256(input.receipt));
});

test('natural end may be observed while the callback writer is live; callback validation waits for STOP finalization', t => {
  const input = fixture(t);
  fs.appendFileSync(path.join(input.root, 'callbacks.csv'), '3,');
  assert.equal(inspectVerifiedCycle({ captureDirectory: input.root, cyclePlanPath: input.plan, child: input.child }).receipt.natural_end, true);
  assert.throws(() => require('./audio-anomaly-analysis.cjs').callbackCsv(path.join(input.root, 'callbacks.csv')), /not numeric CSV/);
});

test('silent cycles require the exact real-engine endpoint and reject a mid-source gate or pause', t => {
  const input = fixture(t);
  const rows = require('./audio-anomaly-analysis.cjs').callbackCsv(path.join(input.root, 'callbacks.csv'));
  assert.equal(validateCycleCallbacks(rows, { engineEnd: 960 }), rows);
  assert.throws(() => validateCycleCallbacks(rows, { engineEnd: 961 }), /endpoint is incomplete/);
  assert.throws(() => validateCycleCallbacks(rows, { engineEnd: 959 }), /coverage or natural end changed/);
  assert.throws(() => validateCycleCallbacks([{ ...rows[0] }, { ...rows[1], engine_start: null, engine_end: null, paused: 1 }], { engineEnd: 960 }), /coverage or natural end changed/);
  assert.throws(() => validateCycleCallbacks([{ ...rows[0], paused: 1 }, rows[1]], { engineEnd: 960 }), /coverage or natural end changed/);
});

test('callback order, engine closure, and live-child boundaries reject a cycle', t => {
  const input = fixture(t);
  const rows = [
    { sequence: 1, callback_qpc_100ns: 100, playback_qpc_100ns: 100, output_frames: 480, engine_start: 0, engine_end: 480, paused: 0, audition: 0, render_lock_miss: 0, trace_dropped: 0 },
    { sequence: 2, callback_qpc_100ns: 200, playback_qpc_100ns: 200, output_frames: 480, engine_start: 500, engine_end: 980, paused: 0, audition: 0, render_lock_miss: 0, trace_dropped: 0 }
  ];
  assert.throws(() => validateCycleCallbacks(rows), /callback capture fault/);
  assert.throws(() => validateCycleCallbacks([{ ...rows[0] }, { ...rows[1], engine_start: 480, engine_end: 960, callback_qpc_100ns: 100 }]), /callback capture fault/);
  assert.throws(() => inspectVerifiedCycle({ captureDirectory: input.root, cyclePlanPath: input.plan, child: { ...input.child, exitCode: 0 } }), /exited before capture completion/);
});

test('waiting cannot convert cancellation or an absent receipt into a natural end', async t => {
  const input = fixture(t);
  fs.unlinkSync(input.receipt);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(waitForVerifiedCycle({ captureDirectory: input.root, cyclePlanPath: input.plan, child: input.child,
    deadline: Date.now() + 1000, signal: controller.signal }), /cancelled/);
  await assert.rejects(waitForVerifiedCycle({ captureDirectory: input.root, cyclePlanPath: input.plan, child: input.child,
    deadline: Date.now() - 1 }), /timed out/);
});
