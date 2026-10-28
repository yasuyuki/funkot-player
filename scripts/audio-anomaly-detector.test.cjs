const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const detector = path.join(__dirname, 'audio-anomaly-detector.cjs');
const RATE = 48000;
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, value) => fs.writeFileSync(file, value);
const json = (file, value) => write(file, JSON.stringify(value, null, 2));
function wave(file, frames, mutate) {
    const bytes = Buffer.alloc(44 + frames * 8);
    bytes.write('RIFF', 0);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(3, 20);
    bytes.writeUInt16LE(2, 22);
    bytes.writeUInt32LE(RATE, 24);
    bytes.writeUInt32LE(RATE * 8, 28);
    bytes.writeUInt16LE(8, 32);
    bytes.writeUInt16LE(32, 34);
    bytes.write('data', 36);
    bytes.writeUInt32LE(frames * 8, 40);
    for (let frame = 0; frame < frames; frame++)
        for (let ch = 0; ch < 2; ch++) {
            const envelope = 0.15 + 0.85 * Math.min(1, frame / 64, (frames - 1 - frame) / 64);
            const ordinary = Math.sin((frame + ch * 7) * 0.031) * 0.2 * envelope;
            bytes.writeFloatLE(mutate?.(frame, ch, ordinary) ?? ordinary, 44 + (frame * 2 + ch) * 4);
        }
    write(file, bytes);
}
function fixture(t, ranges) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-state-'));
    t.after(() => fs.rmSync(root, {
        recursive: true, force: true
    }));
    const frames = 480;
    const reference = path.join(root, 'reference.wav'), a = path.join(root, 'a.wav'), b = path.join(root, 'b.wav'), capture = path.join(root, 'capture.wav');
    wave(reference, frames);
    wave(a, frames, (f, c, v) => v + 1e-7);
    wave(b, frames, (f, c, v) => v - 1e-7);
    wave(capture, frames);
    const packets = path.join(root, 'packets.csv'), callbacks = path.join(root, 'callbacks.csv'), endpointA = path.join(root, 'endpoint-a.json'), endpointB = path.join(root, 'endpoint-b.json'), endpoint = path.join(root, 'endpoint.json');
    write(packets, '#format_tag,3\n#sample_rate,48000\n#channels,2\nfile_frame,qpc_100ns,frames,flags\n0,0,96,0\n96,20000,96,0\n192,40000,96,0\n288,60000,96,0\n384,80000,96,0\n');
    write(callbacks, 'sequence,callback_qpc_100ns,playback_qpc_100ns,output_frames,engine_start,engine_end,paused,audition,render_lock_miss,trace_dropped\n1,0,0,96,0,96,0,0,0,0\n2,20000,20000,96,96,192,0,0,0,0\n3,40000,40000,96,192,288,0,0,0,0\n4,60000,60000,96,288,384,0,0,0,0\n5,80000,80000,96,384,480,0,0,0,0\n');
    const route = {
        endpoint_id: 'stable-route', rate: RATE, channels: 2, sample_format: 'f32'
    };
    const routehash = crypto.createHash('sha256').update(JSON.stringify(route)).digest('hex');
    json(endpointA, {
        schema: 1, run_id: 'a', process_id: 1, stream: route, session: {
            before: {
                ...route, process_id: 1, session_id: 'a'
            },
            after: {
                ...route, process_id: 1, session_id: 'a'
            }
        }
    });
    json(endpointB, {
        schema: 1, run_id: 'b', process_id: 2, stream: route, session: {
            before: {
                ...route, process_id: 2, session_id: 'b'
            },
            after: {
                ...route, process_id: 2, session_id: 'b'
            }
        }
    });
    json(endpoint, {
        schema: 1, run_id: 'target', process_id: 3, stream: route, session: {
            before: {
                ...route, process_id: 3, session_id: 'target'
            },
            after: {
                ...route, process_id: 3, session_id: 'target'
            }
        }
    });
    const descriptor = file => ({
        file: path.basename(file), sha256: sha(file)
    });
    const state = (name, wav, receipt, stateRanges = ranges || [{
            start: 0, end: frames, kind: 'audio', reference_start: 0, first_sequence: 1, last_sequence: 5
        }
    ]) => {
        const file = path.join(root, name);
        json(file, {
            schema: 1, routehash, capture: descriptor(wav), reference: descriptor(reference), packets: descriptor(packets), callbacks: descriptor(callbacks), endpoint_receipt: descriptor(receipt), ranges: stateRanges
        });
        return file;
    };
    return {
        root, frames, reference, capture, packets, callbacks, aState: state('a-state.json', a, endpointA), bState: state('b-state.json', b, endpointB), targetState: state('target-state.json', capture, endpoint), calibration: path.join(root, 'calibration.json'), result: path.join(root, 'result.json')
    };
}
function addOrigin(input, stateFile, captureFile, name) {
    const rawCapture = path.join(input.root, `raw-capture-${name}.wav`), rawPackets = path.join(input.root, `raw-packets-${name}.csv`), rawCallbacks = path.join(input.root, `raw-callbacks-${name}.csv`), origin = path.join(input.root, `origin-${name}`, 'origin.json');
    const capture = fs.readFileSync(captureFile), raw = Buffer.alloc(capture.length + 96 * 8);
    capture.copy(raw);
    raw.writeUInt32LE(raw.length - 8, 4);
    raw.writeUInt32LE(raw.length - 44, 40);
    write(rawCapture, raw);
    write(rawPackets, fs.readFileSync(input.packets, 'utf8') + `${input.frames},100000,96,0\n`);
    write(rawCallbacks, fs.readFileSync(input.callbacks));
    fs.mkdirSync(path.dirname(origin), {
        recursive: true
    });
    json(origin, {
        raw_capture: { file: `../raw-capture-${name}.wav`, sha256: sha(rawCapture) },
        raw_packets: { file: `../raw-packets-${name}.csv`, sha256: sha(rawPackets) },
        raw_callbacks: { file: `../raw-callbacks-${name}.csv`, sha256: sha(rawCallbacks) },
        start_frame: 0, end_frame: input.frames
    });
    const state = JSON.parse(fs.readFileSync(stateFile));
    state.origin = { file: path.relative(input.root, origin), sha256: sha(origin) };
    json(stateFile, state);
    return { origin, rawCapture, rawCallbacks };
}
function calibrate(input) {
    execFileSync(process.execPath, [detector, 'calibrate-state', input.aState, input.bState, input.calibration], {
        stdio: 'pipe'
    });
}
function scan(input) {
    execFileSync(process.execPath, [detector, 'scan-state', input.targetState, input.calibration, input.result], {
        stdio: 'pipe'
    });
    return JSON.parse(fs.readFileSync(input.result, 'utf8'));
}
test('state negatives calibrate and a stereo kick/fade scans clean', t => {
    const input = fixture(t);
    calibrate(input);
    const result = scan(input);
    assert.equal(result.classification, 'clean', JSON.stringify(result));
    assert.equal(result.coverage.complete, true);
    assert.equal(result.coverage.audio_windows, 1);
});
test('an impulse and a 24-frame zero gap are found near their known frame', t => {
    const input = fixture(t);
    calibrate(input);
    const bytes = fs.readFileSync(input.capture);
    for (let frame = 211; frame < 235; frame++)
        for (let ch = 0; ch < 2; ch++)
            bytes.writeFloatLE(0, 44 + (frame * 2 + ch) * 4);
    bytes.writeFloatLE(1, 44 + 200 * 8);
    write(input.capture, bytes);
    const state = JSON.parse(fs.readFileSync(input.targetState));
    state.capture.sha256 = sha(input.capture);
    json(input.targetState, state);
    const result = scan(input);
    assert.equal(result.classification, 'dropout', JSON.stringify(result));
    assert.ok(Math.abs(result.first.frame - 211) <= 1, JSON.stringify(result.first));
});
test('a final-frame impulse is included in the final 96-frame window', t => {
    const input = fixture(t);
    calibrate(input);
    const bytes = fs.readFileSync(input.capture);
    bytes.writeFloatLE(1, 44 + (input.frames - 1) * 8);
    write(input.capture, bytes);
    const state = JSON.parse(fs.readFileSync(input.targetState));
    state.capture.sha256 = sha(input.capture);
    json(input.targetState, state);
    const result = scan(input);
    assert.equal(result.classification, 'pcm_transient', JSON.stringify(result));
    assert.ok(result.residual.candidateFrames.includes(384), JSON.stringify(result));
});
test('a dropout crossing contiguous audio ranges is not reset', t => {
    const ranges = [{
            start: 0, end: 288, kind: 'audio', reference_start: 0, first_sequence: 1, last_sequence: 3
        },
        {
            start: 288, end: 480, kind: 'audio', reference_start: 288, first_sequence: 4, last_sequence: 5
        }
    ];
    const input = fixture(t, ranges);
    calibrate(input);
    const bytes = fs.readFileSync(input.capture);
    for (let frame = 265; frame < 289; frame++)
        for (let channel = 0; channel < 2; channel++)
            bytes.writeFloatLE(0, 44 + (frame * 2 + channel) * 4);
    write(input.capture, bytes);
    const state = JSON.parse(fs.readFileSync(input.targetState));
    state.capture.sha256 = sha(input.capture);
    json(input.targetState, state);
    const result = scan(input);
    assert.equal(result.classification, 'dropout', JSON.stringify(result));
    assert.equal(result.first.frame, 265);
});
test('a checked intentional pause is safe but an advancing tail is not exempt', t => {
    const ranges = [{
            start: 0, end: 192, kind: 'audio', reference_start: 0, first_sequence: 1, last_sequence: 2
        },
        {
            start: 192, end: 288, kind: 'intentional', first_sequence: 3, last_sequence: 3, reason: 'paused'
        },
        {
            start: 288, end: 480, kind: 'audio', reference_start: 288, first_sequence: 4, last_sequence: 5
        }
    ];
    const input = fixture(t, ranges);
    for (const file of [input.capture, path.join(input.root, 'a.wav'), path.join(input.root, 'b.wav')]) {
        const bytes = fs.readFileSync(file);
        for (let frame = 192; frame < 288; frame++)
            for (let channel = 0; channel < 2; channel++)
                bytes.writeFloatLE(0, 44 + (frame * 2 + channel) * 4);
        write(file, bytes);
    }
    const rows = fs.readFileSync(input.callbacks, 'utf8').trim().split(/\r?\n/);
    rows[3] = '3,40000,40000,96,,,1,0,0,0';
    write(input.callbacks, `${rows.join('\n')}\n`);
    for (const file of [input.aState, input.bState, input.targetState]) {
        const state = JSON.parse(fs.readFileSync(file));
        state.capture.sha256 = sha(path.join(input.root, state.capture.file));
        state.callbacks.sha256 = sha(input.callbacks);
        json(file, state);
    }
    calibrate(input);
    assert.equal(scan(input).classification, 'clean');
    rows[3] = '3,40000,40000,96,192,288,1,0,0,0';
    write(input.callbacks, `${rows.join('\n')}\n`);
    const state = JSON.parse(fs.readFileSync(input.targetState));
    state.callbacks.sha256 = sha(input.callbacks);
    json(input.targetState, state);
    assert.equal(scan(input).classification, 'capture_fault');
});
test('lock misses fault and unsupported reference coverage is incomplete', t => {
    const input = fixture(t);
    calibrate(input);
    const rows = fs.readFileSync(input.callbacks, 'utf8').trim().split(/\r?\n/);
    rows[2] = rows[2].replace(',0,0,0,0', ',0,0,1,0');
    write(input.callbacks, `${rows.join('\n')}\n`);
    const state = JSON.parse(fs.readFileSync(input.targetState));
    state.callbacks.sha256 = sha(input.callbacks);
    json(input.targetState, state);
    assert.equal(scan(input).classification, 'capture_fault');
    rows[2] = rows[2].replace(',0,0,1,0', ',0,0,0,0');
    write(input.callbacks, `${rows.join('\n')}\n`);
    state.callbacks.sha256 = sha(input.callbacks);
    state.ranges[0].reference_start = 999999;
    json(input.targetState, state);
    assert.equal(scan(input).classification, 'incomplete');
});
test('missing callback coverage rejects clean output and rate mismatch rejects', t => {
    const input = fixture(t);
    calibrate(input);
    const state = JSON.parse(fs.readFileSync(input.targetState));
    state.ranges[0].last_sequence = 9;
    json(input.targetState, state);
    assert.equal(scan(input).classification, 'incomplete');
    state.ranges[0].last_sequence = 5;
    state.capture.file = 'reference.wav';
    state.capture.sha256 = sha(input.reference);
    json(input.targetState, state);
    const bytes = fs.readFileSync(input.reference);
    bytes.writeUInt32LE(44100, 24);
    write(input.reference, bytes);
    assert.throws(() => scan(input));
});
test('predicted playback QPC jitter does not reject healthy audio calibration', t => {
    const input = fixture(t);
    const rows = fs.readFileSync(input.callbacks, 'utf8').trim().split(/\r?\n/);
    for (let index = 1; index < rows.length; index++) {
        const fields = rows[index].split(',');
        fields[2] = String((index - 1) * 20000 + [0, 0, 833, -625, 1042, 0][index]);
        rows[index] = fields.join(',');
    }
    write(input.callbacks, `${rows.join('\n')}\n`);
    for (const file of [input.aState, input.bState, input.targetState]) {
        const state = JSON.parse(fs.readFileSync(file));
        state.callbacks.sha256 = sha(input.callbacks);
        json(file, state);
    }
    calibrate(input);
    assert.equal(scan(input).classification, 'clean');
    const shifted = rows.map((row, index) => {
        if (!index) return row;
        const fields = row.split(',');
        fields[2] = String(Number(fields[2]) + 900000);
        return fields.join(',');
    });
    write(input.callbacks, `${shifted.join('\n')}\n`);
    const state = JSON.parse(fs.readFileSync(input.targetState));
    state.callbacks.sha256 = sha(input.callbacks);
    json(input.targetState, state);
    assert.equal(scan(input).classification, 'incomplete');
});
test('audio ranges require complete healthy callback and engine accounting', t => {
    const missing = fixture(t);
    let rows = fs.readFileSync(missing.callbacks, 'utf8').trim().split(/\r?\n/);
    rows.splice(3, 1);
    write(missing.callbacks, `${rows.join('\n')}\n`);
    for (const file of [missing.aState, missing.bState]) {
        const state = JSON.parse(fs.readFileSync(file));
        state.callbacks.sha256 = sha(missing.callbacks);
        json(file, state);
    }
    assert.throws(() => calibrate(missing));
    const zero = fixture(t);
    rows = fs.readFileSync(zero.callbacks, 'utf8').trim().split(/\r?\n/);
    rows[2] = '2,20000,20000,0,96,96,0,0,0,0';
    write(zero.callbacks, `${rows.join('\n')}\n`);
    for (const file of [zero.aState, zero.bState]) {
        const state = JSON.parse(fs.readFileSync(file));
        state.callbacks.sha256 = sha(zero.callbacks);
        json(file, state);
    }
    assert.throws(() => calibrate(zero));
    const mismatch = fixture(t);
    rows = fs.readFileSync(mismatch.callbacks, 'utf8').trim().split(/\r?\n/);
    rows[2] = '2,20000,20000,96,96,191,0,0,0,0';
    rows[3] = '3,40000,40000,96,191,287,0,0,0,0';
    rows[4] = '4,60000,60000,96,287,383,0,0,0,0';
    rows[5] = '5,80000,80000,96,383,479,0,0,0,0';
    write(mismatch.callbacks, `${rows.join('\n')}\n`);
    for (const file of [mismatch.aState, mismatch.bState]) {
        const state = JSON.parse(fs.readFileSync(file));
        state.callbacks.sha256 = sha(mismatch.callbacks);
        json(file, state);
    }
    assert.throws(() => calibrate(mismatch));
    const discontinuous = fixture(t);
    calibrate(discontinuous);
    rows = fs.readFileSync(discontinuous.callbacks, 'utf8').trim().split(/\r?\n/);
    rows[3] = '3,40000,40000,96,10000,10096,0,0,0,0';
    write(discontinuous.callbacks, `${rows.join('\n')}\n`);
    const discontinuousState = JSON.parse(fs.readFileSync(discontinuous.targetState));
    discontinuousState.callbacks.sha256 = sha(discontinuous.callbacks);
    json(discontinuous.targetState, discontinuousState);
    assert.equal(scan(discontinuous).classification, 'capture_fault');
});
test('origin descriptors bind the raw crop and calibration provenance', t => {
    const input = fixture(t), origin = addOrigin(input, input.aState, path.join(input.root, 'a.wav'), 'a');
    addOrigin(input, input.bState, path.join(input.root, 'b.wav'), 'b');
    const targetOrigin = addOrigin(input, input.targetState, input.capture, 'target');
    calibrate(input);
    const calibration = JSON.parse(fs.readFileSync(input.calibration));
    assert.equal(calibration.provenance.a.origin.sha256, sha(origin.origin));
    assert.equal(scan(input).classification, 'clean');
    const raw = fs.readFileSync(targetOrigin.rawCapture);
    raw[44] ^= 1;
    write(targetOrigin.rawCapture, raw);
    assert.throws(() => scan(input));
    const bounds = fixture(t), boundsOrigin = addOrigin(bounds, bounds.aState, path.join(bounds.root, 'a.wav'), 'a');
    addOrigin(bounds, bounds.bState, path.join(bounds.root, 'b.wav'), 'b');
    const badBounds = JSON.parse(fs.readFileSync(boundsOrigin.origin));
    badBounds.end_frame = bounds.frames + 97;
    json(boundsOrigin.origin, badBounds);
    const boundsState = JSON.parse(fs.readFileSync(bounds.aState));
    boundsState.origin.sha256 = sha(boundsOrigin.origin);
    json(bounds.aState, boundsState);
    assert.throws(() => calibrate(bounds));
    const callbacks = fixture(t), callbackOrigin = addOrigin(callbacks, callbacks.targetState, callbacks.capture, 'target');
    calibrate(callbacks);
    const altered = fs.readFileSync(callbacks.callbacks, 'utf8').replace('2,20000,20000,96,96,192,0,0,0,0', '2,20000,777777,96,96,192,0,0,0,0');
    write(callbacks.callbacks, altered);
    const state = JSON.parse(fs.readFileSync(callbacks.targetState));
    state.callbacks.sha256 = sha(callbacks.callbacks);
    json(callbacks.targetState, state);
    assert.throws(() => scan(callbacks));
    const packets = fixture(t);
    addOrigin(packets, packets.targetState, packets.capture, 'target');
    calibrate(packets);
    write(packets.packets, fs.readFileSync(packets.packets, 'utf8').replace('96,20000,96,0', '96,20001,96,0'));
    const packetState = JSON.parse(fs.readFileSync(packets.targetState));
    packetState.packets.sha256 = sha(packets.packets);
    json(packets.targetState, packetState);
    assert.throws(() => scan(packets));
});
test('oversized and nonzero intentional masks are capture faults', t => {
    const oversized = [{
            start: 0, end: 192, kind: 'audio', reference_start: 0, first_sequence: 1, last_sequence: 2
        },
        {
            start: 192, end: 480, kind: 'intentional', first_sequence: 3, last_sequence: 3, reason: 'paused'
        }
    ];
    const input = fixture(t);
    calibrate(input);
    const state = JSON.parse(fs.readFileSync(input.targetState));
    state.ranges = oversized;
    json(input.targetState, state);
    assert.equal(scan(input).classification, 'capture_fault');
    const masked = [{
            start: 0, end: 192, kind: 'audio', reference_start: 0, first_sequence: 1, last_sequence: 2
        },
        {
            start: 192, end: 288, kind: 'intentional', first_sequence: 3, last_sequence: 3, reason: 'paused'
        },
        {
            start: 288, end: 480, kind: 'audio', reference_start: 288, first_sequence: 4, last_sequence: 5
        }
    ];
    state.ranges = masked;
    json(input.targetState, state);
    assert.equal(scan(input).classification, 'capture_fault');
});
test('a gain or DC change is rejected instead of normalized away', t => {
    const input = fixture(t);
    calibrate(input);
    const bytes = fs.readFileSync(input.capture);
    for (let frame = 0; frame < input.frames; frame++)
        for (let channel = 0; channel < 2; channel++)
            bytes.writeFloatLE(bytes.readFloatLE(44 + (frame * 2 + channel) * 4) * 1.2 + 0.1, 44 + (frame * 2 + channel) * 4);
    write(input.capture, bytes);
    const state = JSON.parse(fs.readFileSync(input.targetState));
    state.capture.sha256 = sha(input.capture);
    json(input.targetState, state);
    assert.throws(() => scan(input));
});
test('a local control cannot move its first residual to an untouched window', t => {
    const input = fixture(t);
    for (const file of [input.aState, input.bState]) {
        const state = JSON.parse(fs.readFileSync(file));
        const capture = path.join(input.root, state.capture.file);
        write(capture, fs.readFileSync(input.reference));
        state.capture.sha256 = sha(capture);
        json(file, state);
    }
    calibrate(input);
    assert.equal(scan(input).classification, 'clean');
    for (const frame of [96, 200])
        for (const shape of ['step', 'impulse', 'broadband8']) {
            execFileSync(process.execPath, [detector, 'inject', input.reference, input.capture, String(frame), shape, '0.00005'], { stdio: 'pipe' });
            const state = JSON.parse(fs.readFileSync(input.targetState));
            state.capture.sha256 = sha(input.capture);
            json(input.targetState, state);
            const result = scan(input);
            assert.equal(result.classification, 'pcm_transient');
            assert.equal(result.first.frame, Math.floor(frame / 96) * 96);
        }
});
test('all-intentional negatives and missing calibration thresholds are rejected', t => {
    const input = fixture(t);
    const paused = ['sequence,callback_qpc_100ns,playback_qpc_100ns,output_frames,engine_start,engine_end,paused,audition,render_lock_miss,trace_dropped'];
    for (let sequence = 1; sequence <= 5; sequence++)
        paused.push(`${sequence},${(sequence - 1) * 20000},${(sequence - 1) * 20000},96,,,1,0,0,0`);
    write(input.callbacks, `${paused.join('\n')}\n`);
    for (const name of ['a.wav', 'b.wav']) {
        const file = path.join(input.root, name), bytes = fs.readFileSync(file);
        bytes.fill(0, 44);
        write(file, bytes);
    }
    const intentional = [{
            start: 0, end: input.frames, kind: 'intentional', first_sequence: 1, last_sequence: 5, reason: 'paused'
        }
    ];
    for (const file of [input.aState, input.bState]) {
        const state = JSON.parse(fs.readFileSync(file));
        state.capture.sha256 = sha(path.join(input.root, state.capture.file));
        state.callbacks.sha256 = sha(input.callbacks);
        state.ranges = intentional;
        json(file, state);
    }
    assert.throws(() => calibrate(input));
    const clean = fixture(t);
    calibrate(clean);
    const calibration = JSON.parse(fs.readFileSync(clean.calibration));
    calibration.thresholds.rms = null;
    json(clean.calibration, calibration);
    assert.throws(() => scan(clean));
});
