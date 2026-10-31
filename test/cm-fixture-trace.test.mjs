// The characterization fixture's recorder (lib/cm-fixture/trace.mjs): the invariants it checks on each compiled
// request, and the trace it writes. A stand-in manager answers the public reads the recorder makes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCompile, openRecorder } from '../lib/cm-fixture/trace.mjs';
import { digest, readTrace, SCHEMA } from '../lib/cm-fixture/events.mjs';

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

test("a partial raw copy of a body starts where the shards it carries start, for store order", () => {
  const m = shardedManager();
  const [A, , C] = [1, 2, 3].map((k) => m.messages[k].content[0].text);
  const later = { messages: [m.messages[0], recalled('L1-X'), said(C), m.messages[4]] };
  const order = (vs) => vs.filter((v) => /covers from sequence/.test(v.detail)).map((v) => v.detail);
  assert.deepEqual(order(withSources(later, [['r:1'], ['s:L1-X@1'], ['r:2!shards'], ['r:5']])), [], 'the copy carries shard 4, after the summary of shard 3');
  const earlier = { messages: [m.messages[0], recalled('L1-X'), said(A), m.messages[4]] };
  assert.deepEqual(order(withSources(earlier, [['r:1'], ['s:L1-X@1'], ['r:2!shards'], ['r:5']])), ['message 2 covers from sequence 2, before message 1\'s 3']);
});

test('after a head-window reset, a request that opens with the head and then the history from before it keeps store order', () => {
  const store = (participant) => [
    { id: '1', sequence: 1, participant: 'User', content: [{ type: 'text', text: 'one' }] },
    { id: '2', sequence: 2, participant: 'Junga', content: [{ type: 'text', text: 'two' }] },
    { id: '3', sequence: 3, participant: 'User', content: [{ type: 'text', text: 'three' }] },
    { id: '4', sequence: 4, participant, content: [{ type: 'text', text: '[Topic Transition] A new topic.' }] },
    { id: '5', sequence: 5, participant: 'User', content: [{ type: 'text', text: 'five' }] },
  ];
  const summaries = { 'L1-0': { id: 'L1-0', level: 1, sourceLevel: 0, sourceIds: ['1', '2'], content: 'a summary', tokens: 5 } };
  const order = (participant, sources) => {
    const messages = store(participant);
    const m = { ...manager(), getAllMessages: () => messages, getSummary: (id) => summaries[id] ?? null };
    const c = { messages: sources.map(() => ({ participant: 'User', content: [{ type: 'text', text: 'x' }] })), provenance: { messages: [] } };
    return checkCompile(m, budget, c, sources.map((x) => ({ sources: x, content: 'x' })), { compresses: true }).filter((v) => /covers from sequence/.test(v.detail)).map((v) => v.detail);
  };
  assert.deepEqual(order('Context Manager', [['r:4'], ['s:L1-0@1'], ['r:3'], ['r:5']]), [], 'the head, then the history, then what follows the head');
  assert.deepEqual(order('User', [['r:4'], ['s:L1-0@1'], ['r:3'], ['r:5']]), ["message 1 covers from sequence 1, before message 0's 4", "message 2 covers from sequence 3, before message 0's 4"], 'with no transition there is no head to go first');
  assert.deepEqual(order('Context Manager', [['r:5'], ['s:L1-0@1'], ['r:3'], ['r:4']]), ["message 1 covers from sequence 1, before message 0's 5", "message 2 covers from sequence 3, before message 0's 5", "message 3 covers from sequence 4, before message 0's 5"], 'a request may open early only with the head itself');
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

// A store of eight messages: a call answered at once, and a call whose result the store holds two messages later.
function pairsManager() {
  const messages = [
    { id: '1', sequence: 1, participant: 'User', content: [{ type: 'text', text: 'go' }] },
    { id: '2', sequence: 2, participant: 'Junga', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
    { id: '3', sequence: 3, participant: 'User', content: [{ type: 'tool_result', toolUseId: 't1', content: 'file' }] },
    { id: '4', sequence: 4, participant: 'User', content: [{ type: 'text', text: 'meanwhile' }] },
    { id: '5', sequence: 5, participant: 'Junga', content: [{ type: 'tool_use', id: 't2', name: 'read_file', input: {} }] },
    { id: '6', sequence: 6, participant: 'User', content: [{ type: 'text', text: 'wait' }] },
    { id: '7', sequence: 7, participant: 'User', content: [{ type: 'tool_result', toolUseId: 't2', content: 'late' }] },
    { id: '8', sequence: 8, participant: 'Junga', content: [{ type: 'text', text: 'done' }] },
  ];
  return { ...manager(), getAllMessages: () => messages, getSummary: () => null, messages };
}
const request = (m, ids) => ({ messages: ids.map((n) => sent(m.messages[n - 1])), provenance: { messages: ids.map((n) => raw(n)) } });
const shapes = (vs) => vs.filter((v) => v.invariant === 'shape').map((v) => v.detail);

test('a passthrough request breaks shape where it opens with a result, and nowhere it sends the store as stored', () => {
  const m = pairsManager();
  assert.deepEqual(shapes(check(m, request(m, [3, 4, 5, 6, 7, 8]), { compresses: false })), ['message 0: result t1 answers no call in the message before it']);
  assert.deepEqual(shapes(check(m, request(m, [6, 7, 8]), { compresses: false })), [], "a late result whose call lies before the request's start goes out as stored");
  assert.deepEqual(shapes(check(m, request(m, [6, 7, 8]), { compresses: true })), ['message 1: result t2 answers no call in the message before it'], 'where the configuration compresses, it parts a pair the store holds');
});

test('a passthrough request may open with a message holding a call and its own result, or with a result whose call the store never held', () => {
  const messages = [
    { id: '1', sequence: 1, participant: 'User', content: [{ type: 'text', text: 'go' }] },
    { id: '2', sequence: 2, participant: 'Junga', content: [{ type: 'tool_use', id: 'b1', name: 'read_file', input: {} }, { type: 'tool_result', toolUseId: 'b1', content: 'file' }] },
    { id: '3', sequence: 3, participant: 'User', content: [{ type: 'tool_result', toolUseId: 'ghost', content: 'late' }] },
    { id: '4', sequence: 4, participant: 'Junga', content: [{ type: 'text', text: 'done' }] },
  ];
  const m = { ...manager(), getAllMessages: () => messages, getSummary: () => null, messages };
  assert.deepEqual(shapes(check(m, request(m, [2, 3, 4]), { compresses: false })), [], 'the bundled message opens it whole');
  assert.deepEqual(shapes(check(m, request(m, [3, 4]), { compresses: false })), [], 'the ghost goes out as stored');
  assert.deepEqual(shapes(check(m, request(m, [1, 2, 3, 4]), { compresses: true })), [], 'a call answered in its own message is answered, under any configuration');
});

test("a passthrough request that leaves out a message of a pair inside its own span breaks shape", () => {
  const m = pairsManager();
  assert.deepEqual(shapes(check(m, request(m, [1, 2, 4, 5, 6, 7, 8]), { compresses: false })), ['message 1: call t1 unanswered in the message after it']);
  assert.deepEqual(shapes(check(m, request(m, [1, 3, 4, 5, 6, 7, 8]), { compresses: false })), ['message 1: result t1 answers no call in the message before it']);
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
    // listBranches promises no order: the recorder lists them by id.
    const branches = [{ id: '10', name: 'fork', head: 12, created: 0 }, { id: '1', name: 'main', head: 9, created: 0 }, { id: '2', name: 'side', head: 4, created: 0 }];
    const m = { ...manager(), listBranches: () => branches };
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
    assert.deepEqual(cp.branches, [{ id: '1', name: 'main', head: 9 }, { id: '2', name: 'side', head: 4 }, { id: '10', name: 'fork', head: 12 }]);
  } finally {
    console.warn = warn;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a receipt records the chain's head with its leaves named as messages are, a failure after sending, and an unreadable reference as unreadable", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmfx-receipt-'));
  try {
    const file = join(dir, 't.jsonl');
    const header = { run: 'H1.claude-opus-4-6/W11', config: 'H1.claude-opus-4-6', workload: 'W11', variant: null, arm: 'base', seed: 1, scale: 15, from: null, library: { commit: 'c', version: 'v' }, membrane: { version: 'm' }, fixture: { version: 'f' } };
    const rec = await openRecorder({ file, header });
    const m = manager();
    rec.step(1);
    m.messages.forEach((x) => rec.added(x.participant, x.content, x.id));
    rec.compiled(m, budget, compiled(...m.messages.map((x, i) => [sent(x), raw(i + 1)])));
    const changes = [{ leafId: '2', value: { repHash: 'r2', level: 1, lastChangedSeq: 3 } }, { leafId: '4', value: null }];
    rec.receipt({ accepted: true, withReference: true, head: { sequence: 3, receiptHash: 'f'.repeat(64), changes } }, m);
    rec.compiled(m, budget, compiled(...m.messages.map((x, i) => [sent(x), raw(i + 1)])));
    rec.receipt({ accepted: false, failed: true, withReference: { unreadable: 'no kvUnifiedReceipts.cache' } }, m);
    await rec.endStep(m);
    rec.violation('workload', 'a check over the whole run, after its last step');
    await rec.end(null);
    const [first, second] = readTrace(readFileSync(file, 'utf8')).events.filter((e) => e.kind === 'compile');
    assert.deepEqual(first.receipt, { accepted: true, withReference: true, head: { sequence: 3, hash: 'f'.repeat(16), changes: 2, digest: digest([['a1.1', ['r2', 1, 3]], ['a1.3', null]]) } });
    assert.deepEqual(second.receipt, { accepted: false, failed: true, withReference: { unreadable: 'no kvUnifiedReceipts.cache' } });
    assert.deepEqual(readTrace(readFileSync(file, 'utf8')).end.violations, [{ invariant: 'workload', detail: 'a check over the whole run, after its last step' }], 'a check after the last step is written with the end');
  } finally {
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

// The long-run rules the recorder checks over a run (step 5), each on a small store a test builds.
function store({ count = 4, summaries = {}, strategy = { config: {} } } = {}) {
  const messages = Array.from({ length: count }, (_, i) => ({ id: String(i + 1), sequence: i + 1, participant: i % 2 ? 'Junga' : 'User', content: [{ type: 'text', text: `message ${i + 1}` }] }));
  return {
    ...manager(),
    getAllMessages: () => messages,
    getMessage: (m) => messages.find((x) => x.id === String(m)) ?? null,
    getSummary: (s) => summaries[s] ?? null,
    getSummariesInRange: () => Object.values(summaries).map((s) => ({ id: s.id, level: s.level, content: s.content, tokens: 5 })),
    getStrategy: () => strategy,
    getRenderStats: () => ({ total: { messages: count, tokens: 100 } }),
    messages,
  };
}
async function recorded(drive) {
  const dir = mkdtempSync(join(tmpdir(), 'cmfx-test-'));
  const saved = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((k) => [k, console[k]]));
  try {
    const file = join(dir, 't.jsonl');
    const header = { run: 'C3/W1', config: 'C3', workload: 'W1', variant: null, arm: 'base', seed: 1, scale: 15, from: null, library: { commit: 'c', version: 'v' }, membrane: { version: 'm' }, fixture: { version: 'f' } };
    const rec = await openRecorder({ file, header });
    await drive(rec);
    await rec.end(null);
    const t = readTrace(readFileSync(file, 'utf8'));
    return [...t.events.flatMap((e) => e.violations ?? []), ...(t.end.violations ?? [])];
  } finally {
    Object.assign(console, saved);
    rmSync(dir, { recursive: true, force: true });
  }
}
const named = (vs, invariant) => vs.filter((v) => v.invariant === invariant);
const summariserRequest = (text, model = 'claude-opus-4-6') => ({ model, messages: [{ role: 'user', content: [{ type: 'text', text }] }] });

test('a refused or cut-off answer\'s text in a summary breaks refused-text, and a summary without it does not', async () => {
  const refusal = 'I cannot help with summarising this part.';
  for (const [content, kind, breaks] of [[`Memory: ${refusal}`, 'refusal', 1], [`Memory: ${refusal}`, 'max-tokens', 1], ['Memory: what happened.', 'refusal', 0], [`Memory: ${refusal}`, 'text', 0]]) {
    const m = store({ summaries: { 'L1-0': { id: 'L1-0', level: 1, sourceLevel: 0, sourceIds: ['1', '2'], content } } });
    const vs = await recorded(async (rec) => {
      rec.step(1);
      rec.call({ request: summariserRequest('chunk'), target: 10, carried: [], answer: { kind, text: refusal } });
      await rec.endStep(m);
    });
    assert.equal(named(vs, 'refused-text').length, breaks, `${kind}, ${content}`);
  }
});

test('a request sent again after the same bytes were answered or rejected breaks requested-again, and after a throw does not', async () => {
  for (const [first, breaks] of [['text', 1], ['rejection', 1], ['throw', 0], ['refusal', 0]]) {
    const vs = await recorded(async (rec) => {
      rec.step(1);
      rec.call({ request: summariserRequest('chunk'), target: 10, carried: [], answer: first === 'text' ? { kind: 'text', text: 'a memory' } : { kind: first } });
      rec.call({ request: summariserRequest('chunk'), target: 10, carried: [], answer: { kind: 'text', text: 'a memory' } });
      rec.call({ request: summariserRequest('another chunk'), target: 10, carried: [], answer: { kind: 'text', text: 'a memory' } });
      await rec.endStep(store());
    });
    assert.equal(named(vs, 'requested-again').length, breaks, first);
  }
});

test('a summariser request naming another model than the run\'s first breaks model', async () => {
  for (const [second, breaks] of [['claude-opus-4-6', 0], ['claude-sonnet-4-5', 1]]) {
    const vs = await recorded(async (rec) => {
      rec.step(1);
      rec.call({ request: summariserRequest('one'), target: 10, carried: [], answer: { kind: 'text', text: 'a' } });
      rec.call({ request: summariserRequest('two', second), target: 10, carried: [], answer: { kind: 'text', text: 'b' } });
      await rec.endStep(store());
    });
    assert.equal(named(vs, 'model').length, breaks, second);
  }
});

test('a plan-vs-actual line marking a stop at the label ceiling breaks ceiling, and one without the mark does not', async () => {
  for (const [line, breaks] of [['[plan-vs-actual] moved=0 ceiling=live drift=0', 1], ['[plan-vs-actual] moved=0 drift=0', 0]]) {
    const vs = await recorded(async (rec) => {
      rec.step(1);
      console.log(line);
      await rec.endStep(store());
    });
    assert.equal(named(vs, 'ceiling').length, breaks, line);
  }
});

class WindowedPassthroughStrategy { constructor() { this.config = {}; } }
const shown = (m, i, marked = false) => [{ participant: m.messages[i].participant, content: m.messages[i].content, ...(marked ? { cacheBreakpoint: true } : {}) }, raw(i + 1)];

test('a windowed passthrough marks the last message and the last unchanged one, and only the last after a fresh start', async () => {
  const m = store({ strategy: new WindowedPassthroughStrategy() });
  const run = (second, between) => recorded(async (rec) => {
    rec.step(1);
    rec.compiled(m, budget, compiled(shown(m, 0), shown(m, 1, true)));
    if (between) rec.action(between, {});
    rec.compiled(m, budget, compiled(...second));
    await rec.endStep(m);
  });
  assert.equal(named(await run([shown(m, 0), shown(m, 1, true), shown(m, 2, true)]), 'marks').length, 0);
  assert.equal(named(await run([shown(m, 0), shown(m, 1), shown(m, 2, true)]), 'marks').length, 1);
  assert.equal(named(await run([shown(m, 0, true), shown(m, 1, true), shown(m, 2, true)]), 'marks').length, 1);
  assert.equal(named(await run([shown(m, 0), shown(m, 1), shown(m, 2, true)], 'switch'), 'marks').length, 0);
  assert.equal(named(await run([shown(m, 0), shown(m, 1, true), shown(m, 2, true)], 'switch'), 'marks').length, 1);
  // An edit rewrites the history but doesn't start the strategy over: it still marks against the compile before.
  assert.equal(named(await run([shown(m, 0), shown(m, 1, true), shown(m, 2, true)], 'edit'), 'marks').length, 0);
});

test('a windowed passthrough\'s compile extends the one before it, but for a re-anchor, a fresh start or an image stripped since', async () => {
  const m = store({ strategy: new WindowedPassthroughStrategy() });
  const imaged = [{ participant: 'User', content: [{ type: 'text', text: 'see' }, { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } }] }, raw(1)];
  const stripped = [{ participant: 'User', content: [{ type: 'text', text: 'see' }, { type: 'text', text: '[image not shown: this context keeps only some images]' }] }, raw(1)];
  const run = (first, second, { between = null, cause = null } = {}) => recorded(async (rec) => {
    rec.step(1);
    rec.compiled(m, budget, compiled(...first));
    if (between) rec.action(between, {});
    const c = compiled(...second);
    c.provenance.layout = cause ? { cause, memberIds: [] } : null;
    rec.compiled(m, budget, c);
    await rec.endStep(m);
  });
  assert.equal(named(await run([shown(m, 0), shown(m, 1)], [shown(m, 0), shown(m, 1), shown(m, 2)]), 'prefix').length, 0);
  assert.equal(named(await run([shown(m, 0), shown(m, 1)], [shown(m, 1), shown(m, 2)]), 'prefix').length, 1);
  assert.equal(named(await run([shown(m, 0), shown(m, 1)], [shown(m, 1), shown(m, 2)], { cause: 'window' }), 'prefix').length, 0);
  assert.equal(named(await run([shown(m, 0), shown(m, 1)], [shown(m, 1), shown(m, 2)], { between: 'edit' }), 'prefix').length, 0);
  assert.equal(named(await run([imaged, shown(m, 1)], [stripped, shown(m, 1), shown(m, 2)]), 'prefix').length, 0);
});

const flat = { config: { adaptiveResolution: true, foldingStrategy: 'flat-profile' } };
const folded = (sid, level) => [{ participant: 'Junga', content: [{ type: 'text', text: sid }] }, summary(sid, level)];

test('under flat profile an older message shown shallower than a younger one breaks depth, unless no summary above it covers it', async () => {
  const sums = {
    'L1-a': { id: 'L1-a', level: 1, sourceLevel: 0, sourceIds: ['1', '2'], content: 'a' },
    'L1-b': { id: 'L1-b', level: 1, sourceLevel: 0, sourceIds: ['3', '4'], content: 'b' },
  };
  const m = store({ summaries: sums, strategy: flat });
  const one = (c) => recorded(async (rec) => { rec.step(1); rec.compiled(m, budget, c); await rec.endStep(m); });
  // Messages 1 and 2 raw, older than L1-b: L1-a covers them, so they were folded past, not passed over.
  assert.equal(named(await one(compiled(shown(m, 0), shown(m, 1), folded('L1-b', 1))), 'depth').length, 1);
  // Older at least as deep: fine.
  assert.equal(named(await one(compiled(folded('L1-a', 1), shown(m, 2), shown(m, 3))), 'depth').length, 0);
  // With no summary over 1 and 2, they were passed over.
  const m2 = store({ summaries: { 'L1-b': sums['L1-b'] }, strategy: flat });
  assert.equal(named(await recorded(async (rec) => { rec.step(1); rec.compiled(m2, budget, compiled(shown(m2, 0), shown(m2, 1), folded('L1-b', 1))); await rec.endStep(m2); }), 'depth').length, 0);
});

test('under flat profile a stored message raised to a level a second time breaks raised, and raised once does not', async () => {
  const sums = { 'L1-a': { id: 'L1-a', level: 1, sourceLevel: 0, sourceIds: ['1', '2'], content: 'a' } };
  const m = store({ summaries: sums, strategy: flat });
  const rest = [shown(m, 2), shown(m, 3)];
  const run = (...layouts) => recorded(async (rec) => {
    rec.step(1);
    for (const l of layouts) rec.compiled(m, budget, compiled(...(l === 'raw' ? [shown(m, 0), shown(m, 1)] : [folded('L1-a', 1)]), ...rest));
    await rec.endStep(m);
  });
  assert.equal(named(await run('raw', 'L1', 'L1'), 'raised').length, 0);
  assert.equal(named(await run('raw', 'L1', 'raw', 'L1'), 'raised').length, 1);
});

test('under flat profile a body partly folded, its first shards under a summary and the rest raw, is no raise, held over compiles', async () => {
  // Message 1 is a body of two shards, 1 and 2; L1-a covers shard 1, and a partial raw copy (named by the first
  // shard) carries shard 2.
  const sums = { 'L1-a': { id: 'L1-a', level: 1, sourceLevel: 0, sourceIds: ['1'], content: 'a' } };
  const m = store({ summaries: sums, strategy: flat });
  m.messages[0].bodyGroupId = 'g'; m.messages[1].bodyGroupId = 'g';
  const partly = () => compiled(folded('L1-a', 1), [{ participant: 'User', content: m.messages[1].content }, { kind: 'raw', bodies: [{ messageId: '1', sequence: 1, complete: false }] }], shown(m, 2), shown(m, 3));
  const vs = await recorded(async (rec) => { rec.step(1); for (let i = 0; i < 3; i++) rec.compiled(m, budget, partly()); await rec.endStep(m); });
  assert.equal(named(vs, 'raised').length, 0);
  assert.equal(named(vs, 'depth').length, 0);
});
