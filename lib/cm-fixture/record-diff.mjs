/**
 * The difference between a run's committed record and the record its run renders now, as a report a reviewer reads:
 * { same, header, groups, blocking, first }.
 * - `header`: the header lines that differ, other than `# recorded at`, which names the commit the record was made
 *   at: any other is what the record depends on (membrane, stand-in, scale, clock, seed), so the records need
 *   regenerating deliberately.
 * - `groups`: what changed, each { kind, lines, ... }:
 *   - `words`: one change of words, with `before` and `after` (either null where a template is new or gone) and the
 *     `templates` that carry it. A template is named by its role, so a wording change shows here alone, once however
 *     many roles share the words;
 *   - `template`: lines that differ only by one template name swapped for another, one group per swap, with the two
 *     templates' words (`before`, `after`) and how many lines carry it;
 *   - `selection`, `outcome`, `summariser`, `store`, `log`, `invariant`, `action`, `end`: the rest, by what the changed
 *     line is about, each with the expected and the actual lines;
 * - `blocking`: changes a regeneration can't accept by itself: a compile the record has that now refuses, and an
 *   INVARIANT line the record doesn't have;
 * - `first`: the first changed line, with the lines either side, as `- ` expected and `+ ` actual.
 */
export function diffRecords(expectedText, actualText) {
  const e = parse(expectedText), a = parse(actualText);
  const header = [];
  for (let i = 0; i < Math.max(e.header.length, a.header.length); i++) {
    if (e.header[i] !== a.header[i] && !(e.header[i] ?? '').startsWith('# recorded at ')) header.push({ expected: e.header[i] ?? null, actual: a.header[i] ?? null });
  }
  const ops = lineDiff(e.body, a.body);
  const groups = new Map();
  const group = (key, init) => { if (!groups.has(key)) groups.set(key, { ...init, lines: 0, samples: [] }); return groups.get(key); };
  const blocking = [];
  let first = null;
  for (const op of ops) {
    if (op.kind === 'same') continue;
    if (!first) first = context(e.body, a.body, op);
    const pairs = op.kind === 'replace' && op.expected.length === op.actual.length ? op.expected.map((x, i) => [x, op.actual[i]]) : null;
    for (const [x, y] of pairs ?? []) {
      const swaps = templateSwaps(x, y);
      if (swaps) {
        for (const [from, to] of swaps) {
          const g = group(`template ${from} ${to}`, { kind: 'template', from, to, before: e.templates.get(from) ?? null, after: a.templates.get(to) ?? null });
          g.lines++;
          if (g.samples.length < 2) g.samples.push({ expected: x, actual: y });
        }
        continue;
      }
      classify(x, y);
    }
    if (!pairs) {
      for (const x of op.expected) classify(x, null);
      for (const y of op.actual) classify(null, y);
    }
  }
  function classify(x, y) {
    const kind = kindOf(y ?? x);
    const g = group(kind, { kind });
    g.lines++;
    if (g.samples.length < 3) g.samples.push({ expected: x, actual: y });
    if (y && /^\s*compile refused /.test(y) && x && /^\s*compile (?!refused)/.test(x)) blocking.push({ why: 'a compile the record has now refuses', expected: x, actual: y });
    if (y && /^\s*INVARIANT /.test(y) && !(x && x.trim() === y.trim())) blocking.push({ why: 'an invariant the record holds is now broken', actual: y });
  }
  // A template whose words changed under its own name, which no body line shows.
  for (const id of new Set([...e.templates.keys(), ...a.templates.keys()])) {
    const before = e.templates.get(id) ?? null, after = a.templates.get(id) ?? null;
    if (before === after) continue;
    const g = group(`words ${before} ${after}`, { kind: 'words', templates: [], before, after });
    g.templates.push(id);
    g.lines++;
  }
  const same = header.length === 0 && ops.every((o) => o.kind === 'same') && sameTables(e.templates, a.templates);
  return { same, header, groups: [...groups.values()], blocking, first };
}

function parse(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const header = [], body = [], templates = new Map();
  let inTemplates = false;
  for (const line of lines) {
    if (line.startsWith('# ')) { header.push(line); continue; }
    if (line === 'templates') { inTemplates = true; continue; }
    if (inTemplates) {
      const at = line.indexOf(' = ');
      if (at > 0) templates.set(line.slice(0, at), line.slice(at + 3));
      continue;
    }
    if (line.startsWith('totals ')) continue;
    body.push(line);
  }
  return { header, body, templates };
}

const sameTables = (x, y) => x.size === y.size && [...x].every(([k, v]) => y.get(k) === v);

const TEMPLATE = /T:[a-z0-9][a-z0-9.+-]*/g;

/** The template ids two lines swap, when that's all that differs between them; otherwise null. */
function templateSwaps(x, y) {
  if (x.replace(TEMPLATE, 'T:*') !== y.replace(TEMPLATE, 'T:*')) return null;
  const xs = x.match(TEMPLATE) ?? [], ys = y.match(TEMPLATE) ?? [];
  const swaps = new Set();
  xs.forEach((t, i) => { if (t !== ys[i]) swaps.add(`${t}>${ys[i]}`); });
  return swaps.size ? [...swaps].map((s) => s.split('>')) : null;
}

function kindOf(line) {
  const t = line.trim();
  if (t.startsWith('compile refused')) return 'outcome';
  if (t.startsWith('compile')) return 'selection';
  if (t.startsWith('call') || t.startsWith('wrote')) return 'summariser';
  if (t.startsWith('removed') || t.startsWith('checkpoint')) return 'store';
  if (t.startsWith('logs')) return 'log';
  if (t.startsWith('INVARIANT')) return 'invariant';
  if (t.startsWith('action')) return 'action';
  if (t.startsWith('end')) return 'end';
  if (t.startsWith('step')) return 'steps';
  return 'other';
}

function context(expected, actual, op) {
  const from = Math.max(0, op.e - 2);
  return {
    expectedAt: op.e + 1, actualAt: op.a + 1,
    lines: [
      ...expected.slice(from, op.e).map((l) => `  ${l}`),
      ...op.expected.slice(0, 4).map((l) => `- ${l}`),
      ...op.actual.slice(0, 4).map((l) => `+ ${l}`),
    ],
  };
}

/**
 * A line diff by longest common subsequence, as ops in order: { kind: 'same' | 'replace', e, a, expected, actual },
 * `e` and `a` the ops' first line in each.
 */
export function lineDiff(x, y) {
  const n = x.length, m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  let pending = null;
  const flush = () => { if (pending) { ops.push(pending); pending = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { flush(); ops.push({ kind: 'same', e: i, a: j, expected: [x[i]], actual: [y[j]] }); i++; j++; continue; }
    if (!pending) pending = { kind: 'replace', e: i, a: j, expected: [], actual: [] };
    if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) { pending.actual.push(y[j]); j++; }
    else { pending.expected.push(x[i]); i++; }
  }
  flush();
  return ops;
}
