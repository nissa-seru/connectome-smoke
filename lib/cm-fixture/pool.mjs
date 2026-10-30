// Running a check's jobs across worker processes (worker.mjs), where checkpoints live, and the fixture's version.
// The lane command (lanes/cm-fixture.mjs) and the checkpoint writer (checkpoints.mjs) call these.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where a checkpoint's store and clock are kept, under a checkpoint directory. */
export const checkpointPath = (dir, key) => join(dir, key.replaceAll('/', '__').replaceAll(':', '_').replaceAll('@', '-at-'));

/**
 * The fixture's version: a digest of every file in lib/cm-fixture, house.json included. Each run's trace header
 * names it, so a trace says which fixture code wrote it; a committed record doesn't depend on it.
 */
export function fixtureVersion() {
  const h = createHash('sha256');
  for (const f of readdirSync(HERE).sort()) {
    if (!/\.(mjs|json)$/.test(f)) continue;
    h.update(f).update('\u0000').update(readFileSync(join(HERE, f))).update('\u0000');
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * Run an arm's jobs over `workers` processes. Jobs that save a checkpoint must finish before the jobs continuing it
 * start, so a job list with both runs in two phases: the from-empty jobs first, then the continuations.
 * @param {object} o { arm: { name, cmDir, membraneDir, commit }, jobs, workers, traceDir, checkpointDir, workDir,
 *   recorder, house (path), bun (the bun binary; 'bun' when left out) }
 * @returns {Promise<Array<{ id, ok, error, ms }>>} one result per job, in the job list's order
 */
export async function runArm(o) {
  const empty = o.jobs.filter((j) => !j.from);
  const continuing = o.jobs.filter((j) => j.from);
  const results = new Map();
  for (const [phase, jobs] of [['empty', empty], ['continue', continuing]]) {
    if (jobs.length === 0) continue;
    for (const r of await runPhase(o, jobs, phase)) results.set(r.id, r);
  }
  return o.jobs.map((j) => results.get(j.id) ?? { id: j.id, ok: false, error: 'the worker running it ended without a result', ms: null });
}

async function runPhase(o, jobs, phase) {
  mkdirSync(o.traceDir, { recursive: true });
  mkdirSync(o.checkpointDir, { recursive: true });
  mkdirSync(o.workDir, { recursive: true });
  const spec = join(o.workDir, `spec-${o.arm.name}-${phase}.json`);
  writeFileSync(spec, JSON.stringify({
    arm: o.arm,
    jobs,
    traceDir: o.traceDir,
    checkpointDir: o.checkpointDir,
    workDir: o.workDir,
    recorder: o.recorder,
    house: o.house,
    fixtureVersion: fixtureVersion(),
  }));
  const n = Math.max(1, Math.min(o.workers, jobs.length));
  const outs = await Promise.all(Array.from({ length: n }, (_, i) => new Promise((resolve) => {
    const child = spawn(o.bun ?? 'bun', [join(HERE, 'worker.mjs'), spec, String(i), String(n)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ out, err, code, i }));
  })));
  const results = [];
  for (const { out, err, code, i } of outs) {
    const got = new Set();
    for (const line of out.split('\n').filter(Boolean)) {
      try {
        const r = JSON.parse(line);
        results.push(r);
        got.add(r.id);
      } catch { /* a stray line: the worker's stderr says why */ }
    }
    // A worker that ended early leaves its remaining jobs without a result: each gets the worker's own account.
    for (let k = i; k < jobs.length; k += n) {
      if (!got.has(jobs[k].id)) results.push({ id: jobs[k].id, ok: false, error: `worker ${i} exited ${code} before reporting this job: ${err.slice(-800)}`, ms: null });
    }
  }
  return results;
}
