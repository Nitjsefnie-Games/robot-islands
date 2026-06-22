#!/usr/bin/env bash
# Reusable isolated benchmark runner for the server catch-up calculation
# (deserialize + advanceWorldEconomy + advanceWorldSystems). Wraps the
# bench/*.mts harnesses with the orchestration a clean perf run needs:
#
#   1. a FROZEN COPY of the real save (so live play can't drift the baseline,
#      and the bench can never write the production DB), and
#   2. CPU isolation — confine all userspace to cores 0..N-2 and give the bench
#      an exclusive slice on the top core, so scheduler contention doesn't add
#      noise. (Kernel per-CPU threads / IRQs on the bench core can't be moved
#      without isolcpus+reboot; min-of-reps in the harness absorbs that jitter.)
#
# All measurement is read-only against the COPY DB (robot_islands_bench) or a
# cached snapshot file — the production DB is touched only by a read-only
# pg_dump during `refresh-db`. The harness verifies a SHA-256 oracle digest of
# the advanced world across reps, so any behavior-preserving optimization keeps
# it byte-identical; a mismatch aborts.
#
# Usage:
#   bench/iso-bench.sh setup            # confine userspace to 0..N-2, reserve top core
#   bench/iso-bench.sh refresh-db       # re-freeze the copy DB from production (read-only dump)
#   bench/iso-bench.sh run [gapMin] [reps]      # phases + full catchUp bench on the isolated core
#   bench/iso-bench.sh profile [gapMin] [reps]  # full bench under --cpu-prof; prints the .cpuprofile path
#   bench/iso-bench.sh teardown         # give the reserved core back to userspace
#
# Env overrides: PROD_DB (default robot_islands), BENCH_DB (robot_islands_bench),
#   BENCH_USER (default = the largest save), SNAP (snapshot cache file),
#   PGUSER (default root).
set -euo pipefail

PGUSER="${PGUSER:-root}"; export PGUSER
PROD_DB="${PROD_DB:-robot_islands}"
BENCH_DB="${BENCH_DB:-robot_islands_bench}"
SNAP="${SNAP:-/tmp/ri_bench_snapshot.json}"
SLICE="ri-bench.slice"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NCPU="$(nproc)"
TOPCORE=$((NCPU - 1))           # isolated bench core = last core
RESTCORES="0-$((NCPU - 2))"     # everything else

# Default BENCH_USER = the save with the most buildings (the heaviest calc).
pick_user() {
  psql -d "$BENCH_DB" -tAc \
    "select user_id from save_islands group by user_id \
     order by sum(jsonb_array_length(coalesce(state->'buildings','[]'::jsonb))) desc nulls last limit 1;" \
    2>/dev/null | tr -d '[:space:]'
}

iso() { systemd-run --scope --slice="$SLICE" -p AllowedCPUs="$TOPCORE" --quiet "$@"; }

cmd="${1:-run}"; shift || true
case "$cmd" in
  setup)
    systemctl set-property --runtime system.slice AllowedCPUs="$RESTCORES"
    systemctl set-property --runtime user.slice   AllowedCPUs="$RESTCORES"
    systemctl set-property --runtime init.scope   AllowedCPUs="$RESTCORES"
    sleep 1
    echo "userspace confined to $RESTCORES; bench core = $TOPCORE"
    iso bash -c 'echo "verify bench core: $(ps -o psr= -p $$)"'
    ;;
  teardown)
    ALL="0-$TOPCORE"
    systemctl set-property --runtime system.slice AllowedCPUs="$ALL"
    systemctl set-property --runtime user.slice   AllowedCPUs="$ALL"
    systemctl set-property --runtime init.scope   AllowedCPUs="$ALL"
    echo "userspace restored to $ALL"
    ;;
  refresh-db)
    dropdb --if-exists "$BENCH_DB"
    createdb "$BENCH_DB"
    pg_dump "$PROD_DB" | psql -q "$BENCH_DB"   # pg_dump is read-only on prod
    rm -f "$SNAP"                              # invalidate the cached snapshot
    echo "froze $PROD_DB -> $BENCH_DB"
    ;;
  run)
    GAP="${1:-8}"; REPS="${2:-10}"
    USER_ID="${BENCH_USER:-$(pick_user)}"
    echo "=== phases (gap=${GAP}min, user=${USER_ID}) ==="
    iso env DATABASE_URL="postgresql:///$BENCH_DB" BENCH_USER="$USER_ID" \
        npx tsx "$HERE/catchup-phases.mts" "$GAP"
    echo "=== full catchUp (gap=${GAP}min, reps=${REPS}) ==="
    [ -f "$SNAP" ] || DATABASE_URL="postgresql:///$BENCH_DB" BENCH_USER="$USER_ID" \
        BENCH_SNAPSHOT_FILE="$SNAP" BENCH_DUMP=1 npx tsx "$HERE/catchup-bench.mts" "$GAP" 1 >/dev/null
    iso env BENCH_SNAPSHOT_FILE="$SNAP" BENCH_USER="$USER_ID" \
        npx tsx "$HERE/catchup-bench.mts" "$GAP" "$REPS"
    ;;
  profile)
    GAP="${1:-8}"; REPS="${2:-6}"
    USER_ID="${BENCH_USER:-$(pick_user)}"
    OUT="${BENCH_PROFILE_OUT:-/tmp/ri-catchup.cpuprofile}"
    [ -f "$SNAP" ] || DATABASE_URL="postgresql:///$BENCH_DB" BENCH_USER="$USER_ID" \
        BENCH_SNAPSHOT_FILE="$SNAP" BENCH_DUMP=1 npx tsx "$HERE/catchup-bench.mts" "$GAP" 1 >/dev/null
    # In-process inspector profiler (profiles only the warmed compute region;
    # node --cpu-prof under tsx attributes everything to the loader worker).
    iso env BENCH_SNAPSHOT_FILE="$SNAP" BENCH_USER="$USER_ID" BENCH_PROFILE_OUT="$OUT" \
        npx tsx "$HERE/catchup-profile.mts" "$GAP" "$REPS"
    echo "cpuprofile -> $OUT"
    ;;
  *) echo "unknown command: $cmd" >&2; exit 1 ;;
esac
