import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assemblies, budgets, compileInvariants, compileKinds, pairing, reloads, requestPairs, declaredProducts, everyTurnAnswers, wellFormed, windowsRaw, calibrationEdge, coverage, bookkeeping } from '../lib/strategies/checks.mjs';
import { continuation, products, configurations, L3_PRODUCT } from '../lib/strategies/script.mjs';

const msg = (role, ...blocks) => ({ role, blocks });
const text = (canaries) => ({ type: 'text', chars: 10, ...(canaries ? { canaries } : {}) });
const call = (id) => ({ type: 'tool_use', chars: 10, toolUseId: id });
const result = (id, images) => ({ type: 'tool_result', chars: 10, toolUseId: id, ...(images ? { images } : {}) });

test('check 2 names each segment whose product no record in it shows, and only those', () => {
  const script = continuation();
  const wanted = products(configurations().H1);
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
  const wanted = products(configurations().H1);
  const l1 = { id: 'r1', step: 'c.cm.1', kind: 'summariser', level: 1, answer: { shape: 'summary' } };
  const atLevel = (level) => ({ id: `m${level}`, step: 'c.cm.2', kind: 'summariser', level, answer: { shape: 'summary' } });
  const closeMerge = (records) => declaredProducts(records, script, wanted).find((m) => m.segment === 'close-merge')?.missing ?? [];
  assert.deepEqual(closeMerge([l1, atLevel(2)]), [L3_PRODUCT]);
  assert.deepEqual(closeMerge([l1, atLevel(3)]), []);
});

test('check 2: a configuration that doesn\'t summarise declares no summariser products', () => {
  const missing = declaredProducts([], continuation(), products(configurations().H3));
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
  const flags = [full, noHead, noRecent].flatMap((r) => windowsRaw([r], script, log, store));
  assert.deepEqual(flags.map((f) => f.request), ['nohead', 'norecent'], 'p.2, past the reported head, may fold');
  assert.match(flags[0].message, /p\.1\.r1/);
  assert.match(flags[1].message, /b\.r2/);
  const sized = [{ kind: 'checkpoint', name: 's', health: { data: { contextComposition: { fixture: { tail: { messages: 0, tokens: 0 } } } } } }];
  assert.deepEqual(windowsRaw([full], script, sized, store).map((f) => f.message), ["no head size was reported at segment s's checkpoint"]);
  assert.deepEqual(windowsRaw([noHead, full], script, sized, store).map((f) => [f.request, f.message]), [['ok', "no head size was reported at segment s's checkpoint"]], 'once a segment, on its last request');
  assert.deepEqual(windowsRaw([noHead], script, [], store).filter((f) => /head/.test(f.message)), [], 'a segment that ends at no checkpoint, as a workload\'s, has no head to hold it to');
  assert.deepEqual(windowsRaw([noHead], script, log, null), [], 'with no store read, only the recent window is checked');
});
test('check 6 holds only a segment\'s last request to the head its checkpoint reported, since the panel describes that compile alone', () => {
  const script = [turnStep('a'), turnStep('b', 2), turnStep('c'), turnStep('d')];
  const stored = (...canaries) => ({ canaries });
  const store = { messages: [stored(), stored('[[c:p.1.in]]'), stored('[[c:p.1.r1]]'), stored('[[c:p.2.in]]'), stored('[[c:p.2.r1]]'), ...['a.in', 'a.r1', 'b.in', 'b.r1', 'b.r2', 'c.in', 'c.r1', 'd.in'].map((c) => stored(`[[c:${c}]]`))], summaries: [] };
  const log = [{ kind: 'checkpoint', name: 's', health: { data: { contextComposition: { fixture: { head: { messages: 3, tokens: 50 }, tail: { messages: 0, tokens: 0 } } } } } }];
  // c's compile had a head of two messages, so p.1.r1 reached it inside P1; by the checkpoint the head had grown to three.
  const early = { id: 'early', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]')), msg('assistant', summaryBlock('[[s:P1]]')), msg('user', carrying('[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:b.r2]]', '[[c:c.in]]'))] };
  const last = { id: 'last', step: 'd', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]', '[[c:p.1.r1]]')), msg('assistant', summaryBlock('[[s:P2]]')), msg('user', carrying('[[c:b.in]]', '[[c:b.r1]]', '[[c:b.r2]]', '[[c:c.in]]', '[[c:c.r1]]', '[[c:d.in]]'))] };
  const lastLost = { ...last, id: 'last-lost', messages: [msg('user', carrying('[[c:p.1.in]]')), ...last.messages.slice(1)] };
  assert.deepEqual(windowsRaw([early, last], script, log, store), []);
  assert.deepEqual(windowsRaw([early, lastLost], script, log, store).map((f) => [f.request, f.message]), [['last-lost', "the head window's [[c:p.1.r1]] isn't raw"]]);
});
test('check 6 asks a request for a head message only once it was stored, through the turn\'s own earlier replies', () => {
  const script = [turnStep('p.1', 2), turnStep('p.2')];
  const stored = (...canaries) => ({ canaries });
  const store = { messages: ['p.1.in', 'p.1.r1', 'p.1.r2', 'p.2.in', 'p.2.r1'].map((c) => stored(`[[c:${c}]]`)), summaries: [] };
  const log = [{ kind: 'checkpoint', name: 's', health: { data: { contextComposition: { fixture: { head: { messages: 5, tokens: 50 }, tail: { messages: 0, tokens: 0 } } } } } }];
  const first = { id: 'first', step: 'p.1', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]'))] };
  const second = { id: 'second', step: 'p.1', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]')), msg('assistant', carrying('[[c:p.1.r1]]'))] };
  const secondLost = { id: 'second-lost', step: 'p.1', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]'))] };
  assert.deepEqual(windowsRaw([first], script, log, store), [], 'the first request isn\'t asked for its own reply');
  assert.deepEqual(windowsRaw([first, second], script, log, store), []);
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

// An agent request as the stand-in records it (T18): its messages, each with its digest, their
// tokens, its max tokens, the usage it answered with, and the tool_use ids its answer minted.
// `opened` opens a turn, or restarts one with messages context-manager rendered afresh;
// `continued` carries the request before it whole, then the round that request's answer opened.
// The usage is all fresh input unless `cached` names how much of it the cache read: an opened
// request's is all fresh unless given, and a continued one reads the request before it from the
// cache, all of it unless given.
const asked = (id, step, messageTokens, input, messages, toolUseIds, cached = 0) => ({ id, step, kind: 'agent', maxTokens: 2_048, usage: { input_tokens: input - cached, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 }, messages, answer: { shape: 'reply', stop: toolUseIds.length ? 'tool_use' : 'end_turn', toolUseIds } });
const wholeInput = (r) => r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens;
const opened = (id, step, messageTokens, input = messageTokens + 8_000, calls = [], cached = 0) => asked(id, step, messageTokens, input, [{ role: 'user', digest: `in.${id}`, blocks: [text()] }], calls, cached);
const continued = (before, id, messageTokens, input = messageTokens + 8_000, calls = [], cached = wholeInput(before)) => asked(id, before.step, messageTokens, input, [
  ...before.messages,
  { role: 'assistant', digest: `reply.${before.id}`, blocks: [text(), ...before.answer.toolUseIds.map(call)] },
  { role: 'user', digest: `results.${before.id}`, blocks: before.answer.toolUseIds.map((id) => result(id)) },
], calls, cached);
// A run's log as the driver writes it: the host's stream events and the stand-in's arrivals.
const started = { kind: 'ipc', event: { type: 'inference:started', agentName: 'fixture' } };
const resumed = { kind: 'ipc', event: { type: 'inference:stream_resumed', agentName: 'fixture' } };
const sent = (id) => ({ kind: 'request', request: { id, kind: 'agent' } });
// The driver's log of connectome-host's `/budget` after a boot (D12): its header, then the agent's line.
const budgetReport = (...lines) => ({ kind: 'budget-report', boot: 1, lines: ['--- Stream Token Budgets ---', ...lines], ms: 5 });
const WINDOW_CLAUSE = '; its stream doesn\'t break at this budget mid-turn: for its size, only before a request its 1.0M window can\'t hold';
// The harness module's compile lines for the requests `compiled` names, agent-framework's request
// compiles, with each request marked by its turn's last canary, as requestPairs pairs them: a request
// compiled opens a turn's canary, and the rounds after it in its step carry it. `[records, entry]`.
const compiledAs = (records, compiled, agent = 'fixture') => {
  const turn = new Map();
  const canaryOf = (r) => `[[c:${r.step}.${r.id}]]`;
  const marked = records.map((r) => {
    const key = `${r.agent ?? 'primary'}|${r.step}`;
    if (compiled.includes(r.id)) turn.set(key, canaryOf(r));
    const canary = turn.get(key);
    return canary ? { ...r, messages: [...r.messages.slice(0, -1), { ...r.messages.at(-1), blocks: [...r.messages.at(-1).blocks, text([canary])] }] } : r;
  });
  const sentFrom = records.filter((r) => compiled.includes(r.id));
  const lines = sentFrom.map((r, i) => ({ seq: i + 1, agent, kind: 'request', assembly: i + 1, outcome: 'compiled', messages: [{ sources: ['r:1'], content: `x.${r.id}` }] }));
  const blobs = Object.fromEntries(sentFrom.map((r) => [`x.${r.id}`, { role: 'user', content: [{ type: 'text', text: `${canaryOf(r)} words` }] }]));
  return [marked, { kind: 'compiles', lines, blobs }];
};
// A turn of three rounds under a stream bound of 30,000: r2's input passes it, so r3 follows a round over it.
const crossingAs = () => {
  const r1 = opened('r1', 'a', 15_000, 29_000, ['t1']);
  const r2 = continued(r1, 'r2', 16_000, 31_000, ['t2']);
  return compiledAs([r1, r2, continued(r2, 'r3', 17_000, 32_000)], ['r1']);
};
const crossing = () => crossingAs()[0];
const R1_COMPILED = crossingAs()[1];
const under = (report) => [...(report ? [report] : []), R1_COMPILED, sent('r1'), sent('r2'), sent('r3'), panel('s')];

test('K2e: with the module\'s compile lines, a request is compiled when the next sent compile\'s last canary is its own, so a restart that sends what a continuation would is compiled', () => {
  const withCanary = (r, canary) => ({ ...r, messages: [...r.messages.slice(0, -1), { ...r.messages.at(-1), blocks: [{ type: 'text', canaries: [canary] }] }] });
  const r1 = withCanary(opened('r1', 'a', 15_000, 23_000, ['t1']), '[[c:a.in]]');
  // r2 carries r1 and its round whole: by the records alone a continuation. r3 is a true continuation.
  const r2 = withCanary(continued(r1, 'r2', 19_000, 25_000, ['t2']), '[[c:a.call1]]');
  const r3 = withCanary(continued(r2, 'r3', 20_000, 26_000), '[[c:a.call2]]');
  const b = (id, canary) => ({ [id]: { role: 'user', content: [{ type: 'text', text: `${canary} words` }] } });
  const line = (seq, assembly, content, outcome = 'compiled') => ({ seq, agent: 'fixture', kind: 'request', assembly, outcome, messages: [{ sources: ['r:1'], content }] });
  const log = [
    { kind: 'compiles', lines: [line(1, 1, 'x1'), line(2, 2, 'x2', 'refused'), line(3, 2, 'x2'), { ...line(4, 3, 'x9'), kind: 'dry' }, line(5, 4, 'x5')], blobs: { ...b('x1', '[[c:a.in]]'), ...b('x2', '[[c:a.call1]]'), ...b('x9', '[[c:a.call2]]'), ...b('x5', '[[c:z.in]]') } },
  ];
  const paired = compileKinds([r1, r2, r3], log);
  assert.deepEqual(Object.fromEntries(paired.kinds), { r1: 'compiled', r2: 'compiled', r3: 'continuation' }, 'a refused compile, retried in its assembly, and a dry compile take no request');
  assert.deepEqual(paired.unpaired.map((l) => l.seq), [5], 'a compile no request was sent from');
  assert.equal(compileKinds([r1], [{ kind: 'compiles', lines: [{ ...line(1, 1, 'x1'), agent: 'other' }], blobs: b('x1', '[[c:a.in]]') }]), null, 'no line for the agent: nothing to pair by');
  // A new host process numbers its compiles and assemblies from 1 again, and two runs of the driver
  // (the writer's extensions) each call their first boot 1: lines are taken in log order.
  for (const boot of [2, 1]) {
    const twoProcesses = [
      { kind: 'compiles', boot: 1, lines: [line(1, 1, 'x1')], blobs: b('x1', '[[c:a.in]]') },
      { kind: 'compiles', boot, lines: [line(1, 1, 'x2')], blobs: b('x2', '[[c:a.call1]]') },
    ];
    assert.deepEqual(Object.fromEntries(compileKinds([r1, r2], twoProcesses).kinds), { r1: 'compiled', r2: 'compiled' }, `each process's assembly 1 is its own (second boot numbered ${boot})`);
  }
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
  const { flags, notes } = budgets(crossing(), [turnStep('a')], under(budgetReport('  fixture: 30.0k (last: 0, 0%)')), { streamBound: 30_000, windowTokens: 1_000_000 });
  assert.deepEqual(flags.map((f) => f.request), ['r3']);
  assert.match(flags[0].message, /31000.*30000/);
  assert.deepEqual(notes, []);
});

test('K2d: with no report for the agent, only a continuation after a round over the stream bound is couldn\'t-judge', () => {
  // None at all, the header alone, and a line for another agent only.
  for (const log of [under(null), under(budgetReport()), under(budgetReport('  other: 30.0k (last: 0, 0%)'))]) {
    const { flags } = budgets(crossing(), [turnStep('a')], log, { streamBound: 30_000, windowTokens: 1_000_000 });
    assert.deepEqual(flags.map((f) => f.request), ['r3'], JSON.stringify(log.map((e) => e.kind)));
    assert.match(flags[0].message, /couldn't judge/);
  }
  // A report logged after the request doesn't govern it.
  const late = budgets(crossing(), [turnStep('a')], [R1_COMPILED, sent('r1'), sent('r2'), sent('r3'), budgetReport(`  fixture: 30.0k (last: 0, 0%)${WINDOW_CLAUSE}`), panel('s')], { streamBound: 30_000, windowTokens: 1_000_000 }).flags;
  assert.deepEqual(late.map((f) => f.request), ['r3']);
  assert.match(late[0].message, /couldn't judge/);
});

test('K2d: a report whose figure isn\'t the stream bound as the host formats it makes every continuation under it couldn\'t-judge', () => {
  const { flags, headroom } = budgets(crossing(), [turnStep('a')], under(budgetReport('  fixture: 150.0k (last: 0, 0%)')), { streamBound: 30_000, windowTokens: 1_000_000 });
  assert.deepEqual(flags.map((f) => f.request), ['r2', 'r3'], 'r2 follows a round under the bound and is still couldn\'t-judge');
  for (const f of flags) assert.match(f.message, /couldn't judge.*150\.0k.*30000.*30\.0k/);
  assert.deepEqual(headroom.map((h) => h.kind), ['compiled']);
  assert.deepEqual(budgets(crossing(), [turnStep('a')], under(budgetReport('  fixture: 1.0M (last: 0, 0%)')), { streamBound: 1_000_000, windowTokens: 1_000_000 }).flags, [], 'a million, as the host writes it');
  assert.deepEqual(budgets(crossing(), [turnStep('a')], under(budgetReport('  fixture: 150.0k (last: 0, 0%)')), { windowTokens: 1_000_000 }).flags, [], 'the default bound, as the host writes it');
});

test('K2b: a compiled request is held to the model\'s window by the stand-in\'s count of its whole input, every one of them, and context-manager\'s budgetMet flags nothing', () => {
  const script = [turnStep('a'), { ...turnStep('b'), segment: 't' }];
  // A 30,000-token window: r1's whole input fits it exactly, r2's (a restart's compile) passes it,
  // and r3's plan sits in context-manager's slack band, which budgetMet: false reports.
  const [records, lines] = compiledAs([opened('r1', 'a', 17_952, 30_000), opened('r2', 'a', 18_000, 31_000), opened('r3', 'b', 10_000, 18_000)], ['r1', 'r2', 'r3']);
  const log = [lines, panel('s'), panel('t', { budgetMet: false, exhausted: true })];
  const { flags, headroom } = budgets(records, script, log, { windowTokens: 30_000 });
  assert.deepEqual(flags.map((f) => [f.check, f.step, f.request]), [[3, 'a', 'r2']]);
  assert.match(flags[0].message, /31000.*30000-token window/);
  assert.deepEqual(headroom.map((h) => [h.segment, h.kind, h.request, h.tokens, h.bound]), [['s', 'compiled', 'r2', 31_000, 30_000], ['t', 'compiled', 'r3', 18_000, 30_000]], 'the least headroom of each segment, against the window');
});

test('K2b: a continuation round is held to the stream bound, flagged only when the round before it was already over it', () => {
  const script = [turnStep('a')];
  // The stream bound 30,000 for the test; agent-framework restarts once a round's input passes it.
  const r1 = opened('r1', 'a', 15_000, 29_000, ['t1']);
  const r2 = continued(r1, 'r2', 22_000, 31_000, ['t2']);
  const [records, lines] = compiledAs([r1, r2, continued(r2, 'r3', 23_000, 32_000)], ['r1']);
  const log = [lines, budgetReport('  fixture: 30.0k (last: 0, 0%)'), sent('r1'), sent('r2'), sent('r3'), panel('s')];
  const { flags, headroom } = budgets(records, script, log, { streamBound: 30_000, windowTokens: 1_000_000 });
  assert.deepEqual(flags.map((f) => f.request), ['r3'], 'r2 may cross the bound, since r1 was under it; r3 follows a round over it');
  assert.match(flags[0].message, /31000.*30000/);
  assert.deepEqual(headroom.filter((h) => h.kind === 'continuation').map((h) => [h.request, h.tokens, h.bound]), [['r3', 32_000, 30_000]]);
  assert.equal(budgets(records, script, [lines, panel('s')], { windowTokens: 1_000_000 }).flags.length, 0, 'under agent-framework 0.28.0\'s default bound, 150,000, none is over');
  assert.deepEqual(budgets(records, script, [lines, panel('s', { budgetMet: false })], { windowTokens: 1_000_000 }).flags, [], 'context-manager\'s budgetMet is no flag');
});

test('K2b: a continuation is held to its stream\'s fresh input so far, as membrane sums it, not to the whole input of the request before it', () => {
  const script = [turnStep('a')];
  // A warm restart's compile: 31,000 tokens whole, 2,000 of them read from the cache. Its fresh
  // 29,000 is under the 30,000 bound, so agent-framework continues, and rightly.
  const w1 = opened('w1', 'a', 20_000, 31_000, ['t1'], 2_000);
  const [warm, warmLines] = compiledAs([w1, continued(w1, 'w2', 21_000, 32_000)], ['w1']);
  assert.deepEqual(budgets(warm, script, [warmLines, budgetReport('  fixture: 30.0k (last: 0, 0%)'), panel('s')], { streamBound: 30_000, windowTokens: 1_000_000 }).flags, []);
  // Cache misses mid-stream: no request's whole input passes 30,000, but the fresh input summed over
  // the stream does before x3 (20,000 + 15,000), so agent-framework should have restarted there.
  const x1 = opened('x1', 'a', 12_000, 20_000, ['t1']);
  const x2 = continued(x1, 'x2', 14_000, 25_000, ['t2'], 10_000);
  const [missed, missedLines] = compiledAs([x1, x2, continued(x2, 'x3', 15_000, 27_000)], ['x1']);
  const { flags } = budgets(missed, script, [missedLines, budgetReport('  fixture: 30.0k (last: 0, 0%)'), sent('x1'), sent('x2'), sent('x3'), panel('s')], { streamBound: 30_000, windowTokens: 1_000_000 });
  assert.deepEqual(flags.map((f) => f.request), ['x3']);
  assert.match(flags[0].message, /fresh input reached 35000 tokens, over the stream bound 30000/);
  // A continuation's whole input is held to the window too.
  const wide = budgets(warm, script, [warmLines, budgetReport('  fixture: 300.0k (last: 0, 0%)'), panel('s')], { streamBound: 300_000, windowTokens: 31_500 }).flags;
  assert.deepEqual(wide.map((f) => f.request), ['w2']);
  assert.match(wide[0].message, /continuation round's whole input at 32000 tokens, over the model's 31500-token window/);
});

test('K2b: for a second agent, check 3 judges its own requests (the stand-in\'s sub records) and none of the primary\'s', () => {
  const sub = (r) => ({ ...r, agent: 'sub' });
  const s1 = sub(opened('s1', 'a', 2_000, 10_000, ['t1']));
  const s2 = sub(continued(s1, 's2', 2_100, 11_000, ['t2']));
  const s3 = sub(continued(s2, 's3', 2_200, 12_000));
  const p1 = { ...opened('p1', 'b', 1_000, 9_000), agent: 'primary' };
  const script = [turnStep('a'), turnStep('b')];
  const [subMarked, subLines] = compiledAs([s1, s2, s3, p1], ['s1'], 'knowledge-1');
  const [records, primaryLines] = compiledAs(subMarked, ['p1']);
  const log = [subLines, primaryLines, sent('s1'), sent('s2'), sent('s3'), sent('p1')];
  const forSub = budgets(records, script, log, { agent: 'knowledge-1', streamBound: 100_000, windowTokens: 1_000_000 });
  assert.deepEqual(forSub.flags, []);
  assert.equal(forSub.requests, 3);
  assert.equal(forSub.judged, 3, 'the subagent\'s compiled request and its two continuation rounds');
  assert.deepEqual(forSub.headroom.map((h) => [h.kind, h.request]), [['compiled', 's1'], ['continuation', 's3']]);
  const forPrimary = budgets(records, script, log, { streamBound: 100_000, windowTokens: 1_000_000 });
  assert.equal(forPrimary.requests, 1);
  assert.equal(forPrimary.judged, 1);
});

test('K2b: a request the stand-in answered with a provider error isn\'t judged, and adds nothing to its stream\'s fresh input; the retry is judged', () => {
  const script = [turnStep('a')];
  const failed = { ...opened('r1', 'a', 20_000, 31_000, ['t1']), usage: undefined, answer: { shape: 'error', status: 529 } };
  const retry = opened('r2', 'a', 20_000, 29_000, ['t1']);
  const next = continued(retry, 'r3', 21_000, 30_000);
  // agent-framework resends the refused request: the one compile is the failed request's, and the
  // retry and the round after it pair as rounds of its turn.
  const [records, lines] = compiledAs([failed, retry, next], ['r1']);
  const { flags, judged } = budgets(records, script, [lines, budgetReport('  fixture: 30.0k (last: 0, 0%)'), sent('r1'), sent('r2'), sent('r3'), panel('s')], { streamBound: 30_000, windowTokens: 1_000_000 });
  assert.deepEqual(flags, [], 'the error\'s missing usage is no couldn\'t-judge');
  assert.equal(judged, 2, 'the retry and its continuation');
});

test('K2b: a run with no compile line of the agent\'s, a compiled request with no usage, a check given no window, and a segment with no agent request each say the check couldn\'t judge', () => {
  const script = [turnStep('a'), { ...turnStep('b'), segment: 't' }];
  const lineless = budgets([opened('r1', 'a', 1_000)], [turnStep('a')], [panel('s')], { windowTokens: 1_000_000 });
  assert.deepEqual(lineless.flags.map((f) => [f.check, f.step, f.what]), [[3, 'the run', 'no-compile-lines']]);
  assert.match(lineless.flags[0].message, /couldn't judge fixture's 1 request\(s\): the log holds no request compile line of fixture's/);
  assert.equal(lineless.judged, null, 'judged none, and counted as unknown rather than as nothing judged');
  const primaryLine = compiledAs([opened('p1', 'a', 1_000)], ['p1'])[1];
  const subLineless = budgets([{ ...opened('s1', 'a', 1_000), agent: 'sub' }], [turnStep('a')], [primaryLine, panel('s')], { agent: 'knowledge-1', windowTokens: 1_000_000 }).flags;
  assert.match(subLineless[0].message, /couldn't judge knowledge-1's 1 request\(s\)/, 'the primary\'s lines don\'t stand for a second agent\'s');
  const [unusedRecords, unusedLines] = compiledAs([{ ...opened('r1', 'a', 1_000), usage: undefined }], ['r1']);
  const unused = budgets(unusedRecords, [turnStep('a')], [unusedLines, panel('s')], { windowTokens: 1_000_000 }).flags;
  assert.deepEqual(unused.map((f) => f.request), ['r1']);
  assert.match(unused[0].message, /couldn't judge.*no usage/);
  const [one, oneLine] = compiledAs([opened('r1', 'a', 1_000)], ['r1']);
  const windowless = budgets(one, [turnStep('a')], [oneLine, panel('s')]).flags;
  assert.deepEqual(windowless.map((f) => f.request), ['r1']);
  assert.match(windowless[0].message, /couldn't judge.*no window/);
  const [two, twoLines] = compiledAs([opened('r1', 'a', 1_000), opened('r2', 'b', 1_000)], ['r1', 'r2']);
  assert.deepEqual(budgets(two, script, [twoLines, panel('s'), panel('t', { budget: 30_000 })], { windowTokens: 1_000_000 }).flags, [], 'a budget that moved between checkpoints bounds nothing the check reads');
  assert.equal(budgets([], [turnStep('a')], [panel('s')], { windowTokens: 1_000_000 }).flags.length, 1, 'a checkpoint whose segment made no agent request is a flag');
});

test('requestPairs: each compiled assembly takes the next request carrying its last canary; a refusal retried in its assembly counts once; a subagent\'s requests pair only with its own lines', () => {
  const withCanary = (r, canary, agent) => ({ ...r, ...(agent ? { agent } : {}), messages: [...r.messages.slice(0, -1), { ...r.messages.at(-1), blocks: [{ type: 'text', canaries: [canary] }] }] });
  const p1 = withCanary(opened('p1', 'a', 1_000, undefined, ['t1']), '[[c:a.in]]', 'primary');
  const p2 = withCanary(continued(p1, 'p2', 1_100), '[[c:a.call1]]', 'primary');
  const s1 = withCanary(opened('s1', 'a', 900), '[[c:a.task]]', 'sub');
  const p3 = withCanary(opened('p3', 'b', 1_000), '[[c:b.in]]', 'primary');
  const b = (id, canary) => ({ [id]: { role: 'user', content: [{ type: 'text', text: `${canary} words` }] } });
  const line = (seq, agent, assembly, content, outcome = 'compiled') => ({ seq, agent, kind: 'request', assembly, outcome, messages: [{ sources: ['r:1'], content }] });
  const log = [
    { kind: 'compiles', step: 'a', boot: 1, lines: [line(1, 'fixture', 1, 'x1'), line(2, 'knowledge', 1, 'xs'), line(3, 'fixture', 2, 'x3', 'refused'), line(4, 'fixture', 2, 'x3')], blobs: { ...b('x1', '[[c:a.in]]'), ...b('xs', '[[c:a.task]]'), ...b('x3', '[[c:b.in]]') } },
    { kind: 'compiles', step: 'b', boot: 1, lines: [line(5, 'fixture', 3, 'x5', 'refused')], blobs: b('x5', '[[c:b.again]]') },
  ];
  assert.deepEqual(assemblies(log).map((l) => [l.seq, l.outcome, l.step]), [[1, 'compiled', 'a'], [4, 'compiled', 'a'], [5, 'refused', 'b']], 'a retried refusal counts once, by its last line; a refusal not retried stays');
  const primary = requestPairs([p1, s1, p2, p3], log);
  assert.deepEqual(primary.pairs.map(({ line: l, request }) => [l.seq, request.id]), [[1, 'p1'], [4, 'p3']]);
  assert.deepEqual(primary.continuations.map((r) => r.id), ['p2']);
  assert.deepEqual(primary.unpaired, []);
  const sub = requestPairs([p1, s1, p2, p3], log, 'knowledge');
  assert.deepEqual(sub.pairs.map(({ line: l, request }) => [l.seq, request.id]), [[2, 's1']], 'the second agent\'s lines pair with the stand-in\'s sub requests alone');
  assert.equal(requestPairs([p1], []), null);
});

test('check 13: a request compile no stand-in request took is a flag at its batch\'s step; a run whose compiles all paired, or with no compile lines, has none', () => {
  const r1 = opened('r1', 'a', 1_000, undefined, ['t1']);
  r1.messages[0] = { ...r1.messages[0], blocks: [{ type: 'text', canaries: ['[[c:a.in]]'] }] };
  const b = (id, canary) => ({ [id]: { role: 'user', content: [{ type: 'text', text: `${canary} words` }] } });
  const line = (seq, assembly, content) => ({ seq, agent: 'fixture', kind: 'request', assembly, outcome: 'compiled', messages: [{ sources: ['r:1'], content }] });
  const log = [
    { kind: 'compiles', step: 'a', lines: [line(1, 1, 'x1')], blobs: b('x1', '[[c:a.in]]') },
    { kind: 'compiles', step: 'b', lines: [line(2, 2, 'x2')], blobs: b('x2', '[[c:b.in]]') },
  ];
  const flags = pairing([r1], log);
  assert.deepEqual(flags.map((f) => [f.check, f.step, f.what]), [[13, 'b', 'fixture:unpaired']]);
  assert.match(flags[0].message, /compile 2 \(assembly 2\) went out in no request the stand-in received/);
  assert.deepEqual(pairing([r1], log.slice(0, 1)), []);
  assert.deepEqual(pairing([r1], []), [], 'no compile lines: nothing to pair');
});

test('check 12: the dry compile after a restart matches the one before, with image-ref nonces masked; a difference, a changed outcome and a missing line are flags', () => {
  const dry = (seq, contents, system = 'sys', outcome = 'compiled') => ({ seq, agent: 'fixture', kind: 'dry', outcome, ...(outcome === 'refused' ? { error: { class: 'OverBudgetError' } } : {}), messages: contents.map((content, i) => ({ sources: [`r:m${i}`], content })), system });
  const blobs = { a: 'one [ref img_loxiqa_1]', b: 'two', a2: 'one [ref img_68l20r_1]', c: 'three', sys: [{ text: 'x' }] };
  const run = (before, after) => [
    { kind: 'compiles', boot: 1, lines: [before], blobs },
    { kind: 'compiles', boot: 2, lines: [after], blobs: {} },
    { kind: 'reload', step: 'r.restart', agent: 'fixture', before: { boot: 1, seq: before.seq }, after: { boot: 2, seq: after.seq } },
  ];
  assert.deepEqual(reloads(run(dry(7, ['a', 'b']), dry(1, ['a2', 'b']))), [], 'a nonce made fresh by the new process is no difference');
  const changed = reloads(run(dry(7, ['a', 'b']), dry(1, ['a', 'c'])));
  assert.deepEqual(changed.map((f) => [f.check, f.step]), [[12, 'r.restart']]);
  assert.match(changed[0].message, /differs from the one before at message 1 of 2 before and 2 after/);
  assert.match(reloads(run(dry(7, ['a']), dry(1, [], 'sys', 'refused')))[0].message, /refused \(OverBudgetError\), where before it compiled/);
  const missing = reloads([{ kind: 'compiles', boot: 1, lines: [dry(7, ['a'])], blobs }, { kind: 'reload', step: 'r.restart', before: { boot: 1, seq: 7 }, after: { boot: 2, seq: null } }]);
  assert.match(missing[0].message, /couldn't judge the reload: the log holds no dry compile line after it/);
});

test('check 11: each breach a compile line carries is a flag, named by agent, kind and invariant, and so is a compile the module couldn\'t record', () => {
  const log = [
    { kind: 'compiles', step: 'a', lines: [
      { seq: 1, agent: 'fixture', kind: 'request', outcome: 'compiled', violations: [] },
      { seq: 2, agent: 'fixture', kind: 'request', outcome: 'compiled', violations: [{ invariant: 'budget', detail: '30100 tokens against an input budget of 29952 and a grace of 0' }] },
    ] },
    { kind: 'settle', step: 'b' },
    { kind: 'compiles', step: 'b', lines: [
      { seq: 3, agent: 'fixture', kind: 'other', outcome: 'refused', violations: [] },
      { seq: 4, agent: 'researcher', kind: 'dry', outcome: 'unrecordable', reason: 'getAllMessages threw' },
      { seq: 5, agent: 'researcher', kind: 'request', outcome: 'compiled', violations: [{ invariant: 'coverage', detail: '1 stored bodies in no message sent: m9' }, { invariant: 'shape', detail: 'message 2: result t1 answers no call in the message before it' }] },
    ] },
  ];
  const flags = compileInvariants(log);
  assert.deepEqual(flags.map((f) => [f.check, f.step, f.what]), [
    [11, 'a', 'fixture:request:budget'],
    [11, 'b', 'researcher:dry:unrecordable'],
    [11, 'b', 'researcher:request:coverage'],
    [11, 'b', 'researcher:request:shape'],
  ]);
  assert.match(flags[0].message, /fixture's request compile 2 breaks budget: 30100 tokens/);
  assert.match(flags[1].message, /couldn't record researcher's dry compile 4: getAllMessages threw/);
  assert.deepEqual(compileInvariants([]), [], 'a log with no compile lines has nothing to flag');
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
  // With no head size reported, the request splits at its head's start alone: what was stored from there on, and what was stored before.
  const unsized = (r) => coverage([r], resetStore).filter((f) => /store order/.test(f.message)).map((f) => f.request);
  assert.deepEqual([correct, swappedHead, swappedRest].flatMap(unsized), ['swapped-head']);
});

test('check 4 holds only a segment\'s last request to the head its checkpoint reported; an earlier one splits at the head\'s start alone', () => {
  const store = {
    messages: [...resetStore.messages, { id: 'm7', canaries: ['[[c:c.r1]]'] }, { id: 'm8', canaries: ['[[c:d.in]]'] }],
    summaries: resetStore.summaries,
  };
  const script = [...resetScript, turnStep('d')];
  const headOf2 = [panel('s', { head: 2, tail: 0 })];
  // c's compile had a head of three messages (m3, b.in, b.r1); by the checkpoint it had shrunk to two.
  const early = { id: 'early', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:b.in]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:c.in]]'))] };
  const last = { id: 'last', step: 'd', kind: 'agent', messages: [msg('user', carrying('[[c:b.in]]')), msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', carrying('[[c:c.in]]')), msg('assistant', carrying('[[c:c.r1]]')), msg('user', carrying('[[c:d.in]]'))] };
  const lastSwapped = { ...last, id: 'last-swapped', messages: [msg('user', carrying('[[c:b.in]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', summaryBlock('[[s:C1]]')), ...last.messages.slice(3)] };
  const earlySwapped = { ...early, id: 'early-swapped', messages: [msg('user', carrying('[[c:b.r1]]')), msg('assistant', carrying('[[c:b.in]]')), early.messages[2]] };
  const order = (rs) => coverage(rs, store, script, headOf2).filter((f) => /store order/.test(f.message)).map((f) => f.request);
  assert.deepEqual(order([early, last]), []);
  assert.deepEqual(order([early, lastSwapped]), ['last-swapped'], 'b.r1 is past the reported head, so it comes after the history before the head');
  assert.deepEqual(order([earlySwapped, last]), ['early-swapped'], 'from the head\'s start on, an earlier request still runs in store order');
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
  const wanted = products(configurations().H1);
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

test('checks 4 and 6: a request the stand-in answered with an error gives its step no reply, so its retry needs none', () => {
  const failed = { id: 'r3', step: 'c', kind: 'agent', answer: { shape: 'error', status: 529 }, messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const retry = { id: 'r4', step: 'c', kind: 'agent', answer: { shape: 'reply' }, messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  assert.deepEqual(coverage([failed, retry], store).map((f) => f.request), [], 'the retry is held to what the step had stored, not to a reply the error never gave');
});

test('check 4 on a subagent: its requests are held to its own store up to the last canary each carries, whatever the canaries are named', () => {
  const sub = {
    messages: [{ id: 's1', canaries: ['[[c:k.task]]'] }, { id: 's2', canaries: ['[[c:k.s1]]'] }, { id: 's3', canaries: ['[[c:k.s1call1]]'] }, { id: 's4', canaries: ['[[c:k.s2]]'] }],
    summaries: [{ id: 'L1-9', level: 1, sourceLevel: 0, sourceIds: ['s2', 's3'], number: '[[s:C9]]', covers: ['[[c:k.s1]]', '[[c:k.s1call1]]'] }],
  };
  const whole = { id: 'whole', step: 'k', kind: 'agent', agent: 'sub', messages: [msg('user', carrying('[[c:k.task]]')), msg('assistant', summaryBlock('[[s:C9]]')), msg('user', carrying('[[c:k.s2]]'))] };
  const lost = { id: 'lost', step: 'k', kind: 'agent', agent: 'sub', messages: [msg('user', carrying('[[c:k.task]]')), msg('user', carrying('[[c:k.s2]]'))] };
  const primaryOnly = coverage([whole, lost], sub);
  assert.equal(primaryOnly.judged, 0, 'the primary\'s side judges none of a subagent\'s requests');
  const flags = coverage([whole, lost], sub, [], [], { side: 'sub' });
  assert.equal(flags.judged, 2);
  assert.deepEqual(flags.map((f) => [f.request, f.what]), [['lost', 'not-reached']]);
  assert.match(flags[0].message, /\[\[c:k\.s1\]\] \[\[c:k\.s1call1\]\]/);
});

test('check 6 counts a request as judged only where it held it to some message', () => {
  const script = [{ id: 'a', segment: 's', replies: [{}] }, { id: 'b', segment: 's', replies: [{}] }, { id: 'c', segment: 's', replies: [{}] }];
  const empty = { messages: [], summaries: [] };
  const r = { id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:c.in]]'))] };
  assert.equal(windowsRaw([r], script, [], empty).judged, 0, 'nothing stored, so nothing to hold it to');
  assert.equal(windowsRaw([r], script, [], null).judged, 1, 'without a store read, the script\'s turns hold it');
});
