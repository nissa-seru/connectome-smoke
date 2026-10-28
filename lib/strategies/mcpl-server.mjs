#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { deflateSync } from 'node:zlib';
import { lineReader } from './control.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const KINDS = ['prose', 'code', 'json', 'image'];
const MAX_TEXT = 2_000_000;
const MAX_SIDE = 2048;
const FEATURE_SET = 'fixture';

const TOOL = {
  name: 'result',
  description: 'Returns a result of the asked kind and size, carrying the canary.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: KINDS },
      size: { type: 'integer', description: 'Characters, for prose, code and json.' },
      canary: { type: 'string' },
      width: { type: 'integer', description: 'Pixels, for image.' },
      height: { type: 'integer', description: 'Pixels, for image.' },
    },
    required: ['kind', 'canary'],
  },
};

const WORDS = ('river stone lantern harbor quiet orchard ledger signal meadow copper window thread garden compass winter '
  + 'basket candle saddle hollow pebble timber falcon marble cellar thistle willow ember quarry beacon velvet').split(' ');
const IDENTS = ['value', 'index', 'record', 'buffer', 'offset', 'cursor', 'result', 'total', 'entry', 'count'];
const CALLS = ['read', 'merge', 'split', 'store', 'parse', 'apply', 'shift', 'fold'];

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function byteStream(seed) {
  let block = Buffer.alloc(0);
  let at = 0;
  let counter = 0;
  return (n) => {
    if (at >= block.length) { block = createHash('sha256').update(`${seed}:${counter++}`).digest(); at = 0; }
    return block[at++] % n;
  };
}

function words(pick, length) {
  let s = '';
  while (s.length < length) s += (s ? ' ' : '') + WORDS[pick(WORDS.length)];
  return s.slice(0, length);
}

function prose(canary, size, pick) {
  let s = canary;
  let inSentence = 0;
  while (s.length < size) {
    let w = WORDS[pick(WORDS.length)];
    if (inSentence === 0) w = w[0].toUpperCase() + w.slice(1);
    inSentence++;
    s += ` ${w}`;
    if (inSentence > 7 + pick(9)) { s += '.'; inSentence = 0; }
  }
  return s.slice(0, size);
}

function code(canary, size, pick) {
  let s = canary;
  while (s.length < size) {
    const lhs = `${IDENTS[pick(IDENTS.length)]}_${pick(64)}`;
    const args = [IDENTS[pick(IDENTS.length)], IDENTS[pick(IDENTS.length)]].join(', ');
    s += `\n${'  '.repeat(pick(3))}const ${lhs} = ${CALLS[pick(CALLS.length)]}(${args});`;
  }
  return s.slice(0, size);
}

function jsonText(canary, size, pick) {
  let s = `{"canary":${JSON.stringify(canary)},"rows":[`;
  const tail = ']}';
  let first = true;
  for (;;) {
    const row = `${first ? '' : ','}"${words(pick, 20 + pick(60))}"`;
    if (s.length + row.length + tail.length > size) break;
    s += row;
    first = false;
  }
  const room = size - s.length - tail.length;
  const shell = first ? 2 : 3;
  s += room >= shell ? `${first ? '' : ','}"${words(pick, room - shell)}"` : ' '.repeat(room);
  return s + tail;
}

function jsonFloor(canary) { return `{"canary":${JSON.stringify(canary)},"rows":[]}`.length; }

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, pick) {
  const tile = 8;
  const across = Math.ceil(width / tile);
  const colours = Array.from({ length: across * Math.ceil(height / tile) }, () => [pick(256), pick(256), pick(256)]);
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colours[Math.floor(y / tile) * across + Math.floor(x / tile)];
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

const isWhole = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const refuse = (text) => ({ content: [{ type: 'text', text }], isError: true });

function toolResult(args) {
  const a = args && typeof args === 'object' ? args : {};
  if (!KINDS.includes(a.kind)) return refuse(`kind must be one of ${KINDS.join(', ')} (got ${JSON.stringify(a.kind)})`);
  if (typeof a.canary !== 'string' || a.canary === '') return refuse(`canary must be a non-empty string (got ${JSON.stringify(a.canary)})`);
  const pick = byteStream(canonical(a));
  if (a.kind === 'image') {
    if (!isWhole(a.width, 1, MAX_SIDE) || !isWhole(a.height, 1, MAX_SIDE)) {
      return refuse(`width and height must be whole numbers from 1 to ${MAX_SIDE} (got ${JSON.stringify(a.width)} by ${JSON.stringify(a.height)})`);
    }
    return { content: [{ type: 'image', data: png(a.width, a.height, pick), mimeType: 'image/png' }, { type: 'text', text: a.canary }] };
  }
  const floor = a.kind === 'json' ? jsonFloor(a.canary) : a.canary.length;
  if (!isWhole(a.size, floor, MAX_TEXT)) {
    return refuse(`size must be a whole number of characters from ${floor} to ${MAX_TEXT} for this kind and canary (got ${JSON.stringify(a.size)})`);
  }
  const text = (a.kind === 'prose' ? prose : a.kind === 'code' ? code : jsonText)(a.canary, a.size, pick);
  return { content: [{ type: 'text', text }] };
}

function serve() {
  const log = (...parts) => console.error('[fixture-mcpl]', ...parts);
  const toHost = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const channels = (process.env.FIXTURE_CHANNELS ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  const boot = process.env.FIXTURE_BOOT ?? '0';
  let published = 0;
  const waitingOnHost = new Map();
  let nextId = 1;
  let control = null;
  let registering = false;
  let markRegistered;
  const registered = new Promise((resolve) => { markRegistered = resolve; });

  const askHost = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    waitingOnHost.set(id, resolve);
    toHost({ id, method, params });
  });

  const register = async () => {
    registering = true;
    const descriptors = channels.map((id) => ({ id, type: 'chat', label: id, direction: 'bidirectional', initiallyOpen: true }));
    const answer = await askHost('channels/register', { channels: descriptors });
    const refused = answer.error
      ? [answer.error.message]
      : channels.filter((id) => !answer.result?.results?.find((r) => r.id === id)?.accepted)
        .map((id) => `${id}: ${answer.result?.results?.find((r) => r.id === id)?.reason ?? 'no result for it'}`);
    if (refused.length) log(`channels/register refused: ${refused.join('; ')}`);
    markRegistered(refused);
  };

  const mcpl = {
    version: '0.5',
    featureSets: [{ name: FEATURE_SET, description: 'The strategy fixture\'s sized tool results', uses: ['tools'], rollback: false }],
    ...(channels.length ? { channels: { register: true, incoming: true, publish: true } } : {}),
  };
  const answer = (msg) => {
    switch (msg.method) {
      case 'initialize':
        return {
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {}, experimental: { mcpl } },
            serverInfo: { name: 'connectome-smoke-fixture', version: '0.0.0' },
          },
        };
      case 'ping': return { result: {} };
      case 'featureSets/update': return { result: { accepted: true, mode: 'full', unavailableFeatures: [] } };
      case 'tools/list': return { result: { tools: [TOOL] } };
      case 'channels/publish':
        if (!channels.includes(msg.params?.channelId)) return { result: { delivered: false, reason: `no channel ${JSON.stringify(msg.params?.channelId)} here` } };
        return { result: { delivered: true, messageId: `pub-${boot}-${++published}`, ...('threadId' in (msg.params ?? {}) ? { threadId: msg.params.threadId } : {}) } };
      case 'tools/call':
        if (msg.params?.name !== TOOL.name) return { error: { code: -32602, message: `unknown tool ${JSON.stringify(msg.params?.name)}` } };
        return { result: toolResult(msg.params.arguments) };
      default: return { error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  };

  lineReader(process.stdin, (msg) => {
    if (typeof msg.method === 'string') {
      if (msg.id === undefined || msg.id === null) return;
      toHost({ id: msg.id, ...answer(msg) });
      if (msg.method === 'featureSets/update' && channels.length && !registering) register();
      return;
    }
    const waiting = waitingOnHost.get(msg.id);
    if (!waiting) return;
    waitingOnHost.delete(msg.id);
    waiting(msg);
  });
  process.stdin.on('end', () => { control?.end(); process.exit(0); });

  const incoming = (m) => {
    if (!channels.includes(m.channelId)) return `channel ${JSON.stringify(m.channelId)} isn't one this server registers (FIXTURE_CHANNELS: ${channels.join(', ') || 'none'})`;
    if (typeof m.messageId !== 'string' || m.messageId === '') return 'messageId must be a non-empty string';
    if (typeof m.author?.id !== 'string' || typeof m.author?.name !== 'string') return 'author must be { id, name }, both strings';
    if (typeof m.text !== 'string' || m.text === '') return 'text must be a non-empty string';
    if (!Number.isFinite(m.at)) return 'at must be a time in milliseconds';
    if (m.topic !== undefined && typeof m.topic !== 'string') return 'topic must be a string when given';
    return {
      channelId: m.channelId,
      messageId: m.messageId,
      author: { id: m.author.id, name: m.author.name },
      timestamp: new Date(m.at).toISOString(),
      content: [{ type: 'text', text: m.text }],
      ...(m.topic !== undefined ? { metadata: { topic: m.topic } } : {}),
    };
  };

  const path = process.env.FIXTURE_CONTROL;
  if (!path) return;
  const relay = (id, msg) => control?.write(`${JSON.stringify(msg.error ? { id, error: msg.error } : { id, result: msg.result })}\n`);
  control = connect(path, () => control.write(`${JSON.stringify({ type: 'hello', peer: 'server', pid: process.pid })}\n`));
  control.on('error', (e) => { log(`control socket ${path}: ${e.message}`); control = null; });
  lineReader(control, async (msg) => {
    if (msg.op === 'host') {
      relay(msg.id, await askHost('host/command', msg.params));
    } else if (msg.op === 'deliver') {
      const item = incoming(msg.message ?? {});
      if (typeof item === 'string') return relay(msg.id, { error: { code: -32602, message: item } });
      const refused = await registered;
      if (refused.length) return relay(msg.id, { error: { code: -32002, message: `the host refused this server's channels: ${refused.join('; ')}` } });
      relay(msg.id, await askHost('channels/incoming', { messages: [item] }));
    }
  });
}

serve();
