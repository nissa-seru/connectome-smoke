import { createServer } from 'node:net';
import { rmSync } from 'node:fs';

/** Calls `onMessage` with each line of `stream` that parses as JSON. */
export function lineReader(stream, onMessage) {
  let buf = '';
  stream.setEncoding('utf-8');
  stream.on('data', (part) => {
    buf += part;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      onMessage(msg);
    }
  });
}

/**
 * The driver's end of the fixture's control socket, listening at `path`. Two
 * peers connect to it, and the newest connection of each takes its requests:
 * - `'server'`, the fixture's MCPL server (mcpl-server.mjs). The lane's recipe
 *   runs it with FIXTURE_CONTROL set to `path`, FIXTURE_CHANNELS to its channel
 *   ids (comma-separated; bidirectional, and every publish to them is
 *   delivered), and FIXTURE_BOOT to the boot's ordinal, which keeps published
 *   message ids apart across a run's restarts.
 * - `'clock'`, the host's `Date` preload (virtual-date.mjs), which the host
 *   runs with FIXTURE_CONTROL set to `path` and FIXTURE_EPOCH_MS to the time
 *   its clock starts at.
 *
 * - `generation(peer)` counts the connections that peer has made.
 * - `waitConnected(peer, { since, timeoutMs })` resolves once a connection of
 *   that peer newer than generation `since` is open.
 * - `hostCommand(params, { timeoutMs })` sends `host/command` with `params`
 *   through the server and resolves with the host's answer whole.
 * - `deliver({ channelId, messageId, author: { id, name }, topic, text, at },
 *   { timeoutMs })` has the server send it as `channels/incoming`, stamped
 *   with `at` (ms), and resolves with the host's acceptance. It rejects when
 *   the host refuses the message.
 * - `advance(at, { timeoutMs })` sets the host's virtual time to `at` (ms),
 *   and resolves once the host reads it. A time earlier than the clock's is
 *   refused.
 * Each rejects on the peer's or the host's error (with its `code`), when no
 * connection of its peer is open, when that connection closes first, or at
 * `timeoutMs`.
 */
export async function listenForPeers(path) {
  rmSync(path, { force: true });
  const sockets = new Set();
  const pending = new Map();
  const waiters = new Set();
  const current = new Map();
  const generations = new Map();
  let nextId = 1;

  const settle = (id, fn) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    fn(p);
  };

  const server = createServer((sock) => {
    sockets.add(sock);
    const conn = { sock, peer: null };
    lineReader(sock, (msg) => {
      if (msg.type === 'hello') {
        conn.peer = String(msg.peer);
        generations.set(conn.peer, (generations.get(conn.peer) ?? 0) + 1);
        current.set(conn.peer, conn);
        for (const w of waiters) if (w.peer === conn.peer && generations.get(conn.peer) > w.since) w.done();
        return;
      }
      settle(msg.id, (p) => (msg.error
        ? p.reject(Object.assign(new Error(`${p.label} failed: ${msg.error.message}`), { code: msg.error.code, data: msg.error.data }))
        : p.resolve(msg.result)));
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      sockets.delete(sock);
      if (current.get(conn.peer) === conn) current.delete(conn.peer);
      for (const [id, p] of pending) {
        if (p.conn === conn) settle(id, () => p.reject(new Error(`the fixture ${conn.peer}'s connection closed while ${p.label} was pending`)));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });

  const request = (peer, op, body, label, timeoutMs) => {
    const conn = current.get(peer);
    if (!conn) return Promise.reject(new Error(`no ${peer} is connected to ${path}, so ${label} wasn't sent`));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => settle(id, () => reject(new Error(`${label} had no answer in ${timeoutMs} ms`))), timeoutMs);
      pending.set(id, { resolve, reject, timer, label, conn });
      conn.sock.write(`${JSON.stringify({ id, op, ...body })}\n`);
    });
  };

  return {
    generation(peer) { return generations.get(peer) ?? 0; },
    waitConnected(peer, { since = 0, timeoutMs = 30_000 } = {}) {
      if ((generations.get(peer) ?? 0) > since && current.has(peer)) return Promise.resolve(generations.get(peer));
      return new Promise((resolve, reject) => {
        const w = {
          peer,
          since,
          done: () => { waiters.delete(w); clearTimeout(w.timer); resolve(generations.get(peer)); },
          fail: (e) => { waiters.delete(w); clearTimeout(w.timer); reject(e); },
          timer: setTimeout(() => { waiters.delete(w); reject(new Error(`no fixture ${peer} connected to ${path} within ${timeoutMs} ms`)); }, timeoutMs),
        };
        waiters.add(w);
      });
    },
    hostCommand(params, { timeoutMs = 60_000 } = {}) {
      return request('server', 'host', { params }, `host/command ${String(params?.command)}`, timeoutMs);
    },
    async deliver(message, { timeoutMs = 60_000 } = {}) {
      const label = `delivery ${JSON.stringify(message?.messageId)} to channel ${JSON.stringify(message?.channelId)}`;
      const answer = await request('server', 'deliver', { message }, label, timeoutMs);
      const item = answer?.results?.find?.((r) => r.messageId === message.messageId);
      if (!item?.accepted) throw new Error(`the host didn't accept ${label}: ${item?.reason ?? JSON.stringify(answer)}`);
      return item;
    },
    advance(at, { timeoutMs = 10_000 } = {}) {
      return request('clock', 'advance', { at }, `advancing the clock to ${JSON.stringify(at)}`, timeoutMs);
    },
    async close() {
      for (const [id, p] of pending) settle(id, () => p.reject(new Error(`the control socket closed while ${p.label} was pending`)));
      for (const w of waiters) w.fail(new Error(`the control socket at ${path} closed before a fixture ${w.peer} connected`));
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
      rmSync(path, { force: true });
    },
  };
}
