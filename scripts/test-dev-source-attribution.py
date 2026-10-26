#!/usr/bin/env python3
"""Exercise source attribution through the real player dev.sh."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid


ROOT = Path(__file__).resolve().parents[1]


def command(argv, cwd=None, env=None):
    return subprocess.run(argv, cwd=cwd, env=env, text=True, capture_output=True)


def git(path, *args):
    result = command(['git', '-C', str(path), *args])
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def preserve_metadata(path, data):
    before = path.stat()
    assert len(data) == before.st_size
    with path.open('r+b') as stream:
        stream.write(data)
    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    after = path.stat()
    assert (before.st_ino, before.st_size, before.st_mtime_ns) == (after.st_ino, after.st_size, after.st_mtime_ns)


def main():
    prefix = 'player-attribution-' + uuid.uuid4().hex
    work = Path(tempfile.mkdtemp(prefix=prefix + '-'))
    records = []
    volume = prefix + '-target'
    command(['docker', 'volume', 'create', '--label', 'org.funkot.attribution-fixture=' + prefix, volume]).check_returncode()
    try:
        core = work / 'funkot-autodj-for-ui'
        (core / 'funkot-core/src').mkdir(parents=True)
        (core / 'Cargo.toml').write_text('[workspace]\nmembers=["funkot-core"]\nresolver="2"\n')
        (core / 'funkot-core/Cargo.toml').write_text('[package]\nname="funkot-core"\nversion="0.0.0"\nedition="2021"\n')
        core_src = core / 'funkot-core/src/lib.rs'
        core_src.write_text('pub fn value() -> u8 { 1 }\n')
        git(core, 'init', '-q')
        git(core, 'add', 'Cargo.toml', 'funkot-core')
        git(core, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Core A')
        core_a = git(core, 'rev-parse', 'HEAD')

        def fixture(name, value=1):
            path = work / name
            (path / 'scripts').mkdir(parents=True)
            (path / 'src-tauri/src').mkdir(parents=True)
            (path / 'build-input').mkdir()
            for rel in ['dev.sh', 'Dockerfile', 'scripts/check-funkot-core-commit.sh', 'scripts/dev_source_guard.py']:
                shutil.copy2(ROOT / rel, path / rel)
            (path / 'funkot-core.commit').write_text(core_a + '\n')
            (path / 'src-tauri/Cargo.toml').write_text('[package]\nname="attribution_fixture"\nversion="0.1.0"\nedition="2021"\n[workspace]\n[dependencies]\nitoa="=1.0.15"\nfunkot-core={path="../../funkot-autodj-for-ui/funkot-core"}\n')
            (path / 'src-tauri/src/lib.rs').write_text('include!(concat!(env!("OUT_DIR"), "/value.rs"));\npub const PLAYER: u8 = ' + str(value) + ';\n#[test]\nfn attribution() { let core=funkot_core::value(); println!("player={} core={} build={} itoa={}", PLAYER, core, BUILD, itoa::Buffer::new().format(PLAYER)); assert_eq!((PLAYER,core,BUILD),(1,1,1)); }\n')
            (path / 'src-tauri/build.rs').write_text('fn main() { println!("cargo:rerun-if-changed=../build-input"); let value=std::fs::read_to_string("../build-input/value").unwrap(); let out=std::env::var("OUT_DIR").unwrap(); std::fs::write(format!("{out}/value.rs"), format!("pub const BUILD: u8 = {};", value.trim())).unwrap(); }\n')
            (path / 'build-input/value').write_text('1\n')
            for file in path.rglob('*'):
                os.utime(file, (978307200, 978307200))
            return path

        def run(path, player=1, core_value=1, build=1, label='', candidate=None, expect_reject=False, core_repo=None):
            env = os.environ.copy()
            env.pop('WORKSPACE_LIFECYCLE_CONTEXT', None)
            env.pop('FUNKOT_CORE_CANDIDATE_SHA', None)
            core_repo = core_repo or core
            env['FUNKOT_CORE_REPO'] = str(core_repo)
            env['FUNKOT_CARGO_TARGET'] = volume
            if candidate:
                env['FUNKOT_CORE_CANDIDATE_SHA'] = candidate
            sources = [path / 'src-tauri/src/lib.rs', path / 'src-tauri/build.rs', path / 'build-input/value', core_repo / 'funkot-core/src/lib.rs']
            before = {str(f.relative_to(work)): hashlib.sha256(f.read_bytes()).hexdigest() for f in sources}
            started = time.monotonic()
            result = command([str(path / 'dev.sh'), 'cargo', 'test', '--manifest-path', 'src-tauri/Cargo.toml', '--', '--nocapture'], env=env)
            wall = time.monotonic() - started
            output = result.stdout + result.stderr
            if expect_reject:
                assert result.returncode and 'FAIL:' in output and 'player=' not in output, output
            else:
                expected = f'player={player} core={core_value} build={build}'
                assert expected in output, label + '\n' + output
                assert (result.returncode == 0) == ((player, core_value, build) == (1, 1, 1)), label + '\n' + output
                assert '1 passed' in output if result.returncode == 0 else '1 failed' in output, output
            after = {str(f.relative_to(work)): hashlib.sha256(f.read_bytes()).hexdigest() for f in sources}
            assert before == after
            compiled = [line.strip() for line in output.splitlines() if 'Compiling ' in line]
            record = dict(label=label, exit=result.returncode, wall_seconds=wall, compiled=compiled, before=before, after=after,
                          guard=[line for line in output.splitlines() if line.startswith('dev-source-guard:')])
            records.append(record)
            print(json.dumps(record), flush=True)
            return compiled

        a = fixture('A')
        b = fixture('B', 2)
        for i, path in enumerate([a, b, a, b, a, b]):
            compiled = run(path, 1 if path == a else 2, label=f'checkout-{i}')
            if i:
                assert not any('Compiling itoa ' in line for line in compiled), compiled
                assert not any('Compiling funkot-core ' in line for line in compiled), compiled
        replaced = work / 'replaced'
        for source in [a, b, a]:
            shutil.copytree(source, replaced, dirs_exist_ok=True)
            run(replaced, 1 if source == a else 2, label='old-mtime-tree-replacement')
        run(a, label='warm-start')
        for i in range(5):
            assert not run(a, label=f'warm-{i}')
        core_other = work / 'other-core'
        command(['git', 'clone', '--quiet', '--no-hardlinks', str(core), str(core_other)]).check_returncode()
        for selected_core in [core_other, core, core_other, core]:
            compiled = run(a, core_repo=selected_core, label='same-pin-different-core-realpath')
            assert not any('Compiling itoa ' in line for line in compiled), compiled
        src = a / 'src-tauri/src/lib.rs'
        original = src.read_bytes()
        env = os.environ.copy()
        env.pop('WORKSPACE_LIFECYCLE_CONTEXT', None)
        env.pop('FUNKOT_CORE_CANDIDATE_SHA', None)
        env['FUNKOT_CORE_REPO'] = str(core)
        env['FUNKOT_CARGO_TARGET'] = volume
        rejected = command([str(a / 'dev.sh'), 'cargo', 'test', '--target-dir', '/unguarded-attribution-output'], env=env)
        assert rejected.returncode == 2 and 'Cargo --target-dir' in rejected.stderr, rejected.stdout + rejected.stderr
        preserve_metadata(src, original.replace(b'PLAYER: u8 = 1', b'PLAYER: u8 = 2'))
        run(a, player=2, label='same-inode-size-mtime-mutant')
        preserve_metadata(src, original)
        run(a, label='same-inode-size-mtime-restored')
        old = src.stat()
        src.write_bytes(original.replace(b'PLAYER: u8 = 1', b'PLAYER: u8 = 2'))
        os.utime(src, (946684800, 946684800))
        run(a, player=2, label='older-mtime-replacement')
        src.write_bytes(original)
        os.utime(src, ns=(old.st_atime_ns, old.st_mtime_ns))
        run(a, label='older-mtime-restored')
        tracked = a / 'build-input/value'
        preserve_metadata(tracked, b'2\n')
        run(a, build=2, label='build-script-tracked-input-mutant')
        preserve_metadata(tracked, b'1\n')
        run(a, label='build-script-tracked-input-restored')
        build_script = a / 'src-tauri/build.rs'
        build_source = build_script.read_bytes()
        replacement = b'"2"' + b' ' * (len(b'value.trim()') - len(b'"2"'))
        preserve_metadata(build_script, build_source.replace(b'value.trim()', replacement))
        run(a, build=2, label='build-script-source-metadata-identical-mutant')
        preserve_metadata(build_script, build_source)
        run(a, label='build-script-source-restored')
        c = fixture('collision/a_b')
        d = fixture('collision/a/b', 2)
        for path in [c, d, c]:
            run(path, 1 if path == c else 2, label='path-encoding-collision')
        original_core = core_src.read_bytes()
        preserve_metadata(core_src, original_core.replace(b'{ 1 }', b'{ 2 }'))
        run(a, label='dirty-core-rejected', expect_reject=True)
        git(core, 'add', 'funkot-core/src/lib.rs')
        git(core, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Core B')
        core_b = git(core, 'rev-parse', 'HEAD')
        run(a, label='wrong-pin-rejected', expect_reject=True)
        run(a, core_value=2, candidate=core_b, label='explicit-core-candidate')
        preserve_metadata(core_src, original_core)
        git(core, 'add', 'funkot-core/src/lib.rs')
        git(core, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Core A again')
        run(a, candidate=git(core, 'rev-parse', 'HEAD'), label='core-content-restored')
        print(json.dumps(dict(status='PASS', calls=len(records))), flush=True)
    finally:
        inspect = command(['docker', 'volume', 'inspect', volume])
        if inspect.returncode == 0:
            info = json.loads(inspect.stdout)[0]
            assert info.get('Labels', {}).get('org.funkot.attribution-fixture') == prefix
            command(['docker', 'volume', 'rm', volume]).check_returncode()
        shutil.rmtree(work)


if __name__ == '__main__':
    main()
