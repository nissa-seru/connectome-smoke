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
  async compile() { return { messages: [], renderStats: { total: { tokens: this.tokens } }, provenance: { layout: { memberIds: [], units: [] } } }; }
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
  assert.deepEqual(module.elsewhere(reader, ['9', '10']), { found: shared.messages, unfound: ['10'], from: ['fixture'] }, 'and which agent\'s slot held them');
  assert.deepEqual(module.elsewhere(shared, ['9']), { found: [], unfound: ['9'], from: [] }, 'never its own slot');
});

test('module: a reader\'s compile judges the members of its view another agent\'s slot holds, through the compile it records', async () => {
  const shared = new Manager();
  shared.messages = [{ id: 9, sequence: 9, content: [{ type: 'text', text: '[[c:a.chat]] hi' }] }];
  const module = new HarnessModule(null);
  module.framework = { listAgents: () => [{ name: 'fixture' }], getAgent: (name) => (name === 'fixture' ? { getContextManager: () => shared } : null) };
  const Reader = class extends Manager {
    async compile() { return { messages: [], renderStats: { total: { tokens: 1 } }, provenance: { layout: { memberIds: ['9'], units: [{ k: 'o', n: 1 }] } } }; }
  };
  module.wrapManagerCompile(Reader.prototype);
  const reader = new Reader();
  reader.messages = [];
  module.agentOf.set(reader, 'reader');
  await reader.compile({ maxTokens: 1_000, reserveForResponse: 0 });
  assert.deepEqual(module.lines[0].violations, [{ invariant: 'coverage', detail: '1 stored bodies in no message sent: 9' }], 'the shared slot\'s member is judged, not unreadable');
});

test('module: another slot is read only on the compiling manager\'s branch, so a fork\'s copy of a message never stands for the resident\'s', () => {
  const resident = new Manager();
  resident.messages = [{ id: 9, sequence: 9, content: [{ type: 'text', text: 'as stored' }] }];
  const fork = new Manager();
  fork.messages = [{ id: 9, sequence: 9, content: [{ type: 'text', text: 'edited on the fork' }] }];
  fork.getDerivation = () => ({ branch: 'fork-1', parentBranch: 'main' });
  const [module, Own] = harness({ listAgents: () => [{ name: 'fork' }, { name: 'fixture' }], getAgent: (name) => ({ getContextManager: () => (name === 'fork' ? fork : resident) }) });
  assert.deepEqual(module.elsewhere(new Own(), ['9']).found, resident.messages);
  const onFork = new Own();
  onFork.getDerivation = () => ({ branch: 'fork-1', parentBranch: 'main' });
  assert.deepEqual(module.elsewhere(onFork, ['9']).found, fork.messages);
});

test('module: an ended agent\'s tick still in flight counts in ticks, and its manager is read on each take until it settles, the change its tick made included', async () => {
  let registered = ['sub'];
  const managers = new Map();
  const [module, Own] = harness({ listAgents: () => registered.map((name) => ({ name })), getAgent: (name) => (registered.includes(name) ? { getContextManager: () => managers.get(name) } : null) });
  let finish;
  const strategy = { tick: () => new Promise((resolve) => { finish = resolve; }) };
  const sub = new Own();
  sub.getStrategy = () => strategy;
  managers.set('sub', sub);
  module.agentOf.set(sub, 'sub');
  await sub.compile();
  const ticking = strategy.tick();
  registered = [];
  assert.deepEqual(await module.answer({ op: 'ticks' }), { 'sub (ended)': 1 });
  const during = await module.answer({ op: 'take' });
  assert.deepEqual(during.store.sub.messages, [['1', ['[[c:a.in]]']]]);
  sub.messages = [...sub.messages, { id: 2, sequence: 2, content: [{ type: 'text', text: '[[c:a.summary]] done' }] }];
  finish();
  await ticking;
  assert.deepEqual(await module.answer({ op: 'ticks' }), {});
  const after = await module.answer({ op: 'take' });
  assert.deepEqual(after.store.sub.messages, [['2', ['[[c:a.summary]]']]], 'what its tick wrote after it left');
  assert.deepEqual((await module.answer({ op: 'take' })).store, {}, 'then forgotten');
});

test('module: with recording off, an ended agent\'s tick in flight still counts in ticks', async () => {
  let registered = ['fixture', 'sub'];
  const fixtureManager = new (class extends Manager {})();
  const Own = class extends Manager {};
  const sub = new Own();
  let finish;
  const strategy = { tick: () => new Promise((resolve) => { finish = resolve; }) };
  sub.getStrategy = () => strategy;
  const module = new HarnessModule('/nowhere', { record: false });
  module.connect = () => {};
  const Agent = class { getContextManager() { return this.manager; } };
  const agents = { fixture: Object.assign(new Agent(), { name: 'fixture', manager: fixtureManager }), sub: Object.assign(new Agent(), { name: 'sub', manager: sub }) };
  module.setFramework({ getPrimaryAgentName: () => 'fixture', getAgent: (name) => (registered.includes(name) ? agents[name] : null), listAgents: (o) => (o?.includeEnded ? ['fixture', 'sub'] : registered).map((name) => ({ name })) });
  module.wrapManagerCompile(Own.prototype);
  await sub.compile();
  const ticking = strategy.tick();
  registered = ['fixture'];
  const during = await module.answer({ op: 'ticks' });
  assert.deepEqual(Object.entries(during).filter(([name]) => name.endsWith('(ended)')).map(([, n]) => n), [1], 'the ended agent\'s tick, though nothing recorded its name');
  finish();
  await ticking;
  assert.deepEqual(await module.answer({ op: 'ticks' }), { fixture: 0 });
});
