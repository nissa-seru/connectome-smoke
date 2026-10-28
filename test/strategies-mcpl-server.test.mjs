// The strategy fixture's MCPL server (lib/strategies/mcpl-server.mjs) and the
// driver's half of its control socket. Each test names the requirement it pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenForServer } from '../lib/strategies/mcpl-server.mjs';

const SERVER = fileURLToPath(new URL('../lib/strategies/mcpl-server.mjs', import.meta.url));

// A stand-in for the host's side of the server's stdio, as agent-framework
// speaks it: initialize, the initialized notification, the policy request,
// then calls. It answers each request the server sends with `answer(msg)`:
// an object with `result` or `error`, a promise of one, or null for never.
async function startHost({ control = '', answer = () => ({ result: { ok: true } }) } = {}) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, FIXTURE_CONTROL: control }, stdio: ['pipe', 'pipe', 'pipe'] });
  const fromServer = [];
  const waiting = new Map();
  let nextId = 0;
  let buf = '';
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if ('method' in msg) {
        fromServer.push(msg);
        if (msg.id === undefined) continue;
        Promise.resolve(answer(msg)).then((a) => {
          if (a && !child.stdin.destroyed) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...a }) + '\n');
        });
      } else {
        waiting.get(msg.id)?.(msg);
        waiting.delete(msg.id);
      }
    }
  });
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const exited = new Promise((r) => child.once('exit', r));
  const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5' } } }, clientInfo: { name: 'agent-framework', version: '1.0.0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const policy = await request('featureSets/update', { effectiveCapabilities: ['tools', 'channels.register', 'channels.incoming'] });
  const call = async (args) => (await request('tools/call', { name: 'result', arguments: args })).result;
  const stop = async () => { child.stdin.end(); child.kill('SIGKILL'); await exited; };
  return { child, init, policy, call, fromServer, stop, exited };
}

function tempSocket() {
  const dir = mkdtempSync(join(tmpdir(), 'fx-'));
  return { path: join(dir, 'c.sock'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const textOf = (r) => r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

function pngSize(b64) {
  const png = Buffer.from(b64, 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const CALLS = [
  { kind: 'prose', size: 4000, canary: 'CANARY-P-17' },
  { kind: 'code', size: 2500, canary: 'CANARY-C-4' },
  { kind: 'json', size: 3000, canary: 'CANARY-J-9' },
  { kind: 'image', width: 64, height: 48, canary: 'CANARY-I-2' },
];

test('S1: the same arguments give byte-identical results, in one process and in another', async () => {
  const a = await startHost();
  const b = await startHost();
  try {
    for (const args of CALLS) {
      const first = await a.call(args);
      const again = await a.call({ ...args });
      const elsewhere = await b.call(JSON.parse(JSON.stringify(args)));
      assert.equal(JSON.stringify(again), JSON.stringify(first), `${args.kind}: same process`);
      assert.equal(JSON.stringify(elsewhere), JSON.stringify(first), `${args.kind}: another process`);
      assert.notEqual(first.isError, true, `${args.kind}: not an error`);
    }
  } finally { await a.stop(); await b.stop(); }
});

test('S2: a text result is exactly the asked size with the canary at its start; json parses with the canary as its first member; an image is a PNG of the asked size with the canary beside it', async () => {
  const h = await startHost();
  try {
    for (const args of CALLS.filter((c) => c.kind !== 'image')) {
      for (const size of [args.size, args.size + 1, 257]) {
        const text = textOf(await h.call({ ...args, size }));
        assert.equal(text.length, size, `${args.kind} at ${size}`);
        if (args.kind === 'json') {
          assert.ok(text.startsWith(`{"canary":${JSON.stringify(args.canary)}`), `json at ${size} opens with its canary`);
          assert.equal(JSON.parse(text).canary, args.canary, `json at ${size} parses`);
        } else {
          assert.ok(text.startsWith(args.canary), `${args.kind} at ${size} begins with its canary`);
        }
      }
    }
    const img = await h.call({ kind: 'image', width: 37, height: 5, canary: 'CANARY-I-3' });
    const image = img.content.find((b) => b.type === 'image');
    assert.equal(image.mimeType, 'image/png');
    assert.deepEqual(pngSize(image.data), { width: 37, height: 5 });
    assert.ok(textOf(img).includes('CANARY-I-3'));
  } finally { await h.stop(); }
});

test('S3: arguments the server cannot honour get an error result naming what is wrong', async () => {
  const h = await startHost();
  try {
    const cases = [
      [{ kind: 'poem', size: 100, canary: 'C' }, /kind/],
      [{ kind: 'prose', size: 3, canary: 'CANARY-LONG' }, /size/],
      [{ kind: 'json', size: 12, canary: 'CANARY-J' }, /size/],
      [{ kind: 'prose', size: 100 }, /canary/],
      [{ kind: 'prose', size: 1.5, canary: 'C' }, /size/],
      [{ kind: 'prose', size: 1e9, canary: 'C' }, /size/],
      [{ kind: 'image', canary: 'C' }, /width/],
      [{ kind: 'image', width: 0, height: 4, canary: 'C' }, /width/],
    ];
    for (const [args, names] of cases) {
      const r = await h.call(args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(textOf(r), names, JSON.stringify(args));
    }
  } finally { await h.stop(); }
});

test('S4: a host command reaches the host with exactly its params, and the answer comes back whole; a host error comes back as a rejection', async () => {
  const sock = tempSocket();
  const ctl = await listenForServer(sock.path);
  const answer = { ok: true, maintenance: { intervalMs: 5000, agents: [{ agentName: 'smoke', ready: false, pending: { compressions: 2 } }] }, hostMode: { mode: 'running' } };
  const h = await startHost({
    control: sock.path,
    answer: (msg) => (msg.params.command === 'fail' ? { error: { code: -32002, message: 'host/command requires host-owned authority' } } : { result: answer }),
  });
  try {
    await ctl.waitConnected({ since: 0, timeoutMs: 5000 });
    const params = { command: 'maintain', requesterName: 'fixture', nested: { a: [1, 2] } };
    const got = await ctl.hostCommand(params, { timeoutMs: 5000 });
    assert.deepEqual(got, answer);
    const sent = h.fromServer.filter((m) => m.method === 'host/command');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].params, params);
    await assert.rejects(ctl.hostCommand({ command: 'fail' }, { timeoutMs: 5000 }), (e) => e.code === -32002 && /host-owned authority/.test(e.message));
  } finally { await h.stop(); await ctl.close(); sock.done(); }
});

test('S5: with no server connected, a host command rejects at once', { timeout: 5000 }, async () => {
  const sock = tempSocket();
  const ctl = await listenForServer(sock.path);
  try {
    await assert.rejects(ctl.hostCommand({ command: 'maintain' }, { timeoutMs: 600_000 }), /no server is connected/);
  } finally { await ctl.close(); sock.done(); }
});

test('S5: a command pending when the connection closes rejects at once', { timeout: 5000 }, async () => {
  const sock = tempSocket();
  const ctl = await listenForServer(sock.path);
  const h = await startHost({ control: sock.path, answer: () => null });
  try {
    await ctl.waitConnected({ since: 0, timeoutMs: 5000 });
    const pending = ctl.hostCommand({ command: 'maintain' }, { timeoutMs: 600_000 });
    while (!h.fromServer.some((m) => m.method === 'host/command')) await new Promise((r) => setTimeout(r, 10));
    h.child.kill('SIGKILL');
    await assert.rejects(pending, /connection closed/);
  } finally { await h.stop(); await ctl.close(); sock.done(); }
});

test('S5: a command the host never answers rejects at the caller\'s bound, naming the command', { timeout: 5000 }, async () => {
  const sock = tempSocket();
  const ctl = await listenForServer(sock.path);
  const h = await startHost({ control: sock.path, answer: () => null });
  try {
    await ctl.waitConnected({ since: 0, timeoutMs: 5000 });
    const t0 = Date.now();
    await assert.rejects(ctl.hostCommand({ command: 'maintain' }, { timeoutMs: 300 }), /maintain/);
    assert.ok(Date.now() - t0 >= 300);
  } finally { await h.stop(); await ctl.close(); sock.done(); }
});

test('S6: after a restart the new server takes the commands, and the old one closing later leaves it connected', async () => {
  const sock = tempSocket();
  const ctl = await listenForServer(sock.path);
  const old = await startHost({ control: sock.path, answer: () => ({ result: { from: 'old' } }) });
  let fresh;
  try {
    await ctl.waitConnected({ since: 0, timeoutMs: 5000 });
    const gen = ctl.generation;
    fresh = await startHost({ control: sock.path, answer: () => ({ result: { from: 'new' } }) });
    await ctl.waitConnected({ since: gen, timeoutMs: 5000 });
    await old.stop();
    assert.deepEqual(await ctl.hostCommand({ command: 'maintain' }, { timeoutMs: 5000 }), { from: 'new' });
  } finally { await old.stop(); await fresh?.stop(); await ctl.close(); sock.done(); }
});
