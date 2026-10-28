// The parts of the strategy fixture's driver (lib/strategies/driver.mjs) that
// need no host. Its runs through a host are its own evidence (see its commits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { budgetReportDone, readSettle, recipeHash, recipeIdentity } from '../lib/strategies/driver.mjs';
import { configurations } from '../lib/strategies/script.mjs';

const facts = { takesMaintenanceInterval: false, kvUnified: { policy: { cacheScale: 100_000 }, tokenBucketSize: 50_000 } };
const configuration = configurations().default;
const SERVER = fileURLToPath(new URL('../lib/strategies/mcpl-server.mjs', import.meta.url));

test('the recipe the writer keys on leaves out where the lane runs from and what changes between runs, and its hash changes with what the recipe says', () => {
  const identity = JSON.stringify(recipeIdentity({ configuration, facts, channels: ['chat'] }));
  for (const [what, text] of [['node\'s path', process.execPath], ['the server\'s path', SERVER], ['the control socket', 'FIXTURE_CONTROL'], ['the boot', 'FIXTURE_BOOT']]) {
    assert.equal(identity.includes(text), false, what);
  }
  assert.ok(identity.includes('"FIXTURE_CHANNELS":"chat"'), 'the channels stay');
  const h = recipeHash({ configuration, facts, channels: ['chat'] });
  for (const [what, other] of [
    ['another model', recipeHash({ configuration: { ...configuration, agent: { ...configuration.agent, model: 'claude-opus-5-5' } }, facts, channels: ['chat'] })],
    ['another channel', recipeHash({ configuration, facts, channels: ['chat', 'other'] })],
    ['the host taking maintenanceIntervalMs', recipeHash({ configuration, facts: { ...facts, takesMaintenanceInterval: true }, channels: ['chat'] })],
    ['another kv-unified block', recipeHash({ configuration, facts: { ...facts, kvUnified: { ...facts.kvUnified, tokenBucketSize: 40_000 } }, channels: ['chat'] })],
  ]) assert.notEqual(other, h, what);
});

// R7: how a settle reads one `maintain` answer (agent-framework 0.28.0's host-command reply).
const answer = ({ ready = true, pending = false, queue = 0, compressed = 30, drained = true, deferredWrites = 0, activeTurnAgents = [], parkedAdmissions = 0, ok = true } = {}) => ({
  ok,
  maintenance: { ran: true, agents: [{ agentName: 'fixture', ready, ...(ready ? {} : { pending: pending ? 'Compressing chunk 31' : `${queue} chunks pending` }), progress: { totalChunks: 32, chunksCompressed: compressed, l1QueueLength: queue, mergeQueueLength: 0, summaryCounts: { l1: compressed, l2: 1, l3: 0 }, pending } }] },
  hostMode: { drained, deferredWrites, activeTurnAgents, parkedAdmissions },
});

test('R7: a settle is settled only when every agent is ready, the host is drained and nothing it deferred is still to land', () => {
  assert.equal(readSettle(answer(), null).settled, true);
  for (const [what, a] of [
    ['a deferred write', answer({ deferredWrites: 1 })],
    ['a host not drained', answer({ drained: false, activeTurnAgents: ['fixture'] })],
    ['an agent not ready', answer({ ready: false, pending: true })],
    ['an answer that isn\'t ok', answer({ ok: false })],
  ]) assert.equal(readSettle(a, null).settled, false, what);
});

test('R7: work is in flight while a compression runs, a turn is alive or a wake is parked, and otherwise isn\'t', () => {
  assert.equal(readSettle(answer({ ready: false, pending: true }), null).inFlight, true);
  assert.equal(readSettle(answer({ drained: false, activeTurnAgents: ['fixture'] }), null).inFlight, true);
  assert.equal(readSettle(answer({ drained: false, parkedAdmissions: 1 }), null).inFlight, true);
  assert.equal(readSettle(answer({ ready: false, queue: 2 }), null).inFlight, false);
  assert.equal(readSettle(answer({ deferredWrites: 1 }), null).inFlight, false);
});

test('R7: a pass moved the work on when its progress or its deferred writes differ from the pass before, and the first pass always has', () => {
  const before = answer({ ready: false, queue: 2, compressed: 29 });
  assert.equal(readSettle(before, null).moved, true);
  const seen = readSettle(before, null).progress;
  assert.equal(readSettle(answer({ ready: false, queue: 1, compressed: 30 }), seen).moved, true, 'a chunk compressed');
  assert.equal(readSettle(answer({ ready: false, queue: 2, compressed: 29 }), seen).moved, false, 'nothing changed');
  const deferred = readSettle(answer({ deferredWrites: 2 }), null).progress;
  assert.equal(readSettle(answer({ deferredWrites: 1 }), deferred).moved, true, 'a deferred write landed');
  assert.equal(readSettle(answer({ deferredWrites: 2 }), deferred).moved, false, 'none landed');
});

test('D12: `/budget`\'s output is whole once it holds the agent\'s own line, or a line that is no part of the report, and not before', () => {
  const header = '--- Stream Token Budgets ---';
  assert.equal(budgetReportDone([], 'fixture'), false);
  assert.equal(budgetReportDone([header], 'fixture'), false);
  assert.equal(budgetReportDone([header, '  other: 150.0k (last: 0, 0%)'], 'fixture'), false, 'another agent\'s line: ours is still to come');
  assert.equal(budgetReportDone([header, '  fixture: 150.0k (last: 0, 0%)'], 'fixture'), true);
  assert.equal(budgetReportDone([header, '  fixture: 150.0k (last: 0, 0%); its stream doesn\'t break at this budget mid-turn: for its size, only before a request its 1.0M window can\'t hold'], 'fixture'), true);
  assert.equal(budgetReportDone([header, '  fixturette: 1.0k (last: 0, 0%)'], 'fixture'), false, 'another agent whose name starts with ours');
  assert.equal(budgetReportDone(['No agents.'], 'fixture'), true);
  assert.equal(budgetReportDone(['Unknown command: /budget'], 'fixture'), true, 'a host without the report doesn\'t hold the run');
});

test('R7b: an answer with no deferred-write count doesn\'t hold the settle, and the reading says the count wasn\'t reported', () => {
  const unreported = answer();
  delete unreported.hostMode.deferredWrites;
  const read = readSettle(unreported, null);
  assert.equal(read.settled, true);
  assert.equal(read.deferredWritesReported, false);
  assert.equal(readSettle(answer(), null).deferredWritesReported, true);
  const notReady = answer({ ready: false, pending: true });
  delete notReady.hostMode.deferredWrites;
  assert.equal(readSettle(notReady, null).settled, false, 'the rest of the answer still decides');
});
