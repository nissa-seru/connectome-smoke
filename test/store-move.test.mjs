import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readManifest, treeDigest, treeChanges, storesIn, withinStores, givenIn, copiesIn, givenCheck, rowsOf, unreachable, hasHistoryTools, rollbackVerdict, FEATURES } from '../lib/store-move.mjs';

const v1 = Buffer.from('RST\0\x01', 'latin1');
const v2 = (features) => { const b = Buffer.alloc(13); b.write('RST\0', 0, 'latin1'); b[4] = 2; b.writeBigUInt64LE(BigInt(features), 5); return b; };

test('readManifest reads both versions as chronicle writes them, and says why it reads no other', () => {
  assert.deepEqual(readManifest(v1), { version: 1, features: 0 });
  assert.deepEqual(readManifest(v2(FEATURES.appendMany)), { version: 2, features: 1 });
  assert.match(readManifest(Buffer.from('XYZ\0\x01', 'latin1')).error, /not a chronicle MANIFEST/);
  assert.match(readManifest(Buffer.concat([v1, Buffer.from([0])])).error, /1 bytes after its header/);
  assert.match(readManifest(v2(1).subarray(0, 9)).error, /version 2 in 9 bytes/);
  assert.match(readManifest(Buffer.from('RST\0\x03', 'latin1')).error, /version 3/);
});

test('treeDigest, storesIn, withinStores and treeChanges see a store directory and every change in it', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'store-move-test-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  mkdirSync(join(d, 'sessions', 'a1', 'blobs'), { recursive: true });
  writeFileSync(join(d, 'sessions', 'a1', 'MANIFEST'), v1);
  writeFileSync(join(d, 'sessions', 'a1', 'records.log'), 'r');
  writeFileSync(join(d, 'sessions.json'), '{}');
  symlinkSync('nowhere', join(d, 'sessions', 'a1', 'link'));
  const before = treeDigest(d);
  assert.equal(before['sessions/a1/link'], 'link nowhere');
  assert.equal(before['sessions/a1/blobs'], 'dir');
  const stores = storesIn(d, before);
  assert.deepEqual(stores, [{ store: 'sessions/a1', version: 1, features: 0 }]);
  assert.deepEqual(Object.keys(withinStores(before, stores)).sort(), ['sessions/a1', 'sessions/a1/MANIFEST', 'sessions/a1/blobs', 'sessions/a1/link', 'sessions/a1/records.log']);
  writeFileSync(join(d, 'sessions', 'a1', 'MANIFEST'), v2(1));
  writeFileSync(join(d, 'sessions', 'a1', 'LOCK'), '');
  rmSync(join(d, 'sessions', 'a1', 'records.log'));
  writeFileSync(join(d, 'sessions.json'), '{"x":1}');
  const after = treeDigest(d);
  assert.deepEqual(treeChanges(withinStores(before, stores), withinStores(after, stores)), { added: ['sessions/a1/LOCK'], removed: ['sessions/a1/records.log'], changed: ['sessions/a1/MANIFEST'] });
  assert.deepEqual(treeChanges(before, after).changed, ['sessions.json', 'sessions/a1/MANIFEST']);
  assert.deepEqual(storesIn(d), [{ store: 'sessions/a1', version: 2, features: 1 }]);
});

test('givenIn finds each text as a request carries it in JSON, escapes included', () => {
  const json = JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'smoke: line one\nline "two"' }] }] });
  assert.equal(givenIn(json, ['line one\nline "two"']), true);
  assert.equal(givenIn(json, ['line one', 'line three']), false);
  assert.equal(givenIn(json, []), null);
});

const record = {
  messages: [{ id: 'm1', texts: ['turn one'] }, { id: 'm2', texts: ['reply one'] }, { id: 'm3', texts: [] }, { id: 'm4', texts: ['only sometimes'] }],
  summaries: [{ id: 's1', text: 'summary one' }],
  indexed: ['m1', 'm2'],
};
const req = (...texts) => ({ system: null, messages: texts.map((text) => ({ role: 'user', content: [{ type: 'text', text }] })) });

test('givenCheck counts a row as given before only where every control run gave it, and lists what the later release lost', () => {
  const rows = rowsOf(record);
  assert.deepEqual(rows.map((r) => `${r.kind} ${r.id}`), ['message m1', 'message m2', 'message m3', 'message m4', 'summary s1']);
  const g = givenCheck(rows, [req('turn one', 'reply one', 'summary one', 'only sometimes'), req('turn one', 'reply one', 'summary one')], req('turn one', 'summary one'));
  assert.equal(g.given, 3);
  assert.deepEqual(g.lost.map((r) => r.id), ['m2']);
  assert.deepEqual(g.unsteady.map((r) => r.id), ['m4']);
  assert.equal(g.untexted, 1);
  assert.deepEqual(givenCheck(rows, [req('turn one')], req('turn one')).lost, []);
});

test('givenCheck judges rows with the same text as a group, by how many copies each request carries', () => {
  const notice = '[send-undeliverable] Your previous reply had no channel';
  const rows = rowsOf({ messages: [1, 2, 3].map((n) => ({ id: `n${n}`, texts: [notice] })), summaries: [] });
  const g = givenCheck(rows, [req(notice, 'x', notice), req(notice, notice, notice)], req(notice));
  assert.equal(g.given, 2);
  assert.deepEqual(g.givenRows.map((r) => r.id), ['n1', 'n2']);
  assert.deepEqual(g.unsteady.map((r) => r.id), ['n3']);
  assert.deepEqual(g.lost.map((r) => r.id), ['n2']);
  assert.equal(copiesIn(JSON.stringify(req(notice, notice)), [notice]), 2);
  assert.deepEqual(givenCheck(rows, [req(notice, notice)], req(notice, notice, notice, notice)).lost, []);
});

test('unreachable: everything lost without history tools; with them, what the indexed query and the summaries no longer hold', () => {
  const lost = [{ kind: 'message', id: 'm2' }, { kind: 'message', id: 'm9' }, { kind: 'summary', id: 's1' }, { kind: 'summary', id: 's9' }];
  assert.deepEqual(unreachable(lost, { historyTools: false, record }), lost);
  assert.deepEqual(unreachable(lost, { historyTools: true, record }).map((r) => r.id), ['m9', 's9']);
  assert.equal(hasHistoryTools({ modules: { history: true } }), true);
  assert.equal(hasHistoryTools({ modules: { history: false } }), false);
  assert.equal(hasHistoryTools({}), false);
});

test('rollbackVerdict is clean only for a refusal that names version 2 and leaves the store as it was', () => {
  const none = { added: [], removed: [], changed: [] };
  const said = 'host exited 1 before opening ipc\nInvalid store format: Unsupported store version: 2';
  assert.equal(rollbackVerdict({ outcome: { opened: false, error: said }, changes: none }).clean, true);
  assert.deepEqual(rollbackVerdict({ outcome: { opened: false, error: said }, changes: { ...none, changed: ['sessions/a1/LOCK'] } }).wrote, ['sessions/a1/LOCK']);
  assert.equal(rollbackVerdict({ outcome: { opened: false, error: 'host exited 1 before ready' }, changes: none }).namesVersion, false);
  assert.equal(rollbackVerdict({ outcome: { opened: true, error: null }, changes: none }).clean, false);
});
