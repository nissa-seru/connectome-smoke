import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRecord, renderRecordLines } from '../lib/record.mjs';

const header = { configuration: 'H1/W1', release: { tag: 'v0.0.1', versions: { '@animalabs/connectome-host': '0.0.1' } }, from: 'empty', candidate: { versions: { '@animalabs/connectome-host': '0.0.2' } } };
const text = (t) => ({ participant: 'user', content: [{ type: 'text', text: t }] });
const blobs = {
  b1: text('[[c:p.1.in]] hello'),
  b2: { participant: 'fixture', content: [{ type: 'text', text: '[[c:p.1.r1]] hi' }] },
  b3: text('Clock: 12:10 UTC'),
  b4: text('[[c:p.2.in]] more'),
  b5: { participant: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: '[[c:p.2.call1]] [image: image/png, ~352KB, ref img_k7x3q2_1]' }] },
  b6: text('Clock: 12:20 UTC'),
  s1: { participant: 'summary', content: 'what happened first' },
  b7: { participant: 'user', content: [{ type: 'tool_result', toolUseId: 't2', content: 'ref img_zz9yy8_1 then ref img_k7x3q2_1' }] },
};
const m = (id, content, marker) => ({ sources: [`r:${id}`], content, ...(marker ? { marker: { message: true } } : {}) });
const line = (seq, messages, more = {}) => ({ seq, agent: 'fixture', kind: 'request', assembly: seq, outcome: 'compiled', messages, ...more });
const log = [
  { kind: 'send', via: 'ipc', step: 'p.name', command: '/session rename fixture' },
  { kind: 'send', via: 'channel', step: 'p.1' },
  { kind: 'compiles', step: 'p.1', blobs, lines: [line(1, [m(1, 'b1', true)])] },
  { kind: 'send', via: 'channel', step: 'p.2' },
  { kind: 'compiles', step: 'p.2', blobs: {}, lines: [line(2, [m(1, 'b1'), m(2, 'b2'), m(3, 'b3'), m(4, 'b4', true)]), line(3, [m(1, 'b1'), m(2, 'b2'), m(3, 'b3'), m(4, 'b4'), m(5, 'b5', true)])] },
  { kind: 'request', step: 'p.2', request: { id: 'r9', kind: 'summariser' } },
  { kind: 'compiles', step: 'p.3', blobs: {}, store: { fixture: {
    messages: [['1', ['[[c:p.1.in]]']], ['2', ['[[c:p.1.r1]]']]],
    summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sources: ['1', '2'], parent: null, content: 's1' }],
    receiptHead: { sequence: 5, receiptHash: 'abcdef0123456789abcdef', changes: [['L1-1', ['sum:L1-1', 1, 5]], ['6', ['raw:6', 0, 5]]] },
  } }, lines: [
    line(4, [m(3, 'b3'), m(4, 'b4'), m(5, 'b5'), m(6, 'b6')]),
    line(5, [{ sources: ['s:L1-1@1'], content: 's1' }, m(6, 'b6'), m(7, 'b7')]),
    line(6, [], { outcome: 'refused', error: { class: 'BudgetExceeded', message: 'over by 1234 tokens' } }),
  ] },
  { kind: 'checkpoint', step: 'p.end', name: 'prefix' },
];
const records = [{ id: 'r9', kind: 'summariser', step: 'p.2', messages: [{ blocks: [{ canaries: ['[[c:p.1.in]]'] }, { canaries: ['[[c:p.1.r1]]'] }] }], answer: { shape: 'summary' } }];

test('a record names messages by their canaries, writes each compile as what changed, and keeps the stack\'s texts once', () => {
  const r = renderRecord({ header, log, records, end: { ok: true } }).split('\n');
  const body = r.slice(r.indexOf('step p.name')).filter(Boolean).map((l) => l.replace(/, body [0-9a-f]{8}$/, ', body HASH'));
  assert.deepEqual(body, [
    'step p.name',
    '  action /session rename fixture',
    'step p.1',
    '  compile p.1.in ^ 1',
    'step p.2',
    '  compile + p.1.r1 [T:user-clock-#-#-utc](12,10) p.2.in ^ 4',
    '  compile + p.2.call1 ^ 5',
    '  call p.1.in p.1.r1 -> summary, body HASH',
    'step p.3',
    '  wrote L1(p.1.in-p.1.r1) [T:summary-l1-bda55950]',
    '  compile -2 + [T:user-clock-#-#-utc](12,20)',
    '  compile L1(p.1.in-p.1.r1) [T:user-clock-#-#-utc](12,20) [T:user-ref-img-na-#-then](1,1)',
    '  compile refused BudgetExceeded [T:error-budgetexceeded-over-by-#]',
    'checkpoint prefix',
    'end ok',
    'receipt fixture #5 changes L1(p.1.in-p.1.r1)/sum/1/5 #6/raw/0/5',
    'totals {"actions":1,"calls":1,"compiles":5,"dry":0,"other":0,"refused":1,"rounds":0,"written":1}',
  ]);
  assert.equal(r.indexOf('templates'), 3, 'the texts block comes first, after the header');
  const templates = r.slice(r.indexOf('templates') + 1, r.indexOf('step p.name'));
  assert.ok(templates.every((l) => l.startsWith('T:') || l.startsWith('  ')), 'and holds only the texts');
  assert.ok(templates.includes('T:user-clock-#-#-utc = Clock: #:# UTC'), 'numbers written as #, their values on the line');
  assert.ok(templates.includes('T:user-ref-img-na-#-then = ref img_na_# then ref img_nb_#'), 'each nonce named by the order it first appears');
  assert.ok(templates.includes('T:summary-l1-bda55950 = what happened first'));
});

test('texts that share a key are named by their words, whatever order they first appear in', () => {
  const recs = (texts) => texts.map((t, i) => ({ id: `r${i}`, kind: 'summariser', step: 'p.2', texts: [t], messages: [{ role: 'user', digest: 'd1', blocks: [{}] }], answer: { shape: 'summary' } }));
  const withCalls = (n) => [...log.slice(0, 5), ...Array.from({ length: n }, (_, i) => ({ kind: 'request', step: 'p.2', request: { id: `r${i}`, kind: 'summariser' } })), ...log.slice(6)];
  const texts = ['You have just reviewed the slices above.', 'You have just been reading a body of text.', 'You have just reviewed the memories above.\nWrite one.'];
  const named = (order) => {
    const r = renderRecord({ header, log: withCalls(3), records: recs(order.map((i) => texts[i])), end: { ok: true } }).split('\n');
    return r.slice(r.indexOf('templates') + 1, r.indexOf('step p.name')).filter((l) => /^T:call-|^  /.test(l));
  };
  assert.deepEqual(named([0, 1, 2]), [
    'T:call-you-have-just-been = You have just been reading a body of text.',
    'T:call-you-have-just-reviewed-the-memories = You have just reviewed the memories above.',
    '  Write one.',
    'T:call-you-have-just-reviewed-the-slices = You have just reviewed the slices above.',
  ], 'each key taken one word past what it shares with the others; a later line indented');
  assert.deepEqual(named([2, 1, 0]), named([0, 1, 2]), 'the order they first appear in changes no name');
});

test('a stored message sent without its thinking, or altered or in part, says so, and never joins a range', () => {
  const reply = (c, withThinking) => ({ participant: 'fixture', content: [...(withThinking ? [{ type: 'thinking', thinking: 'hm', signature: 's' }] : []), { type: 'text', text: `[[c:${c}]] ok` }] });
  const b = { u1: text('[[c:q.1.in]] a'), r1: reply('q.1.r1', true), r1bare: reply('q.1.r1', false), u2: text('[[c:q.2.in]] b'), r2: reply('q.2.r1', false) };
  const store = { fixture: { messages: [['1', ['[[c:q.1.in]]']], ['2', ['[[c:q.1.r1]]'], { thinking: true }], ['3', ['[[c:q.2.in]]']], ['4', ['[[c:q.2.r1]]']]] } };
  const lg = [
    { kind: 'send', via: 'channel', step: 'q.1' },
    { kind: 'compiles', step: 'q.1', blobs: b, store, lines: [
      line(1, [m(1, 'u1'), m(2, 'r1'), m(3, 'u2'), m(4, 'r2')]),
      line(2, [m(1, 'u1'), m(2, 'r1bare'), m(3, 'u2'), { sources: ['r:4!content'], content: 'r2' }]),
      line(3, [m(1, 'u1'), m(2, 'r1bare'), m(3, 'u2'), m(4, 'r2')]),
    ] },
  ];
  const compiles = (l) => renderRecord({ header, log: l, records: [], end: { ok: true } }).split('\n').filter((x) => x.startsWith('  compile'));
  assert.deepEqual(compiles(lg), [
    '  compile q.1.in-q.2.r1',
    '  compile q.1.in q.1.r1:no-thinking q.2.in q.2.r1!content',
    '  compile q.1.in q.1.r1:no-thinking q.2.in-q.2.r1',
  ], 'the thinking left out by the bytes sent, the body altered by its provenance');
  const stripped = JSON.parse(JSON.stringify(lg));
  stripped[1].store.fixture.messages.push(['2', ['[[c:q.1.r1]]'], { thinking: false }]);
  assert.equal(compiles(stripped)[1], '  compile q.1.in-q.2.in q.2.r1!content', 'a stored copy whose thinking went is sent as it is, so it says nothing, and joins its range');
});

test('two runs whose image nonces differ write the same record', () => {
  const other = JSON.parse(JSON.stringify(log).replaceAll('k7x3q2', 'a1b2c3').replaceAll('zz9yy8', 'q0q0q0'));
  assert.equal(renderRecord({ header, log: other, records, end: { ok: true } }), renderRecord({ header, log, records, end: { ok: true } }));
});

test('a summariser call shows its own words as templates, and its body hash moves when anything else it sends does', () => {
  const asked = (texts, digest = 'd1', more = {}) => [{ id: 'r9', kind: 'summariser', step: 'p.2', model: 'm', maxTokens: more.maxTokens ?? 16000, stream: false, texts,
    head: { model: 'm', maxTokens: more.maxTokens ?? 16000, toolChoice: null, thinking: null, system: [{ text: 'You summarise.', cache: null }], tools: [{ name: 't', sha: more.toolSha ?? '0123456789abcdef' }], rest: null },
    messages: [{ role: 'user', digest, blocks: [{ canaries: ['[[c:p.1.in]]'] }, { canaries: ['[[c:p.1.r1]]'] }, {}] }], answer: { shape: 'summary' }, ...more }];
  const recordOf = (recs) => renderRecord({ header, log, records: recs, end: { ok: true } });
  const callOf = (recs) => recordOf(recs).split('\n').find((l) => l.startsWith('  call '));
  const plain = callOf(asked(['Summarise in about 400 tokens, phase: research.']));
  assert.match(plain, /^  call p\.1\.in p\.1\.r1 \[T:call-summarise-in-about\]\(400\) -> summary, head H:[0-9a-f]{8}, body [0-9a-f]{8}$/);
  const reworded = recordOf(asked(['Summarise in about 400 tokens, phase: .']));
  assert.notEqual(reworded, recordOf(asked(['Summarise in about 400 tokens, phase: research.'])), 'a change to its words');
  assert.ok(reworded.split('\n').includes('T:call-summarise-in-about = Summarise in about # tokens, phase: .'), 'and the words show in its template');
  assert.notEqual(callOf(asked(['Summarise in about 400 tokens, phase: research.'], 'd2')), plain, 'a change to a carried message\'s content');
  const limited = recordOf(asked(['Summarise in about 400 tokens, phase: research.'], 'd1', { maxTokens: 8000 })).split('\n');
  assert.notEqual(limited.find((l) => l.startsWith('  call ')), plain, 'a change to its limits names another head');
  assert.ok(limited.some((l) => /^H:[0-9a-f]{8} = model m, max_tokens 8000, stream false, system \[T:system-you-summarise\], tools t:01234567$/.test(l)), 'and the heads block says what the head is');
  const retooled = recordOf(asked(['Summarise in about 400 tokens, phase: research.'], 'd1', { toolSha: 'fedcba9876543210' })).split('\n');
  assert.ok(retooled.some((l) => /, tools t:fedcba98$/.test(l)), 'a tool\'s changed definition shows as its hash');
  assert.equal(callOf(asked(['Summarise in about 400 tokens, phase: research.'])), plain, 'the same request, the same line');
});

test('a summary a summariser call carries is named as the store names it, not written out again', () => {
  const recs = [{ id: 'r9', kind: 'summariser', step: 'p.2', texts: ['a: [[s:M0000beef]] Memory beef, what happened first', 'Merge these.'],
    messages: [{ role: 'user', digest: 'd1', blocks: [{}, {}] }], answer: { shape: 'summary' } }];
  const line = renderRecord({ header, log, records: recs, end: { ok: true } }).split('\n').find((l) => l.startsWith('  call '));
  assert.match(line, /^  call - S\(M0000beef\) \[T:call-merge-these\] -> summary, body [0-9a-f]{8}$/, 'a mark the store didn\'t report is named by the mark');
  const marked = JSON.parse(JSON.stringify(log));
  marked.find((e) => e.kind === 'compiles' && e.blobs?.s1).blobs.s1 = { participant: 'summary', content: '[[s:M0000beef]] Memory beef, what happened first' };
  const named = renderRecord({ header, log: marked, records: recs, end: { ok: true } }).split('\n').find((l) => l.startsWith('  call '));
  assert.match(named, /^  call - L1\(p\.1\.in-p\.1\.r1\) \[T:call-merge-these\] -> summary, body [0-9a-f]{8}$/, 'a mark the store reported is named as the store names its summary');
});

test('a stored message no compile sends still holds its place, so its neighbours never join across it', () => {
  const b = { u1: text('[[c:q.1.in]] a'), r1: { participant: 'fixture', content: [{ type: 'text', text: '[[c:q.1.r1]] b' }] }, r2: { participant: 'fixture', content: [{ type: 'text', text: '[[c:q.2.r1]] d' }] } };
  const store = { fixture: { messages: [['1', ['[[c:q.1.in]]']], ['2', ['[[c:q.1.r1]]']], ['3', ['[[c:q.2.in]]']], ['4', ['[[c:q.2.r1]]']]] } };
  const lg = [{ kind: 'compiles', step: 'q.2', blobs: b, store, lines: [line(1, [m(1, 'u1'), m(2, 'r1'), m(4, 'r2')])] }];
  const compiles = renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n').filter((x) => x.startsWith('  compile'));
  assert.deepEqual(compiles, ['  compile q.1.in-q.1.r1 q.2.r1']);
});

test('each agent\'s store is its own: lines of another agent than the run\'s first name it, and its summaries are named from its own store', () => {
  const b = { u1: text('[[c:q.1.in]] a'), s1: { participant: 'summary', content: 'first' }, t1: text('[[c:t.1.in]] x'), s2: { participant: 'summary', content: 'second' } };
  const store = {
    fixture: { messages: [['1', ['[[c:q.1.in]]']]], summaries: [{ id: 'L1-0', level: 1, sourceLevel: 0, sources: ['1'], parent: null, content: 's1' }] },
    reader: { messages: [['1', ['[[c:t.1.in]]']]], summaries: [{ id: 'L1-0', level: 1, sourceLevel: 0, sources: ['1'], parent: null, content: 's2' }] },
  };
  const lg = [{ kind: 'compiles', step: 'q.1', blobs: b, store, lines: [
    line(1, [{ sources: ['s:L1-0@1'], content: 's1' }]),
    { ...line(1, [{ sources: ['s:L1-0@1~'], content: 's2' }]), agent: 'reader' },
  ] }];
  const r = renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n');
  assert.ok(r.some((x) => /^  wrote L1\(q\.1\.in\) /.test(x)), 'the first agent\'s summary is named from its own store');
  assert.ok(r.some((x) => /^  wrote \[reader\] L1\(t\.1\.in\) /.test(x)), 'the reader\'s summary is named from the reader\'s store');
  assert.ok(r.includes('  compile L1(q.1.in)'));
  assert.ok(r.includes('  compile [reader] L1(t.1.in)~'), 'a partial summary keeps its mark');
});

test('a receipt that removes a leaf, a failed run, and a batch with no lines each render', () => {
  const lg = [
    { kind: 'compiles', step: 'q.1', blobs: { u1: text('[[c:q.1.in]] a') }, store: { fixture: { messages: [['1', ['[[c:q.1.in]]']]], receiptHead: { sequence: 3, changes: [['1', ['raw:1', 0, 3]], ['7', null]] } } }, lines: [line(1, [m(1, 'u1')])] },
    { kind: 'compiles', step: 'q.2', lost: 'the module stopped before flushing' },
  ];
  const r = renderRecord({ header, log: lg, records: [], end: { ok: false, reason: 'the host exited with code 1 after 1234 ms' } }).split('\n');
  assert.ok(r.includes('receipt fixture #3 changes q.1.in/raw/0/3 #7/removed'));
  assert.ok(r.includes('end failed'), 'a failure\'s text, which varies, stays in the report');
});

test('a sent compile names its head when it changes and its body, and a continuation round gets a line of its own', () => {
  const head = { model: 'm', maxTokens: 100, toolChoice: null, thinking: null, system: [], tools: [], rest: null };
  const req = (id, canaries, digest) => ({ id, kind: 'agent', agent: 'primary', step: 'q.1', stream: true, head, messages: [{ role: 'user', digest, blocks: canaries.map((c) => ({ type: 'text', canaries: [`[[c:${c}]]`] })) }], answer: { shape: 'reply' } });
  const recs = [req('a1', ['q.1.in'], 'd1'), req('a2', ['q.1.in', 'q.1.call1'], 'd2')];
  const lg = [
    { kind: 'compiles', step: 'q.1', blobs: { u1: text('[[c:q.1.in]] a') }, lines: [line(1, [m(1, 'u1')])] },
    { kind: 'request', step: 'q.1', request: { id: 'a1', kind: 'agent' } },
    { kind: 'request', step: 'q.1', request: { id: 'a2', kind: 'agent' } },
  ];
  const r = renderRecord({ header, log: lg, records: recs, end: { ok: true } }).split('\n');
  assert.match(r.find((l) => l.startsWith('  compile')), /^  compile q\.1\.in, head H:[0-9a-f]{8}, body [0-9a-f]{8}$/);
  assert.match(r.find((l) => l.startsWith('  round')), /^  round \+ q\.1\.call1, body [0-9a-f]{8}$/, 'the round carries the call, under the head already named');
  assert.equal(r.filter((l) => l.startsWith('H:')).length, 1);
  const reworded = renderRecord({ header, log: lg, records: [recs[0], { ...recs[1], messages: [{ ...recs[1].messages[0], digest: 'd3' }] }], end: { ok: true } }).split('\n');
  assert.notEqual(reworded.find((l) => l.startsWith('  round')), r.find((l) => l.startsWith('  round')), 'a change to what the round sends moves its line');
});

test('a turn\'s compile comes before its rounds, as the stand-in received them, though the module\'s batch reaches the log after the requests', () => {
  const head = { model: 'm', maxTokens: 100, toolChoice: null, thinking: null, system: [], tools: [], rest: null };
  const req = (id, seq, canaries, digest) => ({ id, seq, kind: 'agent', agent: 'primary', step: 'q.1', stream: true, head, messages: [{ role: 'user', digest, blocks: canaries.map((c) => ({ type: 'text', canaries: [`[[c:${c}]]`] })) }], answer: { shape: 'reply' } });
  const recs = [req('a1', 1, ['q.1.in'], 'd1'), req('a2', 2, ['q.1.in', 'q.1.r1', 'q.1.call1'], 'd2'), req('a3', 3, ['q.1.in', 'q.1.r1', 'q.1.call1', 'q.1.r2', 'q.1.call2'], 'd3')];
  const lg = [
    { kind: 'request', step: 'q.1', request: { id: 'a1', kind: 'agent' } },
    { kind: 'request', step: 'q.1', request: { id: 'a2', kind: 'agent' } },
    { kind: 'request', step: 'q.1', request: { id: 'a3', kind: 'agent' } },
    { kind: 'compiles', step: 'q.1', blobs: { u1: text('[[c:q.1.in]] a') }, lines: [line(1, [m(1, 'u1')])] },
  ];
  const lines = renderRecordLines({ header, log: lg, records: recs, end: { ok: true } });
  const body = lines.filter((l) => l.text.startsWith('  ')).map((l) => l.text.replace(/, (head H:|body ).*$/, ''));
  assert.deepEqual(body, ['  compile q.1.in', '  round + q.1.r1 q.1.call1', '  round + q.1.r2 q.1.call2']);
  const rounds = lines.filter((l) => l.round);
  assert.deepEqual(rounds.map((l) => l.compile?.seq), [1, 1], 'each round belongs to the compile that sent its turn');
});
