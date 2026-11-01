/**
 * Shared plumbing for the harness: a shell, an argument parser, and the host's process
 * and IPC client.
 */
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { connect as netConnect } from 'node:net';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sh(cmd, cmdArgs, { cwd, env = {}, timeout = 600_000, allowFail = false } = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd, env: { ...process.env, ...env }, encoding: 'utf-8', timeout, maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${cmdArgs.join(' ')} (cwd ${cwd}) exited ${r.status}${r.signal ? ' signal ' + r.signal : ''}\n${(r.stdout + '\n' + r.stderr).trim().slice(-3000)}`);
  }
  return r;
}

// ---------------------------------------------------------------- IPC client
export function ipcConnect(path, timeoutMs = 5000) {
  return new Promise((res, rej) => {
    const s = netConnect(path);
    const t = setTimeout(() => { s.destroy(); rej(new Error(`ipc connect timeout ${path}`)); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); res(s); });
    s.once('error', (e) => { clearTimeout(t); rej(e); });
  });
}
export const send = (sock, obj) => sock.write(JSON.stringify(obj) + '\n');

/**
 * The process groups of the hosts spawnHost started, by host pid, until each
 * is killed. Each host leads a group of its own, and its MCPL servers, with
 * anything they start, stay in it, even once the host has exited and they've
 * been handed to init. So killing the group reaches all of them, where killing
 * the host alone would leave its servers running. Only a process that starts a
 * group or session of its own leaves the group.
 *
 * A host doesn't end when the lane that started it does. So the lane kills
 * every group still here when it ends by exiting (an uncaught throw or
 * rejection included) or by SIGTERM, SIGINT, SIGQUIT or SIGHUP, and on a
 * signal it then ends by that signal, as it would have without this. Ending
 * by the signal needs the handler installHostCleanup adds to be the signal's
 * only listener: a lane that adds a listener of its own would have the raised
 * signal call it instead, and would go on unless that listener ends it. Any
 * other ending (SIGKILL, another signal, an abort of the lane's own process)
 * leaves them running.
 */
const hostGroups = new Set();

/** SIGKILL a host's group: the host, if it's still running, and whatever it
 *  started that's still in the group. A host that has exited can leave its
 *  servers there, so this kills the group either way. */
export function stopHost(child) {
  if (!hostGroups.delete(child.pid)) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is already empty */ }
}

function stopAllHosts() {
  for (const pid of hostGroups) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* the group is already empty */ }
  }
  hostGroups.clear();
}

let hostCleanupInstalled = false;
function installHostCleanup() {
  if (hostCleanupInstalled) return;
  hostCleanupInstalled = true;
  // First among the exit listeners, so every host group has been sent SIGKILL
  // before a lane's own listener removes the directory they write into. The
  // lanes register theirs in done(), after their first host, so this holds
  // today either way; first place keeps it true for a lane that registers
  // earlier.
  process.prependListener('exit', stopAllHosts);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGHUP']) {
    process.on(signal, function onSignal() {
      stopAllHosts();
      // Then the signal's own action, which runs no exit listener.
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    });
  }
}

export function spawnHost({ hostDir, recipePath, dataDir, cwd, sockPath, env = {}, preload = null }) {
  const out = [];
  const child = spawn('bun', [...(preload ? ['--preload', preload] : []), join(hostDir, 'src', 'index.ts'), recipePath, '--headless', '--socket-path', sockPath], {
    cwd,
    env: { ...process.env, DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', NO_COLOR: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  if (typeof child.pid === 'number') {
    installHostCleanup();
    hostGroups.add(child.pid);
  }
  child.stdout.on('data', (d) => out.push(d.toString()));
  child.stderr.on('data', (d) => out.push(d.toString()));
  return { child, out };
}

export function parseArgs(argv) {
  const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
  /** Every value of a repeatable option, in the order given. */
  const opts = (name) => argv.flatMap((a, i) => (a === `--${name}` && i + 1 < argv.length ? [argv[i + 1]] : []));
  const flag = (name) => argv.includes(`--${name}`);
  return { opt, opts, flag };
}
