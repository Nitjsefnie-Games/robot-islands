#!/usr/bin/env python3
"""Parse a V8 .cpuprofile and demangle minified frames via source maps.

Usage:
    python3 analyze-cpuprofile-mapped.py <profile.cpuprofile> [<dist-dir>]

The optional <dist-dir> defaults to /root/robot-islands/dist — the script
walks <dist-dir>/assets/ for *.js.map files and matches each cpuprofile node's
URL by basename.
"""
import json, os, sys, collections, glob

try:
    import sourcemap
except ImportError:
    sys.exit("pip install sourcemap")


def load_maps(dist_dir):
    """Return dict[js_basename] -> SourceMap index."""
    maps = {}
    for path in glob.glob(os.path.join(dist_dir, 'assets', '*.js.map')):
        js_name = os.path.basename(path)[:-4]  # strip .map
        with open(path) as f:
            try:
                maps[js_name] = sourcemap.loads(f.read())
            except Exception as e:
                print(f'WARN: failed to load {path}: {e}', file=sys.stderr)
    return maps


def demangle_frame(cf, maps):
    """Return (demangled_name, source_file) tuple."""
    url = cf.get('url', '')
    line = cf.get('lineNumber', -1)
    col = cf.get('columnNumber', -1)
    fn = cf.get('functionName') or '(anonymous)'

    if line < 0 or col < 0 or not url:
        return fn, url

    # Extract bundle basename (e.g. 'index-DzEnqlD5.js')
    base = url.rsplit('/', 1)[-1]
    sm = maps.get(base)
    if sm is None:
        return fn, base

    try:
        # cpuprofile is 0-indexed; source map V3 lookup is 0-indexed
        tok = sm.lookup(line, col)
        if tok is None:
            return fn, base
        # Token: src (source file), src_line, src_col, name
        orig_name = tok.name or fn
        src = tok.src or base
        # Strip leading ../ for readability
        if src.startswith('../'):
            src = src[3:]
        return f'{orig_name}', f'{src}:{tok.src_line + 1}'
    except Exception:
        return fn, base


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    profile_path = sys.argv[1]
    dist_dir = sys.argv[2] if len(sys.argv) > 2 else '/root/robot-islands/dist'

    with open(profile_path) as f:
        prof = json.load(f)

    maps = load_maps(dist_dir)
    print(f'Loaded {len(maps)} source maps from {dist_dir}/assets/', file=sys.stderr)

    nodes = {n['id']: n for n in prof['nodes']}
    samples = prof.get('samples', [])
    deltas = prof.get('timeDeltas', [])

    # Build parent map
    parent = {}
    for nid, n in nodes.items():
        for c in n.get('children', []):
            parent[c] = nid

    # Self + inclusive time per node-id
    self_us = collections.Counter()
    incl_us = collections.Counter()
    for sid, dt in zip(samples, deltas):
        self_us[sid] += dt
        nid = sid
        seen = set()
        while nid is not None and nid not in seen:
            seen.add(nid)
            incl_us[nid] += dt
            nid = parent.get(nid)

    # Aggregate by (demangled_name, source_loc)
    key_self = collections.Counter()
    key_incl = collections.Counter()
    for nid, n in nodes.items():
        cf = n['callFrame']
        name, src = demangle_frame(cf, maps)
        key = f'{name}  @  {src}'
        key_self[key] += self_us[nid]
        key_incl[key] += incl_us[nid]

    total = sum(self_us.values()) or 1
    print(f'\nTotal CPU time observed: {total/1000:.1f} ms')

    print('\n=== TOP 30 BY SELF TIME (demangled) ===')
    print(f' {"self %":>6}  {"self ms":>10}  {"incl %":>6}  function @ src:line')
    for key, us in key_self.most_common(30):
        if us == 0:
            break
        sp = us * 100 / total
        ip = key_incl[key] * 100 / total
        print(f' {sp:5.2f}%  {us/1000:>9.2f}ms  {ip:5.2f}%  {key}')

    print('\n=== TOP 30 BY INCLUSIVE TIME (demangled) ===')
    print(f' {"incl %":>6}  {"incl ms":>10}  function @ src:line')
    for key, us in key_incl.most_common(30):
        if us == 0:
            break
        ip = us * 100 / total
        print(f' {ip:5.2f}%  {us/1000:>9.2f}ms  {key}')


if __name__ == '__main__':
    main()
