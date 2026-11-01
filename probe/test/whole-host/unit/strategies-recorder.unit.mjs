import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blobStore, storeDelta } from '../lib/strategies/recorder.mjs';
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

test('storeDelta: context-manager\'s quarantines, compression spans and merges, are reported when they move', () => {
  const blobs = blobStore();
  let status = { count: 0, keys: [], spans: [] };
  let merges = 0;
  const strategy = { getCompressionQuarantineStatus: () => status, getMergeQuarantineStatus: () => ({ count: merges, records: [] }) };
  const m = { ...manager([]), getStrategy: () => strategy };
  const first = storeDelta(m, undefined, blobs);
  assert.deepEqual(first.out.quarantine, { compression: 0, merge: 0 });
  assert.equal(storeDelta(m, first.seen, blobs).out.quarantine, undefined, 'unmoved');
  status = { count: 3, keys: ['a', 'b', 'c'], spans: [{}] };
  merges = 1;
  assert.deepEqual(storeDelta(m, first.seen, blobs).out.quarantine, { compression: 1, merge: 1 }, 'spans, each once however many records it holds');
  status = { count: 0, keys: [], spans: [], unreadable: true };
  assert.deepEqual(storeDelta(m, first.seen, blobs).out.quarantine, { compression: null, merge: 1 }, 'a quarantine context-manager couldn\'t read is unknown, not none');
  assert.equal(storeDelta(manager([]), undefined, blobs).out.quarantine, undefined, 'a strategy with no quarantine reports none');
});
