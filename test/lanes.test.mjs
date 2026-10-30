import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLane, planUnits, laneUnits, unrecordedUnits, outcomeOf } from '../lib/lanes.mjs';
import { buildGraph, topoOrder, checkScope, typecheckCommand, testCommand } from '../lib/stack.mjs';

const HOST = 'connectome-host';

const pkg = (key, deps = {}, scripts = { test: 'x' }, R = {}) => ({ key, repo: key, R, name: `@animalabs/${key}`, pj: { dependencies: Object.fromEntries(Object.keys(deps).map((d) => [`@animalabs/${d}`, '*'])), scripts } });
const PKGS = [
  pkg('voice-kit'),
  pkg('mcpl-core-ts'),
  pkg('membrane'),
  pkg('context-manager', { membrane: 1 }),
  pkg('agent-framework', { membrane: 1, 'context-manager': 1, 'mcpl-core-ts': 1 }),
  pkg(HOST, { 'agent-framework': 1, 'context-manager': 1, membrane: 1 }, { test: 'x' }, { typecheck: 'tsc' }),
  pkg('mcpl-harness', { 'mcpl-core-ts': 1 }, {}),
  pkg('heartbeat-mcpl', { 'mcpl-core-ts': 1 }),
];

function planFor(mode, changed) {
  const edges = buildGraph(PKGS);
  const keys = PKGS.map((p) => p.key);
  const { ownSet, combinedSet } = checkScope({ keys, changedKeys: changed, edges, mode, host: HOST });
  return planUnits({ pkgs: PKGS, order: topoOrder(keys, edges), edges, ownSet, combinedSet, host: HOST, checks: (p) => !!(typecheckCommand(p) || testCommand(p, () => false)) });
}

test('--lane is I/N with 0 <= I < N, and no --lane is the whole check, 0/1', () => {
  assert.deepEqual(parseLane(undefined), { index: 0, of: 1 });
  assert.deepEqual(parseLane('0/1'), { index: 0, of: 1 });
  assert.deepEqual(parseLane('2/5'), { index: 2, of: 5 });
  for (const bad of ['', '5/5', '6/5', '-1/3', '1/0', '01/3', '1/03', 'a/b', '1/3x', '1', '1/3/4', '0/9007199254740993', `0/${'9'.repeat(400)}`]) {
    assert.throws(() => parseLane(bad), /expected I\/N/, bad);
  }
});

test("a host change's plan: its own suite, its combined suite, then its starts", () => {
  assert.deepEqual(planFor('change', [HOST]), [`${HOST}:own`, `${HOST}:combined`, `${HOST}:starts`]);
});

test("an agent-framework change's plan: its own suite, then the combined suites of it and of the host, then the host's starts", () => {
  assert.deepEqual(planFor('change', ['agent-framework']), ['agent-framework:own', 'agent-framework:combined', `${HOST}:combined`, `${HOST}:starts`]);
});

test("a context-manager change's plan covers every dependent's combined suite, in dependency order", () => {
  assert.deepEqual(planFor('change', ['context-manager']), ['context-manager:own', 'context-manager:combined', 'agent-framework:combined', `${HOST}:combined`, `${HOST}:starts`]);
});

test("main mode's plan: every package with a check in its own install, every one with a stack dependency combined, each after what it depends on, the starts last", () => {
  const plan = planFor('main', []);
  const own = plan.filter((u) => u.endsWith(':own')).map((u) => u.replace(/:own$/, ''));
  const combined = plan.filter((u) => u.endsWith(':combined')).map((u) => u.replace(/:combined$/, ''));
  assert.deepEqual(own, ['voice-kit', 'mcpl-core-ts', 'membrane', 'context-manager', 'agent-framework', HOST, 'heartbeat-mcpl']);
  assert.deepEqual(new Set(combined), new Set(['context-manager', 'agent-framework', HOST, 'heartbeat-mcpl']));
  const edges = buildGraph(PKGS);
  for (const e of edges) {
    if (combined.includes(e.dep) && combined.includes(e.dependent)) assert.ok(combined.indexOf(e.dep) < combined.indexOf(e.dependent), `${e.dep} before ${e.dependent}`);
  }
  assert.equal(plan.at(-1), `${HOST}:starts`);
  assert.equal(plan.length, own.length + combined.length + 1);
});

test('a package with neither a typecheck nor a test has no unit, in its own install or combined', () => {
  const plan = planFor('main', []);
  assert.ok(!plan.some((u) => u.startsWith('mcpl-harness:')));
});

test('every unit runs in exactly one of N lanes, one lane runs the whole plan, and as many lanes as units give each unit a lane of its own', () => {
  for (const plan of [planFor('change', [HOST]), planFor('change', ['agent-framework']), planFor('change', ['context-manager']), planFor('main', [])]) {
    assert.deepEqual(laneUnits(plan, { index: 0, of: 1 }), plan);
    for (let of = 1; of <= 6; of++) {
      const lanes = Array.from({ length: of }, (_, index) => laneUnits(plan, { index, of }));
      assert.deepEqual(lanes.flat().sort(), [...plan].sort(), `${of} lanes`);
      for (let index = plan.length; index < of; index++) assert.deepEqual(lanes[index], [], `lane ${index}/${of} past the plan`);
    }
    const own = Array.from({ length: plan.length }, (_, index) => laneUnits(plan, { index, of: plan.length }));
    assert.deepEqual(own, plan.map((u) => [u]));
  }
  const [a, b, c, d, e] = planFor('change', ['context-manager']);
  assert.deepEqual([0, 1, 2].map((index) => laneUnits([a, b, c, d, e], { index, of: 3 })), [[a, d], [b, e], [c]], 'unit k in lane k mod N');
});

test("a lane that stops early names each of its units no record carries, so it can record them as not run", () => {
  const units = ['agent-framework:own', 'connectome-host:combined', 'connectome-host:starts'];
  const steps = [
    { id: 'agent-framework:install', status: 'pass' },
    { id: 'agent-framework:own:test', status: 'fail', unit: 'agent-framework:own' },
    { id: 'compose:link', status: 'fail' },
  ];
  assert.deepEqual(unrecordedUnits(units, steps), ['connectome-host:combined', 'connectome-host:starts']);
  assert.deepEqual(unrecordedUnits(units, [...steps, { id: 'connectome-host:combined:typecheck', status: 'skip', unit: 'connectome-host:combined' }]), ['connectome-host:starts']);
  assert.deepEqual(unrecordedUnits([], steps), []);
});

function union(lanes) {
  const byId = new Map();
  for (const steps of lanes) {
    for (const s of steps) {
      const prev = byId.get(s.id);
      const rank = (x) => x.status === 'fail' ? (x.cause === 'conflict' ? 4 : x.infra ? 3 : 2) : { pass: 1, skip: 0 }[x.status];
      if (!prev || rank(s) > rank(prev)) byId.set(s.id, s);
    }
  }
  return [...byId.values()];
}
const worst = (outcomes) => ['conflict', 'error', 'break', 'pass'].find((o) => outcomes.includes(o));

test("the worst of the lanes' outcomes is the outcome of the union of their steps", () => {
  const ok = (id, extra = {}) => ({ id, status: 'pass', ...extra });
  const bad = (id, extra = {}) => ({ id, status: 'fail', ...extra });
  const prep = [ok('agent-framework:clone'), ok('agent-framework:install', { tree: 'own', changed: true }), ok('connectome-host:install', { tree: 'own', changed: false }), ok('compose:link')];
  const cases = [
    { name: 'all pass', expect: 'pass', mode: 'change', lanes: [[...prep, ok('agent-framework:own:test')], [...prep, ok('connectome-host:combined:test')]] },
    { name: 'one lane breaks', expect: 'break', mode: 'change', lanes: [[...prep, ok('agent-framework:own:test')], [...prep, bad('connectome-host:combined:test')]] },
    { name: 'one lane breaks, another could not run', expect: 'error', mode: 'change', lanes: [[...prep, bad('agent-framework:own:test')], [...prep, bad('connectome-host:combined:strategies:default', { infra: true })]] },
    { name: "an unchanged package's own install fails in one lane only", expect: 'error', mode: 'change', lanes: [[...prep.slice(0, 2), bad('connectome-host:install', { tree: 'own', changed: false }), prep[3]], [...prep, bad('connectome-host:combined:test')]] },
    { name: 'the same in main mode is a break', expect: 'break', mode: 'main', lanes: [[...prep.slice(0, 2), bad('connectome-host:install', { tree: 'own', changed: false }), prep[3]], [...prep, ok('connectome-host:combined:test')]] },
    { name: 'one prep step fails plainly in one lane and as could-not-run in another', expect: 'error', mode: 'change', lanes: [[prep[0], bad('agent-framework:install', { tree: 'own', changed: true }), ...prep.slice(2)], [prep[0], bad('agent-framework:install', { tree: 'own', changed: true, infra: true }), ...prep.slice(2)]] },
    { name: 'a conflict in every lane', expect: 'conflict', mode: 'change', lanes: [[bad('agent-framework:clone', { cause: 'conflict' })], [bad('agent-framework:clone', { cause: 'conflict' })]] },
    { name: 'a lane stopped by a fatal error', expect: 'error', mode: 'change', lanes: [[...prep, ok('agent-framework:own:test')], [...prep]], fatal: [null, 'TypeError'] },
    { name: 'a lane stopped by a fatal error while another breaks', expect: 'error', mode: 'change', lanes: [[...prep, bad('agent-framework:own:test')], [...prep]], fatal: [null, 'TypeError'] },
  ];
  for (const c of cases) {
    const each = c.lanes.map((steps, i) => outcomeOf({ mode: c.mode, fatal: c.fatal?.[i] ?? null, steps }).outcome);
    const whole = outcomeOf({ mode: c.mode, fatal: c.fatal?.find(Boolean) ?? null, steps: union(c.lanes) });
    assert.equal(worst(each), c.expect, c.name);
    assert.equal(whole.outcome, c.expect, c.name);
  }
});
