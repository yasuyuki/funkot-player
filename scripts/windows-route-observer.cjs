const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function compileWindowsRouteObserver(directory) {
  if (process.platform !== 'win32') throw new Error('Windows route observation requires Windows');
  const root = fs.realpathSync(directory);
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || fs.readdirSync(root).length) throw new Error('observer output directory must be empty and not a link');
  const source = path.join(__dirname, 'windows-route-observer.cs');
  const output = path.join(root, 'windows-route-observer.exe');
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('Windows system directory must be absolute');
  const systemInfo = fs.lstatSync(systemRoot);
  if (!systemInfo.isDirectory() || systemInfo.isSymbolicLink()) throw new Error('Windows system directory must not be a link');
  const compiler = path.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  for (const file of [source, compiler]) {
    const fileInfo = fs.lstatSync(file);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error('observer source and compiler must be regular files');
  }
  const sourceHash = hash(source);
  const compilerHash = hash(compiler);
  const build = spawnSync(compiler, ['/nologo', `/out:${output}`, source], { cwd: root, encoding: 'utf8' });
  if (build.error || build.status !== 0 || hash(source) !== sourceHash || hash(compiler) !== compilerHash) throw new Error('Windows route observer build failed or its inputs changed');
  const outputInfo = fs.lstatSync(output);
  if (!outputInfo.isFile() || outputInfo.isSymbolicLink()) throw new Error('Windows route observer is not a regular file');
  const outputHash = hash(output);
  return {
    async observe({ processId, stream, deadlineMs, signal }) {
      if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error('route observation requires a process id');
      if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error('route observation requires a remaining deadline');
      if (hash(source) !== sourceHash || hash(output) !== outputHash) throw new Error('Windows route observer changed');
      const result = await new Promise((resolve, reject) => {
        const child = spawn(output, [String(processId)], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: deadlineMs, signal });
        const chunks = [];
        child.stdout.on('data', chunk => chunks.push(chunk));
        child.once('error', reject);
        child.once('close', (status, terminated) => resolve({ status, terminated, stdout: Buffer.concat(chunks).toString('utf8') }));
      });
      if (result.terminated || hash(source) !== sourceHash || hash(output) !== outputHash) throw new Error('Windows route observation failed or its inputs changed');
      if (result.status === 3 || result.status === 4) {
        const error = new Error('Windows route session is not yet observable');
        error.code = 'FUNKOT_OBSERVER_NO_SESSION';
        throw error;
      }
      if (result.status !== 0) throw new Error('Windows route observation failed');
      let value;
      try { value = JSON.parse(result.stdout.replace(/^\uFEFF/, '')); } catch { throw new Error('Windows route observer returned invalid JSON'); }
      if (!value || value.process_id !== processId || typeof value.endpoint_id !== 'string' || !value.endpoint_id || typeof value.session_id !== 'string' || !value.session_id) throw new Error('Windows route observer returned an invalid session');
      if (!stream || (stream.endpoint_id !== value.endpoint_id && stream.endpoint_id !== `wasapi:${value.endpoint_id}`) || value.rate !== stream.rate || value.channels !== stream.channels || value.sample_format !== stream.sample_format) throw new Error('Windows route does not match capture stream');
      return { ...value, endpoint_id: stream.endpoint_id };
    }
  };
}

module.exports = { compileWindowsRouteObserver };
