const fs = require('node:fs');
const path = require('node:path');
const {
  callbackCsvContent,
  jsonLines,
  navigationOperations,
  requestedLabels
} = require('./audio-anomaly-analysis.cjs');

class NavigationVerificationError extends Error {}

function fail(message) {
  throw new NavigationVerificationError(message);
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${name} must be a positive safe integer`);
  return value;
}

function captureFile(root, name) {
  const file = path.join(root, name);
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function completedFile(root, name) {
  const file = captureFile(root, name);
  if (!file) return null;
  const content = fs.readFileSync(file, 'utf8');
  return content.endsWith('\n') ? file : null;
}

function terminalState(root, child) {
  if (!child || !Object.hasOwn(child, 'exitCode') || !Object.hasOwn(child, 'signalCode')) fail('capture child state is required');
  if (fs.existsSync(path.join(root, 'STOP'))) return 'capture STOP exists before navigation readiness';
  if (fs.existsSync(path.join(root, 'navigation-complete.json'))) return 'capture completed before navigation readiness';
  if (child && (child.exitCode !== null || child.signalCode !== null)) return 'capture child exited before navigation readiness';
  return null;
}

function headerRate(root) {
  const file = captureFile(root, 'navigation-header.json');
  if (!file) return null;
  const content = fs.readFileSync(file, 'utf8');
  let header;
  try {
    header = JSON.parse(content);
  } catch (error) {
    if (!content.endsWith('\n')) return null;
    fail(`navigation header is invalid JSON: ${error.message}`);
  }
  return positiveInteger(header?.options?.output_sample_rate, 'navigation header output sample rate');
}

function hasFooter(rows) {
  return rows.some(row => row && row.kind === 'capture_end');
}

function callbackStatus(callbacks, fadeEnd) {
  if (!callbacks.length) return { state: 'pending' };
  for (const [index, callback] of callbacks.entries()) {
    for (const field of ['sequence', 'callback_qpc_100ns', 'playback_qpc_100ns', 'output_frames', 'paused', 'audition', 'render_lock_miss', 'trace_dropped']) {
      if (!Number.isSafeInteger(callback[field]) || callback[field] < 0) fail(`callback ${index + 1} has invalid ${field}`);
    }
    if (![0, 1].includes(callback.paused) || ![0, 1].includes(callback.audition) || ![0, 1].includes(callback.render_lock_miss)) fail(`callback ${index + 1} has invalid state flags`);
    if ((callback.engine_start === null) !== (callback.engine_end === null)) fail(`callback ${index + 1} has one engine bound`);
    if (callback.engine_start !== null && (!Number.isSafeInteger(callback.engine_start) || !Number.isSafeInteger(callback.engine_end) || callback.engine_start < 0 || callback.engine_end < callback.engine_start)) fail(`callback ${index + 1} has invalid engine bounds`);
    if (index && callback.sequence !== callbacks[index - 1].sequence + 1) fail('callback sequence is discontinuous');
    if (callback.render_lock_miss !== 0) fail('callback render lock miss occurred');
    if (callback.trace_dropped !== 0) fail('callback trace records were dropped');
  }
  const last = callbacks.at(-1);
  if (last.engine_end === null || last.engine_end < fadeEnd) return { state: 'pending' };
  return { state: 'ready' };
}

function irreversibleNavigationFinding(findings) {
  const terminal = new Set([
    'request_record_invalid',
    'accepted_action_not_next',
    'navigation_cancelled',
    'navigation_trace_stale',
    'navigation_trace_duplicate',
    'plan_generation_unmatched',
    'navigation_source_observation_missing',
    'navigation_source_observation_changed',
    'plan_after_transition'
  ]);
  return findings.find(finding => terminal.has(finding.code));
}

/**
 * Reads live capture rows only after each file ends at a writer-flushed line.
 * A ready result proves one completed navigation and callback coverage only.
 */
function inspectVerifiedNavigation({ captureDirectory, child } = {}) {
  if (typeof captureDirectory !== 'string' || !captureDirectory) fail('captureDirectory is required');
  const root = path.resolve(captureDirectory);
  let info;
  try {
    info = fs.statSync(root);
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'pending' };
    throw error;
  }
  if (!info.isDirectory()) fail('captureDirectory is not a directory');

  const terminal = terminalState(root, child);
  if (terminal) fail(terminal);
  const rate = headerRate(root);
  const trace = completedFile(root, 'navigation.jsonl');
  const callbacksFile = captureFile(root, 'callbacks.csv');
  if (!rate || !trace || !callbacksFile) return { state: 'pending' };

  let rows;
  try {
    rows = jsonLines(trace, 'navigation trace');
  } catch (error) {
    fail(error.message);
  }
  if (hasFooter(rows)) fail('capture ended before navigation readiness');

  let callbacks;
  try {
    const content = fs.readFileSync(callbacksFile, 'utf8');
    const lastComplete = content.lastIndexOf('\n');
    if (lastComplete < 0) return { state: 'pending' };
    callbacks = callbackCsvContent(content.slice(0, lastComplete + 1));
  } catch (error) {
    fail(error.message);
  }
  const findings = [];
  let operations;
  try {
    operations = navigationOperations(rows, rate, findings, requestedLabels(rows, findings));
  } catch (error) {
    fail(error.message);
  }
  const irreversible = irreversibleNavigationFinding(findings);
  if (irreversible) fail(`navigation evidence is contradictory: ${irreversible.code}`);
  if (findings.length || operations.length !== 1) return { state: 'pending' };

  const operation = operations[0];
  const callback = callbackStatus(callbacks, operation.fade_end_engine_frame);
  if (callback.state !== 'ready') return { state: 'pending' };
  return { state: 'ready', operation };
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new NavigationVerificationError('navigation readiness aborted'));
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      reject(new NavigationVerificationError('navigation readiness aborted'));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

async function waitForVerifiedNavigation({ captureDirectory, deadline, signal, child, pollIntervalMs = 20 } = {}) {
  if (!Number.isSafeInteger(deadline)) fail('deadline must be an absolute millisecond timestamp');
  positiveInteger(pollIntervalMs, 'pollIntervalMs');
  while (Date.now() < deadline) {
    if (signal?.aborted) fail('navigation readiness aborted');
    const result = inspectVerifiedNavigation({ captureDirectory, child });
    if (result.state === 'ready') return result.operation;
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
  }
  if (signal?.aborted) fail('navigation readiness aborted');
  fail('navigation readiness timed out');
}

module.exports = { NavigationVerificationError, inspectVerifiedNavigation, waitForVerifiedNavigation };
