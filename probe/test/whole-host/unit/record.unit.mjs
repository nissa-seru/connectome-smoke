// The committed record's writer (lib/record.mjs), from a made-up log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRecord } from '../lib/record.mjs';

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
  // The call's body hash is pinned by its own test below; here it's only its form.
  const body = r.slice(r.indexOf('step p.name'), r.indexOf('templates')).map((l) => l.replace(/, body [0-9a-f]{8}$/, ', body HASH'));
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
    'totals {"actions":1,"calls":1,"compiles":5,"dry":0,"other":0,"refused":1,"written":1}',
  ]);
  const templates = r.slice(r.indexOf('templates') + 1).filter(Boolean);
  assert.ok(templates.includes('T:user-clock-#-#-utc = Clock: #:# UTC'), 'numbers written as #, their values on the line');
  assert.ok(templates.includes('T:user-ref-img-na-#-then = ref img_na_# then ref img_nb_#'), 'each nonce named by the order it first appears');
  assert.ok(templates.includes('T:summary-l1-bda55950 = what happened first'));
});

test('two runs whose image nonces differ write the same record', () => {
  const other = JSON.parse(JSON.stringify(log).replaceAll('k7x3q2', 'a1b2c3').replaceAll('zz9yy8', 'q0q0q0'));
  assert.equal(renderRecord({ header, log: other, records, end: { ok: true } }), renderRecord({ header, log, records, end: { ok: true } }));
});

test('a summariser call shows its own words as templates, and its body hash moves when anything else it sends does', () => {
  const asked = (texts, digest = 'd1', more = {}) => [{ id: 'r9', kind: 'summariser', step: 'p.2', model: 'm', maxTokens: 16000, system: { sha256: 'e3', chars: 0 }, tools: ['t'], texts,
    messages: [{ role: 'user', digest, blocks: [{ canaries: ['[[c:p.1.in]]'] }, { canaries: ['[[c:p.1.r1]]'] }, {}] }], answer: { shape: 'summary' }, ...more }];
  const recordOf = (recs) => renderRecord({ header, log, records: recs, end: { ok: true } });
  const callOf = (recs) => recordOf(recs).split('\n').find((l) => l.startsWith('  call '));
  const plain = callOf(asked(['Summarise in about 400 tokens, phase: research.']));
  assert.match(plain, /^  call p\.1\.in p\.1\.r1 \[T:call-summarise-in-about\]\(400\) -> summary, body [0-9a-f]{8}$/);
  const reworded = recordOf(asked(['Summarise in about 400 tokens, phase: .']));
  assert.notEqual(reworded, recordOf(asked(['Summarise in about 400 tokens, phase: research.'])), 'a change to its words');
  assert.ok(reworded.split('\n').includes('T:call-summarise-in-about = Summarise in about # tokens, phase: .'), 'and the words show in its template');
  assert.notEqual(callOf(asked(['Summarise in about 400 tokens, phase: research.'], 'd2')), plain, 'a change to a carried message\'s content');
  assert.notEqual(callOf(asked(['Summarise in about 400 tokens, phase: research.'], 'd1', { maxTokens: 8000 })), plain, 'a change to its limits');
  assert.equal(callOf(asked(['Summarise in about 400 tokens, phase: research.'])), plain, 'the same request, the same line');
});

test('a summary a summariser call carries is named as the store names it, not written out again', () => {
  const recs = [{ id: 'r9', kind: 'summariser', step: 'p.2', texts: ['a: [[s:M0000beef]] Memory beef, what happened first', 'Merge these.'],
    messages: [{ role: 'user', digest: 'd1', blocks: [{}, {}] }], answer: { shape: 'summary' } }];
  const line = renderRecord({ header, log, records: recs, end: { ok: true } }).split('\n').find((l) => l.startsWith('  call '));
  assert.match(line, /^  call - S\(M0000beef\) \[T:call-merge-these\] -> summary, body [0-9a-f]{8}$/, 'a mark the store didn\'t report is named by the mark');
});
