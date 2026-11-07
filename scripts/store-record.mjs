#!/usr/bin/env node
/**
 * What a store's record holds for one agent, read through the context-manager a given
 * install carries, as JSON on stdout: each message's id, participant and text blocks,
 * each summary's id and text, and the ids context-manager's indexed record query
 * (`queryMessagesByTimeAndChannel`, which agent-framework's history tools read) returns
 * with no filter. The store-move lane runs it on copies (lib/store-move.mjs).
 *
 *   node scripts/store-record.mjs --install <dir> --store <store dir> --namespace <ns>
 *
 * The store is opened audit-only, as context-manager's own topology audit opens one: no
 * chunking at the frontier, no merge enqueued, nothing ticked. Opening still takes the
 * store's lock and can write to it, so give it a copy. Its own process, so each install's
 * packages load apart from the lane's.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const [installDir, storePath, namespace] = [arg('install'), arg('store'), arg('namespace')];
if (!installDir || !storePath || !namespace) {
  console.error('usage: store-record.mjs --install <dir> --store <store dir> --namespace <ns>');
  process.exit(2);
}

const cmEntry = join(installDir, 'node_modules', '@animalabs', 'context-manager', 'dist', 'src', 'index.js');
const { ContextManager, AutobiographicalStrategy } = await import(pathToFileURL(cmEntry).href);
const strategy = new AutobiographicalStrategy({ adaptiveResolution: true, autoTickOnNewMessage: false, topologyPolicy: 'report', auditOnly: true });
const cm = await ContextManager.open({ path: storePath, namespace, strategy });
try {
  /** Each text a message carries: its text blocks', and a tool result's own text. */
  const texts = (content) => (Array.isArray(content) ? content : [content]).flatMap((b) => {
    if (typeof b === 'string') return [b];
    if (b?.type === 'text' && typeof b.text === 'string') return [b.text];
    if (b?.type === 'tool_result') return typeof b.content === 'string' ? [b.content] : texts(b.content ?? []);
    return [];
  }).filter((t) => t.length > 0);
  const messages = cm.getAllMessages().map((m) => ({ id: m.id, participant: m.participant, texts: texts(m.content) }));
  const summaries = cm.getSummariesInRange({}).map((s) => cm.getSummary(s.id) ?? s).map((s) => ({ id: s.id, level: s.level, text: String(s.content ?? '') }));
  const indexed = [];
  for (let offset = 0; ; offset += 500) {
    const page = cm.queryMessagesByTimeAndChannel({ limit: 500, offset });
    indexed.push(...page.messages.map((m) => m.id));
    if (page.messages.length < 500) break;
  }
  process.stdout.write(JSON.stringify({ namespace, messages, summaries, indexed }) + '\n');
} finally {
  await cm.close?.();
}
