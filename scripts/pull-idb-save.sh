#!/usr/bin/env bash
# pull-idb-save.sh — dump the live Robot Islands save from a Daedalus-connected
# browser tab to a local JSON file. Companion to scripts/profile-economy.ts.
#
# Usage:
#   ./scripts/pull-idb-save.sh [output-path]
#
# Default output: /tmp/robot-islands-save.json
#
# Env vars (required):
#   TOKEN — Daedalus bridge token
#   ID    — Chrome tab ID hosting the Robot Islands page (per `daedalus.py tabs`)
#
# The script walks SUPPORTED_LOAD_VERSIONS the same way `loadWorld` does in
# src/persistence.ts, so it doesn't need updating when SCHEMA_VERSION bumps —
# it just tries the highest version first and falls back.

set -euo pipefail

DAEDALUS="${DAEDALUS:-$HOME/Daedalus/daedalus.py}"
OUTPUT_PATH="${1:-/tmp/robot-islands-save.json}"

if [[ -z "${TOKEN:-}" ]]; then
  echo "ERROR: TOKEN env var required (Daedalus bridge token)" >&2
  exit 1
fi
if [[ -z "${ID:-}" ]]; then
  echo "ERROR: ID env var required (Chrome tab ID; see 'python3 \$DAEDALUS tabs')" >&2
  exit 1
fi
if [[ ! -f "$DAEDALUS" ]]; then
  echo "ERROR: daedalus.py not found at $DAEDALUS (set \$DAEDALUS to override)" >&2
  exit 1
fi

# Write the IDB-dump payload. Walks supported save-key versions descending so
# the latest one wins — matches persistence.ts loadWorld behaviour.
PAYLOAD=$(mktemp /tmp/pull-idb-payload.XXXXXX.js)
trap 'rm -f "$PAYLOAD"' EXIT

cat > "$PAYLOAD" <<'EOF'
await (async () => {
  // Try schema versions descending — matches src/persistence.ts loadWorld walker.
  const SUPPORTED = [14, 13, 12, 11, 10, 9, 8, 7];
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('keyval-store', 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('keyval', 'readonly');
      const store = tx.objectStore('keyval');
      let remaining = SUPPORTED.length;
      let found = null;
      const finish = () => {
        if (--remaining > 0) return;
        if (found === null) reject('no-save-found-in-any-supported-version');
        else resolve(found);
      };
      SUPPORTED.forEach((v) => {
        const r = store.get(`robot-islands:save:v${v}`);
        r.onsuccess = () => { if (r.result && (found === null || (r.result.v ?? 0) > (found.v ?? 0))) found = r.result; finish(); };
        r.onerror = () => finish();
      });
    };
    req.onerror = () => reject(req.error.message);
  });
})()
EOF

# Stream the dump through daedalus put. Header lines (sent, hdr) are the first
# two lines of stdout; the rest is the JSON body.
RAW=$(mktemp /tmp/pull-idb-raw.XXXXXX.txt)
trap 'rm -f "$PAYLOAD" "$RAW"' EXIT

python3 "$DAEDALUS" put _idbdump "$PAYLOAD" --timeout 120 > "$RAW"

# tail -n +3 strips: line 1 "→ _idbdump → tab=… (N bytes)" and line 2 "← _idbdump tab=… @url"
tail -n +3 "$RAW" > "$OUTPUT_PATH"

# Validate it parses as JSON and extract meta.
META=$(python3 <<PYEOF
import json
d = json.load(open("$OUTPUT_PATH"))
w = d.get("world", {})
print(f'v={d.get("v")}  islands={len(w.get("islands", []))}  states={len(d.get("islandStates", []))}  drones={len(w.get("drones", []))}  routes={len(w.get("routes", []))}  sats={len(w.get("satellites", []))}')
PYEOF
)

echo "Saved → $OUTPUT_PATH ($(stat -c %s "$OUTPUT_PATH") bytes)"
echo "  $META"
