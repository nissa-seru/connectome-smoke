// The lines of a failed command's output that a lane's report keeps. Run
// with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureLines } from './common.mjs';

test('a failing test\'s name from Node\'s spec reporter is kept, beside the error and the counts', () => {
  // As Node 24's test runner prints a failure when its output is piped,
  // with a test name that says nothing of failing.
  const out = [
    '✔ recipe-save-unresolved: saves a recipe (4.1ms)',
    '✖ clearSavedRecipe refuses a directory (2.3ms)',
    'ℹ tests 2',
    'ℹ pass 1',
    'ℹ fail 1',
    '',
    '✖ failing tests:',
    '',
    'test at test/recipe-save-unresolved.test.ts:322:1',
    '✖ clearSavedRecipe refuses a directory (2.3ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  ];
  assert.deepEqual(failureLines(out), [
    '✖ clearSavedRecipe refuses a directory (2.3ms)',
    'ℹ fail 1',
    '✖ failing tests:',
    '✖ clearSavedRecipe refuses a directory (2.3ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  ]);
});

test('vitest\'s, TAP\'s and ✗-marked failing lines are kept, and only the last 30 of them', () => {
  // The ✗ line's test name says nothing of failing either.
  assert.deepEqual(
    failureLines([' FAIL  test/a.test.ts > a case', 'not ok 3 - another case', 'ok 4 - passes', '✗ saves a recipe']),
    [' FAIL  test/a.test.ts > a case', 'not ok 3 - another case', '✗ saves a recipe'],
  );
  // Ordinary lines after the failing ones: the last 30 are of the failing
  // lines, not of the output.
  const many = Array.from({ length: 40 }, (_, i) => `not ok ${i + 1} - case ${i + 1}`);
  const after = Array.from({ length: 31 }, (_, i) => `# diagnostic ${i + 1}`);
  assert.deepEqual(failureLines([...many, ...after]), many.slice(-30));
});
