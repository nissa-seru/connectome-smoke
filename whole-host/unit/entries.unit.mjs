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

test('a template\'s text that changed is filled from each side\'s first use of it, and one whose numbers don\'t fit is left as written', () => {
  const base = record({ templates: ['T:user-clock-tuesday-#-#-#-aaaaaaaaaaaa = Clock: Tuesday #-#-#, #:# UTC'], steps: { 'p.1': ['compile [T:user-clock-tuesday-#-#-#-aaaaaaaaaaaa](2026,1,6,9,0) p.1.in, body 11111111'] } });
  const head = record({ templates: ['T:user-clock-tuesday-#-#-#-bbbbbbbbbbbb = Clock: Tuesday #-#-# at #:# UTC'], steps: { 'p.1': ['compile [T:user-clock-tuesday-#-#-#-bbbbbbbbbbbb](2026,1,6,9,0) p.1.in, body 11111111'] } });
  const ds = differencesOf('H1/W1', base, head);
  const t = ds.find((d) => d.place.step === 'templates');
  assert.equal(t.describe, 'templates T:user-clock-tuesday-#-#-#: text changed');
  assert.equal(t.before, 'T:user-clock-tuesday-#-#-#-aaaaaaaaaaaa = Clock: Tuesday 2026-1-6, 9:0 UTC');
  assert.equal(t.after, 'T:user-clock-tuesday-#-#-#-bbbbbbbbbbbb = Clock: Tuesday 2026-1-6 at 9:0 UTC');
  const short = differencesOf('H1/W1', base.replace('(2026,1,6,9,0)', '(2026,1)'), head).find((d) => d.place.step === 'templates');
  assert.equal(short.before, 'T:user-clock-tuesday-#-#-#-aaaaaaaaaaaa = Clock: Tuesday #-#-#, #:# UTC', 'two numbers for five #s fill nothing');
});

test('one kind of difference is one entry, its id the sha256 of its signature, with every place and the first as its example', () => {
  const base = (n) => record({ steps: { [`p.${n}`]: [`compile p.${n}.in, body 1111111${n}`] } });
  const head = (n) => record({ steps: { [`p.${n}`]: [`compile p.${n}.in L1(p.0), body 3333333${n}`] } });
  const entries = entriesOf([...differencesOf('H1/W1', base(1), head(1)), ...differencesOf('H1/W2', base(2), head(2)), ...differencesOf('H1/W2', base(3), head(3))]);
  assert.equal(entries.length, 1);
  const [e] = entries;
  assert.match(e.id, /^[0-9a-f]{12}$/);
  assert.equal(e.id, createHash('sha256').update(JSON.stringify(['line', 'compile', 'changed', 'H p.C,', 'H L#(p.#), p.C'])).digest('hex').slice(0, 12));
  assert.equal(e.count, 3);
  assert.deepEqual(e.runs, ['H1/W1', 'H1/W2']);
  assert.deepEqual(e.places, [{ run: 'H1/W1', step: 'p.1' }, { run: 'H1/W2', step: 'p.2' }, { run: 'H1/W2', step: 'p.3' }]);
  assert.deepEqual(e.example, { place: { run: 'H1/W1', step: 'p.1' }, before: 'compile p.1.in, body 11111111', after: 'compile p.1.in L1(p.0), body 33333331' });
  assert.deepEqual(Object.keys(e), ['id', 'describe', 'count', 'runs', 'places', 'example']);
});

test('every differing line of a record lands in exactly one entry', () => {
  const base = record({ heads: ['H:aaaaaaaa = model m, max_tokens 100'], steps: { 'p.1': ['compile p.1.in, body 11111111', 'compile p.1.r1, body 22222222', 'call p.1 -> summary, body 33333333'] }, tail: ['end ok', 'totals {"compiles":2}'] });
  const head = record({ heads: ['H:bbbbbbbb = model m, max_tokens 200'], steps: { 'p.1': ['compile p.1.in L1(p.0), body 44444444', 'compile p.1.r1 L1(p.0), body 55555555', 'round + p.1.r2, body 66666666'] }, tail: ['end ok', 'totals {"compiles":3}'] });
  const ds = differencesOf('H1/W1', base, head);
  const entries = entriesOf(ds);
  assert.equal(entries.reduce((n, e) => n + e.count, 0), ds.length);
  assert.deepEqual(ds.map((d) => [d.place.step, d.describe]), [
    ['heads', 'heads H:aaaaaaaa: text only in base'],
    ['heads', 'heads H:bbbbbbbb: text only in head'],
    ['p.1', '`compile` lines whose `H p.C,` became `H L#(p.#), p.C`'],
    ['p.1', '`compile` lines whose `H p.C,` became `H L#(p.#), p.C`'],
    ['p.1', '`call` lines only in base'],
    ['p.1', '`round` lines only in head'],
    ['end', '`totals` lines whose `{"compiles":#}` became `{"compiles":#}`'],
  ], 'as entries.py gives these records');
  assert.equal(entries.find((e) => e.describe.startsWith('`compile`')).count, 2, 'the two compiles changed the same way');
});

test('records that are the same have no differences', () => {
  const r = record({ steps: { 'p.1': ['compile p.1.in, body 11111111'] } });
  assert.deepEqual(differencesOf('H1/W1', r, r), []);
  assert.deepEqual(entriesOf([]), []);
});
