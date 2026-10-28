import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

/**
 * The openings of context-manager's compression instructions, as 0.23.1 and main send them
 * (src/strategies/autobiographical.ts formatInstruction and its siblings; knowledge.ts's
 * phase prompts and merge), and connectome-host's frontdesk strategy (v0.15.0
 * frontdesk-strategy.ts). A request whose last block holds one is a summariser's. An
 * instruction this list doesn't know makes the request unclassified, which fails the run.
 */
export const INSTRUCTIONS = [
  /Write the memory of events since the most recent memory system notification\./,
  /Write the memory of this slice of the log\./,
  /You have just been reading a substantial body of text/,
  /You have just reviewed [\s\S]+? in chronological order\./,
  /You have just re-experienced [\s\S]+? in chronological order\./,
  /Summarize the research performed\./,
  /Capture the reasoning and conclusions from this discussion\./,
  /Record what knowledge was captured\./,
  /Summarize the subagent work\./,
  /Please consolidate these \d+ L\d summaries/,
  /Starting from my last message, please describe everything that has happened\./,
];

/** The length a compression instruction asks for, in tokens, or null when it states none. */
function requestedTarget(instruction) {
  const m = instruction.match(/Target ~(\d+) tokens|Aim for about (\d+) tokens/);
  return m ? Number(m[1] ?? m[2]) : null;
}

/** The level a summariser request asks for: the merge level its instruction names, else 1. */
function requestedLevel(instruction) {
  const merge = instruction.match(/into a single L(\d+) memory|single L(\d+) memory|at L(\d+)\.|consolidate these \d+ L(\d) summaries/);
  if (!merge) return 1;
  const named = merge.slice(1).find((x) => x !== undefined);
  return /consolidate these/.test(merge[0]) ? Number(named) + 1 : Number(named);
}

export const CANARY = /\[\[c:[^\]\s]+\]\]/g;
export const SUMMARY = /\[\[s:[A-Z]\d+\]\]/g;

// Characters per token by kind. context-manager estimates prose at 2.9 and dense text at
// 2.3 (message-store.ts defaultTokenEstimator); these sit about 1.3 times above it, and
// differ by kind so a store's mix moves its calibration as residents' mixes do.
const RATE = { prose: 2.2, code: 1.9, json: 1.65, base64: 1.35, signature: 3.3 };
const MESSAGE_OVERHEAD = 4;
const FIVE_MINUTES = 5 * 60_000;
const ONE_HOUR = 60 * 60_000;
const WORDS = 'river stone lantern harbor quiet orchard ledger signal meadow copper window thread garden compass winter'.split(' ');

const sha = (s) => createHash('sha256').update(s).digest('hex');

function kindOf(text) {
  if (/^[\s]*[{[]/.test(text)) { try { JSON.parse(text); return 'json'; } catch { /* not JSON */ } }
  if (text.length > 64 && /^[A-Za-z0-9+/=\s]+$/.test(text) && !/ [a-z]+ /.test(text)) return 'base64';
  let dense = 0;
  const n = Math.min(text.length, 2000);
  for (let i = 0; i < n; i++) if ('{}[]":_/=;()<>`'.includes(text[i])) dense++;
  return n && dense / n > 0.12 ? 'code' : 'prose';
}

const textTokens = (text) => (text ? Math.ceil(text.length / RATE[kindOf(text)]) : 0);

function pngSize(data) {
  try {
    const b = Buffer.from(data.slice(0, 64), 'base64');
    if (b.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } catch { return null; }
}

/** Tokens of one content block, by the stand-in's token model. */
function blockTokens(block) {
  if (typeof block === 'string') return textTokens(block);
  if (!block || typeof block !== 'object') return 0;
  switch (block.type) {
    case 'text': return textTokens(block.text);
    case 'thinking': return textTokens(block.thinking) + Math.ceil((block.signature || '').length / RATE.signature);
    case 'redacted_thinking': return Math.ceil((block.data || '').length / RATE.signature);
    case 'tool_use': return textTokens(block.name || '') + Math.ceil(JSON.stringify(block.input ?? {}).length / RATE.json);
    case 'tool_result': return Array.isArray(block.content) ? block.content.reduce((t, b) => t + blockTokens(b), 0) : textTokens(String(block.content ?? ''));
    case 'image': {
      const size = block.source?.type === 'base64' ? pngSize(block.source.data || '') : null;
      return size ? Math.ceil((size.width * size.height) / 750) : 1600;
    }
    default: return Math.ceil(JSON.stringify(block).length / RATE.json);
  }
}

const unmarked = (v) => {
  if (Array.isArray(v)) return v.map(unmarked);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'cache_control').map(([k, x]) => [k, k === 'input' ? x : unmarked(x)]));
};
const blocksOf = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);

/**
 * The request as a sequence of cacheable elements in the order the API reads them (tools,
 * system, messages), each with its tokens, its marker if it has one, and the rolling hash of
 * everything up to it without markers.
 */
function elements(body) {
  const out = [];
  let h = sha(String(body.model));
  const push = (value, tokens, marker) => {
    h = sha(h + JSON.stringify(unmarked(value)));
    out.push({ hash: h, tokens, marker });
  };
  for (const tool of body.tools || []) push({ tool }, Math.ceil(JSON.stringify(unmarked(tool)).length / RATE.json), tool.cache_control);
  for (const block of typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : body.system || []) push({ system: block }, blockTokens(block), block.cache_control);
  for (const [i, m] of (body.messages || []).entries()) {
    const blocks = blocksOf(m.content);
    blocks.forEach((block, j) => push({ message: i, role: m.role, block }, blockTokens(block) + (j === 0 ? MESSAGE_OVERHEAD : 0), block.cache_control));
  }
  if (body.cache_control && out.length) out.at(-1).marker = out.at(-1).marker ?? body.cache_control;
  return out;
}

export function countTokens(body) {
  return elements(body).reduce((t, e) => t + e.tokens, 0);
}

/** Every text a request carries, tool results' included, in order. */
function texts(body) {
  const out = [];
  const walk = (b) => {
    if (typeof b === 'string') { out.push(b); return; }
    if (!b || typeof b !== 'object') return;
    if (b.type === 'text') out.push(b.text || '');
    if (b.type === 'tool_result') blocksOf(b.content).forEach(walk);
  };
  for (const m of body.messages || []) blocksOf(m.content).forEach(walk);
  return out;
}

const found = (strings, re) => strings.flatMap((s) => s.match(re) || []);

/** The identity a thinking block is bound to: everything the request carries ahead of the
 *  message holding the block, as context-manager's RequestIdentity names it (system, tools,
 *  model and the rest of the head) plus the messages before it, all without markers. */
function bindingIdentity(body, beforeMessage) {
  const head = Object.fromEntries(Object.entries(body).filter(([k]) => !['messages', 'stream', 'metadata', 'system', 'tools', 'model'].includes(k)));
  return sha(JSON.stringify(unmarked({ model: body.model, system: body.system ?? null, tools: body.tools ?? null, head, messages: (body.messages || []).slice(0, beforeMessage) })));
}

const signatureFor = (identity) => `fx1.${Buffer.from(identity, 'hex').toString('base64url')}`;

function padding(chars, seed) {
  let s = ''; let k = seed * 7919 + 17;
  while (s.length < chars) { k = (k * 1103515245 + 12345) % 2147483648; s += WORDS[k % WORDS.length] + ' '; }
  return s.slice(0, Math.max(0, chars)).trimEnd();
}

function normalise(body) {
  const block = (b) => {
    const text = b.type === 'text' ? b.text || '' : b.type === 'tool_result' ? texts({ messages: [{ content: [b] }] }).join('') : '';
    const out = { type: b.type, chars: b.type === 'text' || b.type === 'tool_result' ? text.length : b.type === 'thinking' ? (b.thinking || '').length : b.type === 'tool_use' ? JSON.stringify(b.input ?? {}).length : b.type === 'image' ? (b.source?.data || '').length : JSON.stringify(b).length };
    const canaries = text.match(CANARY); if (canaries) out.canaries = canaries;
    const summaries = text.match(SUMMARY); if (summaries) out.summaries = summaries;
    if (b.type === 'tool_use') out.toolUseId = b.id;
    if (b.type === 'tool_result') {
      out.toolUseId = b.tool_use_id;
      const images = blocksOf(b.content).filter((x) => x?.type === 'image').length;
      if (images) out.images = images;
    }
    if (b.cache_control) out.cache = b.cache_control.ttl || '5m';
    if (b.type === 'thinking') out.signature = b.signature ?? null;
    return out;
  };
  const system = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? body.system.map((b) => b.text || '').join('') : '';
  return {
    model: body.model ?? null,
    maxTokens: body.max_tokens ?? null,
    stream: body.stream === true,
    thinking: body.thinking ?? null,
    system: { sha256: sha(system), chars: system.length },
    tools: (body.tools || []).map((t) => t.name),
    messages: (body.messages || []).map((m) => ({ role: m.role, blocks: blocksOf(m.content).map(block) })),
  };
}

/**
 * Start the stand-in for Anthropic's Messages API on a free loopback port.
 *
 * @param {object} opts
 * @param {{ windowTokens: number, binds?: boolean, dropBlock?: boolean, minCacheTokens?: number }} opts.configuration
 *   `windowTokens` is the model's window (T11); `binds` says the model binds thinking to the
 *   request it was minted in, and `dropBlock` that requests carry the provider's drop control (T13).
 * @param {'C'|'P'} [opts.phase] whose summary numbers these are: a check's continuation (C) or the writer's prefix (P).
 * @param {string} [opts.rawDir] where each request's body is saved, as `<id>.json`.
 */
export async function startStandin({ configuration, phase = 'C', rawDir = null }) {
  const config = { minCacheTokens: 0, ...configuration };
  const t0 = performance.now();
  const records = [];
  const listeners = [];
  const cache = new Map();
  const sockets = new Set();
  let step = null;
  let agentCount = 0;
  let clock = 0;
  let summaryNumber = 0;
  let toolNumber = 0;
  const badQueue = [];
  if (rawDir) mkdirSync(rawDir, { recursive: true });

  function usageFor(body, outputTokens) {
    const els = elements(body);
    const total = els.reduce((t, e) => t + e.tokens, 0);
    const cum = []; let c = 0;
    for (const e of els) { c += e.tokens; cum.push(c); }
    const markers = els.map((e, i) => (e.marker ? i : -1)).filter((i) => i >= 0);
    let readAt = -1;
    for (const m of markers) {
      for (let j = m; j >= Math.max(0, m - 20); j--) {
        const entry = cache.get(els[j].hash);
        if (entry && entry.expiresAt > clock && j > readAt) readAt = j;
      }
    }
    const read = readAt >= 0 ? cum[readAt] : 0;
    if (readAt >= 0) {
      const ttl = els[readAt].marker?.ttl === '1h' || cache.get(els[readAt].hash).ttl === ONE_HOUR ? ONE_HOUR : FIVE_MINUTES;
      cache.set(els[readAt].hash, { expiresAt: clock + ttl, ttl });
    }
    const split = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 };
    let written = read;
    for (const m of markers) {
      if (m <= readAt || cum[m] < config.minCacheTokens) continue;
      const ttl = els[m].marker.ttl === '1h' ? ONE_HOUR : FIVE_MINUTES;
      cache.set(els[m].hash, { expiresAt: clock + ttl, ttl });
      split[ttl === ONE_HOUR ? 'ephemeral_1h_input_tokens' : 'ephemeral_5m_input_tokens'] += cum[m] - written;
      written = cum[m];
    }
    const creation = written - read;
    return { input_tokens: total - written, cache_read_input_tokens: read, cache_creation_input_tokens: creation, cache_creation: split, output_tokens: outputTokens };
  }

  function classify(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || body.messages.length === 0) return { kind: 'unclassified', reason: 'no messages' };
    if (body.max_tokens === 0) return { kind: 'unclassified', reason: 'max_tokens 0, the shape of a cache keepalive refresh' };
    const last = body.messages.at(-1);
    const lastBlock = blocksOf(last.content).at(-1);
    if (last.role === 'user' && lastBlock?.type === 'text' && INSTRUCTIONS.some((re) => re.test(lastBlock.text || ''))) {
      return requestedTarget(lastBlock.text) === null ? { kind: 'unclassified', reason: 'its compression instruction states no target length' } : { kind: 'summariser' };
    }
    if (last.role !== 'user') return { kind: 'unclassified', reason: `the last message is the ${last.role}'s` };
    if (!step) return { kind: 'unclassified', reason: 'no step is set' };
    const carried = found(texts({ messages: [last] }), CANARY);
    if (!carried.some((c) => (step.canaries || []).includes(c))) return { kind: 'unclassified', reason: `its last message carries none of step ${step.id}'s canaries (it carries ${carried.join(' ') || 'none'})` };
    if (agentCount >= (step.replies || []).length) return { kind: 'unclassified', reason: `step ${step.id} has no scripted reply left (${agentCount} answered)` };
    return { kind: 'agent' };
  }

  function bindingRefusal(body) {
    if (!config.binds || config.dropBlock) return null;
    for (const [i, m] of body.messages.entries()) {
      for (const [j, b] of blocksOf(m.content).entries()) {
        if (b.type !== 'thinking') continue;
        if (b.signature !== signatureFor(bindingIdentity(body, i))) return `messages.${i}.content.${j}: the thinking block's signature doesn't match this request; something before it changed since it was minted`;
      }
    }
    return null;
  }

  const sendError = (res, status, message) => {
    const body = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } });
    res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_standin' });
    res.end(body);
  };

  function sendMessage(res, body, record, { content, stop }) {
    const outputTokens = content.reduce((t, b) => t + blockTokens(b), 0) || 1;
    const usage = usageFor(body, stop === 'max_tokens' && body.max_tokens ? body.max_tokens : outputTokens);
    record.usage = usage;
    const message = { id: `msg_${record.id}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_sequence: null, usage };
    if (!body.stream) {
      const out = JSON.stringify(message);
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_${record.id}` });
      res.end(out);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_${record.id}` });
    const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    ev('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } });
    content.forEach((b, index) => {
      if (b.type === 'text') {
        ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
      } else if (b.type === 'thinking') {
        ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } });
        ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } });
        ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature } });
      } else if (b.type === 'tool_use') {
        ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      }
      ev('content_block_stop', { index });
    });
    ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
    ev('message_stop', {});
    res.end();
  }

  function answerAgent(res, body, record, reply) {
    const identity = bindingIdentity(body, body.messages.length);
    const content = [];
    if (reply.thinking !== undefined) content.push({ type: 'thinking', thinking: reply.thinking, signature: signatureFor(identity) });
    if (reply.text !== undefined) content.push({ type: 'text', text: reply.text });
    for (const call of reply.calls || []) content.push({ type: 'tool_use', id: `toolu_fx${String(++toolNumber).padStart(6, '0')}`, name: call.name, input: call.input });
    const stop = reply.stop ?? ((reply.calls || []).length ? 'tool_use' : 'end_turn');
    record.answer = { shape: 'reply', chars: content.reduce((t, b) => t + (b.text || b.thinking || '').length, 0), stop };
    sendMessage(res, body, record, { content, stop });
  }

  function answerSummariser(res, body, record) {
    const shape = record.answer.shape;
    const maxChars = Math.floor((body.max_tokens || 16_000) * RATE.prose) - 32;
    let text; let stop = 'end_turn';
    if (shape === 'thinking-only') text = `<thinking>${padding(200, record.seq)}</thinking>`;
    else if (shape === 'empty') text = '';
    else if (shape === 'max-tokens') { text = padding(maxChars, record.seq); stop = 'max_tokens'; }
    else {
      const want = Math.min(Math.floor(record.target * RATE.prose), maxChars) - record.answer.summary.length - 1;
      text = `${record.answer.summary} ${padding(want, record.seq)}`;
    }
    record.answer.chars = text.length;
    record.answer.stop = stop;
    sendMessage(res, body, record, { content: [{ type: 'text', text }], stop });
  }

  function handle(req, res, raw) {
    const path = (req.url || '').split('?')[0];
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    if (req.method === 'POST' && path.endsWith('/v1/messages/count_tokens')) {
      const out = JSON.stringify({ input_tokens: body ? countTokens(body) : 0 });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(out);
      return;
    }
    if (!(req.method === 'POST' && path.endsWith('/v1/messages'))) return sendError(res, 404, `stand-in: no route for ${req.method} ${path}`);
    const seq = records.length + 1;
    const id = `r${seq}`;
    const { kind, reason } = classify(body);
    const record = { id, seq, at: Math.round(performance.now() - t0), clock, step: step?.id ?? null, kind, ...(reason ? { reason } : {}), ...(body ? normalise(body) : {}) };
    records.push(record);
    if (rawDir) writeFileSync(join(rawDir, `${id}.json`), raw);
    for (const cb of listeners) cb({ id, seq, kind, step: record.step, at: record.at, clock });
    if (kind === 'unclassified') {
      record.answer = { shape: 'refused' };
      return sendError(res, 400, `stand-in: unclassified request ${id}: ${reason}`);
    }
    const tooLong = countTokens(body);
    if (tooLong > config.windowTokens) {
      record.refused = 'window';
      record.answer = { shape: 'refused' };
      if (kind === 'agent') agentCount++;
      return sendError(res, 400, `prompt is too long: ${tooLong} tokens > ${config.windowTokens} maximum`);
    }
    const binding = bindingRefusal(body);
    if (binding) {
      record.refused = 'thinking';
      record.answer = { shape: 'refused' };
      if (kind === 'agent') agentCount++;
      return sendError(res, 400, binding);
    }
    if (kind === 'agent') {
      const reply = step.replies[agentCount++];
      answerAgent(res, body, record, reply);
      return;
    }
    record.sent = { canaries: found(texts(body), CANARY), summaries: found(texts(body), SUMMARY) };
    const instruction = blocksOf(body.messages.at(-1).content).at(-1).text;
    record.level = requestedLevel(instruction);
    record.target = requestedTarget(instruction);
    record.retry = /do not call any tools for this|do not wrap it in <thinking>/.test(instruction);
    if (badQueue.length && !record.retry) {
      record.answer = { shape: badQueue.shift() };
    } else {
      record.answer = { shape: 'summary', summary: `[[s:${phase}${++summaryNumber}]]` };
    }
    answerSummariser(res, body, record);
  }

  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf-8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => handle(req, res, raw));
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    /** The step whose input the driver is about to send: its canaries say which requests are
     *  its agent's, its replies are served from it, and its bad answers join the queue the
     *  next first attempts take, one each. */
    setStep(next) { step = next; agentCount = 0; badQueue.push(...(next?.badAnswers || [])); },
    /** The virtual time in ms, which the cache model's lifetimes run on. */
    setClock(ms) { clock = ms; },
    /** Called at every arrival with `{ id, seq, kind, step, at, clock }`. */
    onRequest(cb) { listeners.push(cb); },
    /** Stop the server and return the records in arrival order. */
    async close() {
      await new Promise((resolve) => { server.close(() => resolve()); for (const s of sockets) s.destroy(); });
      return records;
    },
  };
}
