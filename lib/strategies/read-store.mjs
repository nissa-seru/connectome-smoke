import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { CANARY, SUMMARY } from './standin.mjs';

/**
 * Read a copy of a store as one side's own release reads it, through context-manager's
 * public API (`ContextManager.open`, `getAllMessages`, `getSummariesInRange`, `getSummary`),
 * so a release that stores summaries differently still reads. Opening a store takes its lock
 * and can write to it, so this runs on a copy, never on a store a host has open.
 *
 * Returns `{ messages, summaries }`: each message's id, participant, the canaries its text
 * carries and its body's group and shard; each summary's id, level, sources, the stand-in's
 * summary number its content starts with, and the canaries of every message it covers, read
 * down through its sources. A strategy that compressed (`expectSummaries`) and yields no
 * summary, or a summary whose number or sources can't be read, is an error, never "none".
 */
export async function readStore({ installDir, storePath, namespace, expectSummaries = true }) {
  const cmEntry = join(installDir, 'node_modules', '@animalabs', 'context-manager', 'dist', 'src', 'index.js');
  const { ContextManager, AutobiographicalStrategy } = await import(pathToFileURL(cmEntry).href);
  // Opened audit-only, as context-manager's own audit-topology opens a store: no chunking at
  // the frontier, no merge enqueued, nothing ticked.
  const strategy = new AutobiographicalStrategy({ adaptiveResolution: true, autoTickOnNewMessage: false, topologyPolicy: 'report', auditOnly: true });
  const cm = await ContextManager.open({ path: storePath, namespace, strategy });
  try {
    const textOf = (content) => (Array.isArray(content) ? content : [content]).map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : b?.type === 'tool_result' ? JSON.stringify(b.content) : '')).join('');
    const messages = cm.getAllMessages().map((m) => ({
      id: m.id,
      participant: m.participant,
      canaries: textOf(m.content).match(CANARY) ?? [],
      ...(m.bodyGroupId ? { bodyGroupId: m.bodyGroupId, shardIndex: m.shardIndex } : {}),
    }));
    const ids = cm.getSummariesInRange({}).map((s) => s.id);
    if (expectSummaries && ids.length === 0) throw new Error(`no summaries in ${namespace} at ${storePath}, from a configuration that compresses`);
    const entries = new Map();
    for (const id of ids) {
      const s = cm.getSummary(id);
      if (!s) throw new Error(`getSummary(${id}) is null, though getSummariesInRange lists it`);
      entries.set(id, s);
    }
    const byMessage = new Map(messages.map((m) => [m.id, m]));
    const leaves = (s, seen = new Set()) => {
      if (seen.has(s.id)) return [];
      seen.add(s.id);
      if (s.sourceLevel === 0) return s.sourceIds;
      return s.sourceIds.flatMap((id) => {
        const child = entries.get(id) ?? cm.getSummary(id);
        if (!child) throw new Error(`summary ${s.id}'s source ${id} can't be read`);
        return leaves(child, seen);
      });
    };
    const summaries = [...entries.values()].map((s) => ({
      id: s.id,
      level: s.level,
      sourceLevel: s.sourceLevel,
      sourceIds: s.sourceIds,
      number: (String(s.content ?? '').match(SUMMARY) ?? [null])[0],
      covers: leaves(s).flatMap((id) => byMessage.get(id)?.canaries ?? []),
    }));
    return { messages, summaries };
  } finally {
    await cm.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const out = await readStore({ installDir: arg('install'), storePath: arg('store'), namespace: arg('namespace'), expectSummaries: arg('expect-summaries') !== 'false' });
  writeFileSync(arg('out'), JSON.stringify(out, null, 1));
}
