#!/usr/bin/env bash
# MEASUREMENT ONLY (probe/wh-place96, acorn-1468; Oscar-1005 room-203 #317193, #317208): place context-manager
# mutants (lib/cm-fixture/mutants.json at 10cb728) over the whole-host harness's runs by run.mjs's own verdict, with
# the harness as it is: connectome-host's test/whole-host at the commit in probe/HARNESS2, unmodified, copied into
# connectome-host checked out beside this repository (on-gh --with). context-manager fb4cf1046, checked out beside it
# too, is packed plain and with each mutant in MUTANTS (ids, comma-separated). One --checkpoints DIR for the job, so
# the release writes every checkpoint once, as in CI. Candidates: plain (--update-records over the copy's committed
# records), then plain again (each record must be the same) and the mutants, PAR at a time, each in its own workdir.
# Evidence: each candidate's run.json; plain-1's records; each mutant's records that differ; packs.json; times.
set -u
E=${ON_GH_EVIDENCE_DIR:-${ON_VPS_EVIDENCE_DIR:?}}
mkdir -p "$E"
HOST=$(cd ../connectome-host && pwd)
CM=$(cd ../context-manager && pwd)
T=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
PAR=${PAR:-3}
lap() { echo "$1 $2 $(( $(date +%s) - $3 )) s" | tee -a "$E/times.txt"; }
nproc | sed 's/^/cpus /' | tee -a "$E/times.txt"
df -h / "$T" > "$E/disk.txt" 2>&1
rm -rf "$HOST/test/whole-host" && cp -r probe/test2/whole-host "$HOST/test/whole-host"
s=$(date +%s); (cd "$HOST" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error) > "$E/ci.log" 2>&1; lap ci $? $s
s=$(date +%s); node probe/build-packs.mjs "$CM" lib/cm-fixture/mutants.json "${MUTANTS:?}" "$T/packs" > "$E/packs.log" 2>&1; lap packs $? $s
cp "$T/packs/packs.json" "$E/" 2>/dev/null
one() { # LABEL PACK [--update-records]
  local s; s=$(date +%s)
  (cd "$HOST" && node test/whole-host/run.mjs ${RUNS:+--runs "$RUNS"} --overlay "$2" --checkpoints "$T/cp" --workdir "$T/wh-$1" --out "$T/out/$1" ${3:-}) > "$E/run-$1.log" 2>&1
  local rc=$?; echo "candidate-$1 workdir $(du -sh "$T/wh-$1" 2>/dev/null | cut -f1), out $(du -sh "$T/out/$1" 2>/dev/null | cut -f1), free $(df -h --output=avail "$T" | tail -1)" >> "$E/disk.txt"; rm -rf "$T/wh-$1"; lap "candidate-$1" $rc $s
}
export -f one lap; export HOST T E RUNS
PLAIN=$T/packs/plain.tgz
one plain-1 "$PLAIN" --update-records
# plain-2 joins the pool: it needs only plain-1's records.
{ echo "plain-2 $PLAIN"; node -e 'for (const p of JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8"))) if (p.id !== "plain" && p.pack) console.log(p.id, p.pack);' "$T/packs/packs.json"; } > "$T/mutants.txt"
s=$(date +%s); xargs -P "$PAR" -L 1 bash -c 'one "$0" "$1"' < "$T/mutants.txt"; lap mutants 0 $s
mkdir -p "$E/out"
for d in "$T/out"/*/; do
  c=$(basename "$d"); mkdir -p "$E/out/$c"; cp "$d/run.json" "$E/out/$c/" 2>/dev/null
  # Beside the record: each run's requests to the stand-in as a multiset of their kinds, agents and message digests
  # (a W9 fork's own requests at step 7f left out: its synthetic call id carries a fresh UUID), so a mutant that
  # moves what the stand-in received without moving the record shows as such.
  node -e '
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const dir = process.argv[1], out = {};
for (const run of fs.readdirSync(dir)) {
  const f = path.join(dir, run, "records.json"), g = path.join(dir, run, "candidate.records.json");
  const p = fs.existsSync(f) ? f : fs.existsSync(g) ? g : null;
  if (!p) continue;
  const recs = JSON.parse(fs.readFileSync(p, "utf-8"));
  const items = recs.filter((r) => r.agent !== "sub" || !/\.7f$/.test(String(r.step))).map((r) => JSON.stringify([r.kind, r.agent ?? null, (r.messages ?? []).map((m) => m.digest), r.answer?.shape ?? null])).sort();
  out[run] = crypto.createHash("sha256").update(JSON.stringify(items)).digest("hex").slice(0, 16);
}
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
' "$d" "$E/out/$c/requests.json"
  if [ "$c" = plain-1 ]; then for r in "$d"*/; do cp "$r"*.record "$E/out/$c/" 2>/dev/null; done
  else
    node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8"));
for (const r of j.results) if (r.record !== "same") console.log(r.run.replaceAll("/", "_"));
' "$d/run.json" 2>/dev/null | while read -r slug; do cp "$d$slug/$slug.record" "$E/out/$c/" 2>/dev/null; done
  fi
done
cat "$E/times.txt"
