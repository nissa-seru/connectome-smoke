// The parts of the strategy fixture's driver (lib/strategies/driver.mjs) that
// need no host. Its runs through a host are its own evidence (see its commits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetReportDone, hostEnv, readSettle } from '../lib/strategies/driver.mjs';

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

test('R7b: an answer with no deferred-write count isn\'t settled, so a host that stops reporting it fails the settle', () => {
  const unreported = answer();
  delete unreported.hostMode.deferredWrites;
  assert.equal(readSettle(unreported, null).settled, false);
  assert.equal(readSettle(answer(), null).settled, true);
});

test('R12: a configuration whose model binds thinking boots its host with the start-up binding probe off; any other, without the setting', () => {
  const base = { standinUrl: 'http://127.0.0.1:1', control: '/tmp/c', clock: 5 };
  assert.equal(hostEnv({ ...base, configuration: { binds: true } }).THINKING_BINDING_PROBE, 'off');
  assert.equal('THINKING_BINDING_PROBE' in hostEnv({ ...base, configuration: { binds: false } }), false);
  assert.equal(hostEnv({ ...base, configuration: {} }).ANTHROPIC_BASE_URL, 'http://127.0.0.1:1');
});
