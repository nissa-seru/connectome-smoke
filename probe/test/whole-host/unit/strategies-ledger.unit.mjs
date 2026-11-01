import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerOf, moduleCounts } from '../lib/strategies/ledger.mjs';

const ledger = { raw: [['1', '2', 2]], summaries: [['L1-0', 1, [['3', '3', 1]]]], out: [['4', '4', 1]], counts: { raw: 2, summarised: 1, out: 1 } };
const line = (seq, assembly, outcome = 'compiled', more = {}) => ({ seq, agent: 'fixture', kind: 'request', assembly, outcome, messages: [], violations: [], ...(outcome === 'compiled' ? { ledger } : {}), ...more });
const log = [
  { kind: 'compiles', step: 'a', boot: 1, lines: [line(1, 1)], store: { fixture: { messages: [['1', ['[[c:a.in]]']], ['2', ['[[c:a.r1]]']], ['3', ['[[c:b.in]]']], ['4', []]], quarantine: { compression: 0, merge: 0 } } }, blobs: {} },
  { kind: 'compiles', step: 'b', boot: 1, lines: [line(2, 2, 'refused'), line(3, 2), line(4, 3, 'compiled', { kind: 'dry', violations: [{ invariant: 'pins', detail: 'x' }] })], store: { fixture: { quarantine: { compression: 1, merge: 0 } } }, blobs: {} },
];

test('ledgerOf gives a compile line\'s ledger as lines, each message named by its canary, one with none by its id', () => {
  assert.deepEqual(ledgerOf(log, line(1, 1)), ['- raw (2): [[c:a.in]]–[[c:a.r1]] (2)', '- in L1-0 (L1) (1): [[c:b.in]]', '- left out (1): #4']);
  assert.deepEqual(ledgerOf(log, { agent: 'fixture' }), ['- no ledger: the compile line carries none']);
  assert.deepEqual(ledgerOf(log, { agent: 'fixture', ledger: { unreadable: 'gone' } }), ['- no ledger: the store couldn\'t be read (gone)']);
});

test('moduleCounts: compiles sent and refused by assembly, calls by level, the last quarantine, the last sent compile\'s ledger, and lines with a breach', () => {
  const records = [{ kind: 'summariser', level: 1 }, { kind: 'summariser', level: 1 }, { kind: 'summariser', level: 2 }, { kind: 'agent' }];
  assert.deepEqual(moduleCounts(log, records), { compiles: 2, refused: 0, compressions: 2, merges: 1, quarantines: 1, raw: 2, summarised: 1, out: 1, invariantLines: 1 });
  const refusedLast = [...log, { kind: 'compiles', step: 'c', boot: 1, lines: [line(5, 4, 'refused')], blobs: {} }];
  assert.deepEqual([moduleCounts(refusedLast, []).compiles, moduleCounts(refusedLast, []).refused], [2, 1]);
  const bare = moduleCounts([{ kind: 'compiles', lines: [line(1, 1, 'compiled', { ledger: undefined })], blobs: {} }], []);
  assert.deepEqual(Object.keys(bare), ['compiles', 'refused', 'compressions', 'merges', 'invariantLines'], 'what isn\'t known is left out, and the view shows it as ?');
});

test('moduleCounts: requests and quarantines are the run\'s, every agent\'s; raw, summarised and left out are the named agent\'s', () => {
  const sub = { raw: [['9', '9', 1]], summaries: [], out: [], counts: { raw: 1, summarised: 0, out: 0 } };
  const two = [
    ...log,
    { kind: 'compiles', step: 'c', boot: 1, lines: [line(6, 7, 'compiled', { agent: 'helper', ledger: sub }), line(7, 8, 'refused', { agent: 'helper' })], store: { helper: { quarantine: { compression: 0, merge: 2 } } }, blobs: {} },
  ];
  const fixture = moduleCounts(two, []);
  assert.deepEqual([fixture.compiles, fixture.refused, fixture.quarantines, fixture.raw], [3, 1, 3, 2]);
  const helper = moduleCounts(two, [], 'helper');
  assert.deepEqual([helper.compiles, helper.refused, helper.quarantines, helper.raw, helper.summarised, helper.out], [3, 1, 3, 1, 0, 0]);
  assert.equal(moduleCounts(two, [], 'nobody').raw, undefined, 'an agent with no compile has no ledger counts');
});
