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
function replaceWaveFrames(file, start, end, value = 0) {
    const bytes = fs.readFileSync(file);
    for (let frame = start; frame < end; frame++)
        for (let channel = 0; channel < 2; channel++)
            bytes.writeFloatLE(value, 44 + (frame * 2 + channel) * 4);
    write(file, bytes);
}
function updateAlignment(input, stateFile, anchors = [1, 4]) {
    const state = JSON.parse(fs.readFileSync(stateFile));
    const alignmentFile = path.join(input.root, `alignment-${path.basename(stateFile)}`);
    const rows = fs.readFileSync(input.callbacks, 'utf8').trim().split(/\r?\n/).slice(1).map(line => line.split(','));
    let outputFrame = 0;
    const intervals = new Map(rows.map(row => {
        const interval = { output_frame: outputFrame, frames: Number(row[3]) };
        outputFrame += interval.frames;
        return [Number(row[0]), interval];
    }));
    const alignment = {
        schema: 1,
        origin_frame: 0,
        capture_sha256: state.capture.sha256,
        reference_sha256: state.reference.sha256,
        packets_sha256: state.packets.sha256,
        callbacks_sha256: state.callbacks.sha256,
        anchors: anchors.map(sequence => ({
            sequence,
            capture_frame: intervals.get(sequence).output_frame,
            output_frame: intervals.get(sequence).output_frame,
            frames: intervals.get(sequence).frames
        }))
    };
    json(alignmentFile, alignment);
    state.callback_alignment = { file: path.basename(alignmentFile), sha256: sha(alignmentFile) };
    json(stateFile, state);
    return alignmentFile;
}
function alignedFixture(t) {
    const ranges = [{
            start: 0, end: 192, kind: 'audio', reference_start: 0, first_sequence: 1, last_sequence: 2
        },
        {
            start: 192, end: 288, kind: 'intentional', first_sequence: 3, last_sequence: 3, reason: 'diagnostic_gate'
        },
        {
            start: 288, end: 480, kind: 'audio', reference_start: 288, first_sequence: 4, last_sequence: 5
        }
    ];
    const input = fixture(t, ranges);
    for (const file of [input.reference, input.capture, path.join(input.root, 'a.wav'), path.join(input.root, 'b.wav')])
        replaceWaveFrames(file, 192, 288);
    for (const file of [input.capture, path.join(input.root, 'a.wav'), path.join(input.root, 'b.wav')])
        write(file, fs.readFileSync(input.reference));
    write(input.callbacks, 'sequence,callback_qpc_100ns,playback_qpc_100ns,output_frames,engine_start,engine_end,paused,audition,render_lock_miss,trace_dropped\n1,0,1000,96,0,96,0,0,0,0\n2,20000,23000,96,96,192,0,0,0,0\n3,40000,39000,96,192,192,1,0,0,0\n4,60000,65000,96,192,288,0,0,0,0\n5,80000,79000,96,288,384,0,0,0,0\n');
    for (const stateFile of [input.aState, input.bState, input.targetState]) {
        const state = JSON.parse(fs.readFileSync(stateFile));
        state.capture.sha256 = sha(path.join(input.root, state.capture.file));
        state.reference.sha256 = sha(input.reference);
        state.callbacks.sha256 = sha(input.callbacks);
        json(stateFile, state);
        updateAlignment(input, stateFile);
    }
    return input;
}
function rewriteAlignment(input, stateFile, change) {
    const state = JSON.parse(fs.readFileSync(stateFile)), file = path.join(input.root, state.callback_alignment.file), alignment = JSON.parse(fs.readFileSync(file));
    change(alignment, state);
    json(file, alignment);
    state.callback_alignment.sha256 = sha(file);
    json(stateFile, state);
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
test('counter-aligned callback state accepts exact PCM through jittered playback QPC', t => {
    const input = alignedFixture(t);
    calibrate(input);
    const result = scan(input);
    assert.equal(result.classification, 'clean', JSON.stringify(result));
    assert.equal(result.coverage.complete, true);
});
test('counter-aligned callback state rejects false bindings and shifted source coordinates', t => {
    const hash = alignedFixture(t);
    calibrate(hash);
    rewriteAlignment(hash, hash.targetState, alignment => {
        alignment.capture_sha256 = '0'.repeat(64);
    });
    assert.throws(() => scan(hash));
    const anchor = alignedFixture(t);
    calibrate(anchor);
    rewriteAlignment(anchor, anchor.targetState, alignment => {
        alignment.anchors[0].output_frame++;
    });
    assert.throws(() => scan(anchor));
    const origin = alignedFixture(t);
    calibrate(origin);
    rewriteAlignment(origin, origin.targetState, alignment => {
        alignment.origin_frame++;
    });
    assert.throws(() => scan(origin));
    const reference = alignedFixture(t);
    calibrate(reference);
    const referenceState = JSON.parse(fs.readFileSync(reference.targetState));
    referenceState.ranges[0].reference_start++;
    json(reference.targetState, referenceState);
    assert.equal(scan(reference).classification, 'incomplete');
});
test('counter-aligned callback state rejects gaps, moving pauses, and nonzero intentional PCM', t => {
    const gap = alignedFixture(t);
    calibrate(gap);
    const rows = fs.readFileSync(gap.callbacks, 'utf8').trim().split(/\r?\n/);
    rows[3] = rows[3].replace('3,40000', '4,40000');
    write(gap.callbacks, `${rows.join('\n')}\n`);
    const gapState = JSON.parse(fs.readFileSync(gap.targetState));
    gapState.callbacks.sha256 = sha(gap.callbacks);
    json(gap.targetState, gapState);
    rewriteAlignment(gap, gap.targetState, alignment => {
        alignment.callbacks_sha256 = sha(gap.callbacks);
    });
    assert.equal(scan(gap).classification, 'capture_fault');
    const paused = alignedFixture(t);
    calibrate(paused);
    const pausedRows = fs.readFileSync(paused.callbacks, 'utf8').trim().split(/\r?\n/);
    pausedRows[1] = pausedRows[1].replace(',0,0,0,0', ',1,0,0,0');
    write(paused.callbacks, `${pausedRows.join('\n')}\n`);
    const pausedState = JSON.parse(fs.readFileSync(paused.targetState));
    pausedState.callbacks.sha256 = sha(paused.callbacks);
    json(paused.targetState, pausedState);
    rewriteAlignment(paused, paused.targetState, alignment => {
        alignment.callbacks_sha256 = sha(paused.callbacks);
    });
    assert.equal(scan(paused).classification, 'incomplete');
    const nonzero = alignedFixture(t);
    calibrate(nonzero);
    replaceWaveFrames(nonzero.reference, 200, 201, 0.1);
    replaceWaveFrames(nonzero.capture, 200, 201, 0.1);
    const nonzeroState = JSON.parse(fs.readFileSync(nonzero.targetState));
    nonzeroState.capture.sha256 = sha(nonzero.capture);
    nonzeroState.reference.sha256 = sha(nonzero.reference);
    json(nonzero.targetState, nonzeroState);
    rewriteAlignment(nonzero, nonzero.targetState, alignment => {
        alignment.capture_sha256 = sha(nonzero.capture);
        alignment.reference_sha256 = sha(nonzero.reference);
    });
    assert.equal(scan(nonzero).classification, 'capture_fault');
});
test('a recording may start inside a proven gate callback without clipping any source audio', t => {
    const input = fixture(t);
    calibrate(input);
    const source = fs.readFileSync(input.reference);
    const reference = Buffer.alloc(44 + 576 * 8), capture = Buffer.alloc(44 + 480 * 8);
    for (const buffer of [reference, capture]) {
        source.copy(buffer, 0, 0, 44);
        buffer.writeUInt32LE(buffer.length - 8, 4);
        buffer.writeUInt32LE(buffer.length - 44, 40);
    }
    source.copy(reference, 44 + 144 * 8, 44, 44 + 432 * 8);
    source.copy(capture, 44 + 48 * 8, 44, 44 + 432 * 8);
    write(input.reference, reference);
    write(input.capture, capture);
    const header = fs.readFileSync(input.callbacks, 'utf8').split('\n')[0];
    const callbacks = ['1,0,0,48,,,1,0,0,0', '2,210000,210000,48,,,1,0,0,0', '3,220000,220000,48,,,1,0,0,0'];
    for (let index = 0; index < 5; index++) {
        const start = index * 96, frames = index === 4 ? 48 : 96, qpc = 230000 + index * 20000;
        callbacks.push(`${index + 4},${qpc},${qpc},${frames},${start},${start + frames},0,0,0,0`);
    }
    write(input.callbacks, header + '\n' + callbacks.join('\n') + '\n');
    const state = JSON.parse(fs.readFileSync(input.targetState));
    state.capture.sha256 = sha(input.capture);
    state.reference.sha256 = sha(input.reference);
    state.callbacks.sha256 = sha(input.callbacks);
    state.ranges = [
        { start: 0, end: 48, kind: 'intentional', reason: 'diagnostic_gate', first_sequence: 1, last_sequence: 3 },
        { start: 48, end: 480, kind: 'audio', reference_start: 144, first_sequence: 4, last_sequence: 8 }
    ];
    json(input.targetState, state);
    updateAlignment(input, input.targetState, [4]);
    rewriteAlignment(input, input.targetState, alignment => {
        alignment.origin_frame = -96;
        alignment.anchors[0].capture_frame = 48;
    });
    const result = scan(input);
    assert.equal(result.classification, 'clean');
    assert.equal(result.timing.classification, 'timing_glitch');
    assert.equal(result.ignoredUncapturedTiming.count, 1);
    rewriteAlignment(input, input.targetState, (_alignment, value) => { value.ranges[0].end--; });
    assert.notEqual(scan(input).classification, 'clean');
});

test('counter-aligned postroll requires the closed output receipt', t => {
    const input = alignedFixture(t);
    calibrate(input);
    const expanded = Buffer.alloc(fs.readFileSync(input.capture).length + 96 * 8);
    fs.readFileSync(input.capture).copy(expanded);
    expanded.writeUInt32LE(expanded.length - 8, 4);
    expanded.writeUInt32LE(expanded.length - 44, 40);
    write(input.capture, expanded);
    write(input.packets, `${fs.readFileSync(input.packets, 'utf8')}480,100000,96,0\n`);
    const state = JSON.parse(fs.readFileSync(input.targetState));
    state.capture.sha256 = sha(input.capture);
    state.packets.sha256 = sha(input.packets);
    state.ranges.push({ start: 480, end: 576, kind: 'intentional', reason: 'capture_postroll' });
    json(input.targetState, state);
    rewriteAlignment(input, input.targetState, alignment => {
        alignment.capture_sha256 = sha(input.capture);
        alignment.packets_sha256 = sha(input.packets);
    });
    assert.equal(scan(input).classification, 'incomplete');
    const closed = JSON.parse(fs.readFileSync(input.targetState));
    closed.output_closed = true;
    json(input.targetState, closed);
    assert.equal(scan(input).classification, 'clean');
});
test('counter-aligned engine wait is zero PCM before the recorded source start', t => {
    const input = alignedFixture(t);
    const ranges = [{
            start: 0, end: 96, kind: 'intentional', first_sequence: 1, last_sequence: 1, reason: 'engine_wait'
        },
        {
            start: 96, end: 192, kind: 'audio', reference_start: 96, first_sequence: 2, last_sequence: 2
        },
        {
            start: 192, end: 288, kind: 'intentional', first_sequence: 3, last_sequence: 3, reason: 'diagnostic_gate'
        },
        {
            start: 288, end: 480, kind: 'audio', reference_start: 288, first_sequence: 4, last_sequence: 5
        }
    ];
    for (const file of [input.reference, input.capture, path.join(input.root, 'a.wav'), path.join(input.root, 'b.wav')])
        replaceWaveFrames(file, 0, 96);
    for (const stateFile of [input.aState, input.bState, input.targetState]) {
        const state = JSON.parse(fs.readFileSync(stateFile));
        state.capture.sha256 = sha(path.join(input.root, state.capture.file));
        state.reference.sha256 = sha(input.reference);
        state.ranges = ranges;
        state.engine_start_frame = 96;
        json(stateFile, state);
        updateAlignment(input, stateFile, [2, 4]);
    }
    calibrate(input);
    assert.equal(scan(input).classification, 'clean');
    const invalid = JSON.parse(fs.readFileSync(input.targetState));
    invalid.engine_start_frame = 95;
    json(input.targetState, invalid);
    assert.equal(scan(input).classification, 'capture_fault');
});
test('engine-rendered wait zeros remain compared PCM and expose a transient inside the wait', t => {
    const input = alignedFixture(t);
    for (const file of [input.reference, input.capture, path.join(input.root, 'a.wav'), path.join(input.root, 'b.wav')])
        replaceWaveFrames(file, 0, 96);
    for (const stateFile of [input.aState, input.bState, input.targetState]) {
        const state = JSON.parse(fs.readFileSync(stateFile));
        state.capture.sha256 = sha(path.join(input.root, state.capture.file));
        state.reference.sha256 = sha(input.reference);
        json(stateFile, state);
        updateAlignment(input, stateFile, [2, 4]);
    }
    assert.doesNotThrow(() => calibrate(input));
    assert.equal(scan(input).classification, 'clean');
    replaceWaveFrames(input.capture, 48, 49, 0.01);
    const changed = JSON.parse(fs.readFileSync(input.targetState));
    changed.capture.sha256 = sha(input.capture);
    json(input.targetState, changed);
    updateAlignment(input, input.targetState, [2, 4]);
    const result = scan(input);
    assert.equal(result.classification, 'pcm_transient');
    assert.equal(result.first.frame, 0);
});
test('counter-aligned timing ignores only gaps wholly inside validated intentional PCM', t => {
    const gated = alignedFixture(t);
    const gatedRows = fs.readFileSync(gated.callbacks, 'utf8').trim().split(/\r?\n/);
    gatedRows[4] = '4,60000,300000,96,192,192,1,0,0,0';
    gatedRows[5] = '5,80000,320000,96,192,288,0,0,0,0';
    write(gated.callbacks, `${gatedRows.join('\n')}\n`);
    for (const file of [gated.reference, gated.capture, path.join(gated.root, 'a.wav'), path.join(gated.root, 'b.wav')])
        replaceWaveFrames(file, 192, 384);
    const gatedRanges = [{
            start: 0, end: 192, kind: 'audio', reference_start: 0, first_sequence: 1, last_sequence: 2
        },
        {
            start: 192, end: 384, kind: 'intentional', first_sequence: 3, last_sequence: 4, reason: 'diagnostic_gate'
        },
        {
            start: 384, end: 480, kind: 'audio', reference_start: 384, first_sequence: 5, last_sequence: 5
        }
    ];
    for (const stateFile of [gated.aState, gated.bState, gated.targetState]) {
        const state = JSON.parse(fs.readFileSync(stateFile));
        state.capture.sha256 = sha(path.join(gated.root, state.capture.file));
        state.reference.sha256 = sha(gated.reference);
        state.callbacks.sha256 = sha(gated.callbacks);
        state.ranges = gatedRanges;
        json(stateFile, state);
        updateAlignment(gated, stateFile, [1, 5]);
    }
    calibrate(gated);
    const targetRows = fs.readFileSync(gated.callbacks, 'utf8').trim().split(/\r?\n/);
    targetRows[4] = '4,60000,1000000,96,192,192,1,0,0,0';
    targetRows[5] = '5,80000,1020000,96,192,288,0,0,0,0';
    write(gated.callbacks, `${targetRows.join('\n')}\n`);
    const gatedState = JSON.parse(fs.readFileSync(gated.targetState));
    gatedState.callbacks.sha256 = sha(gated.callbacks);
    json(gated.targetState, gatedState);
    updateAlignment(gated, gated.targetState, [1, 5]);
    const ignored = scan(gated);
    assert.equal(ignored.classification, 'clean', JSON.stringify(ignored));
    assert.equal(ignored.timing.glitches.length, 1);
    assert.equal(ignored.ignoredIntentionalTiming.count, 1);
    const audible = alignedFixture(t);
    calibrate(audible);
    const audibleRows = fs.readFileSync(audible.callbacks, 'utf8').trim().split(/\r?\n/);
    audibleRows[2] = '2,20000,500000,96,96,192,0,0,0,0';
    audibleRows[3] = '3,40000,520000,96,192,192,1,0,0,0';
    write(audible.callbacks, `${audibleRows.join('\n')}\n`);
    const audibleState = JSON.parse(fs.readFileSync(audible.targetState));
    audibleState.callbacks.sha256 = sha(audible.callbacks);
    json(audible.targetState, audibleState);
    updateAlignment(audible, audible.targetState);
    const reported = scan(audible);
    assert.equal(reported.classification, 'timing_glitch', JSON.stringify(reported));
    assert.equal(reported.ignoredIntentionalTiming.count, 0);
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
