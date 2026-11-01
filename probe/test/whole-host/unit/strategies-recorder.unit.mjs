import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blobStore, storeDelta } from '../lib/strategies/recorder.mjs';

// A context manager as storeDelta reads one: its stored messages, no summaries, no receipt chain.
const manager = (messages) => ({
  getAllMessages: () => messages,
  getSummariesInRange: () => [],
  getSummary: () => null,
  getStrategy: () => ({}),
});
const text = (t) => ({ type: 'text', text: t });
const thinking = { type: 'thinking', thinking: 'why', signature: 'sig' };

test('storeDelta: a stored message holding thinking is added with the bit; one without, as before; a bit that changes is sent again', () => {
  const blobs = blobStore();
  const plainReply = { id: 1, content: [text('[[c:a.r1]] hello')] };
  const thought = { id: 2, content: [thinking, text('[[c:a.r2]] then')] };
  const first = storeDelta(manager([plainReply, thought]), undefined, blobs);
  assert.deepEqual(first.out.messages, [['1', ['[[c:a.r1]]']], ['2', ['[[c:a.r2]]'], { thinking: true }]]);
  const again = storeDelta(manager([plainReply, thought]), first.seen, blobs);
  assert.equal(again.out.messages, undefined, 'nothing new and no bit changed');
  const stripped = storeDelta(manager([plainReply, { ...thought, content: [text('[[c:a.r2]] then')] }]), first.seen, blobs);
  assert.deepEqual(stripped.out.messages, [['2', ['[[c:a.r2]]'], { thinking: false }]], 'thinking gone from the stored copy');
  const redacted = storeDelta(manager([{ ...plainReply, content: [{ type: 'redacted_thinking', data: 'x' }, text('[[c:a.r1]] hello')] }]), first.seen, blobs);
  assert.deepEqual(redacted.out.messages, [['1', ['[[c:a.r1]]'], { thinking: true }]], 'redacted thinking counts');
});
