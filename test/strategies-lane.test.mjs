// The strategy fixture's lane (lib/strategies/lane.mjs): what can be pinned without a host.
// Each test names the requirement it pins. A check and a write are pinned by runs through
// the host instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheRoot, check, excusing, failureNames, laneVersion, notExercised, pruneCache, stackVersions } from '../lib/strategies/lane.mjs';
import { configurations, L3_PRODUCT } from '../lib/strategies/script.mjs';
import { perCheckReport } from '../lib/strategies/report.mjs';

const LANE = fileURLToPath(new URL('../lib/strategies/lane.mjs', import.meta.url));

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'fxl-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

test('N1: the lane version moves with every file under lib/strategies and lib/common.mjs, and with nothing else', { timeout: 30_000 }, () => {
  const root = tree({
    'lib/strategies/driver.mjs': 'driver',
    'lib/strategies/script.mjs': 'script',
    'lib/common.mjs': 'common',
    'lib/stores.mjs': 'stores',
    'lanes/strategies.mjs': 'lane entry',
    'README.md': 'readme',
    'test/x.test.mjs': 'test',
  });
  try {
    const v = laneVersion(root);
    assert.match(v, /^[0-9a-f]{64}$/);
    assert.equal(laneVersion(root), v, 'the same files give the same version');
    for (const [rel, text] of [['README.md', 'readme 2'], ['lanes/strategies.mjs', 'entry 2'], ['lib/stores.mjs', 'stores 2'], ['test/x.test.mjs', 'test 2'], ['test/y.test.mjs', 'new']]) {
      writeFileSync(join(root, rel), text);
      assert.equal(laneVersion(root), v, `${rel} is outside the lane`);
    }
    const moves = [
      ['a byte of a strategies file', () => writeFileSync(join(root, 'lib/strategies/script.mjs'), 'scripT'), () => writeFileSync(join(root, 'lib/strategies/script.mjs'), 'script')],
      ['lib/common.mjs', () => writeFileSync(join(root, 'lib/common.mjs'), 'common 2'), () => writeFileSync(join(root, 'lib/common.mjs'), 'common')],
      ['a file added under lib/strategies', () => writeFileSync(join(root, 'lib/strategies/new.mjs'), ''), () => unlinkSync(join(root, 'lib/strategies/new.mjs'))],
      ['a file in a directory under lib/strategies', () => { mkdirSync(join(root, 'lib/strategies/sub')); writeFileSync(join(root, 'lib/strategies/sub/x.mjs'), 'x'); }, () => rmSync(join(root, 'lib/strategies/sub'), { recursive: true })],
      ['a file removed from lib/strategies', () => unlinkSync(join(root, 'lib/strategies/driver.mjs')), () => writeFileSync(join(root, 'lib/strategies/driver.mjs'), 'driver')],
      ['the same bytes under another name', () => { unlinkSync(join(root, 'lib/strategies/driver.mjs')); writeFileSync(join(root, 'lib/strategies/driver2.mjs'), 'driver'); }, () => { unlinkSync(join(root, 'lib/strategies/driver2.mjs')); writeFileSync(join(root, 'lib/strategies/driver.mjs'), 'driver'); }],
      ['bytes moved from one file to the next', () => { writeFileSync(join(root, 'lib/strategies/driver.mjs'), 'drivers'); writeFileSync(join(root, 'lib/strategies/script.mjs'), 'cript'); }, () => { writeFileSync(join(root, 'lib/strategies/driver.mjs'), 'driver'); writeFileSync(join(root, 'lib/strategies/script.mjs'), 'script'); }],
    ];
    for (const [what, change, undo] of moves) {
      change();
      assert.notEqual(laneVersion(root), v, what);
      undo();
      assert.equal(laneVersion(root), v, `${what}, undone`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('N2: the key names the stack as the host resolves it, upward from its directory, and bun', { timeout: 30_000 }, () => {
  const pj = (version) => JSON.stringify({ name: 'x', version });
  const root = tree({
    'install/node_modules/@animalabs/connectome-host/package.json': pj('0.15.0'),
    'install/node_modules/@animalabs/agent-framework/package.json': pj('0.28.0'),
    'install/node_modules/@animalabs/connectome-host/node_modules/@animalabs/context-manager/package.json': pj('0.23.1'),
    'install/node_modules/@animalabs/context-manager/package.json': pj('0.22.0'),
    'node_modules/@animalabs/chronicle/package.json': pj('0.4.2'),
  });
  try {
    const v = stackVersions(join(root, 'install/node_modules/@animalabs/connectome-host'));
    const bun = spawnSync('bun', ['--version'], { encoding: 'utf-8' }).stdout.trim();
    assert.ok(bun, 'bun answers --version here');
    assert.deepEqual(v, {
      '@animalabs/connectome-host': '0.15.0',
      '@animalabs/agent-framework': '0.28.0',
      '@animalabs/context-manager': '0.23.1',
      '@animalabs/membrane': null,
      '@animalabs/chronicle': '0.4.2',
      bun,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('N3: the cache root is the one given, or ~/.cache/connectome-smoke/strategies, made if missing', { timeout: 30_000 }, () => {
  const home = mkdtempSync(join(tmpdir(), 'fxh-'));
  try {
    const given = join(home, 'elsewhere', 'cache');
    assert.equal(cacheRoot(given), given);
    assert.ok(existsSync(given));
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const { cacheRoot } = await import(${JSON.stringify(LANE)}); console.log(cacheRoot());`], { encoding: 'utf-8', env: { ...process.env, HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    const want = join(home, '.cache', 'connectome-smoke', 'strategies');
    assert.equal(r.stdout.trim(), want);
    assert.ok(existsSync(want));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('N4: a write leaves the newest two entries of its lane and configuration, other lanes\' for a day, and anything incomplete', { timeout: 30_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'fxc-'));
  const now = Date.parse('2026-10-28T12:00:00Z');
  const at = (hoursAgo) => new Date(now - hoursAgo * 3_600_000).toISOString();
  const entry = (name, fields) => {
    mkdirSync(join(root, name, 'store'), { recursive: true });
    if (fields) writeFileSync(join(root, name, 'entry.json'), JSON.stringify(fields));
  };
  try {
    // Directory names sort against writtenAt, so the order kept is the entries' own.
    entry('a-newest', { complete: true, lane: 'L', configurationName: 'default', writtenAt: at(1) });
    entry('z-second', { complete: true, lane: 'L', configurationName: 'default', writtenAt: at(2) });
    entry('m-third', { complete: true, lane: 'L', configurationName: 'default', writtenAt: at(3) });
    entry('b-fourth', { complete: true, lane: 'L', configurationName: 'default', writtenAt: at(50) });
    entry('passthrough', { complete: true, lane: 'L', configurationName: 'passthrough', writtenAt: at(90) });
    entry('other-old', { complete: true, lane: 'M', configurationName: 'default', writtenAt: at(25) });
    entry('other-young', { complete: true, lane: 'M', configurationName: 'default', writtenAt: at(23) });
    entry('incomplete', { complete: false, lane: 'L', configurationName: 'default', writtenAt: at(100) });
    entry('no-entry-json', null);
    mkdirSync(join(root, '.k1.tmp', 'store'), { recursive: true });
    writeFileSync(join(root, '.k1.lock'), '{}');

    const removed = pruneCache({ cacheRoot: root, lane: 'L', configurationName: 'default', now });
    assert.deepEqual(removed.map((d) => d.slice(root.length + 1)).sort(), ['b-fourth', 'm-third', 'other-old']);
    for (const kept of ['a-newest', 'z-second', 'passthrough', 'other-young', 'incomplete', 'no-entry-json', '.k1.tmp', '.k1.lock']) {
      assert.ok(existsSync(join(root, kept)), `${kept} stays`);
    }
    for (const gone of removed) assert.ok(!existsSync(gone), `${gone} is gone`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('N10: failures are named by check and step, or check 2 and segment and product, each once, without their messages', { timeout: 30_000 }, () => {
  const counted = (n) => ({
    invalid: [{ check: 10, step: 'c.cm.cp', message: `calibration at the clamp edge (1.8) at run ${n}` }],
    flags: [
      { check: 5, step: 'c.cm.3', request: `r${n}`, message: `L3 merge spans ${n} messages` },
      { check: 5, step: 'c.cm.3', request: `r${n + 1}`, message: 'another at the same step' },
      { check: 1, step: 'c.debt', message: `inference:failed after ${n} ms` },
      { check: 1, step: null, message: 'the run stopped' },
    ],
    missing: [{ segment: 'close-merge', name: 'a merge request' }, { segment: 'close-merge', name: 'an L1 compression request' }, { segment: 'debt', name: 'an empty answer' }],
    didntRun: [{ segment: 'parallel', name: 'a request carrying the three results' }],
  });
  const names = failureNames(counted(7));
  assert.deepEqual(names, [
    'check 10 at c.cm.cp',
    'check 5 at c.cm.3',
    'check 1 at c.debt',
    'check 1 at the run',
    'check 2 at close-merge: a merge request',
    'check 2 at close-merge: an L1 compression request',
    'check 2 at debt: an empty answer',
  ]);
  assert.deepEqual(failureNames(counted(9123)), names, 'the same failures in another run go by the same names');
  assert.deepEqual(failureNames({ invalid: [], flags: [], missing: [], didntRun: [] }), []);
});

test('N8: a throw on the candidate\'s side resolves the check as couldn\'t-run, naming what threw', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fxn8-'));
  try {
    const root = join(dir, 'cache');
    mkdirSync(join(root, 'k1', 'store'), { recursive: true });
    writeFileSync(join(root, 'k1', 'entry.json'), JSON.stringify({
      complete: true, lane: 'L', configurationName: 'default', key: 'k1', versions: {}, prefixTurns: 40, clockEnd: 1, writtenAt: new Date().toISOString(),
    }));
    let judged = 0;
    const res = await check({
      cacheRoot: root, configuration: configurations().default, hostDir: join(dir, 'no-host'), installDir: join(dir, 'no-host'),
      work: join(dir, 'work'), evidence: join(dir, 'evidence'), judge: async () => { judged++; return { flags: [], missing: [] }; }, trial: { min: 1, step: 1, bound: 1 }, lane: 'L',
    });
    assert.equal(res.outcome, 'couldnt-run');
    assert.match(res.reason, /^the candidate's side couldn't run: .*recipe facts/s);
    assert.equal(judged, 0, 'nothing was judged');
    assert.equal(JSON.parse(readFileSync(join(dir, 'evidence', 'result.json'), 'utf-8')).outcome, 'couldnt-run', 'the evidence says so too');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('N11: where the trial lacked only the L3 product, neither side counts it, and the report says L3 wasn\'t exercised at this cut', () => {
  const configuration = configurations().default;
  const l3 = { segment: 'close-merge', missing: [L3_PRODUCT] };
  const entryLacking = (missing) => ({ trial: { lengths: [{ turns: 13, missing: [{ segment: 'close-merge', missing: ['a merge request', L3_PRODUCT] }] }, { turns: 14, missing }, { turns: 15, missing }], missing } });
  const verdictOf = (entry, candidate, base = null) => {
    const cut = notExercised(entry);
    const report = perCheckReport({ configuration, candidate: excusing(candidate, cut.products), base: base && excusing(base, cut.products) });
    return { cut, report, names: report.verdict === 'pass' ? [] : failureNames(report) };
  };

  // Only L3 lacking at the bound: it counts against neither side.
  const only = entryLacking([l3]);
  const alone = verdictOf(only, { flags: [], missing: [l3] });
  assert.equal(alone.report.verdict, 'pass', 'the candidate lacking only L3 passes');
  assert.deepEqual(alone.names, []);
  assert.match(alone.cut.line, /L3 wasn't exercised at this cut/);
  assert.match(alone.cut.line, /13 to 15 turns/, 'the line names the trial\'s lengths');
  const withOther = verdictOf(only, { flags: [], missing: [l3, { segment: 'tool-round', missing: ['x'] }] }, { flags: [], missing: [l3] });
  assert.equal(withOther.report.verdict, 'flags');
  assert.deepEqual(withOther.names, ['check 2 at tool-round: x'], 'another missing product still counts, and L3 isn\'t named');
  assert.equal(withOther.report.didntRun.length, 0, 'L3 isn\'t reported as a segment that didn\'t run either');
  const sameSegment = verdictOf(only, { flags: [], missing: [{ segment: 'close-merge', missing: ['a merge request', L3_PRODUCT] }] });
  assert.deepEqual(sameSegment.names, ['check 2 at close-merge: a merge request'], 'close-merge\'s other products still count');

  // The trial lacked nothing: L3 counts as any product does.
  const full = verdictOf({ trial: { lengths: [{ turns: 13, missing: [] }], missing: [] } }, { flags: [], missing: [l3] });
  assert.equal(full.cut.line, null);
  assert.deepEqual(full.names, [`check 2 at close-merge: ${L3_PRODUCT}`]);

  // The trial lacked L3 and something else: nothing is excused.
  for (const missing of [[{ segment: 'close-merge', missing: ['a merge request', L3_PRODUCT] }], [l3, { segment: 'tool-round', missing: ['x'] }]]) {
    const more = verdictOf(entryLacking(missing), { flags: [], missing: [l3] });
    assert.equal(more.cut.line, null);
    assert.deepEqual(more.names, [`check 2 at close-merge: ${L3_PRODUCT}`], JSON.stringify(missing));
  }
});
