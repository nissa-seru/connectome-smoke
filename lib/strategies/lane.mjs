import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { sh } from '../common.mjs';
import { installSpecs } from '../cache-write.mjs';
import { hostFacts, recipeHash, runScript } from './driver.mjs';
import { entryKey, findEntry, writeEntry } from './writer.mjs';
import { startStandin } from './standin.mjs';
import { CHANNEL, continuation, extend, prefix, products } from './script.mjs';
import { declaredProducts } from './checks.mjs';
import { perCheckReport } from './report.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** What the lane's version covers: every file that shapes a cached store or its judging. */
export const LANE_PATHS = ['lib/strategies', 'lib/common.mjs'];

/** The stack packages a store's key names, as the host's install resolves them. */
export const KEY_PACKAGES = ['connectome-host', 'agent-framework', 'context-manager', 'membrane', 'chronicle'].map((p) => `@animalabs/${p}`);

/** Where a write's prefix starts, in virtual time. */
export const EPOCH = Date.UTC(2026, 0, 5, 9, 0, 0);

const DAY = 24 * 60 * 60_000;

/** Beth-2389's judge (judge.mjs) and the length trial's turns (script.mjs, TRIAL), loaded when first needed. */
const judging = async () => (await import('./judge.mjs')).judge;
const trialTurns = async () => (await import('./script.mjs')).TRIAL;

/**
 * The lane's version: the sha256 of every file under LANE_PATHS, each with its path
 * relative to the repository root, in path order.
 */
export function laneVersion(root = ROOT) {
  const files = [];
  const walk = (rel) => {
    const abs = join(root, rel);
    if (statSync(abs).isDirectory()) for (const name of readdirSync(abs)) walk(join(rel, name));
    else files.push(rel);
  };
  for (const p of LANE_PATHS) walk(p);
  const h = createHash('sha256');
  for (const rel of files.sort()) {
    const bytes = readFileSync(join(root, rel));
    h.update(`${rel}\0${bytes.length}\0`).update(bytes);
  }
  return h.digest('hex');
}

/** The versions a store's key names: each KEY_PACKAGES as resolved from `hostDir` upward, and bun's. */
export function stackVersions(hostDir) {
  const out = {};
  for (const name of KEY_PACKAGES) {
    let found = null;
    if (name === '@animalabs/connectome-host') found = join(hostDir, 'package.json');
    else {
      for (let dir = hostDir; ; dir = dirname(dir)) {
        const pj = join(dir, 'node_modules', name, 'package.json');
        if (existsSync(pj)) { found = pj; break; }
        if (dirname(dir) === dir) break;
      }
    }
    out[name] = found ? JSON.parse(readFileSync(found, 'utf-8')).version : null;
  }
  const bun = spawnSync('bun', ['--version'], { encoding: 'utf-8' });
  out.bun = bun.status === 0 ? bun.stdout.trim() : null;
  return out;
}

/** The cache root: the one given, or ~/.cache/connectome-smoke/strategies, made if missing. */
export function cacheRoot(given) {
  const root = given ?? join(homedir(), '.cache', 'connectome-smoke', 'strategies');
  mkdirSync(root, { recursive: true });
  return root;
}

/**
 * After a write: the newest two complete entries for `lane` and `configurationName` stay
 * and older ones go, and so do complete entries of other lanes written more than a day
 * before `now`. Anything without a complete entry.json, and the locks, stay. Returns the
 * removed entries' directories.
 */
export function pruneCache({ cacheRoot: root, lane, configurationName, now = Date.now() }) {
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => {
      const dir = join(root, d.name);
      try { return { dir, entry: JSON.parse(readFileSync(join(dir, 'entry.json'), 'utf-8')) }; } catch { return null; }
    })
    .filter((x) => x?.entry?.complete === true);
  const removed = [];
  const mine = entries
    .filter(({ entry }) => entry.lane === lane && entry.configurationName === configurationName)
    .sort((a, b) => b.entry.writtenAt.localeCompare(a.entry.writtenAt));
  for (const { dir } of mine.slice(2)) removed.push(dir);
  for (const { dir, entry } of entries) {
    if (entry.lane !== lane && now - Date.parse(entry.writtenAt) > DAY) removed.push(dir);
  }
  for (const dir of removed) rmSync(dir, { recursive: true, force: true });
  return removed;
}

/**
 * Install the host as a consumer would, as cache-write's lane installs one: from `spec`, a
 * version or dist-tag of connectome-host (`latest` when not given), or a packed release, a
 * path or anything else npm takes as given (lib/cache-write.mjs, installSpecs), into `dir`.
 * Returns its host directory, the directory the stack resolves from, and the versions.
 */
export function installStack({ spec = 'latest', dir }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'strategies-stack', private: true, version: '0.0.0', type: 'module' }));
  const local = installSpecs({ candidate: spec, startedAt: new Date().toISOString() }).candidate.spec;
  const target = /^[A-Za-z0-9.^~<>=*+-]+$/.test(local) && !/\.(tgz|tar\.gz)$/.test(local) ? `@animalabs/connectome-host@${local}` : local;
  sh('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', '--global=false', '--location=project', `--prefix=${dir}`, target], { cwd: dir, timeout: 900_000 });
  const hostDir = join(dir, 'node_modules', '@animalabs', 'connectome-host');
  return { hostDir, installDir: dir, versions: stackVersions(hostDir) };
}

const readLog = (p) => (existsSync(p) ? readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const slug = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '-');
const load1 = () => Math.round(loadavg()[0] * 10) / 10;

/** A copy of a run's last store copy, its first session directory, for judging. */
const sessionOf = (copy) => copy?.sessions?.[0] ?? null;

/**
 * Write the deep store for `configuration` under the cache root from the host at `hostDir`
 * (its stack resolving from `installDir`), unless a complete entry for its key is there by
 * the time this writer holds the key's lock. `judge` is Beth-2389's: it judges a run from
 * what it recorded, and its flags over the written prefix are the write's hard checks.
 * `trial` is the length trial's `{ min, step, bound }`, in prefix turns. Left out, `judge` is
 * judge.mjs's and `trial` script.mjs's TRIAL.
 * Resolves the writer's `{ dir, entry, written }` with the pruned entries.
 */
export async function writeStore({ cacheRoot: root, configuration, hostDir, installDir, work, judge, trial: lengths, lane = laneVersion(), lockWaitMs }) {
  judge ??= await judging();
  lengths ??= await trialTurns();
  mkdirSync(work, { recursive: true });
  const facts = hostFacts({ hostDir, configuration });
  const keyParts = {
    lane,
    configurationName: configuration.name,
    recipeHash: recipeHash({ configuration, facts, channels: [CHANNEL] }),
    versions: stackVersions(hostDir),
  };
  const key = entryKey(keyParts);
  // One stand-in serves the whole prefix, so its summary numbers run on across the
  // extensions, as one store's do.
  const standin = await startStandin({ configuration, phase: 'P' });
  const logs = [];
  const steps = [];
  let records = null;
  try {
    const runSteps = async ({ steps: these, storeDir, epoch, label }) => {
      const logPath = join(work, `${slug(label)}.log.jsonl`);
      logs.push(logPath);
      steps.push(...these);
      return runScript({ steps: these, configuration, standin, hostDir, facts, work: join(work, slug(label)), storeDir, epoch, logPath });
    };
    const trial = async ({ dataDir, epoch }) => {
      const turns = steps.filter((s) => s.kind === 'channel').length;
      const side = await runSide({ storeDir: dataDir, epoch, configuration, hostDir, facts, work: join(work, `trial-${turns}`) });
      if (!side.run.ok) throw new Error(`the trial's continuation at ${turns} turns failed: ${side.run.failure?.reason ?? 'no reason given'}`);
      return { missing: declaredProducts(side.records, side.steps, products(configuration)) };
    };
    const hardChecks = async ({ dataDir }) => {
      records ??= await standin.close();
      const copy = join(work, 'hard-checks-store');
      rmSync(copy, { recursive: true, force: true });
      cpSync(dataDir, copy, { recursive: true });
      const sessions = existsSync(join(copy, 'sessions')) ? readdirSync(join(copy, 'sessions')).map((id) => join(copy, 'sessions', id)) : [];
      const log = logs.flatMap(readLog);
      return judge({ records, log, script: steps, storeCopy: sessions[0] ?? null, configuration, installDir, run: { ok: true, failure: null } });
    };
    const script = { prefix, extend, min: lengths.min, step: lengths.step, bound: lengths.bound };
    const result = await writeEntry({ cacheRoot: root, key, keyParts, script, runSteps, trial, hardChecks, epoch: EPOCH, work: join(work, 'writer'), lockWaitMs });
    const pruned = pruneCache({ cacheRoot: root, lane, configurationName: configuration.name });
    return { ...result, pruned };
  } finally {
    if (!records) await standin.close();
  }
}

/**
 * The names a check's failures go by, each once and the same from run to run, so a
 * known-red entry keeps matching: a flag as `check N at STEP`, a missing product as
 * `check 2 at SEGMENT: PRODUCT`. `counted` is what the per-check report counts against the
 * candidate (report.mjs, perCheckReport): `invalid`, `flags` and `missing`.
 */
export function failureNames(counted) {
  const names = [
    ...[...counted.invalid, ...counted.flags].map((f) => `check ${f.check} at ${f.step ?? 'the run'}`),
    ...counted.missing.map((m) => `check 2 at ${m.segment}: ${m.name}`),
  ];
  return [...new Set(names)];
}

/** One continuation on the store at `storeDir`, from virtual time `epoch`, under the host at `hostDir`. */
async function runSide({ storeDir, epoch, configuration, hostDir, facts, work, rawDir = null }) {
  const steps = continuation();
  const standin = await startStandin({ configuration, phase: 'C', rawDir });
  const logPath = join(work, 'run.log.jsonl');
  mkdirSync(work, { recursive: true });
  const t = performance.now();
  const loadAt = load1();
  const run = await runScript({ steps, configuration, standin, hostDir, facts, work, storeDir, epoch, logPath });
  const runMs = Math.round(performance.now() - t);
  const records = await standin.close();
  return { run, records, log: readLog(logPath), logPath, steps, timing: { runMs, load: [loadAt, load1()] } };
}

/**
 * The per-check run: continue the newest cached store for `configuration` under the host
 * at `hostDir` (its stack resolving from `installDir`), and judge it. With no entry for
 * this lane version, write one from the stack's last releases first (`fellBack`). When the
 * candidate fails something and `base` is given, `base(runBase)` runs the same
 * continuation under the base: it calls `runBase({ hostDir, installDir })` with its tree
 * in place and returns what that resolves.
 *
 * Resolves `{ outcome, reason, entry, fellBack, candidate, base, report, failures, timing }`,
 * its outcome `pass`, the report's verdict when it isn't a pass (`flags` or `invalid`, with
 * `failures` naming each), or `couldnt-run` with `reason`. A base that couldn't be put in
 * place or run (`base` throwing, or its side resolving `{ couldnt }`) leaves the candidate's
 * failures standing, and the report says the base couldn't run. Writes the runs' logs and records, the report and its lines to
 * `evidence`.
 */
export async function check({ cacheRoot: root, configuration, hostDir, installDir, work, evidence, judge, trial, base = null, lane = laneVersion(), fallbackSpec = 'latest' }) {
  judge ??= await judging();
  trial ??= await trialTurns();
  mkdirSync(work, { recursive: true });
  mkdirSync(evidence, { recursive: true });
  const t0 = performance.now();
  const timing = {};
  const out = { outcome: null, reason: null, entry: null, fellBack: null, candidate: null, base: null, report: null, failures: [], timing };
  const save = () => writeFileSync(join(evidence, 'result.json'), JSON.stringify(out, null, 1));
  const couldnt = (reason) => { out.outcome = 'couldnt-run'; out.reason = reason; timing.wallMs = Math.round(performance.now() - t0); save(); return out; };

  let found = findEntry({ cacheRoot: root, lane, configurationName: configuration.name });
  if (!found) {
    const t = performance.now();
    try {
      const stack = installStack({ spec: fallbackSpec, dir: join(work, 'fallback-stack') });
      const written = await writeStore({ cacheRoot: root, configuration, hostDir: stack.hostDir, installDir: stack.installDir, work: join(work, 'fallback-write'), judge, trial, lane });
      out.fellBack = { spec: fallbackSpec, versions: stack.versions, written: written.written, ms: Math.round(performance.now() - t) };
    } catch (e) {
      out.fellBack = { spec: fallbackSpec, failed: true, ms: Math.round(performance.now() - t) };
      return couldnt(`no store for this lane version (${lane.slice(0, 12)}), and writing one from the last releases failed: ${String(e?.message || e).slice(0, 2000)}`);
    }
    found = findEntry({ cacheRoot: root, lane, configurationName: configuration.name });
    if (!found) return couldnt(`no store for this lane version (${lane.slice(0, 12)}) after the fallback write`);
  }
  const { dir, entry } = found;
  out.entry = { key: entry.key, versions: entry.versions, prefixTurns: entry.prefixTurns, writtenAt: entry.writtenAt, clockEnd: entry.clockEnd, trialMissing: entry.trial?.missing ?? null };

  const sideOf = async (name, sideHost, sideInstall) => {
    const sideWork = join(work, name);
    rmSync(sideWork, { recursive: true, force: true });
    const storeDir = join(sideWork, 'store');
    const t = performance.now();
    try {
      cpSync(join(dir, 'store'), storeDir, { recursive: true });
    } catch (e) {
      return { couldnt: `the cached store ${entry.key.slice(0, 12)} couldn't be copied: ${e.message}` };
    }
    const copyMs = Math.round(performance.now() - t);
    const facts = hostFacts({ hostDir: sideHost, configuration });
    const side = await runSide({ storeDir, epoch: entry.clockEnd, configuration, hostDir: sideHost, facts, work: sideWork });
    const tj = performance.now();
    const judged = await judge({
      records: side.records, log: side.log, script: side.steps, storeCopy: sessionOf(side.run.copies.at(-1)), configuration, installDir: sideInstall,
      run: { ok: side.run.ok, failure: side.run.failure },
    });
    const judgeMs = Math.round(performance.now() - tj);
    cpSync(side.logPath, join(evidence, `${name}.log.jsonl`));
    writeFileSync(join(evidence, `${name}.records.json`), JSON.stringify(side.records));
    return {
      run: { ok: side.run.ok, failure: side.run.failure, clockEnd: side.run.clockEnd },
      judged,
      timerLive: !facts.takesMaintenanceInterval,
      timing: { copyMs, runMs: side.timing.runMs, judgeMs, load: side.timing.load, boots: side.run.timing.boots },
    };
  };

  const candidate = await sideOf('candidate', hostDir, installDir);
  if (candidate.couldnt) return couldnt(candidate.couldnt);
  out.candidate = candidate;
  const failsSomething = candidate.judged.flags.length > 0 || candidate.judged.missing.length > 0;
  if (failsSomething && base) {
    const t = performance.now();
    try {
      out.base = await base(({ hostDir: h, installDir: i }) => sideOf('base', h, i));
    } catch (e) {
      out.base = { couldnt: String(e?.message || e).slice(0, 2000) };
    }
    timing.baseMs = Math.round(performance.now() - t);
  }
  timing.wallMs = Math.round(performance.now() - t0);
  const baseJudged = out.base && !out.base.couldnt ? out.base.judged : null;
  out.report = perCheckReport({
    configuration,
    candidate: candidate.judged,
    base: baseJudged,
    timing: { wallMs: timing.wallMs, load: candidate.timing.load[1], timerLive: candidate.timerLive },
  });
  if (out.base?.couldnt) out.report.lines.push(`- the base couldn't run, so nothing here is compared with it: ${out.base.couldnt}`);
  else if (out.base) out.report.lines.push(`- the base took ${(timing.baseMs / 1000).toFixed(1)} s${out.base.prepMs !== undefined ? `, ${(out.base.prepMs / 1000).toFixed(1)} s of it putting the base in place` : ''}; the candidate's continuation ${(candidate.timing.runMs / 1000).toFixed(1)} s`);
  const by = Object.entries(entry.versions).map(([k, v]) => `${k.replace('@animalabs/', '')} ${v}`).join(', ');
  out.report.lines.push(`- continued a store of ${entry.prefixTurns} prefix turns that ${by} wrote at ${entry.writtenAt} (${entry.key.slice(0, 12)})`);
  if (out.fellBack) {
    out.report.lines.push(`- none was cached for this lane version (${lane.slice(0, 12)}), so this check ${out.fellBack.written ? 'wrote it' : 'waited for another writer\'s'} first: ${(out.fellBack.ms / 1000).toFixed(1)} s`);
  }
  out.outcome = out.report.verdict === 'pass' ? 'pass' : out.report.verdict;
  out.failures = out.outcome === 'pass' ? [] : failureNames(out.report);
  save();
  writeFileSync(join(evidence, 'report.txt'), `${out.report.lines.join('\n')}\n`);
  return out;
}
