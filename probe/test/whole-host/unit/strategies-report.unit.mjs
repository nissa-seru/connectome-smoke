import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { perCheckReport, readExpected, runChecks } from '../lib/strategies/report.mjs';

const configuration = { name: 'H1/W1' };
const flag = (check, step, message = 'm') => ({ check, step, message });

test('the report passes a run with no flag and every product', () => {
  const r = perCheckReport({ configuration, candidate: { flags: [], missing: [] } });
  assert.equal(r.verdict, 'pass');
  assert.match(r.lines[0], /^H1\/W1: no flags\.$/);
});

test('an expected failure covers its flags by key and names its finding; an entry no flag meets fails the run; another configuration\'s entry covers nothing', () => {
  const shape = (step) => ({ check: 11, step, what: 'fixture:request:shape', message: 'fixture\'s request compile 45 breaks shape' });
  const entry = (step, more = {}) => ({ configuration: 'H1/W1', check: 11, step, what: 'fixture:request:shape', finding: 'D1', reason: 'passthrough cuts a call from its result', ...more });
  const covered = perCheckReport({ configuration, candidate: { flags: [shape('p.42'), shape('p.42'), shape('p.45')], missing: [] }, expected: [entry('p.42'), entry('p.45')] });
  assert.equal(covered.verdict, 'pass');
  assert.equal(covered.expected.length, 3);
  assert.match(covered.lines[0], /^H1\/W1: no flags, 3 expected \(D1\)\.$/);
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
  const good = { configuration: 'H1/W1', check: 11, step: 'p.42', what: 'fixture:request:shape', finding: 'D1', reason: 'r' };
  assert.deepEqual(readExpected(join(dir, 'absent.json'), ['H1/W1']), []);
  assert.deepEqual(readExpected(at([good]), ['H1/W1', 'H3/W1']), [good]);
  assert.throws(() => readExpected(at([{ ...good, finding: '' }]), ['H1/W1']), /entry 0: has no finding/);
  assert.throws(() => readExpected(at([good, { ...good, check: '11' }]), ['H1/W1']), /entry 1: has no check number/);
  assert.throws(() => readExpected(at([{ ...good, configuration: 'H9' }]), ['H1/W1']), /entry 0: names a configuration this run has none of: H9/);
  assert.throws(() => readExpected(at([good, { ...good, reason: 'another' }]), ['H1/W1']), /entry 1: repeats another entry/);
  assert.throws(() => readExpected(at({ entries: [] }), ['H1/W1']), /isn't a list of entries/);
  const { what, ...noWhat } = good;
  assert.throws(() => readExpected(at([noWhat]), ['H1/W1']), /entry 0: has no what: an entry covers one kind of flag/);
  assert.throws(() => readExpected(at([{ ...good, match: '(' }]), ['H1/W1']), /entry 0: has a match that isn't a regular expression/);
  const pins = { ...good, what: 'fixture:request:pins' };
  assert.equal(readExpected(at([{ ...pins, match: 'allowing L0$' }, { ...pins, match: 'allowing L[1-9]', finding: 'D39' }]), ['H1/W1']).length, 2, 'entries sharing a key, each with its own match');
  assert.throws(() => readExpected(at([{ ...pins, match: 'allowing L0$' }, pins]), ['H1/W1']), /entry 1: shares its configuration, check, step and what with another entry, and one of them has no match/);
  assert.throws(() => readExpected(at([pins, { ...pins, match: 'allowing L0$' }]), ['H1/W1']), /entry 1: shares its configuration, check, step and what/);
  assert.throws(() => readExpected(at([{ ...pins, match: 'x' }, { ...pins, match: 'x', reason: 'again' }]), ['H1/W1']), /entry 1: repeats another entry's configuration, check, step, what and match/);
});

test('an entry\'s match narrows its cover to the flags whose detail it finds: D3 and D39 at one step each cover their own, a pins flag of a third shape is a flag, and an entry whose match no flag meets fails the run', () => {
  const pins = (detail) => ({ check: 11, step: 'p.9', what: 'fixture:request:pins', detail, message: `fixture's request compile 9 breaks pins: ${detail}` });
  const entry = (finding, match) => ({ configuration: 'H1/W1', check: 11, step: 'p.9', what: 'fixture:request:pins', match, finding, reason: 'r' });
  const d3 = entry('D3', 'allowing L0$');
  const d39 = entry('D39', 'allowing L[1-9][0-9]*$');
  const both = perCheckReport({ configuration, candidate: { flags: [pins('summary 4 sent over raw pin p1, allowing L0'), pins('summary 7 sent under level pin p2, allowing L1')], missing: [] }, expected: [d3, d39] });
  assert.equal(both.verdict, 'pass');
  assert.match(both.lines[0], /^H1\/W1: no flags, 2 expected \(D3, D39\)\.$/);
  assert.ok(both.lines.some((l) => /allowing L1 \[expected: D39\]$/.test(l)));
  const third = perCheckReport({ configuration, candidate: { flags: [pins('summary 4 sent over raw pin p1, allowing L0'), pins('summary 7 sent under level pin p2, allowing L1'), pins('pin p3 names no stored message')], missing: [] }, expected: [d3, d39] });
  assert.deepEqual(third.flags.map((f) => f.detail), ['pin p3 names no stored message'], 'a pins flag neither match finds isn\'t covered');
  const gone = perCheckReport({ configuration, candidate: { flags: [pins('summary 4 sent over raw pin p1, allowing L0')], missing: [] }, expected: [d3, d39] });
  assert.equal(gone.flags.length, 1);
  assert.match(gone.flags[0].message, /expects a flag here for D39 matching \/allowing L\[1-9\]\[0-9\]\*\$\/, and the run raised none/);
  const noDetail = perCheckReport({ configuration, candidate: { flags: [{ check: 4, step: 'p.9', what: 'more-than-once', message: '3 stored message(s) reach the request more than once' }], missing: [] }, expected: [{ configuration: 'H1/W1', check: 4, step: 'p.9', what: 'more-than-once', match: 'more than once', finding: 'D3', reason: 'r' }] });
  assert.equal(noDetail.verdict, 'pass', 'a flag with no detail is matched by its message');
});

test('a clamp-edge calibration makes the run invalid, and the first line says so', () => {
  const r = perCheckReport({ configuration, candidate: { flags: [flag(10, 'c.cm.cp', 'calibration at the clamp edge (1.8)'), flag(1, 's')], missing: [] } });
  assert.equal(r.verdict, 'invalid');
  assert.match(r.lines[0], /^INVALID: calibration at the clamp edge \(1\.8\)/);
});

test('K1b: the report names each operator alert by its kind, and prints the checks\' notes', () => {
  const alert = (kind) => ({ check: 1, step: 'c.debt', what: kind, message: `the host raised an operator alert, ${kind}: x` });
  const r = perCheckReport({
    configuration,
    candidate: { flags: [alert('compression-quarantine'), alert('mcpl-down')], missing: [], notes: ['a note from the checks'] },
  });
  assert.ok(r.lines.some((l) => /compression-quarantine/.test(l)) && r.lines.some((l) => /mcpl-down/.test(l)));
  assert.ok(r.lines.includes('- a note from the checks'));
});

test('K2d: the checks carry check 3\'s note that the host reported its window governs the agent\'s stream', () => {
  const usage = { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 };
  const r1 = { id: 'r1', step: 'a', kind: 'agent', maxTokens: 2_048, usage, messages: [{ role: 'user', digest: 'd1', blocks: [{ type: 'text', canaries: ['[[c:a.in]]'] }] }], answer: { shape: 'reply', toolUseIds: ['t1'] } };
  const r2 = { ...r1, id: 'r2', messages: [...r1.messages, { role: 'assistant', digest: 'd2', blocks: [{ type: 'tool_use', toolUseId: 't1' }] }, { role: 'user', digest: 'd3', blocks: [] }], answer: { shape: 'reply', toolUseIds: [] } };
  const report = { kind: 'budget-report', boot: 1, lines: ['--- Stream Token Budgets ---', '  fixture: 150.0k (last: 0, 0%); its stream doesn\'t break at this budget mid-turn: for its size, only before a request its 1.0M window can\'t hold'] };
  const checkpoint = { kind: 'checkpoint', name: 's', step: 's.cp', health: { data: { contextComposition: { fixture: { planVsActual: { budgetMet: true } } }, runtimeSettings: { fixture: { effectiveContextBudgetTokens: 20_000 } } } } };
  const compiled = { kind: 'compiles', lines: [{ seq: 1, agent: 'fixture', kind: 'request', assembly: 1, outcome: 'compiled', messages: [{ sources: ['r:1'], content: 'x1' }] }], blobs: { x1: { role: 'user', content: [{ type: 'text', text: '[[c:a.in]] words' }] } } };
  const log = [compiled, report, { kind: 'request', request: { id: 'r1', kind: 'agent' } }, { kind: 'request', request: { id: 'r2', kind: 'agent' } }, checkpoint];
  const { notes } = runChecks({ records: [r1, r2], log, script: [{ id: 'a', segment: 's' }], products: [], store: null, windowTokens: 1_000_000 });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /window/);
});

test('judged: every check reports how many items it judged; zero where check 3, 11, 12 or 13 applies is a couldn\'t-judge flag, and the report prints the counts', () => {
  const usage = { input_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const r1 = { id: 'r1', step: 'a', kind: 'agent', agent: 'primary', maxTokens: 2_048, usage, messages: [{ role: 'user', digest: 'd1', blocks: [{ type: 'text', canaries: ['[[c:a.in]]'] }] }], answer: { shape: 'reply', toolUseIds: [] } };
  const script = [{ id: 'a', segment: 's', kind: 'channel' }];
  // The module on, a request made, and no compile line: checks 11 and 13 judged nothing they apply to.
  const none = runChecks({ records: [r1], log: [], script, products: [], store: null, windowTokens: 1_000_000 });
  const what = none.flags.filter((f) => /^judged-none:/.test(f.what ?? '')).map((f) => [f.check, f.what]);
  assert.deepEqual(what, [[11, 'judged-none:compile invariants'], [13, 'judged-none:pairing']]);
  assert.match(none.flags.find((f) => f.check === 11).message, /couldn't judge: check 11 \(compile invariants\) judged nothing, though it applies/);
  assert.deepEqual(none.flags.filter((f) => f.check === 3).map((f) => f.what), ['no-compile-lines'], 'check 3 can\'t tell a compiled request from a round without the lines, and says so itself');
  const counts = Object.fromEntries(none.judged.map((j) => [`${j.check} ${j.name}`, j.judged]));
  assert.equal(counts['3 budgets'], null, 'counted as unknown, so no judged-none flag doubles check 3\'s own');
  assert.equal(counts['3 request shape'], 1);
  assert.equal(counts['11 compile invariants'], 0);
  // A reload-checked restart with no reload logged makes check 12's too.
  const restarted = runChecks({ records: [r1], log: [], script: [...script, { id: 'r', segment: 's', kind: 'restart', reloadCheck: true }], products: [], store: null, windowTokens: 1_000_000 });
  assert.deepEqual(restarted.flags.filter((f) => /^judged-none:/.test(f.what ?? '')).map((f) => f.check), [11, 12, 13]);
  // A request with no usage: check 3 judged none of the run's requests.
  const line = { kind: 'compiles', lines: [{ seq: 1, agent: 'fixture', kind: 'request', assembly: 1, outcome: 'compiled', messages: [{ sources: ['r:1'], content: 'x1' }] }], blobs: { x1: { role: 'user', content: [{ type: 'text', text: '[[c:a.in]] words' }] } } };
  const unused = runChecks({ records: [{ ...r1, usage: undefined }], log: [line], script, products: [], store: null, windowTokens: 1_000_000 });
  assert.ok(unused.flags.some((f) => f.what === 'judged-none:budgets'));
  // No request at all: nothing applies, nothing flags.
  assert.deepEqual(runChecks({ records: [], log: [], script: [], products: [], store: null }).flags, []);
  const report = perCheckReport({ configuration, candidate: { flags: [], missing: [], judged: none.judged } });
  assert.ok(report.lines.some((l) => /^- judged: check 1 every turn answers 1, check 3 request shape 1, check 3 budgets \?, /.test(l)));
});
