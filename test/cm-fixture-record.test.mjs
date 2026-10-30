// The characterization fixture's committed records (lib/cm-fixture/record.mjs) and their diff
// (lib/cm-fixture/record-diff.mjs): what a pull request's diff of the records shows, and what blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA, digest } from '../lib/cm-fixture/events.mjs';
import { renderRecord } from '../lib/cm-fixture/record.mjs';
import { diffRecords } from '../lib/cm-fixture/record-diff.mjs';

// A small trace, as readTrace returns one: a run that adds two turns and compiles each, the second with a summary
// sent as a recall pair whose question is the library's own words.
function trace({ commit = 'aaaa111', label = 'What do you remember from earlier?', refuse = false, violation = null, marker = false, membrane = '0.9.0', cause = null, system = undefined } = {}) {
  const blobs = new Map();
  const blob = (v) => { const id = digest(v); blobs.set(id, v); return id; };
  const user = (n) => [{ type: 'text', text: `m1_${n}ux Continue with part ${n}, please.` }];
  const reply = (n) => [{ type: 'text', text: `m1_${n}ax Here is part ${n} of the answer.` }];
  const events = [];
  const add = (step, n, participant, content) => events.push({ kind: 'action', step, n, op: 'add', args: { participant, content: blob(content) }, result: `${step * 10 + n}` });
  add(1, 0, 'User', user(1));
  add(1, 1, 'Junga', reply(1));
  events.push({ kind: 'compile', step: 1, n: 0, budget: { maxTokens: 1000, reserveForResponse: 100 }, outcome: 'compiled', messages: [
    { sources: ['r:a1.0'], content: blob({ participant: 'User', content: user(1) }), ...(marker ? { marker: { message: true, blocks: [] } } : {}) },
    { sources: ['r:a1.1'], content: blob({ participant: 'Junga', content: reply(1) }) },
  ], violations: [] });
  const request = { ...(system === undefined ? {} : { system }), messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarise what follows, in about 133 tokens.' }, ...user(1), ...reply(1)] }] };
  events.push({ kind: 'call', step: 1, n: 0, carried: [], target: 133, request: blob(request), answer: { kind: 'text', text: blob('Summary of part one, in the stand-in\'s words.') } });
  events.push({ kind: 'step', step: 1, written: [{ id: 'L1-0', level: 1, sources: ['a1.0', 'a1.1'], content: blob('Summary of part one, in the stand-in\'s words.') }], removed: [], waiting: null, pending: null, ready: true, logs: { 'plan-vs-actual': 1 }, lines: [], violations: [] });
  add(2, 0, 'User', user(2));
  events.push(refuse
    ? { kind: 'compile', step: 2, n: 0, budget: { maxTokens: 1000, reserveForResponse: 100 }, outcome: 'refused', error: { class: 'OverBudgetError', message: blob('over') }, violations: [] }
    : { kind: 'compile', step: 2, n: 0, budget: { maxTokens: 1000, reserveForResponse: 100 }, outcome: 'compiled', messages: [
      { sources: ['s:L1-0@1'], content: blob({ participant: 'Context Manager', content: [{ type: 'text', text: label }] }) },
      { sources: ['s:L1-0@1'], content: blob({ participant: 'Junga', content: [{ type: 'text', text: 'Summary of part one, in the stand-in\'s words.' }] }) },
      { sources: ['r:a2.0'], content: blob({ participant: 'User', content: user(2) }) },
    ], ...(cause ? { layout: { cause, memberIds: [] } } : {}), violations: violation ? [violation] : [] });
  events.push({ kind: 'step', step: 2, written: [], removed: [], waiting: null, pending: null, ready: true, logs: {}, lines: [], violations: [] });
  const header = { kind: 'run', schema: SCHEMA, run: 'C3/W1', config: 'C3', workload: 'W1', variant: null, arm: 'candidate', seed: 7, scale: 15, from: null, library: { commit, version: '0.24.2' }, membrane: { version: membrane }, fixture: { version: 'f', standin: 's1', clock: { epoch: '2026-01-05T09:00:00.000Z', stepMs: 240000 } } };
  return { header, events, blobs, end: { kind: 'end', ok: true, wallMs: 3 } };
}

test('a run recorded at another commit, with nothing else changed, matches its record', () => {
  const d = diffRecords(renderRecord(trace({ commit: 'aaaa111' })), renderRecord(trace({ commit: 'bbbb222' })));
  assert.equal(d.same, true);
  assert.deepEqual(d.header, []);
});

test('consecutive messages the run added read as a range, the summary as its recall pair, and words the workload wrote as references', () => {
  const r = renderRecord(trace());
  assert.match(r, /^ {2}compile a1\.0-a1\.1$/m);
  assert.match(r, /^ {2}compile L1-0@1\[T:context-manager-L1,T:junga-L1\] a2\.0$/m);
  assert.match(r, /^T:context-manager-L1 = .*What do you remember from earlier\?/m);
  assert.match(r, /^T:junga-L1 = .*\{\{summary\}\}/m);
  assert.doesNotMatch(r, /Continue with part/);
  // A cache marker ends a range and shows as ^.
  assert.match(renderRecord(trace({ marker: true })), /^ {2}compile a1\.0\^ a1\.1$/m);
});

test('a compile whose layout names why the selection moved shows that cause on its line, and a change of it is a change', () => {
  const without = renderRecord(trace()), withCause = renderRecord(trace({ cause: 'window' }));
  assert.match(withCause, /^ {2}compile L1-0@1\[T:context-manager-L1,T:junga-L1\] a2\.0 cause window$/m);
  assert.doesNotMatch(without, / cause /);
  assert.equal(diffRecords(without, withCause).same, false);
  assert.equal(diffRecords(withCause, renderRecord(trace({ cause: 'budget-fit' }))).same, false);
});

test('a change of the library\'s words is one change, in the template table alone', () => {
  const before = renderRecord(trace()), after = renderRecord(trace({ label: 'What do you recall of what came before?' }));
  const changed = after.split('\n').filter((l, i) => l !== before.split('\n')[i]);
  assert.deepEqual(changed.map((l) => l.split(' = ')[0]), ['T:context-manager-L1']);
  const d = diffRecords(before, after);
  assert.equal(d.same, false);
  assert.deepEqual(d.groups.map((g) => g.kind), ['words']);
  assert.match(d.groups[0].before, /remember from earlier/);
  assert.match(d.groups[0].after, /recall of what came before/);
  assert.deepEqual(d.blocking, []);
});

test('a compile the record has that now refuses blocks, and so does an invariant the record holds that now breaks', () => {
  const base = renderRecord(trace());
  const refused = diffRecords(base, renderRecord(trace({ refuse: true })));
  assert.equal(refused.blocking.length, 1);
  assert.match(refused.blocking[0].why, /now refuses/);
  assert.ok(refused.groups.some((g) => g.kind === 'outcome'));
  const broken = diffRecords(base, renderRecord(trace({ violation: { invariant: 'shape', detail: 'message 0: result t1 answers no call' } })));
  assert.equal(broken.blocking.length, 1);
  assert.match(broken.blocking[0].actual, /INVARIANT shape/);
  // Back the other way, a compile that now compiles, or an invariant that now holds, is a change but blocks nothing.
  assert.deepEqual(diffRecords(renderRecord(trace({ refuse: true })), base).blocking, []);
});

test("a summariser request's system prompt, where a host's setSystemPrompt goes, is part of its template", () => {
  const none = renderRecord(trace()), one = renderRecord(trace({ system: 'You are Junga.' })), other = renderRecord(trace({ system: 'You are Junga, revised.' }));
  assert.notEqual(none, one, 'setting a system prompt changes the record');
  assert.notEqual(one, other, 'changing it changes the record');
  assert.match(one, /You are Junga\./);
  assert.equal(renderRecord(trace({ system: 'You are Junga.' })), one, 'the same prompt renders the same record');
});

test('what a record depends on besides the library, such as membrane\'s version, shows as a header change', () => {
  const d = diffRecords(renderRecord(trace()), renderRecord(trace({ membrane: '0.9.1' })));
  assert.equal(d.same, false);
  assert.equal(d.header.length, 1);
  assert.match(d.header[0].actual, /membrane 0\.9\.1/);
});
