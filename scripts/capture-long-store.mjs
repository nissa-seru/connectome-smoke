#!/usr/bin/env node
/**
 * Capture a long store: the data directory a published host release leaves after tens
 * of turns on a recipe with small strategy budgets, so it holds context-manager's
 * summaries and compressed windows (lib/long-stores.mjs, captureLongStore).
 *
 *   node scripts/capture-long-store.mjs --variant plain|subconscious [--version 0.22.1] [--turns 40]
 *        [--before <ISO time>] [--out <dir>] [--workdir <dir>] [--keep]
 *
 * --version defaults to the host's `latest`, --before to now (what an npm consumer of
 * that release gets today), --out to fixtures/long-stores/<version>-<variant>. A capture
 * that doesn't complete every turn, or whose release doesn't give the resident its
 * summaries on a copy, writes its data and provenance anyway, with `pass: false`, so the
 * failure can be read. Exit 0 when it passed; 1 if not; 2 if the run couldn't start.
 *
 * On a machine that got a copy of this repository without .git, set SMOKE_COMMIT so the
 * provenance names the code that captured it.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReport, sh, finish, parseArgs } from '../lib/common.mjs';
import { captureLongStore } from '../lib/long-stores.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { opt, flag } = parseArgs(process.argv.slice(2));
const VARIANT = opt('variant');
if (!['plain', 'subconscious'].includes(VARIANT)) {
  console.error('usage: capture-long-store.mjs --variant plain|subconscious [--version V] [--turns N] [--before ISO] [--out DIR] [--workdir DIR] [--keep]');
  process.exit(2);
}
const TURNS = Number(opt('turns', '40'));
const WORK = opt('workdir') ? resolve(opt('workdir')) : mkdtempSync(join(tmpdir(), 'connectome-smoke-long-'));
const KEEP = flag('keep');
mkdirSync(WORK, { recursive: true });

const { report, step, log, t0 } = makeReport('capture-long', { workdir: WORK, captures: [] });

(async () => {
  log(`workdir ${WORK}`);
  const smokeCommit = process.env.SMOKE_COMMIT || (sh('git', ['rev-parse', 'HEAD'], { cwd: ROOT, allowFail: true }).stdout || '').trim() || null;
  const version = opt('version') || sh('npm', ['view', '@animalabs/connectome-host', 'dist-tags.latest'], { cwd: WORK, timeout: 120_000 }).stdout.trim();
  const before = opt('before') || new Date().toISOString();
  const out = resolve(opt('out') || join(ROOT, 'fixtures', 'long-stores', `${version}-${VARIANT}`));
  const work = join(WORK, `${version}-${VARIANT}`);
  mkdirSync(work, { recursive: true });
  rmSync(out, { recursive: true, force: true });
  const prov = await captureLongStore({ step, version, before, work, out, smokeCommit, variant: VARIANT, turnCount: TURNS });
  report.captures.push({ version, variant: VARIANT, before, pass: !!prov.pass, out, compressionRequests: prov.compressionRequests, summaries: prov.summaries.length, manifest: prov.manifest, check: prov.check });
  report.exitCode = prov.pass ? 0 : 1;
  done();
})().catch((e) => { log(`FATAL ${e?.stack || e}`); report.fatal = String(e?.stack || e); report.exitCode = 2; done(); });

function done() {
  if (!KEEP && !opt('workdir')) process.on('exit', () => { try { rmSync(WORK, { recursive: true, force: true }); } catch { /* noop */ } });
  finish({
    report, t0, reportPath: opt('report', join(WORK, 'report.json')), summaryPath: opt('summary', join(WORK, 'summary.md')),
    headline: `capture-long ${report.captures.map((c) => `${c.version}-${c.variant} ${c.pass ? '✓' : '✗'}`).join(', ') || 'nothing'}`,
  });
}
