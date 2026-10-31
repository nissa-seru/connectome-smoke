// One worker process of the context-management characterization fixture: loads one arm, then runs each job whose
// index runArm (pool.mjs) writes to its stdin, one per line, printing one JSON line per job, until stdin ends. Run
// under bun:
//
//   bun lib/cm-fixture/worker.mjs SPEC.json
//
// SPEC: { arm: { name, cmDir, membraneDir, commit }, jobs, traceDir, checkpointDir, workDir, recorder, house,
// recordDir, fixtureVersion }. `recorder` is the path of the module whose openRecorder the runs write through
// (trace.mjs). With `recordDir`, each run's record is rendered from its trace and written there.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { loadArm, runJob } from './driver.mjs';
import { WORKLOADS } from './workloads.mjs';
import { readTrace, recordFileName, traceFileName } from './events.mjs';
import { renderRecord } from './record.mjs';

const [specPath] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const { openRecorder } = await import(spec.recorder);
const arm = await loadArm(spec.arm);
const house = JSON.parse(readFileSync(spec.house, 'utf8'));
for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === '') continue;
  const job = spec.jobs[Number(line)];
  const traceFile = join(spec.traceDir, traceFileName(job.id));
  let result;
  try {
    result = await runJob(job, arm, {
      house,
      workloads: WORKLOADS,
      openRecorder,
      traceFile,
      checkpointDir: spec.checkpointDir,
      workDir: spec.workDir,
      fixtureVersion: spec.fixtureVersion,
    });
  } catch (err) {
    result = { id: job.id, ok: false, error: `driver: ${String(err?.stack ?? err).slice(0, 800)}`, ms: null };
  }
  if (spec.recordDir) {
    result.record = false;
    if (existsSync(traceFile)) {
      try {
        const trace = readTrace(readFileSync(traceFile, 'utf8'), job.id);
        writeFileSync(join(spec.recordDir, recordFileName(job.id)), renderRecord(trace));
        result.record = true;
        if (trace.end.error?.where === 'driver') result.driverEnded = trace.end.error.class;
      } catch (err) {
        result.error = `${result.error ? `${result.error}; ` : ''}its record couldn't be rendered: ${String(err?.message ?? err).slice(0, 800)}`;
      }
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
