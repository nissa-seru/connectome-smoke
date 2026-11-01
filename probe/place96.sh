#!/usr/bin/env bash
# MEASUREMENT ONLY (probe/wh-place96, acorn-1468; Oscar-1005 room-203 #317193, #317208): place context-manager
# mutants (lib/cm-fixture/mutants.json at 10cb728) over the whole-host harness's runs by run.mjs's own verdict. The
# harness is connectome-host's test/whole-host at the commit in probe/HARNESS, copied into connectome-host checked
# out beside this repository (on-gh --with), with probe/test/whole-host/run.mjs's measurement loop. context-manager
# fb4cf1046 is checked out beside it too, and packed plain and with each mutant in MUTANTS (ids, comma-separated).
# Candidates, in one process: plain (its records written over the copy's committed ones), plain again (each record
# must be the same), then each mutant. The release writes every checkpoint once, as in CI.
# Evidence: each candidate's run.json; plain-1's records; each mutant's records that differ; packs.json; times.
set -u
E=${ON_GH_EVIDENCE_DIR:-${ON_VPS_EVIDENCE_DIR:?}}
mkdir -p "$E"
HERE=$(pwd)
HOST=$(cd ../connectome-host && pwd)
CM=$(cd ../context-manager && pwd)
T=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
lap() { echo "$1 $2 $(( $(date +%s) - $3 )) s" | tee -a "$E/times.txt"; }
rm -rf "$HOST/test/whole-host" && cp -r probe/test/whole-host "$HOST/test/whole-host"
s=$(date +%s); (cd "$HOST" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error) > "$E/ci.log" 2>&1; lap ci $? $s
s=$(date +%s); node probe/build-packs.mjs "$CM" lib/cm-fixture/mutants.json "${MUTANTS:?}" "$T/packs" > "$E/packs.log" 2>&1; lap packs $? $s
cp "$T/packs/packs.json" "$E/" 2>/dev/null
node -e '
const [packsJson, out] = process.argv.slice(1);
const packs = JSON.parse(require("fs").readFileSync(packsJson, "utf-8"));
const plain = packs.find((p) => p.id === "plain").pack;
const list = [{ label: "plain-1", overlay: [plain], update: true }, { label: "plain-2", overlay: [plain] }, ...packs.filter((p) => p.id !== "plain" && p.pack).map((p) => ({ label: p.id, overlay: [p.pack] }))];
require("fs").writeFileSync(out, JSON.stringify(list));
' "$T/packs/packs.json" "$T/candidates.json"
s=$(date +%s); (cd "$HOST" && WH_CANDIDATES="$T/candidates.json" node test/whole-host/run.mjs ${RUNS:+--runs "$RUNS"} --workdir "$T/wh" --out "$T/out") > "$E/run.log" 2>&1; lap run $? $s
mkdir -p "$E/out"
for d in "$T/out"/*/; do
  c=$(basename "$d"); mkdir -p "$E/out/$c"; cp "$d/run.json" "$E/out/$c/" 2>/dev/null
  if [ "$c" = plain-1 ]; then for r in "$d"*/; do cp "$r"*.record "$E/out/$c/" 2>/dev/null; done
  else
    node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8"));
for (const r of j.results) if (r.record !== "same") console.log(r.run.replaceAll("/", "_"));
' "$d/run.json" 2>/dev/null | while read -r slug; do cp "$d$slug/$slug.record" "$E/out/$c/" 2>/dev/null; done
  fi
done
cat "$E/times.txt"
