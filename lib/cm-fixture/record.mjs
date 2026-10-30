import { canonicalJSON, digest, addedName } from './events.mjs';

/**
 * A run's committed record: its trace (readTrace's result) rendered as text, one line per thing a reviewer judges,
 * so a change's diff of the records shows what it moved.
 *
 * - A header names the run and what the record depends on: the library commit it was recorded at, membrane's
 *   version, the stand-in's, the scale, the clock and the fixture's version.
 * - Per step: `step N`, then its lines in the order they happened:
 *   - `call CARRIED target T -> KIND` for each summariser request;
 *   - `compile SOURCES` or `compile refused CLASS`, each message's sources in order, messages the run added named
 *     `aSTEP.N` and consecutive ones written as a range `aX.Y-aZ.W`, a summary as `L1-3@1`, a message carrying a
 *     cache marker followed by `^`, and a message whose content isn't its source's own text followed by `[T:ID]`;
 *   - `wrote ID over SOURCES` for each summary written, `[T:ID]` after it when its text isn't the stand-in's answer;
 *   - `removed IDS`, `action OP ARGS -> RESULT` (adds aren't listed), `logs TAG*COUNT ...`, `INVARIANT NAME: DETAIL`.
 * - Per checkpoint: `checkpoint LABEL`, with its counts and shape.
 * - Templates: `T:ID = JSON` for each message or request content the record names, with the text the workload added
 *   written `{{aSTEP.N}}` and a summary's text `{{ID}}`, so the words the library itself wrote appear once.
 * - Totals.
 */
export function renderRecord(trace) {
  const { header, events, blobs, end } = trace;
  const lines = [];
  const templates = new Map();
  const value = (id) => blobs.get(id);

  // The workload's own text, by the name of the message it added, and each summary's text, by its id.
  const subs = [];
  const addedContent = new Map();
  for (const e of events) {
    if (e.kind === 'action' && e.op === 'add') {
      const name = addedName(e.step, e.n);
      const content = value(e.args.content);
      addedContent.set(name, canonicalJSON(content));
      for (const block of Array.isArray(content) ? content : []) {
        const text = typeof block?.text === 'string' ? block.text : typeof block?.content === 'string' ? block.content : null;
        if (text && text.length >= 8) subs.push([text, `{{${name}}}`]);
      }
    }
  }
  const answers = new Set();
  for (const e of events) {
    if (e.kind === 'call' && e.answer.text) answers.add(value(e.answer.text));
    if (e.kind === 'step') for (const s of e.written) { const t = value(s.content); if (typeof t === 'string' && t.length >= 8) subs.push([t, `{{${s.id}}}`]); }
  }
  subs.sort((a, b) => b[0].length - a[0].length);
  // A template keeps the words the library wrote: the workload's text becomes {{raw}}, a summary's {{summary}}, and a
  // summary id L#, since which message or summary it is shows in the line that names the template.
  const shape = (text) => {
    let t = text;
    for (const [from, to] of subs) if (t.includes(from)) t = t.split(from).join(to);
    return t.replace(/\{\{a\d+\.\d+\}\}/g, '{{raw}}').replace(/\{\{L\d+-\d+\}\}/g, '{{summary}}').replace(/\bL(\d+)-\d+\b/g, 'L$1-#');
  };
  const shaped = (v) => (typeof v === 'string' ? shape(v) : Array.isArray(v) ? v.map(shaped) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shaped(x)])) : v);
  const keep = (text) => {
    const id = `T:${digest(text).slice(0, 8)}`;
    templates.set(id, text);
    return id;
  };
  // A message's template is its content, shaped.
  const template = (v) => keep(canonicalJSON(shaped(v)));
  // A summariser request's template is the distinct texts it holds (text blocks and string tool results), shaped,
  // with summary levels as L#, and sorted, leaving out those that are only workload or summary text: what the call
  // carried, recalled summaries and their levels included, is on its own line.
  const requestTemplate = (v) => {
    const strings = new Set();
    const walk = (x) => {
      if (Array.isArray(x)) { x.forEach(walk); return; }
      if (!x || typeof x !== 'object') return;
      if (typeof x.text === 'string') strings.add(shape(x.text));
      if (x.type === 'tool_result' && typeof x.content === 'string') strings.add(shape(x.content));
      Object.values(x).forEach(walk);
    };
    walk(v);
    const texts = [...strings].map((t) => t.replace(/\bL\d+-#/g, 'L#-#')).filter((t) => !/^(\s*\{\{(raw|summary)\}\}\s*)+$/.test(t));
    return keep(canonicalJSON([...new Set(texts)].sort()));
  };

  const order = [];
  for (const e of events) if (e.kind === 'action' && e.op === 'add') order.push(addedName(e.step, e.n));
  const position = new Map(order.map((n, i) => [n, i]));
  // A canary the stand-in reports in what a request carried, by the name of the message whose text holds it.
  const canaryName = new Map();
  for (const [name, content] of addedContent) for (const c of content.match(/\bm\d+_\d+[a-z]x\b/g) ?? []) if (!canaryName.has(c)) canaryName.set(c, name);
  const carriedText = (carried) => {
    const names = [...new Set(carried.filter((c) => !/^L\d+-\d+$/.test(c)).map((c) => canaryName.get(c) ?? c))];
    names.sort((a, b) => (position.get(a) ?? Infinity) - (position.get(b) ?? Infinity) || (a < b ? -1 : 1));
    const recalled = carried.filter((c) => /^L\d+-\d+$/.test(c));
    const raw = ranges(names.map((name) => ({ plain: position.has(name), name, text: name })));
    return `${raw || '-'}${recalled.length ? ` +${recalled.join(',')}` : ''}`;
  };
  const ranges = (items) => {
    const out = [];
    for (const it of items) {
      const last = out.at(-1);
      const p = position.get(it.name);
      if (it.plain && last && last.plain && p !== undefined && last.end + 1 === p && !last.mark) { last.end = p; last.to = it.name; last.mark = it.mark; continue; }
      out.push({ ...it, start: p, end: p, from: it.name, to: it.name });
    }
    const merged = [];
    for (const r of out) {
      const last = merged.at(-1);
      if (!r.plain && last && !last.plain && r.key !== undefined && last.key === r.key) { last.parts.push(r.part); continue; }
      merged.push(r.plain ? r : { ...r, parts: r.part !== undefined ? [r.part] : undefined });
    }
    return merged.map((r) => (r.plain ? `${r.from === r.to ? r.from : `${r.from}-${r.to}`}${r.mark ? '^' : ''}` : r.parts ? `${r.key}[${r.parts.join(',')}]` : r.text)).join(' ');
  };

  lines.push(`# cm-fixture record ${header.run}`);
  lines.push(`# library ${header.library.commit}${header.library.version ? ` (${header.library.version})` : ''} · membrane ${header.membrane.version} · fixture ${header.fixture.version}${header.fixture.standin ? ` · stand-in ${header.fixture.standin}` : ''} · scale ${header.scale} · clock ${header.fixture.clock ?? 'virtual'} · seed ${header.seed} · from ${header.from ?? '(empty)'}${header.only ? ' · candidate only' : ''}`);
  let step = -1;
  const totals = { compiles: 0, refused: 0, calls: 0, written: 0 };
  for (const e of events) {
    if (e.step !== undefined && e.step !== step && e.kind !== 'checkpoint') { step = e.step; lines.push(`step ${step}`); }
    switch (e.kind) {
      case 'action':
        if (e.op !== 'add') lines.push(`  action ${e.op} ${canonicalJSON(e.args)}${e.result !== undefined ? ` -> ${canonicalJSON(e.result)}` : ''}`);
        break;
      case 'call':
        totals.calls++;
        lines.push(`  call ${carriedText(e.carried)} target ${e.target} -> ${e.answer.kind} [${requestTemplate(value(e.request))}]`);
        break;
      case 'compile': {
        totals.compiles++;
        if (e.outcome === 'refused') { totals.refused++; lines.push(`  compile refused ${e.error.class}`); break; }
        const items = e.messages.map((m) => {
          const content = value(m.content);
          const raw = m.sources.length === 1 && m.sources[0].startsWith('r:') ? m.sources[0].slice(2) : null;
          const own = raw && addedContent.has(raw) && canonicalJSON(content?.content) === addedContent.get(raw);
          if (own) return { plain: true, name: raw, mark: !!m.marker };
          const key = m.sources.map((s) => s.replace(/^[rs]:/, '')).join('+');
          return { plain: false, key, part: `${template(content)}${m.marker ? '^' : ''}` };
        });
        lines.push(`  compile ${ranges(items)}${e.receipt ? ` receipt${e.receipt.withReference ? '+ref' : ''}` : ''}`);
        break;
      }
      case 'step':
        for (const s of e.written) {
          totals.written++;
          const t = value(s.content);
          lines.push(`  wrote ${s.id} over ${s.sources.join(' ')}${answers.has(t) ? '' : ` [${template(t)}]`}`);
        }
        if (e.removed.length) lines.push(`  removed ${e.removed.join(' ')}`);
        if (Object.keys(e.logs).length) lines.push(`  logs ${Object.entries(e.logs).map(([t, c]) => `${t}*${c}`).join(' ')}`);
        break;
      case 'checkpoint': {
        const levels = {};
        if (Array.isArray(e.summaries)) for (const s of e.summaries) levels[`L${s.level}`] = (levels[`L${s.level}`] ?? 0) + 1;
        lines.push(`checkpoint ${e.label}: messages ${Array.isArray(e.messages) ? e.messages.length : 'unreadable'}, summaries ${canonicalJSON(levels)}, pins ${Array.isArray(e.pins) ? e.pins.length : 'unreadable'}, holds ${Array.isArray(e.holds) ? e.holds.length : 'unreadable'}, ready ${canonicalJSON(e.ready)}, waiting ${canonicalJSON(e.waiting)}`);
        break;
      }
      default: break;
    }
    for (const v of e.violations ?? []) lines.push(`  INVARIANT ${v.invariant}: ${v.detail}`);
  }
  lines.push(`end ${end.ok ? 'ok' : `${end.error.where} ${end.error.class}`}${end.logs ? ` logs ${Object.entries(end.logs).map(([t, c]) => `${t}*${c}`).join(' ')}` : ''}`);
  lines.push(`totals ${canonicalJSON(totals)}`);
  lines.push('templates');
  for (const [id, text] of [...templates.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) lines.push(`${id} = ${text}`);
  return `${lines.join('\n')}\n`;
}

