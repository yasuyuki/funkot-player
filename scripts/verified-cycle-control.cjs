const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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

function preparedStartupMismatch(navigation) {
  return navigation.some(event => event.kind === 'cycle_preview_upgrade')
    ? { classification: 'condition_mismatch', soundQuality: 'incomplete', code: 'cycle_preview_upgrade_unmodeled',
      detail: 'prepared cycle reference does not model an observed preview upgrade' }
    : null;
}

module.exports = { inspectVerifiedCycle, waitForVerifiedCycle, validateCycleCallbacks, preparedStartupMismatch };
