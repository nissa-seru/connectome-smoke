#!/usr/bin/env node
/**
 * connectome-smoke — "store-move" lane: what a resident meets when a host release moves its
 * store to a newer chronicle format, once and for good.
 *
 * It installs the base release (the one residents run now) and the candidate as an npm
 * consumer would, as cache-write does (lib/cache-write.mjs, installSpecs). For each stored
 * fixture, on copies of its data directory:
 *   1. the base boots and takes a turn, twice, as a control;
 *   2. the candidate boots and takes a turn; its store's MANIFEST is then read;
 *   3. a copy of that moved store is put aside for step 5;
 *   4. the candidate boots again on the moved store and takes a second turn;
 *   5. the base boots on the copy from step 3, which should refuse it and write nothing.
 * Then it reads the fixture's record through the base's context-manager and judges, row by
 * row, whether everything the base gave the resident (in both of its runs) the candidate
 * still gives, or the resident can reach again; and the same between the candidate's first
 * boot and its second, which must also carry the first boot's own turn
 * (lib/store-move.mjs). It prints cache-write's cache line for the same runs beside its
 * own result, since what the resident is given anew is a cache matter, not a loss.
 *
 *   node lanes/store-move.mjs --candidate <spec or packed tarball> [--base <spec>]
 *   options: --base-before <ISO time>, --fixtures <dir> (repeatable; default
 *            fixtures/stores and, where it exists, fixtures/long-stores), --only <a,b>,
 *            --workdir <dir>, --keep, --report <file>, --summary <file>
 *
 * A fixture under fixtures/stores is a two-turn store booted on lib/stores.mjs'
 * storeRecipe; one under fixtures/long-stores carries its own recipe and stand-in in its
 * fixture.json, read through lib/long-stores.mjs.
 *
 * Exit 1 when any fixture shows a finding: the candidate's turn failed where the base's
 * didn't, a store didn't move to version 2 with AppendMany, the second boot failed or
 * lost something, the rollback opened the store, didn't name its version, or wrote to it,
 * or a row the base gave is neither given nor reachable. Else 2 when anything couldn't be
 * told: arguments it can't run, an install failed, no fixtures, a fixture unreadable, a
 * base run failed. Else 0. A passing run deletes its default workdir but for its report
 * and summary; any other keeps it whole, every copy included.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const crash = (e) => { console.error(`FATAL ${e?.stack || e}`); process.exit(2); };
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);
const { makeReport, sh, finish, parseArgs } = await import('../lib/common.mjs');
const { resolvedVersions, storeRecipe, turnOnStore, CouldNotRun } = await import('../lib/stores.mjs');
const { compareRuns, cacheLine, cleanupWorkdir, installSpecs } = await import('../lib/cache-write.mjs');
const { treeDigest, treeChanges, storesIn, withinStores, givenCheck, rowsOf, unreachable, hasHistoryTools, rollbackVerdict, FEATURES } = await import('../lib/store-move.mjs');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);
const { opt, opts, flag } = parseArgs(ARGS);
const OPTIONS = { candidate: true, base: true, 'base-before': true, fixtures: true, only: true, workdir: true, report: true, summary: true, keep: false };
const REPEATABLE = new Set(['fixtures']);

function argumentProblem(args) {
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) return `"${a}" isn't an option or an option's value`;
    const name = a.slice(2);
    if (!Object.hasOwn(OPTIONS, name)) return `${a} isn't an option this lane reads; it reads ${Object.keys(OPTIONS).map((o) => `--${o}`).join(', ')}`;
    if (seen.has(name) && !REPEATABLE.has(name)) return `${a} is given more than once`;
    seen.add(name);
    if (OPTIONS[name]) {
      if (typeof args[i + 1] !== 'string' || args[i + 1] === '' || args[i + 1].startsWith('-')) return `${a} needs a value`;
      i++;
    }
  }
  return null;
}

const STARTED_AT = new Date().toISOString();
const NAMED = opt('workdir') ? resolve(opt('workdir')) : null;
const KEEP = flag('keep');
const WORK = NAMED ? (mkdirSync(NAMED, { recursive: true }), mkdtempSync(join(NAMED, 'store-move-'))) : mkdtempSync(join(resolve(tmpdir()), 'connectome-smoke-move-'));
const DIRS = opts('fixtures').length ? opts('fixtures').map((d) => resolve(d)) : [join(ROOT, 'fixtures', 'stores'), join(ROOT, 'fixtures', 'long-stores')].filter((d) => existsSync(d));
const ONLY = ARGS.includes('--only') ? String(opt('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean) : null;
const REPORT = resolve(opt('report') ?? join(WORK, 'report.json'));
const SUMMARY = resolve(opt('summary') ?? join(WORK, 'summary.md'));
const SPECS = installSpecs({ base: opt('base') ?? '@animalabs/connectome-host@latest', candidate: opt('candidate'), baseBefore: opt('base-before'), startedAt: STARTED_AT });

const { report, step, log, t0 } = makeReport('store-move', {
  workdir: WORK, fixtures: DIRS, base: SPECS.base.spec, baseBefore: SPECS.base.before, candidate: SPECS.candidate.spec, candidateBefore: SPECS.candidate.before, resolved: {}, moves: [],
});

/** Every fixture under the fixture directories: `{ name, dir, kind }`, `long` for one whose
 *  fixture.json carries its own recipe. */
function fixtures() {
  return DIRS.flatMap((d) => readdirSync(d).sort().filter((n) => statSync(join(d, n)).isDirectory()).map((name) => {
    let prov = null;
    try { prov = JSON.parse(readFileSync(join(d, name, 'fixture.json'), 'utf-8')); } catch { /* judged in its steps */ }
    return { name, dir: join(d, name), prov, kind: prov?.recipe ? 'long' : 'two-turn' };
  }));
}

/** How a fixture boots: its recipe for a run's values, its stand-in, and its resident. */
async function planFor(fx) {
  if (!fx.prov || !existsSync(join(fx.dir, 'data'))) throw new CouldNotRun(`fixture ${fx.name}: no readable fixture.json or no data/`);
  if (fx.kind === 'two-turn') return { makeRecipe: storeRecipe, replier: null, agent: 'smoke', recipe: storeRecipe({ webPort: 0, auth: null, heartbeatEntry: '', dataDir: '' }) };
  const long = join(ROOT, 'lib', 'long-stores.mjs');
  if (!existsSync(long)) throw new CouldNotRun(`fixture ${fx.name} carries its own recipe, which needs lib/long-stores.mjs to fill`);
  const { fillRecipe, longReplier, waitQuiet } = await import(pathToFileURL(long).href);
  // As the capture ends each boot: the stand-in quiet for 5 s before the shutdown, so no
  // compression is in flight when the host stops.
  return { makeRecipe: (values) => fillRecipe(fx.prov.recipe, values), replier: (nonce) => longReplier(nonce).reply, settle: (fake) => waitQuiet(fake, 5_000), agent: fx.prov.recipe.agent?.name, recipe: fx.prov.recipe };
}

async function install(name, specs, before) {
  const dir = join(WORK, `install-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `connectome-smoke-move-${name}`, private: true, version: '0.0.0', type: 'module' }, null, 2));
  const ok = await step(`install ${name}: ${specs.join(' ')} as of ${before}`, () => {
    const r = sh('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', '--global=false', '--location=project', `--prefix=${dir}`, ...specs], { cwd: dir, timeout: 900_000, env: { npm_config_before: before } });
    report.resolved[name] = resolvedVersions(dir);
    return Object.entries(report.resolved[name]).map(([k, v]) => `${k.replace('@animalabs/', '')}@${v}`).join(' ') + '\n' + (r.stdout + r.stderr).trim().split('\n').slice(-2).join('\n');
  });
  if (!ok) report.fatal = `the ${name} install failed (its step says why)`;
  return ok;
}

/** A store's record as an install's context-manager reads it, on a copy made for the read. */
function readRecord(installName, dataDir, readDir, agent, stores) {
  cpSync(dataDir, readDir, { recursive: true });
  const store = stores.find((s) => s.store !== '.' && !s.error) ?? stores[0];
  if (!store) throw new Error(`no store under ${dataDir}`);
  const r = sh(process.execPath, [join(ROOT, 'scripts', 'store-record.mjs'), '--install', join(WORK, `install-${installName}`), '--store', join(readDir, store.store), '--namespace', `agents/${agent}`], { cwd: WORK, timeout: 300_000 });
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

/** What a request gives the resident, for givenCheck: its system prompt and every message. */
const givenOf = (turn) => ({ system: turn.request.body?.system ?? null, messages: turn.request.body?.messages ?? [] });

(async () => {
  const problem = argumentProblem(ARGS);
  if (problem) { report.fatal = problem; report.exitCode = 2; return done(); }
  if (!SPECS.candidate.spec) { report.fatal = '--candidate <spec or packed tarball> is required'; report.exitCode = 2; return done(); }
  const all = fixtures();
  const chosen = ONLY ? all.filter((f) => ONLY.includes(f.name)) : all;
  const unknown = (ONLY ?? []).filter((n) => !all.some((f) => f.name === n));
  if (!chosen.length || unknown.length) { report.fatal = !all.length ? `no fixtures under ${DIRS.join(', ')}` : `--only names ${unknown.join(', ') || 'no fixture'}`; report.exitCode = 2; return done(); }
  if (!await install('base', [SPECS.base.spec, '@animalabs/heartbeat-mcpl'], SPECS.base.before) || !await install('candidate', [SPECS.candidate.spec], SPECS.candidate.before)) { report.exitCode = 2; return done(); }
  const hostDir = (name) => join(WORK, `install-${name}`, 'node_modules', '@animalabs', 'connectome-host');
  const heartbeatEntry = join(WORK, 'install-base', 'node_modules', '@animalabs', 'heartbeat-mcpl', 'dist', 'src', 'index.js');
  const cacheRuns = { 'base-1': [], 'base-2': [], candidate: [] };

  for (const fx of chosen) {
    const move = { name: fx.name, kind: fx.kind, findings: [], untold: [] };
    report.moves.push(move);
    const at = (...p) => join(WORK, 'fixtures', fx.name, ...p);
    let plan;
    if (!await step(`plan:${fx.name}`, async () => { plan = await planFor(fx); move.historyTools = hasHistoryTools(plan.recipe); return `${fx.kind}, resident ${plan.agent}, history tools ${move.historyTools ? 'on' : 'off'}`; })) { move.untold.push('fixture unreadable'); continue; }
    const turn = async (label, installName, dataDir, opts = {}) => {
      mkdirSync(join(at(label)), { recursive: true });
      return turnOnStore({ hostDir: hostDir(installName), heartbeatEntry, dataDir, work: at(label), label, textPrefix: `store-move ${label} on ${fx.name}`, makeRecipe: plan.makeRecipe, replier: plan.replier, settle: plan.settle ?? null, ...opts });
    };
    const fresh = (label) => { const d = at(label, 'data'); cpSync(join(fx.dir, 'data'), d, { recursive: true }); return d; };
    move.storesBefore = storesIn(join(fx.dir, 'data'));

    // 1. The base, twice.
    const runs = {};
    for (const label of ['base-1', 'base-2']) {
      await step(`${label}:${fx.name}`, async () => { runs[label] = await turn(label, 'base', fresh(label)); return `${runs[label].requests} request(s)`; });
      cacheRuns[label].push({ version: fx.name, ok: Boolean(runs[label]), sent: runs[label] ?? null });
    }
    // 2. The candidate, and its MANIFEST.
    const moved = fresh('candidate');
    const candidateOk = await step(`candidate:${fx.name}`, async () => { runs.candidate = await turn('candidate', 'candidate', moved); return `${runs.candidate.requests} request(s)`; });
    cacheRuns.candidate.push({ version: fx.name, ok: candidateOk, sent: runs.candidate ?? null });
    if (!runs['base-1'] || !runs['base-2']) { move.untold.push('a base run failed'); continue; }
    if (!candidateOk) { move.findings.push("the candidate's turn on the store failed where the base's didn't"); continue; }
    move.storesAfterFirst = storesIn(moved);
    await step(`manifest:${fx.name}`, () => {
      const notMoved = move.storesAfterFirst.filter((s) => s.version !== 2 || !(s.features & FEATURES.appendMany));
      if (!move.storesAfterFirst.length || notMoved.length) {
        move.findings.push('a store did not move to version 2 with AppendMany');
        throw new Error(`MANIFEST after the candidate's turn: ${JSON.stringify(move.storesAfterFirst)}`);
      }
      return move.storesAfterFirst.map((s) => `${s.store}: v${s.version} features ${s.features}`).join('; ');
    });

    // 3. The rollback's copy, and the moved record, before the second boot touches the store.
    const rollbackDir = at('rollback', 'data');
    cpSync(moved, rollbackDir, { recursive: true });
    let fixtureRecord; let movedRecord;
    await step(`record:${fx.name}`, () => {
      fixtureRecord = readRecord('base', join(fx.dir, 'data'), at('record-fixture', 'data'), plan.agent, move.storesBefore);
      movedRecord = readRecord('candidate', moved, at('record-moved', 'data'), plan.agent, move.storesAfterFirst);
      return `fixture: ${fixtureRecord.messages.length} messages, ${fixtureRecord.summaries.length} summaries; moved: ${movedRecord.messages.length} messages, ${movedRecord.summaries.length} summaries, ${movedRecord.indexed.length} indexed`;
    });

    // The base's rows, given by the candidate or reachable.
    if (fixtureRecord && movedRecord) {
      await step(`given:${fx.name}`, () => {
        const g = givenCheck(rowsOf(fixtureRecord), [givenOf(runs['base-1']), givenOf(runs['base-2'])], givenOf(runs.candidate));
        const lostFor = unreachable(g.lost, { historyTools: move.historyTools, record: movedRecord });
        move.given = { given: g.given, lost: g.lost.map((r) => `${r.kind} ${r.id}`), unreachable: lostFor.map((r) => `${r.kind} ${r.id}`), unsteady: g.unsteady.map((r) => `${r.kind} ${r.id}`), untexted: g.untexted };
        if (lostFor.length) { move.findings.push('rows the base gave are neither given nor reachable'); throw new Error(`neither given nor reachable: ${move.given.unreachable.join(', ')}`); }
        return `${g.given} rows given by the base; ${g.lost.length} not given by the candidate (${g.lost.length - lostFor.length} reachable); ${g.unsteady.length} unsteady; ${g.untexted} without text`;
      });
    }

    // 4. The candidate again, on the moved store.
    await step(`second:${fx.name}`, async () => {
      const second = await turn('second', 'candidate', moved);
      const json = JSON.stringify(givenOf(second));
      const first = runs.candidate;
      const ownTurn = [first.text, first.reply].filter((t) => !json.includes(JSON.stringify(t).slice(1, -1)));
      const g = givenCheck(rowsOf(movedRecord), [givenOf(first)], givenOf(second));
      const lostFor = unreachable(g.lost, { historyTools: move.historyTools, record: movedRecord });
      move.storesAfterSecond = storesIn(moved);
      move.second = { requests: second.requests, ownTurnMissing: ownTurn, lost: g.lost.map((r) => `${r.kind} ${r.id}`), unreachable: lostFor.map((r) => `${r.kind} ${r.id}`), stores: move.storesAfterSecond };
      const problems = [
        ...(ownTurn.length ? [`the first boot's own turn isn't in the second's request: ${ownTurn.join(' / ')}`] : []),
        ...(lostFor.length ? [`rows the first boot gave are neither given nor reachable: ${move.second.unreachable.join(', ')}`] : []),
        ...(move.storesAfterSecond.some((s) => s.version !== 2) ? [`a store's MANIFEST after the second boot: ${JSON.stringify(move.storesAfterSecond)}`] : []),
      ];
      if (problems.length) { move.findings.push('the second boot lost something'); throw new Error(problems.join('\n')); }
      return `${g.given} rows given by the first boot, all given or reachable; its own turn carried; ${second.requests} request(s)`;
    }).then((ok) => { if (!ok && !move.findings.includes('the second boot lost something')) move.findings.push("the candidate's second boot on the moved store failed"); });

    // 5. The base, on the moved copy.
    await step(`rollback:${fx.name}`, async () => {
      const stores = storesIn(rollbackDir);
      const before = withinStores(treeDigest(rollbackDir), stores);
      const outcome = { opened: false, error: null };
      try { await turn('rollback', 'base', rollbackDir, { bootTimeoutMs: 60_000 }); outcome.opened = true; } catch (e) { outcome.error = String(e?.message || e); }
      const after = withinStores(treeDigest(rollbackDir), stores);
      const v = rollbackVerdict({ outcome, changes: treeChanges(before, after) });
      move.rollback = { ...v, said: (outcome.error ?? '').split('\n').filter((l) => /error|unsupported|refus/i.test(l) && !/^\s*\d+ \|/.test(l)).slice(0, 6) };
      if (!v.clean) { move.findings.push('the rollback was not a clean refusal'); throw new Error(JSON.stringify(move.rollback)); }
      return `refused, naming version 2; nothing in the store changed (${Object.keys(before).length} entries compared)`;
    });
  }

  report.cache = compareRuns(cacheRuns['base-1'], cacheRuns['base-2'], cacheRuns.candidate, chosen.map((f) => f.name));
  report.cacheLine = cacheLine(report.cache);
  report.exitCode = report.moves.some((m) => m.findings.length) ? 1 : report.moves.some((m) => m.untold.length) || report.steps.some((s) => !s.ok) ? 2 : 0;
  done();
})().catch((e) => { log(`FATAL ${e?.stack || e}`); report.fatal = String(e?.stack || e); report.exitCode = 2; done(); });

function done() {
  process.on('exit', (code) => {
    try { cleanupWorkdir({ code, work: WORK, made: !NAMED && !KEEP, keep: [REPORT, SUMMARY] }); }
    catch (e) { console.error(`[smoke:store-move] couldn't clean ${WORK}, which stays: ${e?.message || e}`); }
  });
  const side = (name) => { const r = report.resolved[name] ?? {}; return `host ${r['@animalabs/connectome-host'] ?? '—'} (af ${r['@animalabs/agent-framework'] ?? '—'}, cm ${r['@animalabs/context-manager'] ?? '—'}, chronicle ${r['@animalabs/chronicle'] ?? '—'})`; };
  const found = report.moves.filter((m) => m.findings.length);
  const line = report.fatal ? `Store move: couldn't tell (${report.fatal.split('\n')[0]}).`
    : found.length ? `Store move: findings in ${found.length} of ${report.moves.length} fixtures: ${found.map((m) => `${m.name} (${m.findings.join('; ')})`).join('; ')}.`
    : report.exitCode === 2 ? `Store move: couldn't tell for ${report.moves.filter((m) => m.untold.length).map((m) => m.name).join(', ') || 'a step'}.`
    : `Store move: none found in ${report.moves.length} fixtures.`;
  console.log(line);
  if (report.cacheLine) console.log(report.cacheLine);
  finish({ report, t0, reportPath: REPORT, summaryPath: SUMMARY, headline: `base ${side('base')} · candidate ${side('candidate')}`, extraLines: [line, ...(report.cacheLine ? [report.cacheLine] : [])] });
}
