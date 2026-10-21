import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawnToFiles } from '../lib/common.mjs';

const node = (code, opts) => spawnToFiles(process.execPath, ['-e', code], opts);
const captures = () => [existsSync('/dev/shm') ? '/dev/shm' : null, tmpdir()].filter(Boolean)
  .flatMap((d) => readdirSync(d).filter((n) => n.startsWith('smoke-out-')).map((n) => `${d}/${n}`));
/** Whether a pid runs, a zombie not counting, waiting up to a second for one just killed to go. */
const runs = async (pid) => {
  for (let i = 0; i < 20; i++) {
    let state;
    try { state = readFileSync(`/proc/${pid}/stat`, 'utf-8').replace(/^.*\) /, '')[0]; } catch { return false; }
    if (state === 'Z') return false;
    await sleep(50);
  }
  return true;
};

test('spawnToFiles keeps all a process wrote before ending itself, where a pipe loses what it had not taken', () => {
  // As a test runner under --test-force-exit: more than a pipe holds, then process.exit at once.
  const r = node("process.stdout.write('x'.repeat(8 << 20)); process.stdout.write('\\nsummary\\n'); process.exit(0)");
  assert.equal(r.status, 0);
  assert.equal(r.stdout.length, (8 << 20) + '\nsummary\n'.length);
  assert.ok(r.stdout.endsWith('\nsummary\n'));
});

test('spawnToFiles gives stdout and stderr apart, with the status, signal and errors spawnSync gives', () => {
  const r = node("process.stdout.write('out'); process.stderr.write('err'); process.exit(3)", { cwd: tmpdir(), env: { ...process.env, X: '1' } });
  assert.deepEqual([r.status, r.signal, r.stdout, r.stderr, r.error, r.leftovers], [3, null, 'out', 'err', undefined, []]);
  assert.deepEqual(r.output, [null, 'out', 'err']);
  // The environment and working directory reach the command.
  assert.equal(node("process.stdout.write(process.env.X + ' ' + process.cwd())", { cwd: tmpdir(), env: { ...process.env, X: 'seen' } }).stdout, `seen ${tmpdir()}`);
  // Its stdin is empty.
  assert.equal(node("process.stdin.on('data', (d) => process.stdout.write('got ' + d)).on('end', () => process.stdout.write('end'))").stdout, 'end');
  const missing = spawnToFiles('no-such-command-smoke', []);
  assert.equal(missing.error?.code, 'ENOENT');
  const slow = node("process.stdout.write('started'); setTimeout(() => {}, 60_000)", { timeout: 500 });
  assert.deepEqual([slow.error?.code, slow.signal, slow.stdout], ['ETIMEDOUT', 'SIGTERM', 'started']);
});

test('spawnToFiles kills and names what the command left running, and nothing else', async () => {
  // Agnes-1009's case: the command starts a grandchild that keeps writing to the command's stdout, then exits at once.
  const other = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const t0 = Date.now();
    const r = node("require('child_process').spawn(process.execPath, ['-e', \"let n = 0; setInterval(() => process.stdout.write('tick ' + n++ + '\\\\n'), 100)\"], { stdio: ['ignore', 'inherit', 'inherit'] }); console.log('child exits'); process.exit(0)");
    assert.ok(Date.now() - t0 < 5_000, 'returns when the command exits');
    assert.equal(r.status, 0);
    assert.ok(r.stdout.startsWith('child exits\n'));
    assert.equal(r.leftovers.length, 1);
    assert.match(r.leftovers[0].command, /tick/);
    assert.equal(r.leftoversChecked, true);
    assert.equal(await runs(r.leftovers[0].pid), false, 'the leftover is gone');
    // A process the command didn't start is left alone.
    assert.equal(await runs(other.pid), true);
  } finally { other.kill('SIGKILL'); }
});

test('spawnToFiles bounds what the command writes, and says when it reached the bound', () => {
  // A writer that dies of SIGXFSZ at the bound.
  const sh = spawnToFiles('sh', ['-c', 'head -c 5000 /dev/zero'], { maxBytes: 1000 });
  assert.equal(sh.bounded, true);
  assert.equal(sh.stdout.length, 1000);
  assert.equal(sh.error?.code, 'EFBIG');
  // Node ignores SIGXFSZ, and its stdout drops the write's EFBIG, so it exits 0 with its output cut off.
  const n = node("process.stdout.write('a'.repeat(5000))", { maxBytes: 1000 });
  assert.deepEqual([n.status, n.stdout.length, n.error?.code], [0, 1000, 'EFBIG']);
  // Under the bound, nothing is said.
  assert.equal(node("process.stdout.write('a'.repeat(999))", { maxBytes: 1000 }).error, undefined);
});

test('spawnToFiles leaves no files behind', () => {
  const before = captures();
  node("process.stdout.write('a'.repeat(1000)); process.stderr.write('b'.repeat(10))");
  assert.deepEqual(captures(), before);
});
