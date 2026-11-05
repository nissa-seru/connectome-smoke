import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { differencesOf, entriesOf } from '../lib/entries.mjs';

const record = ({ templates = [], heads = [], steps = {}, tail = ['end ok'] }) => `${[
  '# whole-host record H1/W1, from empty',
  'templates', ...templates,
  'heads', ...heads,
  ...Object.entries(steps).flatMap(([step, lines]) => [`step ${step}`, ...lines.map((l) => `  ${l}`)]),
  ...tail,
].join('\n')}\n`;

test('a changed line is one difference, at its run and step, with both whole lines as its example', () => {
  const base = record({ steps: { 'p.1': ['compile p.1.in, body 11111111', 'round + p.1.r1, body 22222222'] } });
  const head = record({ steps: { 'p.1': ['compile p.1.in L1(p.0), body 33333333', 'round + p.1.r1, body 22222222'] } });
  const [d, ...rest] = differencesOf('H1/W1', base, head);
  assert.equal(rest.length, 0);
  assert.deepEqual(d.place, { run: 'H1/W1', step: 'p.1' });
  assert.equal(d.describe, '`compile` lines whose `H p.C,` became `H L#(p.#), p.C`', 'its tokens masked, canaries named C, and sorted, as entries.py gives them');
  assert.equal(d.before, 'compile p.1.in, body 11111111');
  assert.equal(d.after, 'compile p.1.in L1(p.0), body 33333333');
});

test('lines a step gained or lost are differences of their own, and a step only one arm ran is one difference', () => {
  const base = record({ steps: { 'p.1': ['compile p.1.in, body 11111111', 'call p.1 [T:call-merge-aaaaaaaaaaaa] -> refused, body 44444444'], 'p.2': ['compile p.2.in, body 55555555'] } });
  const head = record({ steps: { 'p.1': ['compile p.1.in, body 11111111', 'round + p.1.r1, body 22222222'] } });
  const ds = differencesOf('H1/W1', base, head);
  assert.deepEqual(ds.map((d) => [d.describe, d.place.step, d.before, d.after]), [
    ['`call` lines only in base', 'p.1', 'call p.1 [T:call-merge-aaaaaaaaaaaa] -> refused, body 44444444', ''],
    ['`round` lines only in head', 'p.1', '', 'round + p.1.r1, body 22222222'],
    ['a step only one arm ran', 'p.2', 'compile p.2.in, body 55555555', ''],
  ]);
});

test('a template\'s text that changed is never paired across the arms: each side is in one arm only, filled from that side\'s first use, and one whose numbers don\'t fit is left as written', () => {
  const base = record({ templates: ['T:user-clock-tuesday-#-#-#-aaaaaaaaaaaa = Clock: Tuesday #-#-#, #:# UTC'], steps: { 'p.1': ['compile [T:user-clock-tuesday-#-#-#-aaaaaaaaaaaa](2026,1,6,9,0) p.1.in, body 11111111'] } });
  const head = record({ templates: ['T:user-clock-tuesday-#-#-#-bbbbbbbbbbbb = Clock: Tuesday #-#-# at #:# UTC'], steps: { 'p.1': ['compile [T:user-clock-tuesday-#-#-#-bbbbbbbbbbbb](2026,1,6,9,0) p.1.in, body 11111111'] } });
  const ts = differencesOf('H1/W1', base, head).filter((d) => d.place.step === 'templates');
  assert.deepEqual(ts.map((d) => [d.describe, d.before, d.after]), [
    ['templates T:user-clock-tuesday-#-#-#: text only in base', 'T:user-clock-tuesday-#-#-#-aaaaaaaaaaaa = Clock: Tuesday 2026-1-6, 9:0 UTC', ''],
    ['templates T:user-clock-tuesday-#-#-#: text only in head', '', 'T:user-clock-tuesday-#-#-#-bbbbbbbbbbbb = Clock: Tuesday 2026-1-6 at 9:0 UTC'],
  ], 'two texts of one role may be two different texts, so the grouping never says one became the other');
  const short = differencesOf('H1/W1', base.replace('(2026,1,6,9,0)', '(2026,1)'), head).find((d) => d.place.step === 'templates');
  assert.equal(short.before, 'T:user-clock-tuesday-#-#-#-aaaaaaaaaaaa = Clock: Tuesday #-#-#, #:# UTC', 'two numbers for five #s fill nothing');
});

test('a role that names a memory by its id is one kind whatever the id, and an entry names its role masked', () => {
  const fork = (id) => record({ templates: [`T:fork-#-d#-#-s-m${id}-memory-${id}-${'a'.repeat(12)} = Fork`] });
  const none = record({});
  const ds = [...differencesOf('H1/W1', fork('#add#'), none), ...differencesOf('H1/W2', fork('f#d#e'), none), ...differencesOf('H1/W5', fork('b#'), none)];
  const entries = entriesOf(ds);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].describe, 'templates T:fork-#-H-#-s-mH-memory-H: text only in base');
  assert.equal(entries[0].count, 3);
  const levels = entriesOf(['1', '2'].map((l) => differencesOf('H1/W1', record({ templates: [`T:summary-l${l}-${'b'.repeat(12)} = s`] }), none)).flat());
  assert.deepEqual(levels.map((e) => [e.describe, e.count]), [['templates T:summary-l#: text only in base', 2]], 'an entry grouping two levels names neither as if it were both');
});

test('a checkpoint line is placed at its own step', () => {
  const base = `${['# whole-host record H1/W1, from empty', 'templates', 'heads', 'step p.3', '  compile p.3.in, body 11111111', 'step p.end', 'checkpoint prefix', 'end ok'].join('\n')}\n`;
  const head = `${['# whole-host record H1/W1, from empty', 'templates', 'heads', 'step p.3', '  compile p.3.in, body 11111111', 'end ok'].join('\n')}\n`;
  assert.deepEqual(differencesOf('H1/W1', base, head).map((d) => [d.place.step, d.describe]), [['p.end', 'a step only one arm ran']]);
  const both = (name) => `${['# h', 'templates', 'heads', 'step p.3', '  compile p.3.in, body 11111111', 'checkpoint ' + name, 'end ok'].join('\n')}\n`;
  assert.deepEqual(differencesOf('H1/W1', both('prefix'), both('other')).map((d) => [d.place.step, d.describe]), [['p.3', '`checkpoint` lines whose `prefix` became `other`']]);
});

test('one kind of difference is one entry, its id the sha256 of its signature, with every place and an example at each run\'s first place', () => {
  const base = (n) => record({ steps: { [`p.${n}`]: [`compile p.${n}.in, body 1111111${n}`] } });
  const head = (n) => record({ steps: { [`p.${n}`]: [`compile p.${n}.in L1(p.0), body 3333333${n}`] } });
  const entries = entriesOf([...differencesOf('H1/W1', base(1), head(1)), ...differencesOf('H1/W2', base(2), head(2)), ...differencesOf('H1/W2', base(3), head(3))]);
  assert.equal(entries.length, 1);
  const [e] = entries;
  assert.match(e.id, /^[0-9a-f]{12}$/);
  assert.equal(e.id, createHash('sha256').update(JSON.stringify(['line', 'compile', 'changed', 'H p.C,', 'H L#(p.#), p.C'])).digest('hex').slice(0, 12));
  assert.equal(e.count, 3);
  assert.deepEqual(e.runs, ['H1/W1', 'H1/W2']);
  assert.deepEqual(e.places.map(({ run, step }) => ({ run, step })), [{ run: 'H1/W1', step: 'p.1' }, { run: 'H1/W2', step: 'p.2' }, { run: 'H1/W2', step: 'p.3' }]);
  assert.deepEqual(e.examples, [
    { run: 'H1/W1', step: 'p.1', before: 'compile p.1.in, body 11111111', after: 'compile p.1.in L1(p.0), body 33333331' },
    { run: 'H1/W2', step: 'p.2', before: 'compile p.2.in, body 11111112', after: 'compile p.2.in L1(p.0), body 33333332' },
  ], 'one per run, at its first place: H1/W2\'s second place, p.3, gives none');
  assert.deepEqual(Object.keys(e), ['id', 'describe', 'count', 'runs', 'places', 'examples']);
});

test('each place carries the first 12 hex of the sha256 of its two sides, filled, so a difference past the example\'s place shows, and shares that split the runs give the same places', () => {
  const base = (n) => record({ steps: { [`p.${n}`]: [`compile p.${n}.in, body 1111111${n}`] } });
  const head = (n, x = '3') => record({ steps: { [`p.${n}`]: [`compile p.${n}.in L1(p.0), body ${x.repeat(7)}${n}`] } });
  const differences = (x) => [...differencesOf('H1/W1', base(1), head(1)), ...differencesOf('H1/W2', base(2), head(2, x))];
  const digest = (before, after) => createHash('sha256').update(JSON.stringify([before, after])).digest('hex').slice(0, 12);
  const [e] = entriesOf(differences('3'));
  assert.deepEqual(e.places, [
    { run: 'H1/W1', step: 'p.1', digest: digest('compile p.1.in, body 11111111', 'compile p.1.in L1(p.0), body 33333331') },
    { run: 'H1/W2', step: 'p.2', digest: digest('compile p.2.in, body 11111112', 'compile p.2.in L1(p.0), body 33333332') },
  ]);
  const [other] = entriesOf(differences('4'));
  assert.equal(other.id, e.id, 'one kind of difference');
  assert.deepEqual(other.examples[0], e.examples[0], 'with the same first place');
  assert.notDeepEqual(other.places, e.places, 'and a later place\'s text shows in its digest');
  const shares = [...entriesOf(differencesOf('H1/W1', base(1), head(1)))[0].places, ...entriesOf(differencesOf('H1/W2', base(2), head(2)))[0].places];
  assert.deepEqual(shares, e.places, 'shares that split the runs give the same places');
});

test('every differing line of a record lands in exactly one entry', () => {
  const base = record({ heads: ['H:aaaaaaaa = model m, max_tokens 100'], steps: { 'p.1': ['compile p.1.in, body 11111111', 'compile p.1.r1, body 22222222', 'call p.1 -> summary, body 33333333'] }, tail: ['end ok', 'totals {"compiles":2}'] });
  const head = record({ heads: ['H:bbbbbbbb = model m, max_tokens 200'], steps: { 'p.1': ['compile p.1.in L1(p.0), body 44444444', 'compile p.1.r1 L1(p.0), body 55555555', 'round + p.1.r2, body 66666666'] }, tail: ['end ok', 'totals {"compiles":3}'] });
  const ds = differencesOf('H1/W1', base, head);
  const entries = entriesOf(ds);
  assert.equal(entries.reduce((n, e) => n + e.count, 0), ds.length);
  assert.deepEqual(ds.map((d) => [d.place.step, d.describe]), [
    ['heads', 'heads H:H: text only in base'],
    ['heads', 'heads H:H: text only in head'],
    ['p.1', '`compile` lines whose `H p.C,` became `H L#(p.#), p.C`'],
    ['p.1', '`compile` lines whose `H p.C,` became `H L#(p.#), p.C`'],
    ['p.1', '`call` lines only in base'],
    ['p.1', '`round` lines only in head'],
    ['end', '`totals` lines whose `{"compiles":#}` became `{"compiles":#}`'],
  ], 'as entries.py gives these records, but for the heads\' masked role');
  assert.equal(entries.find((e) => e.describe.startsWith('`compile`')).count, 2, 'the two compiles changed the same way');
});

test('records that are the same have no differences', () => {
  const r = record({ steps: { 'p.1': ['compile p.1.in, body 11111111'] } });
  assert.deepEqual(differencesOf('H1/W1', r, r), []);
  assert.deepEqual(entriesOf([]), []);
});

test('two records that differ where no kind of difference is found throw, so a run is never said to differ with nothing to show', () => {
  const base = record({ templates: ['T:a-111111111111 = A text', 'T:b-222222222222 = B text'], heads: ['H:11111111 = head one'], steps: { 'p.1': ['compile p.1.in, body 11111111'], 'p.2': ['compile p.2.in, body 22222222'] } });
  const unplaced = {
    'a trailing newline': base.slice(0, -1),
    'step order': base.replace('step p.1\n  compile p.1.in, body 11111111\nstep p.2\n  compile p.2.in, body 22222222\n', 'step p.2\n  compile p.2.in, body 22222222\nstep p.1\n  compile p.1.in, body 11111111\n'),
    'template order': base.replace('T:a-111111111111 = A text\nT:b-222222222222 = B text\n', 'T:b-222222222222 = B text\nT:a-111111111111 = A text\n'),
    'a head whose key is the same and whose text isn\'t': base.replace('H:11111111 = head one', 'H:11111111 = head one, changed'),
    'a step written twice': base.replace('step p.2\n  compile p.2.in, body 22222222\n', 'step p.2\n  compile p.2.in, body 99999999\nstep p.2\n  compile p.2.in, body 22222222\n'),
  };
  for (const [what, head] of Object.entries(unplaced)) assert.throws(() => differencesOf('H1/W1', base, head), /the records differ, but no difference between them was found/, what);
  assert.deepEqual(differencesOf('H1/W1', base, base), [], 'the same record has no differences, and that\'s no error');
  assert.equal(differencesOf('H1/W1', base, base.replace('body 22222222', 'body 33333333')).length, 1);
});
