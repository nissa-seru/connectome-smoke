import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStandin } from '../lib/strategies/standin.mjs';

// Requests shaped as connectome-host 0.15.0 sends them (fixture-build capture-1): an agent request
// streams, with a string system prompt and the turn's canary in the last user message among host
// notes; a summariser request doesn't stream, has no system prompt, and ends with the instruction
// after `Context Manager: `, in the same message as the slice's last canary.
const TOOLS = [{ name: 'time--now', description: 'now', input_schema: { type: 'object', properties: {} } }];
const NOTE = '[host note: this message arrived over IPC and carries no channel locus.]';
const CHAT = 'Write the memory of events since the most recent memory system notification. Speak in the first person from your own perspective. Target ~200 tokens. Output only the memory body.';
const MERGE = 'You have just reviewed the slices of recent experience above (raw conversation), in chronological order. They cover the stretch of experience you are about to consolidate into a single L2 memory. Write a memory that preserves the through-line. Target ~200 tokens. Output only the memory body — no preamble, no meta-commentary about summarizing.';
const WITNESSED = 'Write the memory of this slice of the log. This part of the record predates your own first turn. Target ~200 tokens.';
const READING = 'You have just been reading a substantial body of text — approximately 4000 tokens total in this piece, of which what you just read is a portion. Target ~200 tokens.';
const READING_MERGE = 'You have just re-experienced the portions of text you read above (raw passages from a larger piece), in chronological order. They cover a contiguous stretch of a substantial body of text you have been reading — approximately 9000 tokens in total across all of it. The portions above cover the stretch you are now consolidating at L2.\n\nReflect across the stretch. Target ~200 tokens.';
const FRONTDESK = 'Starting from my last message, please describe everything that has happened. Aim for about 200 tokens. Describe it as you would to yourself, as if you are remembering what has happened.';
const KNOWLEDGE = 'Summarize the research performed. What was searched for, what sources were consulted, and what was found? Aim for about 200 tokens.';

const prose = (n, seed = 1) => {
  const words = 'river stone lantern harbor quiet orchard ledger signal meadow copper window thread'.split(' ');
  let s = ''; let k = seed;
  while (s.length < n) { k = (k * 1103515245 + 12345) % 2147483648; s += words[k % words.length] + ' '; }
  return s.slice(0, n);
};

function agentBody({ canary, history = [], model = 'claude-sonnet-4-5', stream = true, max_tokens = 2048, tail = [], extra = {} }) {
  return {
    model, max_tokens, stream, system: 'You are the fixture agent.', tools: TOOLS,
    messages: [...history, { role: 'user', content: [{ type: 'text', text: `user: ${canary} ${prose(300)}` }, { type: 'text', text: NOTE }, ...tail] }],
    ...extra,
  };
}

function summariserBody({ canaries = ['[[c:x.1]]'], summaries = [], instruction = CHAT, model = 'claude-sonnet-4-5', max_tokens = 16000, textChars = 400 }) {
  const messages = [];
  for (const s of summaries) {
    messages.push({ role: 'user', content: [{ type: 'text', text: 'Context Manager: [CM] Recall memory L2-6.' }] });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `${s} ${prose(200, 7)}` }] });
  }
  const last = { role: 'user', content: [] };
  for (const c of canaries) last.content.push({ type: 'text', text: `user: ${c} ${prose(textChars, 3)}` }, { type: 'text', text: NOTE });
  last.content.push({ type: 'text', text: `Context Manager: ${instruction}` });
  messages.push(last);
  return { model, max_tokens, stream: false, tools: TOOLS, messages };
}

async function post(url, body, path = '/v1/messages') {
  const res = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
  const type = res.headers.get('content-type') || '';
  if (!type.includes('event-stream')) return { status: res.status, json: await res.json() };
  const raw = await res.text();
  const events = raw.split('\n\n').filter(Boolean).map((chunk) => JSON.parse(chunk.split('\n').find((l) => l.startsWith('data: ')).slice(6)));
  // Rebuild the message the stream carries, as a client does.
  const start = events.find((e) => e.type === 'message_start').message;
  const blocks = [];
  for (const e of events) {
    if (e.type === 'content_block_start') blocks[e.index] = { ...e.content_block };
    if (e.type === 'content_block_delta') {
      const b = blocks[e.index];
      if (e.delta.type === 'text_delta') b.text += e.delta.text;
      if (e.delta.type === 'thinking_delta') b.thinking += e.delta.thinking;
      if (e.delta.type === 'signature_delta') b.signature = (b.signature || '') + e.delta.signature;
      if (e.delta.type === 'input_json_delta') b._json = (b._json || '') + e.delta.partial_json;
    }
  }
  for (const b of blocks) if (b.type === 'tool_use') { b.input = JSON.parse(b._json || '{}'); delete b._json; }
  const delta = events.find((e) => e.type === 'message_delta');
  return { status: res.status, stream: true, json: { ...start, content: blocks, stop_reason: delta.delta.stop_reason, usage: { ...start.usage, ...delta.usage } } };
}

const textOf = (msg) => msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

/** Resolves once the stand-in has seen `n` arrivals. */
function arrivals(standin) {
  const seen = [];
  let waiters = [];
  standin.onRequest((r) => { seen.push(r); waiters = waiters.filter((w) => (seen.length >= w.n ? (w.resolve(), false) : true)); });
  return { seen, until: (n) => (seen.length >= n ? Promise.resolve() : new Promise((resolve) => waiters.push({ n, resolve }))) };
}

const step = (id, replies = [{ text: `[[c:${id}.r1]] noted.` }], more = {}) => ({ id, segment: 'test', kind: 'text', canaries: [`[[c:${id}.in]]`], replies, ...more });

async function withStandin(opts, fn) {
  const standin = await startStandin({ configuration: { windowTokens: 50_000, ...opts } });
  try { return await fn(standin); } finally { await standin.close(); }
}

test('T1/T3: an agent request carrying the step\'s canary gets the step\'s replies in order, streamed or not', () => withStandin({}, async (s) => {
  s.setStep(step('a', [{ text: '[[c:a.r1]] first' }, { text: '[[c:a.r2]] second' }]));
  const one = await post(s.url, agentBody({ canary: '[[c:a.in]]' }));
  assert.equal(one.status, 200);
  assert.equal(one.stream, true);
  assert.equal(textOf(one.json), '[[c:a.r1]] first');
  assert.equal(one.json.stop_reason, 'end_turn');
  const two = await post(s.url, agentBody({ canary: '[[c:a.in]]', stream: false }));
  assert.equal(two.stream, undefined);
  assert.equal(textOf(two.json), '[[c:a.r2]] second');
}));

test('T3: a reply\'s blocks come thinking, text, then calls, and a reply that calls stops for tool use', () => withStandin({}, async (s) => {
  const input = { size: 400, kind: 'prose', canary: '[[c:b.call1]]' };
  s.setStep(step('b', [{ thinking: 'I should look.', text: '[[c:b.r1]] looking', calls: [{ name: 'fixture--result', input }] }]));
  for (const stream of [true]) {
    const r = await post(s.url, agentBody({ canary: '[[c:b.in]]', stream }));
    assert.deepEqual(r.json.content.map((b) => b.type), ['thinking', 'text', 'tool_use']);
    assert.equal(r.json.content[0].thinking, 'I should look.');
    assert.equal(typeof r.json.content[0].signature, 'string');
    assert.equal(r.json.content[2].name, 'fixture--result');
    assert.deepEqual(r.json.content[2].input, input);
    assert.equal(typeof r.json.content[2].id, 'string');
    assert.equal(r.json.stop_reason, 'tool_use');
  }
}));

test('T1/T3: a tool round\'s second request is the step\'s when its last message carries the call\'s canary', () => withStandin({}, async (s) => {
  s.setStep({ ...step('t', [{ text: '[[c:t.r1]] calling', calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:t.call1]]' } }] }, { text: '[[c:t.r2]] done' }]), canaries: ['[[c:t.in]]', '[[c:t.call1]]'] });
  const first = await post(s.url, agentBody({ canary: '[[c:t.in]]' }));
  const call = first.json.content.find((b) => b.type === 'tool_use');
  const second = {
    model: 'claude-sonnet-4-5', max_tokens: 2048, stream: true, system: 'You are the fixture agent.', tools: TOOLS,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'user: [[c:t.in]] go' }] },
      { role: 'assistant', content: first.json.content },
      { role: 'user', content: [{ type: 'text', text: 'user: Clock: Wednesday 2031-01-01, 00:10 UTC' }, { type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: `[[c:t.call1]] ${prose(280)}` }] }] },
    ],
  };
  const r = await post(s.url, second);
  assert.equal(textOf(r.json), '[[c:t.r2]] done');
}));

test('T1/T2: a request with no canary of the step, with max_tokens 0, or past the step\'s replies is refused as unclassified, at once', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  s.setStep(step('u'));
  const stranger = await post(s.url, agentBody({ canary: '[[c:other.in]]' }));
  assert.equal(stranger.status, 400);
  assert.equal(stranger.json.error.type, 'invalid_request_error');
  assert.match(stranger.json.error.message, /stand-in.*unclassified/);
  assert.equal(seen.at(-1).kind, 'unclassified');
  const keepalive = await post(s.url, agentBody({ canary: '[[c:u.in]]', max_tokens: 0 }));
  assert.equal(keepalive.status, 400);
  assert.equal(seen.at(-1).kind, 'unclassified');
  assert.equal((await post(s.url, agentBody({ canary: '[[c:u.in]]' }))).status, 200);
  const extra = await post(s.url, agentBody({ canary: '[[c:u.in]]' }));
  assert.equal(extra.status, 400);
  assert.equal(seen.at(-1).kind, 'unclassified');
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.kind), ['unclassified', 'unclassified', 'agent', 'unclassified']);
  for (const r of records.filter((x) => x.kind === 'unclassified')) assert.equal(typeof r.reason, 'string');
}));

test('T1: each compression instruction context-manager sends is a summariser request, though its message carries the slice\'s canaries', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  s.setStep(step('k', []));
  for (const instruction of [CHAT, MERGE, WITNESSED, READING, READING_MERGE, KNOWLEDGE, FRONTDESK]) {
    const r = await post(s.url, summariserBody({ canaries: ['[[c:k.in]]'], instruction }));
    assert.equal(r.status, 200, instruction.slice(0, 40));
    assert.equal(seen.at(-1).kind, 'summariser', instruction.slice(0, 40));
  }
  // The retry lines context-manager appends keep the request a summariser's.
  await post(s.url, summariserBody({ instruction: `${CHAT}\n\nWrite the memory as plain text directly in your response — do not call any tools for this.` }));
  assert.equal(seen.at(-1).kind, 'summariser');
  await post(s.url, summariserBody({ instruction: 'Please consolidate these 3 L1 summaries (2 synthesis, 1 research) into a single cohesive memory. Aim for about 200 tokens.' }));
  // Each record says what level the request asks for, and whether it's a retry.
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.level), [1, 2, 1, 1, 2, 1, 1, 1, 2]);
  assert.deepEqual(records.map((r) => r.retry), [false, false, false, false, false, false, false, true, false]);
}));

test('T4/T5: summary answers carry a unique number first and untagged padding to the target their instruction states, and the record lists what each call was sent', () => withStandin({}, async (s) => {
  s.setStep(step('p', []));
  const small = await post(s.url, summariserBody({ canaries: ['[[c:p.1]]'], textChars: 4000, instruction: CHAT.replace('~200', '~60') }));
  const big = await post(s.url, summariserBody({ canaries: ['[[c:p.2]]', '[[c:p.3]]'], summaries: ['[[s:C1]]'], textChars: 400 }));
  const [a, b] = [textOf(small.json), textOf(big.json)];
  assert.match(a, /^\[\[s:C1\]\] /);
  assert.match(b, /^\[\[s:C2\]\] /);
  assert.equal(/<|>/.test(a + b), false);
  // Each lands at its own target, whatever it was sent.
  for (const [r, target] of [[small, 60], [big, 200]]) {
    assert.ok(Math.abs(r.json.usage.output_tokens - target) <= target * 0.05, `${r.json.usage.output_tokens} for a target of ${target}`);
  }
  const records = await s.close();
  assert.deepEqual(records[1].sent, { canaries: ['[[c:p.2]]', '[[c:p.3]]'], summaries: ['[[s:C1]]'] });
  assert.equal(records[1].answer.summary, '[[s:C2]]');
}));

test('T1/T4: a compression instruction that states no target is refused as unclassified', () => withStandin({}, async (s) => {
  s.setStep(step('nt', []));
  const r = await post(s.url, summariserBody({ instruction: CHAT.replace('Target ~200 tokens. ', '') }));
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /no target/);
}));
test('T4: a summary answer never runs past what max_tokens allows', () => withStandin({}, async (s) => {
  s.setStep(step('m', []));
  const r = await post(s.url, summariserBody({ canaries: ['[[c:m.1]]'], textChars: 40_000, max_tokens: 100 }));
  assert.ok(r.json.usage.output_tokens <= 100, String(r.json.usage.output_tokens));
  assert.equal(r.json.stop_reason, 'end_turn');
}));

test('T4: the writer\'s prefix numbers its summaries apart from a check\'s continuation', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 }, phase: 'P' });
  try {
    s.setStep(step('q', []));
    assert.match(textOf((await post(s.url, summariserBody({}))).json), /^\[\[s:P1\]\] /);
  } finally { await s.close(); }
});

test('T6: a step\'s bad answers go one each, in order, to the next first attempts, from that step on; a retry is answered well', () => withStandin({}, async (s) => {
  s.setStep(step('bad', [], { badAnswers: ['thinking-only', 'empty', 'max-tokens'] }));
  const retry = (instruction) => summariserBody({ instruction: `${instruction}\n\nWrite the memory directly as plain prose — do not wrap it in <thinking> or any other tags; begin immediately with the memory text itself.` });
  const got = [];
  got.push((await post(s.url, summariserBody({}))).json);
  got.push((await post(s.url, retry(CHAT))).json);
  // The step after it still serves the rest.
  s.setStep(step('bad.cp', []));
  for (let i = 0; i < 3; i++) got.push((await post(s.url, summariserBody({}))).json);
  assert.match(textOf(got[0]), /^<thinking>[\s\S]*<\/thinking>$/);
  assert.equal(got[0].stop_reason, 'end_turn');
  assert.match(textOf(got[1]), /^\[\[s:C\d+\]\] /, 'the retry gets a good answer');
  assert.deepEqual(got[2].content, [{ type: 'text', text: '' }]);
  assert.equal(got[3].stop_reason, 'max_tokens');
  assert.match(textOf(got[4]), /^\[\[s:C\d+\]\] /);
}));
test('T10: the same request always counts the same, at about 1.3 times context-manager\'s own estimate of prose, and an image counts by its size', () => withStandin({}, async (s) => {
  s.setStep(step('n', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]));
  const body = agentBody({ canary: '[[c:n.in]]' });
  const one = (await post(s.url, body)).json.usage;
  const two = (await post(s.url, body)).json.usage;
  const total = (u) => u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  assert.equal(total(one), total(two));
  const big = 29_000;
  const counted = (await post(s.url, { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: prose(big, 9) }] }] }, '/v1/messages/count_tokens')).json.input_tokens;
  const cmEstimate = Math.ceil(big / 2.9);
  assert.ok(counted > cmEstimate * 1.2 && counted < cmEstimate * 1.4, `${counted} vs ${cmEstimate}`);
  const png = (w, h) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b.toString('base64'); };
  const withImage = (w, h) => ({ model: 'm', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(w, h) } }] }] });
  const small = (await post(s.url, withImage(100, 100), '/v1/messages/count_tokens')).json.input_tokens;
  const large = (await post(s.url, withImage(750, 1000), '/v1/messages/count_tokens')).json.input_tokens;
  assert.ok(large - small > 900, `${small} → ${large}`);
}));

test('T11: a request over the window is refused as the API refuses it', () => withStandin({ windowTokens: 1000 }, async (s) => {
  s.setStep(step('o'));
  const r = await post(s.url, agentBody({ canary: '[[c:o.in]]', history: [{ role: 'user', content: [{ type: 'text', text: prose(8000) }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error.type, 'invalid_request_error');
  assert.match(r.json.error.message, /^prompt is too long: \d+ tokens > 1000 maximum$/);
}));

test('T12: a marked prefix is written, read back byte for byte while live on the virtual clock, and its lifetime follows its marker', () => withStandin({}, async (s) => {
  s.setStep(step('c', Array.from({ length: 8 }, (_, i) => ({ text: `r${i}` }))));
  const history = (ttl, text = prose(4000, 5)) => [
    { role: 'user', content: [{ type: 'text', text: `user: ${text}` }] },
    { role: 'assistant', content: [{ type: 'text', text: 'stored reply', cache_control: ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' } }] },
  ];
  const ask = async (h) => (await post(s.url, agentBody({ canary: '[[c:c.in]]', history: h }))).json.usage;
  s.setClock(0);
  const first = await ask(history());
  assert.ok(first.cache_creation_input_tokens > 1000);
  assert.equal(first.cache_read_input_tokens, 0);
  assert.equal(first.cache_creation.ephemeral_5m_input_tokens, first.cache_creation_input_tokens);
  s.setClock(4 * 60_000);
  const second = await ask(history());
  assert.equal(second.cache_read_input_tokens, first.cache_creation_input_tokens);
  assert.equal(second.cache_creation_input_tokens, 0);
  // The read refreshed it: still live 4 minutes on, 8 after the write.
  s.setClock(8 * 60_000);
  assert.equal((await ask(history())).cache_read_input_tokens, first.cache_creation_input_tokens);
  s.setClock(14 * 60_000);
  assert.equal((await ask(history())).cache_read_input_tokens, 0);
  // An hour's marker lives past five minutes; a changed byte before the marker reads nothing.
  await ask(history('1h'));
  s.setClock(40 * 60_000);
  const hour = await ask(history('1h'));
  assert.ok(hour.cache_read_input_tokens > 1000);
  assert.equal((await ask(history('1h', prose(4000, 6)))).cache_read_input_tokens, 0);
}));

test('T12: a cache entry is the model\'s own', () => withStandin({}, async (s) => {
  s.setStep(step('cm', [{ text: 'a' }, { text: 'b' }]));
  const h = [{ role: 'user', content: [{ type: 'text', text: prose(4000, 5), cache_control: { type: 'ephemeral' } }] }, { role: 'assistant', content: [{ type: 'text', text: 'x' }] }];
  await post(s.url, agentBody({ canary: '[[c:cm.in]]', history: h }));
  const other = await post(s.url, agentBody({ canary: '[[c:cm.in]]', history: h, model: 'claude-opus-4-5' }));
  assert.equal(other.json.usage.cache_read_input_tokens, 0);
}));

test('T13: when the model binds thinking, a block sent after anything before it changed is refused; otherwise it\'s taken', async () => {
  for (const binds of [true, false]) {
    await withStandin({ binds }, async (s) => {
      s.setStep({ ...step('g', [{ thinking: 'plan', calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:g.call1]]' } }] }, { text: 'ok' }, { text: 'ok' }]), canaries: ['[[c:g.in]]', '[[c:g.call1]]'] });
      const opening = agentBody({ canary: '[[c:g.in]]' });
      const first = (await post(s.url, opening)).json;
      const call = first.content.find((b) => b.type === 'tool_use');
      const next = (prefixText) => ({
        ...opening, messages: [
          { role: 'user', content: [{ type: 'text', text: prefixText }] },
          { role: 'assistant', content: first.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: `[[c:g.call1]] ${prose(280)}` }] }] },
        ],
      });
      const same = next(opening.messages[0].content.map((b) => b.text).join(''));
      same.messages[0] = opening.messages[0];
      assert.equal((await post(s.url, same)).status, 200);
      const changed = next('user: [[c:g.in]] something else entirely');
      const r = await post(s.url, changed);
      if (binds) {
        assert.equal(r.status, 400);
        assert.match(r.json.error.message, /thinking/);
      } else {
        assert.equal(r.status, 200);
      }
    });
  }
});

test('T7/T14/T15: summariser requests are answered at once, every arrival is reported, and close() returns each request\'s normalised record', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  const { seen, until } = arrivals(s);
  s.setClock(123);
  s.setStep(step('r', [{ text: '[[c:r.r1]] ok' }, { text: '[[c:r.r2]] ok' }]));
  // Answered before the step's agent requests come, since agent-framework's provider gate can
  // keep a turn's request waiting on a compression in flight.
  assert.equal((await post(s.url, summariserBody({ canaries: ['[[c:r.in]]'] }))).status, 200);
  await post(s.url, agentBody({ canary: '[[c:r.in]]' }));
  await until(2);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['at', 'clock', 'id', 'kind', 'seq', 'step']);
  assert.equal(seen[0].clock, 123);
  assert.equal(seen[0].step, 'r');
  const records = await s.close();
  const [summ, agent] = records;
  assert.equal(agent.kind, 'agent');
  assert.equal(agent.model, 'claude-sonnet-4-5');
  assert.equal(agent.maxTokens, 2048);
  assert.equal(agent.stream, true);
  assert.equal(agent.system.chars, 'You are the fixture agent.'.length);
  assert.match(agent.system.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(agent.tools, ['time--now']);
  assert.equal(agent.messages.at(-1).role, 'user');
  assert.deepEqual(agent.messages.at(-1).blocks[0].canaries, ['[[c:r.in]]']);
  assert.equal(typeof agent.usage.input_tokens, 'number');
  assert.equal(summ.kind, 'summariser');
  assert.equal(summ.answer.shape, 'summary');
});

test('T18: each message in a record has a digest, the same wherever it is carried unchanged, whatever its cache marker or a tool image ref\'s nonce, and an answer records the tool_use ids it minted', async () => {
  const standin = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    standin.setStep({ ...step('d', [{ text: '[[c:d.r1]] calling', calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:d.call1]]' } }, { name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:d.call2]]' } }] }, { text: '[[c:d.r2]] done' }, { text: '[[c:d.r3]] again' }]), canaries: ['[[c:d.in]]', '[[c:d.call1]]'] });
    const head = { model: 'claude-sonnet-4-5', max_tokens: 2048, stream: true, system: 'You are the fixture agent.', tools: TOOLS };
    const opening = (ref, marked) => ({ role: 'user', content: [{ type: 'text', text: `user: [[c:d.in]] look at ${ref}`, ...(marked ? { cache_control: { type: 'ephemeral' } } : {}) }] });
    const first = await post(standin.url, { ...head, messages: [opening('img_abc123_4', false)] });
    const ids = first.json.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
    const round = [{ role: 'assistant', content: first.json.content }, { role: 'user', content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: '[[c:d.call1]] ok' }] })) }];
    await post(standin.url, { ...head, messages: [opening('img_def456_4', true), ...round] });
    await post(standin.url, { ...head, messages: [opening('img_abc123_5', false), ...round] });
    records = await standin.close();
    const [one, two, three] = records;
    assert.ok(records.every((r) => r.kind === 'agent'), 'all three are the step\'s');
    assert.match(one.messages[0].digest, /^[0-9a-f]{16}$/);
    assert.equal(two.messages[0].digest, one.messages[0].digest, 'a cache marker and a ref\'s nonce leave it as it was');
    assert.notEqual(three.messages[0].digest, one.messages[0].digest, 'a change elsewhere in it, the ref\'s number here, changes it');
    assert.deepEqual(three.messages.slice(1).map((m) => m.digest), two.messages.slice(1).map((m) => m.digest), 'the round carried unchanged keeps its digests');
    assert.notEqual(two.messages[1].digest, two.messages[2].digest);
    assert.equal(ids.length, 2);
    assert.deepEqual(one.answer.toolUseIds, ids, 'the ids it minted, in order');
    assert.deepEqual(two.answer.toolUseIds, [], 'an answer that calls no tool mints none');
  } finally { if (!records) await standin.close(); }
});

test('T16: each request\'s record counts its messages\' tokens apart from its system prompt and tools, the same every time for the same messages', async () => {
  const standin = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    standin.setStep(step('m', [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }]));
    const body = agentBody({ canary: '[[c:m.in]]' });
    const longerSystem = { ...body, system: `${body.system} ${prose(4000, 5)}`, tools: [...TOOLS, { name: 'more', description: prose(800, 6), input_schema: { type: 'object', properties: {} } }] };
    const moreMessages = agentBody({ canary: '[[c:m.in]]', history: [{ role: 'user', content: [{ type: 'text', text: prose(3000, 4) }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] });
    await post(standin.url, body);
    await post(standin.url, longerSystem);
    await post(standin.url, body);
    await post(standin.url, moreMessages);
    records = await standin.close();
    const [one, two, three, four] = records;
    assert.ok(Number.isInteger(one.messageTokens) && one.messageTokens > 0);
    assert.equal(two.messageTokens, one.messageTokens, 'a longer system prompt and more tools leave it as it was');
    assert.equal(three.messageTokens, one.messageTokens, 'the same messages count the same');
    assert.ok(four.messageTokens > one.messageTokens + 900, `${one.messageTokens} → ${four.messageTokens}`);
    assert.ok(one.usage.input_tokens + one.usage.cache_read_input_tokens + one.usage.cache_creation_input_tokens > one.messageTokens, 'the whole request counts more');
  } finally { if (!records) await standin.close(); }
});
