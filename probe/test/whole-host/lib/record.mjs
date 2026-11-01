import { createHash } from 'node:crypto';

/**
 * A run's committed record: what each request carried, as text a reviewer reads in a pull
 * request's diff, so a change's diff of the records shows what it moved and nothing else.
 *
 * It's made from the run's log: the test module's compile lines (`compiles` entries, each
 * `{ lines, blobs }`, a line per compile with its messages' sources and content digests and
 * `blobs` holding each value once), the driver's steps, and the stand-in's records of the
 * summariser's requests. Nothing in it depends on the machine, the wall clock or the process:
 *
 * - A header names the run, the checkpoint's release and stack and what the run continued,
 *   and the candidate's stack.
 * - Per step that compiled, called the summariser or acted: `step ID`, then
 *   - `compile ITEMS` for each compile the agent sent (`compile dry ITEMS` for a dry one, and
 *     `compile refused CLASS [T:...]` for a refusal). Where a compile sends what the agent's
 *     previous one sent, less some from its front and with more after it, the line is
 *     `compile -N + ITEMS`: N of the previous compile's first items no longer sent, and the
 *     items added. So a change shows on the line of the request it changed rather than on
 *     every later one. A stored message the run sent is named
 *     by the canary its text carries (`p.12.in`, `c.tool.call1`), and a run of them stored
 *     next to each other, among the messages the run's compiles sent, as a range
 *     `p.3.in-p.9.r1`. Any other stored message, such as a clock row or a host notice, is its
 *     template with its numbers after it (`[T:user-clock-#-#-utc](12,10)`); a summary is its
 *     name (below), or, where the store didn't report it, its level and a template named by
 *     its text's hash (`L2[T:summary-l2-0a1b2c3d]`). The line
 *     ends `^ N,M` with the places, in the whole list the compile sent, of the messages
 *     carrying a cache marker.
 *   - `call CARRIED -> SHAPE` for each request to the summariser, with the canaries of the
 *     messages it carried.
 *   - `action COMMAND` for each host command the driver sent.
 *   - `wrote NAME [T:...]` for each summary the batch's store added or changed, and
 *     `removed NAMES` for those it removed. A summary is named by its level and the first
 *     and last named messages it covers (`L1(p.3.in-p.5.r1)`), through any summaries under it.
 * - `checkpoint NAME` where the script took one, and `end ok` or `end failed REASON`, then
 *   `receipt AGENT #SEQ changes LEAF/KIND/LEVEL/LAST ...` for each agent's last receipt head:
 *   its sequence, and each leaf its last request changed, by name, with its representation's
 *   kind, its level and the sequence it last changed at. The head's hashes are left out:
 *   they take in image refs' per-process nonces, so they differ between runs.
 * - `totals`, then `templates`: each text the stack wrote, once, keyed by its role and its
 *   first words with numbers as `#` (a summary by its hash), so a change to its words changes
 *   one line. Two texts with one key take `.2`, `.3` in the order they first appear. A text
 *   over LONG_TEXT_BYTES is written as `{ sha256, bytes, head, tail }`.
 *
 * Image refs carry agent-framework's per-process ledger nonce (`img_<nonce>_<n>`), which
 * differs between runs by design and between the boots of one run. Each nonce is named by
 * the order it first appears in the run's templates (`img_na_<n>`, `img_nb_<n>`), which keeps
 * one boot's refs apart from another's and is the same in every run.
 */
export const LONG_TEXT_BYTES = 2048;

const CANARY = /\[\[c:([A-Za-z0-9._-]+)\]\]/;
const REF = /\bimg_([0-9a-z]+)_(\d+)\b/g;
const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const longText = (s) => {
  const bytes = Buffer.byteLength(s, 'utf8');
  return bytes <= LONG_TEXT_BYTES ? s : canonical({ sha256: createHash('sha256').update(s).digest('hex').slice(0, 16), bytes, head: s.slice(0, 80), tail: s.slice(-80) });
};
const textOf = (content) => {
  if (typeof content === 'string') return content;
  const out = [];
  const walk = (x) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== 'object') return;
    if (typeof x.text === 'string') out.push(x.text);
    if (typeof x.thinking === 'string') out.push(x.thinking);
    if (x.type === 'tool_result') { if (typeof x.content === 'string') out.push(x.content); else walk(x.content); }
    if (x.type === 'tool_use') out.push(`${x.name ?? 'tool'} ${canonical(x.input ?? null)}`);
    if (x.type === 'image') out.push(`[image ${x.source?.media_type ?? x.mimeType ?? ''}]`.replace(' ]', ']'));
  };
  walk(content);
  return out.join('\n');
};

/**
 * @param {object} run
 * @param {object} run.header `{ configuration, release: { tag, versions }, from, candidate: { versions } }`, `from` saying
 *   what the run continued (`49 prefix turns`, `H1/W2`, `empty`)
 * @param {object[]} run.log the driver's log entries, in order
 * @param {object[]} run.records the stand-in's records
 * @param {{ ok: boolean, reason?: string }} run.end how the run ended
 */
export function renderRecord({ header, log, records, end }) {
  const blobs = new Map();
  const batches = [];
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    for (const [id, v] of Object.entries(e.blobs ?? {})) blobs.set(id, v);
    batches.push(e);
  }

  // Nonces, in the order they first appear in the run's text.
  const nonces = new Map();
  // Named in letters (`na`, `nb`, … `nz`, `nba`), so a template's numbers as # leave them be.
  const letters = (i) => (i < 26 ? String.fromCharCode(97 + i) : letters(Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)));
  const nameNonces = (s) => s.replace(REF, (_, nonce, n) => {
    if (!nonces.has(nonce)) nonces.set(nonce, `n${letters(nonces.size)}`);
    return `img_${nonces.get(nonce)}_${n}`;
  });

  // Templates, by role and first words, numbers as #.
  const templates = new Map();
  const byKey = new Map();
  const slug = (s) => String(s).toLowerCase().replace(/\d+/g, '#').replace(/[^a-z#]+/g, '-').replace(/^-+|-+$/g, '');
  const template = (role, text, key = `${slug(role)}-${slug(text.split(/\s+/).slice(0, 3).join(' ')).slice(0, 40) || 'empty'}`) => {
    const shaped = longText(nameNonces(text));
    const texts = byKey.get(key) ?? [];
    let i = texts.indexOf(shaped);
    if (i === -1) { texts.push(shaped); byKey.set(key, texts); i = texts.length - 1; }
    const id = `T:${key}${i === 0 ? '' : `.${i + 1}`}`;
    templates.set(id, shaped);
    return id;
  };

  // Where each stored message sits among those the run's compiles sent, by its stored id.
  const storedIds = new Set();
  for (const b of batches) for (const l of b.lines) for (const m of l.messages ?? []) if (m.sources.length === 1 && m.sources[0].startsWith('r:')) storedIds.add(m.sources[0].slice(2));
  const order = new Map([...storedIds].sort((a, b) => (Number(a) - Number(b)) || (a < b ? -1 : 1)).map((id, i) => [id, i]));
  // What each agent's store holds, as the module reports it with each batch (`store`): the
  // canaries of the messages it added, its summaries with their sources, its receipt head.
  const canaryOf = new Map();
  const summaries = new Map();
  for (const b of batches) for (const st of Object.values(b.store ?? {})) {
    for (const [id, canaries] of st.messages ?? []) { const c = CANARY.exec(canaries?.[0] ?? '')?.[1]; if (c) canaryOf.set(String(id), c); }
    for (const sm of st.summaries ?? []) summaries.set(sm.id, sm);
  }
  // A summary's name: its level and the first and last named messages it covers, through any summaries it covers.
  const leaves = (id, seen = new Set()) => {
    const sm = summaries.get(id);
    if (!sm || seen.has(id)) return [];
    seen.add(id);
    return sm.sources.flatMap((src) => (summaries.has(src) && sm.sourceLevel > 0 ? leaves(src, seen) : [String(src)]));
  };
  const summaryName = (id, level) => {
    const named = leaves(id).map((leaf) => canaryOf.get(leaf)).filter(Boolean);
    return `L${summaries.get(id)?.level ?? level}(${named.length ? (named.length === 1 ? named[0] : `${named[0]}-${named.at(-1)}`) : '-'})`;
  };
  const summaryTemplate = (sm) => {
    const value = blobs.get(sm.content);
    const text = nameNonces(textOf(value?.content ?? value ?? ''));
    return template('summary', text, `summary-l${sm.level}-${createHash('sha256').update(text).digest('hex').slice(0, 8)}`);
  };
  // A stored message's name: the canary its text carries, else its template and its numbers.
  const item = (m) => {
    const value = blobs.get(m.content);
    const raw = textOf(value?.content ?? value);
    if (m.sources.length === 1 && m.sources[0].startsWith('r:')) {
      const canary = CANARY.exec(raw)?.[1];
      if (canary) return { name: canary, pos: order.get(m.sources[0].slice(2)) };
      const text = nameNonces(raw);
      const numbers = text.match(/\d+/g) ?? [];
      return { text: `[${template(value?.participant ?? 'message', text.replace(/\d+/g, '#'))}]${numbers.length ? `(${numbers.join(',')})` : ''}` };
    }
    const ids = m.sources.map((s) => /^s:([^@]+)@?(.*)$/.exec(s));
    if (ids.every((x) => x && summaries.has(x[1]))) return { text: ids.map((x) => summaryName(x[1], x[2])).join('+') };
    const levels = m.sources.map((s) => (s.startsWith('s:') ? `L${s.split('@')[1] ?? '?'}` : s.split(':')[0])).join('+');
    const text = nameNonces(raw);
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 8);
    return { text: `${levels}[${template('summary', text, `summary-${levels.toLowerCase()}-${hash}`)}]` };
  };
  const items = (list) => {
    const out = [];
    for (const it of list) {
      const last = out.at(-1);
      if (it.name && last?.from && it.pos !== undefined && it.pos === last.end + 1) { last.to = it.name; last.end = it.pos; continue; }
      out.push(it.name ? { from: it.name, to: it.name, end: it.pos } : it);
    }
    return out.map((r) => r.text ?? (r.from === r.to ? r.from : `${r.from}-${r.to}`)).join(' ');
  };
  // Each agent's previous compile of its kind (sent or dry), as its items' keys, for the `+` lines.
  const previous = new Map();
  const keyOf = (it) => it.name ?? it.text;
  const compileLine = (l) => {
    const list = (l.messages ?? []).map(item);
    const marks = (l.messages ?? []).flatMap((m, i) => (m.marker ? [i + 1] : []));
    const keys = list.map(keyOf);
    const whose = `${l.agent} ${l.kind}`;
    const before = previous.get(whose);
    previous.set(whose, keys);
    // The fewest of the previous compile's first items to drop for the rest to start this one.
    let dropped = -1;
    if (before) {
      for (let n = 0; n <= before.length && dropped < 0; n++) {
        const kept = before.length - n;
        if (kept <= keys.length && (kept > 0 || n === 0) && before.slice(n).every((k, i) => keys[i] === k)) dropped = n;
      }
    }
    const added = dropped < 0 ? null : list.slice(before.length - dropped);
    const shown = dropped < 0 ? items(list) : [dropped ? `-${dropped}` : '', added.length ? `+ ${items(added)}` : ''].filter(Boolean).join(' ') || '= (as before)';
    return `  compile${l.kind === 'dry' ? ' dry' : ''} ${shown}${marks.length ? ` ^ ${marks.join(',')}` : ''}`;
  };

  const lines = [];
  const versions = (v) => Object.entries(v ?? {}).map(([k, x]) => `${k.replace('@animalabs/', '')} ${x}`).join(', ');
  lines.push(`# whole-host record ${header.configuration}`);
  lines.push(`# checkpoint ${header.release.tag}, ${header.from}: ${versions(header.release.versions)}`);
  lines.push(`# candidate: ${versions(header.candidate.versions)}`);

  const totals = { compiles: 0, dry: 0, refused: 0, other: 0, calls: 0, written: 0, actions: 0 };
  const receipt = new Map();
  const known = new Map();
  const byStep = new Map();
  const at = (step) => { if (!byStep.has(step)) byStep.set(step, []); return byStep.get(step); };
  const steps = [];
  const seen = (step) => { if (!steps.includes(step)) steps.push(step); };
  const summariser = new Map((records ?? []).filter((r) => r.kind === 'summariser').map((r) => [r.id, r]));
  for (const e of log) {
    if (e.kind === 'send' && e.via === 'ipc' && e.command) { seen(e.step); at(e.step).push(`  action ${e.command}`); totals.actions++; }
    if (e.kind === 'request' && summariser.has(e.request?.id)) {
      const r = summariser.get(e.request.id);
      totals.calls++;
      seen(e.step);
      const carried = [...new Set(r.messages.flatMap((m) => m.blocks.flatMap((b) => b.canaries ?? [])).map((c) => CANARY.exec(c)?.[1] ?? c))];
      at(e.step).push(`  call ${carried.length ? carried.join(' ') : '-'} -> ${r.answer?.shape ?? 'none'}`);
    }
    if (e.kind === 'compiles') {
      for (const [agent, st] of Object.entries(e.store ?? {})) {
        if (st.receiptHead) receipt.set(agent, st.receiptHead);
        for (const sm of st.summaries ?? []) {
          // A new process's first batch lists the store whole; a summary it already had isn't written again.
          const was = known.get(`${agent} ${sm.id}`);
          const now = canonical({ level: sm.level, sources: sm.sources, content: sm.content, parent: sm.parent ?? null });
          known.set(`${agent} ${sm.id}`, now);
          if (was === now) continue;
          seen(e.step); at(e.step).push(`  wrote ${summaryName(sm.id, sm.level)} [${summaryTemplate(sm)}]`); totals.written++;
        }
        for (const id of st.removed ?? []) known.delete(`${agent} ${id}`);
        if (st.removed?.length) { seen(e.step); at(e.step).push(`  removed ${st.removed.map((id) => (summaries.has(id) ? summaryName(id) : canaryOf.get(String(id)) ?? `#${id}`)).join(' ')}`); }
      }
      for (const l of e.lines) {
        if (l.kind === 'other') { totals.other++; continue; }
        seen(e.step);
        if (l.outcome === 'refused' || l.error) {
          totals.refused++;
          const text = typeof l.error?.message === 'string' ? (blobs.get(l.error.message) ?? l.error.message) : '';
          at(e.step).push(`  compile refused ${l.error?.class ?? 'unknown'}${text ? ` [${template(`error-${l.error?.class ?? 'unknown'}`, String(text).replace(/\d+/g, '#'))}]` : ''}`);
          continue;
        }
        if (l.kind === 'dry') totals.dry++; else totals.compiles++;
        at(e.step).push(compileLine(l));
      }
    }
    if (e.kind === 'checkpoint') { seen(e.step); at(e.step).push(`checkpoint ${e.name}`); }
  }
  for (const step of steps) {
    const own = byStep.get(step) ?? [];
    const body = own.filter((l) => l.startsWith('  '));
    if (body.length) lines.push(`step ${step}`, ...body);
    lines.push(...own.filter((l) => !l.startsWith('  ')));
  }
  lines.push(`end ${end?.ok ? 'ok' : `failed ${end?.reason ?? 'with no reason given'}`}`);
  // The head's hashes take in image refs' nonces, so they differ between runs; its sequence
  // and the leaves its last request changed don't.
  const leafName = (leaf) => (summaries.has(leaf) ? summaryName(leaf) : canaryOf.get(String(leaf)) ?? `#${leaf}`);
  for (const [agent, head] of [...receipt.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const changes = (head.changes ?? []).map(([leaf, [repr, level, last]]) => `${leafName(leaf)}/${String(repr).split(':')[0]}/${level}/${last}`);
    lines.push(`receipt ${agent} #${head.sequence}${changes.length ? ` changes ${changes.join(' ')}` : ''}`);
  }
  lines.push(`totals ${canonical(totals)}`);
  lines.push('templates');
  for (const [id, text] of [...templates.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) lines.push(`${id} = ${text}`);
  return `${lines.join('\n')}\n`;
}
