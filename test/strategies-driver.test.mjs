// The parts of the strategy fixture's driver (lib/strategies/driver.mjs) that
// need no host. Its runs through a host are its own evidence (see its commits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { recipeHash, recipeIdentity } from '../lib/strategies/driver.mjs';
import { configurations } from '../lib/strategies/script.mjs';

const facts = { takesMaintenanceInterval: false, kvUnified: { policy: { cacheScale: 100_000 }, tokenBucketSize: 50_000 } };
const configuration = configurations().default;
const SERVER = fileURLToPath(new URL('../lib/strategies/mcpl-server.mjs', import.meta.url));

test('the recipe the writer keys on leaves out where the lane runs from and what changes between runs, and its hash changes with what the recipe says', () => {
  const identity = JSON.stringify(recipeIdentity({ configuration, facts, channels: ['chat'] }));
  for (const [what, text] of [['node\'s path', process.execPath], ['the server\'s path', SERVER], ['the control socket', 'FIXTURE_CONTROL'], ['the boot', 'FIXTURE_BOOT']]) {
    assert.equal(identity.includes(text), false, what);
  }
  assert.ok(identity.includes('"FIXTURE_CHANNELS":"chat"'), 'the channels stay');
  const h = recipeHash({ configuration, facts, channels: ['chat'] });
  for (const [what, other] of [
    ['another model', recipeHash({ configuration: { ...configuration, agent: { ...configuration.agent, model: 'claude-opus-5-5' } }, facts, channels: ['chat'] })],
    ['another channel', recipeHash({ configuration, facts, channels: ['chat', 'other'] })],
    ['the host taking maintenanceIntervalMs', recipeHash({ configuration, facts: { ...facts, takesMaintenanceInterval: true }, channels: ['chat'] })],
    ['another kv-unified block', recipeHash({ configuration, facts: { ...facts, kvUnified: { ...facts.kvUnified, tokenBucketSize: 40_000 } }, channels: ['chat'] })],
  ]) assert.notEqual(other, h, what);
});
