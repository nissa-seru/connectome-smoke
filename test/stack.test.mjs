import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChange, satisfies, buildGraph, dependentsOf, topoOrder, classifyInstallFailure } from '../lib/stack.mjs';

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
  assert.deepEqual(classifyInstallFailure('npm error ENOSPC: no space left on device'), { cause: 'disk', infra: true });
  assert.deepEqual(classifyInstallFailure('npm error code 1\nnpm error command failed\nnpm error command sh -c node postinstall.js'), { cause: 'other', infra: false });
  // a network word outside npm's own error lines doesn't count
  assert.deepEqual(classifyInstallFailure('test: network request mocked\nnpm error code 1'), { cause: 'other', infra: false });
});
