import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blobStore, compiledLine, storeDelta } from '../lib/strategies/recorder.mjs';
import { readsFailed } from '../lib/strategies/ledger.mjs';
class PassthroughStrategy {}
const manager = (messages) => ({
  getAllMessages: () => messages,
  getSummariesInRange: () => [],
  getSummary: () => null,
  getStrategy: () => new PassthroughStrategy(),
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

test('storeDelta: a take with no earlier one lists the whole store and says so; a later take is a delta and doesn\'t', () => {
  const blobs = blobStore();
  const first = storeDelta(manager([{ id: 1, content: [text('[[c:a.r1]] hello')] }]), undefined, blobs);
  assert.equal(first.out.whole, true);
  assert.equal(first.changed, true);
  const empty = storeDelta(manager([]), undefined, blobs);
  assert.deepEqual([empty.out, empty.changed], [{ whole: true, messages: [], summaries: [] }, true], 'an empty store too, with its empty lists, so a restart that lost everything says it holds nothing');
  const later = storeDelta(manager([{ id: 1, content: [text('[[c:a.r1]] hello')] }]), first.seen, blobs);
  assert.deepEqual([later.out, later.changed], [{}, false]);
});

test('storeDelta: context-manager\'s quarantines, compression spans and merge records, are reported by identity when they move', () => {
  const blobs = blobStore();
  let status = { count: 0, keys: [], spans: [] };
  let records = [];
  const strategy = { getCompressionQuarantineStatus: () => status, getMergeQuarantineStatus: () => ({ count: records.length, records }) };
  const m = { ...manager([]), getStrategy: () => strategy };
  const first = storeDelta(m, undefined, blobs);
  assert.deepEqual(first.out.quarantine, { compression: [], merge: [] });
  assert.equal(storeDelta(m, first.seen, blobs).out.quarantine, undefined, 'unmoved');
  status = { count: 3, keys: ['a', 'b', 'c'], spans: [{ chunkSourceHash: 'span-b' }, { chunkSourceHash: 'span-a' }] };
  records = [{ key: 'merge-1' }];
  assert.deepEqual(storeDelta(m, first.seen, blobs).out.quarantine, { compression: ['span-a', 'span-b'], merge: ['merge-1'] }, 'each span once however many records it holds, and each merge record, by identity, in order');
  status = { count: 0, keys: [], spans: [], unreadable: true };
  assert.deepEqual(storeDelta(m, first.seen, blobs).out.quarantine, { compression: null, merge: ['merge-1'] }, 'a quarantine context-manager couldn\'t read is unknown, not none');
  assert.equal(storeDelta(manager([]), undefined, blobs).out.quarantine, undefined, 'a passthrough, which has no quarantine, reports none');
  const renamed = { ...manager([]), getStrategy: () => ({ getCompressionQuarantineStatus: () => status }) };
  assert.match(storeDelta(renamed, undefined, blobs).out.quarantine?.unreadable ?? '', /getMergeQuarantineStatus/, 'a strategy that compresses with no merge quarantine to read is unreadable, not one with none');
});

test('storeDelta: a quarantined span or merge record with no identity is a read this can\'t make, not a quarantine', () => {
  const blobs = blobStore();
  const withSpan = (span) => ({ ...manager([]), getStrategy: () => ({ getCompressionQuarantineStatus: () => ({ count: 1, keys: ['a'], spans: [span] }), getMergeQuarantineStatus: () => ({ count: 0, records: [] }) }) });
  assert.match(storeDelta(withSpan({ hash: 'renamed' }), undefined, blobs).out.quarantine?.unreadable ?? '', /chunkSourceHash/);
  const withRecord = { ...manager([]), getStrategy: () => ({ getCompressionQuarantineStatus: () => ({ count: 0, keys: [], spans: [] }), getMergeQuarantineStatus: () => ({ count: 1, records: [{ id: 'renamed' }] }) }) };
  assert.match(storeDelta(withRecord, undefined, blobs).out.quarantine?.unreadable ?? '', /key/);
});

test('storeDelta: a read that throws an error with no message is unreadable with a reason, so the receipt it was to read is a failed read, not a receipt', () => {
  class PassthroughStrategy { beginKvUnifiedSubmission() {} get kvUnifiedReceipts() { throw new Error(); } }
  const out = storeDelta({ ...manager([]), getStrategy: () => new PassthroughStrategy() }, undefined, blobStore()).out;
  assert.equal(out.receiptHead?.unreadable, 'Error with no message');
  assert.deepEqual(readsFailed([{ kind: 'compiles', step: 'a', boot: 1, lines: [], store: { fixture: out }, blobs: {} }]), ['receipt']);
});

test('storeDelta: a strategy that takes kv-unified submissions but has no receipt chain to read is reported unreadable, not as no receipt', () => {
  const blobs = blobStore();
  const on = (strategy) => ({ ...manager([]), getStrategy: () => strategy });
  const begin = () => {};
  assert.match(storeDelta(on({ beginKvUnifiedSubmission: begin }), undefined, blobs).out.receiptHead?.unreadable ?? '', /kvUnifiedReceipts/, 'the chain is gone');
  assert.match(storeDelta(on({ beginKvUnifiedSubmission: begin, kvUnifiedReceipts: {} }), undefined, blobs).out.receiptHead?.unreadable ?? '', /head/, 'the chain has no head');
  assert.equal(storeDelta(on({ beginKvUnifiedSubmission: begin, kvUnifiedReceipts: { head: null } }), undefined, blobs).out.receiptHead, undefined, 'a chain with no receipt yet has none');
  assert.equal(storeDelta(on({}), undefined, blobs).out.receiptHead, undefined, 'a strategy that takes no kv-unified submissions has none');
});

test('storeDelta: a receipt head without a numeric sequence, a changes list, or a readable change is reported unreadable, not as a receipt', () => {
  const blobs = blobStore();
  const leaf = { repHash: 'r:1', level: 0, lastChangedSeq: 3 };
  const headed = (head) => ({ ...manager([]), getStrategy: () => ({ beginKvUnifiedSubmission() {}, kvUnifiedReceipts: { head } }) });
  const good = { sequence: 2, receiptHash: 'h', parentReceiptHash: null, requestHash: 'q', layoutHash: 'l', changes: [{ leafId: 'm1', value: leaf }, { leafId: 'm2', value: null }] };
  assert.deepEqual(storeDelta(headed(good), undefined, blobs).out.receiptHead.changes, [['m1', ['r:1', 0, 3]], ['m2', null]], 'a leaf presented and a leaf removed');
  const unread = (head) => storeDelta(headed(head), undefined, blobs).out.receiptHead?.unreadable ?? '';
  assert.match(unread({ ...good, sequence: undefined }), /sequence/);
  assert.match(unread({ ...good, changes: undefined }), /changes list/);
  assert.match(unread({ ...good, changes: [{ leafId: 'm1', leaf }] }), /value/, 'a renamed value');
  assert.match(unread({ ...good, changes: [{ leafId: 'm1', value: { hash: 'r:1', level: 0, lastChangedSeq: 3 } }] }), /repHash/, 'a renamed repHash');
  assert.match(unread({ ...good, changes: [{ id: 'm1', value: leaf }] }), /leafId/, 'a renamed leafId');
});

test('compiledLine: a compile whose provenance gives no sources list matching its messages, or a source of a kind context-manager 0.24.0 doesn\'t give, has an unreadable violation', () => {
  class AutobiographicalStrategy { config = {}; getRenderStats() { return { total: { tokens: 10 } }; } }
  const stored = [{ id: '1', sequence: 1, role: 'user', content: [text('one')] }];
  const layout = { memberIds: ['1'], units: [{ k: 'r', t: 1 }] };
  const raw = { kind: 'raw', bodies: [{ messageId: '1', complete: true }] };
  const line = (compiled) => compiledLine(
    { ...manager(stored), getStrategy: () => new AutobiographicalStrategy(), listPins: () => [], getRenderStats: () => null },
    { maxTokens: 1_000, reserveForResponse: 0 },
    { renderStats: { total: { tokens: 10 } }, ...compiled },
    blobStore(),
  );
  const sent = [{ role: 'user', content: [text('one')] }];
  const unreadable = (l) => l.violations.filter((v) => v.invariant === 'unreadable').map((v) => v.detail);
  assert.deepEqual(unreadable(line({ messages: sent, provenance: { messages: [raw], layout } })), [], 'the control');
  assert.match(unreadable(line({ messages: sent, provenance: { layout } })).join(), /no messages list/);
  assert.match(unreadable(line({ messages: sent, provenance: { messages: [], layout } })).join(), /sources for 0 of its 1 messages/);
  assert.match(unreadable(line({ messages: sent, provenance: { messages: [{ kind: 'stored', bodies: [] }], layout } })).join(), /kind context-manager 0.24.0 doesn't: stored/);
  assert.deepEqual(unreadable(line({ messages: sent, provenance: { messages: [{ kind: 'other' }], layout } })), [], 'a message that stands for nothing stored is a source of its own');
  assert.deepEqual(unreadable(line({ messages: [], provenance: { layout: { memberIds: [], units: [] } } })), [], 'a compile of nothing has no sources to misread');
});

test('compiledLine: a source of a kind context-manager 0.24.0 gives, without the fields 0.24.0 gives it, has an unreadable violation, and no sources are read from it', () => {
  class AutobiographicalStrategy { config = {}; getRenderStats() { return { total: { tokens: 10 } }; } }
  const stored = [{ id: '1', sequence: 1, role: 'user', content: [text('one')] }];
  const layout = { memberIds: ['1'], units: [{ k: 'r', t: 1 }] };
  const line = (source) => compiledLine(
    { ...manager(stored), getStrategy: () => new AutobiographicalStrategy(), listPins: () => [], getRenderStats: () => null },
    { maxTokens: 1_000, reserveForResponse: 0 },
    { renderStats: { total: { tokens: 10 } }, messages: [{ role: 'user', content: [text('one')] }], provenance: { messages: [source], layout } },
    blobStore(),
  );
  const fieldsUnread = (source) => line(source).violations.some((v) => v.invariant === 'unreadable' && /without the fields context-manager 0\.24\.0 gives them/.test(v.detail));
  const raw = (body) => ({ kind: 'raw', bodies: [body] });
  for (const source of [
    raw({ messageId: '1', complete: true }),
    raw({ messageId: '1', complete: false, missing: ['content'] }),
    raw({ messageId: '1', complete: false, missing: ['shards', 'content'] }),
    { kind: 'summary', summaries: [{ id: 'S', level: 1 }] },
    { kind: 'summary', summaries: [{ id: 'S', level: 1, partial: true }] },
    { kind: 'injection', namespace: 'recall' },
    { kind: 'other' },
  ]) assert.equal(fieldsUnread(source), false, JSON.stringify(source));
  for (const source of [
    { kind: 'raw' },
    raw({ complete: true }),
    raw({ messageId: '1', complete: 'yes' }),
    raw({ messageId: '1', complete: false }),
    raw({ messageId: '1', complete: false, missing: [] }),
    raw({ messageId: '1', complete: false, missing: ['images'] }),
    { kind: 'summary' },
    { kind: 'summary', summaries: [{ level: 1 }] },
    { kind: 'summary', summaries: [{ id: 'S' }] },
    { kind: 'summary', summaries: [{ id: 'S', level: 1, partial: false }] },
    { kind: 'injection' },
  ]) {
    assert.equal(fieldsUnread(source), true, JSON.stringify(source));
    assert.deepEqual(line(source).messages[0].sources, ['o'], `no sources are read from ${JSON.stringify(source)}`);
  }
});

test('storeDelta: a strategy that can\'t be read when the quarantine is first sampled is reported unreadable, not as none', () => {
  const failing = { ...manager([]), getStrategy: () => { throw new Error('gone'); } };
  assert.deepEqual(storeDelta(failing, undefined, blobStore()).out.quarantine, { unreadable: 'gone' });
});

test('storeDelta: a summary read that fails keeps the summaries last read, so a later removal is still reported', () => {
  const blobs = blobStore();
  let listed = [{ id: 'S' }];
  let failing = false;
  const m = { ...manager([]), getSummariesInRange: () => { if (failing) throw new Error('gone'); return listed; }, getSummary: (id) => ({ id, level: 1, sourceLevel: 0, sourceIds: [], content: 'c' }) };
  const first = storeDelta(m, undefined, blobs);
  assert.deepEqual(first.out.summaries.map((s) => s.id), ['S']);
  failing = true;
  const unread = storeDelta(m, first.seen, blobs);
  assert.deepEqual(unread.out.summaries, { unreadable: 'gone' });
  failing = false;
  listed = [];
  assert.deepEqual(storeDelta(m, unread.seen, blobs).out.removed, ['S']);
});

test('storeDelta: a stored message whose canaries change is reported again, its thinking bit with it', () => {
  const blobs = blobStore();
  const first = storeDelta(manager([{ id: 9, content: [text('[[c:a.in]] hi')] }]), undefined, blobs);
  assert.deepEqual(first.out.messages, [['9', ['[[c:a.in]]']]]);
  assert.deepEqual(storeDelta(manager([{ id: 9, content: [text('[[c:b.in]] hi')] }]), first.seen, blobs).out.messages, [['9', ['[[c:b.in]]']]]);
  const thought = storeDelta(manager([{ id: 9, content: [thinking, text('[[c:a.in]] hi')] }]), undefined, blobs);
  assert.deepEqual(storeDelta(manager([{ id: 9, content: [thinking, text('[[c:c.in]] hi')] }]), thought.seen, blobs).out.messages, [['9', ['[[c:c.in]]'], { thinking: true }]]);
});

test('storeDelta: a stored message gone from the store is reported removed and forgotten, so it can be reported again if it returns', () => {
  const blobs = blobStore();
  const a = { id: 1, content: [text('[[c:a.in]] one')] }, b = { id: 2, content: [text('[[c:b.in]] two')] };
  const first = storeDelta(manager([a, b]), undefined, blobs);
  const undone = storeDelta(manager([a]), first.seen, blobs);
  assert.deepEqual([undone.out.messages, undone.out.removedMessages], [undefined, ['2']]);
  assert.equal(storeDelta(manager([a]), undone.seen, blobs).out.removedMessages, undefined, 'reported once');
  assert.deepEqual(storeDelta(manager([a, b]), undone.seen, blobs).out.messages, [['2', ['[[c:b.in]]']]]);
});

test('compiledLine: a compile whose strategy gives no render stats carries its unjudged budget on the line; one with its own stats carries them and nothing unjudged', () => {
  class PassthroughStrategy { config = {}; }
  class AutobiographicalStrategy { config = {}; getRenderStats() { return { total: { tokens: 99_999 } }; } }
  const stored = [{ id: '1', sequence: 1, role: 'user', content: [text('one')] }];
  const line = (strategy, renderStats) => compiledLine(
    { ...manager(stored), getStrategy: () => strategy, listPins: () => [], getRenderStats: () => strategy.getRenderStats?.() ?? null },
    { maxTokens: 1_000, reserveForResponse: 0 },
    { messages: [{ role: 'user', content: [text('one')] }], provenance: { messages: [{ kind: 'raw', bodies: [{ messageId: '1', complete: true }] }], layout: { memberIds: ['1'], units: [{ k: 'r', t: 1 }] } }, ...(renderStats ? { renderStats } : {}) },
    blobStore(),
  );
  const passthrough = line(new PassthroughStrategy());
  assert.deepEqual([passthrough.unjudged, passthrough.stats, passthrough.violations], [['budget: PassthroughStrategy gives no render stats'], null, []]);
  const own = line(new AutobiographicalStrategy(), { total: { tokens: 10 } });
  assert.deepEqual([own.unjudged, own.stats, own.violations], [undefined, { total: { tokens: 10 } }, []]);
});
