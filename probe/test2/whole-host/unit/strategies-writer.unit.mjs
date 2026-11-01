// The strategy fixture's deep-store writer (lib/strategies/writer.mjs), with
// stand-ins for the runs it makes. Each test names the requirement it pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { entryKey, findEntry, writeEntry } from '../lib/strategies/writer.mjs';

const parts = { lane: 'abc123', configurationName: 'default', recipeHash: 'r1', versions: { '@animalabs/connectome-host': '0.15.0', '@animalabs/agent-framework': '0.28.0' }, trialTurns: { min: 20, step: 5, bound: 40 } };

// A stand-in for the lane's runs: a "run" appends its steps' ids to the store's
// file, and moves the clock a minute a step. Like a real run, it waits on I/O,
// so the test's own timeout can fire while the writer loops.
function fakeLane({ passesAt = 0, failOn = null, gate = null } = {}) {
  const calls = { runs: [], trials: [], checks: 0 };
  return {
    calls,
    script: {
      min: 20, step: 5, bound: 40,
      prefix: (n) => Array.from({ length: n }, (_, i) => `p.${i + 1}`),
      extend: (from, to) => Array.from({ length: to - from }, (_, i) => `p.${from + i + 1}`),
    },
    runSteps: async ({ steps, storeDir, epoch, label }) => {
      await new Promise((r) => setImmediate(r));
      calls.runs.push({ first: steps[0], last: steps.at(-1), epoch, label });
      if (failOn && steps.includes(failOn)) return { ok: false, failure: { reason: `step ${failOn} failed` }, clockEnd: epoch };
      mkdirSync(storeDir, { recursive: true });
      appendFileSync(join(storeDir, 'messages'), steps.join('\n') + '\n');
      return { ok: true, clockEnd: epoch + steps.length * 60_000 };
    },
    trial: async ({ dataDir, epoch }) => {
      const turns = readFileSync(join(dataDir, 'messages'), 'utf-8').trim().split('\n').length;
      calls.trials.push({ turns, epoch });
      if (gate) await gate;
      return { missing: turns >= passesAt ? [] : ['a merge request'] };
    },
    hardChecks: async () => { calls.checks++; return { ok: true }; },
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fxw-'));
  return { cacheRoot: join(dir, 'cache'), work: join(dir, 'work'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const write = (s, lane, extra = {}) => writeEntry({ cacheRoot: s.cacheRoot, key: entryKey(parts), keyParts: parts, script: lane.script, runSteps: lane.runSteps, trial: lane.trial, hardChecks: lane.hardChecks, epoch: 1_000_000, work: s.work, ...extra });

test('W1: the same inputs give the same key, in any order of versions; each part changes it', { timeout: 30_000 }, () => {
  const k = entryKey(parts);
  assert.equal(entryKey({ ...parts, versions: Object.fromEntries(Object.entries(parts.versions).reverse()) }), k);
  assert.match(k, /^[0-9a-f]{64}$/);
  for (const changed of [
    { lane: 'abc124' }, { configurationName: 'passthrough' }, { recipeHash: 'r2' },
    { versions: { ...parts.versions, '@animalabs/agent-framework': '0.28.1' } },
    { versions: { ...parts.versions, '@animalabs/membrane': '0.8.0' } },
    { trialTurns: { min: 1, step: 5, bound: 40 } }, { trialTurns: { min: 20, step: 1, bound: 40 } }, { trialTurns: { min: 20, step: 5, bound: 80 } },
  ]) assert.notEqual(entryKey({ ...parts, ...changed }), k, JSON.stringify(changed));
});

test('W2, W4: an entry is found only once complete, with its key parts, clock and length; lookup takes the newest for the lane version, configuration and trial numbers', { timeout: 30_000 }, async () => {
  const s = setup();
  let open;
  const gate = new Promise((r) => { open = r; });
  const lane = fakeLane({ passesAt: 20, gate });
  try {
    const writing = write(s, lane);
    while (lane.calls.trials.length === 0) await new Promise((r) => setTimeout(r, 5));
    assert.equal(findEntry({ cacheRoot: s.cacheRoot, lane: 'abc123', configurationName: 'default' }), null, 'not found while it is being written');
    open();
    const { entry, written } = await writing;
    assert.equal(written, true);
    const found = findEntry({ cacheRoot: s.cacheRoot, lane: 'abc123', configurationName: 'default' });
    assert.equal(found.entry.key, entryKey(parts));
    for (const [k, v] of Object.entries(parts)) assert.deepEqual(found.entry[k], v, k);
    assert.equal(found.entry.prefixTurns, 20);
    assert.equal(found.entry.clockEnd, 1_000_000 + 20 * 60_000);
    assert.deepEqual(found.entry, entry);
    assert.ok(existsSync(join(found.dir, 'store', 'messages')), 'the written store is in the entry');

    const newer = { ...parts, versions: { ...parts.versions, '@animalabs/agent-framework': '0.29.0' } };
    await new Promise((r) => setTimeout(r, 5));
    await writeEntry({ cacheRoot: s.cacheRoot, key: entryKey(newer), keyParts: newer, script: lane.script, runSteps: lane.runSteps, trial: lane.trial, hardChecks: lane.hardChecks, epoch: 1_000_000, work: s.work });
    const other = { ...parts, lane: 'zzz' };
    await new Promise((r) => setTimeout(r, 5));
    await writeEntry({ cacheRoot: s.cacheRoot, key: entryKey(other), keyParts: other, script: lane.script, runSteps: lane.runSteps, trial: lane.trial, hardChecks: lane.hardChecks, epoch: 1_000_000, work: s.work });
    assert.deepEqual(findEntry({ cacheRoot: s.cacheRoot, lane: 'abc123', configurationName: 'default' }).entry.versions, newer.versions, 'the newest for the lane version, whichever release wrote it');
    assert.equal(findEntry({ cacheRoot: s.cacheRoot, lane: 'abc123', configurationName: 'passthrough' }), null);
    assert.ok(findEntry({ cacheRoot: s.cacheRoot, lane: 'abc123', configurationName: 'default', trialTurns: { min: 20, step: 5, bound: 40 } }), 'found under its own trial numbers');
    for (const turns of [{ min: 1, step: 5, bound: 40 }, { min: 20, step: 1, bound: 40 }, { min: 20, step: 5, bound: 80 }]) {
      assert.equal(findEntry({ cacheRoot: s.cacheRoot, lane: 'abc123', configurationName: 'default', trialTurns: turns }), null, `not under another trial's numbers: ${JSON.stringify(turns)}`);
    }
  } finally { s.done(); }
});

test('W3: a second writer of the same key waits, then takes the entry the first wrote without running anything', { timeout: 30_000 }, async () => {
  const s = setup();
  let open;
  const gate = new Promise((r) => { open = r; });
  const first = fakeLane({ passesAt: 20, gate });
  const second = fakeLane({ passesAt: 20 });
  try {
    const a = write(s, first);
    while (first.calls.trials.length === 0) await new Promise((r) => setTimeout(r, 5));
    const b = write(s, second);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(second.calls.runs.length, 0, 'it waits while the first holds the lock');
    open();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.written, true);
    assert.equal(rb.written, false);
    assert.deepEqual(rb.entry, ra.entry);
    assert.equal(second.calls.runs.length, 0);
  } finally { s.done(); }
});

test('W3: a lock whose holder isn\'t running on this machine is taken over; one held by a running process makes the writer give up at its bound, naming the holder', { timeout: 30_000 }, async () => {
  const s = setup();
  try {
    mkdirSync(s.cacheRoot, { recursive: true });
    const lock = join(s.cacheRoot, `.${entryKey(parts)}.lock`);
    const gone = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
    writeFileSync(lock, JSON.stringify({ pid: gone, host: hostname(), since: 'then' }));
    assert.equal((await write(s, fakeLane({ passesAt: 20 }))).written, true);

    const t = setup();
    mkdirSync(t.cacheRoot, { recursive: true });
    writeFileSync(join(t.cacheRoot, `.${entryKey(parts)}.lock`), JSON.stringify({ pid: process.pid, host: hostname(), since: 'now' }));
    const lane = fakeLane({ passesAt: 20 });
    await assert.rejects(write(t, lane, { lockWaitMs: 200 }), new RegExp(`pid ${process.pid}`));
    assert.equal(lane.calls.runs.length, 0);
    t.done();
  } finally { s.done(); }
});

test('W5, W6: the prefix is extended, not rewritten, in the script\'s steps until the continuation produces every product, each run starting where the last ended', { timeout: 30_000 }, async () => {
  const s = setup();
  const lane = fakeLane({ passesAt: 30 });
  try {
    const { entry } = await write(s, lane);
    assert.deepEqual(lane.calls.runs.map((r) => [r.first, r.last]), [['p.1', 'p.20'], ['p.21', 'p.25'], ['p.26', 'p.30']]);
    assert.deepEqual(lane.calls.runs.map((r) => r.epoch), [1_000_000, 1_000_000 + 20 * 60_000, 1_000_000 + 25 * 60_000]);
    assert.deepEqual(lane.calls.trials, [{ turns: 20, epoch: 1_000_000 + 20 * 60_000 }, { turns: 25, epoch: 1_000_000 + 25 * 60_000 }, { turns: 30, epoch: 1_000_000 + 30 * 60_000 }]);
    assert.equal(entry.prefixTurns, 30);
    assert.deepEqual(entry.trial.missing, []);
    assert.equal(readFileSync(join(s.cacheRoot, entry.key, 'store', 'messages'), 'utf-8').trim().split('\n').length, 30, 'the store holds each turn once');
  } finally { s.done(); }
});

test('W6: when no length up to the bound produces every product, the entry is written at the bound with what was missing', { timeout: 30_000 }, async () => {
  const s = setup();
  const lane = fakeLane({ passesAt: 1000 });
  try {
    const { entry } = await write(s, lane);
    assert.equal(entry.prefixTurns, 40);
    assert.deepEqual(entry.trial.missing, ['a merge request']);
    assert.deepEqual(entry.trial.lengths.map((l) => l.turns), [20, 25, 30, 35, 40]);
  } finally { s.done(); }
});

test('W7: the hard checks\' outcome is in the entry, and a failing one still writes it', { timeout: 30_000 }, async () => {
  const s = setup();
  const lane = fakeLane({ passesAt: 20 });
  lane.hardChecks = async () => ({ ok: false, flags: ['audit-topology: 2 orphans'] });
  try {
    const { entry } = await write(s, lane);
    assert.deepEqual(entry.hardChecks, { ok: false, flags: ['audit-topology: 2 orphans'] });
    assert.ok(findEntry({ cacheRoot: s.cacheRoot, lane: 'abc123', configurationName: 'default' }));
  } finally { s.done(); }
});

test('W8: a write that fails leaves no entry, says why, and frees the lock for the next writer', { timeout: 30_000 }, async () => {
  const s = setup();
  try {
    await assert.rejects(write(s, fakeLane({ passesAt: 30, failOn: 'p.23' })), /p\.23 failed/);
    assert.equal(findEntry({ cacheRoot: s.cacheRoot, lane: 'abc123', configurationName: 'default' }), null);
    const failingTrial = fakeLane({ passesAt: 20 });
    failingTrial.trial = async () => { throw new Error('the continuation could not run'); };
    await assert.rejects(write(s, failingTrial, { lockWaitMs: 200 }), /could not run/);
    assert.equal(findEntry({ cacheRoot: s.cacheRoot, lane: 'abc123', configurationName: 'default' }), null);
    assert.equal((await write(s, fakeLane({ passesAt: 20 }), { lockWaitMs: 200 })).written, true, 'the lock is free again');
  } finally { s.done(); }
});
