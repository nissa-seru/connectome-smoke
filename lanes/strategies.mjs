#!/usr/bin/env node
/**
 * connectome-smoke — "strategies" lane: the context-management strategy fixture
 * (lib/strategies/), from the command line. A check of a change runs inside part 1's
 * source lane, as its step `connectome-host:combined:strategies:default`; this is for
 * writing the cache it continues from, and for checking a host by hand.
 *
 *   node lanes/strategies.mjs write [--candidate <spec or packed release>] [--overlay <pack.tgz>,...] [--configurations a,b]
 *   node lanes/strategies.mjs check --host-dir <dir> --install-dir <dir> [--configuration <name>]
 *   options: --cache <dir> (default ~/.cache/connectome-smoke/strategies), --workdir <dir>, --out <dir>
 *
 * `write` installs connectome-host as a consumer would, the last release when no
 * --candidate is given. `--overlay` then installs packed releases of the host's
 * dependencies over that install, as a consumer upgrading one package would, so a
 * candidate of context-manager, agent-framework, membrane or chronicle is written under the
 * host release it would reach, and the store's key names each by its version and its
 * pack's integrity. A pack of a package outside lane.mjs's KEY_PACKAGES is refused, since
 * the key wouldn't name it, and so is an install where any copy of an overlaid package
 * isn't the pack, as when the pack is outside a dependent's range. `write` then writes
 * each configuration's deep store under the cache for this lane version
 * (lib/strategies/lane.mjs, laneVersion, which covers lib/strategies/ and lib/common.mjs).
 * A change to those files is merged into the fork's main only after `write` has run from
 * that change's head on the VPS, so no check waits on a write. For each configuration it
 * then makes the cut's drift run (lane.mjs, driftRun): a run of DRIFT_TURNS turns from an
 * empty store, judged as the write's prefix is, whose store isn't kept. A check's own
 * fallback write never makes one.
 *
 * `check` continues the cached store for one configuration under the host at --host-dir,
 * whose stack resolves from --install-dir, as a check does, with no base.
 *
 * Exit 0: written, or a check passed · 1: a check failed something, or a write's hard
 * checks or drift run flagged, or its trial reached the bound lacking a product besides L3
 * (lane.mjs, lacking, writeFlagged) · 2: couldn't run.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, sh } from '../lib/common.mjs';
import { KEY_PACKAGES, cacheRoot, check, driftRun, installStack, lacking, laneVersion, notExercised, stackVersions, writeFlagged, writeStore } from '../lib/strategies/lane.mjs';
import { configurations } from '../lib/strategies/script.mjs';

const [command, ...rest] = process.argv.slice(2);
const { opt } = parseArgs(rest);
const fail = (message) => { console.error(`[smoke:strategies] ${message}`); process.exit(2); };
if (command !== 'write' && command !== 'check') fail(`the commands are write and check, not ${JSON.stringify(command ?? '')}`);
const work = opt('workdir') ? resolve(opt('workdir')) : mkdtempSync(join(tmpdir(), 'connectome-smoke-strategies-'));
mkdirSync(work, { recursive: true });
const out = resolve(opt('out', work));
mkdirSync(out, { recursive: true });
const root = cacheRoot(opt('cache'));
const all = configurations();
const lane = laneVersion();
console.log(`[smoke:strategies] lane ${lane.slice(0, 12)} · cache ${root} · work ${work}`);

if (command === 'write') {
  const names = String(opt('configurations', 'default')).split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !all[n]);
  if (unknown.length) fail(`no configuration ${unknown.join(', ')}; there are ${Object.keys(all).join(', ')}`);
  const overlay = String(opt('overlay', '')).split(',').map((s) => s.trim()).filter(Boolean).map((p) => resolve(p));
  const packs = overlay.map((p) => {
    let name, integrity;
    try {
      name = JSON.parse(sh('tar', ['-xzOf', p, 'package/package.json']).stdout).name;
      integrity = `sha512-${createHash('sha512').update(readFileSync(p)).digest('base64')}`;
    } catch (e) { fail(`the overlay ${p} couldn't be read as a packed release: ${e.message}`); }
    if (!KEY_PACKAGES.includes(name)) fail(`the overlay ${p} is ${name}, which a store's key doesn't name; overlay one of ${KEY_PACKAGES.join(', ')}`);
    return { path: p, name, integrity };
  });
  let stack;
  try { stack = installStack({ spec: opt('candidate', 'latest'), dir: join(work, 'stack') }); } catch (e) { fail(`the install failed: ${e.message}`); }
  if (packs.length) {
    try {
      sh('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', '--global=false', '--location=project', `--prefix=${stack.installDir}`, ...overlay], { cwd: stack.installDir, timeout: 900_000 });
      stack.versions = stackVersions(stack.hostDir, { installDir: stack.installDir });
    } catch (e) { fail(`the overlay install failed: ${e.message}`); }
    const lock = JSON.parse(readFileSync(join(stack.installDir, 'package-lock.json'), 'utf-8')).packages ?? {};
    for (const { path, name, integrity } of packs) {
      const copies = Object.entries(lock).filter(([at]) => at.endsWith(`node_modules/${name}`));
      const notThePack = copies.filter(([, l]) => l.integrity !== integrity);
      if (!copies.length || notThePack.length) fail(`the overlay ${path} didn't replace every copy of ${name}: ${copies.map(([at, l]) => `${at} from ${l.resolved}`).join('; ')}`);
    }
  }
  console.log(`[smoke:strategies] installed ${Object.entries(stack.versions).map(([k, v]) => `${k.replace('@animalabs/', '')}@${v}`).join(' ')}`);
  const results = [];
  const failWrite = (name, stage, e) => {
    writeFileSync(join(out, 'write.json'), JSON.stringify({ lane, versions: stack.versions, results, failed: { configuration: name, stage, reason: e.message } }, null, 1));
    fail(`${name}: ${stage === 'drift' ? 'the drift run couldn\'t run' : 'the write failed'}: ${e.message}`);
  };
  for (const name of names) {
    let result;
    try {
      const r = await writeStore({ cacheRoot: root, configuration: all[name], hostDir: stack.hostDir, installDir: stack.installDir, work: join(work, `write-${name}`) });
      const hard = r.entry.hardChecks;
      const lacks = lacking(r.entry);
      result = { configuration: name, key: r.entry.key, written: r.written, prefixTurns: r.entry.prefixTurns, trial: r.entry.trial, hardChecks: hard, lacking: lacks, pruned: r.pruned };
      results.push(result);
      console.log(`[smoke:strategies] ${name}: ${r.written ? 'written' : 'already there'}, ${r.entry.key.slice(0, 12)}, ${r.entry.prefixTurns} prefix turns, ${hard?.flags?.length ?? 0} hard-check flags`);
      for (const p of lacks) console.log(`[smoke:strategies] ${name}: the trial reached its bound of ${r.entry.prefixTurns} turns lacking ${p.segment}'s ${p.name}, so no check on this cut exercises it`);
      const cut = notExercised(r.entry);
      if (cut.line) console.log(`[smoke:strategies] ${name}: ${cut.line.slice(2)}`);
    } catch (e) {
      failWrite(name, 'write', e);
    }
    try {
      result.drift = await driftRun({ configuration: all[name], hostDir: stack.hostDir, installDir: stack.installDir, work: join(work, `drift-${name}`) });
    } catch (e) {
      result.drift = { couldntRun: e.message };
      failWrite(name, 'drift', e);
    }
    const d = result.drift;
    console.log(`[smoke:strategies] ${name}: drift run of ${d.turns} turns from empty${d.ok ? '' : `, which didn't complete (${d.failure?.reason ?? 'no reason given'})`}, ${d.flags.length} flag(s), ${(d.ms / 1000).toFixed(1)} s at load ${d.load[0]} to ${d.load[1]}`);
    for (const f of d.flags) console.log(`[smoke:strategies] ${name}: drift run: check ${f.check} at ${f.step ?? 'the run'}: ${f.message}`);
  }
  writeFileSync(join(out, 'write.json'), JSON.stringify({ lane, versions: stack.versions, results }, null, 1));
  process.exit(writeFlagged(results) ? 1 : 0);
} else {
  const name = opt('configuration', 'default');
  if (!all[name]) fail(`no configuration ${name}; there are ${Object.keys(all).join(', ')}`);
  if (!opt('host-dir') || !opt('install-dir')) fail('check needs --host-dir and --install-dir');
  let r;
  try {
    r = await check({ cacheRoot: root, configuration: all[name], hostDir: resolve(opt('host-dir')), installDir: resolve(opt('install-dir')), work: join(work, 'check'), evidence: join(out, 'check') });
  } catch (e) {
    fail(`the check couldn't run: ${e?.stack || e}`);
  }
  console.log((r.report?.lines ?? [`couldn't run: ${r.reason}`]).join('\n'));
  process.exit(r.outcome === 'pass' ? 0 : r.outcome === 'couldnt-run' ? 2 : 1);
}
