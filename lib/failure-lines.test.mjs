import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DETAIL_MAX, failureLines, failureMessage } from './common.mjs';

const other = '[other lines that look like an error:]';

const notOk = [
  '    # Subtest: refuses a directory',
  '    not ok 2 - refuses a directory',
  '      ---',
  '      duration_ms: 1.291048',
  "      type: 'test'",
  "      location: '/work/src/agent-framework/test/a.test.mjs:5:3'",
  "      failureType: 'testCodeFailure'",
  '      error: |-',
  '        Expected values to be strictly equal:',
  '        ',
  '        1 !== 2',
  '        ',
  "      code: 'ERR_ASSERTION'",
  '      stack: |-',
  '        TestContext.<anonymous> (file:///work/src/agent-framework/test/a.test.mjs:5:46)',
  '      ...',
];
const record = notOk.slice(1);
const passing = (n) => Array.from({ length: n }, (_, i) => [
  `    # Subtest: lets go of root ${i} when its path fails with another error`,
  `    ok ${i + 3} - lets go of root ${i} when its path fails with another error`,
  '      ---',
  '      duration_ms: 0.5',
  "      type: 'test'",
  '      ...',
]).flat();

test("a TAP failure's `not ok` line and its YAML block come first and whole, ahead of 30 or more passing lines that say \"fails\"", () => {
  const out = ['TAP version 13', ...notOk, ...passing(40), '# tests 41', '# pass 40', '# fail 1'];
  const kept = failureLines(out);
  assert.deepEqual(kept.slice(0, record.length), record);
  assert.equal(kept[record.length], other);
  assert.equal(kept.length, record.length + 1 + 30);
  assert.equal(kept.at(-1), '# fail 1');
  assert.equal(kept.filter((l) => l === record[0]).length, 1);
});

test("a `not ok` line whose YAML block never closes is kept alone, and a later test keeps its own", () => {
  const later = notOk.map((l) => l.replace('refuses a directory', 'refuses a file'));
  const out = [...notOk.slice(0, -1), '# Subtest: a store', ...later];
  const kept = failureLines(out);
  assert.deepEqual(kept.slice(0, 1 + record.length), [record[0], ...later.slice(1)]);
});

test("Bun's `(fail)` lines come first, each with its file's line, ahead of 30 or more `(pass)` lines that say \"error\"", () => {
  const fail = '(fail) a store > refuses a directory [0.03ms]';
  const out = [
    'bun test v1.4.4 (38afee6c8)',
    'x.test.ts:',
    fail,
    ...Array.from({ length: 35 }, (_, i) => `(pass) LoggingProviderAdapter error records > case ${i} [0.5ms]`),
    'y.test.ts:',
    fail,
    ' 2 fail',
  ];
  const kept = failureLines(out);
  assert.deepEqual(kept.slice(0, 4), ['x.test.ts:', fail, 'y.test.ts:', fail]);
  assert.equal(kept[4], other);
  assert.equal(kept.length, 35);
  assert.equal(kept.at(-1), ' 2 fail');
});

test("the names in Node's spec reporter's failing-tests list come first, each with its `test at` line", () => {
  const out = [
    '▶ a store',
    '  ✔ lets go of its root when its path fails with another error (2.0ms)',
    '  ✖ refuses a directory (1.1ms)',
    '✖ a store (5.4ms)',
    'ℹ tests 2',
    'ℹ fail 1',
    '',
    '✖ failing tests:',
    '',
    'test at test/a.test.mjs:5:3',
    '✖ refuses a directory (1.1ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '      at TestContext.<anonymous> (file:///work/test/a.test.mjs:5:46)',
  ];
  const kept = failureLines(out);
  assert.deepEqual(kept.slice(0, 2), ['test at test/a.test.mjs:5:3', '✖ refuses a directory (1.1ms)']);
  assert.ok(!kept.includes('✖ a store (5.4ms)'), 'a failing suite line is no other line');
  const named = ['✖ failing tests:', '', 'test at a.mjs:1:1', '✖ failing tests: are named too (1ms)'];
  assert.deepEqual(failureLines(named).slice(0, 2), ['test at a.mjs:1:1', '✖ failing tests: are named too (1ms)']);
});

test('the lines that look like an error follow the records without repeating them', () => {
  const out = [...notOk, '# Subtest: an error path', 'ok 9 - an error path', '# fail 1'];
  assert.deepEqual(failureLines(out), [...record, other, '# Subtest: an error path', 'ok 9 - an error path', '# fail 1']);
});

const failing = (n) => notOk.map((l) => l.replace('refuses a directory', `refuses directory ${n}`));
const whole = (n) => failing(n).slice(1);
const named = (n) => [whole(n)[0], whole(n)[4]];

test("a test whose whole lines don't fit beside the names of the tests after it is kept by its name and location", () => {
  const out = [...failing(1), ...failing(2), ...failing(3), ...passing(5), '# fail 3'];
  assert.match(named(1)[1], /^ {6}location: /);
  const budget = [...whole(1), ...named(2), ...named(3)].join('\n').length;
  assert.deepEqual(failureLines(out, budget), [...whole(1), ...named(2), ...named(3)]);
  const tighter = failureLines(out, budget - 1);
  assert.deepEqual(tighter.slice(0, 6), [...named(1), ...named(2), ...named(3)]);
  const rest = tighter.slice(6);
  assert.ok(rest.every((l) => /error|fail/i.test(l) && !tighter.slice(0, 6).includes(l)), 'the rest are other lines that look like an error');
});

test('when the names alone pass the budget, the kept lines say how many tests they leave unnamed, and end there', () => {
  const out = [...failing(1), ...failing(2), ...failing(3), ...passing(5), '# fail 3'];
  const note = (n) => `[${n} more failing tests not shown, to keep this step's text within ${DETAIL_MAX} characters]`;
  const budget = [...named(1), note(2)].join('\n').length;
  assert.deepEqual(failureLines(out, budget), [...named(1), note(2)]);
});

test('within the budget, every record is kept, and the earliest of the other lines are dropped first', () => {
  const out = [...notOk, ...passing(40), '# fail 1'];
  const budget = record.join('\n').length + 300;
  const kept = failureLines(out, budget);
  assert.deepEqual(kept.slice(0, record.length), record);
  assert.equal(kept.at(-1), '# fail 1');
  assert.ok(kept.join('\n').length <= budget);
  assert.ok(kept.length < record.length + 30);
});

test("a failed command's message names every failing test that fits, within the report's characters, with any cut among the error's frames", () => {
  const out = [...Array.from({ length: 20 }, (_, n) => failing(n)).flat(), ...passing(40), '# fail 20'];
  const message = failureMessage('`npm test` in ./src/agent-framework exited 1', out);
  const detail = String(new Error(message).stack).slice(0, DETAIL_MAX);
  assert.ok(detail.startsWith(`Error: ${message}\n`));
  for (let n = 0; n < 20; n++) assert.ok(message.includes(`\n    not ok 2 - refuses directory ${n}\n`), `test ${n} is named`);
  assert.ok(message.includes(whole(0).join('\n')), 'the first test is whole');
  const many = failureMessage('`npm test` exited 1', Array.from({ length: 200 }, (_, n) => failing(n)).flat());
  assert.ok(String(new Error(many).stack).slice(0, DETAIL_MAX).startsWith(`Error: ${many}\n`));
  assert.match(many.split('\n').at(-1), /^\[\d+ more failing tests not shown, to keep this step's text within 6000 characters\]$/);
});

test("with no line that looks like an error, the message keeps the output's last lines that fit", () => {
  assert.equal(failureMessage('`npm test` exited 1', ['a', 'b']), '`npm test` exited 1\na\nb');
  const long = Array.from({ length: 40 }, (_, n) => `line ${n} `.padEnd(400, '.'));
  const message = failureMessage('`npm run build` exited 2', long);
  assert.ok(`Error: ${message}`.length < DETAIL_MAX);
  assert.equal(message.split('\n').at(-1), long.at(-1));
});

test("vitest's `FAIL` lines are failing tests, with or without colour", () => {
  const red = '\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m a.test.ts\x1b[2m > \x1b[22ma store\x1b[2m > \x1b[22mrefuses a directory';
  const out = [
    ...Array.from({ length: 35 }, (_, i) => `     ✓ case ${i} fails with another error 1ms`),
    ' FAIL  b.test.ts [ b.test.ts ]',
    red,
    ' Test Files  2 failed (2)',
  ];
  assert.deepEqual(failureLines(out).slice(0, 2), [' FAIL  b.test.ts [ b.test.ts ]', red]);
});

test("a TAP suite's or file's record that failed only through its subtests isn't a failing test, nor one of the other lines", () => {
  const suite = [
    '    not ok 3 - nested',
    '      ---',
    '      duration_ms: 0.44842',
    "      type: 'suite'",
    "      location: '/work/src/agent-framework/test/a.test.mjs:6:3'",
    "      failureType: 'subtestsFailed'",
    "      error: '1 subtest failed'",
    "      code: 'ERR_TEST_FAILURE'",
    '      ...',
  ];
  const kept = failureLines([...notOk, ...suite, '# fail 1']);
  assert.deepEqual(kept, [...record, other, '# fail 1']);
  const note = (n) => `[${n} more failing test${n === 1 ? '' : 's'} not shown, to keep this step's text within ${DETAIL_MAX} characters]`;
  const tight = failureLines([...failing(1), ...suite, ...failing(2), ...suite], [...named(1), note(1)].join('\n').length + 1);
  assert.deepEqual(tight, [...named(1), note(1)]);
});

test("a name too long for the room is left out and counted, and the shorter names after it are kept", () => {
  const long = `(fail) a table > case ${'x'.repeat(500)} [1ms]`;
  const short = (n) => `(fail) a store > refuses ${n} [1ms]`;
  const note = `[1 more failing test not shown, to keep this step's text within ${DETAIL_MAX} characters]`;
  const budget = [short(1), short(2), short(3), note].join('\n').length + 1;
  assert.deepEqual(failureLines([short(1), long, short(2), short(3)], budget), [short(1), short(2), short(3), note]);
});

test('an other line too long for the room is left out, and the earlier ones that fit are kept', () => {
  const kept = failureLines([...notOk, 'Error: early', 'Error: later', `Error: ${'y'.repeat(500)}`], [...record, other].join('\n').length + 40);
  assert.deepEqual(kept, [...record, other, 'Error: early', 'Error: later']);
});

test("a test kept by its name leaves its error lines free to be among the other lines", () => {
  const typeLine = "      failureType: 'testCodeFailure'";
  const errorLine = '      error: |-';
  const budget = [...named(1), other, typeLine, errorLine].join('\n').length;
  assert.deepEqual(failureLines(failing(1), budget), [...named(1), other, typeLine, errorLine]);
});

test("vitest's `×` line is one of the other lines", () => {
  assert.deepEqual(failureLines(['     ✓ keeps a root 1ms', '     × refuses a directory 6ms', ' Tests  1 passed']), ['     × refuses a directory 6ms']);
});

test("a TAP suite's subtests record ending in a carriage return is still no failing test", () => {
  const suite = ['    not ok 3 - nested', '      ---', "      failureType: 'subtestsFailed'", "      error: '1 subtest failed'", '      ...'].map((l) => `${l}\r`);
  const kept = failureLines([...notOk, ...suite, '# fail 1']);
  assert.deepEqual(kept, [...record, other, '# fail 1']);
});

test("with no line that fits, the message keeps the latest cut short, saying how much it lost", () => {
  const message = failureMessage('`npm run build` exited 2', [`minified ${'z'.repeat(7000)}`]);
  assert.ok(`Error: ${message}`.length < DETAIL_MAX);
  assert.match(message.split('\n').at(-1), /^minified z+ \[… \d+ more characters\]$/);
});

test("Bun's closing list of failed tests names none again, nor under another file", () => {
  const fail = '(fail) fails here [0.31ms]';
  const out = [
    'a.test.ts:',
    'error: expect(received).toBe(expected)',
    fail,
    ...Array.from({ length: 30 }, (_, i) => `(pass) a passes ${i + 1}`),
    '',
    'b.test.ts:',
    ...Array.from({ length: 30 }, (_, i) => `(pass) b passes ${i + 1}`),
    '',
    '1 tests failed:',
    fail,
    '',
    ' 60 pass',
    ' 1 fail',
  ];
  assert.deepEqual(failureLines(out), ['a.test.ts:', fail, other, 'error: expect(received).toBe(expected)', '1 tests failed:', ' 1 fail']);
});

test('no line says other lines follow when none does', () => {
  assert.deepEqual(failureLines(['a.test.ts:', '(fail) fails here [1ms]']), ['a.test.ts:', '(fail) fails here [1ms]']);
});
