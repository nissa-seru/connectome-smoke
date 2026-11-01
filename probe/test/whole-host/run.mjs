#!/usr/bin/env node
/**
 * Whole-host runs: what a change to connectome-host, or to a package under it, does to the
 * requests a resident's host sends. The host runs as residents run it, on a virtual clock,
 * against a stand-in for the provider (lib/strategies/).
 *
 *   node test/whole-host/run.mjs [--runs a,b] [--shard i/n] [--overlay <pack.tgz>,...] [--checkpoints <dir>] [--update-records] [--update-seconds] [--self-check] [--workdir <dir>] [--out <dir>]
 *
 * The runs are the workloads' (lib/strategies/workloads.mjs RUNS, CONFIGURATION/WORKLOAD[/VARIANT]).
 * `--runs` picks some of them.
 *
 * 1. The checkpoints. The release stack.json names (a tag of this repository, cloned from
 *    package.json's repository) is installed from its own lockfile, so every package under
 *    it is the version it was released with, and it writes each run's starting store from
 *    empty by running the run it continues (runOf's `from`, such as `H1/W2`). They're written
 *    at the start of every run of this script unless `--checkpoints` keeps them.
 * 2. The candidate: this checkout, with the stack its lockfile installs (`npm ci` first). With
 *    `--overlay`, a copy of the checkout is installed from its lockfile under the work
 *    directory, and each pack is installed over it, as a consumer upgrading that package
 *    would: a change to a package under the host runs at the host's lockfile with its head
 *    laid over. Every copy of an overlaid package must be the pack.
 * 3. Each run under the candidate, from a copy of its checkpoint: its workload's steps, judged
 *    by the harness's checks (lib/strategies/judge.mjs), check 2 among them for the products a
 *    workload declares (the continuation's), and its workload's own property as check 14, with
 *    the expected failures applied (expected-failures.json, report.mjs readExpected). Each run's
 *    evidence goes under `--out` by its id, `/` as `_`, and `run.json` sums them up.
 * 4. Each run's record (lib/record.mjs) is compared with the one committed in `records/`.
 *    One that differs, or isn't committed, fails the run, and the run's own is in its
 *    evidence. `--update-records` writes the run's records over the committed ones, for a
 *    change whose effect on what residents' requests carry is meant.
 *
 * `--checkpoints DIR` keeps the checkpoints in DIR and reuses one already there, so reruns, such
 * as chasing a record's difference or laying many candidates over one release, skip writing them.
 * Each is keyed by everything that determines it: the lane's code (laneVersion), the release
 * install's versions, the configuration as run and, for a workload's, the run it continues, so a
 * reuse never picks up a checkpoint something else wrote. Without it they're written in the work
 * directory at each run, as CI writes them.
 *
 * `--self-check` also runs each run without the harness's test module
 * (lib/strategies/module.mjs, which records every compile the host makes) and compares what the
 * stand-in received in the two, every request's whole body (system, tools with their
 * descriptions and schemas, messages): the same, once maskRunVarying has masked both, or the
 * run fails. The module observes and must change nothing a host sends, which every record
 * rests on; a pull request that changes it, or what runs inside the host's process with it,
 * runs this (.github/workflows/whole-host-self-check.yml).
 *
 * `--shard i/n` runs the i-th of n shares of the runs, for CI's jobs (.github/workflows/whole-host.yml),
 * balanced by the seconds stack.json records for each run and each checkpoint, as measured on
 * GitHub's ubuntu24 runners: each run, longest first, goes to the share it adds least to, a share
 * paying for a checkpoint once however many of its runs continue it (a run or checkpoint with no
 * recorded seconds counts as the median of those recorded). `run.json` gives every run's and
 * checkpoint's seconds, and `--update-seconds` writes this run's into stack.json; refresh them,
 * from a run of all of them on such a runner, when a run is added or the shares drift apart.
 *
 * Moving to a newer release is a change of its own: its tag in stack.json.
 *
 * Exit 0: every run passed and every record matched (or was updated) · 1: a run flagged something or lacked a product, a record differs or isn't
 * committed, or a self-check found the module changed what the stand-in received · 2: a run
 * couldn't run.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, sh } from './lib/common.mjs';
import { EPOCH, EXPECTED_FAILURES, KEY_PACKAGES, asRun, laneVersion, stackVersions } from './lib/strategies/lane.mjs';
import { hostFacts, runScript } from './lib/strategies/driver.mjs';
import { startStandin } from './lib/strategies/standin.mjs';
import { judge } from './lib/strategies/judge.mjs';
import { perCheckReport, readExpected } from './lib/strategies/report.mjs';
import { RUNS, runOf } from './lib/strategies/workloads.mjs';
import { configurations } from './lib/strategies/script.mjs';
import { renderRecord } from './lib/record.mjs';
import { shares } from './lib/shares.mjs';
import { maskRunVarying } from './lib/strategies/compare.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const LABEL = '[whole-host]';
const RECORDS = join(HERE, 'records');
/**
 * The candidate's stack as a record names it: each package by its version alone. What names
 * its content (the host's source hash, a laid-over pack's integrity, a git commit) changes
 * with the change under test, and would make every run's record differ from the committed
 * one at its header whatever the change did; run.json keeps it.
 */
const versionsOnly = (versions) => Object.fromEntries(Object.entries(versions).map(([k, v]) => [k, String(v).replace(/ \((?:source|git) [0-9a-f]+\)$| \(sha512-[^)]*\)$/, '')]));

/**
 * Whether two runs' stand-ins received the same requests: every request's body as the stand-in
 * saved it (`<id>.json` in each directory, in request order), once maskRunVarying has masked
 * both. Resolves `{ outcome: 'same', requests }` or `{ outcome: 'differs', at, detail }`, `at`
 * the first request that differs and `detail` the first top-level field of its body that does.
 */
function sameRequests(withDir, withoutDir) {
  const read = (dir) => (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => /^r\d+\.json$/.test(f))
    .sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)))
    .map((f) => maskRunVarying(JSON.parse(readFileSync(join(dir, f), 'utf-8'))));
  const [a, b] = [read(withDir), read(withoutDir)];
  if (!a.length) return { outcome: 'differs', at: 0, detail: `no request bodies were saved in ${withDir}` };
  const at = a.findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(b[i]));
  if (at === -1 && a.length === b.length) return { outcome: 'same', requests: a.length };
  const i = at === -1 ? Math.min(a.length, b.length) : at;
  const field = a[i] && b[i] ? Object.keys({ ...a[i], ...b[i] }).find((k) => JSON.stringify(a[i][k]) !== JSON.stringify(b[i][k])) : null;
  return { outcome: 'differs', at: i, detail: `${a.length} requests with the module, ${b.length} without${field ? `; its ${field} differs` : ''}` };
}

const { opt, flag } = parseArgs(process.argv.slice(2));
const fail = (message) => { console.error(`${LABEL} ${message}`); process.exit(2); };
const stack = JSON.parse(readFileSync(join(HERE, 'stack.json'), 'utf-8'));
const all = configurations();
const everyRun = RUNS;
const listed = String(opt('runs', everyRun.join(','))).split(',').map((s) => s.trim()).filter(Boolean);
const unknown = listed.filter((n) => !everyRun.includes(n));
if (unknown.length) fail(`no run ${unknown.join(', ')}; there are ${everyRun.join(', ')}`);
const shard = /^(\d+)\/(\d+)$/.exec(opt('shard', '1/1'));
if (!shard || +shard[1] < 1 || +shard[1] > +shard[2]) fail(`--shard takes i/n with 1 <= i <= n, not ${opt('shard')}`);
/** The checkpoint a run continues: its runOf `from` (null from empty). */
const checkpointKey = (id) => runOf(id, all, {}).from;
const share = shares(listed, +shard[2], stack.seconds, checkpointKey)[+shard[1] - 1];
const names = share.ids;
if (!names.length) { console.log(`${LABEL} shard ${shard[0]} holds none of ${listed.join(', ')}`); process.exit(0); }
if (+shard[2] > 1) console.log(`${LABEL} shard ${shard[0]}: ${names.length} of ${listed.length} runs, about ${share.seconds} s by stack.json's seconds`);
const work = opt('workdir') ? resolve(opt('workdir')) : mkdtempSync(join(tmpdir(), 'whole-host-'));
mkdirSync(work, { recursive: true });
const out = resolve(opt('out', join(work, 'out')));
mkdirSync(out, { recursive: true });
const lane = laneVersion();
const checkpointsDir = opt('checkpoints') ? resolve(opt('checkpoints')) : null;
const npmCi = (cwd) => sh('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd, timeout: 900_000 });
const named = (versions) => Object.entries(versions).map(([k, v]) => `${k.replace('@animalabs/', '')}@${v}`).join(' ');

/** The release stack.json names: this repository at its tag, cloned from package.json's repository, installed from its lockfile. */
function installRelease(dir) {
  const repository = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).repository?.url ?? '').replace(/^git\+/, '');
  if (!repository) fail('package.json names no repository to clone the release from');
  sh('git', ['clone', '--quiet', '--depth', '1', '--branch', stack.release, '--', repository, dir], { timeout: 300_000 });
  npmCi(dir);
  return { hostDir: dir, installDir: dir, versions: stackVersions(dir, { installDir: dir }) };
}

/** The packs `--overlay` names, each read for its package name and integrity. */
function readPacks(paths) {
  return paths.map((p) => {
    let name;
    try { name = JSON.parse(sh('tar', ['-xzOf', p, 'package/package.json']).stdout).name; } catch (e) { fail(`the overlay ${p} couldn't be read as a packed release: ${e.message}`); }
    if (!KEY_PACKAGES.includes(name)) fail(`the overlay ${p} is ${name}; overlay one of ${KEY_PACKAGES.join(', ')}`);
    return { path: p, name, integrity: `sha512-${createHash('sha512').update(readFileSync(p)).digest('base64')}` };
  });
}

/** The candidate: this checkout as installed, or a copy of it with the packs laid over. */
function installCandidate(packs, dir) {
  if (!packs.length) {
    if (!existsSync(join(ROOT, 'node_modules'))) fail(`there's no install at ${ROOT}; run npm ci first`);
    return { hostDir: ROOT, installDir: ROOT, versions: stackVersions(ROOT, { installDir: ROOT }) };
  }
  mkdirSync(dir, { recursive: true });
  sh('sh', ['-c', 'tar -C "$ROOT" --exclude=./node_modules --exclude=./.git -cf - . | tar -x -C "$DIR"'], { env: { ROOT, DIR: dir } });
  npmCi(dir);
  sh('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', ...packs.map((p) => p.path)], { cwd: dir, timeout: 900_000 });
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf-8')).packages ?? {};
  for (const { path, name, integrity } of packs) {
    const copies = Object.entries(lock).filter(([at]) => at.endsWith(`node_modules/${name}`));
    if (!copies.length || copies.some(([, l]) => l.integrity !== integrity)) {
      fail(`the overlay ${path} didn't replace every copy of ${name}: ${copies.map(([at, l]) => `${at} from ${l.resolved}`).join('; ')}`);
    }
  }
  return { hostDir: dir, installDir: dir, versions: stackVersions(dir, { installDir: dir }) };
}

console.log(`${LABEL} lane ${lane.slice(0, 12)} · release ${stack.release} · work ${work}`);
let release;
try { release = installRelease(join(work, 'release')); } catch (e) { fail(`installing ${stack.release} failed: ${e.message}`); }
console.log(`${LABEL} checkpoints from ${named(release.versions)}`);

const packs = readPacks(String(opt('overlay', '')).split(',').map((s) => s.trim()).filter(Boolean).map((p) => resolve(p)));
let candidate;
try { candidate = installCandidate(packs, join(work, 'candidate')); } catch (e) { fail(`installing the candidate failed: ${e.message}`); }
console.log(`${LABEL} candidate ${named(candidate.versions)}${packs.length ? `, with ${packs.map((p) => p.name).join(', ')} laid over` : ''}`);

const expected = (() => {
  try { return readExpected(EXPECTED_FAILURES, everyRun); } catch (e) { return fail(`the expected failures couldn't be read: ${e.message}`); }
})();
const slug = (id) => id.replaceAll('/', '_');
const readJsonLines = (path) => (existsSync(path) ? readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/**
 * One drive of a workload's run (workloads.mjs runOf) under the host at `side`, from `storeDir`
 * (a checkpoint's copy, or empty) at `epoch`: its log and its stand-in's records (and raw bodies
 * in `rawDir`) kept in `dir`, the evidence, and the host's own work in `scratch`.
 */
async function drive(job, side, { storeDir, epoch, dir, scratch = dir, rawDir = null }) {
  const facts = hostFacts({ hostDir: side.hostDir, configuration: job.configuration });
  const configuration = asRun(job.configuration, facts);
  mkdirSync(dir, { recursive: true });
  mkdirSync(storeDir, { recursive: true });
  const standin = await startStandin({ configuration, ...job.standin, ...(rawDir ? { rawDir } : {}) });
  const logPath = join(dir, 'log.jsonl');
  const steps = job.steps();
  let run;
  let records;
  try {
    run = await runScript({ steps, configuration, standin, hostDir: side.hostDir, facts, work: join(scratch, 'work'), storeDir, epoch, logPath });
  } finally {
    records = await standin.close();
  }
  writeFileSync(join(dir, 'records.json'), JSON.stringify(records));
  return { run, records, log: readJsonLines(logPath), steps, configuration };
}

// Each workload checkpoint (runOf's `from`), written once per run of this script by the release, from empty.
const checkpoints = new Map();
// Seconds each checkpoint and each run took (run.json), and the checkpoints' share of the time running.
const seconds = { runs: {}, checkpoints: {} };
let checkpointTime = 0;
const since = (t) => Math.round((performance.now() - t) / 100) / 10;
async function checkpointOf(from) {
  if (!checkpoints.has(from)) {
    const t = performance.now();
    const job = runOf(from, all, hostFacts({ hostDir: release.hostDir, configuration: all[from.split('/')[0]] }));
    // Kept under --checkpoints by everything that determines it; else written in this run's work directory.
    const key = createHash('sha256').update(JSON.stringify({ lane, release: release.versions, from, configuration: job.configuration, epoch: EPOCH })).digest('hex').slice(0, 16);
    const kept = checkpointsDir ? join(checkpointsDir, 'workloads', `${slug(from)}-${key}`) : null;
    if (kept && existsSync(join(kept, 'checkpoint.json'))) {
      checkpoints.set(from, { ...JSON.parse(readFileSync(join(kept, 'checkpoint.json'), 'utf-8')), storeDir: join(kept, 'store') });
      console.log(`${LABEL} checkpoint ${from}: reused ${kept}`);
    } else {
      const dir = kept ? `${kept}.writing-${process.pid}` : join(work, 'checkpoints', slug(from));
      rmSync(dir, { recursive: true, force: true });
      const d = await drive(job, release, { storeDir: join(dir, 'store'), epoch: EPOCH, dir });
      if (!d.run.ok) checkpoints.set(from, { failed: d.run.failure?.reason ?? 'no reason given' });
      else if (!kept) checkpoints.set(from, { storeDir: join(dir, 'store'), clockEnd: d.run.clockEnd });
      else {
        writeFileSync(join(dir, 'checkpoint.json'), `${JSON.stringify({ from, key, clockEnd: d.run.clockEnd })}\n`);
        // A writer that lost the race to another keeps the other's, which has the same key.
        try { renameSync(dir, kept); } catch { rmSync(dir, { recursive: true, force: true }); }
        checkpoints.set(from, { ...JSON.parse(readFileSync(join(kept, 'checkpoint.json'), 'utf-8')), storeDir: join(kept, 'store') });
      }
      seconds.checkpoints[from] = since(t);
      checkpointTime += seconds.checkpoints[from];
    }
  }
  return checkpoints.get(from);
}

/**
 * A workload's run: its checkpoint, if it has one, copied, then the run under the candidate,
 * judged by the harness's checks and by its workload's own property (check 14), with the
 * expected failures applied. `harnessModule` false runs it without the test module, for the
 * self-check.
 */
async function workloadRun(id, { harnessModule = true, rawDir = null, dir }) {
  const job = runOf(id, all, hostFacts({ hostDir: candidate.hostDir, configuration: all[id.split('/')[0]] }));
  if (!harnessModule) job.configuration = { ...job.configuration, harnessModule: false };
  let epoch = EPOCH;
  // The run's store, its copies and the host's work stay in the work directory; only what judges
  // the run (log, records, report, record) goes to the evidence.
  const scratch = join(work, 'runs', basename(dir));
  const storeDir = join(scratch, 'store');
  if (job.from) {
    const cp = await checkpointOf(job.from);
    if (cp.failed) return { outcome: 'couldnt-run', reason: `its checkpoint ${job.from} failed: ${cp.failed}` };
    cpSync(cp.storeDir, storeDir, { recursive: true });
    epoch = cp.clockEnd + 24 * 60 * 60_000;
  }
  let d;
  try { d = await drive(job, candidate, { storeDir, epoch, dir, scratch, rawDir }); } catch (e) { return { outcome: 'couldnt-run', reason: String(e?.message ?? e).slice(0, 2000) }; }
  const copy = join(scratch, 'judged-store');
  cpSync(storeDir, copy, { recursive: true });
  const sessions = existsSync(join(copy, 'sessions')) ? readdirSync(join(copy, 'sessions')).map((s) => join(copy, 'sessions', s)) : [];
  let judged;
  try {
    judged = await judge({ records: d.records, log: d.log, script: d.steps, storeCopy: sessions[0] ?? null, configuration: d.configuration, installDir: candidate.installDir, run: d.run, declared: job.products });
  } catch (e) { return { outcome: 'couldnt-run', reason: `the run couldn't be judged: ${String(e?.message ?? e).slice(0, 2000)}` }; }
  const breaches = d.run.ok ? job.check({ log: d.log, records: d.records }) : [];
  // What the workload makes happen by design and its property judges (runOf's `owns`, each
  // `{ check, what }`), such as the alert a refused merge raises, isn't counted again here.
  const owns = (f) => (job.owns ?? []).some((o) => o.check === f.check && (o.what === undefined || o.what === f.what));
  const judgedFlags = judged.flags.filter((f) => !owns(f));
  const owned = judged.flags.length - judgedFlags.length;
  const flags = [...judgedFlags, ...breaches.map((b) => ({ check: 14, step: b.step ?? 'the run', ...(b.what ? { what: b.what } : {}), message: `${job.workload}'s property: ${b.message}` }))];
  // The property's count joins the run's: a property that says how many it judged and
  // judged none, on a run that completed, couldn't judge it.
  const counts = [...(judged.judged ?? []), ...(typeof breaches.judged === 'number' ? [{ check: 14, name: 'property', judged: breaches.judged }] : [])];
  if (d.run.ok && breaches.judged === 0 && !breaches.length) flags.push({ check: 14, step: 'the run', what: 'judged-none:property', message: `couldn't judge: ${job.workload}'s property judged nothing, though the run completed` });
  const report = perCheckReport({ configuration: { name: id }, candidate: { flags, missing: [], notes: [...(judged.notes ?? []), ...(owned ? [`${owned} flag(s) are ${job.workload}'s by design, judged by its property (runOf owns)`] : [])], headroom: judged.headroom, judged: counts }, expected });
  writeFileSync(join(dir, 'report.txt'), `${report.lines.join('\n')}\n`);
  return {
    outcome: report.verdict === 'pass' ? 'pass' : report.verdict,
    failures: report.flags,
    lines: report.lines,
    log: d.log,
    records: d.records,
    end: { ok: d.run.ok, reason: d.run.failure?.reason },
    from: job.from ?? 'empty',
  };
}


const results = [];
for (const id of names) {
  const dir = join(out, slug(id));
  const t = performance.now();
  const before = checkpointTime;
  const r = await workloadRun(id, { dir, rawDir: flag('self-check') ? join(dir, 'raw') : null });
  seconds.runs[id] = Math.round((since(t) - (checkpointTime - before)) * 10) / 10;
  console.log((r.lines?.length ? r.lines : [`${id}: couldn't run: ${r.reason}`]).join('\n'));
  let record = null;
  // A record matches whatever the module recorded, nothing included: a run that sent agent
  // requests with no request compile line in its log, the module on, can't be judged by it.
  if (r.outcome !== 'couldnt-run' && r.records.some((x) => x.kind === 'agent') && !r.log.some((e) => e.kind === 'compiles' && (e.lines ?? []).some((l) => l.kind === 'request'))) {
    Object.assign(r, { outcome: 'couldnt-run', reason: 'the run sent agent requests, and its log holds no request compile line from the test module, so its record would judge nothing' });
    console.log(`${LABEL} ${id}: couldn't run: ${r.reason}`);
  }
  if (r.outcome !== 'couldnt-run') {
    const text = renderRecord({
      header: { configuration: id, release: { tag: stack.release, versions: release.versions }, from: r.from, candidate: { versions: versionsOnly(candidate.versions) } },
      log: r.log, records: r.records, end: r.end,
    });
    writeFileSync(join(dir, `${slug(id)}.record`), text);
    const committed = join(RECORDS, `${slug(id)}.record`);
    if (flag('update-records')) { mkdirSync(RECORDS, { recursive: true }); writeFileSync(committed, text); record = 'updated'; }
    else record = existsSync(committed) && readFileSync(committed, 'utf-8') === text ? 'same' : existsSync(committed) ? 'differs' : 'missing';
    if (record === 'differs' || record === 'missing') console.log(`${LABEL} ${id}: the record ${record === 'missing' ? 'isn\'t committed' : 'differs from the committed one'}; the run's is ${join(dir, `${slug(id)}.record`)}`);
  }
  let selfCheck = null;
  if (flag('self-check') && r.outcome !== 'couldnt-run') {
    const withoutDir = join(out, `${slug(id)}.without-module`);
    const without = await workloadRun(id, { harnessModule: false, dir: withoutDir, rawDir: join(withoutDir, 'raw') });
    const raw = (d) => join(d, 'raw');
    selfCheck = without.outcome === 'couldnt-run' ? { outcome: 'couldnt-run', reason: without.reason } : sameRequests(raw(dir), raw(withoutDir));
    console.log(`${LABEL} ${id}: self-check: ${selfCheck.outcome === 'same' ? `the stand-in received the same ${selfCheck.requests} requests without the test module` : selfCheck.outcome === 'couldnt-run' ? `the run without the test module couldn't run: ${selfCheck.reason}` : `request ${selfCheck.at} differs without the test module: ${selfCheck.detail}`}`);
  }
  results.push({ run: id, outcome: r.outcome, reason: r.reason, failures: r.failures, record, ...(selfCheck ? { selfCheck } : {}) });
}
writeFileSync(join(out, 'run.json'), JSON.stringify({ lane, release: { tag: stack.release, versions: release.versions }, candidate: { versions: candidate.versions, overlays: packs }, seconds, results }, null, 1));
if (flag('update-seconds')) {
  const merged = { runs: { ...stack.seconds?.runs, ...seconds.runs }, checkpoints: { ...stack.seconds?.checkpoints, ...seconds.checkpoints } };
  writeFileSync(join(HERE, 'stack.json'), `${JSON.stringify({ ...stack, seconds: merged }, null, 2)}\n`);
  console.log(`${LABEL} wrote ${Object.keys(seconds.runs).length} runs' and ${Object.keys(seconds.checkpoints).length} checkpoints' seconds into stack.json`);
}
process.exit(results.some((r) => r.outcome === 'couldnt-run' || r.selfCheck?.outcome === 'couldnt-run') ? 2 : results.every((r) => r.outcome === 'pass' && (r.record === 'same' || r.record === 'updated') && (!r.selfCheck || r.selfCheck.outcome === 'same')) ? 0 : 1);
