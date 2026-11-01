import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedRequests, stepSummary, summaryTable, viewOf } from '../lib/view.mjs';

const lines = (...xs) => xs.map(([text, request = null]) => ({ text, request }));
const text = (...xs) => `${xs.join('\n')}\n`;

test('the requests a change moved are those whose lines differ from the committed record, in the run\'s order', () => {
  const committed = text('# h', 'step a', '  compile p.1, body 11111111', '  call - -> summary, body 22222222', 'step b', '  compile -1 + p.2, body 33333333', 'end ok');
  const same = lines(['# h'], ['step a'], ['  compile p.1, body 11111111', 'r1'], ['  call - -> summary, body 22222222', 's1'], ['step b'], ['  compile -1 + p.2, body 33333333', 'r2'], ['end ok']);
  assert.deepEqual(changedRequests(committed, same), { requests: [], added: 0, removed: 0, unattributed: 0 });
  const moved = lines(['# h'], ['step a'], ['  compile p.1, body 11111111', 'r1'], ['  call - -> summary, body 2222aaaa', 's1'], ['step b'], ['  compile -1 + p.2, body 3333bbbb', 'r2'], ['end ok']);
  assert.deepEqual(changedRequests(committed, moved), { requests: ['s1', 'r2'], added: 2, removed: 2, unattributed: 0 });
});

test('a line no request owns counts apart, and a request that only went away names nothing on the run\'s side', () => {
  const committed = text('step a', '  compile p.1, body 11111111', '  wrote L1(p.1) [T:summary-l1-aaaa]', '  compile p.1 L1(p.1), body 44444444', 'end ok');
  const run = lines(['step a'], ['  compile p.1, body 11111111', 'r1'], ['  wrote L1(p.1) [T:summary-l1-bbbb]'], ['end ok']);
  assert.deepEqual(changedRequests(committed, run), { requests: [], added: 1, removed: 2, unattributed: 1 });
});

test('a request with several changed lines is named once, and an inserted line leaves the lines around it unchanged', () => {
  const committed = text('step a', '  compile p.1, body 11111111', '  compile p.2, body 22222222');
  const run = lines(['step a'], ['  compile p.1, body 11111111', 'r1'], ['  round + p.1.call1, body 55555555', 'r9'], ['  round + p.1.call2, body 66666666', 'r9'], ['  compile p.2, body 22222222', 'r2']);
  assert.deepEqual(changedRequests(committed, run), { requests: ['r9'], added: 2, removed: 0, unattributed: 0 });
});

test('the summary has a row per run, naming what changed, with a count it wasn\'t given shown as unknown', () => {
  const table = summaryTable([
    { run: 'H1/W1', record: 'same', ledgerOf: 'fixture', counts: { compiles: 70, refused: 0, compressions: 12, merges: 3, quarantines: 0, raw: 20, summarised: 40, out: 10, invariantLines: 0 }, tokens: { input: 23456, cacheRead: 100000, cacheWrite: 0, output: 900 } },
    { run: 'H3/W4', record: 'differs', changed: { requests: ['r3', 'r4'], added: 3, removed: 2 }, counts: {} },
  ]).split('\n');
  assert.equal(table.length, 4);
  assert.equal(table[1], '|---|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|', 'counts align right, the agent\'s name left');
  assert.equal(table[2], '| H1/W1 | same | 70 | 0 | 12 | 3 | 0 | fixture | 20 | 40 | 10 | 123456 | 0 |');
  assert.equal(table[3], '| H3/W4 | differs: 2 request(s), +3 -2 line(s) | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? |');
});

test('a run\'s view shows each changed request\'s record line, its ledger and its transcript, sharing what the transcripts have shown', () => {
  const calls = [];
  const view = viewOf({
    run: 'H3/W4', record: 'differs',
    changed: { requests: ['r3', 'r4'], added: 2, removed: 2, unattributed: 0 },
    lines: lines(['step a'], ['  compile p.3, body 33333333', 'r3'], ['  round + p.3.call1, body 44444444', 'r4']),
    ledger: (id) => (id === 'r3' ? ['raw: p.1-p.3'] : []),
    transcript: (id, seen) => { calls.push([id, seen.size]); seen.add(id); return [`transcript of ${id}`]; },
  });
  assert.match(view, /^## H3\/W4\n\n2 request\(s\) changed: 2 record line\(s\) added and 2 removed\.\n/);
  assert.match(view, /### r3: `compile p\.3, body 33333333`\n\nraw: p\.1-p\.3\n\n```text\ntranscript of r3\n```/);
  assert.match(view, /### r4: `round \+ p\.3\.call1, body 44444444`\n\n```text\ntranscript of r4\n```/);
  assert.deepEqual(calls, [['r3', 0], ['r4', 1]], 'the second transcript knows what the first showed');
});

test('the step summary keeps within its bytes, showing views in order while they fit and naming each that didn\'t', () => {
  const view = (run, n) => ({ run, path: `${run}/view.md`, text: `${run}:${'x'.repeat(n)}\n` });
  const all = stepSummary({ table: 'T', views: [view('a', 10), view('b', 10)], budget: 1000 });
  assert.equal(all, 'T\n\na:xxxxxxxxxx\nb:xxxxxxxxxx\n');
  const some = stepSummary({ table: 'T', views: [view('a', 10), view('b', 2000), view('c', 10)], budget: 1000 });
  assert.ok(Buffer.byteLength(some) <= 1000);
  assert.match(some, /^T\n\na:x{10}\nc:x{10}\nThe view of b \(2003 bytes\) didn't fit within this summary's 1000 bytes: it's b\/view\.md in the job's evidence\.\n$/);
  const none = stepSummary({ table: 'T', views: [view('a', 1000)], budget: 1000 });
  assert.equal(none, 'T\n\nThe view of a (1003 bytes) didn\'t fit within this summary\'s 1000 bytes: it\'s a/view.md in the job\'s evidence.\n', 'a view larger than the whole budget is only named');
});

test('a changed request\'s heading keeps its record line short, since the line itself is in the record diff', () => {
  const long = `  round + ${Array.from({ length: 60 }, (_, i) => `p.${i}.in`).join(' ')}, body 44444444`;
  const view = viewOf({ run: 'R', record: 'differs', changed: { requests: ['r1'], added: 1, removed: 1, unattributed: 0 }, lines: lines([long, 'r1']), ledger: () => [], transcript: () => [] });
  const heading = view.split('\n').find((l) => l.startsWith('### r1: '));
  assert.equal(heading, `### r1: \`${long.trim().slice(0, 199)}…\``);
});
