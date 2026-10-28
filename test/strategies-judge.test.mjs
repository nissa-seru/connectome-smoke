import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge } from '../lib/strategies/judge.mjs';
import { configurations, continuation } from '../lib/strategies/script.mjs';

const store = { messages: [], summaries: [] };
const counting = (audit = { status: 0, output: '' }) => {
  const calls = { read: 0, audit: 0 };
  return {
    calls,
    readers: {
      readStore: async () => { calls.read++; return store; },
      audit: () => { calls.audit++; return audit; },
    },
  };
};
const side = (configuration, over = {}) => ({
  records: [], log: [], script: continuation(), storeCopy: '/nowhere/session', configuration, installDir: '/nowhere', run: { ok: true, failure: null }, ...over,
});

test('K2d: the judge holds a reported window against its configuration\'s stand-in window', async () => {
  const usage = { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 };
  const r1 = { id: 'r1', step: 'a', kind: 'agent', messageTokens: 900, maxTokens: 2_048, usage, messages: [{ role: 'user', digest: 'd1', blocks: [] }], answer: { shape: 'reply', toolUseIds: ['t1'] } };
  const r2 = { ...r1, id: 'r2', messages: [...r1.messages, { role: 'assistant', digest: 'd2', blocks: [{ type: 'tool_use', toolUseId: 't1' }] }, { role: 'user', digest: 'd3', blocks: [] }], answer: { shape: 'reply', toolUseIds: [] } };
  const report = (window) => ({ kind: 'budget-report', boot: 1, lines: ['--- Stream Token Budgets ---', `  fixture: 150.0k (last: 0, 0%); its stream doesn't break at this budget mid-turn: for its size, only before a request its ${window} window can't hold`] });
  const checkpoint = { kind: 'checkpoint', name: 's', step: 's.cp', health: { data: { contextComposition: { fixture: { planVsActual: { budgetMet: true } } }, runtimeSettings: { fixture: { effectiveContextBudgetTokens: 20_000 } } } } };
  const sent = (id) => ({ kind: 'request', request: { id, kind: 'agent' } });
  const configuration = configurations().default;
  const run = (window) => judge({ ...side(configuration, { records: [r1, r2], script: [{ id: 'a', segment: 's' }], log: [report(window), sent('r1'), sent('r2'), checkpoint] }), readers: counting().readers });
  assert.equal(configuration.windowTokens, 200_000);
  assert.equal((await run('200.0k')).notes.length, 1, 'the stand-in\'s window, as the host writes it');
  assert.ok((await run('1.0M')).flags.some((f) => f.check === 3 && f.request === 'r2' && /couldn't judge/.test(f.message)), 'another window');
});

test('a run that failed counts against its side, naming its failure, and its store is not read', async () => {
  const { calls, readers } = counting();
  const judged = await judge({ ...side(configurations().default, { run: { ok: false, failure: { reason: 'the host exited' } } }), readers });
  const failed = judged.flags.filter((f) => f.check === 1 && f.step === 'the run');
  assert.equal(failed.length, 1);
  assert.match(failed[0].message, /the host exited/);
  assert.deepEqual(calls, { read: 0, audit: 0 });
});

test('the store is read and audited where the configuration keeps summaries, and only there', async () => {
  const kept = counting();
  await judge({ ...side(configurations().default), readers: kept.readers });
  assert.deepEqual(kept.calls, { read: 1, audit: 1 });
  const none = counting();
  await judge({ ...side(configurations().passthrough), readers: none.readers });
  assert.deepEqual(none.calls, { read: 0, audit: 0 });
});

test('the audit\'s violations are a check 5 flag on the run; an audit that could not run leaves the side unjudged', async () => {
  const violated = counting({ status: 2, output: 'L2 overlaps L2' });
  const judged = await judge({ ...side(configurations().default), readers: violated.readers });
  const audit = judged.flags.filter((f) => f.check === 5 && f.step === 'the run');
  assert.equal(audit.length, 1);
  assert.match(audit[0].message, /L2 overlaps L2/);
  const broken = counting({ status: 1, output: 'no such namespace' });
  await assert.rejects(judge({ ...side(configurations().default), readers: broken.readers }), /no such namespace/);
});

test('a run that succeeded with no store copy leaves the side unjudged where summaries are kept', async () => {
  const { readers } = counting();
  await assert.rejects(judge({ ...side(configurations().default, { storeCopy: null }), readers }), /no store copy/);
  const judged = await judge({ ...side(configurations().passthrough, { storeCopy: null }), readers });
  assert.ok(Array.isArray(judged.flags));
});
