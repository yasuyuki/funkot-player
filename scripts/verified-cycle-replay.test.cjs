const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareCycleReference, compareCycle } = require('./verified-cycle-replay.cjs');

test('foreign build, reference, and capture values never obtain fresh-cycle provenance', () => {
  assert.throws(() => prepareCycleReference({
    build: { buildWitness: Object.freeze({}) }, inputManifest: 'unread', workDirectory: os.tmpdir(), header: {}, captureWitness: Object.freeze({}), deadline: Date.now() + 1000
  }), /was not issued by this process/);

  const result = compareCycle({
    captured: Object.freeze({ captureWitness: Object.freeze({}) }), reference: Object.freeze({}), calibrationFile: 'unread',
    workDirectory: path.join(os.tmpdir(), 'unreachable-cycle-analysis'), deadline: Date.now() + 1000
  });
  assert.equal(result.classification, 'incomplete');
  assert.equal(result.soundQuality, 'incomplete');
  assert.equal(result.code, 'cycle_provenance_unverified');
  assert.equal(result.guaranteeClass, undefined);
  assert.equal(result.comparable, undefined);
});
