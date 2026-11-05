import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAgainst, recordAgainst, releaseDiffers } from '../lib/against.mjs';

const LANE = 'a'.repeat(64);
const RUNS = ['H1/W1', 'H1/W2', 'H2/W7'];

const baseArm = ({ lane = LANE, runs = RUNS, results, records = {} }) => {
  const dir = mkdtempSync(join(tmpdir(), 'against-'));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ lane, runs, release: { tag: 'v1', versions: {} }, results }));
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
    const opts = { lane: LANE, runs: RUNS, names: ['H1/W1', 'H1/W2'] };
    assert.ok(readAgainst(arm({}), opts), 'the same lane, runs and share');
    const absent = mkdtempSync(join(tmpdir(), 'against-'));
    dirs.push(absent);
    assert.throws(() => readAgainst(absent, opts), /holds no run\.json, so the base arm didn't finish/);
    assert.throws(() => readAgainst(arm({ lane: 'b'.repeat(64) }), opts), /written by the harness at lane bbbbbbbbbbbb, and this one is aaaaaaaaaaaa/);
    assert.throws(() => readAgainst(arm({ runs: ['H1/W1', 'H1/W2'] }), opts), /drew its shares from H1\/W1, H1\/W2, and this invocation from H1\/W1, H1\/W2, H2\/W7: give both arms the same --runs/);
    assert.throws(() => readAgainst(arm({}), { ...opts, names: ['H2/W7'] }), /ran H1\/W1, H1\/W2, and this share runs H2\/W7: give both arms the same --shard/);
    assert.throws(() => readAgainst(arm({ results: [{ run: 'H1/W1', record: 'written' }] }), opts), /ran H1\/W1, and this share runs H1\/W1, H1\/W2/, 'a share the base ran only part of');
    assert.throws(() => readAgainst(arm({ records: {} }), opts), /says H1\/W1 wrote a record, and H1_W1\/H1_W1\.record isn't there/);
  } finally { for (const d of dirs) rmSync(d, { recursive: true, force: true }); }
});

test('a base arm whose checkpoints another release or stack made is refused, since its runs would start from other stores', () => {
  const dir = baseArm({ results: [] });
  try {
    const against = readAgainst(dir, { lane: LANE, runs: RUNS, names: [] });
    assert.equal(releaseDiffers(against, { tag: 'v1', versions: {} }), null);
    assert.match(releaseDiffers(against, { tag: 'v2', versions: {} }), /made its checkpoints with v1 \(\), and this invocation with v2 \(\)/);
    assert.match(releaseDiffers(against, { tag: 'v1', versions: { '@animalabs/context-manager': '0.24.0' } }), /and this invocation with v1 \(context-manager@0\.24\.0\), so the two arms' runs wouldn't start from the same stores/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a head run\'s record is the same as the base arm\'s, differs from it, or has none to compare with when the base couldn\'t run it; with no base arm it\'s only written', () => {
  const dir = baseArm({ results: [{ run: 'H1/W1', record: 'written' }, { run: 'H1/W2', record: null }], records: { 'H1/W1': 'r1\n' } });
  try {
    const against = readAgainst(dir, { lane: LANE, runs: RUNS, names: ['H1/W1', 'H1/W2'] });
    assert.deepEqual(recordAgainst(against, 'H1/W1', 'r1\n'), { record: 'same', base: 'r1\n' });
    assert.deepEqual(recordAgainst(against, 'H1/W1', 'r2\n'), { record: 'differs', base: 'r1\n' });
    assert.deepEqual(recordAgainst(against, 'H1/W2', 'r1\n'), { record: 'missing', base: null });
    assert.deepEqual(recordAgainst(null, 'H1/W1', 'r1\n'), { record: 'written', base: null });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
