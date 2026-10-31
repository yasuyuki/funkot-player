const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { inspectVerifiedCycle, validateCycleCallbacks, waitForVerifiedCycle, validateFirstLiveReplay } = require('./verified-cycle-control.cjs');

const callbackHeader = 'sequence,callback_qpc_100ns,playback_qpc_100ns,output_frames,engine_start,engine_end,paused,audition,render_lock_miss,trace_dropped\n';
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function firstLive() {
  const evidence = { playlist_index: 0, build_revision: Array(20).fill(17), decoded_input_sha256: Array(32).fill(1),
    preview_prepared_sha256: Array(32).fill(2), full_prepared_sha256: Array(32).fill(3) };
  return {
    core: '11'.repeat(20),
    navigation: [
      { kind: 'cycle_source_started', index: 0, engine_frame: 0 },
      { kind: 'cycle_first_live_preparation', mode: 'preview_full', ready_engine_frame: 0, callback_sequence: 2,
        queued_upgrade_at_render_frame: null, recipe: { recorded: true }, evidence },
      { kind: 'cycle_preview_upgrade', count: 1, playlist_index: 0, render_frame: 13, callback_sequence: 2,
        preview_frames: 20, playhead: 13, evidence: structuredClone(evidence) },
    ],
    callbacks: [
      { sequence: 1, paused: 0, engine_start: 0, engine_end: 10 },
      { sequence: 2, paused: 0, engine_start: 10, engine_end: 20 },
    ],
  };
}

test('recorded first-live adoption uses the engine frame inside its actual callback', () => {
  const input = firstLive();
  assert.deepEqual(validateFirstLiveReplay(input.navigation, input.callbacks, input.core).schedule,
    { ready_at_render_frame: 0, upgrade_at_render_frame: 13, upgrade_adoption: 'Active' });
  const delayed = firstLive();
  delayed.navigation[0].engine_frame = 10;
  delayed.navigation[1].ready_engine_frame = 13;
  delayed.navigation[2].render_frame = 17;
  delayed.navigation[2].playhead = 4;
  assert.deepEqual(validateFirstLiveReplay(delayed.navigation, delayed.callbacks, delayed.core).schedule,
    { ready_at_render_frame: 13, upgrade_at_render_frame: 17, upgrade_adoption: 'Active' });
  input.navigation[1].mode = 'single';
  input.navigation[1].callback_sequence = 1;
  input.navigation.pop();
  assert.equal(validateFirstLiveReplay(input.navigation, input.callbacks, input.core).schedule.upgrade_at_render_frame, null);
});

test('a queued full buffer is distinguished from an active preview fade at the same frame', () => {
  const input = firstLive();
  input.navigation[1].queued_upgrade_at_render_frame = 0;
  input.navigation[1].callback_sequence = 1;
  input.navigation.pop();
  assert.deepEqual(validateFirstLiveReplay(input.navigation, input.callbacks, input.core).schedule,
    { ready_at_render_frame: 0, upgrade_at_render_frame: 0, upgrade_adoption: 'Queued' });
  for (const frame of [1, -1, 0.5]) {
    input.navigation[1].queued_upgrade_at_render_frame = frame;
    assert.throws(() => validateFirstLiveReplay(input.navigation, input.callbacks, input.core), { classification: 'condition_mismatch' });
  }
});

test('legacy, missing and duplicate first-live observations cannot become comparable', () => {
  const input = firstLive();
  assert.throws(() => validateFirstLiveReplay([input.navigation[0]], input.callbacks, input.core), { classification: 'incomplete' });
  for (const navigation of [input.navigation.slice(0, 2), [...input.navigation, input.navigation[1]], [...input.navigation, input.navigation[2]]]) {
    assert.throws(() => validateFirstLiveReplay(navigation, input.callbacks, input.core), { classification: 'condition_mismatch' });
  }
});

test('foreign sources, producers and content cannot replace observed first-live evidence', () => {
  const changes = [
    value => { value.navigation[1].evidence.playlist_index = 1; },
    value => { value.navigation[1].evidence.build_revision = Array(20).fill(0); },
    value => { value.navigation[1].evidence.build_revision[0] = 18; value.navigation[2].evidence.build_revision[0] = 18; },
    value => { value.navigation[1].recipe = null; },
    value => { value.navigation[2].evidence.decoded_input_sha256[0] = 2; },
    value => { value.navigation[2].evidence.preview_prepared_sha256[0] = 4; },
    value => { value.navigation[2].evidence.full_prepared_sha256[0] = 4; },
    value => { value.navigation[2].playlist_index = 2; },
    value => { value.navigation[2].playhead = 21; },
  ];
  for (const change of changes) {
    const input = firstLive(); change(input);
    assert.throws(() => validateFirstLiveReplay(input.navigation, input.callbacks, input.core), { classification: 'condition_mismatch' });
  }
});

test('adoption at another callback or an ambiguous engine boundary is rejected', () => {
  for (const frame of [9, 21, -1, 13.5]) {
    const input = firstLive(); input.navigation[2].render_frame = frame;
    assert.throws(() => validateFirstLiveReplay(input.navigation, input.callbacks, input.core), { classification: 'condition_mismatch' });
  }
  const input = firstLive();
  input.callbacks.push({ sequence: 3, paused: 0, engine_start: 12, engine_end: 14 });
  assert.throws(() => validateFirstLiveReplay(input.navigation, input.callbacks, input.core), { classification: 'condition_mismatch' });
});

test('an upgrade adopted by poll_events at callback end keeps its explicitly observed callback', () => {
  const input = firstLive();
  input.navigation[2].render_frame = 20;
  assert.equal(validateFirstLiveReplay(input.navigation, input.callbacks, input.core).schedule.upgrade_at_render_frame, 20);
  input.navigation[2].callback_sequence = undefined;
  assert.throws(() => validateFirstLiveReplay(input.navigation, input.callbacks, input.core), { classification: 'condition_mismatch' });
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
