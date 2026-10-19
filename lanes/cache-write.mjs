#!/usr/bin/env node
/**
 * connectome-smoke — "cache-write" lane: would a resident stepping from one host release
 * to another have its prompt cache written again?
 *
 * It installs the base release and the candidate as an npm consumer would, each as npm's
 * before filter takes the lane's start, or the base as it takes --base-before when given
 * (lib/cache-write.mjs, installSpecs). It boots each on a copy of every stored
 * fixture with the base's heartbeat-mcpl, takes one turn (lib/stores.mjs, checkStores),
 * and compares what the requests carry before that turn's first message
 * (lib/cache-write.mjs). The base runs twice, as a control: where its own two runs differ
 * anywhere, a difference from the candidate can't be told from noise, and that fixture's
 * verdict is `noise`.
 *
 *   node lanes/cache-write.mjs --candidate <spec or packed tarball> [--base <spec>]
 *   options: --base-before <ISO time> (install the base as npm's before filter takes that
 *            time), --fixtures <dir>, --only <v1,v2>, --workdir <dir> (the lane makes its
 *            own directory inside it), --keep, --report <file>, --summary <file>
 *   Each option once, its value as the next word; anything else is refused.
 *
 * --base defaults to @animalabs/connectome-host@latest. The lane prints the cache line for
 * the candidate's release notes before its report path and result lines, and the summary
 * carries it after its headline.
 *
 * Exit 1 when any fixture shows a write, whatever the others show; else 0 when every
 * fixture's requests are the same; else 2, couldn't tell: arguments it can't run as
 * given, an install failed, no fixtures, an --only that names none or a name with none,
 * a --base-before that isn't a time, a fixture with no result in some run, the control
 * differed, or the requests differ only where the check can't tell what is written again:
 * where the caching guide doesn't place, in the cache markers, or in an effort given on
 * one side only. A passing
 * run deletes its default workdir's installs and fixture copies and keeps its report and
 * summary; any other run, or a workdir made inside one you named, keeps it whole.
 */
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// A crash is a run that couldn't tell, so it exits 2, never 1, which says a write was
// found, and it still ends in a cache line. The library is imported after these are set,
// so a failure loading it is such a crash too.
const crash = (e) => {
  console.error(`FATAL ${e?.stack || e}`);
  console.log(`Cache: couldn't tell (the lane crashed: ${String(e?.message || e).split('\n')[0]}).`);
  process.exit(2);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);
const { makeReport, sh, finish, parseArgs } = await import('../lib/common.mjs');
const { checkStores, listFixtures, resolvedVersions } = await import('../lib/stores.mjs');
const { compareRuns, cacheLine, cleanupWorkdir, exitFor, installSpecs, verdictStep } = await import('../lib/cache-write.mjs');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);
const { opt, flag } = parseArgs(ARGS);

/** The options the lane reads, each with whether it takes a value. */
const OPTIONS = { candidate: true, base: true, 'base-before': true, fixtures: true, only: true, workdir: true, report: true, summary: true, keep: false };

/** A value an option can take: not missing, empty, or another option's flag. */
const isValue = (v) => typeof v === 'string' && v !== '' && !v.startsWith('-');

/** Why the arguments can't be run as given, or null: an option the lane doesn't read, one
 *  given twice or as --name=value, one that takes a value given none, or a word no option
 *  takes, such as a second fixture after --only's. */
function argumentProblem(args) {
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) return `"${a}" isn't an option or an option's value (--only takes its fixtures as one list: a,b)`;
    const name = a.slice(2).split('=')[0];
    if (!Object.hasOwn(OPTIONS, name)) return `${a} isn't an option this lane reads; it reads ${Object.keys(OPTIONS).map((o) => `--${o}`).join(', ')}`;
    if (a.includes('=')) return OPTIONS[name] ? `give --${name} its value as the next word, not after "="` : `--${name} takes no value`;
    if (seen.has(name)) return `${a} is given more than once`;
    seen.add(name);
    if (OPTIONS[name]) {
      if (!isValue(args[i + 1])) return `${a} needs a value${args[i + 1]?.startsWith('-') && !args[i + 1].startsWith('--') ? ` (a path starting with - can be given as ./${args[i + 1]})` : ''}`;
      i++;
    }
  }
  return null;
}

/** An option's value, or `def` when it's absent or given none, which the argument check
 *  then refuses, so nothing read here fails before that check can say why. */
const value = (name, def) => (isValue(opt(name)) ? opt(name) : def);

const STARTED_AT = new Date().toISOString();
// The lane's own workdir: a temp directory it makes, or one it makes inside the directory
// --workdir names, so nothing already there is ever touched. An empty --workdir, or one
// followed by another option (which the argument check refuses), is none.
const NAMED = value('workdir', null);
const KEEP = flag('keep');
const WORK = NAMED
  ? (mkdirSync(resolve(NAMED), { recursive: true }), mkdtempSync(join(resolve(NAMED), 'cache-write-')))
  : mkdtempSync(join(resolve(tmpdir()), 'connectome-smoke-cache-'));
const FIXTURES = resolve(value('fixtures', join(ROOT, 'fixtures', 'stores')));
// Given at all, --only must name fixtures: only separators name none.
const ONLY = ARGS.includes('--only') ? String(value('only', '')).split(',').map((s) => s.trim()).filter(Boolean) : null;
const BASE_BEFORE = value('base-before');
const REPORT = resolve(value('report', join(WORK, 'report.json')));
const SUMMARY = resolve(value('summary', join(WORK, 'summary.md')));
const SPECS = installSpecs({ base: value('base', '@animalabs/connectome-host@latest'), candidate: value('candidate'), baseBefore: BASE_BEFORE, startedAt: STARTED_AT });

const { report, step, log, t0 } = makeReport('cache-write', {
  workdir: WORK, fixtures: FIXTURES, base: SPECS.base.spec, baseBefore: SPECS.base.before, candidate: SPECS.candidate.spec, candidateBefore: SPECS.candidate.before, resolved: {}, verdicts: [],
});

/** Install `specs` into a new WORK/install-<name> as a consumer would, as npm's before
 *  filter takes `before`, which also overrides any npm_config_before the lane was started
 *  with. */
async function install(name, specs, before) {
  const dir = join(WORK, `install-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `connectome-smoke-cache-${name}`, private: true, version: '0.0.0', type: 'module' }, null, 2));
  const ok = await step(`install ${name}: ${specs.join(' ')} as of ${before}`, () => {
    // In this directory and nowhere else, whatever npm config the lane inherits.
    const r = sh('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', '--global=false', '--location=project', `--prefix=${dir}`, ...specs], { cwd: dir, timeout: 900_000, env: { npm_config_before: before } });
    report.resolved[name] = resolvedVersions(dir);
    return Object.entries(report.resolved[name]).map(([k, v]) => `${k.replace('@animalabs/', '')}@${v}`).join(' ') + '\n' + (r.stdout + r.stderr).trim().split('\n').slice(-2).join('\n');
  });
  if (!ok) report.fatal = `the ${name} install failed (its step says why)`;
  return ok;
}

(async () => {
  mkdirSync(WORK, { recursive: true });
  log(`workdir ${WORK}`);
  const problem = argumentProblem(ARGS);
  if (problem) { report.fatal = problem; log(`FATAL: ${problem}`); report.exitCode = 2; return done(); }
  if (!SPECS.candidate.spec) { log('FATAL: --candidate <spec or packed tarball> is required'); report.fatal = 'no candidate'; report.exitCode = 2; return done(); }
  // A directory given as a path or a bare file: spec, which npm would link rather than
  // install as a consumer gets it: the release has to be packed first. A scheme after a
  // package's name is npm's to resolve, as installSpecs leaves it.
  for (const [name, { spec }] of Object.entries(SPECS)) {
    const path = spec?.startsWith('file:') ? spec.slice('file:'.length) : spec;
    if (path?.startsWith('/') && statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
      report.fatal = `--${name} names a directory, ${path}; pack it first (npm pack) and give the .tgz`;
      log(`FATAL: ${report.fatal}`); report.exitCode = 2; return done();
    }
  }
  if (BASE_BEFORE !== undefined && Number.isNaN(Date.parse(BASE_BEFORE))) {
    report.fatal = `--base-before needs a time npm can read, such as 2026-10-18T21:00:00Z, not ${JSON.stringify(BASE_BEFORE)}`;
    log(`FATAL: ${report.fatal}`); report.exitCode = 2; return done();
  }
  const fixtures = listFixtures(FIXTURES).map((f) => f.version);
  const unknown = (ONLY ?? []).filter((v) => !fixtures.includes(v));
  if (!fixtures.length || unknown.length || ONLY?.length === 0) {
    report.fatal = !fixtures.length ? `no fixtures under ${FIXTURES}`
      : `--only names ${unknown.length ? `${unknown.join(', ')}, which has no fixture` : 'no fixture'} under ${FIXTURES} (it has ${fixtures.join(', ')})`;
    log(`FATAL: ${report.fatal}`); report.exitCode = 2; return done();
  }
  if (!await install('base', [SPECS.base.spec, '@animalabs/heartbeat-mcpl'], SPECS.base.before) || !await install('candidate', [SPECS.candidate.spec], SPECS.candidate.before)) { report.exitCode = 2; return done(); }
  const hostDir = (name) => join(WORK, `install-${name}`, 'node_modules', '@animalabs', 'connectome-host');
  const heartbeatEntry = join(WORK, 'install-base', 'node_modules', '@animalabs', 'heartbeat-mcpl', 'dist', 'src', 'index.js');
  const run = (label, name) => checkStores({ step: (n, fn, m) => step(`${label} ${n}`, fn, m), hostDir: hostDir(name), heartbeatEntry, work: join(WORK, label), fixturesDir: FIXTURES, only: ONLY });
  const base1 = await run('base-1', 'base');
  const base2 = await run('base-2', 'base');
  const candidate = await run('candidate', 'candidate');
  report.verdicts = compareRuns(base1, base2, candidate, ONLY ?? fixtures);
  // One step per fixture, so the summary's marks are the verdicts: a write found fails its
  // step, and a fixture the check couldn't judge is infra, as a stored fixture that can't
  // be checked is in the stores lane.
  for (const v of report.verdicts) {
    await step(`cache:${v.version}`, () => {
      const { ok, infra, message } = verdictStep(v);
      if (ok) return message;
      const e = new Error(message);
      if (infra) e.smokeInfra = true;
      throw e;
    });
  }
  report.exitCode = exitFor(report.verdicts);
  done();
})().catch((e) => { log(`FATAL ${e?.stack || e}`); report.fatal = String(e?.stack || e); report.exitCode = 2; done(); });

function done() {
  // By the code the process exits with: a passing run's default workdir keeps only its
  // report and summary, and any other keeps everything, as evidence.
  process.on('exit', (code) => {
    try { cleanupWorkdir({ code, work: WORK, made: !NAMED && !KEEP, keep: [REPORT, SUMMARY] }); }
    catch (e) { console.error(`[smoke:cache-write] couldn't clean ${WORK}, which stays: ${e?.message || e}`); }
  });
  const line = report.verdicts.length ? cacheLine(report.verdicts) : `Cache: couldn't tell (the check didn't reach a comparison${report.fatal ? `: ${report.fatal.split('\n')[0]}` : ''}).`;
  const side = (name) => {
    const r = report.resolved[name] ?? {};
    return `host ${r['@animalabs/connectome-host'] ?? '—'} (af ${r['@animalabs/agent-framework'] ?? '—'}, cm ${r['@animalabs/context-manager'] ?? '—'}, membrane ${r['@animalabs/membrane'] ?? '—'})`;
  };
  console.log(line);
  finish({
    report, t0, reportPath: REPORT, summaryPath: SUMMARY,
    headline: `base ${side('base')} · candidate ${side('candidate')} · heartbeat ${report.resolved.base?.['@animalabs/heartbeat-mcpl'] ?? '—'}`,
    extraLines: [line],
  });
}
