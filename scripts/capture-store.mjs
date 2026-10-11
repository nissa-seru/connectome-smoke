#!/usr/bin/env node
/**
 * Capture fixtures for the stored-store check: the data directory a published host
 * release leaves after two turns, with its provenance (lib/stores.mjs, captureStore).
 *
 *   node scripts/capture-store.mjs --version 0.9.0 [--before <ISO time>] [--out <dir>]
 *   node scripts/capture-store.mjs --missing      every published release without a fixture
 *   common options: [--workdir <dir>] [--keep]
 *
 * --before defaults to one second before the next host release was published, so the
 * dependencies resolve to the newest set a consumer of this release could have had while
 * it was `latest`; for the newest release, to now. --out defaults to
 * fixtures/stores/<version>. A capture that doesn't complete both turns writes no
 * fixture. Exit 0 when every capture asked for completed; 1 if one didn't; 2 if the run
 * couldn't start (no such release, the registry unreachable).
 *
 * On a machine that got a copy of this repository without .git, set SMOKE_COMMIT so the
 * provenance names the code that captured it.
 */
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReport, sh, finish, parseArgs } from '../lib/common.mjs';
import { captureStore } from '../lib/stores.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'fixtures', 'stores');
const { opt, flag } = parseArgs(process.argv.slice(2));
const VERSION = opt('version');
const MISSING = flag('missing');
if (!VERSION && !MISSING) {
  console.error('usage: capture-store.mjs --version <host version> [--before ISO] [--out DIR] | --missing   [--workdir DIR] [--keep]');
  process.exit(2);
}
const WORK = opt('workdir') ? resolve(opt('workdir')) : mkdtempSync(join(tmpdir(), 'connectome-smoke-capture-'));
const KEEP = flag('keep');
mkdirSync(WORK, { recursive: true });

const { report, step, log, t0 } = makeReport('capture', { workdir: WORK, captures: [] });

function publishTimes() {
  const r = sh('npm', ['view', '@animalabs/connectome-host', 'time', '--json'], { cwd: WORK, timeout: 120_000 });
  const t = JSON.parse(r.stdout);
  delete t.created; delete t.modified;
  return t;
}

/** One second before the next release was published, or now for the newest. */
function beforeFor(version, times) {
  const mine = times[version];
  if (!mine) throw new Error(`@animalabs/connectome-host@${version} is not published`);
  const later = Object.values(times).filter((t) => t > mine).sort();
  return later.length ? new Date(Date.parse(later[0]) - 1000).toISOString() : new Date().toISOString();
}

(async () => {
  log(`workdir ${WORK}`);
  const smokeCommit = process.env.SMOKE_COMMIT || (sh('git', ['rev-parse', 'HEAD'], { cwd: ROOT, allowFail: true }).stdout || '').trim() || null;
  const times = publishTimes();
  const versions = MISSING
    ? Object.keys(times).sort((a, b) => (times[a] < times[b] ? -1 : 1)).filter((v) => !existsSync(join(FIXTURES, v, 'fixture.json')))
    : [VERSION];
  log(`capturing: ${versions.join(' ') || 'nothing missing'}`);
  for (const v of versions) {
    const before = VERSION && opt('before') ? opt('before') : beforeFor(v, times);
    const out = resolve(VERSION && opt('out') ? opt('out') : join(FIXTURES, v));
    const work = join(WORK, v);
    mkdirSync(work, { recursive: true });
    const prov = await captureStore({ step, version: v, before, work, out, smokeCommit });
    if (!prov.pass) rmSync(out, { recursive: true, force: true });
    report.captures.push({ version: v, before, pass: !!prov.pass, out: prov.pass ? out : null, absolutePaths: prov.absolutePaths });
  }
  done();
})().catch((e) => { log(`FATAL ${e?.stack || e}`); report.fatal = String(e?.stack || e); report.exitCode = 2; done(); });

function done() {
  if (!KEEP && !opt('workdir')) process.on('exit', () => { try { rmSync(WORK, { recursive: true, force: true }); } catch { /* noop */ } });
  finish({
    report, t0, reportPath: opt('report', join(WORK, 'report.json')), summaryPath: opt('summary', join(WORK, 'summary.md')),
    headline: `capture ${report.captures.map((c) => `${c.version} ${c.pass ? '✓' : '✗'}`).join(', ') || 'nothing'}`,
  });
}
