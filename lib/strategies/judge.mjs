import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { readStore } from './read-store.mjs';
import { runChecks } from './report.mjs';
import { FIXTURE_AGENT, STREAM_BOUND } from './checks.mjs';
import { products } from './script.mjs';

const agentOf = (configuration) => configuration.agent?.name ?? FIXTURE_AGENT;
const namespaceOf = (configuration) => `agents/${agentOf(configuration)}`;

/** context-manager's own audit of a store's summary topology, from the side's install: 0 clean, 2 violations, anything else couldn't run. */
function auditTopology({ installDir, storePath, namespace }) {
  const script = join(installDir, 'node_modules', '@animalabs', 'context-manager', 'dist', 'scripts', 'audit-topology.js');
  const copy = mkdtempSync(join(tmpdir(), 'judge-audit-'));
  try {
    cpSync(storePath, copy, { recursive: true });
    const run = spawnSync(process.execPath, [script, copy, '--namespace', namespace], { encoding: 'utf-8', timeout: 120_000 });
    return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}${run.error ? String(run.error) : ''}` };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

/**
 * Judge one side's run from what it recorded: the stand-in's `records`, the driver's `log`,
 * the `script` it ran, and `storeCopy`, a copy of its final store's session directory (or
 * null). Returns `{ flags, missing, headroom, timing }` for report.mjs's perCheckReport:
 * - a run that failed (`run.ok` false) is a check 1 flag at `the run`, naming its failure,
 *   and its store isn't read;
 * - where the run succeeded and the configuration keeps summaries, the store is read
 *   through context-manager's public API from `installDir` (read-store.mjs) for checks 4 to 6,
 *   and context-manager's `audit-topology` runs on a copy of it: violations are a check 5
 *   flag at `the run`;
 * - a run that succeeded with no store copy, where the configuration keeps summaries, a store
 *   that can't be read, and an audit that couldn't run throw, since the side couldn't be judged.
 * `timing` gives the store read's and the audit's milliseconds. `readers` replaces the store
 * read and the audit, for tests.
 */
export async function judge({ records, log, script, storeCopy, configuration, installDir, run, readers = {} }) {
  const read = readers.readStore ?? readStore;
  const audit = readers.audit ?? auditTopology;
  const flags = [];
  const timing = {};
  if (!run?.ok) flags.push({ check: 1, step: 'the run', message: `the run failed: ${run?.failure?.reason ?? run?.failure ?? 'no reason given'}` });
  let store = null;
  if (run?.ok && configuration.summarises !== false && storeCopy) {
    const namespace = namespaceOf(configuration);
    let t = performance.now();
    store = await read({ installDir, storePath: storeCopy, namespace });
    timing.readMs = Math.round(performance.now() - t);
    t = performance.now();
    const audited = audit({ installDir, storePath: storeCopy, namespace });
    timing.auditMs = Math.round(performance.now() - t);
    if (audited.status === 2) flags.push({ check: 5, step: 'the run', message: `audit-topology found violations: ${audited.output.trim().slice(0, 600)}` });
    else if (audited.status !== 0) throw new Error(`audit-topology couldn't run (exit ${audited.status}): ${audited.output.trim().slice(0, 600)}`);
  } else if (configuration.summarises !== false && run?.ok) {
    throw new Error('the run succeeded but left no store copy to judge');
  }
  // The stream bound is the recipe's own, else agent-framework's default.
  const checked = runChecks({ records, log, script, products: products(configuration), store, agent: agentOf(configuration), streamBound: configuration.agent?.maxStreamTokens ?? STREAM_BOUND, windowTokens: configuration.windowTokens });
  return { flags: [...flags, ...checked.flags], missing: checked.missing, headroom: checked.headroom, notes: checked.notes, timing };
}
