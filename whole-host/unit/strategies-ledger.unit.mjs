import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerOf, moduleCounts, readsFailed } from '../lib/strategies/ledger.mjs';

const layout = { memberIds: ['1', '2', '3', '4', '5', '6'], units: [{ k: 'o', n: 1 }, { k: 's', n: 2, sm: [['L1-0', 1, 'llm', 0, 40]] }, { k: 'r', t: 10 }, { k: 'r', t: 10, p: 1 }, { k: 'r', t: 10 }] };
const line = (seq, assembly, outcome = 'compiled', more = {}) => ({ seq, agent: 'fixture', kind: 'request', assembly, outcome, messages: [], violations: [], ...(outcome === 'compiled' ? { layout } : {}), ...more });
const log = [
  { kind: 'compiles', step: 'a', boot: 1, lines: [line(1, 1)], store: { fixture: { messages: [['1', ['[[c:a.in]]']], ['2', ['[[c:a.r1]]']], ['3', ['[[c:b.in]]']], ['5', []]], summaries: [{ id: 'L1-0', level: 1, sourceLevel: 0, sources: ['2', '3'] }], quarantine: { compression: [], merge: [] } } }, blobs: {} },
  { kind: 'compiles', step: 'b', boot: 1, lines: [line(2, 2, 'refused'), line(3, 2), line(4, 3, 'compiled', { kind: 'dry', violations: [{ invariant: 'pins', detail: 'x' }] })], store: { fixture: { quarantine: { compression: ['s1'], merge: [] } }, reader: { messages: [['4', ['[[c:b.r1]]']]] } }, blobs: {} },
];

test('ledgerOf reads context-manager\'s layout of the compile: each view member raw, raw from an incomplete body, under which summaries, or left out, named through its store\'s names, with that store\'s agent where it isn\'t the compiling agent\'s, or by its id where no store holds it', () => {
  assert.deepEqual(ledgerOf(log, log[1].lines[1]), [
    '- raw (2): reader/b.r1, #6',
    '- raw, its body incomplete (1): b.in+1',
    '- in L1(a.r1-b.in) (2): a.r1–b.in (2)',
    '- left out (1): a.in',
  ]);
  assert.deepEqual(ledgerOf(log, { agent: 'fixture' }), ['- no ledger: the compile line carries no layout context-manager gave']);
  assert.deepEqual(ledgerOf(log, { agent: 'fixture', layout: { unreadable: 'no provenance' } }), ['- no ledger: the compile line carries no layout context-manager gave (no provenance)']);
  assert.deepEqual(ledgerOf(log, { agent: 'fixture', layout: { memberIds: ['1'], units: [{ k: 'o', n: 2 }] } }), ['- no ledger: the compile line carries no layout context-manager gave'], 'units that don\'t account for the members exactly');
});

test('moduleCounts: request compile calls made and refused, a refusal whose retry compiled counting as one of each, calls by level, the quarantines entered by kind, the last request compile\'s layout, and lines with a breach', () => {
  const records = [{ kind: 'summariser', level: 1 }, { kind: 'summariser', level: 1 }, { kind: 'summariser', level: 2 }, { kind: 'agent' }];
  assert.deepEqual(moduleCounts(log, records), { compiles: 2, refused: 1, compressions: 2, merges: 1, quarantines: { compression: 1, merge: 0 }, raw: 3, summarised: 2, out: 1, invariantLines: 1 });
  const refusedLast = [...log, { kind: 'compiles', step: 'c', boot: 1, lines: [line(5, 4, 'refused')], blobs: {} }];
  assert.deepEqual([moduleCounts(refusedLast, []).compiles, moduleCounts(refusedLast, []).refused], [2, 2]);
  const bare = moduleCounts([{ kind: 'compiles', lines: [line(1, 1, 'compiled', { layout: undefined })], blobs: {} }], []);
  assert.deepEqual(Object.keys(bare), ['compiles', 'refused', 'compressions', 'merges', 'quarantines', 'invariantLines'], 'what isn\'t known is left out, and the view shows it as ?');
  assert.equal(bare.quarantines, 'not-reported', 'no agent\'s strategy reported a quarantine');
});

test('moduleCounts: requests and quarantines are the run\'s, every agent\'s; raw, summarised and left out are the named agent\'s', () => {
  const sub = { memberIds: ['9'], units: [{ k: 'r', t: 5 }] };
  const two = [
    ...log,
    { kind: 'compiles', step: 'c', boot: 1, lines: [line(6, 7, 'compiled', { agent: 'helper', layout: sub }), line(7, 8, 'refused', { agent: 'helper' })], store: { helper: { quarantine: { compression: [], merge: ['m1', 'm2'] } } }, blobs: {} },
  ];
  const fixture = moduleCounts(two, []);
  assert.deepEqual([fixture.compiles, fixture.refused, fixture.quarantines, fixture.raw], [3, 2, { compression: 1, merge: 2 }, 3]);
  const helper = moduleCounts(two, [], 'helper');
  assert.deepEqual([helper.compiles, helper.refused, helper.quarantines, helper.raw, helper.summarised, helper.out], [3, 2, { compression: 1, merge: 2 }, 1, 0, 0]);
  assert.equal(moduleCounts(two, [], 'nobody').raw, undefined, 'an agent with no compile has no ledger counts');
});

test('moduleCounts: a quarantine entered during the run counts once by its identity, though it clears before the end or comes back', () => {
  const take = (step, compression, merge) => ({ kind: 'compiles', step, boot: 1, lines: [], store: { fixture: { quarantine: { compression, merge } } }, blobs: {} });
  const cleared = [...log, take('c', [], ['m1']), take('d', ['s1'], []), take('e', ['s2'], [])];
  const counts = moduleCounts(cleared, []);
  assert.deepEqual(counts.quarantines, { compression: 2, merge: 1 }, 's1 cleared and came back, and counts once; s2 is new; m1 cleared and still counts');
  const forked = [...log, { kind: 'compiles', step: 'c', boot: 1, lines: [], store: { fork: { quarantine: { compression: ['s1'], merge: [] } } }, blobs: {} }];
  assert.equal(moduleCounts(forked, []).quarantines.compression, 2, 'one identity in two agents\' strategies is each agent\'s');
});

test('moduleCounts: a kind of quarantine any agent couldn\'t read at any take is unknown; the other kind still counts', () => {
  const unread = [...log, { kind: 'compiles', step: 'c', boot: 1, lines: [], store: { helper: { quarantine: { compression: null, merge: ['m1'] } } }, blobs: {} }, { kind: 'compiles', step: 'd', boot: 1, lines: [], store: { helper: { quarantine: { compression: [], merge: ['m1'] } } }, blobs: {} }];
  assert.deepEqual(moduleCounts(unread, []).quarantines, { compression: 'unreadable', merge: 1 }, 'a later read that worked doesn\'t tell what the failed one missed');
  const failed = [...log, { kind: 'compiles', step: 'c', boot: 1, lines: [], store: { helper: { quarantine: { unreadable: 'gone' } } }, blobs: {} }];
  assert.deepEqual(moduleCounts(failed, []).quarantines, { compression: 'unreadable', merge: 'unreadable' });
});

test('readsFailed names each read of the run\'s that failed, once, and nothing for a run whose reads all worked', () => {
  assert.deepEqual(readsFailed(log), []);
  const at = (store, lines = []) => ({ kind: 'compiles', step: 'c', boot: 1, lines, store, blobs: {} });
  const failing = [
    ...log,
    at({ fixture: { messages: { unreadable: 'gone' }, receiptHead: { unreadable: 'no chain' } }, helper: { summaries: { unreadable: 'gone' }, quarantine: { compression: null, merge: [] } } }),
    at({ helper: { messages: { unreadable: 'again' }, quarantine: { unreadable: 'gone' } } }, [line(9, 9, 'unrecordable'), line(10, 10, 'compiled', { violations: [{ invariant: 'unreadable', detail: 'getStrategy: gone' }] })]),
  ];
  assert.deepEqual(readsFailed(failing), ['messages', 'receipt', 'summaries', 'compression quarantines', 'quarantines', 'a compile', 'a compile check\'s inputs']);
  const judgedOnly = [...log, at({}, [line(11, 11, 'compiled', { violations: [{ invariant: 'unplaced', count: 1, detail: 'x' }, { invariant: 'pins', detail: 'y' }] })])];
  assert.deepEqual(readsFailed(judgedOnly), [], 'a breach, or a part store order couldn\'t place, is a judgement, not a failed read');
  assert.deepEqual(readsFailed([...log, at({ fixture: { quarantine: null } })]), [], 'a strategy that stopped reporting quarantines');
});

test('readsFailed names a health panel read that failed, and an agent\'s context composition the host reports it couldn\'t read, whatever the checks made of the panel', () => {
  const panel = (kind, health, extra = {}) => ({ kind, name: kind === 'health' ? 'end' : 's1', health, ...extra });
  const composition = { fixture: { head: { messages: 4 }, tail: { messages: 6 } } };
  assert.deepEqual(readsFailed([...log, panel('checkpoint', { ok: true, data: { contextComposition: composition } }), panel('health', { ok: true, data: { contextComposition: composition, readFailures: { fixture: { runtimeSettings: 'boom' } } } })]), [], 'reads that worked, and a failure in a section the harness doesn\'t read');
  assert.deepEqual(readsFailed([...log, panel('health', { ok: false, error: 'no panel' })]), ['the health panel']);
  assert.deepEqual(readsFailed([...log, panel('checkpoint', { ok: true, data: { contextComposition: composition, readFailures: { sub: { contextComposition: 'boom' } } } })]), ['the health panel\'s context composition'], 'any agent\'s');
  assert.deepEqual(readsFailed([...log, panel('health', undefined, { skipped: 'the run\'s last step stopped its host' })]), [], 'a read the run skipped');
});

test('readsFailed names a module read the driver made that failed, by what it read: the store\'s summary level, or its messages', () => {
  const read = (op, answer) => ({ kind: 'read', step: 'e', op, answer });
  assert.deepEqual(readsFailed([...log, read('state', { maxLevel: 3 }), read('messages', []), read('dry', { seq: null })]), [], 'reads that worked');
  assert.deepEqual(readsFailed([...log, read('state', { maxLevel: { unreadable: 'gone' } })]), ['the store\'s summary level']);
  assert.deepEqual(readsFailed([...log, read('messages', { unreadable: 'gone' })]), ['messages']);
});

test('moduleCounts and readsFailed: a kind of quarantine whose own read failed is unknown and named, and the other kind still counts', () => {
  const at = [...log, { kind: 'compiles', step: 'c', boot: 1, lines: [], store: { helper: { quarantine: { compression: { unreadable: 'a compression quarantine span has no chunkSourceHash' }, merge: ['m1'] } } }, blobs: {} }];
  assert.deepEqual(moduleCounts(at, []).quarantines, { compression: 'unreadable', merge: 1 });
  assert.deepEqual(readsFailed(at), ['compression quarantines']);
});

test('ledgerOf names a message by its own agent\'s store first, so a fork\'s edited copy under the same id doesn\'t rename the resident\'s', () => {
  const one = { memberIds: ['1'], units: [{ k: 'r', t: 1 }] };
  const resident = { agent: 'fixture', layout: one }, forked = { agent: 'fork', layout: one };
  const branches = [
    { kind: 'compiles', step: 'a', lines: [resident, forked], store: { fixture: { messages: [['1', ['[[c:a.in]]']]] }, fork: { messages: [['1', ['[[c:b.in]]']]] } }, blobs: {} },
  ];
  assert.deepEqual(ledgerOf(branches, resident)[0], '- raw (1): a.in');
  assert.deepEqual(ledgerOf(branches, forked)[0], '- raw (1): b.in');
});

test('ledgerOf names an own message with no canary by its place, and another slot\'s member, with its agent, by the agents the compile read it from before any other', () => {
  const layout = (ids) => ({ memberIds: ids, units: ids.map(() => ({ k: 'r', t: 1 })) });
  const own = { agent: 'fixture', layout: layout(['1']) };
  const reader = { agent: 'reader', slots: ['fixture'], layout: layout(['9']) };
  const unslotted = { agent: 'reader', layout: layout(['9']) };
  const stores = [{ kind: 'compiles', step: 'a', lines: [own, reader, unslotted], store: { fork: { messages: [['1', ['[[c:fork.in]]']], ['9', ['[[c:fork.chat]]']]] }, fixture: { messages: [['1', []], ['9', ['[[c:a.chat]]']]] }, reader: { messages: [] } }, blobs: {} }];
  assert.deepEqual(ledgerOf(stores, own)[0], '- raw (1): start+1');
  assert.deepEqual(ledgerOf(stores, reader)[0], '- raw (1): fixture/a.chat', 'the slot the compile read, though another store came first');
  assert.deepEqual(ledgerOf(stores, unslotted)[0], '- raw (1): fork/fork.chat', 'with no slots named, the first store that holds it');
});

test('ledgerOf names a compile\'s members as the store stood at its batch: a later edit or removal doesn\'t rename them, and a line from no batch names none', () => {
  const layout = { memberIds: ['9'], units: [{ k: 'r', t: 1 }] };
  const early = { agent: 'fixture', layout }, later = { agent: 'fixture', layout }, last = { agent: 'fixture', layout };
  const log = [
    { kind: 'compiles', step: 'a', lines: [early], store: { fixture: { messages: [['9', ['[[c:a.in]]']]] } }, blobs: {} },
    { kind: 'compiles', step: 'b', lines: [later], store: { fixture: { messages: [['9', ['[[c:b.in]]']]] } }, blobs: {} },
    { kind: 'compiles', step: 'c', lines: [last], store: { fixture: { messages: [['9', []]] } }, blobs: {} },
  ];
  assert.deepEqual([early, later, last].map((l) => ledgerOf(log, l)[0]), ['- raw (1): a.in', '- raw (1): b.in', '- raw (1): start+1']);
  assert.deepEqual(ledgerOf(log, { agent: 'fixture', layout })[0], '- raw (1): #9');
});

test('ledgerOf names a summary by its level and its first and last covered message, and stops naming by a message its store removed', () => {
  const layout = { memberIds: ['1', '3', '4'], units: [{ k: 's', n: 2, sm: [['L2-9', 2, 'llm', 0, 40]] }, { k: 'r', t: 1 }] };
  const before = { agent: 'fixture', layout }, after = { agent: 'fixture', layout };
  const log = [
    { kind: 'compiles', step: 'a', lines: [before], store: { fixture: { messages: [['1', ['[[c:a.in]]']], ['2', ['[[c:b.in]]']], ['3', []], ['4', []]], summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sources: ['1', '3'] }, { id: 'L2-9', level: 2, sourceLevel: 1, sources: ['L1-1'] }] } }, blobs: {} },
    { kind: 'compiles', step: 'b', lines: [after], store: { fixture: { removedMessages: ['2'] } }, blobs: {} },
  ];
  assert.deepEqual(ledgerOf(log, before), ['- raw (1): b.in+2', '- in L2(a.in-b.in+1) (2): a.in–b.in+1 (2)', '- left out (0): none']);
  assert.deepEqual(ledgerOf(log, after), ['- raw (1): a.in+2', '- in L2(a.in-a.in+1) (2): a.in–a.in+1 (2)', '- left out (0): none'], 'the removed message no longer anchors the names after it');
  assert.equal(ledgerOf([{ kind: 'compiles', lines: [before], blobs: {} }], before)[1], '- in L2(-) (2): #1–#3 (2)', 'a summary no store holds');
});

test('ledgerOf takes a restart\'s whole listing as its store: a message it lacks no longer anchors names', () => {
  const layout = { memberIds: ['3'], units: [{ k: 'r', t: 1 }] };
  const before = { agent: 'fixture', layout }, after = { agent: 'fixture', layout };
  const log = [
    { kind: 'compiles', step: 'a', boot: 1, lines: [before], store: { fixture: { whole: true, messages: [['1', ['[[c:a.in]]']], ['2', ['[[c:b.in]]']], ['3', []]], summaries: [] } }, blobs: {} },
    { kind: 'compiles', step: 'b', at: 'boot', boot: 2, lines: [after], store: { fixture: { whole: true, messages: [['1', ['[[c:a.in]]']], ['3', []]], summaries: [] } }, blobs: {} },
  ];
  assert.deepEqual(ledgerOf(log, before)[0], '- raw (1): b.in+1');
  assert.deepEqual(ledgerOf(log, after)[0], '- raw (1): a.in+1', 'the restart\'s listing lacks message 2, so message 3 follows a.in');
});

test('ledgerOf names a restored message in its place in the store, not after the messages that follow it, and a summary over it by its ends in store order', () => {
  const layout = { memberIds: ['3'], units: [{ k: 'r', t: 1 }] };
  const line = { agent: 'fixture', layout };
  const log = [
    { kind: 'compiles', step: 'a', lines: [], store: { fixture: { messages: [['1', ['[[c:a.in]]']], ['2', ['[[c:b.in]]']], ['3', []]], summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sources: ['3', '2'] }] } }, blobs: {} },
    { kind: 'compiles', step: 'b', lines: [], store: { fixture: { removedMessages: ['2'] } }, blobs: {} },
    { kind: 'compiles', step: 'c', lines: [line], store: { fixture: { messages: [['2', ['[[c:b.in]]']]] } }, blobs: {} },
  ];
  assert.equal(ledgerOf(log, line)[0], '- raw (1): b.in+1');
  const summarised = { agent: 'fixture', layout: { memberIds: ['2', '3'], units: [{ k: 's', n: 2, sm: [['L1-1', 1, 'llm', 0, 40]] }] } };
  assert.match(ledgerOf([...log.slice(0, 2), { ...log[2], lines: [summarised] }], summarised).find((l) => l.startsWith('- in ')) ?? '', /^- in L1\(b\.in-b\.in\+1\) /);
});
