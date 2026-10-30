// The characterization fixture's trace schema (lib/cm-fixture/events.mjs): what the recorder writes and the
// comparison reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA, canonicalJSON, digest, readTrace, runId, parseRunId, traceFileName, sourceStrings, normalizeMessage,
  logTag, maskTiming, readable, isUnreadable,
} from '../lib/cm-fixture/events.mjs';

const blob = (value) => ({ kind: 'blob', id: digest(value), value });
const header = { kind: 'run', schema: SCHEMA, run: 'C7/W5', config: 'C7', workload: 'W5', variant: null, arm: 'base', seed: 5, scale: 'lane', from: 'C7/W2@phase:end', library: { commit: 'fb4cf1046', version: '0.24.2' }, membrane: { version: '0.9.0' }, fixture: { version: 'abc' } };
const content = { participant: 'User', content: [{ type: 'text', text: 'm5_1ux Continue reading.' }] };
const compiled = { kind: 'compile', step: 1, n: 0, budget: { maxTokens: 20000, reserveForResponse: 2048 }, outcome: 'compiled', messages: [{ sources: ['r:1'], content: digest(content) }], violations: [] };
const end = { kind: 'end', ok: true, wallMs: 12 };
const lines = (...events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

test('a whole trace reads into its header, events, blobs and end', () => {
  const t = readTrace(lines(header, blob(content), compiled, end));
  assert.equal(t.header.run, 'C7/W5');
  assert.equal(t.events.length, 1);
  assert.deepEqual(t.blobs.get(digest(content)), content);
  assert.equal(t.end.ok, true);
});

test('a trace that is cut off, malformed or names a blob it never wrote is refused, naming the line', () => {
  assert.throws(() => readTrace(lines(header, blob(content), compiled)), /no end; the run was cut off/);
  assert.throws(() => readTrace(lines(header, compiled, blob(content), end)), /trace:2: names blob [0-9a-f]{16} before it's written/);
  assert.throws(() => readTrace(lines(blob(content), header, end)), /trace:1: a trace opens with run, not blob/);
  assert.throws(() => readTrace(lines(header, { ...compiled, extra: 1 }, end)), /trace:2: compile with unknown field extra/);
  assert.throws(() => readTrace(lines(header, { ...blob(content), value: { other: 1 } }, end)), /trace:2: blob id is not its value's digest/);
  assert.throws(() => readTrace(lines({ ...header, run: 'C7/W11', workload: 'W11' }, end)), /trace:1: not a run id/);
  assert.throws(() => readTrace(lines(header, end, compiled)), /trace:3: an event after end/);
  assert.throws(() => readTrace(lines(header, { ...compiled, outcome: 'refused', messages: undefined }, end)), /a refused compile without its error/);
  const call = { kind: 'call', step: 1, n: 0, carried: ['L1-0', 'm5_2ux'], target: 133, request: digest(content), answer: { kind: 'text' } };
  assert.equal(readTrace(lines(header, blob(content), call, end)).events[0].kind, 'call');
  assert.throws(() => readTrace(lines(header, blob(content), { ...call, carried: ['m5_2ux', 'L1-0'] }, end)), /trace:3: call.carried is not sorted without repeats/);
});

test('equal values have equal digests whatever their keys\' order, and different values differ', () => {
  assert.equal(digest({ a: 1, b: [1, { c: 2, d: 3 }] }), digest({ b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 }));
  assert.equal(canonicalJSON({ b: 1, a: undefined, c: 'x' }), '{"b":1,"c":"x"}');
  assert.throws(() => canonicalJSON({ a: Number.NaN }), /no JSON for NaN/);
});

test('run ids name a configuration, a workload and an optional variant, and nothing else', () => {
  assert.equal(runId({ config: 'H1.claude-opus-4-6', workload: 'W10', variant: 'speculative-on' }), 'H1.claude-opus-4-6/W10/speculative-on');
  assert.deepEqual(parseRunId('C3/W7/source-only'), { config: 'C3', workload: 'W7', variant: 'source-only' });
  assert.equal(traceFileName('C3/W7/source-only'), 'C3__W7__source-only.jsonl');
  for (const bad of ['C0/W1', 'C3', 'C3/W0', 'H5/W1', 'C3/W1/Bad', 'C3/W1/a/b', '../W1']) assert.throws(() => parseRunId(bad), /not a run id/);
});

test('a compiled message\'s cache markers come apart from its bytes, and an image is kept as its hash', () => {
  const plain = { participant: 'Junga', content: [{ type: 'text', text: 'hi' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] };
  const marked = { ...plain, cacheBreakpoint: true, content: [{ ...plain.content[0], cache_control: { type: 'ephemeral' } }, plain.content[1]] };
  const a = normalizeMessage(plain), b = normalizeMessage(marked);
  assert.equal(digest(a.message), digest(b.message));
  assert.equal(a.marker, null);
  assert.deepEqual(b.marker, { message: true, blocks: [[0, { type: 'ephemeral' }]] });
  assert.equal(b.message.content[1].source.data, undefined);
  assert.match(b.message.content[1].source.sha256, /^[0-9a-f]{64}$/);
  assert.equal(marked.content[0].cache_control.type, 'ephemeral');
});

test('provenance reads as source strings: raw bodies with what they miss, summaries with level and partial', () => {
  assert.deepEqual(sourceStrings({ kind: 'raw', bodies: [{ messageId: '7', sequence: 7, complete: true }, { messageId: '9', sequence: 9, complete: false, missing: ['shards', 'content'] }] }), ['r:7', 'r:9!shards+content']);
  assert.deepEqual(sourceStrings({ kind: 'summary', summaries: [{ id: 'L2-4', level: 2 }, { id: 'L1-9', level: 1, partial: true }] }), ['s:L2-4@2', 's:L1-9@1~']);
  assert.deepEqual(sourceStrings({ kind: 'injection', namespace: 'agents/junga' }), ['i:agents/junga']);
  assert.deepEqual(sourceStrings({ kind: 'other' }), ['o']);
});

test('a log line counts under its leading tag, and two runs\' lines differing only in timing fields mask equal', () => {
  assert.equal(logTag('[compression-quarantine] on branch \'main\', L1-3 failed ns=agents/junga'), 'compression-quarantine');
  assert.equal(logTag('[autobiographical] recent-window eviction dropped 2 message(s)'), 'autobiographical');
  assert.equal(logTag('no tag here'), '(untagged)');
  const a = '[plan-vs-actual] compileMs=12 planMs: 3.5 chunks=4 ns=agents/junga';
  const b = '[plan-vs-actual] compileMs=40 planMs: 9 chunks=4 ns=agents/junga';
  assert.equal(maskTiming(a), maskTiming(b));
  assert.notEqual(maskTiming(a), maskTiming(b.replace('chunks=4', 'chunks=5')));
});

test('a reader one version lacks, or that throws, reads as unreadable rather than stopping the trace', () => {
  assert.deepEqual(readable(() => [1]), [1]);
  assert.equal(isUnreadable(readable(undefined)), true);
  assert.deepEqual(readable(() => { throw new Error('boom'); }), { unreadable: 'boom' });
  assert.equal(isUnreadable({ unreadable: 'x', other: 1 }), false);
});
