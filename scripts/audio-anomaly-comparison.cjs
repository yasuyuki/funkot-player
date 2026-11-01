const fs = require('node:fs');
const { analyzeEvidence } = require('./audio-anomaly-analysis.cjs');
const { freshReplay } = require('./verified-replay.cjs');

function compareEvidence(input) {
  try {
    const replay = JSON.parse(fs.readFileSync(input.replayPath, 'utf8'));
    if (replay.schema !== 2) {
      const result = analyzeEvidence(input);
      return { ...result, classification: result.classification === 'capture_fault' ? 'capture_fault' : 'incomplete', comparable: false, soundQuality: 'incomplete', findings: [...result.findings, { kind: 'incomplete', code: 'replay_producer_unverified' }] };
    }
    const observed = freshReplay(input.captureManifestPath, input.replayPath, input.captureWitness, input.deadline);
    const result = analyzeEvidence({ ...input, observed });
    return { ...result, replayGeneration: { directory: observed.work, coreRevision: observed.raw.runtime.core_revision, rawSha256: observed.rawHash, wavSha256: observed.wavHash, executableSha256: observed.raw.executable_sha256, coreSourceSha256: observed.raw.core_source_sha256, driverSourceSha256: observed.raw.driver_source_sha256 } };
  } catch (error) {
    const kind = /does not match/.test(error.message) ? 'condition_mismatch' : 'incomplete';
    return { schema: 1, classification: kind, comparable: false, soundQuality: 'incomplete', findings: [{ kind, code: 'replay_producer_unverified', detail: error.message }] };
  }
}

module.exports = { compareEvidence };
