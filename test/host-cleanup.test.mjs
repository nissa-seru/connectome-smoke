// A lane takes the hosts it started with it, and everything they started,
// when it ends by exiting (a throw or a rejection included) or by SIGTERM,
// SIGINT, SIGQUIT or SIGHUP. Needs bun, as the lanes do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const COMMON = fileURLToPath(new URL('../lib/common.mjs', import.meta.url));
const noBun = spawnSync('bun', ['--version']).status === 0 ? false : 'bun is not on PATH';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for the host spawnHost runs (`bun <hostDir>/src/index.ts …`).
// It starts a child that starts a grandchild, as a host starts an MCPL server
// through a wrapper, writes the three pids, and ignores SIGTERM, as a host
// whose shutdown hangs would. With EXIT_AFTER set it exits once it has
// written them, leaving the two to init.
const FAKE_HOST = `
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
process.on('SIGTERM', () => {});
const gcFile = process.env.PIDS_FILE + '.grandchild';
const child = spawn('sh', ['-c', 'sleep 600 & echo $! > "$1"; wait', 'sh', gcFile], { stdio: 'ignore' });
while (!existsSync(gcFile) || !readFileSync(gcFile, 'utf-8').trim()) await new Promise((r) => setTimeout(r, 20));
const grandchild = Number(readFileSync(gcFile, 'utf-8'));
writeFileSync(process.env.PIDS_FILE + '.tmp', JSON.stringify({ host: process.pid, child: child.pid, grandchild }));
renameSync(process.env.PIDS_FILE + '.tmp', process.env.PIDS_FILE);
if (process.env.EXIT_AFTER) process.exit(0);
setInterval(() => {}, 1000);
`;

// A stand-in lane: it starts HOSTS hosts, waits for each, says it's ready,
// then ends as HOW says, or calls stopHost on each and goes on running.
const LANE = `
import { existsSync, writeFileSync } from 'node:fs';
import * as common from ${JSON.stringify(COMMON)};
const dir = process.env.WORK;
const hosts = [];
for (let i = 0; i < Number(process.env.HOSTS); i++) {
  const pidsFile = process.env.PIDS_FILE + '.' + i;
  const { child } = common.spawnHost({ hostDir: dir + '/host', recipePath: dir + '/recipe.json', dataDir: dir, cwd: dir, sockPath: dir + '/host.sock', env: { PIDS_FILE: pidsFile } });
  while (!existsSync(pidsFile)) await new Promise((r) => setTimeout(r, 50));
  hosts.push(child);
}
// A host told to exit has exited, as this lane sees it, before the lane goes on.
if (process.env.EXIT_AFTER) {
  for (const child of hosts) await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
}
writeFileSync(process.env.PIDS_FILE + '.ready', '');
const how = process.env.HOW;
if (how === 'exit') process.exit(3);
if (how === 'throw') throw new Error('the lane failed');
if (how === 'reject') Promise.reject(new Error('the lane failed'));
if (how === 'stopHost') {
  for (const child of hosts) common.stopHost(child);
  writeFileSync(process.env.PIDS_FILE + '.stopped', '');
}
setInterval(() => {}, 1000);
`;

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
async function waitFor(check, ms) {
  for (let t = 0; t < ms; t += 50) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}
const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => `no exit within ${ms} ms`)]);
const everyPid = (pids) => pids.flatMap((p) => [p.host, p.child, p.grandchild]);

/** Start a stand-in lane in a fresh directory, leading a process group of its
 *  own as `timeout` starts one, and wait until its hosts have written their
 *  pids. */
async function startLane(how, { hosts = 1, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'host-cleanup-'));
  mkdirSync(join(dir, 'host', 'src'), { recursive: true });
  writeFileSync(join(dir, 'host', 'src', 'index.ts'), FAKE_HOST);
  writeFileSync(join(dir, 'lane.mjs'), LANE);
  const pidsFile = join(dir, 'pids.json');
  const lane = spawn(process.execPath, [join(dir, 'lane.mjs')], {
    cwd: dir,
    env: { ...process.env, ...env, WORK: dir, PIDS_FILE: pidsFile, HOW: how, HOSTS: String(hosts) },
    stdio: 'ignore',
    detached: true,
  });
  const exited = new Promise((r) => lane.once('exit', (code, signal) => r({ code, signal })));
  const ready = await waitFor(() => existsSync(`${pidsFile}.ready`), 15_000);
  const pids = ready ? [...Array(hosts).keys()].map((i) => JSON.parse(readFileSync(`${pidsFile}.${i}`, 'utf-8'))) : [];
  return { dir, lane, exited, pids, ready, pidsFile };
}

/** Kill whatever a case left: the lane's group and each host's. */
function cleanup({ dir, lane, pidsFile }) {
  try { process.kill(-lane.pid, 'SIGKILL'); } catch { /* gone */ }
  for (let i = 0; existsSync(`${pidsFile}.${i}`); i++) {
    try { process.kill(-JSON.parse(readFileSync(`${pidsFile}.${i}`, 'utf-8')).host, 'SIGKILL'); } catch { /* gone */ }
  }
  rmSync(dir, { recursive: true, force: true });
}

for (const [how, end] of [
  ['exit', { code: 3, signal: null }],
  ['throw', { code: 1, signal: null }],
  ['reject', { code: 1, signal: null }],
  ['SIGTERM', { code: null, signal: 'SIGTERM' }],
  ['SIGINT', { code: null, signal: 'SIGINT' }],
  ['SIGQUIT', { code: null, signal: 'SIGQUIT' }],
  ['SIGHUP', { code: null, signal: 'SIGHUP' }],
]) {
  test(`a lane that ends by ${how} leaves nothing its host started running`, { skip: noBun }, async () => {
    const run = await startLane(how);
    try {
      assert.ok(run.ready, 'the stand-in host never wrote its pids');
      // To the lane's group, as timeout signals it.
      if (how.startsWith('SIG')) process.kill(-run.lane.pid, how);
      assert.deepEqual(await within(run.exited, 15_000), end);
      assert.ok(await waitFor(() => !everyPid(run.pids).some(alive), 5000), `still running: ${JSON.stringify(run.pids)}`);
    } finally {
      cleanup(run);
    }
  });
}

test('a lane that started two hosts takes both with it', { skip: noBun }, async () => {
  const run = await startLane('exit', { hosts: 2 });
  try {
    assert.ok(run.ready, 'the stand-in hosts never wrote their pids');
    assert.deepEqual(await within(run.exited, 15_000), { code: 3, signal: null });
    assert.ok(await waitFor(() => !everyPid(run.pids).some(alive), 5000), `still running: ${JSON.stringify(run.pids)}`);
  } finally {
    cleanup(run);
  }
});

test('what a host started dies with the lane, though the host exited first', { skip: noBun }, async () => {
  const run = await startLane('wait', { env: { EXIT_AFTER: '1' } });
  try {
    assert.ok(run.ready, 'the stand-in host never wrote its pids');
    const [p] = run.pids;
    assert.ok(await waitFor(() => !alive(p.host), 5000), 'the stand-in host never exited');
    assert.ok(alive(p.child) && alive(p.grandchild), 'what it started outlives it until the lane ends');
    process.kill(-run.lane.pid, 'SIGTERM');
    assert.deepEqual(await within(run.exited, 15_000), { code: null, signal: 'SIGTERM' });
    assert.ok(await waitFor(() => !everyPid(run.pids).some(alive), 5000), `still running: ${JSON.stringify(run.pids)}`);
  } finally {
    cleanup(run);
  }
});

for (const [state, env] of [['a running', {}], ['an exited', { EXIT_AFTER: '1' }]]) {
  test(`stopHost on ${state} host kills everything it started, and the lane goes on`, { skip: noBun }, async () => {
    const run = await startLane('stopHost', { env });
    try {
      assert.ok(run.ready, 'the stand-in host never wrote its pids');
      assert.ok(await waitFor(() => existsSync(`${run.pidsFile}.stopped`), 5000), 'the lane never stopped its host');
      assert.ok(await waitFor(() => !everyPid(run.pids).some(alive), 5000), `still running: ${JSON.stringify(run.pids)}`);
      // Still running: no exit code and no signal, since a lane killed by a
      // signal has a null exitCode too.
      assert.deepEqual([run.lane.exitCode, run.lane.signalCode], [null, null], 'the lane ended as well');
    } finally {
      cleanup(run);
    }
  });
}

test('a lane killed with SIGKILL leaves its host running, which this test then kills', { skip: noBun }, async () => {
  const run = await startLane('wait');
  try {
    assert.ok(run.ready, 'the stand-in host never wrote its pids');
    process.kill(-run.lane.pid, 'SIGKILL');
    assert.deepEqual(await within(run.exited, 15_000), { code: null, signal: 'SIGKILL' });
    await sleep(500);
    assert.ok(everyPid(run.pids).every(alive), 'the host and what it started outlive a SIGKILLed lane');
  } finally {
    cleanup(run);
  }
});
