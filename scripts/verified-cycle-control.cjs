const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function inspectVerifiedCycle({ captureDirectory, cyclePlanPath, child }) {
  if (!child || child.exitCode !== null || child.signalCode !== null) throw new Error('finite cycle player exited before capture completion');
  const completion = path.join(captureDirectory, 'cycle-complete.json');
  if (!fs.existsSync(completion)) return null;
  const stat = fs.lstatSync(completion);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('finite cycle receipt must be a regular file');
  const bytes = fs.readFileSync(completion);
  if (!bytes.toString('utf8').endsWith('\n')) return null;
  const plan = read(cyclePlanPath), receipt = JSON.parse(bytes.toString('utf8'));
  if (plan.schema !== 1 || plan.occurrences?.join(',') !== '0,1,0' || plan.inputs?.length !== 2 ||
      receipt.schema !== 1 || receipt.plan_sha256 !== digest(cyclePlanPath) || receipt.cycle !== plan.cycle ||
      receipt.process_id !== child.pid || receipt.playlist_run_id !== 0 || typeof receipt.playlist_id !== 'string' || !receipt.playlist_id ||
      receipt.natural_end !== true || receipt.cancelled !== false || receipt.output_closed !== true || receipt.occurrences?.length !== 3) {
    throw new Error('finite cycle natural-end evidence is incomplete or changed');
  }
  const ids = receipt.occurrences.map(row => row.entry_id);
  if (new Set(ids).size !== 3 || ids.some(id => typeof id !== 'string' || !id) ||
      JSON.stringify(receipt.observed_entries) !== JSON.stringify(ids) ||
      receipt.occurrences.some((row, index) => row.ordinal !== index || row.status !== 'played' || row.sha256 !== plan.inputs[plan.occurrences[index]].sha256)) {
    throw new Error('finite cycle source occurrence order does not match A-B180-A');
  }
  return { receipt, file: completion, sha256: digest(completion) };
}

function validateCycleCallbacks(callbacks, { engineEnd } = {}) {
  if (!callbacks.length) throw new Error('finite cycle callback evidence is missing');
  if (engineEnd !== undefined && (!Number.isSafeInteger(engineEnd) || engineEnd <= 0)) throw new Error('finite cycle expected engine extent is invalid');
  let lastEngine = 0;
  for (const [index, row] of callbacks.entries()) {
    if (row.sequence !== index + 1 || row.output_frames <= 0 || row.audition !== 0 || row.render_lock_miss !== 0 || row.trace_dropped !== 0 ||
        ![0, 1].includes(row.paused) || (row.engine_start === null) !== (row.engine_end === null) ||
        row.engine_start !== null && (row.engine_end < row.engine_start || row.engine_end - row.engine_start > row.output_frames) ||
        index && (row.callback_qpc_100ns <= callbacks[index - 1].callback_qpc_100ns || row.playback_qpc_100ns <= callbacks[index - 1].playback_qpc_100ns ||
          row.engine_start !== null && callbacks[index - 1].engine_end !== null && row.engine_start !== callbacks[index - 1].engine_end)) {
      throw new Error('finite cycle callback capture fault');
    }
    if (engineEnd !== undefined) {
      if (row.engine_start === null ? lastEngine !== 0 && lastEngine !== engineEnd :
          row.engine_start !== lastEngine || row.engine_end > engineEnd || row.paused === 1 && row.engine_end > 0 && row.engine_end < engineEnd) {
        throw new Error('finite cycle engine coverage or natural end changed');
      }
      if (row.engine_end !== null) lastEngine = row.engine_end;
    }
  }
  if (engineEnd !== undefined && lastEngine !== engineEnd) throw new Error('finite cycle engine endpoint is incomplete');
  return callbacks;
}

async function waitForVerifiedCycle({ captureDirectory, cyclePlanPath, child, deadline, signal }) {
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('finite cycle cancelled');
    const result = inspectVerifiedCycle({ captureDirectory, cyclePlanPath, child });
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))));
  }
  throw new Error('finite cycle natural end timed out');
}

function validateFirstLiveReplay(navigation, callbacks, coreRevision) {
  const reject = (detail, classification = 'condition_mismatch') => {
    throw Object.assign(new Error(detail), { classification, code: 'cycle_first_live_unverified' });
  };
  const preparations = navigation.filter(row => row.kind === 'cycle_first_live_preparation');
  if (!preparations.length) reject('finite cycle lacks recorded first-live preparation', 'incomplete');
  if (preparations.length !== 1) reject('finite cycle has duplicate first-live preparation');
  const preparation = preparations[0];
  const revision = preparation.evidence?.build_revision;
  if (!/^[0-9a-f]{40}$/.test(coreRevision) || !Array.isArray(revision) || revision.length !== 20 ||
      revision.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255) ||
      Buffer.from(revision).toString('hex') !== coreRevision || preparation.evidence.playlist_index !== 0 ||
      !preparation.recipe || typeof preparation.recipe !== 'object' || Array.isArray(preparation.recipe) ||
      !['preview_full', 'single'].includes(preparation.mode) ||
      !Number.isSafeInteger(preparation.ready_engine_frame) || preparation.ready_engine_frame < 0) {
    reject('finite cycle preparation does not match its verified producer');
  }
  const containing = frame => callbacks.filter(row => row.paused === 0 && row.engine_start !== null &&
    row.engine_start <= frame && frame < row.engine_end);
  const ready = containing(preparation.ready_engine_frame);
  const sources = navigation.filter(row => row.kind === 'cycle_source_started' && row.index === 0);
  if (ready.length !== 1 || sources.length !== 1 || sources[0].engine_frame !== ready[0].engine_start) {
    reject('first-live ready frame lacks one source callback');
  }
  const queued = preparation.queued_upgrade_at_render_frame ?? null;
  if (queued !== null && (preparation.mode !== 'preview_full' || queued !== preparation.ready_engine_frame ||
      preparation.callback_sequence !== ready[0].sequence)) {
    reject('queued first-live upgrade does not match actual readiness');
  }
  const upgrades = navigation.filter(row => row.kind === 'cycle_preview_upgrade');
  if (upgrades.length !== (preparation.mode === 'preview_full' && queued === null ? 1 : 0)) {
    reject('first-live upgrade is missing or duplicated');
  }
  const upgrade = upgrades[0];
  if (upgrade) {
    const adopted = callbacks.filter(row => row.sequence === upgrade.callback_sequence && row.paused === 0 &&
      row.engine_start !== null && row.engine_start <= upgrade.render_frame && upgrade.render_frame <= row.engine_end);
    const overlapping = callbacks.filter(row => row.engine_start !== null &&
      row.engine_start < upgrade.render_frame && upgrade.render_frame < row.engine_end);
    if (!Number.isSafeInteger(upgrade.render_frame) || upgrade.render_frame < preparation.ready_engine_frame ||
        upgrade.count !== 1 || upgrade.playlist_index !== 0 ||
        !Number.isSafeInteger(upgrade.preview_frames) || upgrade.preview_frames <= 0 ||
        !Number.isSafeInteger(upgrade.playhead) || upgrade.playhead < 0 || upgrade.playhead > upgrade.preview_frames ||
        !isDeepStrictEqual(upgrade.evidence, preparation.evidence) ||
        adopted.length !== 1 || overlapping.length > 1 ||
        preparation.callback_sequence !== upgrade.callback_sequence) {
      reject('first-live adoption does not match one actual callback and preparation');
    }
  } else if (preparation.callback_sequence !== ready[0].sequence) {
    reject('first-live preparation does not match its actual callback');
  }
  return { preparation, upgrade: upgrade ?? null, schedule: {
    ready_at_render_frame: preparation.ready_engine_frame,
    upgrade_at_render_frame: queued ?? upgrade?.render_frame ?? null,
    upgrade_adoption: queued !== null ? 'Queued' : upgrade ? 'Active' : null,
  } };
}

module.exports = { inspectVerifiedCycle, waitForVerifiedCycle, validateCycleCallbacks, validateFirstLiveReplay };
