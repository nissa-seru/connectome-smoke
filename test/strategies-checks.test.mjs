import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declaredProducts, everyTurnAnswers, wellFormed } from '../lib/strategies/checks.mjs';
import { continuation, products, configurations } from '../lib/strategies/script.mjs';

const msg = (role, ...blocks) => ({ role, blocks });
const text = (canaries) => ({ type: 'text', chars: 10, ...(canaries ? { canaries } : {}) });
const call = (id) => ({ type: 'tool_use', chars: 10, toolUseId: id });
const result = (id, images) => ({ type: 'tool_result', chars: 10, toolUseId: id, ...(images ? { images } : {}) });

test('check 2 names each segment whose product no record in it shows, and only those', () => {
  const script = continuation();
  const wanted = products(configurations().default);
  const records = [
    { id: 'r1', step: 'c.cm.1', kind: 'summariser', level: 1, answer: { shape: 'summary' } },
    { id: 'r2', step: 'c.tool', kind: 'agent', messages: [msg('user', text()), msg('assistant', call('a'), call('b')), msg('user', result('a'), result('b', 1))] },
    { id: 'r3', step: 'c.par', kind: 'agent', messages: [msg('assistant', call('a'), call('b'), call('c')), msg('user', result('a'), result('b'), result('c'))] },
  ];
  const missing = declaredProducts(records, script, wanted);
  assert.deepEqual(missing.map((m) => m.segment), ['close-merge', 'thinking-call', 'held']);
  assert.deepEqual(missing[0].missing, ['a merge request']);
});

test('check 2: a configuration that doesn\'t summarise declares no summariser products', () => {
  const missing = declaredProducts([], continuation(), products(configurations().passthrough));
  assert.deepEqual(missing.map((m) => m.segment), ['tool-round', 'parallel', 'thinking-call']);
});

test('check 1 flags unclassified and refused requests, failure events and unsettled checkpoints', () => {
  const flags = everyTurnAnswers(
    [{ id: 'r1', step: 's', kind: 'agent' }, { id: 'r2', step: 's', kind: 'unclassified', reason: 'x' }, { id: 'r3', step: 't', kind: 'agent', refused: 'window' }],
    [{ kind: 'ipc', step: 'u', event: { type: 'inference:failed', error: 'boom' } }, { kind: 'settle', phase: 'end', step: 'v', settled: false }, { kind: 'settle', phase: 'end', step: 'w', settled: true }],
  );
  assert.deepEqual(flags.map((f) => f.step), ['s', 't', 'u', 'v']);
  assert.ok(flags.every((f) => f.check === 1));
});

test('check 3 flags roles out of turn and calls parted from their results, either way', () => {
  const ok = { id: 'ok', step: 's', kind: 'agent', messages: [msg('user', text()), msg('assistant', call('a')), msg('user', result('a'))] };
  const twice = { id: 'twice', step: 's', kind: 'agent', messages: [msg('user', text()), msg('user', text())] };
  const orphan = { id: 'orphan', step: 's', kind: 'agent', messages: [msg('user', text()), msg('assistant', text()), msg('user', result('a'))] };
  const unanswered = { id: 'unanswered', step: 's', kind: 'summariser', messages: [msg('assistant', call('a')), msg('user', text()), msg('assistant', text()), msg('user', text())] };
  // A call in the last message is the model's own turn to come, and waits for nothing.
  const lastCall = { id: 'last', step: 's', kind: 'agent', messages: [msg('user', text()), msg('assistant', call('a'))] };
  const flags = wellFormed([ok, twice, orphan, unanswered, lastCall]);
  assert.deepEqual(flags.map((f) => f.request), ['twice', 'orphan', 'unanswered']);
});
