/**
 * A local stand-in for Anthropic's Messages API, used by the stored-store check
 * (lib/stores.mjs). It answers every message request with one deterministic text
 * reply, streamed or not, and records every request it receives, so a check can
 * see exactly what the host sent: the messages, the tools and the system prompt.
 *
 * The host reaches it through ANTHROPIC_BASE_URL, which connectome-host passes to
 * its Anthropic adapter from 0.3.x on (`baseURL: process.env.ANTHROPIC_BASE_URL`).
 * Zero dependencies, like the rest of this repository.
 */
import { createServer } from 'node:http';

/** Rough token estimate: about four characters a token, over what the request carries. */
function estimate(body) {
  if (!body || typeof body !== 'object') return 1;
  const s = JSON.stringify([body.system ?? '', body.messages ?? [], body.tools ?? []]);
  return Math.max(1, Math.ceil(s.length / 4));
}

function message({ model, text, inTok, outTok }) {
  return {
    id: `msg_fake_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: inTok, output_tokens: outTok },
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_fake', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function streamMessage(res, { model, text, inTok, outTok }) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_fake' });
  const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const start = message({ model, text: '', inTok, outTok: 1 });
  start.content = [];
  start.stop_reason = null;
  ev('message_start', { type: 'message_start', message: start });
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  ev('content_block_stop', { type: 'content_block_stop', index: 0 });
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outTok } });
  ev('message_stop', { type: 'message_stop' });
  res.end();
}

/**
 * Start the stand-in on a free loopback port.
 * @param {{ reply: string | ((body: object|null) => string) }} opts
 * @returns {Promise<{ url: string, requests: object[], messageRequests: () => object[], close: () => Promise<void> }>}
 *   `requests` holds every request in arrival order: method, path, the headers that
 *   say which API features were asked for, and the parsed body.
 */
export async function startFakeAnthropic({ reply }) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf-8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const path = (req.url || '').split('?')[0];
      requests.push({
        at: new Date().toISOString(), method: req.method, path,
        headers: { 'anthropic-version': req.headers['anthropic-version'] ?? null, 'anthropic-beta': req.headers['anthropic-beta'] ?? null },
        body,
      });
      if (req.method === 'POST' && path.endsWith('/v1/messages/count_tokens')) {
        return sendJson(res, 200, { input_tokens: estimate(body) });
      }
      if (req.method === 'POST' && path.endsWith('/v1/messages')) {
        const text = typeof reply === 'function' ? reply(body) : String(reply);
        const model = (body && body.model) || 'claude-fake';
        const inTok = estimate(body);
        const outTok = Math.max(1, Math.ceil(text.length / 4));
        if (body && body.stream) return streamMessage(res, { model, text, inTok, outTok });
        return sendJson(res, 200, message({ model, text, inTok, outTok }));
      }
      sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: `fake-anthropic: no route for ${req.method} ${path}` } });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    messageRequests: () => requests.filter((r) => r.method === 'POST' && r.path.endsWith('/v1/messages')),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
