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
