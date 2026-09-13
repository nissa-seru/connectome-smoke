#!/usr/bin/env node
/**
 * Post the run's lane summaries to Discord (webhook in $DISCORD_WEBHOOK).
 * Reads every summary-*.md under the evidence dir (downloaded artifacts).
 * Without a webhook it prints what it would post and exits 0.
 *
 * Usage: node scripts/notify.mjs <evidence-dir>
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'evidence';
const webhook = process.env.DISCORD_WEBHOOK;
const runUrl = process.env.RUN_URL ?? '';
const reason = process.env.REASON ?? '';

function* walk(d) {
  let ents = [];
  try { ents = readdirSync(d); } catch { return; }
  for (const n of ents) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/^summary-.*\.md$/.test(n)) yield p;
  }
}

const summaries = [...walk(dir)].sort().map((p) => readFileSync(p, 'utf-8').trim());
const lanesMissing = [];
for (const lane of ['published', 'latest', 'source']) {
  const r = process.env[`RESULT_${lane === 'source' ? 'SOURCE' : 'PUBLISHED'}`];
  if (!summaries.some((s) => s.includes(`· ${lane}**`)) && r && r !== 'skipped') lanesMissing.push(`${lane}: job ${r}, no summary (infra/error)`);
}

const allPass = summaries.length > 0 && summaries.every((s) => s.includes('✅ PASS')) && lanesMissing.length === 0;
const head = `${allPass ? '🟢' : '🔴'} **connectome-smoke** — ${allPass ? 'all lanes pass' : 'FAILURES'}${reason ? ` · _${reason}_` : ''}${runUrl ? ` · <${runUrl}>` : ''}`;
// Discord cap is 2000 chars/message; keep one message: heads + failing lines.
const body = [];
for (const s of summaries) {
  const lines = s.split('\n');
  body.push(lines[0]);            // lane head
  body.push(lines[1] ?? '');      // versions
  for (const l of lines.slice(2)) if (/^(lag|nested|✗|fatal)/.test(l)) body.push(l);
}
for (const m of lanesMissing) body.push(`✗ ${m}`);
let content = [head, ...body].join('\n');
if (content.length > 1950) content = content.slice(0, 1940) + '\n…';

if (!webhook) { console.log('(no DISCORD_WEBHOOK) would post:\n' + content); process.exit(0); }
const res = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) });
if (!res.ok) { console.error(`discord webhook → ${res.status} ${await res.text()}`); process.exit(1); }
console.log('posted:\n' + content);
