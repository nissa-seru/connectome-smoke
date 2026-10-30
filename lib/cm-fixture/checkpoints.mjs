// The checkpoint stores the fixture's continuations start from, written by a released context-manager as a consumer
// installs it, and committed beside the records. A continuation then moves only when its own behaviour does, and
// every check also has the version under test read a store an earlier release wrote.
//
// Refreshed deliberately, at a release: `writeCheckpoints` installs the release from npm, runs each configuration's
// from-empty workload that continuations start from (W2 for the configurations that compress, W1 for the others),
// and saves each run's end, its store and the clock it stopped at, under the run's checkpoint key. It writes a
// manifest naming the release and each store's size.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkpointPath, runArm } from './pool.mjs';
import { matrix } from './workloads.mjs';

function sizeOf(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    total += s.isDirectory() ? sizeOf(p) : s.size;
  }
  return total;
}

/**
 * Write every checkpoint a check's continuations start from.
 * @param {object} o { release: a context-manager version on npm; outDir: where the checkpoints go (replaced);
 *   house: house.json's path; recorder: the recorder module's path; workDir; workers; npm ('npm' when left out) }
 * @returns {{ release, stores: Array<{ key, bytes }>, failed: Array<{ id, error }> }}
 */
export async function writeCheckpoints(o) {
  const install = join(o.workDir, `cm-${o.release}`);
  rmSync(install, { recursive: true, force: true });
  execFileSync(o.npm ?? 'npm', ['install', '--prefix', install, '--ignore-scripts', '--no-audit', '--no-fund', `@animalabs/context-manager@${o.release}`], { stdio: 'ignore' });
  const cmDir = join(install, 'node_modules/@animalabs/context-manager');
  const version = JSON.parse(readFileSync(join(cmDir, 'package.json'), 'utf8')).version;
  if (version !== o.release) throw new Error(`npm installed context-manager ${version}, not ${o.release}`);
  const house = JSON.parse(readFileSync(o.house, 'utf8'));
  const jobs = matrix(house, { writeCheckpoints: true }).filter((j) => j.save);
  rmSync(o.outDir, { recursive: true, force: true });
  mkdirSync(o.outDir, { recursive: true });
  const results = await runArm({
    arm: { name: 'base', cmDir, membraneDir: cmDir, commit: `npm:${version}` },
    jobs,
    workers: o.workers,
    traceDir: join(o.workDir, 'checkpoint-traces'),
    checkpointDir: o.outDir,
    workDir: join(o.workDir, 'checkpoint-work'),
    recorder: o.recorder,
    house: o.house,
  });
  const failed = results.filter((r) => !r.ok).map((r) => ({ id: r.id, error: r.error }));
  const stores = jobs.filter((j) => results.find((r) => r.id === j.id)?.ok).map((j) => ({ key: j.save, bytes: sizeOf(checkpointPath(o.outDir, j.save)) }));
  const manifest = { release: version, stores, failed };
  writeFileSync(join(o.outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
