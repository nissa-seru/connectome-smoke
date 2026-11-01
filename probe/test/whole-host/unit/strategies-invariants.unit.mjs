import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCompile } from '../lib/strategies/invariants.mjs';

// checkCompile over constructed compiles: each of check 11's invariants breaks in each of the forms it names, on a
// store and a compile built to break it, and stays quiet on its control. A store of four messages: a user's text,
// the agent's call t1, its result, and the agent's text.
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

/** A context manager as checkCompile reads one. */
const manager = ({ messages = STORE, summaries = {}, pins = [], config = {}, stats = null } = {}) => ({
  getAllMessages: () => messages,
  getSummary: (id) => (summaries[id] ? { id, level: 1, sourceLevel: 0, ...summaries[id] } : null),
  getStrategy: () => ({ config }),
  getRenderStats: () => stats,
  listPins: () => pins,
});

/**
 * A compile of `sent`, each `r:ID` (a stored message raw, its content as stored or `content` given), or `s:ID@LEVEL`
 * (a summary): `[compiled, messages]` as the module hands them to checkCompile.
 */
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
