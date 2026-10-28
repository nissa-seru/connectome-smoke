#!/usr/bin/env node
/**
 * connectome-smoke — "strategies" lane: the context-management strategy fixture
 * (lib/strategies/), from the command line. A check of a change runs inside part 1's
 * source lane, as its step `connectome-host:combined:strategies:default`; this is for
 * writing the cache it continues from, and for checking a host by hand.
 *
 *   node lanes/strategies.mjs write [--candidate <spec or packed release>] [--configurations a,b]
 *   node lanes/strategies.mjs check --host-dir <dir> --install-dir <dir> [--configuration <name>]
 *   options: --cache <dir> (default ~/.cache/connectome-smoke/strategies), --workdir <dir>, --out <dir>
 *
 * `write` installs connectome-host as a consumer would, the last release when no
 * --candidate is given, and writes each configuration's deep store under the cache for
 * this lane version (lib/strategies/lane.mjs, laneVersion, which covers lib/strategies/ and
 * lib/common.mjs). A change to those files is merged into the fork's main only after
 * `write` has run from that change's head on the VPS, so no check waits on a write.
 *
 * `check` continues the cached store for one configuration under the host at --host-dir,
 * whose stack resolves from --install-dir, as a check does, with no base.
 *
 * Exit 0: written, or a check passed · 1: a check failed something, or a write's hard
 * checks flagged · 2: couldn't run.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from '../lib/common.mjs';
import { cacheRoot, check, installStack, laneVersion, writeStore } from '../lib/strategies/lane.mjs';
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
  let stack;
  try { stack = installStack({ spec: opt('candidate', 'latest'), dir: join(work, 'stack') }); } catch (e) { fail(`the install failed: ${e.message}`); }
  console.log(`[smoke:strategies] installed ${Object.entries(stack.versions).map(([k, v]) => `${k.replace('@animalabs/', '')}@${v}`).join(' ')}`);
  const results = [];
  let flagged = false;
  for (const name of names) {
    try {
      const r = await writeStore({ cacheRoot: root, configuration: all[name], hostDir: stack.hostDir, installDir: stack.installDir, work: join(work, `write-${name}`) });
      const hard = r.entry.hardChecks;
      if (hard?.flags?.length) flagged = true;
      results.push({ configuration: name, key: r.entry.key, written: r.written, prefixTurns: r.entry.prefixTurns, trial: r.entry.trial, hardChecks: hard, pruned: r.pruned });
      console.log(`[smoke:strategies] ${name}: ${r.written ? 'written' : 'already there'}, ${r.entry.key.slice(0, 12)}, ${r.entry.prefixTurns} prefix turns, ${hard?.flags?.length ?? 0} hard-check flags`);
    } catch (e) {
      writeFileSync(join(out, 'write.json'), JSON.stringify({ lane, versions: stack.versions, results, failed: { configuration: name, reason: e.message } }, null, 1));
      fail(`${name}: the write failed: ${e.message}`);
    }
  }
  writeFileSync(join(out, 'write.json'), JSON.stringify({ lane, versions: stack.versions, results }, null, 1));
  process.exit(flagged ? 1 : 0);
} else {
  const name = opt('configuration', 'default');
  if (!all[name]) fail(`no configuration ${name}; there are ${Object.keys(all).join(', ')}`);
  if (!opt('host-dir') || !opt('install-dir')) fail('check needs --host-dir and --install-dir');
  const r = await check({ cacheRoot: root, configuration: all[name], hostDir: resolve(opt('host-dir')), installDir: resolve(opt('install-dir')), work: join(work, 'check'), evidence: join(out, 'check') });
  console.log((r.report?.lines ?? [`couldn't run: ${r.reason}`]).join('\n'));
  process.exit(r.outcome === 'pass' ? 0 : r.outcome === 'couldnt-run' ? 2 : 1);
}
