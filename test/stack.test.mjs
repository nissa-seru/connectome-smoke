import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChange, satisfies, buildGraph, dependentsOf, topoOrder, classifyInstallFailure, parseTestFailures, runnerSummary, nodeFailingTests, testFailureFields, filesystemFull, diskFull, testCommand, mergeCommand } from '../lib/stack.mjs';

test('parseTestFailures names failing tests as bun, node, TAP and vitest print them', () => {
  const bun = [
    '(pass) resolveAgentName > explicit wins [0.14ms]',
    '(fail) buildCountTokensPayload > prefixes every text block of a named user message in place — no standalone name block [0.22ms]',
    ' 1210 pass',
    '(fail) buildCountTokensPayload > prefixes every text block of a named user message in place — no standalone name block [0.22ms]',
  ].join('\n');
  assert.deepEqual(parseTestFailures(bun), ['buildCountTokensPayload > prefixes every text block of a named user message in place — no standalone name block']);
  const nodeSpec = [
    '▶ AutobiographicalStrategy',
    '  ✔ fork inherits resolutions (239.44ms)',
    '  ✖ locks on fork do not affect parent (134.98ms)',
    '✖ AutobiographicalStrategy (601.26ms)',
    '✖ failing tests:',
    'test at dist/test/a.test.js:12:3',
    '✖ locks on fork do not affect parent (134.98ms)',
  ].join('\n');
  // the suite node closes with ✖ is left out: it was opened with ▶
  assert.deepEqual(parseTestFailures(nodeSpec), ['locks on fork do not affect parent']);
  assert.deepEqual(parseTestFailures('ok 1 - a\nnot ok 2 - b fails # time=3ms\n    not ok 1 - nested'), ['b fails', 'nested']);
  assert.deepEqual(parseTestFailures(' ✓ test/a.test.ts > ok 3ms\n × test/b.test.ts > suite > breaks 12ms\n FAIL  test/b.test.ts > suite > breaks'), ['test/b.test.ts > suite > breaks']);
  assert.deepEqual(parseTestFailures('\x1b[31m(fail)\x1b[0m colored > name [1.00ms]'), ['colored > name']);
  assert.deepEqual(parseTestFailures('Error: something else entirely'), []);
});

// Vitest 4's default reporter, as it printed one failure in a run of membrane's tests.
const vitestOne = [
  '\x1b[31m     \x1b[31m×\x1b[31m XML prefill: opt-in image shedding makes the round unknown\x1b[39m\x1b[33m 6341\x1b[2mms\x1b[22m\x1b[39m',
  '\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m128 passed\x1b[39m\x1b[22m\x1b[90m (129)\x1b[39m',
  '\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m2376 passed\x1b[39m\x1b[22m\x1b[90m (2377)\x1b[39m',
  '\x1b[31m⎯⎯⎯⎯⎯⎯⎯\x1b[39m\x1b[1m\x1b[41m Failed Tests 1 \x1b[49m\x1b[22m\x1b[31m⎯⎯⎯⎯⎯⎯⎯\x1b[39m',
  '\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m tests/unit/round-report.test.ts\x1b[2m > \x1b[22mreview\x1b[2m > \x1b[22mXML prefill: opt-in image shedding makes the round unknown',
].join('\n');

// Node 24's spec reporter, as it prints a describe() whose before() hook fails and a test whose subtest fails.
const nodeHook = [
  '▶ s', '  ✖ t1', '  ✖ t2', '✖ s (0.52ms)', '▶ u', '  ✖ t3 (0.21ms)', '✖ u (0.38ms)',
  'ℹ tests 3', 'ℹ suites 2', 'ℹ pass 0', 'ℹ fail 1', 'ℹ cancelled 2',
  '✖ failing tests:', '', 'test at d.test.mjs:4:3', '✖ t1', "  'test did not finish before its parent and was cancelled'", '',
  'test at d.test.mjs:5:3', '✖ t2', "  'test did not finish before its parent and was cancelled'", '',
  'test at d.test.mjs:2:1', '✖ s (0.52ms)', '  Error: before failed', '',
  'test at d.test.mjs:9:3', '✖ t3 (0.21ms)', '  Error: afterEach failed', '      at TestContext.<anonymous> (file:///d.test.mjs:8:27)',
].join('\n');
const nodeSubtest = [
  '▶ parent', '  ✔ child ok (0.1ms)', '  ✖ child fails (0.19ms)', '✖ parent (4.28ms)',
  'ℹ tests 3', 'ℹ suites 0', 'ℹ pass 1', 'ℹ fail 2',
  '✖ failing tests:', '', 'test at a.test.mjs:9:11', '✖ child fails (0.19ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:', '  ✖ a line of a failure\'s own output', '  1 !== 2',
].join('\n');

const nodeParentFails = [
  '▶ parent fails itself too', '  ✖ child fails (1.11ms)', '✖ parent fails itself too (1.84ms)',
  'ℹ tests 2', 'ℹ suites 0', 'ℹ pass 0', 'ℹ fail 2',
  '✖ failing tests:', '', 'test at k.test.mjs:4:11', '✖ child fails (1.11ms)', '  AssertionError [ERR_ASSERTION]: 1 !== 2', '',
  'test at k.test.mjs:3:1', '✖ parent fails itself too (1.84ms)', '  AssertionError [ERR_ASSERTION]: 3 !== 4',
].join('\n');

test("nodeFailingTests reads node's own list of failures at the end of its report", () => {
  assert.deepEqual(nodeFailingTests(nodeHook), ['t1', 't2', 's', 't3']);
  assert.deepEqual(nodeFailingTests(nodeSubtest), ['child fails']);
  assert.equal(nodeFailingTests('✔ a (1ms)\n✖ b (2ms)\nℹ fail 1'), null);
});

test("parseTestFailures takes vitest's list of failed tests over its tree, where the list is there", () => {
  assert.deepEqual(parseTestFailures(vitestOne), ['tests/unit/round-report.test.ts > review > XML prefill: opt-in image shedding makes the round unknown']);
  assert.deepEqual(parseTestFailures(' ✓ test/a.test.ts > ok 3ms\n × suite > breaks 12ms'), ['suite > breaks']);
});

test('runnerSummary reads what each runner says in its summary, the last count printed and the errors line after it', () => {
  assert.deepEqual(runnerSummary('▶ s\n  ✖ a (1ms)\n✖ s (2ms)\nℹ tests 7\nℹ suites 1\nℹ pass 2\nℹ fail 4\nℹ cancelled 0'), { failed: 4, errors: null, form: 'node' });
  assert.deepEqual(runnerSummary('not ok 1 - a\n# tests 3\n# pass 1\n# fail 2'), { failed: 2, errors: null, form: 'tap' });
  assert.deepEqual(runnerSummary(' 718 pass\n 75 fail\n 64 errors\n 5402 expect() calls\nRan 793 tests across 130 files. [53.49s]'), { failed: 75, errors: 64, form: 'bun' });
  assert.deepEqual(runnerSummary(' 0 pass\n 1 fail\n 1 error\nRan 1 test across 2 files. [8.00ms]'), { failed: 1, errors: 1, form: 'bun' });
  assert.deepEqual(runnerSummary(vitestOne), { failed: 1, errors: null, form: 'vitest' });
  assert.deepEqual(runnerSummary(`${vitestOne}\n\x1b[2m     Errors \x1b[22m \x1b[1m\x1b[31m1 error\x1b[39m\x1b[22m`), { failed: 1, errors: 1, form: 'vitest' });
  assert.deepEqual(runnerSummary(' Test Files  1 failed | 128 passed (129)\n      Tests  2376 passed (2376)'), { failed: null, errors: null, form: null });
  assert.deepEqual(runnerSummary('✔ a (1ms)\n✖ b (2ms)\n[puppet] assistant: odd--cyclic → ERROR in 1ms'), { failed: null, errors: null, form: null });
  assert.deepEqual(runnerSummary('a nested run printed:\n 3 fail\n...\nℹ tests 9\nℹ fail 1'), { failed: 1, errors: null, form: 'node' });
  // an errors line counts only after the last count of failed tests
  assert.deepEqual(runnerSummary('a test printed:\n 1 error\n 10 pass\n 1 fail\nRan 11 tests across 2 files.'), { failed: 1, errors: null, form: 'bun' });
  assert.deepEqual(runnerSummary(' 2 fail\n 1 error\n...\n 10 pass\n 1 fail\nRan 11 tests across 2 files.'), { failed: 1, errors: null, form: 'bun' });
});

test("testFailureFields reads a step's failures only when they're every failure its runner reports", () => {
  const bun = (names, fail, errors = 0) => [...names.map((n) => `(fail) ${n} [1.00ms]`), ` 10 pass`, ` ${fail} fail`, ...(errors ? [` ${errors} error${errors === 1 ? '' : 's'}`] : []), 'Ran 20 tests across 3 files. [1.00s]'].join('\n');
  assert.deepEqual(testFailureFields(bun(['s > a', 's > b'], 2)), { failures: ['s > a', 's > b'], failureCount: 2, failuresParsed: true });
  // bun counts a test file that failed to load as a failure and an error, and it has no name
  assert.deepEqual(testFailureFields(bun(['s > a'], 2, 1)), { failures: ['s > a'], failureCount: 2, failuresParsed: false });
  // an error bun reports outside any test, such as a rejection while a file loads, is in no count of failed tests
  assert.deepEqual(testFailureFields(bun(['s > a'], 1, 1)), { failures: ['s > a'], failureCount: 1, failuresParsed: false });
  // two failures that share a name can't be told apart by it
  assert.equal(testFailureFields(bun(['s > a', 's > a'], 2)).failuresParsed, false);
  // a node report cut before its summary: what it named isn't all there was
  assert.deepEqual(testFailureFields('✔ a (1ms)\n✖ b (2ms)\n# exit 1'), { failures: ['b'], failureCount: null, failuresParsed: false });
  // a node report cut after its summary and before its list: node's names are checked against its list alone
  assert.deepEqual(testFailureFields('✖ b (2ms)\nℹ tests 1\nℹ pass 0\nℹ fail 1'), { failures: ['b'], failureCount: 1, failuresParsed: false });
  // node's list is the names: a suite whose before() hook failed is among them, which no known test can stand for
  assert.deepEqual(testFailureFields(nodeHook), { failures: ['t1', 't2', 's', 't3'], failureCount: 1, failuresParsed: true });
  // a test that failed itself besides its subtest is in node's list, though it opened a group
  assert.deepEqual(testFailureFields(nodeParentFails), { failures: ['child fails', 'parent fails itself too'], failureCount: 2, failuresParsed: true });
  // a list cut short: a failure the report printed before it isn't in it
  assert.deepEqual(testFailureFields(nodeHook.slice(0, nodeHook.indexOf('test at d.test.mjs:9:3'))), { failures: ['t1', 't2', 's'], failureCount: 1, failuresParsed: false });
  // a name node lists twice is two failures one name can't tell apart
  assert.equal(testFailureFields('✖ a (1ms)\n✖ a (2ms)\nℹ tests 2\nℹ fail 2\n✖ failing tests:\n\n✖ a (1ms)\n\n✖ a (2ms)').failuresParsed, false);
  // node counts a test that failed through its subtests, and lists only the subtest: the list is what's compared
  assert.deepEqual(testFailureFields(nodeSubtest), { failures: ['child fails'], failureCount: 2, failuresParsed: true });
  // a ✖ line a test printed, which node doesn't list as a failure, keeps the names from being read
  assert.deepEqual(testFailureFields(nodeSubtest.replace('▶ parent', '✖ a line a test printed\n▶ parent')), { failures: ['child fails'], failureCount: 2, failuresParsed: false });
  // the same report cut short before its summary
  assert.deepEqual(testFailureFields(nodeSubtest.slice(0, nodeSubtest.indexOf('ℹ tests'))), { failures: ['child fails'], failureCount: null, failuresParsed: false });
  // a vitest file that wouldn't load is listed with FAIL, and isn't a failed test
  assert.equal(testFailureFields(`${vitestOne}\n FAIL  tests/unit/broken.test.ts [ tests/unit/broken.test.ts ]`).failuresParsed, false);
  assert.equal(testFailureFields(vitestOne).failuresParsed, true);
  // an unhandled error vitest reports fails no test
  assert.equal(testFailureFields(`${vitestOne}\n     Errors  1 error`).failuresParsed, false);
  // a step stopped at its time limit before its summary: what it named before the limit is read as it stands
  assert.deepEqual(testFailureFields('(fail) s > a [1.00ms]', { timedOut: true }), { failures: ['s > a'], failureCount: null, failuresParsed: true });
  assert.equal(testFailureFields('(pass) s > a [1.00ms]', { timedOut: true }).failuresParsed, false);
  // a step stopped at its time limit after its summary printed is checked like any other
  assert.equal(testFailureFields(bun(['s > a'], 2), { timedOut: true }).failuresParsed, false);
  assert.equal(testFailureFields(bun(['s > a'], 1), { timedOut: true }).failuresParsed, true);
  // a node step stopped after its summary and before its list
  assert.equal(testFailureFields('✖ b (2ms)\nℹ tests 1\nℹ pass 0\nℹ fail 1', { timedOut: true }).failuresParsed, false);
  // a bun run that counted a failure and named none
  assert.equal(testFailureFields(bun([], 1)).failuresParsed, false);
  // a bun run whose test printed a node report: bun's own count is compared, and node's list isn't its names
  const nestedNode = (name) => `✖ ${name} (1ms)\nℹ tests 1\nℹ fail 1\n✖ failing tests:\n\n✖ ${name} (1ms)`;
  assert.deepEqual(testFailureFields(`${nestedNode('s > a')}\n${bun(['s > a'], 2)}`), { failures: ['s > a'], failureCount: 2, failuresParsed: false });
  assert.deepEqual(testFailureFields(`${nestedNode('x')}\n${bun(['s > a'], 1)}`), { failures: ['x', 's > a'], failureCount: 1, failuresParsed: false });
  // node prints no errors line, so node's check reads none: details that read like bun's or vitest's don't count
  const strayErrors = nodeParentFails.replace('  AssertionError [ERR_ASSERTION]: 3 !== 4', '  AssertionError [ERR_ASSERTION]: 3 !== 4\n  2 errors\n     Errors  1 error');
  assert.deepEqual(testFailureFields(strayErrors), { failures: ['child fails', 'parent fails itself too'], failureCount: 2, failuresParsed: true });
  // a run that failed with no failing test named reads as unread, whatever count it gives
  assert.equal(testFailureFields('ℹ tests 3\nℹ fail 0\nError: something else entirely').failuresParsed, false);
});

test('parseChange reads pull and branch specs, with and without a pin', () => {
  assert.deepEqual(parseChange('connectome-host=pull/231'), { repo: 'connectome-host', spec: 'pull/231', kind: 'pull', pr: 231, pin: null });
  assert.deepEqual(parseChange('connectome-host=pull/231@29170b3'), { repo: 'connectome-host', spec: 'pull/231', kind: 'pull', pr: 231, pin: '29170b3' });
  assert.deepEqual(parseChange('agent-framework=nissa-seru:fix/a-b@0123456789abcdef'), { repo: 'agent-framework', spec: 'nissa-seru:fix/a-b', kind: 'branch', owner: 'nissa-seru', branch: 'fix/a-b', pin: '0123456789abcdef' });
  assert.throws(() => parseChange('connectome-host'), /expected/);
  assert.throws(() => parseChange('connectome-host=main'), /expected pull/);
  assert.throws(() => parseChange('connectome-host=pull/2@xyz'), /hex/);
});

test('satisfies follows npm for the range forms the stack declares', () => {
  assert.equal(satisfies('0.2.5', '^0.2.1'), true);
  assert.equal(satisfies('0.3.0', '^0.2.1'), false);          // caret on 0.x locks the minor
  assert.equal(satisfies('0.0.4', '^0.0.3'), false);          // and on 0.0.x the patch
  assert.equal(satisfies('1.4.0', '^1.2.3'), true);
  assert.equal(satisfies('2.0.0', '^1.2.3'), false);
  assert.equal(satisfies('1.2.9', '~1.2.3'), true);
  assert.equal(satisfies('1.3.0', '~1.2.3'), false);
  assert.equal(satisfies('0.5.86', '>=0.5.0 <0.6.0'), true);
  assert.equal(satisfies('0.6.0', '>=0.5.0 <0.6.0'), false);
  assert.equal(satisfies('1.2.3', '1.2.3'), true);
  assert.equal(satisfies('1.2.4', '1.2.x'), true);
  assert.equal(satisfies('1.3.0', '1.2'), false);
  assert.equal(satisfies('3.0.0', '^1.0.0 || ^3.0.0'), true);
  assert.equal(satisfies('0.4.1-beta.1', '^0.4.0'), false);   // prereleases need a prerelease range
  assert.equal(satisfies('0.1.0', 'file:../voice-kit'), true);
  assert.equal(satisfies('0.1.0', 'github:owner/repo'), null);
});

const pkgs = [
  { key: 'voice-kit', name: '@animalabs/voice-kit', pj: {} },
  { key: 'mcpl-core-ts', name: '@animalabs/mcpl-core', pj: {} },
  { key: 'membrane', name: '@animalabs/membrane', pj: {} },
  { key: 'context-manager', name: '@animalabs/context-manager', pj: { dependencies: { '@animalabs/membrane': '^0.5.69' } } },
  { key: 'agent-framework', name: '@animalabs/agent-framework', pj: { dependencies: { '@animalabs/context-manager': '^0.13.0', '@animalabs/membrane': '^0.5.78' } } },
  { key: 'connectome-host', name: '@animalabs/connectome-host', pj: { dependencies: { '@animalabs/agent-framework': '^0.21.0', '@animalabs/membrane': '^0.5.86' } } },
  { key: 'heartbeat-mcpl', name: '@animalabs/heartbeat-mcpl', pj: { dependencies: { '@animalabs/mcpl-core': '^0.2.1' } } },
  { key: 'discord-mcpl', name: '@animalabs/discord-mcpl', pj: { dependencies: { '@animalabs/mcpl-core': '^0.2.1', '@animalabs/voice-kit': 'file:../voice-kit' } } },
];

test('the graph comes from declared dependencies, and dependents are transitive', () => {
  const edges = buildGraph(pkgs);
  assert.equal(edges.length, 8);
  const deps = dependentsOf(['membrane'], edges);
  assert.deepEqual(deps.map((d) => d.pkg).sort(), ['agent-framework', 'connectome-host', 'context-manager']);
  assert.deepEqual(deps.find((d) => d.pkg === 'connectome-host').via, { dep: 'membrane', range: '^0.5.86', field: 'dependencies' });
  assert.deepEqual(dependentsOf(['voice-kit'], edges).map((d) => d.pkg), ['discord-mcpl']);
  assert.deepEqual(dependentsOf(['connectome-host'], edges), []);
});

test('topoOrder puts dependencies first and keeps the given order among ties', () => {
  const edges = buildGraph(pkgs);
  const order = topoOrder(['connectome-host', 'agent-framework', 'context-manager', 'membrane'], edges);
  assert.deepEqual(order, ['membrane', 'context-manager', 'agent-framework', 'connectome-host']);
  assert.throws(() => topoOrder(['a', 'b'], [{ dep: 'a', dependent: 'b' }, { dep: 'b', dependent: 'a' }]), /cycle/);
});

test('install failures are classified from npm error lines', () => {
  assert.deepEqual(classifyInstallFailure('npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.'), { cause: 'lockfile', infra: false });
  assert.deepEqual(classifyInstallFailure('npm error Missing: zod@4.1.0 from lock file'), { cause: 'lockfile', infra: false });
  assert.deepEqual(classifyInstallFailure('npm error code ECONNRESET\nnpm error network aborted'), { cause: 'network', infra: true });
  assert.deepEqual(classifyInstallFailure('npm error code E503'), { cause: 'network', infra: true });
  // A full disk is read from the disk itself, before this (diskFull).
  assert.deepEqual(classifyInstallFailure('npm error ENOSPC: no space left on device'), { cause: 'other', infra: false });
  assert.deepEqual(classifyInstallFailure('npm error code 1\nnpm error command failed\nnpm error command sh -c node postinstall.js'), { cause: 'other', infra: false });
  // a network word outside npm's own error lines doesn't count
  assert.deepEqual(classifyInstallFailure('test: network request mocked\nnpm error code 1'), { cause: 'other', infra: false });
});

test('filesystemFull reads a filesystem as full the way ENOSPC means it: near nothing left, at any size', () => {
  const GiB = 2 ** 30;
  const MiB = 2 ** 20;
  // A filesystem of `size` bytes in 4 KiB blocks, with `avail` bytes left to an unprivileged process.
  const fs = (size, avail, o = {}) => ({ frsize: 4096, bsize: 4096, blocks: size / 4096, bfree: avail / 4096 + 1000, bavail: avail / 4096, files: 1e6, ffree: 5e5, ...o });
  // A 503 GiB disk, as the runner's is: 9 GiB left isn't full, and under 1 GiB is.
  assert.equal(filesystemFull(fs(503 * GiB, 9 * GiB)), false);
  assert.equal(filesystemFull(fs(503 * GiB, 1 * GiB)), false);
  assert.equal(filesystemFull(fs(503 * GiB, 1023 * MiB)), true);
  // A 512 MiB filesystem: its margin is 1%, about 5 MiB.
  assert.equal(filesystemFull(fs(512 * MiB, 6 * MiB)), false);
  assert.equal(filesystemFull(fs(512 * MiB, 5 * MiB)), true);
  // Blocks only root may use, which an unprivileged process can't, don't count as room.
  assert.equal(filesystemFull(fs(503 * GiB, 0, { bfree: (25 * GiB) / 4096 })), true);
  // Free inodes under 1,024, or under 1% of a filesystem with fewer than 102,400.
  assert.equal(filesystemFull(fs(503 * GiB, 9 * GiB, { files: 3e7, ffree: 1023 })), true);
  assert.equal(filesystemFull(fs(503 * GiB, 9 * GiB, { files: 3e7, ffree: 1024 })), false);
  assert.equal(filesystemFull(fs(503 * GiB, 9 * GiB, { files: 50000, ffree: 499 })), true);
  assert.equal(filesystemFull(fs(503 * GiB, 9 * GiB, { files: 50000, ffree: 600 })), false);
  // A filesystem that counts no inodes, as btrfs doesn't, reads by its blocks alone.
  assert.equal(filesystemFull(fs(503 * GiB, 9 * GiB, { files: 0, ffree: 0 })), false);
  assert.equal(filesystemFull(fs(503 * GiB, 0, { files: 0, ffree: 0 })), true);
  // Blocks count in frsize: with a 16 times larger bsize, 512 MiB left is still under 1 GiB.
  assert.equal(filesystemFull(fs(503 * GiB, 512 * MiB, { bsize: 65536 })), true);
  // Without frsize, bsize is the block's size.
  assert.equal(filesystemFull(fs(503 * GiB, 63 * MiB, { frsize: undefined })), true);
});

test("diskFull takes ENOSPC in a step's output as a full disk only when a filesystem it reads is nearly full", () => {
  const GiB = 2 ** 30;
  const roomy = { frsize: 4096, bsize: 4096, blocks: (503 * GiB) / 4096, bfree: (12 * GiB) / 4096, bavail: (9 * GiB) / 4096, files: 3e7, ffree: 2e7 };
  const full = { ...roomy, bfree: 1000, bavail: 0 };
  const noFreeInodes = { ...roomy, ffree: 0 };
  const statfs = (stats) => (p) => {
    if (!(p in stats)) throw Object.assign(new Error(`ENOENT: no such file or directory, statfs '${p}'`), { code: 'ENOENT' });
    return stats[p];
  };
  // The line agent-framework's tests log on purpose.
  const printed = 'Error in event loop: Error: ENOSPC: no space left on device';
  assert.equal(diskFull(printed, ['/w', '/t', '/h'], statfs({ '/w': roomy, '/t': roomy, '/h': roomy })), false);
  // Any one of them full is a full disk, by its blocks or its inodes.
  assert.equal(diskFull(printed, ['/w', '/t', '/h'], statfs({ '/w': roomy, '/t': full, '/h': roomy })), true);
  assert.equal(diskFull(printed, ['/w', '/t', '/h'], statfs({ '/w': roomy, '/t': roomy, '/h': full })), true);
  assert.equal(diskFull(printed, ['/w', '/t'], statfs({ '/w': noFreeInodes, '/t': roomy })), true);
  // Either wording, in any case.
  assert.equal(diskFull('Error: ENOSPC, write', ['/w'], statfs({ '/w': full })), true);
  assert.equal(diskFull('OSError: [Errno 28] No space left on device', ['/w'], statfs({ '/w': full })), true);
  // Without the text, a full filesystem isn't this step's reason.
  assert.equal(diskFull('ℹ fail 1', ['/w'], statfs({ '/w': full })), false);
  // A filesystem that can't be read counts as one with room, and the next is still read.
  assert.equal(diskFull(printed, ['/w', '/t'], statfs({})), false);
  assert.equal(diskFull(printed, ['/w', '/t'], statfs({ '/t': roomy })), false);
  assert.equal(diskFull(printed, ['/w', '/t'], statfs({ '/t': full })), true);
});

test("connectome-host's suite runs as its CI runs it, by `bun test --parallel`, and its failures are read whole", () => {
  const out = [
    "bun's tmpdir(): /dev/shm/t.hfgu6Z",
    'Filesystem     Type   Size  Used Avail Use% Mounted on',
    'tmpfs          tmpfs   16G  2.2M   16G   1% /dev/shm',
    '', '> test', '> bun test --parallel=4', '',
    'bun test v1.4.4 (38afee6c8) 4x PARALLEL', '',
    'test/a.test.ts:', '(pass) a case 1 [0.02ms]', '(pass) a case 2',
    '(pass) b case 30',
    '(fail) b breaks on purpose [0.24ms]',
    "32 | test('b breaks on purpose', () => { expect(1).toBe(2); });",
    '                                                   ^',
    'error: expect(received).toBe(expected)', '', 'Expected: 2', 'Received: 1', '',
    '      at <anonymous> (/home/nissa/suite/test/b.test.ts:32:47)', '',
    'test/d.test.ts:', '(pass) d case 30',
    "32 | test('d breaks too', () => { throw new Error('x'); });",
    'error: x',
    '      at <anonymous> (/home/nissa/suite/test/d.test.ts:32:49)',
    '(fail) d breaks too [0.16ms]', '',
    '2 tests failed:', '(fail) b breaks on purpose [0.24ms]', '(fail) d breaks too [0.16ms]', '',
    ' 120 pass', ' 2 fail', ' 121 expect() calls', 'Ran 122 tests across 4 files. [110.00ms]',
    'Filesystem      Size  Used Avail Use% Mounted on',
    'tmpfs            16G  2.7M   16G   1% /dev/shm',
  ].join('\n');
  assert.deepEqual(testFailureFields(out), { failures: ['b breaks on purpose', 'd breaks too'], failureCount: 2, failuresParsed: true });
});

test("a package's tests run by the script its repository's CI runs where the checkout has it, else by `npm test`", () => {
  const host = { R: { testScript: 'scripts/test-on-tmpfs.sh' }, pj: { scripts: { test: 'bun test' } } };
  const af = { R: { testScript: 'scripts/test-as-ci.mjs' }, pj: { scripts: { test: 'node --test' } } };
  assert.equal(testCommand(host, (f) => f === 'scripts/test-on-tmpfs.sh'), 'bash scripts/test-on-tmpfs.sh');
  assert.equal(testCommand(af, (f) => f === 'scripts/test-as-ci.mjs'), 'node scripts/test-as-ci.mjs');
  assert.equal(testCommand(host, () => false), 'npm test');
  assert.equal(testCommand({ R: {}, pj: { scripts: { test: 'x' } } }, () => true), 'npm test');
  assert.equal(testCommand({ R: {}, pj: { scripts: {} } }, () => true), null);
});

test('the same changes merged onto the same main at two clock times make the same merge commit, chained changes included', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-merge-'));
  const git = (args, env = {}) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8', env: { ...process.env, ...env } });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (msg) => git(['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '--allow-empty', '-m', msg]);
  try {
    git(['init', '-q', '-b', 'main']);
    commit('base');
    git(['checkout', '-q', '-b', 'one']); commit('one');
    const one = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', 'main']); git(['checkout', '-q', '-b', 'two']); commit('two');
    const two = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', 'main']); commit('main moves on');
    const main = git(['rev-parse', 'HEAD']);
    const mergeAll = () => {
      git(['checkout', '-q', '--detach', main]);
      for (const [spec, head] of [['pull/1', one], ['pull/2', two]]) {
        const m = mergeCommand(spec, head, git(['log', '-1', '--format=%cI', head]));
        const r = spawnSync(m.argv[0], m.argv.slice(1), { cwd: dir, encoding: 'utf-8', env: { ...process.env, ...m.env } });
        assert.equal(r.status, 0, r.stderr);
      }
      return git(['rev-parse', 'HEAD']);
    };
    const first = mergeAll();
    const second = Math.floor(Date.now() / 1000);
    while (Math.floor(Date.now() / 1000) === second) await new Promise((r) => setTimeout(r, 20));
    assert.equal(mergeAll(), first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
