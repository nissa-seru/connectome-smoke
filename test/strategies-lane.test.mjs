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
import { cacheRoot, check, excusing, failureNames, lacking, laneVersion, notExercised, pruneCache, stackVersions } from '../lib/strategies/lane.mjs';
import { configurations, L3_PRODUCT } from '../lib/strategies/script.mjs';
import { perCheckReport } from '../lib/strategies/report.mjs';
import { entryKey, findEntry, writeEntry } from '../lib/strategies/writer.mjs';

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

// An install as npm leaves it: each package's package.json under `install/`, and the
// install's lockfile entry for each (`locked`, by path from `install/`; null leaves it out).
const REGISTRY = 'https://registry.example.test/';
const fromRegistry = (name, version) => ({ version, resolved: `${REGISTRY}${name}/-/${name.split('/')[1]}-${version}.tgz`, integrity: `sha512-registry-${version}` });
function install(packages) {
  const files = {};
  const lock = { name: 'strategies-stack', lockfileVersion: 3, packages: { '': { name: 'strategies-stack' } } };
  for (const [path, { version, locked }] of Object.entries(packages)) {
    files[`install/${path}/package.json`] = JSON.stringify({ name: 'x', version });
    if (locked) lock.packages[path] = locked;
  }
  files['install/package-lock.json'] = JSON.stringify(lock);
  const root = tree(files);
  return { root, installDir: join(root, 'install'), hostDir: join(root, 'install/node_modules/@animalabs/connectome-host') };
}
const released = (overrides = {}) => ({
  'node_modules/@animalabs/connectome-host': { version: '0.15.0', locked: fromRegistry('@animalabs/connectome-host', '0.15.0') },
  'node_modules/@animalabs/agent-framework': { version: '0.28.0', locked: fromRegistry('@animalabs/agent-framework', '0.28.0') },
  'node_modules/@animalabs/connectome-host/node_modules/@animalabs/context-manager': { version: '0.23.1', locked: fromRegistry('@animalabs/context-manager', '0.23.1') },
  'node_modules/@animalabs/context-manager': { version: '0.22.0', locked: fromRegistry('@animalabs/context-manager', '0.22.0') },
  'node_modules/@animalabs/chronicle': { version: '0.4.2', locked: fromRegistry('@animalabs/chronicle', '0.4.2') },
  ...overrides,
});
const bunVersion = () => spawnSync('bun', ['--version'], { encoding: 'utf-8' }).stdout.trim();

test('N2: the key names the stack as the host resolves it, upward from its directory, by version where npm installed it from the registry, and bun', { timeout: 30_000 }, () => {
  const s = install(released());
  try {
    const v = stackVersions(s.hostDir, { installDir: s.installDir, registry: REGISTRY });
    const bun = bunVersion();
    assert.ok(bun, 'bun answers --version here');
    assert.deepEqual(v, {
      '@animalabs/connectome-host': '0.15.0',
      '@animalabs/agent-framework': '0.28.0',
      '@animalabs/context-manager': '0.23.1',
      '@animalabs/membrane': null,
      '@animalabs/chronicle': '0.4.2',
      bun,
    });
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('N2: a package installed from a pack or a git spec is named by its version and its content, as the lockfile records it', { timeout: 30_000 }, () => {
  const host = 'node_modules/@animalabs/connectome-host';
  const pack = install(released({ [host]: { version: '0.15.0', locked: { version: '0.15.0', resolved: 'file:../connectome-host-0.15.0.tgz', integrity: 'sha512-one-changed-line' } } }));
  const otherPack = install(released({ [host]: { version: '0.15.0', locked: { version: '0.15.0', resolved: 'file:../connectome-host-0.15.0.tgz', integrity: 'sha512-another-change' } } }));
  const sha = 'a'.repeat(40);
  const git = install(released({ [host]: { version: '0.15.0', locked: { version: '0.15.0', resolved: `git+ssh://git@github.com/x/connectome-host.git#${sha}` } } }));
  const url = install(released({ [host]: { version: '0.15.0', locked: { version: '0.15.0', resolved: 'https://example.test/builds/connectome-host-0.15.0.tgz', integrity: 'sha512-from-a-url' } } }));
  try {
    const name = (s) => stackVersions(s.hostDir, { installDir: s.installDir, registry: REGISTRY })['@animalabs/connectome-host'];
    const one = name(pack);
    assert.notEqual(one, '0.15.0', 'a pack at the release\'s version is not named as the release');
    assert.ok(one.startsWith('0.15.0') && one.includes('sha512-one-changed-line'), one);
    assert.notEqual(name(otherPack), one, 'two packs with different content have different names');
    assert.equal(name(pack), one, 'the same pack names the same way twice');
    const g = name(git);
    assert.ok(g.startsWith('0.15.0') && g.includes(sha), g);
    const u = name(url);
    assert.ok(u.startsWith('0.15.0') && u.includes('sha512-from-a-url'), `a tarball from a URL outside the registry is named by its integrity: ${u}`);
    // The registry's other packages are still named by version alone.
    assert.equal(stackVersions(pack.hostDir, { installDir: pack.installDir, registry: REGISTRY })['@animalabs/agent-framework'], '0.28.0');
  } finally { for (const s of [pack, otherPack, git, url]) rmSync(s.root, { recursive: true, force: true }); }
});

test('N2: a package the install can\'t name by its content refuses, naming it and what to pass instead', { timeout: 30_000 }, () => {
  const host = 'node_modules/@animalabs/connectome-host';
  const linked = install(released({ [host]: { version: '0.15.0', locked: { resolved: '../checkout/connectome-host', link: true } } }));
  const unlisted = install(released({ 'node_modules/@animalabs/agent-framework': { version: '0.28.0', locked: null } }));
  const unlocked = install(released());
  unlinkSync(join(unlocked.installDir, 'package-lock.json'));
  try {
    assert.throws(() => stackVersions(unlocked.hostDir, { installDir: unlocked.installDir, registry: REGISTRY }), (e) => /no lockfile at/.test(e.message));
    assert.throws(() => stackVersions(linked.hostDir, { installDir: linked.installDir, registry: REGISTRY }), (e) => /@animalabs\/connectome-host/.test(e.message) && /linked/.test(e.message) && /npm pack/.test(e.message));
    assert.throws(() => stackVersions(unlisted.hostDir, { installDir: unlisted.installDir, registry: REGISTRY }), (e) => /@animalabs\/agent-framework/.test(e.message) && /lockfile/.test(e.message));
  } finally { for (const s of [linked, unlisted, unlocked]) rmSync(s.root, { recursive: true, force: true }); }
});

test('N2: a candidate at the release\'s version with a changed line writes its own entry, beside the release\'s', { timeout: 30_000 }, async () => {
  const release = install(released());
  const candidate = install(released({ 'node_modules/@animalabs/connectome-host': { version: '0.15.0', locked: { version: '0.15.0', resolved: 'file:../connectome-host-0.15.0.tgz', integrity: 'sha512-one-changed-line' } } }));
  const tmp = mkdtempSync(join(tmpdir(), 'fxk-'));
  const cache = join(tmp, 'cache');
  let writes = 0;
  const parts = (s) => ({ lane: 'L', configurationName: 'default', recipeHash: 'r', versions: stackVersions(s.hostDir, { installDir: s.installDir, registry: REGISTRY }), trialTurns: { min: 1, step: 1, bound: 1 } });
  const script = { min: 1, step: 1, bound: 1, prefix: () => ['p.1'], extend: () => [] };
  const runSteps = async ({ storeDir, epoch }) => { mkdirSync(storeDir, { recursive: true }); writeFileSync(join(storeDir, 'messages'), 'p.1\n'); return { ok: true, clockEnd: epoch + 60_000 }; };
  const write = (p) => writeEntry({ cacheRoot: cache, key: entryKey(p), keyParts: p, script, runSteps, trial: async () => ({ missing: [] }), hardChecks: async () => ({ ok: true }), epoch: 0, work: join(tmp, `work-${++writes}`) });
  try {
    const first = await write(parts(release));
    assert.equal(first.written, true);
    const second = await write(parts(candidate));
    assert.equal(second.written, true, 'the candidate wrote its own entry, not the release\'s returned as already there');
    assert.notEqual(second.dir, first.dir);
    assert.ok(existsSync(join(first.dir, 'entry.json')), 'the release\'s entry stays');
  } finally { for (const s of [release, candidate]) rmSync(s.root, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); }
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

test('N4: pruning keeps each trial\'s newest two, so a write of another trial never removes the lane\'s own entry', { timeout: 30_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'fxc-'));
  const now = Date.parse('2026-10-28T12:00:00Z');
  const at = (hoursAgo) => new Date(now - hoursAgo * 3_600_000).toISOString();
  const lanes = { min: 13, step: 1, bound: 80 };
  const probes = { min: 1, step: 1, bound: 42 };
  const entry = (name, trialTurns, hoursAgo) => {
    mkdirSync(join(root, name, 'store'), { recursive: true });
    writeFileSync(join(root, name, 'entry.json'), JSON.stringify({ complete: true, lane: 'L', configurationName: 'default', trialTurns, writtenAt: at(hoursAgo) }));
  };
  try {
    // Greta-2425's P1 (room-203 #251172): the lane's own entry first, then two of another trial.
    entry('lanes', lanes, 3);
    entry('probe-1', probes, 2);
    entry('probe-2', probes, 1);
    const afterProbe = pruneCache({ cacheRoot: root, lane: 'L', configurationName: 'default', trialTurns: probes, now });
    assert.deepEqual(afterProbe, []);
    assert.equal(findEntry({ cacheRoot: root, lane: 'L', configurationName: 'default', trialTurns: lanes })?.dir, join(root, 'lanes'), 'a check still finds the lane\'s own entry');
    // A third of the probe's trial prunes only the probe's oldest.
    entry('probe-3', probes, 0.5);
    const removed = pruneCache({ cacheRoot: root, lane: 'L', configurationName: 'default', trialTurns: probes, now });
    assert.deepEqual(removed.map((d) => d.slice(root.length + 1)), ['probe-1']);
    for (const kept of ['lanes', 'probe-2', 'probe-3']) {
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

test('K1b: an operator alert\'s failure name carries its kind, so a known-red entry for one kind doesn\'t cover another', () => {
  const alert = (what) => ({ check: 1, step: 'c.debt', what, message: 'm' });
  assert.deepEqual(failureNames({ invalid: [], flags: [alert('compression-quarantine'), alert('mcpl-down'), { check: 1, step: 'c.debt', message: 'm' }], missing: [], didntRun: [] }), [
    'check 1 at c.debt: compression-quarantine',
    'check 1 at c.debt: mcpl-down',
    'check 1 at c.debt',
  ]);
});

test('N8: a throw on the candidate\'s side resolves the check as couldn\'t-run, naming what threw', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fxn8-'));
  try {
    const root = join(dir, 'cache');
    mkdirSync(join(root, 'k1', 'store'), { recursive: true });
    writeFileSync(join(root, 'k1', 'entry.json'), JSON.stringify({
      complete: true, lane: 'L', configurationName: 'default', key: 'k1', versions: {}, trialTurns: { min: 1, step: 1, bound: 1 }, prefixTurns: 40, clockEnd: 1, writtenAt: new Date().toISOString(),
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

test('N9: a write\'s entry lacks, for its exit, each product its trial lacked at its bound besides the L3 that N11 excuses', () => {
  const at = (missing) => ({ trial: { lengths: [{ turns: 13, missing }], missing } });
  assert.deepEqual(lacking(at([])), [], 'a trial that found every product lacks nothing');
  assert.deepEqual(lacking(at([{ segment: 'close-merge', missing: [L3_PRODUCT] }])), [], 'L3 alone is the fallback, not a lack');
  assert.deepEqual(lacking(at([{ segment: 'tool-round', missing: ['x'] }])), [{ segment: 'tool-round', name: 'x' }]);
  assert.deepEqual(
    lacking(at([{ segment: 'close-merge', missing: ['a merge request', L3_PRODUCT] }, { segment: 'debt', missing: ['y'] }])),
    [{ segment: 'close-merge', name: 'a merge request' }, { segment: 'close-merge', name: L3_PRODUCT }, { segment: 'debt', name: 'y' }],
    'beside another lack, L3 is named too, since nothing is excused then',
  );
  assert.deepEqual(lacking({}), [], 'an entry with no trial recorded lacks nothing it can name');
});
