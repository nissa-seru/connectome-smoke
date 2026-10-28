import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perCheckReport, runChecks } from '../lib/strategies/report.mjs';

const configuration = { name: 'default' };
const flag = (check, step, message = 'm') => ({ check, step, message });

test('the report passes a run with no flag and every product', () => {
  const r = perCheckReport({ configuration, candidate: { flags: [], missing: [] }, timing: { wallMs: 5200, load: 30 } });
  assert.equal(r.verdict, 'pass');
  assert.match(r.lines[0], /^default: no flags \(5\.2 s, load 30\)\.$/);
});

test('a clamp-edge calibration makes the run invalid, and the first line says so', () => {
  const r = perCheckReport({ configuration, candidate: { flags: [flag(10, 'c.cm.cp', 'calibration at the clamp edge (1.8)'), flag(1, 's')], missing: [] } });
  assert.equal(r.verdict, 'invalid');
  assert.match(r.lines[0], /^INVALID: calibration at the clamp edge \(1\.8\)/);
});

test('with the base beside it, each flag says whether the base has it, and a product neither side made is a segment that didn\'t run', () => {
  const r = perCheckReport({
    configuration,
    candidate: { flags: [flag(4, 'c.cm.3'), flag(6, 'c.par')], missing: [{ segment: 'close-merge', missing: ['a merge request'] }, { segment: 'held', missing: ['an empty answer'] }] },
    base: { flags: [flag(6, 'c.par')], missing: [{ segment: 'close-merge', missing: ['a merge request'] }] },
  });
  assert.equal(r.verdict, 'flags');
  assert.ok(r.lines.some((l) => /check 4 at c\.cm\.3.*\[not on base\]/.test(l)));
  assert.ok(r.lines.some((l) => /check 6 at c\.par.*\[base too\]/.test(l)));
  assert.ok(r.lines.some((l) => /held: missing an empty answer \[the base produced it\]/.test(l)));
  assert.ok(r.lines.some((l) => /close-merge didn't run: neither side produced a merge request/.test(l)));
});

test('K1b: an operator alert is matched on the base by its kind, and the report names a settle where the host reported no deferred writes', () => {
  const alert = (kind) => ({ check: 1, step: 'c.debt', what: kind, message: `the host raised an operator alert, ${kind}: x` });
  const r = perCheckReport({
    configuration,
    candidate: { flags: [alert('compression-quarantine'), alert('mcpl-down')], missing: [], notes: ['the host reported no deferred-write count at c.debt\'s settle'] },
    base: { flags: [alert('mcpl-down')], missing: [] },
  });
  assert.ok(r.lines.some((l) => /compression-quarantine.*\[not on base\]/.test(l)), 'the base\'s alert at that step is another kind');
  assert.ok(r.lines.some((l) => /mcpl-down.*\[base too\]/.test(l)));
  assert.ok(r.lines.some((l) => /no deferred-write count at c\.debt/.test(l)));
});

test('R7b: the checks note each settle at which the host reported no deferred-write count, and only those', () => {
  const settle = (step, deferredWritesReported) => ({ kind: 'settle', phase: 'end', step, settled: true, deferredWritesReported });
  const { notes } = runChecks({ records: [], log: [settle('a', true), settle('b', false)], script: [], products: [], store: null });
  assert.deepEqual(notes, ['the host reported no deferred-write count at b\'s settle']);
});
