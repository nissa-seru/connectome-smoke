// The characterization fixture's recorder (lib/cm-fixture/trace.mjs): the invariants it checks on each compiled
// request, and the trace it writes. A stand-in manager answers the public reads the recorder makes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCompile, openRecorder } from '../lib/cm-fixture/trace.mjs';
import { readTrace, SCHEMA } from '../lib/cm-fixture/events.mjs';

// A store of four messages: a user turn, a call with its thinking, its result, and a reply; L1-0 summarises 1-2.
function manager({ pins = [], tokens = 500, config = {}, idBase = 0 } = {}) {
  const id = (n) => String(idBase + n);
  const messages = [
    { id: id(1), sequence: 1, participant: 'User', content: [{ type: 'text', text: 'hello' }] },
    { id: id(2), sequence: 2, participant: 'Junga', content: [{ type: 'thinking', thinking: 'why', signature: 's' }, { type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
    { id: id(3), sequence: 3, participant: 'User', content: [{ type: 'tool_result', toolUseId: 't1', content: 'file' }] },
    { id: id(4), sequence: 4, participant: 'Junga', content: [{ type: 'text', text: 'done' }] },
  ];
  const summaries = { 'L1-0': { id: 'L1-0', level: 1, sourceLevel: 0, sourceIds: [id(1), id(2)], content: 'a summary', tokens: 5 } };
  return {
    getAllMessages: () => messages,
    getMessage: (m) => messages.find((x) => x.id === String(m)) ?? null,
    getSummary: (s) => summaries[s] ?? null,
    getSummariesInRange: () => Object.values(summaries).map((s) => ({ id: s.id, level: s.level, content: s.content, tokens: s.tokens })),
    listPins: () => pins,
    getRenderStats: () => ({ total: { messages: 4, tokens } }),
    getStrategy: () => ({ config }),
    getWaitingWork: () => null,
    getPendingWork: () => null,
    isReady: () => true,
    getCompressionHoldDetails: () => new Map(),
    getMaxSummaryLevel: () => 1,
    getDerivation: () => null,
    listBranches: () => [{ id: '1', name: 'main', head: 9, created: Date.now() }],
    getHotContextSettings: () => null,
    messages,
  };
}
const budget = { maxTokens: 1000, reserveForResponse: 100 };
const raw = (...ids) => ({ kind: 'raw', bodies: ids.map((m) => ({ messageId: String(m), sequence: Number(m), complete: true })) });
const summary = (sid, level = 1) => ({ kind: 'summary', summaries: [{ id: sid, level }] });
// A compiled request, as compile returns one, from [content, provenance] pairs.
const compiled = (...entries) => ({ messages: entries.map(([m]) => m), provenance: { messages: entries.map(([, p]) => p), layout: null } });
const sent = (m) => ({ participant: m.participant, content: m.content });
const check = (mgr, c, o) => checkCompile(mgr, budget, c, c.messages.map((m, i) => ({ sources: (() => { const p = c.provenance.messages[i]; return p.kind === 'raw' ? p.bodies.map((b) => `r:${b.messageId}`) : p.kind === 'summary' ? p.summaries.map((s) => `s:${s.id}@${s.level}`) : ['o']; })(), content: 'x' })), o);
const invariants = (vs) => vs.map((v) => v.invariant).sort();

test('a summary sent as a recall pair, its question and its answer, covers its sources once', () => {
  const m = manager();
  const c = compiled(
    [{ participant: 'Context Manager', content: [{ type: 'text', text: 'What do you remember?' }] }, summary('L1-0')],
    [{ participant: 'Junga', content: [{ type: 'text', text: 'a summary' }] }, summary('L1-0')],
    [sent(m.messages[2]), raw(3)],
    [sent(m.messages[3]), raw(4)],
  );
  // Message 3's result answers a call inside the summary, so shape flags it; coverage, counted once, doesn't.
  assert.deepEqual(invariants(check(m, c)), ['shape']);
});

test('a body sent raw beside a summary of it breaks beside-sources', () => {
  const m = manager();
  const beside = compiled([sent(m.messages[0]), raw(1)], [{ participant: 'Junga', content: [{ type: 'text', text: 'a summary' }] }, summary('L1-0')], [sent(m.messages[2]), raw(3)], [sent(m.messages[3]), raw(4)]);
  assert.ok(invariants(check(m, beside)).includes('beside-sources'));
});

test('a stored body sent in no message breaks coverage where the configuration compresses, and only there', () => {
  const m = manager();
  const c = compiled([sent(m.messages[2]), raw(3)], [sent(m.messages[3]), raw(4)]);
  assert.ok(check(m, c, { compresses: true }).some((v) => v.invariant === 'coverage' && /2 stored bodies in no message sent: 1, 2/.test(v.detail)));
  assert.ok(!check(m, c, { compresses: false }).some((v) => v.invariant === 'coverage'));
});

test('a tool result whose call isn\'t in the message before it breaks shape', () => {
  const m = manager();
  const c = compiled([sent(m.messages[2]), raw(3)], [sent(m.messages[3]), raw(4)]);
  assert.ok(check(m, c, { compresses: false }).some((v) => v.invariant === 'shape' && /result t1 answers no call/.test(v.detail)));
  const whole = compiled(...m.messages.map((x, i) => [sent(x), raw(i + 1)]));
  assert.deepEqual(check(m, whole), []);
});

// A store holding a body in three shards (2, 3, 4) between two short messages, and summaries over parts of it.
function shardedManager() {
  const shard = (n, letter) => ({ id: String(n), sequence: n, participant: 'User', bodyGroupId: 'g', shardIndex: n - 2, content: [{ type: 'text', text: `${letter.repeat(40)} ` }] });
  const messages = [
    { id: '1', sequence: 1, participant: 'Junga', content: [{ type: 'text', text: 'paste it' }] },
    shard(2, 'A'), shard(3, 'B'), shard(4, 'C'),
    { id: '5', sequence: 5, participant: 'Junga', content: [{ type: 'text', text: 'read it' }] },
  ];
  const summary = (id, sourceIds) => ({ id, level: 1, sourceLevel: 0, sourceIds, content: `summary ${id}`, tokens: 5 });
  const summaries = { 'L1-A': summary('L1-A', ['2']), 'L1-B': summary('L1-B', ['3', '4']), 'L1-X': summary('L1-X', ['3']) };
  return { ...manager(), getAllMessages: () => messages, getSummary: (id) => summaries[id] ?? null, messages };
}
const withSources = (c, sources) => checkCompile(shardedManager(), budget, c, sources.map((s) => ({ sources: s, content: 'x' })), { compresses: true });
const said = (text) => ({ participant: 'User', content: [{ type: 'text', text }] });
const recalled = (id) => ({ participant: 'Junga', content: [{ type: 'text', text: `summary ${id}` }] });

test('a body whose shards are under two summaries, each over its own shards, breaks no coverage, and a shard under two does', () => {
  const m = shardedManager();
  const parted = { messages: [m.messages[0], recalled('L1-A'), recalled('L1-B'), m.messages[4]] };
  assert.deepEqual(withSources(parted, [['r:1'], ['s:L1-A@1'], ['s:L1-B@1'], ['r:5']]), []);
  const twice = { messages: [m.messages[0], recalled('L1-X'), recalled('L1-B'), m.messages[4]] };
  const v = withSources(twice, [['r:1'], ['s:L1-X@1'], ['s:L1-B@1'], ['r:5']]);
  assert.ok(v.some((x) => x.invariant === 'coverage' && /1 stored messages under two summaries sent: 3 in L1-X, L1-B/.test(x.detail)), JSON.stringify(v));
});

test("a body partly raw beside a summary of its other shards breaks nothing, and a shard both raw and summarised breaks beside-sources", () => {
  const m = shardedManager();
  const partly = { messages: [m.messages[0], said(m.messages[1].content[0].text), recalled('L1-B'), m.messages[4]] };
  assert.deepEqual(withSources(partly, [['r:1'], ['r:2!shards'], ['s:L1-B@1'], ['r:5']]), []);
  const both = { messages: [m.messages[0], said(m.messages[1].content[0].text + m.messages[2].content[0].text), recalled('L1-B'), m.messages[4]] };
  const v = withSources(both, [['r:1'], ['r:2!shards'], ['s:L1-B@1'], ['r:5']]);
  assert.ok(v.some((x) => x.invariant === 'beside-sources' && /3 raw beside L1-B/.test(x.detail)), JSON.stringify(v));
  const whole = { messages: [m.messages[0], said('AAA'), recalled('L1-B'), m.messages[4]] };
  assert.ok(withSources(whole, [['r:1'], ['r:2'], ['s:L1-B@1'], ['r:5']]).some((x) => x.invariant === 'beside-sources'), 'a whole raw copy holds every shard');
});

test("a call or result the store holds unpaired, sent as stored, breaks no shape", () => {
  const messages = [
    { id: '1', sequence: 1, participant: 'User', content: [{ type: 'text', text: 'go' }] },
    { id: '2', sequence: 2, participant: 'Junga', content: [{ type: 'tool_use', id: 'lost', name: 'read_file', input: {} }] },
    { id: '3', sequence: 3, participant: 'User', content: [{ type: 'text', text: 'and?' }] },
    { id: '4', sequence: 4, participant: 'User', content: [{ type: 'tool_result', toolUseId: 'ghost', content: 'late' }] },
    { id: '5', sequence: 5, participant: 'Junga', content: [{ type: 'text', text: 'done' }] },
  ];
  const m = { ...manager(), getAllMessages: () => messages, getSummary: () => null };
  const c = { messages: messages.map(sent), provenance: { messages: messages.map((x) => raw(Number(x.id))) } };
  assert.deepEqual(check(m, c, { compresses: false }), []);
});

test('a message carrying a body\'s thinking without that body\'s calls breaks thinking', () => {
  const m = manager();
  const parted = compiled([sent(m.messages[0]), raw(1)], [{ participant: 'Junga', content: [m.messages[1].content[0]] }, raw(2)], [sent(m.messages[2]), raw(3)], [sent(m.messages[3]), raw(4)]);
  assert.ok(check(m, parted).some((v) => v.invariant === 'thinking' && /without its calls t1/.test(v.detail)));
});

test('a summary sent over a pinned range breaks the pin unless the pin allows its level', () => {
  const c = (mgr) => compiled([{ participant: 'Junga', content: [{ type: 'text', text: 'a summary' }] }, summary('L1-0')], [sent(mgr.messages[2]), raw(3)], [sent(mgr.messages[3]), raw(4)]);
  const pinned = manager({ pins: [{ id: 'p1', firstMessageId: '2', lastMessageId: '2', kind: 'pin' }] });
  assert.ok(check(pinned, c(pinned)).some((v) => v.invariant === 'pins' && /inside pin p1 allowing L0/.test(v.detail)));
  const allowsL1 = manager({ pins: [{ id: 'p1', firstMessageId: '2', lastMessageId: '2', kind: 'pin', maxLevel: 1 }] });
  assert.ok(!check(allowsL1, c(allowsL1)).some((v) => v.invariant === 'pins'));
});

test('a request past its input budget breaks budget only past the strategy\'s grace, and not where it doesn\'t enforce one', () => {
  const whole = (mgr) => compiled(...mgr.messages.map((x, i) => [sent(x), raw(i + 1)]));
  const at = (tokens, config) => invariants(check(manager({ tokens, config }), whole(manager())));
  assert.deepEqual(at(918, {}), []); // 900 and its default 0.02 grace
  assert.deepEqual(at(919, {}), ['budget']);
  assert.deepEqual(at(901, { overBudgetGraceRatio: 0 }), ['budget']);
  assert.deepEqual(at(5000, { enforceBudget: false }), []);
});

test('the recorder writes a trace that reads back, counts the step\'s log lines by tag, and gives console back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmfx-test-'));
  const warn = console.warn;
  try {
    const file = join(dir, 't.jsonl');
    const header = { run: 'C3/W1', config: 'C3', workload: 'W1', variant: null, arm: 'base', seed: 1, scale: 15, from: null, library: { commit: 'c', version: 'v' }, membrane: { version: 'm' }, fixture: { version: 'f' } };
    const rec = await openRecorder({ file, header });
    const m = manager();
    rec.step(1);
    m.messages.forEach((x) => rec.added(x.participant, x.content, x.id));
    console.warn('[compression-quarantine] one ns=agents/junga');
    console.warn('[compression-quarantine] two');
    rec.compiled(m, budget, compiled(...m.messages.map((x, i) => [sent(x), raw(i + 1)])));
    await rec.endStep(m);
    await rec.checkpoint(m, 'end');
    await rec.end(null);
    assert.equal(console.warn, warn);
    const t = readTrace(readFileSync(file, 'utf8'));
    assert.equal(t.header.schema, SCHEMA);
    const step = t.events.find((e) => e.kind === 'step');
    assert.deepEqual(step.logs, { 'compression-quarantine': 2 });
    const c = t.events.find((e) => e.kind === 'compile');
    assert.deepEqual(c.messages.map((x) => x.sources[0]), ['r:a1.0', 'r:a1.1', 'r:a1.2', 'r:a1.3']);
    assert.deepEqual(c.violations, []);
    assert.deepEqual(step.written.map((s) => [s.id, s.sources]), [['L1-0', ['a1.0', 'a1.1']]]);
    const cp = t.events.find((e) => e.kind === 'checkpoint');
    assert.deepEqual(cp.branches, [{ id: '1', name: 'main', head: 9 }]);
  } finally {
    console.warn = warn;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a message is named by its add, so a store that numbers it differently records the same sources', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmfx-test-'));
  try {
    const sourcesAt = async (idBase) => {
      const file = join(dir, `t${idBase}.jsonl`);
      const rec = await openRecorder({ file, header: { run: 'C3/W1', config: 'C3', workload: 'W1', variant: null, arm: 'base', seed: 1, scale: 15, from: null, library: { commit: 'c', version: 'v' }, membrane: { version: 'm' }, fixture: { version: 'f' } } });
      const m = manager({ idBase });
      rec.step(1);
      m.messages.forEach((x) => rec.added(x.participant, x.content, x.id));
      rec.compiled(m, budget, compiled(...m.messages.map((x) => [sent(x), raw(x.id)])));
      await rec.endStep(m);
      await rec.end(null);
      return readTrace(readFileSync(file, 'utf8')).events.find((e) => e.kind === 'compile').messages.map((x) => x.sources[0]);
    };
    assert.deepEqual(await sourcesAt(0), await sourcesAt(100));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
