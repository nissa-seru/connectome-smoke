import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgets, requestKinds, declaredProducts, everyTurnAnswers, wellFormed, windowsRaw, calibrationEdge, coverage, bookkeeping } from '../lib/strategies/checks.mjs';
import { continuation, products, configurations, prefix, extend, L3_PRODUCT } from '../lib/strategies/script.mjs';

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
  assert.deepEqual(missing.map((m) => m.segment), ['close-merge', 'parallel', 'thinking-call', 'debt']);
  assert.deepEqual(missing[0].missing, ['a merge request', 'an L3 merge request']);
});

test('check 2: close-merge declares an L3 merge, which a merge at L3 meets with the merge product', () => {
  const script = continuation();
  const wanted = products(configurations().default);
  const l1 = { id: 'r1', step: 'c.cm.1', kind: 'summariser', level: 1, answer: { shape: 'summary' } };
  const atLevel = (level) => ({ id: `m${level}`, step: 'c.cm.2', kind: 'summariser', level, answer: { shape: 'summary' } });
  const closeMerge = (records) => declaredProducts(records, script, wanted).find((m) => m.segment === 'close-merge')?.missing ?? [];
  assert.deepEqual(closeMerge([l1, atLevel(2)]), [L3_PRODUCT]);
  assert.deepEqual(closeMerge([l1, atLevel(3)]), []);
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

const carrying = (...canaries) => ({ type: 'text', chars: 10, canaries });
const summaryBlock = (...summaries) => ({ type: 'text', chars: 10, summaries });
const turnStep = (id, replies = 1) => ({ id, segment: 's', kind: 'channel', canaries: [`[[c:${id}.in]]`], replies: Array.from({ length: replies }, () => ({ text: 'x' })) });

test('check 6 flags a request that loses a raw message of the head the host reported, or lacks the two turns before it raw', () => {
  const script = [turnStep('a'), turnStep('b', 2), turnStep('c'), turnStep('d')];
  const stored = (...canaries) => ({ canaries });
  const store = { messages: [stored(), stored('[[c:p.1.in]]'), stored('[[c:p.1.r1]]'), stored('[[c:p.2.in]]'), stored('[[c:p.2.r1]]'), ...['a.in', 'a.r1', 'b.in', 'b.r1', 'b.r2', 'c.in', 'c.r1', 'd.in'].map((c) => stored(`[[c:${c}]]`))], summaries: [] };
  const log = [{ kind: 'checkpoint', name: 's', health: { data: { contextComposition: { fixture: { head: { messages: 3, tokens: 50 }, tail: { messages: 0, tokens: 0 } } } } } }];
  const head = msg('user', carrying('[[c:p.1.in]]', '[[c:p.1.r1]]'));
  const full = { id: 'ok', step: 'd', kind: 'agent', messages: [head, msg('assistant', summaryBlock('[[s:P1]]')), msg('user', carrying('[[c:b.in]]', '[[c:b.r1]]', '[[c:b.r2]]', '[[c:c.in]]', '[[c:c.r1]]', '[[c:d.in]]'))] };
  const noHead = { ...full, id: 'nohead', messages: [msg('user', carrying('[[c:p.1.in]]')), ...full.messages.slice(1)] };
  const noRecent = { ...full, id: 'norecent', messages: [head, msg('user', carrying('[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]', '[[c:c.r1]]'))] };
  const flags = windowsRaw([full, noHead, noRecent], script, log, store);
  assert.deepEqual(flags.map((f) => f.request), ['nohead', 'norecent'], 'p.2, past the reported head, may fold');
  assert.match(flags[0].message, /p\.1\.r1/);
  assert.match(flags[1].message, /b\.r2/);
  assert.deepEqual(windowsRaw([full], script, [], store).map((f) => f.message), ["no head size was reported at segment s's checkpoint"]);
  assert.deepEqual(windowsRaw([noHead], script, log, null), [], 'with no store read, only the recent window is checked');
});
test('check 6 asks a request for a head message only once it was stored, through the turn\'s own earlier replies', () => {
  const script = [turnStep('p.1', 2), turnStep('p.2')];
  const stored = (...canaries) => ({ canaries });
  const store = { messages: ['p.1.in', 'p.1.r1', 'p.1.r2', 'p.2.in', 'p.2.r1'].map((c) => stored(`[[c:${c}]]`)), summaries: [] };
  const log = [{ kind: 'checkpoint', name: 's', health: { data: { contextComposition: { fixture: { head: { messages: 5, tokens: 50 }, tail: { messages: 0, tokens: 0 } } } } } }];
  const first = { id: 'first', step: 'p.1', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]'))] };
  const second = { id: 'second', step: 'p.1', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]')), msg('assistant', carrying('[[c:p.1.r1]]'))] };
  const secondLost = { id: 'second-lost', step: 'p.1', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]'))] };
  assert.deepEqual(windowsRaw([first, second], script, log, store), [], 'neither asks for a reply that came after it');
  const flags = windowsRaw([first, secondLost], script, log, store);
  assert.deepEqual(flags.map((f) => [f.request, f.message]), [['second-lost', "the head window's [[c:p.1.r1]] isn't raw"]]);
});
test('check 10 flags a multiplier at either clamp edge, wherever the health panel puts it, and nothing inside them', () => {
  const at = (m) => ({ kind: 'checkpoint', step: 's', name: 'n', health: { contextComposition: { fixture: { calibration: { multiplier: m } } } } });
  const flags = calibrationEdge([at(1.3), at(0.6), at(1.8), at(1.79), { kind: 'settle' }]);
  assert.deepEqual(flags.map((f) => f.message.match(/\(([\d.]+)\)/)[1]), ['0.6', '1.8']);
});

const store = {
  messages: [
    { id: 'm1', canaries: ['[[c:a.in]]'] }, { id: 'm2', canaries: ['[[c:a.r1]]'] },
    { id: 'm3', canaries: ['[[c:b.in]]'] }, { id: 'm4', canaries: ['[[c:b.r1]]'] },
    { id: 'm5', canaries: ['[[c:c.in]]'] }, { id: 'm6', canaries: [] },
  ],
  summaries: [
    { id: 'L1-1', level: 1, sourceLevel: 0, sourceIds: ['m1', 'm2'], number: '[[s:C1]]', covers: ['[[c:a.in]]', '[[c:a.r1]]'] },
    { id: 'L1-2', level: 1, sourceLevel: 0, sourceIds: ['m3', 'm4', 'm6'], number: '[[s:C2]]', covers: ['[[c:b.in]]', '[[c:b.r1]]'] },
    { id: 'L2-1', level: 2, sourceLevel: 1, sourceIds: ['L1-1', 'L1-2'], number: '[[s:C3]]', covers: ['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]'] },
  ],
};

test('check 4: each message stored before a request reaches it raw or in a summary, once, and an unmapped summary is flagged', () => {
  const ok = { id: 'ok', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:b.in]]', '[[c:b.r1]]')), msg('user', carrying('[[c:c.in]]'))] };
  const merged = { id: 'merged', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const lost = { id: 'lost', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const twice = { id: 'twice', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:b.in]]', '[[c:c.in]]'))] };
  const unmapped = { id: 'unmapped', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]', '[[s:P9]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const flags = [ok, merged, lost, twice, unmapped].flatMap((r) => coverage([r], store));
  assert.deepEqual(flags.map((f) => f.request), ['lost', 'twice', 'unmapped']);
  assert.match(flags[0].message, /b\.in.*b\.r1/);
});

test('check 4: a step\'s later request also needs that step\'s earlier replies', () => {
  const first = { id: 'one', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const second = { id: 'two', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const flags = coverage([first, second], store);
  assert.deepEqual(flags.map((f) => f.request), ['two']);
  assert.match(flags[0].message, /c\.r1/);
});

test('check 5: a summary declares only what its request showed, a child by its number or by all it covers', () => {
  const shown = (number, canaries, summaries = []) => ({ id: number, step: 's', kind: 'summariser', answer: { summary: number }, sent: { canaries, summaries } });
  const flags = bookkeeping([
    shown('[[s:C1]]', ['[[c:a.in]]', '[[c:a.r1]]']),
    shown('[[s:C2]]', ['[[c:b.in]]']),
    shown('[[s:C3]]', ['[[c:a.in]]', '[[c:a.r1]]'], ['[[s:C2]]']),
  ], store);
  assert.deepEqual(flags.map((f) => f.request), ['[[s:C2]]']);
  const childUnseen = bookkeeping([shown('[[s:C3]]', ['[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]'])], store);
  assert.match(childUnseen[0].message, /L1-1/);
  // A level above shown its grandchildren's numbers, as an L3 merge is shown L1 memories.
  const l3store = { ...store, summaries: [...store.summaries, { id: 'L3-1', level: 3, sourceLevel: 2, sourceIds: ['L2-1'], number: '[[s:C4]]', covers: ['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]'] }] };
  assert.deepEqual(bookkeeping([shown('[[s:C4]]', [], ['[[s:C1]]', '[[s:C2]]'])], l3store), []);
  assert.equal(bookkeeping([shown('[[s:C4]]', [], ['[[s:C1]]'])], l3store).length, 1);
});

test('extending a prefix of one length to another gives the longer prefix\'s turns, the same in every call', () => {
  const whole = prefix(40);
  assert.deepEqual([whole[0], ...extend(0, 25), ...extend(25, 40), whole.at(-1)], whole);
  assert.deepEqual(extend(25, 40), extend(25, 40));
  assert.ok(!extend(25, 40).some((s) => s.id === 'p.name' || s.id === 'p.end'), 'no naming or end checkpoint');
});

test('K1: check 1 flags every operator alert the host raises, naming its kind and message', () => {
  const alert = (step, kind, message) => ({ kind: 'ipc', step, event: { type: 'ops:alert', kind, agentName: 'fixture', message } });
  const flags = everyTurnAnswers([], [
    alert('c.debt', 'compression-quarantine', '1 span(s) in compression quarantine'),
    alert('c.cm.2', 'context-maintenance-failed', 'the tick threw'),
    alert('c.par', 'mcpl-down', 'MCPL server unreachable'),
    { kind: 'ipc', step: 'c.par', event: { type: 'inference:speech' } },
  ]);
  assert.deepEqual(flags.map((f) => [f.check, f.step]), [[1, 'c.debt'], [1, 'c.cm.2'], [1, 'c.par']]);
  assert.match(flags[0].message, /compression-quarantine.*1 span\(s\) in compression quarantine/);
  assert.match(flags[1].message, /context-maintenance-failed.*the tick threw/);
  assert.deepEqual(flags.map((f) => f.what), ['compression-quarantine', 'context-maintenance-failed', 'mcpl-down'], 'K1b: each carries its kind');
});

// A checkpoint's health panel as connectome-host 0.15.0 reports the last live compile.
const panel = (name, { budget = 20_000, budgetMet = true, exhausted = false, head, tail } = {}) => ({
  kind: 'checkpoint', name, step: `${name}.cp`,
  health: { data: {
    contextComposition: { fixture: { planVsActual: { planned: 15_000, actual: 15_000, budgetMet, exhausted }, ...(head !== undefined ? { head: { messages: head } } : {}), ...(tail !== undefined ? { tail: { messages: tail } } : {}) } },
    runtimeSettings: { fixture: budget === null ? {} : { contextBudgetTokens: budget, effectiveContextBudgetTokens: budget } },
  } },
});

// An agent request as the stand-in records it (T16, T18): its messages, each with its digest, their
// tokens, its max tokens, the usage it answered with, and the tool_use ids its answer minted.
// `opened` opens a turn, or restarts one with messages context-manager rendered afresh;
// `continued` carries the request before it whole, then the round that request's answer opened.
const asked = (id, step, messageTokens, input, messages, toolUseIds) => ({ id, step, kind: 'agent', messageTokens, maxTokens: 2_048, usage: { input_tokens: 100, cache_read_input_tokens: input - 100, cache_creation_input_tokens: 0 }, messages, answer: { shape: 'reply', stop: toolUseIds.length ? 'tool_use' : 'end_turn', toolUseIds } });
const opened = (id, step, messageTokens, input = messageTokens + 8_000, calls = []) => asked(id, step, messageTokens, input, [{ role: 'user', digest: `in.${id}`, blocks: [text()] }], calls);
const continued = (before, id, messageTokens, input = messageTokens + 8_000, calls = []) => asked(id, before.step, messageTokens, input, [
  ...before.messages,
  { role: 'assistant', digest: `reply.${before.id}`, blocks: [text(), ...before.answer.toolUseIds.map(call)] },
  { role: 'user', digest: `results.${before.id}`, blocks: before.answer.toolUseIds.map((id) => result(id)) },
], calls);
// A run's log as the driver writes it: the host's stream events and the stand-in's arrivals.
const started = { kind: 'ipc', event: { type: 'inference:started', agentName: 'fixture' } };
const resumed = { kind: 'ipc', event: { type: 'inference:stream_resumed', agentName: 'fixture' } };
const sent = (id) => ({ kind: 'request', request: { id, kind: 'agent' } });
// The driver's log of connectome-host's `/budget` after a boot (D12): its header, then the agent's line.
const budgetReport = (...lines) => ({ kind: 'budget-report', boot: 1, lines: ['--- Stream Token Budgets ---', ...lines], ms: 5 });
const WINDOW_CLAUSE = '; its stream doesn\'t break at this budget mid-turn: for its size, only before a request its 1.0M window can\'t hold';
// A turn of three rounds under a stream bound of 30,000: r2's input passes it, so r3 follows a round over it.
const crossing = () => {
  const r1 = opened('r1', 'a', 15_000, 29_000, ['t1']);
  const r2 = continued(r1, 'r2', 16_000, 31_000, ['t2']);
  return [r1, r2, continued(r2, 'r3', 17_000, 32_000)];
};
const under = (report) => [...(report ? [report] : []), sent('r1'), sent('r2'), sent('r3'), panel('s')];

test('K2c: a step\'s first request is compiled, and a later one is a continuation only when it carries the request before it whole, then that request\'s own tool round', () => {
  const a1 = opened('a1', 'a', 1_000, undefined, ['t1']);
  const a2 = continued(a1, 'a2', 1_100, undefined, ['t2', 't3']);
  const a3 = continued(a2, 'a3', 1_200);
  // A restart: context-manager renders afresh, so the messages before the round differ.
  const b1 = opened('b1', 'b', 1_000, undefined, ['u1']);
  const b2 = continued(b1, 'b2', 1_100);
  b2.messages[0] = { ...b2.messages[0], digest: 'rendered afresh' };
  // The assistant's message carries ids the stand-in didn't answer the request before with.
  const c1 = opened('c1', 'c', 1_000, undefined, ['v1']);
  const c2 = continued(c1, 'c2', 1_100);
  c2.messages[1] = { ...c2.messages[1], blocks: [text(), call('v9')] };
  // Something other than the user's follows the round.
  const d1 = opened('d1', 'd', 1_000, undefined, ['w1']);
  const d2 = continued(d1, 'd2', 1_100);
  d2.messages.push({ role: 'assistant', digest: 'more', blocks: [text()] }, { role: 'user', digest: 'again', blocks: [text()] });
  // An answer with no tool call, and a refusal, open no round to continue.
  const e1 = opened('e1', 'e', 1_000);
  const e2 = continued(e1, 'e2', 1_100);
  const f1 = { ...opened('f1', 'f', 1_000), answer: { shape: 'refused' } };
  const f2 = continued({ ...f1, answer: { toolUseIds: ['z1'] } }, 'f2', 1_100);
  // A step's first request, though it arrives just after step a's a2 and carries a2 and its round.
  const g1 = { ...continued(a2, 'g1', 1_300), step: 'g' };
  const kinds = requestKinds([a1, a2, g1, a3, b1, b2, c1, c2, d1, d2, e1, e2, f1, f2]);
  assert.deepEqual(Object.fromEntries(kinds), {
    a1: 'compiled', a2: 'continuation', a3: 'continuation',
    b1: 'compiled', b2: 'compiled', c1: 'compiled', c2: 'compiled', d1: 'compiled', d2: 'compiled',
    e1: 'compiled', e2: 'compiled', f1: 'compiled', f2: 'compiled', g1: 'compiled',
  });
  // A record without digests, its own or the request before it's, can't be classified.
  const bare = (r) => ({ ...r, messages: r.messages.map(({ digest, ...m }) => m) });
  const h1 = opened('h1', 'h', 1_000, undefined, ['x1']);
  const h2 = continued(h1, 'h2', 1_100);
  assert.deepEqual(Object.fromEntries(requestKinds([bare(h1), h2])), { h1: null, h2: null });
  assert.deepEqual(Object.fromEntries(requestKinds([h1, bare(h2)])), { h1: 'compiled', h2: null });
});

test('K2c: the same records give the same kinds and verdicts whether each stream event is logged before its request, after it, or not at all', () => {
  const script = [turnStep('a')];
  // r2 and r3 are over what a compile could plan to (17,952) and under the stream bound: only as
  // continuations do they pass.
  const r1 = opened('r1', 'a', 15_000, 23_000, ['t1']);
  const r2 = continued(r1, 'r2', 19_000, 25_000, ['t2']);
  const r3 = continued(r2, 'r3', 20_000, 26_000);
  const records = [r1, r2, r3];
  const first = [started, sent('r1'), resumed, sent('r2'), resumed, sent('r3'), panel('s')];
  const late = [sent('r1'), started, sent('r2'), resumed, sent('r3'), resumed, panel('s')];
  const none = [sent('r1'), sent('r2'), sent('r3'), panel('s')];
  const [a, b, c] = [first, late, none].map((log) => budgets(records, script, log));
  assert.deepEqual(a.flags, []);
  assert.deepEqual(b, a, 'each event after its request');
  assert.deepEqual(c, a, 'no stream event at all');
  assert.deepEqual(a.headroom.map((h) => [h.kind, h.request]), [['compiled', 'r1'], ['continuation', 'r3']]);
});

test('K2d: a continuation under a report that the window governs the agent\'s stream, at the stand-in\'s window, isn\'t held to the stream bound, and a note says so', () => {
  const { flags, headroom, notes } = budgets(crossing(), [turnStep('a')], under(budgetReport(`  fixture: 30.0k (last: 0, 0%)${WINDOW_CLAUSE}`)), { streamBound: 30_000, windowTokens: 1_000_000 });
  assert.deepEqual(flags, []);
  assert.deepEqual(headroom.map((h) => h.kind), ['compiled'], 'no continuation headroom against a bound that doesn\'t govern it');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /window/);
});

test('K2d: under a report that the window governs, a window other than the stand-in\'s makes every continuation couldn\'t-judge, smaller or larger', () => {
  for (const [printed, standin] of [['500.0k', 1_000_000], ['2.0M', 1_000_000], ['1.0M', 200_000]]) {
    const clause = WINDOW_CLAUSE.replace('1.0M', printed);
    const { flags, notes } = budgets(crossing(), [turnStep('a')], under(budgetReport(`  fixture: 30.0k (last: 0, 0%)${clause}`)), { streamBound: 30_000, windowTokens: standin });
    assert.deepEqual(flags.map((f) => f.request), ['r2', 'r3'], `${printed} against ${standin}`);
    for (const f of flags) assert.match(f.message, new RegExp(`couldn't judge.*${printed.replace('.', '\\.')}.*${standin}`));
    assert.deepEqual(notes, []);
  }
  const unnamed = budgets(crossing(), [turnStep('a')], under(budgetReport('  fixture: 30.0k (last: 0, 0%); its stream doesn\'t break at this budget mid-turn')), { streamBound: 30_000, windowTokens: 1_000_000 }).flags;
  assert.deepEqual(unnamed.map((f) => f.request), ['r2', 'r3'], 'a clause that names no window');
});

test('K2d: a continuation under a report without that clause is held to the stream bound', () => {
  const { flags, notes } = budgets(crossing(), [turnStep('a')], under(budgetReport('  fixture: 30.0k (last: 0, 0%)')), { streamBound: 30_000 });
  assert.deepEqual(flags.map((f) => f.request), ['r3']);
  assert.match(flags[0].message, /31000.*30000/);
  assert.deepEqual(notes, []);
});

test('K2d: with no report for the agent, only a continuation after a round over the stream bound is couldn\'t-judge', () => {
  // None at all, the header alone, and a line for another agent only.
  for (const log of [under(null), under(budgetReport()), under(budgetReport('  other: 30.0k (last: 0, 0%)'))]) {
    const { flags } = budgets(crossing(), [turnStep('a')], log, { streamBound: 30_000 });
    assert.deepEqual(flags.map((f) => f.request), ['r3'], JSON.stringify(log.map((e) => e.kind)));
    assert.match(flags[0].message, /couldn't judge/);
  }
  // A report logged after the request doesn't govern it.
  const late = budgets(crossing(), [turnStep('a')], [sent('r1'), sent('r2'), sent('r3'), budgetReport(`  fixture: 30.0k (last: 0, 0%)${WINDOW_CLAUSE}`), panel('s')], { streamBound: 30_000 }).flags;
  assert.deepEqual(late.map((f) => f.request), ['r3']);
  assert.match(late[0].message, /couldn't judge/);
});

test('K2d: a report whose figure isn\'t the stream bound as the host formats it makes every continuation under it couldn\'t-judge', () => {
  const { flags, headroom } = budgets(crossing(), [turnStep('a')], under(budgetReport('  fixture: 150.0k (last: 0, 0%)')), { streamBound: 30_000 });
  assert.deepEqual(flags.map((f) => f.request), ['r2', 'r3'], 'r2 follows a round under the bound and is still couldn\'t-judge');
  for (const f of flags) assert.match(f.message, /couldn't judge.*150\.0k.*30000.*30\.0k/);
  assert.deepEqual(headroom.map((h) => h.kind), ['compiled']);
  assert.deepEqual(budgets(crossing(), [turnStep('a')], under(budgetReport('  fixture: 1.0M (last: 0, 0%)')), { streamBound: 1_000_000 }).flags, [], 'a million, as the host writes it');
  assert.deepEqual(budgets(crossing(), [turnStep('a')], under(budgetReport('  fixture: 150.0k (last: 0, 0%)'))).flags, [], 'the default bound, as the host writes it');
});

test('K2b: a compiled request is held to the budget less its own max tokens, every one of them, and context-manager\'s verdict flags the segment\'s last compile', () => {
  const script = [turnStep('a'), { ...turnStep('b'), segment: 't' }];
  // 20,000 less 2,048 is 17,952: r1 fits, r2 (a restart's compile) is under the setting but over
  // what its compile could plan to.
  const records = [opened('r1', 'a', 17_952), opened('r2', 'a', 18_000), opened('r3', 'b', 10_000)];
  const log = [panel('s'), panel('t', { budgetMet: false })];
  const { flags, headroom } = budgets(records, script, log);
  assert.deepEqual(flags.map((f) => [f.check, f.step, f.request]), [[3, 'a', 'r2'], [3, 'b', 'r3']]);
  assert.match(flags[0].message, /18000.*17952/);
  assert.match(flags[1].message, /didn't meet the budget/);
  assert.deepEqual(headroom.map((h) => [h.segment, h.kind, h.request, h.tokens, h.bound]), [['s', 'compiled', 'r2', 18_000, 17_952], ['t', 'compiled', 'r3', 10_000, 17_952]], 'the least headroom of each segment');
});

test('K2b: a continuation round is held to the stream bound, flagged only when the round before it was already over it', () => {
  const script = [turnStep('a')];
  // The stream bound 30,000 for the test; agent-framework restarts once a round's input passes it.
  const r1 = opened('r1', 'a', 15_000, 29_000, ['t1']);
  const r2 = continued(r1, 'r2', 22_000, 31_000, ['t2']);
  const records = [r1, r2, continued(r2, 'r3', 23_000, 32_000)];
  const log = [budgetReport('  fixture: 30.0k (last: 0, 0%)'), sent('r1'), sent('r2'), sent('r3'), panel('s')];
  const { flags, headroom } = budgets(records, script, log, { streamBound: 30_000 });
  assert.deepEqual(flags.map((f) => f.request), ['r3'], 'r2 may cross the bound, since r1 was under it; r3 follows a round over it');
  assert.match(flags[0].message, /31000.*30000/);
  assert.deepEqual(headroom.filter((h) => h.kind === 'continuation').map((h) => [h.request, h.tokens, h.bound]), [['r3', 32_000, 30_000]]);
  assert.equal(budgets(records, script, [panel('s')]).flags.length, 0, 'under agent-framework 0.28.0\'s default bound, 150,000, none is over');
  const verdict = budgets(records, script, [panel('s', { budgetMet: false })]).flags;
  assert.deepEqual(verdict.map((f) => f.request), ['r1'], 'context-manager\'s verdict is on the compile, not the turn\'s last round');
});

test('K2b: a request its records don\'t classify, a budget that changed since the last checkpoint, and a panel without the agent each say the check couldn\'t judge', () => {
  const script = [turnStep('a'), { ...turnStep('b'), segment: 't' }];
  const undigested = { ...opened('r1', 'a', 1_000), messages: [{ role: 'user', blocks: [text()] }] };
  const unclassified = budgets([undigested], [turnStep('a')], [panel('s')]).flags;
  assert.deepEqual(unclassified.map((f) => f.request), ['r1']);
  assert.match(unclassified[0].message, /couldn't judge/);
  const moved = budgets([opened('r1', 'a', 1_000), opened('r2', 'b', 1_000)], script, [panel('s'), panel('t', { budget: 30_000 })]).flags;
  assert.deepEqual(moved.map((f) => f.step), ['b']);
  assert.match(moved[0].message, /couldn't judge.*20000.*30000/);
  const other = { ...panel('s'), health: { data: { contextComposition: { other: {}, fixture: panel('s').health.data.contextComposition.fixture }, runtimeSettings: { other: { effectiveContextBudgetTokens: 1_000 }, fixture: { effectiveContextBudgetTokens: 20_000 } } } } };
  assert.deepEqual(budgets([opened('r1', 'a', 5_000)], [turnStep('a')], [other]).flags, [], 'the panel is read for the run\'s agent, not its first entry');
  assert.ok(budgets([opened('r1', 'a', 5_000)], [turnStep('a')], [other], { agent: 'nobody' }).flags.some((f) => /no entry for nobody/.test(f.message)), 'a panel without the agent is a flag');
  assert.equal(budgets([opened('r1', 'a', 1_000)], [turnStep('a')], [panel('s', { budget: null })]).flags.length, 1, 'a panel that names no budget is a flag, never a pass');
  assert.equal(budgets([], [turnStep('a')], [panel('s')]).flags.length, 1, 'a checkpoint whose segment made no agent request is a flag');
});

// K3b and K6b: a store whose head window was reset at a topic transition (context-manager's marker).
const resetStore = {
  messages: [
    { id: 'm1', canaries: ['[[c:a.in]]'] }, { id: 'm2', canaries: ['[[c:a.r1]]'] },
    { id: 'm3', canaries: [], topicTransition: true },
    { id: 'm4', canaries: ['[[c:b.in]]'] }, { id: 'm5', canaries: ['[[c:b.r1]]'] },
    { id: 'm6', canaries: ['[[c:c.in]]'] },
  ],
  summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sourceIds: ['m1', 'm2'], number: '[[s:C1]]', covers: ['[[c:a.in]]', '[[c:a.r1]]'] }],
};
const resetScript = [turnStep('a'), turnStep('b'), turnStep('c')];
const headOf3 = [panel('s', { head: 3, tail: 0 })];

test('K3b: after a head-window reset, store order holds within the head window and within what follows it, not across them', () => {
  // context-manager renders the head (from the transition on) first, then the summary of what came before it.
  const correct = { id: 'correct', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:b.in]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:c.in]]'))] };
  const swappedHead = { id: 'swapped-head', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:b.r1]]')), msg('assistant', carrying('[[c:b.in]]')), msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:c.in]]'))] };
  const swappedRest = { id: 'swapped-rest', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:b.in]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', carrying('[[c:c.in]]'), summaryBlock('[[s:C1]]'))] };
  const order = (r) => coverage([r], resetStore, resetScript, headOf3).filter((f) => /store order/.test(f.message)).map((f) => f.request);
  assert.deepEqual([correct, swappedHead, swappedRest].flatMap(order), ['swapped-head', 'swapped-rest']);
  // With no head size reported, the request is held to one order, as before.
  assert.deepEqual(coverage([correct], resetStore).filter((f) => /store order/.test(f.message)).map((f) => f.request), ['correct']);
});

test('K6b: check 6\'s head window starts at the last topic transition stored before the request', () => {
  const r = { id: 'after-reset', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:b.in]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:c.in]]'))] };
  assert.deepEqual(windowsRaw([r], resetScript, headOf3, resetStore).filter((f) => /head window/.test(f.message)), [], 'a.in and a.r1 are before the head now, and may fold');
  const lost = { ...r, id: 'lost', messages: [msg('user', carrying('[[c:b.in]]')), msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:c.in]]'))] };
  assert.match(windowsRaw([lost], resetScript, headOf3, resetStore).find((f) => /head window/.test(f.message))?.message ?? '', /b\.r1/);
});

test('K3: check 4 flags a request whose raw messages and summaries don\'t run in store order', () => {
  const inOrder = { id: 'in-order', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:b.in]]', '[[c:b.r1]]')), msg('user', carrying('[[c:c.in]]'))] };
  const merge = { id: 'merge', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('user', carrying('[[c:c.in]]'))] };
  const swapped = { id: 'swapped', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C2]]', '[[s:C1]]')), msg('user', carrying('[[c:c.in]]'))] };
  const rawFirst = { id: 'raw-first', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:c.in]]')), msg('user', summaryBlock('[[s:C3]]'))] };
  // A raw message inside a summary's span is there twice, which check 4 names as that, not as out of order.
  const twice = { id: 'twice', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('user', carrying('[[c:b.in]]', '[[c:c.in]]'))] };
  const flags = [inOrder, merge, swapped, rawFirst, twice].flatMap((r) => coverage([r], store)).filter((f) => /store order/.test(f.message));
  assert.deepEqual(flags.map((f) => f.request), ['swapped', 'raw-first']);
});

test('K4: check 6 holds a segment\'s last request to the raw tail the host reported, past the two turns before it, among what was stored before it', () => {
  const script = [turnStep('q'), turnStep('p'), turnStep('a'), turnStep('b'), turnStep('c')];
  const stored = (...canaries) => ({ canaries });
  const store = { messages: [...['q.in', 'q.r1', 'p.in', 'p.r1', 'a.in', 'a.r1', 'b.in', 'b.r1'].map((c) => stored(`[[c:${c}]]`)), stored(), stored('[[c:c.in]]'), stored('[[c:c.r1]]')], summaries: [] };
  const all = ['q.in', 'q.r1', 'p.in', 'p.r1', 'a.in', 'a.r1', 'b.in', 'b.r1', 'c.in'].map((c) => `[[c:${c}]]`);
  const without = (c) => all.filter((x) => x !== c);
  const req = (id, step, canaries) => ({ id, step, kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  const log = [panel('s', { head: 1, tail: 7 })];
  // The tail's 7 newest before c's request: p.r1 .. b.r1, the clock row, c.in. c.r1 came after it.
  // Held to that tail, b's request would need q.r1; it isn't the request the panel describes.
  assert.deepEqual(windowsRaw([req('b-early', 'b', without('[[c:q.r1]]')), req('ok', 'c', all)], script, log, store), []);
  const folded = windowsRaw([req('folded', 'c', without('[[c:p.r1]]'))], script, log, store);
  assert.deepEqual(folded.map((f) => [f.check, f.request]), [[6, 'folded']], 'p.r1 is past the two turns before c, inside the reported tail');
  assert.match(folded[0].message, /tail.*p\.r1/);
  const noTail = windowsRaw([req('ok', 'c', all)], script, [panel('s', { head: 1 })], store);
  assert.deepEqual(noTail.map((f) => f.message), ["no tail size was reported at segment s's checkpoint"]);
});

test('K5: close-merge declares its long message stored in parts, from the store, and parallel the tool round\'s image reaching it as its placeholder', () => {
  const script = continuation();
  const wanted = products(configurations().default);
  const segment = (missing, name) => missing.find((m) => m.segment === name)?.missing ?? [];
  const parts = { messages: [{ id: 'm1', canaries: ['[[c:c.cm.2.in]]'], bodyGroupId: 'g', shardIndex: 0 }, { id: 'm2', canaries: [], bodyGroupId: 'g', shardIndex: 1 }], summaries: [] };
  const whole = { messages: [{ id: 'm1', canaries: ['[[c:c.cm.2.in]]'] }], summaries: [] };
  const LONG = 'the long message stored in parts';
  assert.ok(!segment(declaredProducts([], script, wanted, parts), 'close-merge').includes(LONG));
  assert.ok(segment(declaredProducts([], script, wanted, whole), 'close-merge').includes(LONG));
  assert.ok(!segment(declaredProducts([], script, wanted, null), 'close-merge').includes(LONG), 'with no store read, the store\'s product waits on none');
  const PLACEHOLDER = 'the tool round\'s image as its placeholder';
  const imageCall = script.find((s) => s.id === 'c.tool').replies[0].calls.find((c) => c.input.kind === 'image').input.canary;
  const carryingResult = (images) => ({ id: 'r', step: 'c.par', kind: 'agent', messages: [msg('user', { type: 'tool_result', chars: 61, toolUseId: 't', canaries: [imageCall], ...(images ? { images } : {}) })] });
  assert.ok(!segment(declaredProducts([carryingResult(0)], script, wanted, null), 'parallel').includes(PLACEHOLDER));
  assert.ok(segment(declaredProducts([carryingResult(1)], script, wanted, null), 'parallel').includes(PLACEHOLDER), 'an image still in it isn\'t its placeholder');
});
