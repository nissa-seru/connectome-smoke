// The strategy fixture's comparison across runs (lib/strategies/compare.mjs). Each test names
// the requirement it pins (cm-fixture-build/lane-requirements.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskRunVarying, sameAcrossRuns } from '../lib/strategies/compare.mjs';

// A request body as the host sends one after a tool round with an image, and a thinking reply.
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
  // A record as the stand-in keeps one carries the signature the same way.
  const record = (signature) => ({ kind: 'agent', messages: [{ role: 'assistant', blocks: [{ type: 'thinking', chars: 8, signature }] }] });
  assert.equal(sameAcrossRuns(record('fx1.AAAA'), record('fx1.CCCC')), true);
  // The mask leaves its input as it was.
  assert.equal(a.messages[1].content[0].signature, 'fx1.AAAA');
  assert.match(a.messages[2].content[0].content[0].text, /img_2ie66y_1/);
});

test('N12: any other difference compares unequal, the ref\'s sequence number and the order of keys included', { timeout: 30_000 }, () => {
  const a = body();
  for (const [what, b] of [
    ['the ref\'s sequence number', body({ seq: 2 })],
    ['a character of a message', body({ text: 'hellp [[c:c.chat.in]]' })],
    ['the model', body({ model: 'claude-opus-4-5' })],
  ]) assert.equal(sameAcrossRuns(a, b), false, what);
  // A signature on a block that isn't thinking is content like any other field.
  const signed = (signature) => { const x = body(); x.messages[1].content[1].signature = signature; return x; };
  assert.equal(sameAcrossRuns(signed('fx1.YYYY'), signed('fx1.ZZZZ')), false, 'a signature on a block that isn\'t thinking');
  const { model, ...rest } = a;
  assert.equal(sameAcrossRuns(a, { ...rest, model }), false, 'the order of keys');
});
