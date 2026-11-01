import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerOf, moduleCounts } from '../lib/strategies/ledger.mjs';

const layout = { memberIds: ['1', '2', '3', '4', '5', '6'], units: [{ k: 'o', n: 1 }, { k: 's', n: 2, sm: [['L1-0', 1, 'llm', 0, 40]] }, { k: 'r', t: 10 }, { k: 'r', t: 10, p: 1 }, { k: 'r', t: 10 }] };
const line = (seq, assembly, outcome = 'compiled', more = {}) => ({ seq, agent: 'fixture', kind: 'request', assembly, outcome, messages: [], violations: [], ...(outcome === 'compiled' ? { layout } : {}), ...more });
const log = [
  { kind: 'compiles', step: 'a', boot: 1, lines: [line(1, 1)], store: { fixture: { messages: [['1', ['[[c:a.in]]']], ['2', ['[[c:a.r1]]']], ['3', ['[[c:b.in]]']], ['5', []]], quarantine: { compression: 0, merge: 0 } } }, blobs: {} },
  { kind: 'compiles', step: 'b', boot: 1, lines: [line(2, 2, 'refused'), line(3, 2), line(4, 3, 'compiled', { kind: 'dry', violations: [{ invariant: 'pins', detail: 'x' }] })], store: { fixture: { quarantine: { compression: 1, merge: 0 } }, reader: { messages: [['4', ['[[c:b.r1]]']]] } }, blobs: {} },
];

test('ledgerOf reads context-manager\'s layout of the compile: each view member raw, raw from an incomplete body, under which summaries, or left out, named by its canary from any agent\'s store, or by its id', () => {
  assert.deepEqual(ledgerOf(log, line(1, 1)), [
    '- raw (2): [[c:b.r1]], #6',
    '- raw, its body incomplete (1): #5',
    '- in L1-0 (L1) (2): [[c:a.r1]]–[[c:b.in]] (2)',
    '- left out (1): [[c:a.in]]',
  ]);
  assert.deepEqual(ledgerOf(log, { agent: 'fixture' }), ['- no ledger: the compile line carries no layout context-manager gave']);
  assert.deepEqual(ledgerOf(log, { agent: 'fixture', layout: { unreadable: 'no provenance' } }), ['- no ledger: the compile line carries no layout context-manager gave (no provenance)']);
  assert.deepEqual(ledgerOf(log, { agent: 'fixture', layout: { memberIds: ['1'], units: [{ k: 'o', n: 2 }] } }), ['- no ledger: the compile line carries no layout context-manager gave'], 'units that don\'t account for the members exactly');
});

test('moduleCounts: request compiles made and refused by assembly, calls by level, the last quarantine, the last request compile\'s layout, and lines with a breach', () => {
  const records = [{ kind: 'summariser', level: 1 }, { kind: 'summariser', level: 1 }, { kind: 'summariser', level: 2 }, { kind: 'agent' }];
  assert.deepEqual(moduleCounts(log, records), { compiles: 2, refused: 0, compressions: 2, merges: 1, quarantines: 1, raw: 3, summarised: 2, out: 1, invariantLines: 1 });
  const refusedLast = [...log, { kind: 'compiles', step: 'c', boot: 1, lines: [line(5, 4, 'refused')], blobs: {} }];
  assert.deepEqual([moduleCounts(refusedLast, []).compiles, moduleCounts(refusedLast, []).refused], [2, 1]);
  const bare = moduleCounts([{ kind: 'compiles', lines: [line(1, 1, 'compiled', { layout: undefined })], blobs: {} }], []);
  assert.deepEqual(Object.keys(bare), ['compiles', 'refused', 'compressions', 'merges', 'invariantLines'], 'what isn\'t known is left out, and the view shows it as ?');
});

test('moduleCounts: requests and quarantines are the run\'s, every agent\'s; raw, summarised and left out are the named agent\'s', () => {
  const sub = { memberIds: ['9'], units: [{ k: 'r', t: 5 }] };
  const two = [
    ...log,
    { kind: 'compiles', step: 'c', boot: 1, lines: [line(6, 7, 'compiled', { agent: 'helper', layout: sub }), line(7, 8, 'refused', { agent: 'helper' })], store: { helper: { quarantine: { compression: 0, merge: 2 } } }, blobs: {} },
  ];
  const fixture = moduleCounts(two, []);
  assert.deepEqual([fixture.compiles, fixture.refused, fixture.quarantines, fixture.raw], [3, 1, 3, 3]);
  const helper = moduleCounts(two, [], 'helper');
  assert.deepEqual([helper.compiles, helper.refused, helper.quarantines, helper.raw, helper.summarised, helper.out], [3, 1, 3, 1, 0, 0]);
  assert.equal(moduleCounts(two, [], 'nobody').raw, undefined, 'an agent with no compile has no ledger counts');
});

test('moduleCounts: a quarantine any agent couldn\'t read leaves the run\'s quarantines unknown', () => {
  const unread = [...log, { kind: 'compiles', step: 'c', boot: 1, lines: [], store: { helper: { quarantine: { compression: null, merge: 2 } } }, blobs: {} }];
  assert.equal(moduleCounts(unread, []).quarantines, undefined);
  const failed = [...log, { kind: 'compiles', step: 'c', boot: 1, lines: [], store: { helper: { quarantine: { unreadable: 'gone' } } }, blobs: {} }];
  assert.equal(moduleCounts(failed, []).quarantines, undefined);
});

test('ledgerOf names a message by its own agent\'s store first, so a fork\'s edited copy under the same id doesn\'t rename the resident\'s', () => {
  const branches = [
    { kind: 'compiles', step: 'a', lines: [], store: { fixture: { messages: [['1', ['[[c:a.in]]']]] }, fork: { messages: [['1', ['[[c:b.in]]']]] } }, blobs: {} },
  ];
  const one = { memberIds: ['1'], units: [{ k: 'r', t: 1 }] };
  assert.deepEqual(ledgerOf(branches, { agent: 'fixture', layout: one })[0], '- raw (1): [[c:a.in]]');
  assert.deepEqual(ledgerOf(branches, { agent: 'fork', layout: one })[0], '- raw (1): [[c:b.in]]');
});
