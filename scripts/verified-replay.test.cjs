const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const childProcess = require('node:child_process');
const { freshReplay, validateCaptureSources, validateProducerRevision, replayExtent } = require('./verified-replay.cjs');

const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-replay-sources-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const player = path.join(root, 'player'), core = path.join(root, 'core');
  const playerNames = ['src-tauri/src/lib.rs', 'src-tauri/src/navigation_capture.rs', 'funkot-core.commit'];
  const files = [path.join(core, 'funkot-core/src/engine.rs'), path.join(core, 'funkot-core/examples/manual_nav_acceptance.rs'), ...playerNames.map(name => path.join(player, name))];
  for (const [index, file] of files.entries()) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `source-${index}`);
  }
  const manifest = path.join(root, 'source.json');
  fs.writeFileSync(manifest, JSON.stringify({ files: files.map(file => ({ file, sha256: digest(file) })) }));
  const build = { guardedInputs: { playerSource: { files: playerNames.map(name => ({ path: name, sha256: digest(path.join(player, name)) })) } } };
  return { root, player, core, files, manifest, build };
}

test('capture sources must match the actual core and verified player files', t => {
  const input = fixture(t);
  assert.equal(validateCaptureSources({ manifest: input.manifest }, input.root, input.player, input.core, input.build).sourceManifest, input.manifest);
  const other = path.join(input.root, 'other.rs');
  fs.copyFileSync(input.files[0], other);
  const manifest = JSON.parse(fs.readFileSync(input.manifest, 'utf8'));
  manifest.files[0].file = other;
  fs.writeFileSync(input.manifest, JSON.stringify(manifest));
  assert.throws(() => validateCaptureSources({ manifest: input.manifest }, input.root, input.player, input.core, input.build), /does not match/);
});

test('capture player source cannot differ from the build inventory', t => {
  const input = fixture(t);
  input.build.guardedInputs.playerSource.files[0].sha256 = '0'.repeat(64);
  assert.throws(() => validateCaptureSources({ manifest: input.manifest }, input.root, input.player, input.core, input.build), /player source does not match/);
});

test('missing or malformed capture revisions are incomplete while valid differences mismatch', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-replay-revisions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pin = fs.readFileSync(path.join(__dirname, '..', 'funkot-core.commit'), 'utf8').trim();
  const header = path.join(root, 'header.json'), capture = path.join(root, 'capture.json'), recipe = path.join(root, 'recipe.json');
  fs.writeFileSync(recipe, JSON.stringify({ schema: 2, work_directory: 'work' }));
  for (const value of [undefined, '', 'bad']) {
    fs.writeFileSync(header, JSON.stringify({ core_git: pin, silent_render: true }));
    fs.writeFileSync(capture, JSON.stringify({ header: { file: header }, core_git: value }));
    assert.throws(() => freshReplay(capture, recipe, {}), /missing or invalid/);
    fs.writeFileSync(header, JSON.stringify({ core_git: value, silent_render: true }));
    fs.writeFileSync(capture, JSON.stringify({ header: { file: header }, core_git: pin }));
    assert.throws(() => freshReplay(capture, recipe, {}), /missing or invalid/);
  }
  fs.writeFileSync(header, JSON.stringify({ core_git: pin, silent_render: true }));
  fs.writeFileSync(capture, JSON.stringify({ header: { file: header }, core_git: '0'.repeat(40) }));
  assert.throws(() => freshReplay(capture, recipe, {}), /does not match/);
});

test('producer revision distinguishes absent evidence from a valid mismatch', () => {
  const pin = 'a'.repeat(40);
  for (const value of [undefined, '', 'bad']) {
    assert.throws(() => validateProducerRevision({ runtime: { core_revision: value } }, pin), /missing or invalid/);
  }
  assert.throws(() => validateProducerRevision({ runtime: { core_revision: 'b'.repeat(40) } }, pin), /does not match/);
  assert.doesNotThrow(() => validateProducerRevision({ runtime: { core_revision: pin } }, pin));
});

test('full replay endpoint follows emitted engine frames across a pause', () => {
  const accepted = { kind: 'accepted', action: 'transition_to_next', active_playhead: 591724, render_frame: 587040 };
  const callbacks = [
    { sequence: 1, engine_end: 587520, output_frames: 480, playback_qpc_100ns: 100000 },
    { sequence: 2, engine_end: 587520, output_frames: 480, playback_qpc_100ns: 200000 },
    { sequence: 3, engine_end: 2688480, output_frames: 480, playback_qpc_100ns: 300000 }
  ];
  const footer = { kind: 'capture_end', last_callback_sequence: 3, last_engine_frame: 2688480,
    last_output_frames: 480, last_playback_qpc_100ns: 300000 };
  assert.deepEqual(replayExtent([accepted, footer], callbacks), { requestFrame: 591724, endFrame: 2693164 });
  assert.throws(() => replayExtent([accepted], callbacks), /final callback/);
  assert.throws(() => replayExtent([accepted, { ...footer, last_engine_frame: 2688479 }], callbacks), /final callback/);
  assert.throws(() => replayExtent([accepted, footer], [callbacks[0], callbacks[2]]), /final callback/);
  assert.throws(() => replayExtent([accepted, accepted, footer], callbacks), /one accepted/);
  assert.throws(() => replayExtent([{ ...accepted, render_frame: 2688480 }, footer], callbacks), /endpoint/);
  assert.throws(() => replayExtent([{ ...accepted, active_playhead: Number.MAX_SAFE_INTEGER }, footer], callbacks), /endpoint/);
});

test('replay does not pass inherited compiler overrides to Cargo', t => {
  const root = fs.mkdtempSync(path.join(__dirname, '.verified-replay-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const player = path.join(root, 'player'), core = path.join(root, 'funkot-autodj-for-ui');
  const write = (file, contents) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); return file; };
  const scripts = path.join(player, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  for (const name of ['verified-replay.cjs', 'verified-player-build.cjs']) fs.copyFileSync(path.join(__dirname, name), path.join(scripts, name));
  const coreFiles = [write(path.join(core, 'funkot-core/src/engine.rs'), 'engine'), write(path.join(core, 'funkot-core/examples/manual_nav_acceptance.rs'), 'driver')];
  const git = args => {
    const result = childProcess.spawnSync('git', ['-C', core, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const pin = git(['rev-parse', 'HEAD']);
  const names = ['src-tauri/src/lib.rs', 'src-tauri/src/navigation_capture.rs', 'funkot-core.commit'];
  const playerFiles = names.map(name => write(path.join(player, name), name === 'funkot-core.commit' ? `${pin}\n` : name));
  const inputs = [write(path.join(root, 'input-a'), 'a'), write(path.join(root, 'input-b'), 'b')];
  const input = write(path.join(root, 'input.json'), JSON.stringify({ files: inputs.map(file => ({ file, sha256: digest(file) })) }));
  const header = write(path.join(root, 'header.json'), JSON.stringify({ core_git: pin, silent_render: false, process_id: 123, input: { content_hashes: inputs.map(digest) } }));
  const trace = write(path.join(root, 'navigation.jsonl'), [
    { kind: 'accepted', action: 'transition_to_next', active_playhead: 1, render_frame: 0 },
    { kind: 'capture_end', last_callback_sequence: 1, last_engine_frame: 480, last_output_frames: 480, last_playback_qpc_100ns: 100000 }
  ].map(JSON.stringify).join('\n') + '\n');
  const callbacks = write(path.join(root, 'callbacks.csv'), 'sequence,callback_qpc_100ns,playback_qpc_100ns,output_frames,engine_start,engine_end,paused,audition,render_lock_miss,trace_dropped\n1,100000,100000,480,0,480,0,0,0,0\n');
  const source = write(path.join(root, 'sources.json'), JSON.stringify({ files: [...coreFiles, ...playerFiles].map(file => ({ file, sha256: digest(file) })) }));
  const binary = fs.realpathSync(process.execPath);
  const capture = write(path.join(root, 'capture.json'), JSON.stringify({ core_git: pin, header: { file: header }, trace: { file: trace }, audio: { callbacks: { file: callbacks } }, identities: { binary: { file: binary }, source: { manifest: source }, input: { manifest: input } } }));
  const recipe = write(path.join(root, 'recipe.json'), JSON.stringify({ schema: 2, work_directory: 'work' }));
  const witness = {
    childPid: 123, endpointReceipt: { process_id: 123 }, header: { realpath: header, sha256: digest(header) }, executable: { realpath: binary, sha256: digest(binary) },
    outputs: { navigation_jsonl: { realpath: trace, sha256: digest(trace) }, callbacks_csv: { realpath: callbacks, sha256: digest(callbacks) } },
    guardFiles: [input, ...inputs].map(file => ({ realpath: file, beforeSha256: digest(file), afterSha256: digest(file) })),
    buildProvenance: { coreRevision: pin, binary: { file: binary, sha256: digest(binary) }, guardedInputs: { playerSource: { files: names.map((name, index) => ({ path: name, sha256: digest(playerFiles[index]) })) } } }
  };
  const overrides = ['RUSTC_WRAPPER', 'CARGO_ENCODED_RUSTFLAGS', 'CC', 'NODE_OPTIONS'];
  const previous = Object.fromEntries(overrides.map(key => [key, process.env[key]]));
  const oldLoad = Module._load;
  let observedMetadata, observedBuild, metadataTimeout, buildTimeout;
  try {
    for (const key of overrides) process.env[key] = 'injected-value';
    Module._load = function(request, parent, isMain) {
      if (request === './verified-capture.cjs' && parent?.filename === path.join(scripts, 'verified-replay.cjs')) return { readCaptureWitness: () => witness };
      if (request === './audio-anomaly-analysis.cjs' && parent?.filename === path.join(scripts, 'verified-replay.cjs')) return require('./audio-anomaly-analysis.cjs');
      if (request === 'node:child_process' && parent?.filename === path.join(scripts, 'verified-replay.cjs')) return { ...childProcess, spawnSync: (command, args, options) => {
        if (command === 'cargo' && args[0] === 'metadata') {
          observedMetadata = options.env;
          metadataTimeout = options.timeout;
          return { status: 0, stdout: JSON.stringify({ target_directory: options.env.CARGO_TARGET_DIR, build_directory: options.env.CARGO_BUILD_BUILD_DIR }) };
        }
        if (command === 'cargo' && args[0] === 'build') { observedBuild = options.env; buildTimeout = options.timeout; return { status: 1 }; }
        return childProcess.spawnSync(command, args, options);
      } };
      return oldLoad.call(this, request, parent, isMain);
    };
    const replay = require(path.join(scripts, 'verified-replay.cjs'));
    assert.throws(() => replay.freshReplay(capture, recipe, {}, Date.now() + 60000), /verified replay build failed/);
    for (const timeout of [metadataTimeout, buildTimeout]) assert.ok(timeout > 0 && timeout <= 60000, 'Cargo must respect the remaining deadline');
    for (const observed of [observedMetadata, observedBuild]) {
      assert.ok(observed, 'replay reached Cargo');
      for (const key of overrides) assert.equal(observed[key], undefined, `${key} reached Cargo`);
      const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH');
      assert.ok(pathKey && process.env[pathKey], 'the tool search path is configured');
      assert.equal(observed[pathKey], process.env[pathKey], 'the tool search path remains available');
    }
  } finally {
    Module._load = oldLoad;
    for (const key of overrides) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
