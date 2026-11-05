import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readStore, storedEntry } from '../lib/strategies/read-store.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('readStore reads a subagent\'s own isolated slot, not the shared one, when asked to isolate (shown by what each slot holds, since a store with summaries needs a summariser)', { timeout: 60_000 }, async () => {
  const { ContextManager, AutobiographicalStrategy } = await import(pathToFileURL(join(root, 'node_modules', '@animalabs', 'context-manager', 'dist', 'src', 'index.js')).href);
  const dir = mkdtempSync(join(tmpdir(), 'read-store-'));
  const storePath = join(dir, 'store');
  try {
    const write = async (config, participant, text) => {
      const cm = await ContextManager.open({ path: storePath, strategy: new AutobiographicalStrategy({ autoTickOnNewMessage: false }), ...config });
      try { cm.addMessage(participant, [{ type: 'text', text }]); } finally { cm.close(); }
    };
    await write({ namespace: 'agents/fixture' }, 'user', '[[c:p.1.in]] the resident\'s message');
    await write({ namespace: 'subagent/knowledge-1', isolate: true }, 'knowledge-1', '[[c:k.1.task]] the subagent\'s task');
    await assert.rejects(readStore({ installDir: root, storePath, namespace: 'subagent/knowledge-1', isolate: true }), /no summaries in subagent\/knowledge-1 .*it holds 1 message\(s\), first carrying \[\[c:k\.1\.task\]\]/, 'it read the subagent\'s own slot, which holds its task and not the resident\'s message');
    await assert.rejects(readStore({ installDir: root, storePath, namespace: 'agents/fixture' }), /it holds 1 message\(s\), first carrying \[\[c:p\.1\.in\]\]/, 'and the shared slot holds the resident\'s');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readStore refuses a stored message without a content list, as context-manager 0.24.0 stores it, so the judge can\'t read it as a message with no canaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-store-shape-'));
  try {
    const pack = join(dir, 'node_modules', '@animalabs', 'context-manager');
    mkdirSync(join(pack, 'dist', 'src'), { recursive: true });
    writeFileSync(join(pack, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(pack, 'dist', 'src', 'index.js'), [
      'export class AutobiographicalStrategy { getTopologyViolations() { return []; } }',
      'export class ContextManager {',
      '  static async open() { return new ContextManager(); }',
      '  getAllMessages() { return [{ id: \'1\', sequence: 1, participant: \'user\', content: [{ type: \'text\', text: \'[[c:p.1.in]] one\' }] }, { id: \'2\', sequence: 2, participant: \'user\', body: [{ type: \'text\', text: \'[[c:p.1.r1]] two\' }] }]; }',
      '  getSummariesInRange() { return [{ id: \'S\' }]; }',
      '  getSummary(id) { return { id, level: 1, sourceLevel: 0, sourceIds: [\'1\', \'2\'], content: \'S\' }; }',
      '  async close() {}',
      '}',
    ].join('\n'));
    await assert.rejects(readStore({ installDir: dir, storePath: join(dir, 'store'), namespace: 'agents/fixture' }), /getAllMessages: stored message 2 has no content list/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readStore refuses a summary without the content, levels or string source ids context-manager 0.24.0 gives it, so the judge can\'t read it as an unmarked summary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-store-summary-'));
  try {
    const pack = join(dir, 'node_modules', '@animalabs', 'context-manager');
    mkdirSync(join(pack, 'dist', 'src'), { recursive: true });
    writeFileSync(join(pack, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(pack, 'dist', 'src', 'index.js'), [
      'export class AutobiographicalStrategy { getTopologyViolations() { return []; } }',
      'export class ContextManager {',
      '  static async open() { return new ContextManager(); }',
      '  getAllMessages() { return [{ id: \'1\', sequence: 1, participant: \'user\', content: [{ type: \'text\', text: \'[[c:p.1.in]] one\' }] }]; }',
      '  getSummariesInRange() { return [{ id: \'S\' }]; }',
      '  getSummary(id) { return { id, level: 1, sourceLevel: 0, sourceIds: [\'1\'], text: \'renamed\' }; }',
      '  async close() {}',
      '}',
    ].join('\n'));
    await assert.rejects(readStore({ installDir: dir, storePath: join(dir, 'store'), namespace: 'agents/fixture' }), /getSummary\(S\) has no content/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a stored message whose only block is a call takes its call\'s canary as the name to give it, while the canaries checks 4-6 read stay text and tool results', () => {
  const e = storedEntry({ id: 9, participant: 'Subconscious', content: [{ type: 'tool_use', id: 't1', name: 'deliver_summary', input: { text: '[[c:q.1.read]] what the reader saw' } }] });
  assert.equal(e.nameCanary, '[[c:q.1.read]]');
  assert.deepEqual(e.canaries, []);
  assert.equal(storedEntry({ id: 2, participant: 'user', content: [{ type: 'text', text: '[[c:q.1.in]] hello' }] }).nameCanary, '[[c:q.1.in]]');
});
