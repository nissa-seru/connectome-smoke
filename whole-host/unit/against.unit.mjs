import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flagsAgainst, measuredOf, readAgainst, recordAgainst, releaseDiffers } from '../lib/against.mjs';

const LANE = 'a'.repeat(64);
const RUNS = ['H1/W1', 'H1/W2', 'H2/W7'];
const RUNTIME = { node: 'v24.22.2', platform: 'linux', arch: 'x64' };

const baseArm = ({ lane = LANE, runs = RUNS, runtime = RUNTIME, results, records = {} }) => {
  const dir = mkdtempSync(join(tmpdir(), 'against-'));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ lane, runs, runtime, release: { tag: 'v1', versions: {} }, results }));
  for (const [id, text] of Object.entries(records)) {
    const slug = id.replaceAll('/', '_');
    mkdirSync(join(dir, slug), { recursive: true });
    writeFileSync(join(dir, slug, `${slug}.record`), text);
  }
  return dir;
};

test('the base arm\'s evidence is refused unless the same harness ran the same runs, so a record can differ only by the candidate', () => {
  const ok = { results: [{ run: 'H1/W1', record: 'written' }, { run: 'H1/W2', record: null }], records: { 'H1/W1': 'r1\n' } };
  const dirs = [];
  const arm = (over) => { const d = baseArm({ ...ok, ...over }); dirs.push(d); return d; };
  try {
    const opts = { lane: LANE, runs: RUNS, names: ['H1/W1', 'H1/W2'], runtime: RUNTIME };
    assert.ok(readAgainst(arm({}), opts), 'the same lane, runs and share');
    const absent = mkdtempSync(join(tmpdir(), 'against-'));
    dirs.push(absent);
    assert.throws(() => readAgainst(absent, opts), /holds no run\.json: it isn't the --out of a base arm that finished/);
    assert.throws(() => readAgainst(arm({ lane: 'b'.repeat(64) }), opts), /written by the harness at lane bbbbbbbbbbbb, and this one is aaaaaaaaaaaa/);
    assert.throws(() => readAgainst(arm({ runs: ['H1/W1', 'H1/W2'] }), opts), /drew its shares from H1\/W1, H1\/W2, and this invocation from H1\/W1, H1\/W2, H2\/W7: give both arms the same --runs/);
    assert.throws(() => readAgainst(arm({}), { ...opts, names: ['H2/W7'] }), /ran H1\/W1, H1\/W2, and this share runs H2\/W7: give both arms the same --shard/);
    assert.throws(() => readAgainst(arm({ results: [{ run: 'H1/W1', record: 'written' }] }), opts), /ran H1\/W1, and this share runs H1\/W1, H1\/W2/, 'a share the base ran only part of');
    assert.throws(() => readAgainst(arm({ records: {} }), opts), /says H1\/W1 wrote a record, and H1_W1\/H1_W1\.record isn't there/);
    assert.throws(() => readAgainst(arm({ runtime: { ...RUNTIME, node: 'v22.12.0' } }), opts), /ran under Node v22\.12\.0 on linux x64, and this invocation under Node v24\.22\.2 on linux x64/, 'a base run with another Node');
    assert.throws(() => readAgainst(arm({ runtime: { ...RUNTIME, arch: 'arm64' } }), opts), /on linux arm64, and this invocation under Node v24\.22\.2 on linux x64/);
  } finally { for (const d of dirs) rmSync(d, { recursive: true, force: true }); }
});

test('a base arm whose checkpoints another release or stack made is refused, since its runs would start from other stores', () => {
  const dir = baseArm({ results: [] });
  try {
    const against = readAgainst(dir, { lane: LANE, runs: RUNS, names: [], runtime: RUNTIME });
    assert.equal(releaseDiffers(against, { tag: 'v1', versions: {} }), null);
    assert.match(releaseDiffers(against, { tag: 'v2', versions: {} }), /made its checkpoints with v1 \(\), and this invocation with v2 \(\)/);
    assert.match(releaseDiffers(against, { tag: 'v1', versions: { '@animalabs/context-manager': '0.24.0' } }), /and this invocation with v1 \(context-manager@0\.24\.0\), so the two arms' runs wouldn't start from the same stores/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a head run\'s record is the same as the base arm\'s, differs from it, or has none to compare with when the base couldn\'t run it; with no base arm it\'s only written', () => {
  const dir = baseArm({ results: [{ run: 'H1/W1', record: 'written' }, { run: 'H1/W2', record: null }], records: { 'H1/W1': 'r1\n' } });
  try {
    const against = readAgainst(dir, { lane: LANE, runs: RUNS, names: ['H1/W1', 'H1/W2'], runtime: RUNTIME });
    assert.deepEqual(recordAgainst(against, 'H1/W1', 'r1\n'), { record: 'same', base: 'r1\n' });
    assert.deepEqual(recordAgainst(against, 'H1/W1', 'r2\n'), { record: 'differs', base: 'r1\n' });
    assert.deepEqual(recordAgainst(against, 'H1/W2', 'r1\n'), { record: 'missing', base: null });
    assert.deepEqual(recordAgainst(null, 'H1/W1', 'r1\n'), { record: 'written', base: null });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a head run\'s flags are each new, gone or kept against the base arm\'s, counted one for one, so a flag raised once more on the head is new once', () => {
  const a = { check: 11, step: 'p.9', what: 'fixture:request:pins', detail: 'summary 4 at L1 covers 1' };
  const b = { check: 1, step: 'the run', detail: 'the run failed: x' };
  const c = { check: 2, step: 'close-merge', detail: 'missing an L3 merge request' };
  const dir = baseArm({ results: [{ run: 'H1/W1', record: 'written', flags: { new: [a, a], gone: [], kept: [b] } }, { run: 'H1/W2', record: null }], records: { 'H1/W1': 'r1\n' } });
  try {
    const against = readAgainst(dir, { lane: LANE, runs: RUNS, names: ['H1/W1', 'H1/W2'], runtime: RUNTIME });
    assert.deepEqual(flagsAgainst(against, 'H1/W1', [a, c]), { new: [c], gone: [a, b], kept: [a] }, 'the base arm\'s own flags are its new and kept');
    assert.deepEqual(flagsAgainst(against, 'H1/W1', [b, a, a, a]), { new: [a], gone: [], kept: [b, a, a] });
    assert.deepEqual(flagsAgainst(against, 'H1/W1', [{ ...a, detail: 'summary 5 at L1 covers 1' }]).gone, [a, a, b], 'a flag whose detail moved is gone, and the moved one new');
    assert.equal(flagsAgainst(against, 'H1/W2', [a]), null, 'a run the base arm couldn\'t run has no flags to compare with');
    assert.deepEqual(flagsAgainst(against, 'H1/W1', [{ ...a, whole: '0123456789ab' }, a, b]), { new: [{ ...a, whole: '0123456789ab' }], gone: [a], kept: [a, b] }, 'a flag whose whole text differs past the cut is another flag, so the base\'s second one is gone');
    assert.deepEqual(flagsAgainst(null, 'H1/W1', [a, c]), { new: [a, c], gone: [], kept: [] }, 'with no base arm every flag is new');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const cut = (whole) => ({ ...a, whole });
  const both = baseArm({ results: [{ run: 'H1/W1', record: 'written', flags: { new: [cut('111111111111')], gone: [], kept: [] } }], records: { 'H1/W1': 'r1\n' } });
  try {
    const against = readAgainst(both, { lane: LANE, runs: RUNS, names: ['H1/W1'], runtime: RUNTIME });
    assert.deepEqual(flagsAgainst(against, 'H1/W1', [cut('222222222222')]), { new: [cut('222222222222')], gone: [cut('111111111111')], kept: [] }, 'two cut flags whose whole texts differ are two flags');
    assert.deepEqual(flagsAgainst(against, 'H1/W1', [cut('111111111111')]), { new: [], gone: [], kept: [cut('111111111111')] }, 'and two whose whole texts match are one');
  } finally { rmSync(both, { recursive: true, force: true }); }
});

test('a run\'s measurements: the head\'s and, with a base arm, the base\'s, and the base\'s reason where it couldn\'t run the run; none for a run the head couldn\'t run', () => {
  const ran = { outcome: 'flags', unmeasured: ['the run failed'] };
  assert.deepEqual(measuredOf(ran, { against: false, base: null, log: [{ kind: 'health', health: { ok: false } }] }), { unmeasured: ['the run failed'], readsFailed: ['the health panel'] });
  const base = { outcome: 'pass', record: 'H1_W2.record', unmeasured: ['check 4 (coverage) judged nothing'], readsFailed: ['merge quarantines'] };
  assert.deepEqual(measuredOf({ outcome: 'pass' }, { against: true, base, log: [] }), { unmeasured: [], baseUnmeasured: ['check 4 (coverage) judged nothing'], readsFailed: [], baseReadsFailed: ['merge quarantines'] });
  assert.deepEqual(measuredOf({ outcome: 'pass' }, { against: true, base: undefined, log: [] }), { unmeasured: [], baseUnmeasured: [], readsFailed: [], baseReadsFailed: [] }, 'a base arm with no result for the run');
  const failed = { outcome: 'couldnt-run', record: null, reason: 'its checkpoint failed: H1/W2 exited 1' };
  assert.deepEqual(measuredOf({ outcome: 'pass' }, { against: true, base: failed, log: [] }), { unmeasured: [], baseUnmeasured: [], readsFailed: [], baseReadsFailed: [], baseReason: 'its checkpoint failed: H1/W2 exited 1' });
  assert.equal(measuredOf({ outcome: 'pass' }, { against: true, base: { ...failed, reason: undefined }, log: [] }).baseReason, '');
  assert.deepEqual(measuredOf({ outcome: 'couldnt-run', reason: 'x' }, { against: true, base: failed, log: [null] }), {}, 'a run the head couldn\'t run has its log left unread, so a partial one can\'t end the invocation');
});
