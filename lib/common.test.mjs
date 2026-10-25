// The lines of a failed command's output that a lane's report keeps. Run
// with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exerciseBoot, failureEventLine, failureLines, INFERENCE_FAILURE_KEYS } from './common.mjs';

test('a failing test\'s name from Node\'s spec reporter is kept, beside the error and the counts', () => {
  // As Node 24's test runner prints a failure when its output is piped,
  // with a test name that says nothing of failing.
  const out = [
    '✔ recipe-save-unresolved: saves a recipe (4.1ms)',
    '✖ clearSavedRecipe refuses a directory (2.3ms)',
    'ℹ tests 2',
    'ℹ pass 1',
    'ℹ fail 1',
    '',
    '✖ failing tests:',
    '',
    'test at test/recipe-save-unresolved.test.ts:322:1',
    '✖ clearSavedRecipe refuses a directory (2.3ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  ];
  assert.deepEqual(failureLines(out), [
    '✖ clearSavedRecipe refuses a directory (2.3ms)',
    'ℹ fail 1',
    '✖ failing tests:',
    '✖ clearSavedRecipe refuses a directory (2.3ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  ]);
});

test('vitest\'s, TAP\'s and ✗-marked failing lines are kept, and only the last 30 of them', () => {
  // The ✗ line's test name says nothing of failing either.
  assert.deepEqual(
    failureLines([' FAIL  test/a.test.ts > a case', 'not ok 3 - another case', 'ok 4 - passes', '✗ saves a recipe']),
    [' FAIL  test/a.test.ts > a case', 'not ok 3 - another case', '✗ saves a recipe'],
  );
  // Ordinary lines after the failing ones: the last 30 are of the failing
  // lines, not of the output.
  const many = Array.from({ length: 40 }, (_, i) => `not ok ${i + 1} - case ${i + 1}`);
  const after = Array.from({ length: 31 }, (_, i) => `# diagnostic ${i + 1}`);
  assert.deepEqual(failureLines([...many, ...after]), many.slice(-30));
});

test('a boot whose ipc socket refuses every connection names the socket by its label, not by this process\'s pid', async () => {
  // A stand-in `bun` that makes the socket's path a plain file, which refuses
  // connections, and stays up: the host that opens its socket but won't take
  // a connection, on every runtime alike.
  const dir = mkdtempSync(join(tmpdir(), 'cs-fake-host-'));
  try {
    writeFileSync(join(dir, 'bun'), '#!/bin/sh\nwhile [ "$1" != --socket-path ]; do shift; done\n: > "$2"\nexec sleep 30\n');
    chmodSync(join(dir, 'bun'), 0o755);
    await assert.rejects(
      exerciseBoot({ hostDir: dir, recipePath: join(dir, 'recipe.json'), dataDir: join(dir, 'data'), work: dir, label: 'boot1', env: { PATH: `${dir}:${process.env.PATH}` } }),
      (e) => {
        const first = e.message.split('\n')[0];
        assert.match(first, /^ipc connect failed: .*<boot1 socket>$/);
        assert.ok(!first.includes(String(process.pid)), first);
        return true;
      },
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A stand-in host that speaks the boot's ipc: it opens its socket, says it's
// ready, answers /help and a text, and adds both clocks to every event, as
// agent-framework (`timestamp`) and the host (`ts`) do. $CS_FAKE says which
// failure it reports: an MCPL server's failed connect, with its stderr and
// attempt, followed by its first reconnect's failure, which reads otherwise
// and on another runtime may not have arrived yet; or a failed inference
// with its stack.
const FAKE_HOST = `
import { createServer } from 'node:net';
const sockPath = process.argv[process.argv.indexOf('--socket-path') + 1];
const emit = (c, e) => c.write(JSON.stringify({ ...e, timestamp: Date.now(), ts: Date.now() }) + '\\n');
createServer((c) => {
  emit(c, { type: 'lifecycle', phase: 'ready' });
  if (process.env.CS_FAKE === 'mcpl') {
    emit(c, { type: 'mcpl:server-connect-failed', serverId: 'heartbeat', error: 'MCP error -32000: Connection closed', stderrTail: 'node:internal/modules/esm/resolve:857', attempt: 0, willRetry: true });
    emit(c, { type: 'mcpl:server-connect-failed', serverId: 'heartbeat', error: 'MCP handshake timed out', attempt: 1, willRetry: true });
  }
  let buf = '';
  c.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\\n')) >= 0; buf = buf.slice(i + 1)) {
      const m = JSON.parse(buf.slice(0, i));
      if (m.type === 'command') for (let n = 0; n < 3; n++) emit(c, { type: 'command-output', text: 'help' });
      if (m.type === 'text') {
        emit(c, { type: 'message:added', source: 'external-message' });
        emit(c, { type: 'inference:failed', agentName: 'smoke', error: 'boom', stack: 'Error: boom\\n    at ' + process.cwd() + '/src/index.ts:1:1' });
        emit(c, { type: 'inference:speech', agentName: 'smoke', content: 'SMOKE-REPLY ' + m.content.split(' ')[2] });
        emit(c, { type: 'lifecycle', phase: 'idle' });
      }
    }
  });
}).listen(sockPath);
`;

async function failingLineOf(fake) {
  const dir = mkdtempSync(join(tmpdir(), 'cs-fake-host-'));
  try {
    writeFileSync(join(dir, 'host.mjs'), FAKE_HOST);
    writeFileSync(join(dir, 'bun'), '#!/bin/sh\nexec node "$(dirname "$0")/host.mjs" "$@"\n');
    chmodSync(join(dir, 'bun'), 0o755);
    let first;
    await assert.rejects(
      exerciseBoot({ hostDir: dir, recipePath: join(dir, 'recipe.json'), dataDir: join(dir, 'data'), work: dir, label: 'boot1', nonce: 'n1', env: { PATH: `${dir}:${process.env.PATH}`, CS_FAKE: fake } }),
      (e) => { first = e.message.split('\n')[0]; return true; },
    );
    return first;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a boot\'s MCPL failure line quotes only the first failure, by the keys that name it, so it reads the same on every runtime', async () => {
  assert.equal(await failingLineOf('mcpl'), 'MCPL server trouble: {"type":"mcpl:server-connect-failed","serverId":"heartbeat","error":"MCP error -32000: Connection closed"}');
});

test('a boot\'s inference failure line quotes the event by the keys that name it, without its clocks or its stack', async () => {
  assert.equal(await failingLineOf('inference'), 'inference failures: {"type":"inference:failed","agentName":"smoke","error":"boom"}');
});

test('a failure\'s line keeps only the listed keys, in the list\'s order, leaving out those the event lacks', () => {
  assert.equal(
    failureEventLine({ httpStatus: 400, retryable: false, error: 'bad', type: 'inference:exhausted', agentName: 'smoke', timestamp: 1, ts: 2, added: { later: true } }, INFERENCE_FAILURE_KEYS),
    '{"type":"inference:exhausted","agentName":"smoke","error":"bad","httpStatus":400}',
  );
  assert.equal(failureEventLine({ type: 't', error: { code: 1, detail: ['a'] } }, ['type', 'error']), '{"type":"t","error":{"code":1,"detail":["a"]}}');
});
