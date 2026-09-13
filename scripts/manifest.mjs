#!/usr/bin/env node
/**
 * Registry manifest: the current `latest` version + publish time of every
 * package in the stack, plus a stable hash of the version set. The workflow
 * gate compares hashes to decide "did anything change since we last tested?"
 * and uses the newest `modified` to debounce a cascading release.
 *
 * Usage: node scripts/manifest.mjs   → JSON on stdout
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const PACKAGES = [
  '@animalabs/chronicle',
  '@animalabs/membrane',
  '@animalabs/context-manager',
  '@animalabs/agent-framework',
  '@animalabs/connectome-host',
  '@animalabs/mcpl-core',
  '@animalabs/heartbeat-mcpl',
  '@animalabs/discord-mcpl',
  '@animalabs/portal-protocol',
  '@animalabs/portal-client',
];

function view(pkg) {
  const out = execFileSync('npm', ['view', pkg, 'dist-tags.latest', 'time', '--json'], { encoding: 'utf-8', timeout: 60_000 });
  const j = JSON.parse(out);
  const latest = j['dist-tags.latest'];
  const time = j.time ?? {};
  return { latest, modified: time[latest] ?? time.modified ?? null };
}

const packages = {};
for (const p of PACKAGES) {
  try { packages[p] = view(p); }
  catch (e) { packages[p] = { latest: null, modified: null, error: String(e.message).split('\n')[0] }; }
}
const versionSet = Object.entries(packages).map(([k, v]) => `${k}@${v.latest}`).sort().join(' ');
const hash = createHash('sha256').update(versionSet).digest('hex').slice(0, 16);
process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), hash, packages }) + '\n');
