#!/usr/bin/env node
/**
 * connectome-smoke — "source" lane: the stack's repositories from source.
 *
 * Main mode (no --change): every repository at `main`.
 * Change mode (--change <repo>=<spec>, repeatable): the changed repository at
 * its change merged onto `main`, every other repository at `main`. That's the
 * code a merge would leave on `main` everywhere.
 *
 *   1. Clone. Unchanged repositories shallowly; a changed one with its whole
 *      history (blobs fetched lazily), so `git merge-base` can answer. Each
 *      change is fetched (a pull request's head from the base repository's
 *      `refs/pull/<n>/head`, a branch from `<owner>`'s fork), checked against
 *      its pin, and merged with --no-ff, in the order given.
 *   2. Own tree, as each repository's own CI would see it: strict install
 *      (`npm ci` where a lockfile is committed), build. Then, for the changed
 *      repositories (every repository in main mode), typecheck and tests, and
 *      for the host its two starts on the mock provider. This is what a fleet
 *      box runs after the merge: it links only `file:` siblings, and takes the
 *      rest from npm through the lockfile or the declared ranges.
 *   3. Compose one tree: every stack package linked under a single
 *      <work>/src/node_modules/@animalabs root, every nested copy removed,
 *      chronicle from the host's npm install unless chronicle is the change.
 *      A resolution proof, run under node and under bun from each checkout,
 *      fails the run if any package resolves a stack dependency to anything
 *      but the checkout linked for it.
 *   4. Combined tree, in dependency order: for the changed packages and every
 *      package depending on them (every package in main mode) that has a
 *      stack dependency, build, typecheck and test against the other
 *      checkouts. The host is always checked: typecheck, its tests as its CI
 *      runs them (`scripts/test-on-tmpfs.sh`) and the two starts. The
 *      dependents come from each checkout's package.json, not a fixed table.
 *   5. Where the host is a change or one of its dependents, and always in
 *      main mode: the strategy fixture on the combined tree's host
 *      (lib/strategies/lane.mjs), which continues a cached deep store and
 *      judges the run. In change mode, when it fails something, the same run
 *      under each changed repository's `main` says whether `main` fails it too.
 *
 * Lanes (--lane I/N): lane I of a check split into N lanes runs every prep
 * step and only its own units of the plan, unit k in lane k mod N; a lane
 * with no units stops after its clones. lib/lanes.mjs states the contract a
 * fold of the lanes' reports rests on. No --lane is 0/1, the whole check.
 *
 * Output, in --out (default: the workdir): report.json, summary.md, and
 * logs/<step id>.log for every step. report.json is rewritten after every
 * step, so a run killed from outside leaves a partial report with no
 * `outcome`, which should be read as "couldn't run".
 *
 * Exit: 0 pass · 1 break (a step failed; a step's own timeout counts) ·
 *       2 error (the check couldn't run) · 3 conflict (a change doesn't merge
 *       cleanly onto main).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync, symlinkSync, readdirSync, readFileSync, writeFileSync, appendFileSync, realpathSync, renameSync, statfsSync } from 'node:fs';
import { tmpdir, homedir, release, cpus } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { makeReport, bootTwice, parseArgs, spawnToFiles } from '../lib/common.mjs';
import { checkStores, listFixtures } from '../lib/stores.mjs';
import { fileURLToPath as pathOfUrl } from 'node:url';
import { parseChange, satisfies, buildGraph, topoOrder, classifyInstallFailure, testFailureFields, diskFull, checkScope, typecheckCommand, testCommand, mergeCommand, startsBlocked } from '../lib/stack.mjs';
import { parseLane, planUnits, laneUnits, unrecordedUnits, outcomeOf } from '../lib/lanes.mjs';
import { check as strategiesCheck, cacheRoot as strategiesCacheRoot } from '../lib/strategies/lane.mjs';
import { configurations as strategyConfigurations } from '../lib/strategies/script.mjs';

const { opt, opts, flag } = parseArgs(process.argv.slice(2));
// The real path, so paths read back through realpath (links, resolutions) compare with it.
const WORK = (() => {
  const w = opt('workdir') ? resolve(opt('workdir')) : mkdtempSync(join(tmpdir(), 'connectome-smoke-source-'));
  mkdirSync(w, { recursive: true });
  return realpathSync(w);
})();
const OUT = resolve(opt('out', WORK));
const LOGS = join(OUT, 'logs');
const REPORT = resolve(opt('report', join(OUT, 'report.json')));
const SUMMARY = resolve(opt('summary', join(OUT, 'summary.md')));
const ORG = opt('org', 'anima-research');
const SRC = join(WORK, 'src');
const HOST = 'connectome-host';

/**
 * The stack's repositories, in an order where every `file:` sibling comes
 * before the package that links it. `pkgDirs`: a monorepo's packages, in
 * build order. `build`: the build command when it isn't `npm run build`.
 * `typecheck`: the fallback when the package has no `typecheck` script.
 * `testScript`: the script the repository's CI runs its tests with, run in
 * place of `npm test` where the checkout has it.
 * `onlyWhenChanged`: cloned only when it's the change (chronicle is Rust;
 * otherwise the host's npm copy is linked).
 */
const REPOS = [
  { repo: 'voice-kit',       dir: 'voice-kit' },
  { repo: 'mcpl-core-ts',    dir: 'mcpl-core-ts' },
  { repo: 'chronicle',       dir: 'chronicle', onlyWhenChanged: true },
  { repo: 'membrane',        dir: 'membrane', owner: 'antra-tess' },   // canonical home per the npm repository field
  { repo: 'context-manager', dir: 'context-manager' },
  { repo: 'agent-framework', dir: 'agent-framework', testScript: 'scripts/test-as-ci.mjs' },
  { repo: HOST,              dir: HOST, build: 'npm run build:web:ci', typecheck: 'npx tsc --noEmit -p tsconfig.json', testScript: 'scripts/test-on-tmpfs.sh' },
  { repo: 'mcpl-harness',    dir: 'mcpl-harness' },   // heartbeat-mcpl's reminders harness loads ../mcpl-harness/src/session.ts
  { repo: 'heartbeat-mcpl',  dir: 'heartbeat-mcpl' },
  { repo: 'discord-mcpl',    dir: 'discord-mcpl' },
  { repo: 'portal',          dir: 'portal', pkgDirs: ['portal-protocol', 'portal-client', 'portal-mcpl', 'portal-relay'] },
];

const LIMITS = [
  'The resolution proof runs under node and bun. vitest (membrane\'s tests) resolves through vite\'s resolver, which the proof does not cover.',
  'The combined tree links each main whatever range the dependent declares; `links` marks each link the declared range does not admit, where a combined failure may reflect an unreleased version rather than the change.',
  'chronicle comes from the host\'s npm install unless chronicle is the change or pinned with --main.',
  'The resolution proof writes .smoke-resolve.mjs into each checkout it probes and removes it afterwards; a run killed mid-probe leaves it in the work tree.',
  'Lanes share their prep steps but not each other\'s test side effects: a test that writes into a checkout changes only its own lane\'s later steps, and the lanes\' recorded commits can\'t show it.',
];

mkdirSync(LOGS, { recursive: true });
mkdirSync(SRC, { recursive: true });

const { report, step, skip, log, t0 } = makeReport('source', {
  mode: null, lanes: null, workdir: WORK, out: OUT, toolchain: toolchain(), change: [], repos: {}, packages: {},
  dependents: null, links: [], resolution: [], compose: null, limits: LIMITS, outcome: null, exitCode: null,
});
const flush = () => { try { writeFileSync(REPORT, JSON.stringify(report, null, 2)); } catch { /* best effort */ } };

// ------------------------------------------------------------------ helpers

const logFile = (id) => join(LOGS, `${id.replace(/[^A-Za-z0-9._-]+/g, '_')}.log`);
const rel = (p) => p.replace(WORK + sep, '');

/** An error a step records: `cause` and `infra` classify it, `fields` land on the step's record. */
function smokeError(message, { cause, infra, fields } = {}) {
  const e = new Error(message);
  if (cause) e.smokeCause = cause;
  if (infra) e.smokeInfra = true;
  if (fields) e.smokeFields = fields;
  return e;
}

/**
 * Run a command, appending its whole output to the step's log. A test step's
 * command runs through spawnToFiles: its output goes to files, so a runner
 * that ends itself still leaves all it wrote, what it leaves running is killed
 * and named here, and what it writes is bounded.
 */
function runCmd(id, cwd, argv, { timeout = 900_000, env = {}, test = false } = {}) {
  const [cmd, ...args] = Array.isArray(argv) ? argv : argv.split(' ');
  const options = { cwd, env: { ...process.env, CI: '1', FORCE_COLOR: '0', ...env }, timeout };
  const r = test ? spawnToFiles(cmd, args, options) : spawnSync(cmd, args, { ...options, encoding: 'utf-8', maxBuffer: 256 << 20 });
  const all = `${r.stdout ?? ''}${r.stderr ? `\n${r.stderr}` : ''}`;
  const after = test ? [
    ...r.leftovers.map((p) => `# still running when it exited, so killed: pid ${p.pid}, ${p.command}`),
    ...(r.leftoversChecked ? [] : ["# what it left running wasn't checked: no /proc here"]),
    ...(r.bounded ? [] : ["# what it wrote had no bound: prlimit wasn't found"]),
  ].map((line) => `${line}\n`).join('') : '';
  appendFileSync(logFile(id), `$ ${[cmd, ...args].join(' ')}\n# cwd ${cwd}\n${all}\n# exit ${r.status}${r.signal ? ` signal ${r.signal}` : ''}${r.error ? ` error ${r.error.code ?? r.error.message}` : ''}\n${after}\n`);
  return { ...r, all, cmdline: [cmd, ...args].join(' '), timedOut: r.error?.code === 'ETIMEDOUT' };
}

/**
 * Throw the step's failure, classified. A missing tool, a full disk, or a
 * SIGKILL it didn't time out on (the OOM killer, or someone outside) means
 * the check couldn't run. A full disk is read from the disk itself, the step's
 * directory's, the temp directory's and the home directory's, which holds
 * npm's and bun's caches, since a test can print ENOSPC on purpose
 * (diskFull). Any other signal, such as a crash, stays a break: the code
 * under test can cause it.
 */
function fail(r, cwd, extra = {}) {
  if (r.error?.code === 'ENOENT') throw smokeError(`\`${r.cmdline}\`: command not found`, { cause: 'toolchain', infra: true });
  if (diskFull(r.all, [cwd, tmpdir(), homedir()], statfsSync)) throw smokeError(`\`${r.cmdline}\`: the disk is full`, { cause: 'disk', infra: true });
  if (r.timedOut) throw smokeError(`\`${r.cmdline}\` in ${rel(cwd)} timed out`, { cause: 'timeout', ...extra });
  if (r.signal === 'SIGKILL') throw smokeError(`\`${r.cmdline}\` in ${rel(cwd)} was killed (SIGKILL) from outside`, { cause: 'killed', infra: true });
  if (r.error?.code === 'EFBIG') throw smokeError(`\`${r.cmdline}\` in ${rel(cwd)}: its output reached 256 MiB, where it was cut off`, extra);
  const lines = r.all.trim().split('\n');
  const interesting = lines.filter((l) => /error|fail|✗|not ok|Error:/i.test(l)).slice(-30);
  throw smokeError(`\`${r.cmdline}\` in ${rel(cwd)} exited ${r.status}${r.signal ? ` ${r.signal}` : ''}\n${(interesting.length ? interesting : lines.slice(-30)).join('\n')}`, extra);
}

function checked(id, cwd, argv, o) {
  const r = runCmd(id, cwd, argv, o);
  if (r.status !== 0 || r.error) fail(r, cwd);
  return r;
}

async function cmdStep(id, meta, cwd, argv, { timeout, summarize } = {}) {
  const ok = await step(`${id}: ${Array.isArray(argv) ? argv.join(' ') : argv}`, () => {
    const r = runCmd(id, cwd, argv, { timeout, test: meta.stage === 'test' });
    if (r.status !== 0 || r.error) {
      // A test step names its failing tests, so a known failure on main can
      // be told apart from a new one in the same step.
      if (meta.stage === 'test') fail(r, cwd, { fields: testFailureFields(r.all, { timedOut: r.timedOut }) });
      fail(r, cwd);
    }
    return summarize ? summarize(r) : 'ok';
  }, { id, ...meta, log: logFile(id) });
  flush();
  return ok;
}

function testSummary(r) {
  const s = r.all;
  const m = s.match(/# pass (\d+)[\s\S]*?# fail (\d+)/) || s.match(/(\d+) pass[\s\S]*?(\d+) fail/) || s.match(/Tests\s+(\d+) passed/);
  return m ? `${m[1]} pass${m[2] !== undefined ? `, ${m[2]} fail` : ''}` : 'ok';
}

function version(cmd, args = ['--version']) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8' });
  return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : null;
}

function toolchain() {
  return {
    node: process.version, bun: version('bun', ['-v']), npm: version('npm', ['-v']),
    git: version('git'), cargo: version('cargo'), platform: `${process.platform}-${process.arch}`,
    os: release(), cpus: cpus().length,
  };
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));
const realpathOr = (p) => { try { return realpathSync(p); } catch { return null; } };

// ------------------------------------------------------------------ the run

let CHANGES = [];
let PKGS = [];
let EDGES = [];
const MAINS = new Map();   // --main <repo>=<commit>: a repository's main pinned to that commit
let LANE = { index: 0, of: 1 };
let MY_UNITS = new Set();

(async () => {
  try { LANE = parseLane(flag('lane') ? opt('lane') ?? '' : undefined); }
  catch (e) { return fatal(e.message); }
  report.lanes = { ...LANE, plan: null, units: null };
  try { CHANGES = opts('change').map(parseChange); }
  catch (e) { return fatal(e.message); }
  for (const a of opts('main')) {
    const m = /^([A-Za-z0-9_.-]+)=([0-9a-f]{40})$/.exec(a);
    if (!m) return fatal(`--main ${a}: expected <repo>=<the full 40-character commit>`);
    if (!REPOS.some((r) => r.repo === m[1])) return fatal(`--main ${m[1]}: not a stack repository (${REPOS.map((r) => r.repo).join(', ')})`);
    MAINS.set(m[1], m[2]);
  }
  report.pinnedMains = Object.fromEntries(MAINS);
  report.mode = CHANGES.length ? 'change' : 'main';
  report.change = CHANGES.map((c) => ({ ...c, baseSha: null, headSha: null, mergeBase: null, mergeSha: null }));
  for (const c of CHANGES) {
    if (c.repo === 'mcpl') return fatal('mcpl is MCPL\'s spec repository: it holds no package in the stack, so it gets no run.');
    if (!REPOS.some((r) => r.repo === c.repo)) return fatal(`--change ${c.repo}: not a stack repository (${REPOS.map((r) => r.repo).join(', ')})`);
  }
  if (!report.toolchain.bun) return fatal('bun is not on PATH (the host runs under bun)');
  const changedRepos = new Set(CHANGES.map((c) => c.repo));
  // A pinned repository that is cloned only when it's the change (chronicle)
  // is cloned at its pin, so a baseline that pins it covers it.
  const cloneOnly = new Set([...changedRepos, ...MAINS.keys()]);
  if (cloneOnly.has('chronicle') && !report.toolchain.cargo) return fatal('cargo is not on PATH, and chronicle is built from source when it is the change or pinned');
  log(`workdir ${WORK} · out ${OUT} · ${report.mode}${CHANGES.length ? ': ' + CHANGES.map((c) => `${c.repo}=${c.spec}`).join(' ') : ''}`);
  flush();

  // -- 1. clone, and merge each change onto main --
  const cloned = [];
  for (const R of REPOS) {
    const changes = report.change.filter((c) => c.repo === R.repo);
    if (R.onlyWhenChanged && !cloneOnly.has(R.repo)) continue;
    const id = `${R.repo}:clone`;
    const ok = await step(`${R.repo}: clone main${changes.length ? `, merge ${changes.map((c) => c.spec).join(' then ')}` : ''}`,
      () => cloneRepo(R, changes, id), { id, repo: R.repo, stage: 'clone', log: logFile(id) });
    flush();
    if (!ok) return done();
    cloned.push(R);
  }

  // The packages, and the graph between them, as the checkouts declare it.
  for (const R of cloned) {
    for (const d of R.pkgDirs ?? ['.']) {
      const dir = join(SRC, R.dir, d);
      const pj = readJson(join(dir, 'package.json'));
      PKGS.push({ key: d === '.' ? R.repo : `${R.repo}/${d}`, repo: R.repo, R, dir, name: pj.name, version: pj.version, pj });
    }
  }
  EDGES = buildGraph(PKGS);
  const hasStackDeps = new Set(EDGES.map((e) => e.dependent));
  const changedKeys = PKGS.filter((p) => changedRepos.has(p.repo)).map((p) => p.key);
  const { dependents: deps, ownSet, combinedSet, reachesHost } = checkScope({ keys: PKGS.map((p) => p.key), changedKeys, edges: EDGES, mode: report.mode, host: HOST });
  report.dependents = deps;
  // `changed`: whether the package's repository is a change. In change mode
  // an unchanged package's own install and build take nothing from the
  // change, so their failure is main's or the machine's, not the change's.
  const pkgMeta = (p, tree, stage) => ({ repo: p.repo, pkg: p.key, tree, stage, changed: changedRepos.has(p.repo) });
  const script = (p, name) => p.pj.scripts?.[name];
  const testCmd = (p) => testCommand(p, (file) => existsSync(join(p.dir, file)));
  const order = topoOrder(PKGS.map((p) => p.key), EDGES);
  const plan = planUnits({ pkgs: PKGS, order, edges: EDGES, ownSet, combinedSet, host: HOST, checks: (p) => !!(typecheckCommand(p) || testCmd(p)) });
  const units = laneUnits(plan, LANE);
  MY_UNITS = new Set(units);
  report.lanes = { ...LANE, plan, units };
  const workMeta = (p, tree, stage, unit) => ({ ...pkgMeta(p, tree, stage), unit });
  flush();
  if (!units.length) { log(`lane ${LANE.index}/${LANE.of}: no units of the plan's ${plan.length}, so nothing past the clones`); return done(); }

  // -- 2. own tree: install and build everything, check what changed --
  const installed = new Set();
  for (const p of PKGS) {
    const id = `${p.key}:install`;
    const lock = existsSync(join(p.dir, 'package-lock.json'));
    const cmd = lock ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund';
    const entry = report.packages[p.key] = {
      name: p.name, version: p.version, repo: p.repo,
      lockfile: lock ? 'package-lock.json' : existsSync(join(p.dir, 'bun.lock')) ? 'bun.lock only (npm resolves at run time)' : 'none (npm resolves at run time)',
      lockfileSha256: lock ? sha256(join(p.dir, 'package-lock.json')) : null, install: cmd,
    };
    const ok = await step(`${p.key}: ${cmd}`, () => {
      const r = runCmd(id, p.dir, cmd);
      if (r.status !== 0 || r.error) fail(r, p.dir, r.all.trim() ? classifyInstallFailure(r.all) : { cause: 'no-output', infra: true });
      if (!lock) entry.resolved = topLevelVersions(p.dir, id);
      return lock ? 'from the lockfile' : 'resolved at run time';
    }, { id, ...pkgMeta(p, 'own', 'install'), log: logFile(id) });
    flush();
    if (ok) installed.add(p.key);
  }
  for (const R of cloned) {
    const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: join(SRC, R.dir), encoding: 'utf-8' });
    report.repos[R.repo].installChangedTracked = (r.stdout ?? '').split('\n').filter(Boolean);
  }

  for (const p of PKGS) {
    const cmd = p.R.build ?? (script(p, 'build') ? 'npm run build' : null);
    if (!cmd) continue;
    const id = `${p.key}:own:build`;
    if (!installed.has(p.key)) { skip(`${id}: ${cmd}`, 'its install failed', { id, ...pkgMeta(p, 'own', 'build') }); continue; }
    await cmdStep(id, pkgMeta(p, 'own', 'build'), p.dir, cmd);
  }

  for (const p of PKGS.filter((x) => ownSet.has(x.key) && MY_UNITS.has(`${x.key}:own`))) {
    const unit = `${p.key}:own`;
    for (const [stage, cmd, timeout] of [['typecheck', typecheckCommand(p), 600_000], ['test', testCmd(p), 1_200_000]]) {
      if (!cmd) continue;
      const id = `${p.key}:own:${stage}`;
      if (!installed.has(p.key)) { skip(`${id}: ${cmd}`, 'its install failed', { id, ...workMeta(p, 'own', stage, unit) }); continue; }
      await cmdStep(id, workMeta(p, 'own', stage, unit), p.dir, cmd, { timeout, summarize: stage === 'test' ? testSummary : undefined });
    }
  }
  const hostPkg = PKGS.find((p) => p.key === HOST);
  const heartbeatEntry = join(SRC, 'heartbeat-mcpl', 'dist', 'src', 'index.js');
  if (ownSet.has(HOST) && MY_UNITS.has(`${HOST}:own`)) await boots(hostPkg, 'own', installed, heartbeatEntry, false, `${HOST}:own`);

  // -- 3. compose one tree --
  const composed = await step('compose: link every stack package under one @animalabs root', () => compose(),
    { id: 'compose:link', stage: 'compose', log: logFile('compose:link') });
  flush();
  if (!composed) { skip('compose: resolution proof', 'compose failed', { id: 'compose:resolution', stage: 'compose' }); return done(); }
  const resolved = await step('compose: every package resolves its stack dependencies to the linked checkouts, under node and bun',
    () => resolutionProof(), { id: 'compose:resolution', stage: 'compose', log: logFile('compose:resolution') });
  flush();
  if (!resolved) return done();

  // -- 4. combined tree: the changed packages and their dependents, in dependency order --
  for (const key of order) {
    const p = PKGS.find((x) => x.key === key);
    if (!combinedSet.has(key) || !hasStackDeps.has(key)) continue;
    const unit = `${key}:combined`;
    const stages = [
      ['build', script(p, 'build') ? 'npm run build' : null, 900_000],
      ...(MY_UNITS.has(unit) ? [['typecheck', typecheckCommand(p), 600_000], ['test', testCmd(p), 1_200_000]] : []),
    ];
    for (const [stage, cmd, timeout] of stages) {
      if (!cmd) continue;
      const id = `${key}:combined:${stage}`;
      const meta = stage === 'build' ? pkgMeta(p, 'combined', stage) : workMeta(p, 'combined', stage, unit);
      if (!installed.has(key)) { skip(`${id}: ${cmd}`, 'its install failed', { id, ...meta }); continue; }
      await cmdStep(id, meta, p.dir, cmd, { timeout, summarize: stage === 'test' ? testSummary : undefined });
    }
  }
  if (MY_UNITS.has(`${HOST}:starts`)) await boots(hostPkg, 'combined', installed, heartbeatEntry, reachesHost, `${HOST}:starts`);
  done();
})().catch((e) => { log(`FATAL ${e?.stack || e}`); report.fatal = String(e?.stack || e); done(); });

// ------------------------------------------------------------------ stages

function cloneRepo(R, changes, id) {
  const url = `https://github.com/${R.owner ?? ORG}/${R.repo}.git`;
  const dst = join(SRC, R.dir);
  const git = (args, cause = 'git') => {
    const r = runCmd(id, dst, ['git', ...args], { timeout: 300_000 });
    if (r.status !== 0 || r.error) fail(r, dst, { cause, infra: true });
    return r.stdout.trim();
  };
  const pin = MAINS.get(R.repo);
  if (pin && !changes.length) {
    // Exactly the commit asked for, and nothing else: GitHub serves a fetch by full commit id.
    const r = runCmd(id, SRC, ['git', 'init', '--quiet', dst]);
    if (r.status !== 0 || r.error) fail(r, SRC, { cause: 'clone', infra: true });
    git(['remote', 'add', 'origin', url]);
    fetchPin(['--depth', '1']);
    git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  } else {
    // A changed repository gets its whole history (blobs on demand), pinned
    // or not, so the merge below has its merge base.
    const cloneArgs = changes.length ? ['--filter=blob:none'] : ['--depth', '1'];
    const r = runCmd(id, SRC, ['git', 'clone', '--quiet', ...cloneArgs, '--branch', 'main', url, dst], { timeout: 300_000 });
    if (r.status !== 0 || r.error) fail(r, SRC, { cause: 'clone', infra: true });
    if (pin) {
      if (runCmd(id, dst, ['git', 'cat-file', '-e', `${pin}^{commit}`]).status !== 0) fetchPin([]);
      git(['checkout', '--quiet', '--detach', pin]);
    }
  }
  function fetchPin(extra) {
    const f = runCmd(id, dst, ['git', 'fetch', '--quiet', ...extra, 'origin', pin], { timeout: 300_000 });
    if (f.status !== 0 || f.error) {
      throw smokeError(`--main ${R.repo}=${pin}: ${R.owner ?? ORG}/${R.repo} would not serve that commit (main force-pushed past it, or not a commit of this repository)`, { cause: 'pin', infra: true });
    }
  }
  const main = git(['rev-parse', 'HEAD']);
  const merged = [];
  for (const [i, c] of changes.entries()) {
    const ref = `refs/smoke/change-${i}`;
    if (c.kind === 'pull') git(['fetch', '--quiet', 'origin', `+refs/pull/${c.pr}/head:${ref}`], 'fetch');
    else git(['fetch', '--quiet', `https://github.com/${c.owner}/${R.repo}.git`, `+refs/heads/${c.branch}:${ref}`], 'fetch');
    c.headSha = git(['rev-parse', ref]);
    if (c.pin && !c.headSha.startsWith(c.pin)) {
      throw smokeError(`${c.spec} has moved: pinned ${c.pin}, its head is now ${c.headSha.slice(0, 12)}`, { cause: 'moved', infra: true });
    }
    c.baseSha = git(['rev-parse', 'HEAD']);
    const mb = runCmd(id, dst, ['git', 'merge-base', 'HEAD', c.headSha]);
    if (mb.status !== 0) throw smokeError(`no merge base between ${merged.length ? 'main + ' + merged.join(' + ') : 'main'} and ${c.spec} (${c.headSha.slice(0, 12)})`, { cause: 'merge-base', infra: true });
    c.mergeBase = mb.stdout.trim();
    const merge = mergeCommand(c.spec, c.headSha, git(['log', '-1', '--format=%cI', c.headSha]));
    const m = runCmd(id, dst, merge.argv, { env: merge.env });
    if (m.status !== 0) {
      const files = runCmd(id, dst, ['git', 'diff', '--name-only', '--diff-filter=U']).stdout.trim().split('\n').filter(Boolean);
      runCmd(id, dst, ['git', 'merge', '--abort']);
      const against = merged.length ? `main + ${merged.join(' + ')}` : 'main';
      report.conflict = { repo: R.repo, change: c.spec, against, files };
      throw smokeError(`${c.spec} doesn't merge cleanly onto ${against}${files.length ? `: conflicts in ${files.join(', ')}` : ''}`, { cause: 'conflict' });
    }
    c.mergeSha = git(['rev-parse', 'HEAD']);
    merged.push(c.spec);
  }
  const [sha, date, subject] = git(['log', '-1', '--format=%H%n%cI%n%s']).split('\n');
  report.repos[R.repo] = { sha, main, pinned: !!pin, date, subject, changed: changes.length > 0, home: `${R.owner ?? ORG}/${R.repo}` };
  return changes.length
    ? `main ${main.slice(0, 12)}; ${changes.map((c) => `${c.spec} ${c.headSha.slice(0, 12)}`).join(', ')} → ${sha.slice(0, 12)}`
    : `${sha.slice(0, 12)} ${subject.slice(0, 70)}`;
}

/** What npm resolved for a package without a lockfile, so two runs can be compared. */
function topLevelVersions(dir, id) {
  const r = runCmd(id, dir, ['npm', 'ls', '--depth=0', '--json'], { timeout: 120_000 });
  try {
    const tree = JSON.parse(r.stdout);
    return Object.fromEntries(Object.entries(tree.dependencies ?? {}).map(([n, d]) => [n, d.version ?? d.resolved ?? null]));
  } catch { return null; }
}

/** Link every stack package under one root, remove every nested copy, and record each link against its declared range. */
function compose() {
  const id = 'compose:link';
  const root = join(SRC, 'node_modules', '@animalabs');
  mkdirSync(root, { recursive: true });
  const provided = new Map();
  for (const p of PKGS) if (p.name?.startsWith('@animalabs/')) provided.set(p.name, realpathSync(p.dir));
  if (!provided.has('@animalabs/chronicle')) {   // not cloned: link the host's npm copy
    const chr = join(SRC, HOST, 'node_modules', '@animalabs', 'chronicle');
    if (!existsSync(chr)) throw smokeError(`the host's install has no @animalabs/chronicle to link (${rel(chr)})`);
    provided.set('@animalabs/chronicle', realpathSync(chr));
  }
  for (const [name, target] of provided) {
    const link = join(root, name.slice('@animalabs/'.length));
    rmSync(link, { recursive: true, force: true });
    symlinkSync(target, link);
  }
  const keep = new Set(provided.values());
  const removed = [];
  for (const p of PKGS) {
    const nm = join(p.dir, 'node_modules', '@animalabs');
    if (!existsSync(nm)) continue;
    for (const d of readdirSync(nm)) {
      const full = join(nm, d);
      if (!provided.has(`@animalabs/${d}`)) continue;
      // The npm chronicle the root links to stays, and so does a `file:`
      // link, which already points at the checkout the root provides.
      if (keep.has(realpathOr(full))) continue;
      rmSync(full, { recursive: true, force: true });
      removed.push(`${p.key}/node_modules/@animalabs/${d}`);
    }
  }
  const versionOf = (name) => { try { return readJson(join(provided.get(name), 'package.json')).version; } catch { return null; } };
  for (const p of PKGS) {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const [name, declared] of Object.entries(p.pj[field] ?? {})) {
        if (!provided.has(name)) continue;
        const linked = versionOf(name);
        report.links.push({ dependent: p.key, dep: name, field, declared, linked, target: rel(provided.get(name)), admits: satisfies(linked, declared) });
      }
    }
  }
  report.compose = { root: rel(root), provided: Object.fromEntries([...provided].map(([n, t]) => [n, rel(t)])), removed };
  appendFileSync(logFile(id), `${JSON.stringify(report.compose, null, 2)}\n`);
  const outOfRange = report.links.filter((l) => l.admits === false);
  return `${provided.size} packages linked, ${removed.length} nested copies removed`
    + (outOfRange.length ? `; ${outOfRange.length} links outside the declared range (see links)` : '');
}

const PROBE = `import { realpathSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
const out = {};
for (const d of JSON.parse(process.argv[2])) {
  let how = 'import.meta.resolve', path = null, err = null;
  try { const u = String(import.meta.resolve(d)); path = u.startsWith('file:') ? fileURLToPath(u) : u; }
  catch (e) { err = String(e?.code ?? e?.message ?? e); }
  if (path) { try { path = realpathSync(path); } catch (e) { err = 'resolved to a missing file: ' + path; path = null; } }
  if (!path) {
    how = 'node_modules lookup';
    for (let dir = process.cwd(); ; dir = dirname(dir)) {
      const c = join(dir, 'node_modules', d);
      if (existsSync(c)) { path = realpathSync(c); break; }
      if (dirname(dir) === dir) break;
    }
  }
  out[d] = { how, path, err };
}
console.log(JSON.stringify(out));
`;

/** From each checkout, under node and under bun, resolve each declared stack dependency; fail if any lands outside the checkout linked for it. */
function resolutionProof() {
  const id = 'compose:resolution';
  const provided = new Map(Object.entries(report.compose.provided).map(([n, t]) => [n, join(WORK, t)]));
  const wrong = [];
  for (const p of PKGS) {
    const want = [...new Set(['dependencies', 'devDependencies', 'peerDependencies'].flatMap((f) => Object.keys(p.pj[f] ?? {})))].filter((n) => provided.has(n));
    if (!want.length) continue;
    const probe = join(p.dir, '.smoke-resolve.mjs');
    writeFileSync(probe, PROBE);
    try {
      for (const rt of ['node', 'bun']) {
        const r = runCmd(id, p.dir, [rt, '.smoke-resolve.mjs', JSON.stringify(want)], { timeout: 60_000 });
        let res = {};
        try { res = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* recorded below as unresolved */ }
        for (const dep of want) {
          const expected = provided.get(dep);
          const got = res[dep] ?? { how: null, path: null, err: r.status !== 0 ? `probe exited ${r.status}` : 'no answer' };
          const ok = !!got.path && (got.path === expected || got.path.startsWith(expected + sep));
          report.resolution.push({ pkg: p.key, dep, runtime: rt, how: got.how, resolved: got.path ? rel(got.path) : null, expected: rel(expected), ok, err: got.err ?? undefined });
          if (!ok) wrong.push(`${p.key} → ${dep} under ${rt}: ${got.path ? rel(got.path) : `unresolved (${got.err})`}, expected ${rel(expected)}`);
        }
      }
    } finally { rmSync(probe, { force: true }); }
  }
  if (wrong.length) throw smokeError(`${wrong.length} resolutions outside the linked checkouts:\n${wrong.join('\n')}`);
  const pkgs = new Set(report.resolution.map((x) => x.pkg)).size;
  return `${report.resolution.length} resolutions from ${pkgs} packages, all to the linked checkouts`;
}

// Stores that earlier host releases wrote: checked on the combined tree's host, the tree every change is in.
const STORE_FIXTURES = pathOfUrl(new URL('../fixtures/stores', import.meta.url));

async function boots(hostPkg, tree, installed, heartbeatEntry, strategies, unit) {
  const meta = { idPrefix: `${HOST}:${tree}`, repo: HOST, pkg: HOST, tree, unit };
  const label = `${HOST}-${tree}-boot-`;
  const fixtures = tree === 'combined' ? listFixtures(STORE_FIXTURES) : [];
  const skipStores = (why) => {
    for (const f of fixtures) skip(`stores:${f.version}`, why, { ...meta, id: `${meta.idPrefix}:stores:${f.version}`, stage: `stores:${f.version}` });
  };
  const strategiesMeta = { repo: HOST, pkg: HOST, tree, unit, id: `${meta.idPrefix}:strategies:${STRATEGIES}`, stage: `strategies:${STRATEGIES}` };
  const skipStrategies = (why) => { if (strategies) skip(`${HOST} ${tree} strategy fixture`, why, strategiesMeta); };
  const blocked = startsBlocked({
    hostCheckout: !!hostPkg, hostInstalled: installed.has(HOST),
    heartbeatEntry: { exists: existsSync(heartbeatEntry), path: rel(heartbeatEntry) },
    heartbeatBuildFailed: report.steps.some((s) => s.pkg === 'heartbeat-mcpl' && (s.stage === 'install' || s.stage === 'build') && s.status !== 'pass'),
  });
  if (blocked) {
    const { why } = blocked;
    for (const n of [1, 2]) {
      const bootMeta = { ...meta, id: `${meta.idPrefix}:boot-${n}`, stage: `boot-${n}` };
      if (n === 1 && blocked.fail) await step(`${HOST} ${tree} boot #1`, () => { throw smokeError(why); }, bootMeta);
      else skip(`${HOST} ${tree} boot #${n}`, why, bootMeta);
    }
    skipStores(why);
    skipStrategies(why);
    flush();
    return;
  }
  const booted = await bootTwice({ step, skip, hostDir: hostPkg.dir, heartbeatEntry, work: LOGS, dataDir: join(WORK, `data-${tree}`), label, meta });
  flush();
  if (fixtures.length) {
    if (!booted) skipStores(`the host's ${tree} boots failed`);
    else await checkStores({ step, hostDir: hostPkg.dir, heartbeatEntry, work: join(LOGS, 'stores'), fixturesDir: STORE_FIXTURES, meta });
    flush();
  }
  if (!strategies) return;
  if (!booted) { skipStrategies(`the host's ${tree} boots failed`); flush(); return; }
  await strategiesStep(hostPkg, strategiesMeta);
  flush();
}

// ------------------------------------------------------------------ the strategy fixture

/** The configuration a check runs; full runs, with the others, are lanes/strategies.mjs's. */
const STRATEGIES = 'default';

/**
 * The strategy fixture on the combined tree's host. A flag, or a product the base produced
 * and the candidate didn't, fails the step, with each named in `failures` the same way
 * from run to run, for the known red list. A fixture that couldn't run, or anything the
 * fixture throws, fails it as a check that couldn't run. Its runs' logs, stand-in records
 * and report go to logs/strategies/.
 */
async function strategiesStep(hostPkg, meta) {
  const id = meta.id;
  await step(`${id}: the strategy fixture continues its cached deep store`, async () => {
    let res;
    try {
      res = await strategiesCheck({
        cacheRoot: strategiesCacheRoot(opt('strategies-cache')),
        configuration: strategyConfigurations()[STRATEGIES],
        hostDir: hostPkg.dir,
        installDir: SRC,
        work: join(WORK, 'strategies'),
        evidence: join(LOGS, 'strategies'),
        base: report.mode === 'change' ? (runBase) => strategiesBase(id, hostPkg, runBase) : null,
      });
      appendFileSync(logFile(id), `${(res.report?.lines ?? [res.reason]).join('\n')}\n`);
    } catch (e) {
      throw smokeError(`the strategy fixture couldn't run: ${String(e?.stack || e).slice(0, 3000)}`, { cause: 'strategies', infra: true });
    }
    if (res.outcome === 'couldnt-run') throw smokeError(`the strategy fixture couldn't run: ${res.reason}`, { cause: 'strategies', infra: true });
    if (res.outcome !== 'pass') {
      throw smokeError(res.report.lines.join('\n'), { fields: { failures: res.failures, failureCount: res.failures.length, failuresParsed: true } });
    }
    return res.report.lines.join(' ');
  }, { ...meta, log: logFile(id) });
}

/**
 * The fixture's base, for a change: each changed repository at its `main`, in a worktree
 * beside its checkout, installed with its own install's command and with compose's rule for
 * nested copies, and built in dependency order as its own tree builds, by the worktree's own
 * package.json (the host runs from its source, so it isn't built). The composed root's links point at it for the base run
 * only, and back however that ends. Before the run, the base's host must resolve each
 * package swapped in to its worktree, under bun, as the resolution proof checks.
 */
async function strategiesBase(id, hostPkg, runBase) {
  const t0 = Date.now();
  const root = join(SRC, 'node_modules');
  const provided = new Map(Object.entries(report.compose.provided).map(([n, t]) => [n, join(WORK, t)]));
  const based = new Map(provided);
  const built = [];
  for (const repo of new Set(report.change.map((c) => c.repo))) {
    const R = REPOS.find((r) => r.repo === repo);
    const checkout = join(SRC, R.dir);
    const worktree = join(SRC, `${R.dir}.base`);
    checked(id, checkout, ['git', 'worktree', 'add', '--detach', worktree, report.repos[repo].main], { timeout: 300_000 });
    for (const p of PKGS.filter((x) => x.repo === repo)) {
      const dir = join(worktree, relative(checkout, p.dir));
      checked(id, dir, existsSync(join(dir, 'package-lock.json')) ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund');
      if (p.name?.startsWith('@animalabs/')) based.set(p.name, dir);
      built.push({ p, dir });
    }
  }
  const baseHost = built.find(({ p }) => p.key === HOST)?.dir ?? hostPkg.dir;
  if (!PKGS.some((p) => p.name === '@animalabs/chronicle') && baseHost !== hostPkg.dir) {
    based.set('@animalabs/chronicle', realpathSync(join(baseHost, 'node_modules', '@animalabs', 'chronicle')));
  }
  const keep = new Set([...based.values()].map(realpathOr));
  for (const { dir } of built) {
    const nm = join(dir, 'node_modules', '@animalabs');
    if (!existsSync(nm)) continue;
    for (const d of readdirSync(nm)) {
      const full = join(nm, d);
      if (based.has(`@animalabs/${d}`) && !keep.has(realpathOr(full))) rmSync(full, { recursive: true, force: true });
    }
  }
  const swapped = [...based].filter(([name, dir]) => provided.get(name) !== dir);
  const point = (name, target) => {
    const link = join(root, name);
    rmSync(`${link}.swap`, { force: true });
    symlinkSync(target, `${link}.swap`);
    renameSync(`${link}.swap`, link);
  };
  try {
    for (const [name, dir] of swapped) point(name, dir);
    const order = topoOrder(PKGS.map((p) => p.key), EDGES);
    for (const { p, dir } of [...built].sort((a, b) => order.indexOf(a.p.key) - order.indexOf(b.p.key))) {
      if (p.key === HOST) continue;
      const cmd = p.R.build ?? (readJson(join(dir, 'package.json')).scripts?.build ? 'npm run build' : null);
      if (cmd) checked(id, dir, cmd, { timeout: 900_000 });
    }
    const want = swapped.map(([name]) => name);
    const probe = join(baseHost, '.smoke-resolve.mjs');
    writeFileSync(probe, PROBE);
    let res = {};
    try {
      const r = runCmd(id, baseHost, ['bun', '.smoke-resolve.mjs', JSON.stringify(want)], { timeout: 60_000 });
      try { res = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* each name is then unresolved */ }
    } finally { rmSync(probe, { force: true }); }
    const wrong = want.filter((name) => { const got = res[name]?.path; const dir = realpathSync(based.get(name)); return !got || !(got === dir || got.startsWith(dir + sep)); });
    if (wrong.length) throw new Error(`the base's host doesn't resolve ${wrong.map((n) => `${n} (to ${res[n]?.path ? rel(res[n].path) : 'nothing'})`).join(', ')} to the base`);
    const prepMs = Date.now() - t0;
    const side = await runBase({ hostDir: baseHost, installDir: SRC });
    return side.couldnt ? side : { ...side, prepMs, swapped: want };
  } finally {
    for (const [name] of swapped) point(name, provided.get(name));
  }
}

// ------------------------------------------------------------------ verdict

function fatal(message) {
  log(`FATAL ${message}`);
  report.fatal = message;
  done();
}

function outcome() {
  const { outcome: o, unjudged } = outcomeOf({ mode: report.mode, fatal: report.fatal, steps: report.steps });
  if (unjudged) report.unjudged = unjudged;
  return o;
}

function done() {
  if (report.lanes?.units) {
    const why = report.fatal ? 'the lane stopped at a fatal error' : `the lane stopped at ${report.steps.findLast((s) => s.status === 'fail')?.id ?? 'a step that failed'}`;
    for (const unit of unrecordedUnits(report.lanes.units, report.steps)) skip(`${unit}: not run`, why, { id: `${unit}:not-run`, stage: 'not-run', unit });
  }
  const o = outcome();
  const code = { pass: 0, break: 1, error: 2, conflict: 3 }[o];
  report.finishedAt = new Date().toISOString();
  report.outcome = o;
  report.exitCode = code;
  report.pass = o === 'pass';
  flush();
  const verdict = { pass: '✅ PASS', break: '❌ BREAK', error: '⚠️ ERROR (the check couldn\'t run)', conflict: '⛔ CONFLICT' }[o];
  const short = (repo) => (report.repos[repo]?.sha ?? '—').slice(0, 7);
  const lines = [
    `**connectome-smoke · source** — ${verdict} (${((Date.now() - t0) / 1000).toFixed(0)}s, ${report.platform}, node ${report.node}, bun ${report.bun})`,
    report.mode === null ? 'the arguments were refused'
    : report.mode === 'change'
      ? `change: ${report.change.map((c) => `${c.repo} ${c.spec} ${c.headSha?.slice(0, 7) ?? '?'} onto ${c.baseSha?.slice(0, 7) ?? '?'}${c.mergeSha ? ` → ${c.mergeSha.slice(0, 7)}` : ''}`).join(' · ')}`
        + (report.dependents ? ` · dependents: ${report.dependents.map((d) => d.pkg).join(', ') || 'none'}` : '')
      : `main: host ${short(HOST)} · af ${short('agent-framework')} · cm ${short('context-manager')} · membrane ${short('membrane')} · mcpl-core ${short('mcpl-core-ts')} · heartbeat ${short('heartbeat-mcpl')} · discord-mcpl ${short('discord-mcpl')} · portal ${short('portal')} · voice-kit ${short('voice-kit')}`,
  ];
  if (report.lanes?.plan) lines.push(`lane ${report.lanes.index}/${report.lanes.of}: ${report.lanes.units.length ? report.lanes.units.join(', ') : 'no units'} (the plan has ${report.lanes.plan.length})`);
  if (report.fatal) lines.push(`fatal: ${report.fatal.split('\n')[0]}`);
  if (report.unjudged) lines.push(`the change couldn't be judged: unchanged packages failed in their own install or build, which take nothing from the change: ${report.unjudged.join(', ')}`);
  if (report.conflict) lines.push(`✗ conflict: ${report.conflict.change} onto ${report.conflict.against}: ${report.conflict.files.join(', ') || '(no file list)'}`);
  const failed = report.steps.filter((s) => s.status === 'fail');
  for (const s of failed) lines.push(`✗ ${s.id ?? s.name}${s.cause ? ` [${s.cause}]` : ''} — ${s.detail.split('\n')[0].slice(0, 300)}${s.log ? ` (${s.log.replace(OUT + sep, '')})` : ''}`);
  const outOfRange = report.links.filter((l) => l.admits === false);
  if (outOfRange.length) lines.push(`links outside the declared range: ${outOfRange.map((l) => `${l.dependent} → ${l.dep.replace('@animalabs/', '')} ${l.declared} (linked ${l.linked})`).join(', ')}`);
  for (const s of report.steps) {
    if (s.status === 'fail') continue;
    lines.push(`${s.status === 'skip' ? '–' : '✓'} ${s.id ?? s.name}${s.status === 'skip' ? ` (skipped: ${s.detail})` : s.detail ? ` — ${s.detail.split('\n')[0].slice(0, 120)}` : ''}`);
  }
  writeFileSync(SUMMARY, lines.join('\n') + '\n');
  console.log(`[smoke:source] report → ${REPORT}`);
  console.log(`[smoke:source] RESULT: ${o.toUpperCase()} (exit ${code})`);
  process.exit(code);
}
