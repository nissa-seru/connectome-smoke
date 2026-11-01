import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskRunVarying } from '../lib/strategies/compare.mjs';

const sameAcrossRuns = (a, b) => JSON.stringify(maskRunVarying(a)) === JSON.stringify(maskRunVarying(b));

const body = ({ nonce = '2ie66y', seq = 1, signature = 'fx1.AAAA', text = 'hello [[c:c.chat.in]]', model = 'claude-opus-4-6' } = {}) => ({
  model,
  max_tokens: 2048,
  messages: [
    { role: 'user', content: [{ type: 'text', text }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'about it', signature }, { type: 'tool_use', id: 'toolu_fx000001', name: 'mcpl--fixture--result', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fx000001', content: [{ type: 'text', text: `[image: image/png, ~9KB, ref img_${nonce}_${seq}]\n[[c:c.tool.call2]]` }] }] },
  ],
});

test('N12: two runs\' bodies that differ only in the image ledger\'s nonce and thinking signatures compare equal', { timeout: 30_000 }, () => {
  const a = body();
  const b = body({ nonce: 'nai651', signature: 'fx1.BBBB' });
  assert.notDeepEqual(a, b);
  assert.equal(sameAcrossRuns(a, b), true);
  assert.deepEqual(maskRunVarying(a), maskRunVarying(b));
  const record = (signature) => ({ kind: 'agent', messages: [{ role: 'assistant', blocks: [{ type: 'thinking', chars: 8, signature }] }] });
  assert.equal(sameAcrossRuns(record('fx1.AAAA'), record('fx1.CCCC')), true);
  assert.equal(a.messages[1].content[0].signature, 'fx1.AAAA');
  assert.match(a.messages[2].content[0].content[0].text, /img_2ie66y_1/);
});

test('N12: two runs\' bodies that differ only in a fork call\'s random UUID compare equal, and the fork\'s name still counts', () => {
  const fork = (name, uuid) => ({ role: 'assistant', content: [{ type: 'tool_use', id: `fork-${name}-${uuid}`, name: 'subagent--fork', input: { name } }] });
  assert.equal(sameAcrossRuns(fork('fork-321741', 'd5641659-0a1b-4c2d-8e3f-123456789abc'), fork('fork-321741', '7271e5fa-9f8e-4d7c-b6a5-cba987654321')), true);
  assert.equal(sameAcrossRuns(fork('fork-321741', 'd5641659-0a1b-4c2d-8e3f-123456789abc'), fork('fork-321742', 'd5641659-0a1b-4c2d-8e3f-123456789abc')), false);
  const result = (uuid) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `fork-w9-${uuid}`, content: 'forked' }] });
  assert.equal(sameAcrossRuns(result('d5641659-0a1b-4c2d-8e3f-123456789abc'), result('7271e5fa-9f8e-4d7c-b6a5-cba987654321')), true, 'its result names it the same way');
});

test('N12: any other difference compares unequal, the ref\'s sequence number and the order of keys included', { timeout: 30_000 }, () => {
  const a = body();
  for (const [what, b] of [
    ['the ref\'s sequence number', body({ seq: 2 })],
    ['a character of a message', body({ text: 'hellp [[c:c.chat.in]]' })],
    ['the model', body({ model: 'claude-opus-4-5' })],
  ]) assert.equal(sameAcrossRuns(a, b), false, what);
  const signed = (signature) => { const x = body(); x.messages[1].content[1].signature = signature; return x; };
  assert.equal(sameAcrossRuns(signed('fx1.YYYY'), signed('fx1.ZZZZ')), false, 'a signature on a block that isn\'t thinking');
  const { model, ...rest } = a;
  assert.equal(sameAcrossRuns(a, { ...rest, model }), false, 'the order of keys');
});
