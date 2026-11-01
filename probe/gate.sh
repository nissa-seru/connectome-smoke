#!/usr/bin/env bash
# Measurement only (acorn-1468): the whole-host harness (connectome-host's test/whole-host, copied here at the
# commit named in probe/HARNESS) run on a GitHub runner against connectome-host checked out beside this repository
# (on-gh --with), as its CI jobs would: npm ci in the host, then the unit tests (UNIT set, CI's unit job) or run.mjs over the runs given (RUNS, default all),
# sharded by SHARD (i/n, default 1/1). Evidence: each run's records and run.json.
set -u
E=${ON_GH_EVIDENCE_DIR:-${ON_VPS_EVIDENCE_DIR:?}}
mkdir -p "$E"
HOST=$(cd ../connectome-host && pwd)
rm -rf "$HOST/test/whole-host" && cp -r probe/test/whole-host "$HOST/test/whole-host"
cd "$HOST"
s=$(date +%s); npm ci --ignore-scripts --no-audit --no-fund --loglevel=error > "$E/ci.log" 2>&1; echo "ci $? $(( $(date +%s) - s )) s" >> "$E/times.txt"
T=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
if [ -n "${UNIT:-}" ]; then s=$(date +%s); node --test test/whole-host/unit/*.unit.mjs > "$E/unit.txt" 2>&1; echo "unit $? $(( $(date +%s) - s )) s" >> "$E/times.txt"; cat "$E/times.txt"; exit 0; fi
s=$(date +%s); node test/whole-host/run.mjs --shard "${SHARD:-1/1}" ${RUNS:+--runs "$RUNS"} --workdir "$T/wh" --out "$T/out" > "$E/run.log" 2>&1; echo "run $? $(( $(date +%s) - s )) s" >> "$E/times.txt"
# What comes back is what judges: each run's record and report, and run.json (logs stay on the runner).
mkdir -p "$E/out" && (cd "$T/out" && cp run.json "$E/out/" && for d in */; do mkdir -p "$E/out/$d"; cp "$d"*.record "$d"report.txt "$E/out/$d" 2>/dev/null; done)
cat "$E/times.txt"
