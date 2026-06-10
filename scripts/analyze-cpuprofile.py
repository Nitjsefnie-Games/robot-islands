#!/usr/bin/env python3
"""Parse a V8 .cpuprofile and produce a flat self-time-per-function table."""
import json, sys, collections

def main():
    path = sys.argv[1]
    with open(path) as f:
        prof = json.load(f)

    nodes = {n['id']: n for n in prof['nodes']}
    samples = prof.get('samples', [])
    deltas = prof.get('timeDeltas', [])
    if len(samples) != len(deltas):
        print(f'WARN: samples={len(samples)} deltas={len(deltas)}', file=sys.stderr)

    # Build child→parent map for callstack reconstruction.
    parent = {}
    for nid, n in nodes.items():
        for c in n.get('children', []):
            parent[c] = nid

    # Self time: sum deltas for each sample's top-of-stack node.
    self_us = collections.Counter()
    total_us = collections.Counter()  # inclusive
    for sample_id, dt in zip(samples, deltas):
        self_us[sample_id] += dt
        # Walk up the stack for inclusive time.
        nid = sample_id
        seen = set()
        while nid is not None and nid not in seen:
            seen.add(nid)
            total_us[nid] += dt
            nid = parent.get(nid)

    # Aggregate by (functionName, url:line) for cross-instance merging.
    key_self = collections.Counter()
    key_total = collections.Counter()
    for nid, n in nodes.items():
        cf = n['callFrame']
        fn = cf.get('functionName') or '(anonymous)'
        url = cf.get('url', '')
        line = cf.get('lineNumber', -1)
        # Trim long urls
        if 'robot-islands/src/' in url:
            short = url.split('robot-islands/')[-1]
        elif url.startswith('file://'):
            short = url.replace('file://', '')
            if 'robot-islands' in short:
                short = short[short.find('robot-islands'):]
        elif url.startswith('node:'):
            short = url
        else:
            short = url[-40:] if len(url) > 40 else url
        key = f'{fn}  @  {short}:{line+1 if line >= 0 else "?"}'
        key_self[key] += self_us[nid]
        key_total[key] += total_us[nid]

    total = sum(self_us.values()) or 1
    print(f'Total CPU time observed: {total/1000:.1f} ms')
    print()
    print('=== TOP 30 BY SELF TIME ===')
    print(f'{"self %":>7}  {"self ms":>10}  {"incl %":>7}  function @ file:line')
    for key, us in key_self.most_common(30):
        incl = key_total[key]
        print(f'{100*us/total:>6.2f}%  {us/1000:>9.2f}ms  {100*incl/total:>6.2f}%  {key}')
    print()
    print('=== TOP 30 BY INCLUSIVE TIME ===')
    print(f'{"incl %":>7}  {"incl ms":>10}  function @ file:line')
    for key, us in key_total.most_common(30):
        print(f'{100*us/total:>6.2f}%  {us/1000:>9.2f}ms  {key}')

if __name__ == '__main__':
    main()
