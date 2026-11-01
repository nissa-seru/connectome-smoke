import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCompile } from '../lib/strategies/invariants.mjs';
const text = (t) => ({ type: 'text', text: t });
const call = (id) => ({ type: 'tool_use', id, name: 'look', input: {} });
const result = (id) => ({ type: 'tool_result', toolUseId: id, content: 'seen' });
const thinking = { type: 'thinking', thinking: 'why', signature: 'sig' };
const stored = (id, sequence, role, content) => ({ id, sequence, role, participant: role === 'user' ? 'Ann' : 'fixture', content });
const STORE = [
  stored('1', 1, 'user', [text('one')]),
  stored('2', 2, 'assistant', [text('two'), call('t1')]),
  stored('3', 3, 'user', [result('t1')]),
  stored('4', 4, 'assistant', [text('four')]),
];
const byId = new Map(STORE.map((m) => [m.id, m]));

const manager = ({ messages = STORE, summaries = {}, pins = [], config = {}, stats = null } = {}) => ({
  getAllMessages: () => messages,
  getSummary: (id) => (summaries[id] ? { id, level: 1, sourceLevel: 0, ...summaries[id] } : null),
  getStrategy: () => ({ config }),
  getRenderStats: () => stats,
  listPins: () => pins,
});

function compile(sent, { tokens = 100 } = {}) {
  const messages = [];
  const compiled = { messages: [], renderStats: { total: { tokens } } };
  for (const item of sent) {
    const [source, content] = Array.isArray(item) ? item : [item, null];
    messages.push({ sources: [source] });
    if (source.startsWith('r:')) {
      const m = byId.get(source.slice(2).split('!')[0]);
      compiled.messages.push({ role: m.role, content: content ?? m.content });
    } else compiled.messages.push({ role: 'user', content: [text(`summary ${source}`)] });
  }
  return [compiled, messages];
}
const BUDGET = { maxTokens: 1_000, reserveForResponse: 0 };
const check = (m, sent, opts = {}, compileOpts = {}) => checkCompile(m, BUDGET, ...compile(sent, compileOpts), opts);
const named = (violations) => violations.map((v) => [v.invariant, v.detail]);

test('checkCompile: a compile that sends the store as stored, within its budget, breaks nothing', () => {
  assert.deepEqual(check(manager(), ['r:1', 'r:2', 'r:3', 'r:4']), []);
});

test('coverage: a stored body in no message sent, where the configuration compresses; a passthrough isn\'t held to it', () => {
  assert.deepEqual(named(check(manager(), ['r:1', 'r:2', 'r:3'])), [['coverage', '1 stored bodies in no message sent: 4']]);
  assert.deepEqual(check(manager(), ['r:1', 'r:2', 'r:3'], { compresses: false }), []);
});

test('coverage: a stored message under two summaries sent', () => {
  const m = manager({ summaries: { S1: { sourceIds: ['1', '2'] }, S2: { sourceIds: ['2', '3'] } } });
  assert.deepEqual(named(check(m, ['s:S1@1', 's:S2@1', 'r:4'])), [['coverage', '1 stored messages under two summaries sent: 2 in S1, S2']]);
  const once = manager({ summaries: { S1: { sourceIds: ['1', '2'] }, S2: { sourceIds: ['3'] } } });
  assert.deepEqual(check(once, ['s:S1@1', 's:S2@1', 'r:4']), []);
});

test('coverage: what a message covers starts before what the message before it covers (store order)', () => {
  assert.deepEqual(named(check(manager(), ['r:1', 'r:4', 'r:2', 'r:3'])), [
    ['coverage', 'message 2 covers from sequence 2, before message 1\'s 4'],
    ['coverage', 'message 3 covers from sequence 3, before message 1\'s 4'],
  ]);
});

test('beside-sources: a stored message sent raw beside a summary of it', () => {
  const m = manager({ summaries: { S: { sourceIds: ['1'] } } });
  assert.deepEqual(named(check(m, ['s:S@1', 'r:1', 'r:2', 'r:3', 'r:4'])), [['beside-sources', '1 stored messages sent raw beside a summary of them: 1 raw beside S']]);
  assert.deepEqual(check(m, ['s:S@1', 'r:2', 'r:3', 'r:4']), []);
});

test('budget: the compile\'s own count over the input budget and its grace; within the grace, or with enforcement off, breaks nothing', () => {
  assert.deepEqual(named(check(manager(), ['r:1', 'r:2', 'r:3', 'r:4'], {}, { tokens: 1_021 })), [['budget', '1021 tokens against an input budget of 1000 and a grace of 0.02']]);
  assert.deepEqual(check(manager(), ['r:1', 'r:2', 'r:3', 'r:4'], {}, { tokens: 1_020 }), []);
  assert.deepEqual(check(manager({ config: { enforceBudget: false } }), ['r:1', 'r:2', 'r:3', 'r:4'], {}, { tokens: 5_000 }), []);
});

test('shape: a result whose call isn\'t in the message before it, where the configuration compresses', () => {
  const m = manager({ summaries: { S: { sourceIds: ['1', '2'] } } });
  assert.deepEqual(named(check(m, ['s:S@1', 'r:3', 'r:4'])), [['shape', 'message 1: result t1 answers no call in the message before it']]);
});

test('shape: a passthrough opening with a result whose call the store holds before the request\'s start; opening at the call breaks nothing', () => {
  assert.deepEqual(named(check(manager(), ['r:3', 'r:4'], { compresses: false })), [['shape', 'message 0: result t1 answers no call in the message before it']]);
  assert.deepEqual(check(manager(), ['r:2', 'r:3', 'r:4'], { compresses: false }), []);
});

test('shape: a call, not in the last message, unanswered in the message after it', () => {
  const m = manager({ summaries: { S: { sourceIds: ['3'] } } });
  assert.deepEqual(named(check(m, ['r:1', 'r:2', 's:S@1', 'r:4'])), [['shape', 'message 1: call t1 unanswered in the message after it']]);
});

test('thinking: a stored body\'s thinking sent without its calls; with them, nothing', () => {
  const withThinking = STORE.map((m) => (m.id === '2' ? { ...m, content: [thinking, text('two'), call('t1')] } : m));
  const m = manager({ messages: withThinking });
  const two = withThinking[1];
  byId.set('2', two);
  try {
    assert.deepEqual(named(check(m, ['r:1', ['r:2', [thinking, text('two')]]], { compresses: false })), [['thinking', 'message 1 carries body 2\'s thinking without its calls t1']]);
    assert.deepEqual(check(m, ['r:1', 'r:2', 'r:3', 'r:4']), []);
  } finally {
    byId.set('2', STORE[1]);
  }
});

test('pins: a summary sent over a pinned message at a level the pin doesn\'t allow; at an allowed level, nothing', () => {
  const pinned = (level) => manager({ summaries: { S: { sourceIds: ['1', '2'] } }, pins: [{ id: 'p1', firstMessageId: '1', lastMessageId: '2', level }] });
  assert.deepEqual(named(check(pinned(0), ['s:S@1', 'r:3', 'r:4'])).filter(([inv]) => inv === 'pins'), [['pins', 'summary S at L1 covers 1, inside pin p1 allowing L0']]);
  assert.deepEqual(check(pinned(1), ['s:S@1', 'r:3', 'r:4']).filter((v) => v.invariant === 'pins'), []);
});

test('unreadable: a store, pins or stats read that fails is a violation naming the read, never a compile judged clean', () => {
  const failing = (what) => () => { throw new Error(`${what} failed`); };
  assert.deepEqual(named(check({ ...manager(), getAllMessages: failing('store') }, ['r:1'])), [['unreadable', 'getAllMessages: store failed; no invariant was judged']]);
  assert.deepEqual(named(check({ ...manager(), listPins: failing('pins') }, ['r:1', 'r:2', 'r:3', 'r:4'])), [['unreadable', 'listPins: pins failed; pins weren\'t judged']]);
  const [compiled, messages] = compile(['r:1', 'r:2', 'r:3', 'r:4']);
  delete compiled.renderStats;
  assert.deepEqual(named(checkCompile({ ...manager(), getRenderStats: failing('stats') }, BUDGET, compiled, messages)), [['unreadable', 'getRenderStats: stats failed; budget wasn\'t judged']]);
});
const shard = (id, sequence, index, words, group = 'g1') => ({ ...stored(id, sequence, 'user', [text(words)]), bodyGroupId: group, shardIndex: index });

test('coverage is per shard: one shard\'s summary doesn\'t cover the other, and a partial raw copy holds only the shards whose text it carries', () => {
  const sharded = [...STORE, shard('5', 5, 0, 'first half'), shard('6', 6, 1, 'second half')];
  for (const m of sharded) byId.set(m.id, m);
  try {
    const m = manager({ messages: sharded, summaries: { S: { sourceIds: ['5'] } } });
    assert.deepEqual(named(check(m, ['r:1', 'r:2', 'r:3', 'r:4', 's:S@1'])), [['coverage', '1 stored bodies in no message sent: 5 (shards 6)']]);
    assert.deepEqual(check(m, ['r:1', 'r:2', 'r:3', 'r:4', 's:S@1', ['r:5!shards', [text('second half')]]]), [], 'the partial copy carries the second shard');
    assert.deepEqual(named(check(manager({ messages: sharded }), ['r:1', 'r:2', 'r:3', 'r:4', ['r:5!shards', [text('first half')]]])), [['coverage', '1 stored bodies in no message sent: 5 (shards 6)']]);
    assert.deepEqual(check(manager({ messages: sharded }), ['r:1', 'r:2', 'r:3', 'r:4', 'r:5']), [], 'a whole raw copy holds every shard');
  } finally {
    for (const m of sharded) if (!STORE.includes(m)) byId.delete(m.id);
  }
});

test('a raw copy context-manager marks altered (`!content`) but not partial carries every shard: covered, and beside a summary of one of them', () => {
  const sharded = [...STORE, shard('5', 5, 0, 'first half'), shard('6', 6, 1, 'second half')];
  for (const m of sharded) byId.set(m.id, m);
  try {
    assert.deepEqual(check(manager({ messages: sharded }), ['r:1', 'r:2', 'r:3', 'r:4', ['r:5!content', [text('first half, altered')]]]), []);
    const m = manager({ messages: sharded, summaries: { S: { sourceIds: ['6'] } } });
    assert.deepEqual(named(check(m, ['r:1', 'r:2', 'r:3', 'r:4', ['r:5!content', [text('first half, altered')]], 's:S@1'])), [['beside-sources', '1 stored messages sent raw beside a summary of them: 6 raw beside S']]);
  } finally {
    for (const m of sharded) if (!STORE.includes(m)) byId.delete(m.id);
  }
});

test('bodies are context-manager\'s: two ingestions of one text, sharing a group id, are two bodies, so the second sent nowhere is a lost body', () => {
  const twice = [...STORE, shard('5', 5, 0, 'doc a'), shard('6', 6, 1, 'doc b'), shard('7', 7, 0, 'doc a'), shard('8', 8, 1, 'doc b')];
  for (const m of twice) byId.set(m.id, m);
  try {
    assert.deepEqual(named(check(manager({ messages: twice }), ['r:1', 'r:2', 'r:3', 'r:4', 'r:5'])), [['coverage', '1 stored bodies in no message sent: 7']]);
    assert.deepEqual(check(manager({ messages: twice }), ['r:1', 'r:2', 'r:3', 'r:4', 'r:5', 'r:7']), []);
  } finally {
    for (const m of twice) if (!STORE.includes(m)) byId.delete(m.id);
  }
});
