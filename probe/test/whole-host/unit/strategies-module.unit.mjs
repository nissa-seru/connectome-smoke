import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessModule } from '../lib/strategies/module.mjs';
class Manager {
  constructor(tokens = 1_000) {
    this.tokens = tokens;
    this.messages = [{ id: 1, sequence: 1, content: [{ type: 'text', text: '[[c:a.in]] hello' }] }];
  }
  getAllMessages() { return this.messages; }
  getSummariesInRange() { return []; }
  getSummary() { return null; }
  getStrategy() { return {}; }
  getRenderStats() { return null; }
  getMaxSummaryLevel() { return 0; }
  listPins() { return []; }
  async compile() { return { messages: [], renderStats: { total: { tokens: this.tokens } } }; }
}
const harness = (framework) => {
  const module = new HarnessModule(null);
  module.framework = framework;
  const Own = class extends Manager {};
  module.wrapManagerCompile(Own.prototype);
  return [module, Own];
};

test('module: a compile given no budget is held to the budget context-manager then takes, 100,000 with 4,000 reserved', async () => {
  const [module, Own] = harness(null);
  const over = new Own(98_000);
  over.messages = [];
  module.agentOf.set(over, 'fixture');
  await over.compile();
  await over.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
  const [defaulted, given] = module.lines;
  assert.equal(defaulted.budget, null, 'the line records the budget as passed');
  assert.deepEqual(defaulted.violations.map((v) => v.invariant), ['budget']);
  assert.match(defaulted.violations[0].detail, /98000 tokens against an input budget of 96000/);
  assert.deepEqual(given.violations, []);
});

test('module: a take covers an agent that compiled and has left the registry once more, from the manager kept at its compile, then forgets it', async () => {
  const registered = [];
  const managers = new Map();
  const [module, Own] = harness({ listAgents: () => registered.map((name) => ({ name })), getAgent: (name) => (registered.includes(name) ? { getContextManager: () => managers.get(name) } : null) });
  const sub = new Own();
  managers.set('sub', sub);
  registered.push('sub');
  module.agentOf.set(sub, 'sub');
  await sub.compile();
  registered.length = 0;
  sub.messages = [...sub.messages, { id: 2, sequence: 2, content: [{ type: 'text', text: '[[c:a.report]] done' }] }];
  const last = await module.answer({ op: 'take' });
  assert.deepEqual(last.store.sub.messages, [['1', ['[[c:a.in]]']], ['2', ['[[c:a.report]]']]], 'its store, read after it left');
  assert.equal(last.lines.length, 1);
  const after = await module.answer({ op: 'take' });
  assert.deepEqual(after.store, {}, 'once, then forgotten');
});

test('module: with recording off it wraps no agent compile and records no compile, yet counts every manager\'s ticks, and its reads still answer', async () => {
  const boot = (record) => {
    const module = new HarnessModule('/nowhere', { record });
    module.connect = () => {};
    const Own = class extends Manager {};
    const manager = new Own();
    const Agent = class { compileWithInjections() {} compileContext() {} getContextManager() { return manager; } };
    const originals = { compileWithInjections: Agent.prototype.compileWithInjections, compileContext: Agent.prototype.compileContext };
    const agent = Object.assign(new Agent(), { name: 'fixture' });
    module.setFramework({ getPrimaryAgentName: () => 'fixture', getAgent: (name) => (name === 'fixture' ? agent : null), listAgents: () => [{ name: 'fixture' }] });
    return { module, manager, Own, Agent, originals };
  };
  const off = boot(false);
  for (const [name, original] of Object.entries(off.originals)) assert.equal(off.Agent.prototype[name], original, `${name} isn't wrapped`);
  await off.manager.compile();
  assert.deepEqual(off.module.lines, [], 'no line is recorded, not only none handed over');
  let finish;
  const strategy = { tick: () => new Promise((resolve) => { finish = resolve; }) };
  const second = new off.Own();
  second.getStrategy = () => strategy;
  await second.compile();
  const ticking = strategy.tick();
  assert.equal(off.module.ticksInFlight(second), 1, 'a second manager\'s tick, watched from its compile');
  finish();
  await ticking;
  assert.equal(off.module.ticksInFlight(second), 0);
  assert.deepEqual((await off.module.answer({ op: 'messages', agent: 'fixture' })).map((m) => m.canaries), [['[[c:a.in]]']]);
  assert.deepEqual(await off.module.answer({ op: 'state', agent: 'fixture' }), { maxLevel: 0 });
  const on = boot(true);
  for (const [name, original] of Object.entries(on.originals)) assert.notEqual(on.Agent.prototype[name], original, `${name} is wrapped with recording on`);
  await on.manager.compile();
  const taken = await on.module.answer({ op: 'take' });
  assert.equal(taken.lines.length, 1, 'the same compile, recorded');
  assert.ok(taken.store.fixture);
});

test('module: a compile\'s view member another agent\'s slot holds is read from that agent\'s manager', async () => {
  const shared = new Manager();
  shared.messages = [{ id: 9, sequence: 9, content: [{ type: 'text', text: '[[c:a.chat]] hi' }] }];
  const [module, Own] = harness({ listAgents: () => [{ name: 'fixture' }, { name: 'reader' }], getAgent: (name) => (name === 'fixture' ? { getContextManager: () => shared } : null) });
  const reader = new Own();
  assert.deepEqual(module.elsewhere(reader, ['9', '10']), { found: shared.messages, unfound: ['10'] });
  assert.deepEqual(module.elsewhere(shared, ['9']), { found: [], unfound: ['9'] }, 'never its own slot');
});
