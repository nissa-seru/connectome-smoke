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
 * Run an arm's jobs over `workers` processes, each taking the list's next job as it finishes one, so one long run
 * doesn't leave the rest of a worker's share waiting behind it. A list where one job continues a checkpoint another saves is refused: no caller makes one (the checkpoint
 * writer's jobs only save, and a check's only continue). With `recordDir`, each worker renders each run's record from
 * its trace and writes it there (record.mjs), in parallel.
 * @param {object} o { arm: { name, cmDir, membraneDir, commit }, jobs, workers, traceDir, checkpointDir, workDir,
 *   recorder, house (path), recordDir, bun (the bun binary; 'bun' when left out) }
 * @returns {Promise<Array<{ id, ok, error, ms, record, driverEnded }>>} one result per job, in the job list's order:
 *   with `recordDir`, `record` says whether its record was written and `driverEnded` names the error class the
 *   driver ended the run with, if it did
 */
export async function runArm(o) {
  const saved = new Set(o.jobs.map((j) => j.save).filter(Boolean));
  const waits = o.jobs.find((j) => j.from && saved.has(j.from));
  if (waits) throw new Error(`${waits.id} continues ${waits.from}, which another job in the same list saves: run the savers first, as their own list`);
  mkdirSync(o.traceDir, { recursive: true });
  mkdirSync(o.checkpointDir, { recursive: true });
  mkdirSync(o.workDir, { recursive: true });
  if (o.recordDir) mkdirSync(o.recordDir, { recursive: true });
  const spec = join(o.workDir, `spec-${o.arm.name}.json`);
  writeFileSync(spec, JSON.stringify({
    arm: o.arm,
    jobs: o.jobs,
    traceDir: o.traceDir,
    checkpointDir: o.checkpointDir,
    workDir: o.workDir,
    recorder: o.recorder,
    house: o.house,
    recordDir: o.recordDir ?? null,
    fixtureVersion: fixtureVersion(),
  }));
  const results = new Map();
  const pending = o.jobs.map((_, k) => k);
  const n = Math.max(1, Math.min(o.workers, o.jobs.length));
  await new Promise((done) => {
    const idle = [];
    let live = n;
    const dispatch = () => {
      while (idle.length > 0 && pending.length > 0) {
        const w = idle.pop();
        w.job = pending.shift();
        w.child.stdin.write(`${w.job}\n`);
      }
      if (pending.length === 0) for (const w of idle.splice(0)) w.child.stdin.end();
    };
    for (let i = 0; i < n; i++) {
      const child = spawn(o.bun ?? 'bun', [join(HERE, 'worker.mjs'), spec], { stdio: ['pipe', 'pipe', 'pipe'] });
      const w = { child, job: null, err: '' };
      let buffered = '';
      child.stdout.on('data', (d) => {
        buffered += d;
        let nl;
        while ((nl = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, nl);
          buffered = buffered.slice(nl + 1);
          let r;
          try { r = JSON.parse(line); } catch { continue; } // a stray line: the worker's stderr says why
          results.set(r.id, r);
          if (w.job !== null && o.jobs[w.job].id === r.id) w.job = null;
          idle.push(w);
          dispatch();
        }
      });
      child.stderr.on('data', (d) => { w.err = (w.err + d).slice(-4000); });
      child.stdin.on('error', () => { /* a worker that ended early: its close accounts for its job */ });
      child.on('close', (code) => {
        live--;
        if (w.job !== null) results.set(o.jobs[w.job].id, { id: o.jobs[w.job].id, ok: false, error: `worker ${i} exited ${code} before reporting this job: ${w.err.slice(-800)}`, ms: null });
        const at = idle.indexOf(w);
        if (at >= 0) idle.splice(at, 1);
        if (live === 0) done();
        else dispatch();
      });
      idle.push(w);
    }
    dispatch();
  });
  return o.jobs.map((j) => results.get(j.id) ?? { id: j.id, ok: false, error: 'no worker was left to run it', ms: null });
}
