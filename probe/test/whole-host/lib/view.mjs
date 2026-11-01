export function changedRequests(committed, lines) {
  const before = committed.split('\n');
  if (before.at(-1) === '') before.pop();
  const after = lines.map((l) => l.text);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const a = before.slice(start, before.length - tail);
  const b = after.slice(start, after.length - tail);
  const width = b.length + 1;
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] = a[i] === b[j] ? common[(i + 1) * width + j + 1] + 1 : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
    }
  }
  const added = [];
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; continue; }
    if (j < b.length && (i === a.length || common[i * width + j + 1] >= common[(i + 1) * width + j])) { added.push(start + j); j++; continue; }
    removed++;
    i++;
  }
  const requests = [...new Set(added.map((k) => lines[k].request).filter(Boolean))];
  return { requests, added: added.length, removed, unattributed: added.filter((k) => !lines[k].request).length };
}

export const STEP_SUMMARY_BYTES = 1024 * 1024;
const HEADING_CHARS = 200;

const COLUMNS = [
  ['compiles sent', (c) => c.counts?.compiles],
  ['refused', (c) => c.counts?.refused],
  ['compressions', (c) => c.counts?.compressions],
  ['merges', (c) => c.counts?.merges],
  ['quarantines', (c) => c.counts?.quarantines],
  ['ledger of', (c) => c.ledgerOf],
  ['raw', (c) => c.counts?.raw],
  ['summarised', (c) => c.counts?.summarised],
  ['left out', (c) => c.counts?.out],
  ['tokens sent', (c) => (c.tokens ? (c.tokens.input ?? 0) + (c.tokens.cacheRead ?? 0) + (c.tokens.cacheWrite ?? 0) : undefined)],
  ['invariant lines', (c) => c.counts?.invariantLines],
];

export function summaryTable(rows) {
  const cell = (v) => (v === undefined || v === null ? '?' : String(v));
  const record = (r) => (r.record === 'differs' ? `differs: ${r.changed.requests.length} request(s), +${r.changed.added} -${r.changed.removed} line(s)` : r.record ?? 'none');
  return [
    `| run | record | ${COLUMNS.map(([name]) => name).join(' | ')} |`,
    `|---|---|${COLUMNS.map(([name]) => (name === 'ledger of' ? '---' : '---:')).join('|')}|`,
    ...rows.map((r) => `| ${r.run} | ${record(r)} | ${COLUMNS.map(([, of]) => cell(of(r))).join(' | ')} |`),
  ].join('\n');
}

export function viewOf({ run, record, changed, lines, transcript, ledger }) {
  const out = [`## ${run}`, ''];
  if (record === 'missing') out.push('No record is committed for this run, so every request is shown.', '');
  else out.push(`${changed.requests.length} request(s) changed: ${changed.added} record line(s) added and ${changed.removed} removed${changed.unattributed ? `, ${changed.unattributed} of the added belonging to no request (a summary written or removed, an action, a checkpoint)` : ''}.`, '');
  const lineOf = new Map();
  const short = (t) => (t.length > HEADING_CHARS ? `${t.slice(0, HEADING_CHARS - 1)}…` : t);
  for (const l of lines) if (l.request && !lineOf.has(l.request)) lineOf.set(l.request, short(l.text.trim()));
  const seen = new Set();
  for (const id of changed.requests) {
    out.push(`### ${id}: \`${lineOf.get(id) ?? '(no line)'}\``, '');
    const owned = ledger(id);
    if (owned?.length) out.push(...owned, '');
    out.push('```text', ...transcript(id, seen), '```', '');
  }
  return `${out.join('\n')}\n`;
}

export function stepSummary({ table, views, budget = STEP_SUMMARY_BYTES }) {
  const bytes = (s) => Buffer.byteLength(s, 'utf8');
  const head = `${table}\n\n`;
  const notes = views.map((v) => `The view of ${v.run} (${bytes(v.text)} bytes) didn't fit within this summary's ${budget} bytes: it's ${v.path} in the job's evidence.\n`);
  let used = bytes(head);
  const shown = [];
  const skipped = [];
  views.forEach((v, i) => {
    const rest = notes.slice(i + 1).reduce((n, x) => n + bytes(x), 0);
    if (used + bytes(v.text) + rest <= budget) { shown.push(v.text); used += bytes(v.text); } else { skipped.push(notes[i]); used += bytes(notes[i]); }
  });
  return head + shown.join('') + skipped.join('');
}
