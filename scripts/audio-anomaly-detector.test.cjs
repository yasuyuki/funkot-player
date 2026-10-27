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
test('playback QPC, not callback QPC, maps normal state coverage', t => {
    const input = fixture(t);
    const rows = fs.readFileSync(input.callbacks, 'utf8').trim().split(/\r?\n/);
    for (let index = 1; index < rows.length; index++) {
        const fields = rows[index].split(',');
        fields[1] = String(900000 + index * 100000);
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
