#!/usr/bin/env python3
"""Check Cargo's recorded source bytes before reusing local build units."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

RECORD = '.funkot-dev-sources.json'
VERSION = 3


def inside(path, root):
    return path == root or root in path.parents


def paths(raw, roots, target, base=None):
    value = Path(raw)
    candidates = [value] if value.is_absolute() else ([base / value] if base else [root / value for root in roots])
    existing = [p for p in candidates if p.exists()]
    return {str(p.resolve()) for p in existing or candidates[:1] if not inside(p.resolve(), target)}


def dep_inputs(dep):
    text = dep.read_text().replace('\\\n', ' ')
    for line in text.splitlines():
        if not line or line.startswith('#'):
            continue
        match = re.search(r'(?<!\\):(?:\s|$)', line)
        if match:
            right = line[match.end():]
            if right.strip():
                words = iter(right.split())
                result = []
                for word in words:
                    while word.endswith('\\'):
                        word = word[:-1] + ' ' + next(words)
                    result.append(word)
                return result
    return []


def marker_stamp(directory):
    return [[p.name, p.stat().st_mtime_ns, p.stat().st_size] for p in sorted(directory.iterdir())
            if p.is_file() and p.name not in ('invoked.timestamp', 'output')
            and not p.name.startswith(('dep-', 'output-')) and p.suffix != '.json']


def package_root(source):
    for parent in (source.parent, *source.parents):
        if (parent / 'Cargo.toml').is_file():
            return parent
    raise ValueError('build-script package manifest is missing')


def package_files(base):
    run = subprocess.run(['cargo', 'package', '--list', '--allow-dirty', '--manifest-path', str(base / 'Cargo.toml')],
                         capture_output=True, text=True)
    if run.returncode:
        raise ValueError('cannot determine build-script default inputs: ' + run.stderr)
    return {str((base / name).resolve()) for name in run.stdout.splitlines() if (base / name).is_file()}


def units(target, roots):
    result = {}
    build_bases = {}
    for dep in [*target.glob('*/deps/*.d'), *target.glob('*/*/deps/*.d'),
                *target.glob('*/build/*/*.d'), *target.glob('*/*/build/*/*.d')]:
        raw = dep_inputs(dep)
        sources = set().union(*(paths(value, roots, target) for value in raw)) if raw else set()
        if not any(any(inside(Path(value), root) for root in roots) for value in sources):
            continue
        build = dep.parent.parent.name == 'build'
        profile = dep.parent.parent.parent if build else dep.parent.parent
        suffix = dep.stem.rpartition('-')[2]
        for fp in (profile / '.fingerprint').glob('*-' + suffix):
            if not fp.is_dir():
                continue
            key = str(fp.relative_to(target))
            result[key] = {'inputs': sources, 'stamp': marker_stamp(fp), 'package': fp.name.rpartition('-')[0]}
            if build:
                build_bases.setdefault((profile, fp.name.rpartition('-')[0]), set()).update(
                    package_root(Path(value)) for value in sources if Path(value).is_file() and value.endswith('.rs'))
    for (profile, package), bases in build_bases.items():
        for output in (profile / 'build').glob(package + '-*/output'):
            fp = profile / '.fingerprint' / output.parent.name
            if not fp.is_dir():
                continue
            lines = output.read_text().splitlines()
            values = set()
            for base in bases:
                values.add(str(base / 'Cargo.toml'))
                for line in lines:
                    if line.startswith(('cargo:rerun-if-changed=', 'cargo::rerun-if-changed=')):
                        values.update(paths(line.split('=', 1)[1], roots, target, base))
                if not any(line.startswith(('cargo:rerun-if-', 'cargo::rerun-if-')) for line in lines):
                    values.update(package_files(base))
            result[str(fp.relative_to(target))] = {'inputs': values, 'stamp': marker_stamp(fp), 'package': package}
    for key, unit in result.items():
        fp = target / key
        deps = set()
        for file in fp.glob('*.json'):
            deps.update(item[1] for item in json.loads(file.read_text()).get('deps', []))
        unit['deps'] = deps
        unit['names'] = {p.name.split('-', 1)[1] for p in fp.iterdir()
                         if p.is_file() and p.name.startswith(('lib-', 'bin-', 'test-', 'example-')) and p.suffix != '.json'}
    return result


class Hashes:
    def __init__(self):
        self.files = 0
        self.bytes = 0
        self.seconds = 0.0

    def read(self, names):
        started = time.monotonic()
        cache = {}

        def digest(path):
            name = str(path)
            if name in cache:
                return cache[name]
            if path.is_dir():
                entries = [(str(child.relative_to(path)), digest(child)) for child in sorted(path.rglob('*')) if child.is_file()]
                value = hashlib.sha256(json.dumps(entries, separators=(',', ':')).encode()).hexdigest()
            elif path.is_file():
                h = hashlib.sha256()
                with path.open('rb') as source:
                    for block in iter(lambda: source.read(1024 * 1024), b''):
                        self.bytes += len(block)
                        h.update(block)
                self.files += 1
                value = h.hexdigest()
            else:
                value = None
            cache[name] = value
            return value

        result = {name: digest(Path(name)) for name in sorted(names)}
        self.seconds += time.monotonic() - started
        return result


def invalidate(target, keys):
    by_profile = {}
    for key in keys:
        fp = target / key
        if fp.parent.name != '.fingerprint' or not inside(fp.resolve(), target):
            raise ValueError('invalid fingerprint path in source record')
        by_profile.setdefault(fp.parent.parent, []).append(fp)
    for profile, fingerprints in by_profile.items():
        with (profile / '.cargo-lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            for fp in fingerprints:
                if fp.exists():
                    shutil.rmtree(fp)


def run(argv, stats):
    roots = []
    while argv[:1] == ['--source-root']:
        roots.append(Path(argv[1]).resolve())
        argv = argv[2:]
    if argv[:1] == ['--']:
        argv = argv[1:]
    roots = sorted(set(roots or [Path.cwd().resolve()]))
    target = Path(os.environ.get('CARGO_TARGET_DIR', 'target')).resolve()
    if argv and Path(argv[0]).name == 'cargo':
        for index, value in enumerate(argv):
            if value == '--':
                break
            requested = argv[index + 1] if value == '--target-dir' else value.partition('=')[2] if value.startswith('--target-dir=') else None
            if requested is not None and Path(requested).resolve() != target:
                raise ValueError('Cargo --target-dir must match CARGO_TARGET_DIR for source attribution')
    target.mkdir(parents=True, exist_ok=True)
    with (target / '.funkot-dev-sources.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            record = json.loads((target / RECORD).read_text())
            if record.get('version') != VERSION:
                record = {}
        except (FileNotFoundError, ValueError):
            record = {}
        previous = record.get('units', {})
        before_units = units(target, roots)
        watched = {name for unit in before_units.values() for name in unit['inputs']}
        watched.update(name for unit in previous.values() for name in unit['inputs'])
        before = stats.read(watched)
        stale = set()
        for key, unit in before_units.items():
            old = previous.get(key)
            if not old or unit['stamp'] != old['stamp'] or {
                    name: before[name] for name in unit['inputs']} != old['inputs']:
                stale.add(key)
        stale.update(key for key, old in previous.items() if any(before.get(name) != value for name, value in old['inputs'].items()))
        while True:
            packages = {before_units[key]['package'] for key in stale if key in before_units}
            names = set().union(*(before_units[key]['names'] for key in stale if key in before_units)) if stale else set()
            expanded = {key for key, unit in before_units.items() if unit['package'] in packages or unit['deps'] & names}
            if expanded <= stale:
                break
            stale.update(expanded)
        executable = Path(argv[0]).resolve() if argv else Path.cwd()
        if stale and inside(executable, target):
            raise ValueError('target executable has stale source inputs; build it with Cargo first')
        invalidate(target, stale)
        clean_units = units(target, roots)
        status = subprocess.call(argv) if argv else 0
        after_units = units(target, roots)
        after_names = {name for unit in after_units.values() for name in unit['inputs']}
        after = stats.read(after_names | watched)
        if any(before[name] != after[name] for name in watched):
            invalidate(target, set(after_units))
            raise ValueError('source input changed during the command; local units were invalidated')
        trusted = {}
        for key, unit in after_units.items():
            old = previous.get(key)
            unchanged = key not in stale and old and old['stamp'] == unit['stamp']
            rebuilt = unit['stamp'] and (key not in clean_units or clean_units[key]['stamp'] != unit['stamp'])
            if unchanged or rebuilt:
                trusted[key] = {'stamp': unit['stamp'], 'inputs': {name: after[name] for name in unit['inputs']}}
        temporary = target / (RECORD + '.' + str(os.getpid()))
        temporary.write_text(json.dumps({'version': VERSION, 'roots': list(map(str, roots)), 'units': trusted}))
        os.replace(temporary, target / RECORD)
        return status if status >= 0 else 128 - status


def main(argv):
    stats = Hashes()
    try:
        return run(argv, stats)
    except (OSError, ValueError, KeyError, IndexError, TypeError) as error:
        print('dev.sh: source attribution failed: ' + str(error), file=sys.stderr)
        return 2
    finally:
        print('dev-source-guard: ' + json.dumps({'hash_files': stats.files, 'hash_bytes': stats.bytes,
              'hash_wall_seconds': round(stats.seconds, 6)}), file=sys.stderr)


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
