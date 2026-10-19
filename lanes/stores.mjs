#!/usr/bin/env node
/**
 * connectome-smoke — "stores" lane: boot a host on stores that earlier releases wrote.
 *
 * For each fixture under fixtures/stores/<version>/ (scripts/capture-store.mjs makes
 * them), copy its data directory, boot the host on the copy with the anthropic provider
 * against a local stand-in, and take one turn. A fixture passes only if the turn
 * completes and the request it sends carries both of the fixture's stored turns and
 * the heartbeat tools (lib/stores.mjs, checkStores).
 *
 *   node lanes/stores.mjs --host-dir <dir> --heartbeat <entry>   a host already built
 *   node lanes/stores.mjs [--host <spec>]                         install from npm (default latest)
 *   options: --fixtures <dir> (default fixtures/stores), --only <v1,v2>, --workdir <dir>, --keep,
 *            --report <file>, --summary <file>
 *
 * Exit 0 pass / 1 a fixture's boot failed / 2 couldn't run (a fixture unreadable, no
 * fixtures, an --only that names none or a name with none, or the host couldn't be
 * installed).
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReport, sh, finish, parseArgs } from '../lib/common.mjs';
import { checkStores, listFixtures, resolvedVersions } from '../lib/stores.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);
const { opt, flag } = parseArgs(ARGS);
const WORK = opt('workdir') ? resolve(opt('workdir')) : mkdtempSync(join(tmpdir(), 'connectome-smoke-stores-'));
const FIXTURES = resolve(opt('fixtures', join(ROOT, 'fixtures', 'stores')));
// Given at all, --only must name fixtures: with no value, or only separators, it names none.
const ONLY = ARGS.includes('--only') ? String(opt('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean) : null;
const KEEP = flag('keep');

const { report, step, log, t0 } = makeReport('stores', { workdir: WORK, fixtures: FIXTURES, resolved: {}, stores: [] });

(async () => {
  mkdirSync(WORK, { recursive: true });
  log(`workdir ${WORK}`);
  // Before any install: no fixtures, or an --only that names none or a name with none, can't run.
  const fixtures = listFixtures(FIXTURES).map((f) => f.version);
  const unknown = (ONLY ?? []).filter((v) => !fixtures.includes(v));
  if (!fixtures.length || unknown.length || ONLY?.length === 0) {
    report.fatal = !fixtures.length ? 'no fixtures'
      : `--only names ${unknown.length ? `${unknown.join(', ')}, which has no fixture` : 'no fixture'} under ${FIXTURES} (it has ${fixtures.join(', ')})`;
    log(`FATAL: ${report.fatal}${fixtures.length ? '' : ` under ${FIXTURES}`}`); report.exitCode = 2; return done();
  }
  let hostDir = opt('host-dir') ? resolve(opt('host-dir')) : null;
  let heartbeatEntry = opt('heartbeat') ? resolve(opt('heartbeat')) : null;
  if (!hostDir) {
    const installDir = join(WORK, 'install');
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'connectome-smoke-stores', private: true, version: '0.0.0', type: 'module' }, null, 2));
    const spec = opt('host', '@animalabs/connectome-host@latest');
    const ok = await step(`npm install ${spec}`, () => {
      const r = sh('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', spec, '@animalabs/heartbeat-mcpl@latest'], { cwd: installDir, timeout: 900_000 });
      report.resolved = resolvedVersions(installDir);
      return (r.stdout + r.stderr).trim().split('\n').slice(-2).join('\n');
    });
    if (!ok) { report.exitCode = 2; return done(); }
    hostDir = join(installDir, 'node_modules', '@animalabs', 'connectome-host');
    heartbeatEntry = join(installDir, 'node_modules', '@animalabs', 'heartbeat-mcpl', 'dist', 'src', 'index.js');
  } else if (!heartbeatEntry) {
    log('FATAL: --host-dir needs --heartbeat <heartbeat-mcpl entry>'); report.exitCode = 2; return done();
  }
  // Each result without the request it recorded, which only the cache-write lane reads.
  report.stores = (await checkStores({ step, hostDir, heartbeatEntry, work: WORK, fixturesDir: FIXTURES, only: ONLY }))
    .map(({ sent, ...result }) => result);
  const broke = report.stores.filter((s) => !s.ok && !s.couldNotRun);
  const couldNot = report.stores.filter((s) => s.couldNotRun);
  if (!broke.length && couldNot.length) report.exitCode = 2;
  done();
})().catch((e) => { log(`FATAL ${e?.stack || e}`); report.fatal = String(e?.stack || e); report.exitCode = 2; done(); });

function done() {
  if (!KEEP && !opt('workdir')) process.on('exit', () => { try { rmSync(WORK, { recursive: true, force: true }); } catch { /* noop */ } });
  const r = report.resolved;
  finish({
    report, t0, reportPath: opt('report', join(WORK, 'report.json')), summaryPath: opt('summary', join(WORK, 'summary.md')),
    headline: Object.keys(r).length ? `host ${r['@animalabs/connectome-host'] ?? '—'} · af ${r['@animalabs/agent-framework'] ?? '—'} · cm ${r['@animalabs/context-manager'] ?? '—'} · membrane ${r['@animalabs/membrane'] ?? '—'} · chronicle ${r['@animalabs/chronicle'] ?? '—'}` : `host at ${opt('host-dir')}`,
    extraLines: [`fixtures: ${report.stores.map((s) => `${s.version} ${s.ok ? '✓' : s.couldNotRun ? '?' : '✗'}`).join(', ') || 'none'}`],
  });
}
