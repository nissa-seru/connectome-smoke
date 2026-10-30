#!/usr/bin/env node
// The context-manager characterization fixture's lane: each strategy configuration through each workload, in-process
// against a context-manager tree, each run's record compared with the record committed for it.
//
//   node lanes/cm-fixture.mjs check --cm DIR [--commit SHA] [--workers N] [--runs ID,ID] [--workloads W1,W2]
//   node lanes/cm-fixture.mjs regenerate --cm DIR [--commit SHA] [--workers N] [--runs ID,ID] [--workloads W1,W2]
//   node lanes/cm-fixture.mjs checkpoints --release VERSION [--workers N]
//   node lanes/cm-fixture.mjs readiness --cm DIR [--workers N] [--mutants FILE] [--runs ID,ID] [--workloads W1,W2]
//
// check: runs the matrix once and compares each run's record with fixtures/cm-fixture/records. Exit 0 when every
// record matches, 1 when any differs, a run has no record, or a run failed, and 2 when the check couldn't run.
// regenerate: runs the matrix twice, refuses unless both runs render every record the same, and refuses a record
// holding an INVARIANT line that fixtures/cm-fixture/expected-failures.json doesn't name with its issue (an entry
// names a run's lines of one invariant, or, with `match`, a regular expression, those whose detail it matches).
// Otherwise it writes the records, removes those of runs the matrix no longer has, and prints what changed.
// checkpoints: replaces fixtures/cm-fixture/checkpoints with the stores the continuations start from, written by the
// context-manager release named, installed from npm (checkpoints.mjs).
// readiness: whether the fixture sees what it's for, in copies of the tree: a no-op change (a comment) must leave every
// record the same, and each mutant in lib/cm-fixture/mutants.json ({ id, why, edits: [{ file, find, replace }], flags:
// runs, CONFIG/WORKLOAD pairs or workloads }), applied, must change a record of a run it names.
// A mutant whose text no longer occurs exactly once in the tree is stale, and fails readiness until it's updated.
// A mutant's optional `configs` names the configurations whose runs count for it. A mutant with no flags is unplaced:
// readiness runs it against W1, W2 and every run another mutant names, of its configurations, reports which of their
// records it changes, and isn't ready until its flags are written; --runs and --workloads narrow the runs an unplaced
// mutant is tried against. --mutants reads another file of mutants in the same form, such as a rule
// list's survivors before they're placed.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTrace, traceFileName } from '../lib/cm-fixture/events.mjs';
import { renderRecord } from '../lib/cm-fixture/record.mjs';
import { diffRecords } from '../lib/cm-fixture/record-diff.mjs';
import { runArm } from '../lib/cm-fixture/pool.mjs';
import { matrix } from '../lib/cm-fixture/workloads.mjs';
import { writeCheckpoints } from '../lib/cm-fixture/checkpoints.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'lib', 'cm-fixture');
const RECORDS = join(ROOT, 'fixtures', 'cm-fixture', 'records');
const CHECKPOINTS = join(ROOT, 'fixtures', 'cm-fixture', 'checkpoints');
const EXPECTED_FAILURES = join(ROOT, 'fixtures', 'cm-fixture', 'expected-failures.json');
const recordFile = (id) => traceFileName(id).replace(/\.jsonl$/, '.txt');

function args(argv) {
  const [command, ...rest] = argv;
  const o = { command, workers: 10, runs: null, workloads: null };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i], v = rest[i + 1];
    if (k === '--cm') { o.cm = resolve(v); i++; } else if (k === '--mutants') { o.mutants = resolve(v); i++; } else if (k === '--release') { o.release = v; i++; } else if (k === '--commit') { o.commit = v; i++; } else if (k === '--workers') { o.workers = Number(v); i++; } else if (k === '--runs') { o.runs = new Set(v.split(',')); i++; } else if (k === '--workloads') { o.workloads = new Set(v.split(',')); i++; } else throw new Error(`unknown argument ${k}`);
  }
  if (!['check', 'regenerate', 'checkpoints', 'readiness'].includes(command)) throw new Error('the command is check, regenerate, checkpoints or readiness');
  if (!Number.isInteger(o.workers) || o.workers < 1) throw new Error('--workers is a whole number from 1');
  if (command === 'checkpoints') {
    if (!/^\d+\.\d+\.\d+$/.test(o.release ?? '')) throw new Error('--release names a context-manager version on npm, such as 0.24.2');
    return o;
  }
  if (!o.cm || !existsSync(join(o.cm, 'src', 'index.ts'))) throw new Error('--cm names a context-manager tree (one with src/index.ts)');
  o.commit ??= execFileSync('git', ['-C', o.cm, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return o;
}

/** Run the matrix once in the tree, and render each run's record: { records: Map(id -> text), failed }. */
async function runOnce(o, jobs, work) {
  const traceDir = join(work, 'traces');
  const results = await runArm({
    arm: { name: 'candidate', cmDir: o.cm, membraneDir: o.membraneDir ?? o.cm, commit: o.commit },
    jobs, workers: o.workers, traceDir, checkpointDir: CHECKPOINTS, workDir: join(work, 'runs'),
    recorder: join(LIB, 'trace.mjs'), house: join(LIB, 'house.json'),
  });
  const records = new Map();
  const failed = [];
  for (const r of results) {
    const file = join(traceDir, traceFileName(r.id));
    if (!existsSync(file)) { failed.push({ id: r.id, why: r.error ?? 'no trace written' }); continue; }
    const trace = readTrace(readFileSync(file, 'utf8'), r.id);
    if (trace.end.error?.where === 'driver') failed.push({ id: r.id, why: `the driver ended the run: ${trace.end.error.class}` });
    records.set(r.id, renderRecord(trace));
  }
  return { records, failed };
}

/**
 * A copy of a tree's src with edits made, sharing its node_modules: each edit's `find` must occur exactly once in its
 * file, or `append` is added at the file's end. Returns the first edit that can't be made, or null.
 */
function mutated(cm, dir, edits) {
  mkdirSync(dir, { recursive: true });
  cpSync(join(cm, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(cm, 'package.json'), join(dir, 'package.json'));
  symlinkSync(join(cm, 'node_modules'), join(dir, 'node_modules'));
  for (const edit of edits) {
    const file = join(dir, 'src', edit.file);
    if (!existsSync(file)) return edit;
    const text = readFileSync(file, 'utf8');
    if (edit.append !== undefined) { writeFileSync(file, text + edit.append); continue; }
    if (text.split(edit.find).length !== 2) return edit;
    writeFileSync(file, text.replace(edit.find, edit.replace));
  }
  return null;
}

/**
 * Each mutant flags a run it names, and a no-op flags none: { ok, lines }. A run that renders no record under a
 * mutant is reported as such and doesn't count as flagging: a mutant that breaks the build would otherwise flag every
 * run it reaches. A base run that renders none, or that the driver ends, fails readiness.
 */
async function readiness(o, house, work) {
  const mutants = JSON.parse(readFileSync(o.mutants ?? join(LIB, 'mutants.json'), 'utf8'));
  const all = matrix(house);
  const unplaced = (m) => !m.flags?.length;
  const counts = (m, j) => !m.configs || m.configs.some((c) => j.config === c || j.config.startsWith(`${c}.`));
  const named = (m) => all.filter((j) => counts(m, j) && (m.flags ?? []).some((f) => f === j.id || f === j.workload || f === `${j.config}/${j.workload}`));
  const lines = [];
  let ok = true;
  const runIn = (cm, jobs, at) => runOnce({ ...o, cm, membraneDir: o.cm }, jobs, at);
  const baseJobs = all.filter((j) => mutants.some((m) => named(m).includes(j)) || ['W1', 'W2'].includes(j.workload));
  const { records: base, failed: baseFailed } = await runIn(o.cm, baseJobs, join(work, 'base'));
  for (const f of baseFailed) { ok = false; lines.push(`base: ${f.id} ${base.has(f.id) ? 'was ended by the driver' : 'rendered no record'} (${f.why})`); }
  const noop = join(work, 'noop');
  mutated(o.cm, noop, [{ file: 'index.ts', append: '\n// cm-fixture readiness: a change that changes nothing.\n' }]);
  const after = (await runIn(noop, baseJobs, join(work, 'noop-run'))).records;
  const moved = [...base].filter(([id, text]) => after.get(id) !== text).map(([id]) => id);
  ok &&= moved.length === 0;
  lines.push(moved.length === 0 ? `no-op: every record the same (${base.size} runs)` : `no-op: FAILED, records changed in ${moved.join(', ')}`);
  for (const m of mutants) {
    const dir = join(work, `mutant-${m.id}`);
    const stale = mutated(o.cm, dir, m.edits);
    if (stale) { ok = false; lines.push(`${m.id}: STALE, its text doesn't occur exactly once in src/${stale.file}`); continue; }
    const jobs = unplaced(m) ? baseJobs.filter((j) => counts(m, j) && (!o.runs || o.runs.has(j.id)) && (!o.workloads || o.workloads.has(j.workload))) : named(m);
    const { records, failed } = await runIn(dir, jobs, join(work, `mutant-${m.id}-run`));
    const flagged = jobs.filter((j) => base.has(j.id) && records.has(j.id) && records.get(j.id) !== base.get(j.id)).map((j) => j.id);
    const missing = failed.filter((f) => !records.has(f.id));
    const norecord = missing.length ? ` (${missing.length} rendered no record, the first ${missing[0].id}: ${missing[0].why})` : '';
    if (unplaced(m)) {
      ok = false;
      if (failed.length && missing.length === jobs.length) { lines.push(`${m.id}: UNPLACED; no run rendered a record${norecord}`); continue; }
      lines.push(flagged.length ? `${m.id}: UNPLACED; changes the records of ${flagged.join(', ')}${norecord}` : `${m.id}: UNPLACED; changes none of the ${jobs.length} runs' records${norecord} (${m.why})`);
      continue;
    }
    ok &&= flagged.length > 0;
    lines.push(flagged.length ? `${m.id}: flagged in ${flagged.join(', ')}${norecord}` : `${m.id}: NOT FLAGGED in ${jobs.map((j) => j.id).join(', ')}${norecord} (${m.why})`);
  }
  return { ok, lines };
}

function expectedFailures() {
  if (!existsSync(EXPECTED_FAILURES)) return [];
  const list = JSON.parse(readFileSync(EXPECTED_FAILURES, 'utf8'));
  for (const f of list) if (!f.run || !f.invariant || !f.issue) throw new Error(`${EXPECTED_FAILURES}: each entry names its run, invariant and issue (the issue text record, such as post:post-342, until it is filed)`);
  return list.map((f) => ({ ...f, match: f.match === undefined ? null : new RegExp(f.match) }));
}

/** The INVARIANT lines a record holds that no expected failure names. */
function unexpectedInvariants(id, text, expected) {
  const entries = expected.filter((f) => f.run === id);
  return text.split('\n').filter((l) => /^\s*INVARIANT /.test(l)).filter((l) => {
    const line = l.trim().slice('INVARIANT '.length);
    const name = line.split(':')[0];
    const detail = line.slice(name.length + 2);
    return !entries.some((f) => f.invariant === name && (f.match === null || f.match.test(detail)));
  });
}

function summary(id, d) {
  const out = [`${id}: ${d.same ? 'same' : 'changed'}`];
  for (const h of d.header) out.push(`  header: ${h.expected ?? '(none)'} -> ${h.actual ?? '(none)'}`);
  for (const g of d.groups) {
    if (g.kind === 'words') out.push(`  words in ${g.templates.join(', ')}: ${g.before ?? '(new)'} -> ${g.after ?? '(gone)'}`);
    else if (g.kind === 'template') out.push(`  ${g.lines} lines name ${g.to} where they named ${g.from}`);
    else out.push(`  ${g.kind}: ${g.lines} lines`);
  }
  for (const b of d.blocking) out.push(`  BLOCKING ${b.why}: ${b.actual}`);
  if (d.first) out.push(`  first change, expected line ${d.first.expectedAt}:`, ...d.first.lines.map((l) => `    ${l}`));
  return out.join('\n');
}

async function main() {
  let o;
  try { o = args(process.argv.slice(2)); } catch (err) { process.stderr.write(`cm-fixture: ${err.message}\n`); return 2; }
  if (o.command === 'checkpoints') {
    const work = mkdtempSync(join(tmpdir(), 'cm-fixture-'));
    try {
      const m = await writeCheckpoints({ release: o.release, outDir: CHECKPOINTS, house: join(LIB, 'house.json'), recorder: join(LIB, 'trace.mjs'), workDir: work, workers: o.workers });
      for (const f of m.failed) process.stderr.write(`${f.id}: FAILED ${f.error}\n`);
      process.stdout.write(`cm-fixture checkpoints: ${m.stores.length} stores from context-manager ${m.release}, ${(m.stores.reduce((a, s) => a + s.bytes, 0) / 1e6).toFixed(1)} MB\n`);
      return m.failed.length ? 1 : 0;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  const house = JSON.parse(readFileSync(join(LIB, 'house.json'), 'utf8'));
  const jobs = matrix(house).filter((j) => (!o.runs || o.runs.has(j.id)) && (!o.workloads || o.workloads.has(j.workload)));
  const partial = !!(o.runs || o.workloads);
  const work = mkdtempSync(join(tmpdir(), 'cm-fixture-'));
  try {
    const started = performance.now();
    if (o.command === 'readiness') {
      const r = await readiness(o, house, work);
      for (const l of r.lines) process.stdout.write(`${l}\n`);
      process.stdout.write(`cm-fixture readiness: ${r.ok ? 'ready' : 'NOT READY'} at ${o.commit.slice(0, 12)}, in ${((performance.now() - started) / 1000).toFixed(1)} s\n`);
      return r.ok ? 0 : 1;
    }
    const first = await runOnce(o, jobs, join(work, 'a'));
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    if (o.command === 'check') {
      let bad = first.failed.length;
      for (const f of first.failed) process.stdout.write(`${f.id}: FAILED ${f.why}\n`);
      for (const [id, text] of first.records) {
        const committed = join(RECORDS, recordFile(id));
        if (!existsSync(committed)) { bad++; process.stdout.write(`${id}: no committed record; a run the matrix gained needs one, written by regenerate\n`); continue; }
        const d = diffRecords(readFileSync(committed, 'utf8'), text);
        if (!d.same) { bad++; process.stdout.write(`${summary(id, d)}\n`); }
      }
      process.stdout.write(`cm-fixture check: ${jobs.length} runs at ${o.commit.slice(0, 12)}, ${jobs.length - bad} matching their records, in ${seconds} s\n`);
      return bad === 0 ? 0 : 1;
    }
    // regenerate
    if (first.failed.length) { for (const f of first.failed) process.stderr.write(`${f.id}: FAILED ${f.why}\n`); return 1; }
    const second = await runOnce(o, jobs, join(work, 'b'));
    const differs = [...first.records].filter(([id, text]) => second.records.get(id) !== text).map(([id]) => id);
    if (differs.length) { process.stderr.write(`cm-fixture: two runs rendered different records, so the fixture or the library isn't deterministic there: ${differs.join(', ')}\n`); return 1; }
    const expected = expectedFailures();
    const unnamed = [...first.records].flatMap(([id, text]) => unexpectedInvariants(id, text, expected).map((l) => `${id}: ${l.trim()}`));
    if (unnamed.length) { process.stderr.write(`cm-fixture: records hold invariant failures no expected failure names with its issue:\n${unnamed.join('\n')}\n`); return 1; }
    mkdirSync(RECORDS, { recursive: true });
    const keep = new Set();
    for (const [id, text] of first.records) {
      const file = join(RECORDS, recordFile(id));
      keep.add(recordFile(id));
      const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
      if (before === text) continue;
      writeFileSync(file, text);
      process.stdout.write(before === null ? `${id}: new record\n` : `${summary(id, diffRecords(before, text))}\n`);
    }
    if (!partial) for (const f of readdirSync(RECORDS)) if (f.endsWith('.txt') && !keep.has(f)) { unlinkSync(join(RECORDS, f)); process.stdout.write(`${f}: removed, its run is no longer in the matrix\n`); }
    process.stdout.write(`cm-fixture regenerate: ${jobs.length} records at ${o.commit.slice(0, 12)}, each the same in two runs\n`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

process.exitCode = await main();
