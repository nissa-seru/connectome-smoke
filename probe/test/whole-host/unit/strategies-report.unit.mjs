import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { perCheckReport, readExpected, runChecks } from '../lib/strategies/report.mjs';

const configuration = { name: 'default' };
const flag = (check, step, message = 'm') => ({ check, step, message });

test('the report passes a run with no flag and every product', () => {
  const r = perCheckReport({ configuration, candidate: { flags: [], missing: [] }, timing: { wallMs: 5200, load: 30 } });
  assert.equal(r.verdict, 'pass');
  assert.match(r.lines[0], /^default: no flags \(5\.2 s, load 30\)\.$/);
});

test('an expected failure covers its flags by key and names its finding; an entry no flag meets fails the run; another configuration\'s entry covers nothing', () => {
  const shape = (step) => ({ check: 11, step, what: 'fixture:request:shape', message: 'fixture\'s request compile 45 breaks shape' });
  const entry = (step, more = {}) => ({ configuration: 'default', check: 11, step, what: 'fixture:request:shape', finding: 'D1', reason: 'passthrough cuts a call from its result', ...more });
  const covered = perCheckReport({ configuration, candidate: { flags: [shape('p.42'), shape('p.42'), shape('p.45')], missing: [] }, expected: [entry('p.42'), entry('p.45')] });
  assert.equal(covered.verdict, 'pass');
  assert.equal(covered.expected.length, 3);
  assert.match(covered.lines[0], /^default: no flags, 3 expected \(D1\)\.$/);
  assert.ok(covered.lines.some((l) => /check 11 at p\.45: .*\[expected: D1\]/.test(l)));
  const fixed = perCheckReport({ configuration, candidate: { flags: [shape('p.42')], missing: [] }, expected: [entry('p.42'), entry('p.45')] });
  assert.equal(fixed.verdict, 'flags');
  assert.deepEqual(fixed.flags.map((f) => [f.check, f.step, f.what]), [[11, 'p.45', 'fixture:request:shape']]);
  assert.match(fixed.flags[0].message, /expects a flag here for D1, and the run raised none: if D1 is fixed, the change that fixed it removes the entry/);
  const unrelated = perCheckReport({ configuration, candidate: { flags: [shape('p.42'), { check: 11, step: 'p.42', what: 'fixture:request:coverage', message: 'm' }], missing: [] }, expected: [entry('p.42', { configuration: 'passthrough' })] });
  assert.equal(unrelated.flags.length, 2, 'an entry for another configuration covers nothing here');
  assert.equal(unrelated.expected.length, 0);
});

test('the expected failures read: none without the file, and an entry missing a field, naming an unknown configuration or repeating a key throws, naming it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'expected-'));
  const at = (entries) => { const p = join(dir, `e${Math.random()}.json`); writeFileSync(p, JSON.stringify(entries)); return p; };
  const good = { configuration: 'default', check: 11, step: 'p.42', what: 'fixture:request:shape', finding: 'D1', reason: 'r' };
  assert.deepEqual(readExpected(join(dir, 'absent.json'), ['default']), []);
  assert.deepEqual(readExpected(at([good]), ['default', 'passthrough']), [good]);
  assert.throws(() => readExpected(at([{ ...good, finding: '' }]), ['default']), /entry 0: has no finding/);
  assert.throws(() => readExpected(at([good, { ...good, check: '11' }]), ['default']), /entry 1: has no check number/);
  assert.throws(() => readExpected(at([{ ...good, configuration: 'H9' }]), ['default']), /entry 0: names a configuration this run has none of: H9/);
  assert.throws(() => readExpected(at([good, { ...good, reason: 'another' }]), ['default']), /entry 1: repeats another entry/);
  assert.throws(() => readExpected(at({ entries: [] }), ['default']), /isn't a list of entries/);
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

test('K2d: the checks carry check 3\'s note that the host reported its window governs the agent\'s stream', () => {
  const usage = { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 };
  const r1 = { id: 'r1', step: 'a', kind: 'agent', messageTokens: 900, maxTokens: 2_048, usage, messages: [{ role: 'user', digest: 'd1', blocks: [] }], answer: { shape: 'reply', toolUseIds: ['t1'] } };
  const r2 = { ...r1, id: 'r2', messages: [...r1.messages, { role: 'assistant', digest: 'd2', blocks: [{ type: 'tool_use', toolUseId: 't1' }] }, { role: 'user', digest: 'd3', blocks: [] }], answer: { shape: 'reply', toolUseIds: [] } };
  const report = { kind: 'budget-report', boot: 1, lines: ['--- Stream Token Budgets ---', '  fixture: 150.0k (last: 0, 0%); its stream doesn\'t break at this budget mid-turn: for its size, only before a request its 1.0M window can\'t hold'] };
  const checkpoint = { kind: 'checkpoint', name: 's', step: 's.cp', health: { data: { contextComposition: { fixture: { planVsActual: { budgetMet: true } } }, runtimeSettings: { fixture: { effectiveContextBudgetTokens: 20_000 } } } } };
  const log = [report, { kind: 'request', request: { id: 'r1', kind: 'agent' } }, { kind: 'request', request: { id: 'r2', kind: 'agent' } }, checkpoint];
  const { notes } = runChecks({ records: [r1, r2], log, script: [{ id: 'a', segment: 's' }], products: [], store: null, windowTokens: 1_000_000 });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /window/);
});

test('R7b: the checks note each settle at which the host reported no deferred-write count, and only those', () => {
  const settle = (step, deferredWritesReported) => ({ kind: 'settle', phase: 'end', step, settled: true, deferredWritesReported });
  const { notes } = runChecks({ records: [], log: [settle('a', true), settle('b', false)], script: [], products: [], store: null });
  assert.deepEqual(notes, ['the host reported no deferred-write count at b\'s settle']);
});

test('judged: every check reports how many items it judged; zero where check 3, 11, 12 or 13 applies is a couldn\'t-judge flag, and the report prints the counts', () => {
  const usage = { input_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const r1 = { id: 'r1', step: 'a', kind: 'agent', agent: 'primary', messageTokens: 900, maxTokens: 2_048, usage, messages: [{ role: 'user', digest: 'd1', blocks: [{ type: 'text', canaries: ['[[c:a.in]]'] }] }], answer: { shape: 'reply', toolUseIds: [] } };
  const script = [{ id: 'a', segment: 's', kind: 'channel' }];
  // The module on, a request made, and no compile line: checks 11 and 13 judged nothing they apply to.
  const none = runChecks({ records: [r1], log: [], script, products: [], store: null, windowTokens: 1_000_000 });
  const what = none.flags.filter((f) => /^judged-none:/.test(f.what ?? '')).map((f) => [f.check, f.what]);
  assert.deepEqual(what, [[11, 'judged-none:compile invariants'], [13, 'judged-none:pairing']]);
  assert.match(none.flags.find((f) => f.check === 11).message, /couldn't judge: check 11 \(compile invariants\) judged nothing, though it applies/);
  const counts = Object.fromEntries(none.judged.map((j) => [`${j.check} ${j.name}`, j.judged]));
  assert.equal(counts['3 budgets'], 1, 'check 3 held the one request to the window');
  assert.equal(counts['3 request shape'], 1);
  assert.equal(counts['11 compile invariants'], 0);
  // With the module off, checks 11 and 13 don't apply; a reload-checked restart with no reload logged makes check 12's.
  const off = runChecks({ records: [r1], log: [], script: [...script, { id: 'r', segment: 's', kind: 'restart', reloadCheck: true }], products: [], store: null, windowTokens: 1_000_000, moduleOn: false });
  assert.deepEqual(off.flags.filter((f) => /^judged-none:/.test(f.what ?? '')).map((f) => f.check), [12]);
  // A request with no usage: check 3 judged none of the run's requests.
  const unused = runChecks({ records: [{ ...r1, usage: undefined }], log: [], script, products: [], store: null, windowTokens: 1_000_000, moduleOn: false });
  assert.ok(unused.flags.some((f) => f.what === 'judged-none:budgets'));
  // No request at all: nothing applies, nothing flags.
  assert.deepEqual(runChecks({ records: [], log: [], script: [], products: [], store: null }).flags, []);
  const report = perCheckReport({ configuration, candidate: { flags: [], missing: [], judged: none.judged } });
  assert.ok(report.lines.some((l) => /^- judged: check 1 every turn answers 1, check 3 request shape 1, check 3 budgets 1, /.test(l)));
});
