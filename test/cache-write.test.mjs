import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedPrefix, firstDifference, differingParts, compareRuns, exitFor, installSpecs, cleanupWorkdir, cacheReach, partReach, cacheLine, excerpt, differenceLine, verdictStep } from '../lib/cache-write.mjs';
import { listFixtures } from '../lib/stores.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEXT = 'smoke check on 0.10.2 abc123';
const LIMIT = 'one recipe: claude-sonnet-4-5 on the anthropic provider with its default formatter, heartbeat-mcpl as the only MCPL server and the same heartbeat-mcpl for both releases, and subagents, lessons, retrieval, wake and workspace off';
const SYSTEM = "the system prompt's cache and the messages'";
const THINKING = "the messages' cache, and on some models the tools' and the system prompt's too";
const UNPLACED = "a part of the request the caching guide doesn't place";
const MARKERS = "where entries are written and looked up, which one pair of requests can't show";
const EFFORT_ONE_SIDE = "none if it's the model's default, which the check doesn't know";

/** A request as the stand-in records it, with a stored history and the turn's own message. */
function recorded({ system = 'You are the connectome smoke agent.', tools = [{ name: 'heartbeat_set', input_schema: { type: 'object', properties: { at: { type: 'string' } } } }], history = ['stored turn 1', 'SMOKE-REPLY old'], own = TEXT, ownBlocks = [], beta = null, extra = {} } = {}) {
  const messages = history.map((h, i) => ({ role: i % 2 ? 'assistant' : 'user', content: typeof h === 'string' ? [{ type: 'text', text: h }] : h }));
  messages.push({ role: 'user', content: [{ type: 'text', text: own }, ...ownBlocks] });
  return {
    at: new Date().toISOString(), method: 'POST', path: '/v1/messages',
    headers: { 'anthropic-version': '2023-06-01', 'anthropic-beta': beta },
    body: { model: 'claude-sonnet-4-5', max_tokens: 4096, system, tools, messages, stream: true, ...extra },
  };
}

const prefix = (r, text = TEXT) => cachedPrefix(r, text);
const ok = (version, request, text = TEXT) => ({ version, ok: true, couldNotRun: false, sent: { text, request } });
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };

test('cachedPrefix keeps what the cache reads, the request headers last, and leaves out the turn\'s own message and what follows it', () => {
  const r = recorded({ beta: 'interleaved-thinking-2025-05-14' });
  r.body.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'a prefill after the turn' }] });
  const p = prefix(r);
  assert.deepEqual(Object.keys(p), ['model', 'tools', 'system', 'settings', 'messages', 'images', 'citations', 'markers', 'anthropic-version', 'anthropic-beta']);
  assert.deepEqual(p.markers, {});
  assert.deepEqual(p.messages.map((m) => m.content[0].text), ['stored turn 1', 'SMOKE-REPLY old']);
  assert.equal(p.model, 'claude-sonnet-4-5');
  assert.equal(p['anthropic-version'], '2023-06-01');
  assert.equal(p['anthropic-beta'], 'interleaved-thinking-2025-05-14');
  assert.deepEqual(p.settings, {});
  assert.equal(p.images, false);
  assert.equal(p.citations, false);
});

test('the prefix ends at the first message that carries the turn\'s text, since the text\'s nonce is this turn\'s alone', () => {
  const long = prefix(recorded({ history: ['one', 'two', 'three', 'four'] }));
  assert.deepEqual(long.messages.map((m) => m.content[0].text), ['one', 'two', 'three', 'four']);
  // A message this turn adds before its own that quotes the text is this turn's too, and is left out with it.
  const before = recorded();
  before.body.messages.splice(2, 0, { role: 'user', content: [{ type: 'text', text: `about to answer: ${TEXT}` }] });
  assert.equal(firstDifference(prefix(recorded()), prefix(before)), null);
  // So is one after it that echoes the text, which can't pull the turn's own message into the prefix.
  const after = recorded();
  after.body.messages.push({ role: 'assistant', content: [{ type: 'text', text: `you said: ${TEXT}` }] });
  assert.equal(firstDifference(prefix(recorded()), prefix(after)), null);
  // A turn text no message carries leaves every message in the comparison.
  assert.equal(prefix(recorded(), 'a text nobody sent').messages.length, 3);
});

test('settings are every field but those that shape only the answer, with keys sorted at every depth, so effort, speed and a field nobody has listed are compared and a reorder isn\'t', () => {
  const r = recorded({ extra: { tool_choice: { type: 'auto' }, output_config: { effort: 'high', format: { type: 'json' } }, speed: 'fast', temperature: 1, top_p: 0.9, top_k: 5, stop_sequences: ['x'], metadata: { user_id: 'u' }, some_new_setting: [null, { b: 1, a: 2 }] } });
  assert.deepEqual(prefix(r).settings, { output_config: { effort: 'high', format: { type: 'json' } }, some_new_setting: [null, { a: 2, b: 1 }], speed: 'fast', tool_choice: { type: 'auto' } });
  assert.deepEqual(Object.keys(prefix(r).settings), ['output_config', 'some_new_setting', 'speed', 'tool_choice']);
  // Reordered at the top and inside a setting, and inside an array in a setting: the same.
  const reordered = recorded({ extra: { speed: 'fast', tool_choice: { type: 'auto' }, output_config: { format: { type: 'json' }, effort: 'high' }, some_new_setting: [null, { a: 2, b: 1 }] } });
  assert.equal(firstDifference(prefix(r), prefix(reordered)), null);
  const effort = (e) => prefix(recorded({ extra: { output_config: { effort: e } } }));
  assert.equal(firstDifference(effort('high'), effort('medium')).path, 'settings.output_config.effort');
  assert.equal(firstDifference(prefix(recorded()), prefix(recorded({ extra: { speed: 'fast' } }))).path, 'settings.speed');
});

test('requests that differ only in the turn\'s own text, max_tokens and stream have the same prefix', () => {
  const a = recorded({ own: `${TEXT} first` });
  const b = recorded({ own: `${TEXT} second`, extra: { max_tokens: 8192, stream: false } });
  assert.equal(firstDifference(prefix(a), prefix(b)), null);
});

test('whether the request holds an image counts, wherever its messages hold it, not how many or anything else typed image', () => {
  const withImage = recorded({ ownBlocks: [image] });
  assert.equal(prefix(withImage).images, true);
  const d = firstDifference(prefix(recorded()), prefix(withImage));
  assert.deepEqual([d.path, d.base, d.candidate], ['images', false, true]);
  // Two images where there was one: the presence is the same.
  assert.equal(firstDifference(prefix(withImage), prefix(recorded({ ownBlocks: [image, image] }))), null);
  assert.equal(prefix(recorded({ history: [[{ type: 'text', text: 'look' }, image], 'SMOKE-REPLY old'] })).images, true);
  // In a tool result's content, or a document whose source is content blocks, it counts.
  assert.equal(prefix(recorded({ history: ['go', [{ type: 'tool_result', tool_use_id: 't', content: [image] }]] })).images, true);
  assert.equal(prefix(recorded({ history: [[{ type: 'document', source: { type: 'content', content: [{ type: 'text', text: 'a' }, image] } }], 'ok'] })).images, true);
  // A tool's input typed image, a null block, or content that's a string doesn't.
  assert.equal(prefix(recorded({ history: ['go', [{ type: 'tool_use', id: 't', name: 'draw', input: { type: 'image', at: null } }, null]] })).images, false);
  const plain = recorded();
  plain.body.messages[0].content = 'stored turn 1, as a string';
  assert.equal(prefix(plain).images, false);
});

test('whether any document has citations on counts too, wherever the request holds it, the turn\'s own message included', () => {
  const doc = (enabled) => ({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'a fact' }, ...(enabled === undefined ? {} : { citations: { enabled } }) });
  assert.equal(prefix(recorded({ ownBlocks: [doc(true)] })).citations, true);
  assert.equal(prefix(recorded({ ownBlocks: [doc(false)] })).citations, false);
  assert.equal(prefix(recorded({ ownBlocks: [doc()] })).citations, false);
  assert.equal(prefix(recorded({ history: ['go', [{ type: 'tool_result', tool_use_id: 't', content: [doc(true)] }]] })).citations, true);
  // A search result's own setting counts, and so does a document inside a web fetch's result.
  assert.equal(prefix(recorded({ ownBlocks: [{ type: 'search_result', source: 's', title: 't', content: [{ type: 'text', text: 'x' }], citations: { enabled: true } }] })).citations, true);
  assert.equal(prefix(recorded({ history: ['go', [{ type: 'web_fetch_tool_result', tool_use_id: 't', content: { type: 'web_fetch_result', url: 'u', content: doc(true) } }]] })).citations, true);
  // A tool input that names citations isn't the toggle, nor is a reply's list of the citations it made.
  assert.equal(prefix(recorded({ history: ['go', [{ type: 'tool_use', id: 't', name: 'cite', input: { type: 'document', citations: { enabled: true } } }]] })).citations, false);
  assert.equal(prefix(recorded({ history: ['go', [{ type: 'text', text: 'a fact', citations: [{ type: 'char_location', cited_text: 'a fact' }] }]] })).citations, false);
  assert.equal(prefix(recorded({ history: ['go', [{ type: 'text', text: 'a fact', citations: null }]] })).citations, false);
  // Nor is a server tool call's input, however it's shaped.
  assert.equal(prefix(recorded({ history: ['go', [{ type: 'server_tool_use', id: 's', name: 'web_fetch', input: { type: 'document', citations: { enabled: true }, image: { type: 'image' } } }]] })).citations, false);
  assert.equal(prefix(recorded({ history: ['go', [{ type: 'server_tool_use', id: 's', name: 'web_fetch', input: { content: [{ type: 'image' }] } }]] })).images, false);
  const d = differingParts(prefix(recorded({ ownBlocks: [doc(false)] })), prefix(recorded({ ownBlocks: [doc(true)] })));
  assert.deepEqual(d.map((p) => [p.path, cacheReach(p.path)]), [['citations', SYSTEM]]);
});

test('firstDifference names the first place two values differ, with each side\'s value there', () => {
  assert.equal(firstDifference({ a: [1, { b: 'x' }] }, { a: [1, { b: 'x' }] }), null);
  assert.deepEqual(firstDifference({ a: [1, { b: 'x' }] }, { a: [1, { b: 'y' }] }), { path: 'a[1].b', base: 'x', candidate: 'y', offset: 0 });
  assert.deepEqual(firstDifference({ s: 'Open a channel to start' }, { s: 'Open a channel. What' }), { path: 's', base: 'Open a channel to start', candidate: 'Open a channel. What', offset: 14 });
  assert.equal(firstDifference({ s: 'abc' }, { s: 'abcd' }).offset, 3);
  // Two astral characters that share their first half: the offset is where the character starts.
  assert.equal(firstDifference({ s: 'a🙂' }, { s: 'a🙃' }).offset, 1);
  assert.deepEqual(firstDifference({ a: [1] }, { a: [1, 2] }), { path: 'a[1]', base: undefined, candidate: 2 });
  assert.deepEqual(firstDifference({ a: [1, 2] }, { a: [1] }), { path: 'a[1]', base: 2, candidate: undefined });
  assert.deepEqual(firstDifference({ a: 1 }, { a: '1' }), { path: 'a', base: 1, candidate: '1' });
  assert.deepEqual(firstDifference({ a: null }, { a: {} }), { path: 'a', base: null, candidate: {} });
  assert.deepEqual(firstDifference({ a: 1, b: 2 }, { a: 1 }), { path: 'b', base: 2, candidate: undefined });
  assert.deepEqual(firstDifference({ a: 1 }, { a: 1, 'cache-control': 2 }), { path: 'cache-control', base: undefined, candidate: 2 });
  assert.deepEqual(firstDifference({ 'a b': 1 }, { 'a b': 2 }), { path: '["a b"]', base: 1, candidate: 2 });
});

test('a named element is named in the path, from the candidate where only it has one', () => {
  assert.equal(firstDifference({ t: [{ name: 'channel_open', d: 'a' }] }, { t: [{ name: 'channel_open', d: 'b' }] }).path, 't[0:channel_open].d');
  const added = firstDifference({ t: [{ name: 'a' }] }, { t: [{ name: 'a' }, { name: 'b' }] });
  assert.deepEqual([added.path, added.base, added.candidate], ['t[1:b]', undefined, { name: 'b' }]);
  const removed = firstDifference({ t: [{ name: 'a' }, { name: 'b' }] }, { t: [{ name: 'a' }] });
  assert.equal(removed.path, 't[1:b]');
});

test('a reordered object differs at its first key out of place, since it is sent as other bytes', () => {
  const d = firstDifference({ s: { type: 'object', properties: {} } }, { s: { properties: {}, type: 'object' } });
  assert.deepEqual(d, { path: 's (key order)', base: ['type', 'properties'], candidate: ['properties', 'type'] });
});

test('the request shapes a host change can take each show where they first differ', () => {
  const tool = (name) => ({ name, input_schema: { type: 'object' } });
  const tools = (names) => prefix(recorded({ tools: names.map(tool) }));
  assert.equal(firstDifference(tools(['a', 'b']), tools(['a', 'x', 'b'])).path, 'tools[1:b].name');
  assert.equal(firstDifference(tools(['a', 'b']), tools(['a'])).path, 'tools[1:b]');
  assert.equal(firstDifference(tools(['a', 'b']), tools(['b', 'a'])).path, 'tools[0:a].name');
  const blocks = prefix(recorded({ system: [{ type: 'text', text: 'You are the connectome smoke agent.' }] }));
  assert.equal(firstDifference(prefix(recorded()), blocks).path, 'system');
  const marked = (i) => prefix(recorded({ history: ['one', 'two'].map((t, j) => [{ type: 'text', text: t, ...(i === j ? { cache_control: { type: 'ephemeral' } } : {}) }]) }));
  assert.equal(firstDifference(marked(0), marked(1)).path, 'markers["messages[0].content[0]"]');
  // A stored tool_use block's input keys reordered reach the cache, by the guide.
  const used = (input) => prefix(recorded({ history: ['go', [{ type: 'tool_use', id: 'toolu_1', name: 'heartbeat_set', input }]] }));
  assert.equal(firstDifference(used({ at: '1', why: 'x' }), used({ why: 'x', at: '1' })).path, 'messages[1].content[0:heartbeat_set].input (key order)');
});

test('differingParts names every part that differs, so one can\'t hide another of wider reach', () => {
  const paths = (a, b) => differingParts(prefix(a), prefix(b)).map((d) => d.path);
  // A beta change beside a tools one: the tools write is named, before the headers.
  assert.deepEqual(paths(recorded(), recorded({ beta: 'some-beta', tools: [] })), ['tools[0:heartbeat_set]', 'anthropic-beta']);
  // Each changed tool is named, the unchanged ones not.
  const tool = (name, description = name) => ({ name, description, input_schema: { type: 'object' } });
  const tools = (...list) => recorded({ tools: list });
  assert.deepEqual(paths(tools(tool('a', 'x'), tool('b', 'y'), tool('c', 'z')), tools(tool('a', 'X'), tool('b', 'y'), tool('c', 'Z'))),
    ['tools[0:a].description', 'tools[2:c].description']);
  // By name: a tool added before others, or one removed, is named itself, and the rest aren't.
  assert.deepEqual(paths(tools(tool('a'), tool('b')), tools(tool('x'), tool('a'), tool('b'))), ['tools[0:x]']);
  assert.deepEqual(paths(tools(tool('a'), tool('b'), tool('c')), tools(tool('a'), tool('c'))), ['tools[1:b]']);
  assert.deepEqual(paths(tools(tool('a'), tool('b')), tools(tool('a'), tool('b'), tool('c'))), ['tools[2:c]']);
  // Kept tools in another order are one part, its values from the first tool out of place.
  const order = (a, b) => differingParts(prefix(a), prefix(b)).find((d) => d.path === 'tools (order)');
  assert.deepEqual(paths(tools(tool('a'), tool('b')), tools(tool('b'), tool('a'))), ['tools (order)']);
  assert.deepEqual(order(tools(tool('a'), tool('b'), tool('c')), tools(tool('a'), tool('c'), tool('b'))), { path: 'tools (order)', base: ['b', 'c'], candidate: ['c', 'b'] });
  // A reorder beside an added, a removed and a changed tool: each named, and the order part once.
  assert.deepEqual(paths(tools(tool('a'), tool('b'), tool('c'), tool('d')), tools(tool('x'), tool('c', 'changed'), tool('a'), tool('d'))),
    ['tools[0:x]', 'tools[1:c].description', 'tools[1:b]', 'tools (order)']);
  // A missing name on either side, or a repeated one, is matched by place, past the shorter list too.
  assert.deepEqual(paths(tools(tool('a'), tool('b')), tools(tool('a'), { description: 'b' })), ['tools[1:b].name']);
  assert.deepEqual(paths(tools(tool('a'), tool('a')), tools(tool('a'), tool('a', 'changed'), tool('c'))), ['tools[1:a].description', 'tools[2:c]']);
  assert.deepEqual(paths(recorded({ tools: null }), tools(tool('a'), tool('b'))), ['tools[0:a]', 'tools[1:b]']);
  assert.deepEqual(paths(tools(tool('a')), recorded({ tools: null })), ['tools[0:a]']);
  // An empty list of tools and none differ: nothing shows the API renders them alike, and
  // a missed write costs more than a false one.
  assert.deepEqual(paths(recorded({ tools: [] }), recorded({ tools: null })), ['tools']);
  assert.deepEqual(prefix(recorded({ tools: [] })).tools, []);
  // Without a name of its own on every tool, by place.
  assert.deepEqual(paths(tools({ description: 'p' }, tool('b')), tools({ description: 'q' }, tool('b'))), ['tools[0].description']);
  // A system change beside a thinking one, and effort apart from output_config's other keys.
  assert.deepEqual(paths(recorded({ extra: { thinking: { type: 'enabled' }, output_config: { effort: 'high', format: 'a' } } }), recorded({ system: 'Other.', extra: { thinking: { type: 'adaptive' }, output_config: { effort: 'low', format: 'b' } } })),
    ['system', 'settings.output_config.effort', 'settings.output_config.format', 'settings.thinking.type']);
  // output_config on one side only: split as if the other had an empty one, or whole when that finds nothing.
  assert.deepEqual(paths(recorded(), recorded({ extra: { output_config: { effort: 'high' } } })), ['settings.output_config.effort']);
  assert.deepEqual(paths(recorded({ extra: { output_config: { effort: 'high' }, speed: 'fast' } }), recorded()), ['settings.output_config.effort', 'settings.speed']);
  assert.deepEqual(paths(recorded(), recorded({ extra: { output_config: {} } })), ['settings.output_config']);
  // A message holding an image, added to the stored history: the message first, then the image flag.
  assert.deepEqual(paths(recorded(), recorded({ history: ['stored turn 1', 'SMOKE-REPLY old', [image], 'ok'] })), ['messages[2]', 'images']);
  assert.deepEqual(differingParts(prefix(recorded()), prefix(recorded())), []);
});

test('compareRuns: same, a write with each part that differs, and noise when the base\'s own two runs differ, each run with its own turn text', () => {
  const run = (label, request) => ok(request.version, recorded({ ...request.opts, own: `smoke check ${label} ${request.version}` }), `smoke check ${label} ${request.version}`);
  const at = (version, opts = {}) => ({ version, opts });
  const verdicts = compareRuns(
    [run('b1', at('0.9.0')), run('b1', at('0.10.0')), run('b1', at('0.10.1'))],
    [run('b2', at('0.9.0')), run('b2', at('0.10.0')), run('b2', at('0.10.1', { system: 'You are the connectome smoke agent. It is 17:52.' }))],
    [run('c', at('0.9.0')), run('c', at('0.10.0', { system: 'Changed.', beta: 'b' })), run('c', at('0.10.1', { system: 'Changed.' }))],
  );
  assert.deepEqual(verdicts.map((v) => [v.version, v.verdict, v.difference?.path ?? null]), [
    ['0.9.0', 'same', null],
    ['0.10.0', 'differs', 'system'],
    ['0.10.1', 'noise', 'system'],
  ]);
  assert.deepEqual(verdicts[1].parts.map((p) => p.path), ['system', 'anthropic-beta']);
  // A difference only where the guide doesn't place is one the check can't tell for.
  const [unplaced] = compareRuns([run('b1', at('0.10.3'))], [run('b2', at('0.10.3'))], [run('c', at('0.10.3', { beta: 'b' }))]);
  assert.deepEqual([unplaced.verdict, unplaced.parts.map((p) => p.path)], ['unplaced', ['anthropic-beta']]);
  assert.equal(exitFor([unplaced]), 2);
  assert.equal(verdicts[1].difference.candidate, 'Changed.');
  assert.equal(verdicts[2].difference.base, 'You are the connectome smoke agent.');
  assert.equal(verdicts[2].difference.candidate, 'You are the connectome smoke agent. It is 17:52.');
});

test('compareRuns: every fixture any run has, by version whatever the order, with the runs that have no result for it and those that never ran it', () => {
  const base = recorded();
  const failed = { version: '0.10.0', ok: false, couldNotRun: false, sent: { text: TEXT, request: base } };
  const unsent = { version: '0.9.0', ok: true, couldNotRun: false, sent: null };
  const verdicts = compareRuns(
    [ok('0.10.1', base), ok('0.9.0', base), ok('0.10.0', base)],
    [ok('0.9.0', base), failed, ok('0.10.1', base), ok('0.8.0', base)],
    [unsent, ok('0.10.0', base), ok('0.10.1', base), ok('0.11.0', base)],
  );
  assert.deepEqual(verdicts.map((v) => [v.version, v.verdict, v.missing ?? null, v.absent ?? null]), [
    ['0.10.1', 'same', null, null],
    ['0.9.0', 'not run', ['candidate'], []],
    ['0.10.0', 'not run', ['base-2'], []],
    ['0.8.0', 'not run', ['base-1', 'candidate'], ['base-1', 'candidate']],
    ['0.11.0', 'not run', ['base-1', 'base-2'], ['base-1', 'base-2']],
  ]);
});

test('compareRuns judges every fixture the lane set out to check, so one that vanished from every run is not run', () => {
  const base = recorded();
  const verdicts = compareRuns([ok('0.10.1', base)], [ok('0.10.1', base)], [ok('0.10.1', base)], ['0.10.1', '0.10.2']);
  assert.deepEqual(verdicts.map((v) => [v.version, v.verdict, v.absent ?? null]), [['0.10.1', 'same', null], ['0.10.2', 'not run', ['base-1', 'base-2', 'candidate']]]);
  assert.equal(exitFor(verdicts), 2);
});

test('cache markers are compared apart from the prefix: one that moves, appears, goes or changes its TTL is one the check can\'t tell for, and a change beneath it still shows', () => {
  const marker = (ttl) => ({ cache_control: { type: 'ephemeral', ...(ttl ? { ttl } : {}) } });
  const at = (i, ttl, texts = ['one', 'two']) => recorded({ history: texts.map((t, j) => [{ type: 'text', text: t, ...(i === j ? marker(ttl) : {}) }]) });
  const verdict = (b, c) => compareRuns([ok('0.1.0', b)], [ok('0.1.0', b)], [ok('0.1.0', c)])[0];
  for (const [b, c, paths] of [
    // Moved: gone from one place and come to another, each named.
    [at(0), at(1), ['markers["messages[0].content[0]"]', 'markers["messages[1].content[0]"]']],
    [at(-1), at(1), ['markers["messages[1].content[0]"]']],
    [at(1), at(-1), ['markers["messages[1].content[0]"]']],
    [at(1), at(1, '1h'), ['markers["messages[1].content[0]"].ttl']],
  ]) {
    const v = verdict(b, c);
    assert.deepEqual([v.verdict, v.parts.map((p) => p.path)], ['unplaced', paths]);
    assert.equal(exitFor([v]), 2);
    assert.match(verdictStep(v).message, new RegExp(`\\(${MARKERS}\\)$`));
  }
  // A marker that moved in an early message doesn't hide a change further on.
  const v = verdict(at(0), at(1, undefined, ['one', 'TWO']));
  assert.deepEqual([v.verdict, v.parts.map((p) => p.path)], ['differs', ['messages[1].content[0].text', 'markers["messages[0].content[0]"]', 'markers["messages[1].content[0]"]']]);
  assert.equal(exitFor([v]), 1);
  // Markers on a tool, a system block, the turn's own message and the request itself count;
  // a key so named inside a tool call's input is the model's data.
  const r = recorded({ system: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }], tools: [{ name: 'heartbeat_set', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    history: ['go', [{ type: 'tool_use', id: 't', name: 'heartbeat_set', input: { cache_control: 'data' } }]], ownBlocks: [{ type: 'text', text: 'more', cache_control: { type: 'ephemeral' } }], extra: { cache_control: { type: 'ephemeral' } } });
  const p = prefix(r);
  assert.deepEqual(p.markers, { automatic: { type: 'ephemeral' }, 'tools[0:heartbeat_set]': { type: 'ephemeral', ttl: '1h' }, 'system[0]': { type: 'ephemeral' }, 'messages[2].content[1]': { type: 'ephemeral' } });
  // A marker's keys in another order are the same marker, the request's own included; each marker that differs is a part of its own.
  const auto = (cc) => prefix(recorded({ extra: { cache_control: cc } }));
  assert.equal(firstDifference(auto({ type: 'ephemeral', ttl: '1h' }), auto({ ttl: '1h', type: 'ephemeral' })), null);
  const toolMarked = (cc) => prefix(recorded({ tools: [{ name: 't', input_schema: { type: 'object', properties: { cache_control: { type: 'string' } } }, cache_control: cc }] }));
  assert.equal(firstDifference(toolMarked({ type: 'ephemeral', ttl: '1h' }), toolMarked({ ttl: '1h', type: 'ephemeral' })), null);
  // A marked tool keeps its whole definition, a schema property so named included.
  assert.deepEqual([toolMarked({ type: 'ephemeral' }).tools, toolMarked({ type: 'ephemeral' }).markers],
    [[{ name: 't', input_schema: { type: 'object', properties: { cache_control: { type: 'string' } } } }], { 'tools[0:t]': { type: 'ephemeral' } }]);
  // Markers met in another order, as a block's own and one inside it can be, are the same
  // markers, and the block without its marker keeps its other keys' order.
  const nested = (outerFirst) => prefix(recorded({ history: ['go', [outerFirst
    ? { type: 'tool_result', tool_use_id: 't', cache_control: { type: 'ephemeral' }, content: [{ type: 'text', text: 'r', cache_control: { type: 'ephemeral' } }] }
    : { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'r', cache_control: { type: 'ephemeral' } }], cache_control: { type: 'ephemeral' } }]] }));
  assert.deepEqual(differingParts(nested(true), nested(false)), []);
  const reordered = recorded({ history: [[{ type: 'text', text: 'one', cache_control: { ttl: '1h', type: 'ephemeral' } }], 'two'] });
  assert.equal(firstDifference(prefix(recorded({ history: [[{ type: 'text', text: 'one', cache_control: { type: 'ephemeral', ttl: '1h' } }], 'two'] })), prefix(reordered)), null);
  const two = verdict(at(-1), recorded({ history: ['one', 'two'].map((t) => [{ type: 'text', text: t, ...marker() }]) }));
  assert.deepEqual(two.parts.map((p) => p.path), ['markers["messages[0].content[0]"]', 'markers["messages[1].content[0]"]']);
  // A tool's marker is its own: a schema property so named is the tool's definition, and a change to it a write.
  const schema = (t) => recorded({ tools: [{ name: 'cache_tool', input_schema: { type: 'object', properties: { cache_control: { type: t } } } }] });
  assert.deepEqual(prefix(schema('string')).markers, {});
  assert.deepEqual(verdict(schema('string'), schema('number')).parts.map((p) => p.path), ['tools[0:cache_tool].input_schema.properties.cache_control.type']);
  // Key order outside a marker survives, and a key named __proto__ stays data.
  assert.equal(firstDifference(prefix(recorded({ system: [{ type: 'text', text: 'S' }] })), prefix(recorded({ system: [{ text: 'S', type: 'text' }] }))).path, 'system[0] (key order)');
  const proto = (v) => prefix(recorded({ system: [JSON.parse(`{"type":"text","text":"S","__proto__":${v}}`)] }));
  assert.equal(firstDifference(proto('1'), proto('2')).path, 'system[0].__proto__');
  assert.deepEqual([p.tools, p.system], [[{ name: 'heartbeat_set', input_schema: { type: 'object' } }], [{ type: 'text', text: 'S' }]]);
  assert.deepEqual(p.messages[1].content[0].input, { cache_control: 'data' });
  assert.deepEqual(p.settings, {});
});

test('an effort given on one side only is one the check can\'t tell for, since the model\'s default given explicitly writes nothing', () => {
  const effort = (e) => recorded(e === undefined ? {} : { extra: { output_config: { effort: e } } });
  const verdict = (b, c) => compareRuns([ok('0.1.0', effort(b))], [ok('0.1.0', effort(b))], [ok('0.1.0', effort(c))])[0];
  for (const [b, c] of [[undefined, 'high'], ['high', undefined], [undefined, 'low']]) {
    const v = verdict(b, c);
    assert.deepEqual([v.verdict, v.parts.map((p) => p.path), partReach(v.parts[0])], ['unplaced', ['settings.output_config.effort'], EFFORT_ONE_SIDE]);
    assert.equal(exitFor([v]), 2);
  }
  // Set on both sides, a change of effort reaches the messages' cache, as the guide says.
  const v = verdict('high', 'low');
  assert.deepEqual([v.verdict, partReach(v.parts[0])], ['differs', THINKING]);
  assert.equal(cacheLine([v]), `Cache: a write found in 1 of the 1 fixtures' requests (${LIMIT}), where they differ at settings.output_config.effort (${THINKING}).`);
});

test('exitFor: a write anywhere is 1, every fixture the same is 0, and anything else is 2', () => {
  const v = (verdict) => ({ version: 'x', verdict });
  assert.equal(exitFor([v('same'), v('differs'), v('noise'), v('not run')]), 1);
  assert.equal(exitFor([v('same'), v('same')]), 0);
  assert.equal(exitFor([v('same'), v('noise')]), 2);
  assert.equal(exitFor([v('same'), v('not run')]), 2);
  assert.equal(exitFor([]), 2);
});

test('installSpecs makes a local path absolute, leaves a registry spec, and gives each install its cutoff', () => {
  const exists = (path) => ['/w/pkg.tgz', '/w/sub/base.tgz'].includes(path);
  const specs = installSpecs({ base: 'file:sub/base.tgz', candidate: 'pkg.tgz', startedAt: 'T1', cwd: '/w', exists });
  assert.deepEqual(specs, { base: { spec: 'file:/w/sub/base.tgz', before: 'T1' }, candidate: { spec: '/w/pkg.tgz', before: 'T1' } });
  const registry = installSpecs({ base: '@animalabs/connectome-host@latest', candidate: '/elsewhere/missing.tgz', baseBefore: 'T0', startedAt: 'T1', cwd: '/w', exists });
  assert.deepEqual(registry, { base: { spec: '@animalabs/connectome-host@latest', before: 'T0' }, candidate: { spec: '/elsewhere/missing.tgz', before: 'T1' } });
  assert.equal(installSpecs({ base: 'x', candidate: undefined, startedAt: 'T1', exists }).candidate.spec, undefined);
  // A spec that names a path is made absolute even when it's missing, so npm fails naming it.
  const existing = (path) => exists(path) || path === '/w/pkgdir';
  assert.equal(installSpecs({ base: 'b', candidate: 'pkgdir', startedAt: 'T1', cwd: '/w', exists: existing }).candidate.spec, '/w/pkgdir');
  for (const [spec, want] of [['./missing.tgz', '/w/missing.tgz'], ['../up/host.tgz', '/up/host.tgz'], ['missing.tgz', '/w/missing.tgz'], ['./checkout', '/w/checkout'], ['file:gone', 'file:/w/gone'], ['x', 'x'],
    ['https://example.com/host-0.10.3.tgz', 'https://example.com/host-0.10.3.tgz'], ['git+https://example.com/host.git', 'git+https://example.com/host.git'],
    ['@animalabs/connectome-host@https://example.com/host.tgz', '@animalabs/connectome-host@https://example.com/host.tgz']]) {
    assert.equal(installSpecs({ base: 'b', candidate: spec, startedAt: 'T1', cwd: '/w', exists }).candidate.spec, want, spec);
  }
  // With the filesystem itself: a packed release named relatively, as the cutter gives it.
  const dir = mkdtempSync(join(tmpdir(), 'cache-write-specs-'));
  try {
    writeFileSync(join(dir, 'host.tgz'), '');
    assert.equal(installSpecs({ base: 'x', candidate: 'host.tgz', startedAt: 'T1', cwd: dir }).candidate.spec, join(dir, 'host.tgz'));
    assert.equal(installSpecs({ base: 'x', candidate: 'file:host.tgz', startedAt: 'T1', cwd: dir }).candidate.spec, `file:${join(dir, 'host.tgz')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cacheReach says what a difference writes again, by the caching guide\'s table and, for the model, the check\'s own rule', () => {
  assert.equal(cacheReach('tools[11:channel_open].description'), 'the whole cache');
  assert.equal(cacheReach('tools (key order)'), 'the whole cache');
  assert.equal(cacheReach('model'), 'the whole cache, which is kept per model');
  assert.equal(cacheReach('system'), SYSTEM);
  assert.equal(cacheReach('system[0].text'), SYSTEM);
  assert.equal(cacheReach('settings.speed'), SYSTEM);
  assert.equal(cacheReach('citations'), SYSTEM);
  assert.equal(cacheReach('messages[2].content[0].citations.enabled'), "the messages' cache from that message on");
  assert.equal(cacheReach('settings.tool_choice.type'), "the messages' cache");
  assert.equal(cacheReach('images'), "the messages' cache");
  assert.equal(cacheReach('settings.thinking'), THINKING);
  assert.equal(cacheReach('settings.output_config.effort'), THINKING);
  assert.equal(cacheReach('markers["messages[3].content[0]"].ttl'), MARKERS);
  assert.equal(cacheReach('markers.automatic'), MARKERS);
  assert.equal(cacheReach('messages[3].content[0].text'), "the messages' cache from that message on");
  assert.equal(cacheReach('messages[3].content[0].citations_note'), "the messages' cache from that message on");
  for (const path of ['anthropic-version', 'anthropic-beta', 'settings.some_new_setting', 'settings.speed_limit', 'settings.output_config.format', 'settings.output_config', 'settings.thinking_budget']) {
    assert.equal(cacheReach(path), UNPLACED, path);
  }
});

test('cacheLine says none found with the check\'s limit, a write with each reach and up to two of its places, or that it couldn\'t tell and why', () => {
  const same = (version) => ({ version, verdict: 'same' });
  const differs = (version, ...paths) => ({ version, verdict: 'differs', difference: { path: paths[0] }, parts: paths.map((path) => ({ path })) });
  const noise = { version: '0.10.2', verdict: 'noise', difference: { path: 'system' } };
  assert.equal(cacheLine([same('0.9.0'), same('0.10.0')]), `Cache: none found in the 2 fixtures' requests (${LIMIT}).`);
  assert.equal(cacheLine([same('0.9.0'), differs('0.10.0', 'tools[3:a].description', 'anthropic-beta'), differs('0.10.1', 'tools[3:a].description'), noise]),
    `Cache: a write found in 2 of the 4 fixtures' requests (${LIMIT}), where they differ at tools[3:a].description (the whole cache); anthropic-beta (${UNPLACED}). It couldn't tell for 1: 0.10.2, whose base's own two runs differ at system.`);
  // Every reach is named, in the request's order, however many places come before it.
  assert.equal(cacheLine([differs('0.9.0', 'messages[1]', 'messages[3]', 'messages[5]', 'images'), differs('0.10.0', 'settings.tool_choice'), differs('0.10.1', 'tools[0:a]'), differs('0.10.2', 'model', 'system', 'citations')]),
    `Cache: a write found in 4 of the 4 fixtures' requests (${LIMIT}), where they differ at model (the whole cache, which is kept per model); tools[0:a] (the whole cache); system, citations (${SYSTEM}); settings.tool_choice, images (the messages' cache); messages[1], messages[3] and 1 more (the messages' cache from that message on).`);
  assert.equal(cacheLine([same('0.9.0'), noise, { version: '0.10.1', verdict: 'not run', missing: ['base-1', 'candidate'], absent: ['candidate'] }, { version: '0.10.3', verdict: 'unplaced', parts: [{ path: 'anthropic-beta' }, { path: 'anthropic-version' }] }]),
    "Cache: couldn't tell, for 3 of the 4 fixtures (0.10.2, whose base's own two runs differ at system; 0.10.1, whose stores step failed in the base's first run, and which the candidate's run never ran; 0.10.3, which differs only at anthropic-beta and anthropic-version, where the check can't tell what is written again).");
  assert.equal(cacheLine([]), "Cache: couldn't tell, for 0 of the 0 fixtures (no fixtures).");
  // A place keeps each reach it has across fixtures, and the markers come in the request's order.
  const effortOneSide = { path: 'settings.output_config.effort', base: undefined, candidate: 'high' };
  const effortChanged = { path: 'settings.output_config.effort', base: 'high', candidate: 'low' };
  const marker = { path: 'markers["messages[0].content[0]"]', base: { type: 'ephemeral' }, candidate: undefined };
  const write = (version, ...parts) => ({ version, verdict: 'differs', difference: parts[0], parts });
  assert.equal(cacheLine([write('0.9.0', { path: 'system', base: 'a', candidate: 'b' }, effortOneSide, marker), write('0.10.0', effortChanged)]),
    `Cache: a write found in 2 of the 2 fixtures' requests (${LIMIT}), where they differ at system (${SYSTEM}); settings.output_config.effort (none if it's the model's default, which the check doesn't know); settings.output_config.effort (${THINKING}); markers["messages[0].content[0]"] (where entries are written and looked up, which one pair of requests can't show).`);
});

test('differenceLine shows each side from a little before the first character that differs, saying how many come before it', () => {
  const pad = 'x'.repeat(200);
  assert.equal(differenceLine(firstDifference({ d: `${pad}Open a channel to start` }, { d: `${pad}Open a channel. What` })),
    'd, after 214 characters: base "…xxxxxxOpen a channel to start", candidate "…xxxxxxOpen a channel. What"');
  // At the string's start there's nothing before it to elide; past 100 characters after it, the rest is.
  const tail = 'y'.repeat(150);
  assert.equal(differenceLine(firstDifference({ d: `ab${tail}` }, { d: `ac${tail}` })),
    `d, after 1 character: base "ab${'y'.repeat(98)}…", candidate "ac${'y'.repeat(98)}…"`);
  // An astral character before the difference counts as one, and one that differs is counted from its start.
  assert.match(differenceLine(firstDifference({ d: '🙂 hello' }, { d: '🙂 help' })), /^d, after 5 characters: /);
  assert.match(differenceLine(firstDifference({ d: 'a🙂' }, { d: 'a🙃' })), /^d, after 1 character: base "a🙂", candidate "a🙃"$/);
  // The window starts 20 characters before and runs 100 on, counted in characters, so astral text isn't cut in half.
  const smiles = '🙂'.repeat(150);
  assert.equal(differenceLine(firstDifference({ d: `${smiles}a${smiles}` }, { d: `${smiles}b${smiles}` })),
    `d, after 150 characters: base "…${'🙂'.repeat(20)}a${'🙂'.repeat(79)}…", candidate "…${'🙂'.repeat(20)}b${'🙂'.repeat(79)}…"`);
  assert.equal(differenceLine(firstDifference({ s: 'one' }, { s: 'two' }), 'its second run'), 's, after 0 characters: base "one", its second run "two"');
  assert.equal(differenceLine({ path: 'settings.thinking', base: undefined, candidate: { type: 'adaptive' } }, 'its second run'), 'settings.thinking: base (none), its second run {"type":"adaptive"}');
});

test('verdictStep: the same passes, a write fails naming every part, and the rest are infra saying why', () => {
  const sys = firstDifference('one', 'two', 'system');
  assert.deepEqual(verdictStep({ version: 'x', verdict: 'same' }), { ok: true, message: 'the same prefix' });
  assert.deepEqual(verdictStep({ version: 'x', verdict: 'differs', difference: sys, parts: [sys, { path: 'anthropic-beta', base: null, candidate: 'b' }] }),
    { ok: false, infra: false, message: 'a write, at system, after 0 characters: base "one", candidate "two"; it also differs at anthropic-beta' });
  assert.deepEqual(verdictStep({ version: 'x', verdict: 'noise', difference: sys }),
    { ok: false, infra: true, message: 'couldn\'t tell: the base\'s own two runs differ at system, after 0 characters: base "one", its second run "two"' });
  assert.deepEqual(verdictStep({ version: 'x', verdict: 'unplaced', difference: { path: 'anthropic-beta', base: null, candidate: 'b' }, parts: [{ path: 'anthropic-beta', base: null, candidate: 'b' }] }),
    { ok: false, infra: true, message: `couldn't tell: it differs only where the check can't tell what is written again, at anthropic-beta: base null, candidate "b" (${UNPLACED})` });
  assert.deepEqual(verdictStep({ version: 'x', verdict: 'not run', missing: ['base-2', 'candidate'], absent: ['candidate'] }),
    { ok: false, infra: true, message: 'couldn\'t tell: no result in base-2, candidate (the stores step in base-2 says why); candidate never ran it' });
  assert.equal(verdictStep({ version: 'x', verdict: 'not run', missing: ['base-1'], absent: [] }).message, 'couldn\'t tell: no result in base-1 (the stores step in base-1 says why)');
  assert.equal(verdictStep({ version: 'x', verdict: 'not run', missing: ['candidate'], absent: ['candidate'] }).message, 'couldn\'t tell: no result in candidate; candidate never ran it');
  // One part has no suffix; with several, the write leads with the first part the guide places.
  assert.equal(verdictStep({ version: 'x', verdict: 'differs', difference: sys, parts: [sys] }).message, 'a write, at system, after 0 characters: base "one", candidate "two"');
  const unplacedFirst = { path: 'settings.some_new_setting', base: 1, candidate: 2 };
  assert.equal(verdictStep({ version: 'x', verdict: 'differs', difference: unplacedFirst, parts: [unplacedFirst, sys, { path: 'images', base: false, candidate: true }] }).message,
    'a write, at system, after 0 characters: base "one", candidate "two"; it also differs at settings.some_new_setting, images');
});

test('cacheLine says why for each kind of fixture it couldn\'t tell for', () => {
  const notRun = (missing, absent) => cacheLine([{ version: '0.1.0', verdict: 'not run', missing, absent }]);
  assert.equal(notRun(['base-1'], []), "Cache: couldn't tell, for 1 of the 1 fixtures (0.1.0, whose stores step failed in the base's first run).");
  assert.equal(notRun(['base-2', 'candidate'], []), "Cache: couldn't tell, for 1 of the 1 fixtures (0.1.0, whose stores step failed in the base's second run and the candidate's run).");
  assert.equal(notRun(['candidate'], ['candidate']), "Cache: couldn't tell, for 1 of the 1 fixtures (0.1.0, which the candidate's run never ran).");
});

test('cleanupWorkdir empties only a workdir the lane made, only on exit 0, and keeps the paths it\'s told to', () => {
  const setup = () => {
    const work = mkdtempSync(join(tmpdir(), 'cache-write-cleanup-'));
    mkdirSync(join(work, 'install-base', 'node_modules'), { recursive: true });
    writeFileSync(join(work, 'report.json'), '{}');
    writeFileSync(join(work, 'summary.md'), 'Cache: none found');
    return { work, keep: [join(work, 'report.json'), join(work, 'summary.md')] };
  };
  const a = setup();
  cleanupWorkdir({ code: 0, work: a.work, made: true, keep: a.keep });
  assert.deepEqual(readdirSync(a.work).sort(), ['report.json', 'summary.md']);
  rmSync(a.work, { recursive: true, force: true });
  for (const [code, made] of [[1, true], [2, true], [0, false]]) {
    const b = setup();
    cleanupWorkdir({ code, work: b.work, made, keep: b.keep });
    assert.deepEqual(readdirSync(b.work).sort(), ['install-base', 'report.json', 'summary.md'], `code ${code}, made ${made}`);
    rmSync(b.work, { recursive: true, force: true });
  }
  // Nothing to keep there, as with --report and --summary given elsewhere: the directory goes.
  const c = setup();
  cleanupWorkdir({ code: 0, work: c.work, made: true, keep: [] });
  assert.equal(existsSync(c.work), false);
});

test('excerpt keeps a value short enough for a line and says how long it was', () => {
  assert.equal(excerpt(undefined), '(none)');
  assert.equal(excerpt('x'), '"x"');
  assert.equal(excerpt('y'.repeat(500), 20), `${JSON.stringify('y'.repeat(500)).slice(0, 20)}… (502 chars)`);
  assert.equal(excerpt('z'.repeat(300)), `${JSON.stringify('z'.repeat(300)).slice(0, 160)}… (302 chars)`);
  // It counts and cuts by characters, so an astral one isn't split.
  assert.equal(excerpt('🙂'.repeat(10), 4), '"🙂🙂🙂… (12 chars)');
});

/** A lane run that stops before any install. Whatever it writes goes inside a directory
 *  this test owns: the one --workdir names, or, with `workdir: false`, the TMPDIR it's given. */
function lane(script, args, { workdir = true, cwd = ROOT } = {}) {
  const own = mkdtempSync(join(tmpdir(), 'cache-write-test-'));
  const env = workdir ? process.env : { ...process.env, TMPDIR: own };
  const r = spawnSync(process.execPath, [join(ROOT, 'lanes', script), ...(workdir ? ['--workdir', own] : []), ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 });
  const made = readdirSync(own).map((d) => join(own, d));
  return { ...r, own, made, out: r.stdout + r.stderr, cleanup: () => rmSync(own, { recursive: true, force: true }) };
}

const FIXTURE_LIST = listFixtures(join(ROOT, 'fixtures', 'stores')).map((f) => f.version).join(', ').replace(/\./g, '\\.');

test('the cache-write lane stops before any install on an --only that names a missing fixture or none, keeping its workdir and saying why on its cache line', () => {
  const missing = lane('cache-write.mjs', ['--candidate', 'x', '--only', '9.9.9']);
  try {
    assert.equal(missing.status, 2, missing.out);
    assert.match(missing.out, new RegExp(`FATAL: --only names 9\\.9\\.9, which has no fixture under .* \\(it has ${FIXTURE_LIST}\\)`));
    assert.match(missing.stdout, /^Cache: couldn't tell \(the check didn't reach a comparison: --only names 9\.9\.9, /m);
    assert.equal(missing.made.length, 1, 'one workdir of its own');
    const work = missing.made[0];
    assert.match(readFileSync(join(work, 'summary.md'), 'utf8'), /^Cache: couldn't tell \(the check didn't reach a comparison: --only names 9\.9\.9, /m);
    assert.match(JSON.parse(readFileSync(join(work, 'report.json'), 'utf8')).fatal, /^--only names 9\.9\.9, /);
    assert.deepEqual(readdirSync(work).sort(), ['report.json', 'summary.md'], 'no install directory');
  } finally { missing.cleanup(); }
  // A known name beside an unknown one: only the unknown one is named.
  const mixed = lane('cache-write.mjs', ['--candidate', 'x', '--only', '0.10.2,9.9.9']);
  try {
    assert.equal(mixed.status, 2, mixed.out);
    assert.match(mixed.out, /FATAL: --only names 9\.9\.9, which has no fixture/);
  } finally { mixed.cleanup(); }
  // Separators only: it names no fixture.
  for (const args of [['--only', ' , ']]) {
    const none = lane('cache-write.mjs', ['--candidate', 'x', ...args]);
    try {
      assert.equal(none.status, 2, `${JSON.stringify(args)}: ${none.out}`);
      assert.match(none.stdout, new RegExp(`^Cache: couldn't tell \\(the check didn't reach a comparison: --only names no fixture under .* \\(it has ${FIXTURE_LIST}\\)\\)\\.$`, 'm'));
    } finally { none.cleanup(); }
  }
});

test('the cache-write lane refuses before any install without a candidate, fixtures or a readable --base-before', () => {
  const empty = mkdtempSync(join(tmpdir(), 'cache-write-fixtures-'));
  try {
    for (const [args, reason] of [
      [['--only', '0.10.2'], /FATAL: --candidate <spec or packed tarball> is required/],
      [['--candidate', 'x', '--fixtures', empty], /FATAL: no fixtures under /],
      [['--candidate', 'x', '--base-before', 'yesterday'], /FATAL: --base-before needs a time npm can read, such as 2026-10-18T21:00:00Z, not "yesterday"/],
      [['--candidate', 'x', '--base-before', ''], /FATAL: --base-before needs a value/],
    ]) {
      const r = lane('cache-write.mjs', args);
      try {
        assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.out}`);
        assert.match(r.out, reason);
        assert.doesNotMatch(r.out, /install (base|candidate)/);
      } finally { r.cleanup(); }
    }
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test('the cache-write lane refuses arguments it can\'t run as given, before any install', () => {
  for (const [args, reason] of [
    [['--candidate', 'x', '--frobnicate'], /FATAL: --frobnicate isn't an option this lane reads; it reads --candidate, --base, --base-before, --fixtures, --only, --workdir, --report, --summary, --keep/],
    [['--candidate', 'x', '--keep=yes'], /FATAL: --keep takes no value/],
    [['--candidate', 'x', '--frobnicate=x'], /FATAL: --frobnicate=x isn't an option this lane reads/],
    [['--candidate', '-host.tgz'], /FATAL: --candidate needs a value \(a path starting with - can be given as \.\/-host\.tgz\)/],
    [['--candidate', 'x', '--only', ''], /FATAL: --only needs a value/],
    [['--candidate', '-x'], /FATAL: --candidate needs a value/],
    [['--candidate=x'], /FATAL: give --candidate its value as the next word, not after "="/],
    [['--candidate', 'x', '--only', '0.10.1', '0.10.2'], /FATAL: "0\.10\.2" isn't an option or an option's value \(--only takes its fixtures as one list: a,b\)/],
    [['--candidate', 'x', '--only', '0.10.1', '--only', '0.10.2'], /FATAL: --only is given more than once/],
    [['--candidate', 'x', '--only'], /FATAL: --only needs a value/],
    [['--candidate', 'x', '--base-before'], /FATAL: --base-before needs a value/],
    [['--candidate', 'x', '--keep', '--report'], /FATAL: --report needs a value/],
    [['--candidate', 'x', '--summary'], /FATAL: --summary needs a value/],
    [['--candidate', 'x', '--fixtures'], /FATAL: --fixtures needs a value/],
    [['--candidate'], /FATAL: --candidate needs a value/],
  ]) {
    const r = lane('cache-write.mjs', args);
    try {
      assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.out}`);
      assert.match(r.out, reason);
      assert.deepEqual(r.made.flatMap((d) => readdirSync(d)).sort(), ['report.json', 'summary.md'], 'nothing installed');
    } finally { r.cleanup(); }
  }
});

test('a refusal writes its report and summary where --report and --summary say, and records the specs as it would install them', () => {
  const own = realpathSync(mkdtempSync(join(tmpdir(), 'cache-write-out-')));
  try {
    const r = spawnSync(process.execPath, [join(ROOT, 'lanes', 'cache-write.mjs'), '--workdir', own, '--base', './host-0.10.1.tgz', '--candidate', 'host.tgz', '--only', '9.9.9',
      '--report', join(own, 'r.json'), '--summary', join(own, 's.md')], { cwd: own, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    const report = JSON.parse(readFileSync(join(own, 'r.json'), 'utf8'));
    assert.deepEqual([report.base, report.candidate], [join(own, 'host-0.10.1.tgz'), join(own, 'host.tgz')]);
    assert.match(readFileSync(join(own, 's.md'), 'utf8'), /^Cache: couldn't tell \(the check didn't reach a comparison: --only names 9\.9\.9, /m);
  } finally { rmSync(own, { recursive: true, force: true }); }
});

test('a crash, such as a --workdir that names a file, exits 2, never 1, which says a write was found, and still ends in a cache line', () => {
  const own = mkdtempSync(join(tmpdir(), 'cache-write-crash-'));
  try {
    writeFileSync(join(own, 'a-file'), '');
    const r = spawnSync(process.execPath, [join(ROOT, 'lanes', 'cache-write.mjs'), '--workdir', join(own, 'a-file'), '--candidate', 'x'], { cwd: own, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /FATAL .*(EEXIST|ENOTDIR)/);
    assert.match(r.stdout, /^Cache: couldn't tell \(the lane crashed: .*(EEXIST|ENOTDIR)/m);
  } finally { rmSync(own, { recursive: true, force: true }); }
});

test('a directory given as a release is refused before any install, since npm would link it rather than install it', () => {
  const own = realpathSync(mkdtempSync(join(tmpdir(), 'cache-write-dir-')));
  try {
    mkdirSync(join(own, 'checkout'));
    for (const [args, reason] of [
      [['--candidate', './checkout'], new RegExp(`FATAL: --candidate names a directory, ${join(own, 'checkout')}; pack it first \\(npm pack\\) and give the \\.tgz`)],
      [['--candidate', 'x.tgz', '--base', 'file:'], new RegExp(`FATAL: --base names a directory, ${own}; pack it first`)],
    ]) {
      const r = spawnSync(process.execPath, [join(ROOT, 'lanes', 'cache-write.mjs'), '--workdir', join(own, 'w'), ...args], { cwd: own, encoding: 'utf8', timeout: 60_000 });
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stdout + r.stderr, reason);
      assert.doesNotMatch(r.stdout + r.stderr, /install (base|candidate)/);
    }
  } finally { rmSync(own, { recursive: true, force: true }); }
});

test('the cache-write lane makes its own workdir, in TMPDIR or inside the one named, and touches nothing already there', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cache-write-cwd-'));
  try {
    // Its own temp directory, also for an empty --workdir or one with no value (refused).
    for (const args of [[], ['--workdir', ''], ['--workdir', '--only', '9.9.9'], ['--workdir']]) {
      const r = lane('cache-write.mjs', [...args, '--candidate', 'x', ...(args.includes('--only') ? [] : ['--only', '9.9.9'])], { workdir: false, cwd });
      try {
        assert.equal(r.status, 2, r.out);
        assert.equal(r.made.length, 1, `one workdir, in the TMPDIR given: ${JSON.stringify(args)}`);
        assert.deepEqual(readdirSync(r.made[0]).sort(), ['report.json', 'summary.md'], 'its report and summary stay');
        assert.deepEqual(readdirSync(cwd), [], 'nothing made in the working directory');
      } finally { r.cleanup(); }
    }
    // A relative TMPDIR still gives an absolute workdir.
    mkdirSync(join(cwd, 'reltmp'));
    const rel = spawnSync(process.execPath, [join(ROOT, 'lanes', 'cache-write.mjs'), '--candidate', 'x', '--only', '9.9.9'], { cwd, env: { ...process.env, TMPDIR: 'reltmp' }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(rel.status, 2, rel.stdout + rel.stderr);
    assert.match(rel.stdout, new RegExp(`workdir ${join(realpathSync(cwd), 'reltmp')}/connectome-smoke-cache-`));
    rmSync(join(cwd, 'reltmp'), { recursive: true, force: true });
    // A named workdir that holds things already: they stay as they were.
    const named = mkdtempSync(join(tmpdir(), 'cache-write-named-'));
    try {
      mkdirSync(join(named, 'install-base'), { recursive: true });
      writeFileSync(join(named, 'install-base', 'mine'), 'x');
      writeFileSync(join(named, 'report.json'), 'mine');
      const r = spawnSync(process.execPath, [join(ROOT, 'lanes', 'cache-write.mjs'), '--workdir', named, '--candidate', 'x', '--only', '9.9.9'], { cwd, encoding: 'utf8', timeout: 60_000 });
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.equal(readFileSync(join(named, 'install-base', 'mine'), 'utf8'), 'x');
      assert.equal(readFileSync(join(named, 'report.json'), 'utf8'), 'mine');
      const own = readdirSync(named).filter((d) => d.startsWith('cache-write-'));
      assert.equal(own.length, 1);
      assert.deepEqual(readdirSync(join(named, own[0])).sort(), ['report.json', 'summary.md']);
      // A named workdir whose parents don't exist yet is made, with them.
      const deep = join(named, 'a', 'b');
      const d = spawnSync(process.execPath, [join(ROOT, 'lanes', 'cache-write.mjs'), '--workdir', deep, '--candidate', 'x', '--only', '9.9.9'], { cwd, encoding: 'utf8', timeout: 60_000 });
      assert.equal(d.status, 2, d.stdout + d.stderr);
      assert.equal(readdirSync(deep).filter((e) => e.startsWith('cache-write-')).length, 1);
    } finally { rmSync(named, { recursive: true, force: true }); }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('the stores lane stops before any install on an --only that names a missing fixture or none, or no fixtures', () => {
  const empty = mkdtempSync(join(tmpdir(), 'stores-fixtures-'));
  try {
    for (const [args, reason] of [
      [['--only', '9.9.9'], new RegExp(`FATAL: --only names 9\\.9\\.9, which has no fixture under .* \\(it has ${FIXTURE_LIST}\\)`)],
      [['--only', ''], /FATAL: --only names no fixture under /],
      [['--only', ' , '], /FATAL: --only names no fixture under /],
      [['--only'], /FATAL: --only names no fixture under /],
      [['--fixtures', empty], /FATAL: no fixtures under /],
    ]) {
      const r = lane('stores.mjs', args);
      try {
        assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.out}`);
        assert.match(r.out, reason);
        assert.doesNotMatch(r.out, /npm install/);
      } finally { r.cleanup(); }
    }
  } finally { rmSync(empty, { recursive: true, force: true }); }
});
