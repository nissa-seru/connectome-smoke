// One worker process of the context-management characterization fixture: loads one arm, runs its share of a job
// list in order, and prints one JSON line per job. Run by runArm (pool.mjs), under bun:
//
//   bun lib/cm-fixture/worker.mjs SPEC.json INDEX OF
//
// SPEC: { arm: { name, cmDir, membraneDir, commit }, jobs, traceDir, checkpointDir, workDir, recorder, house,
// fixtureVersion }. `recorder` is the path of the module whose openRecorder the runs write through (trace.mjs).
// This worker runs jobs i with i % OF === INDEX.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadArm, runJob } from './driver.mjs';
import { WORKLOADS } from './workloads.mjs';
import { traceFileName } from './events.mjs';

const [specPath, index, of] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const { openRecorder } = await import(spec.recorder);
const arm = await loadArm(spec.arm);
const house = JSON.parse(readFileSync(spec.house, 'utf8'));
for (let i = Number(index); i < spec.jobs.length; i += Number(of)) {
  const job = spec.jobs[i];
  let result;
  try {
    result = await runJob(job, arm, {
      house,
      workloads: WORKLOADS,
      openRecorder,
      traceFile: join(spec.traceDir, traceFileName(job.id)),
      checkpointDir: spec.checkpointDir,
      workDir: spec.workDir,
      fixtureVersion: spec.fixtureVersion,
    });
  } catch (err) {
    result = { id: job.id, ok: false, error: `driver: ${String(err?.stack ?? err).slice(0, 800)}`, ms: null };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
