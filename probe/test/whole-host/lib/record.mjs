import { createHash } from 'node:crypto';
import { requestPairs } from './strategies/checks.mjs';

export const LONG_TEXT_BYTES = 4096;

const CANARY = /\[\[c:([A-Za-z0-9._-]+)\]\]/;
const MARK = /\[\[s:M[0-9a-f]{8}\]\]/g;
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

export function renderRecord({ header, log, records, end }) {
  const blobs = new Map();
  const batches = [];
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    for (const [id, v] of Object.entries(e.blobs ?? {})) blobs.set(id, v);
    batches.push(e);
  }

  const nonces = new Map();
  const letters = (i) => (i < 26 ? String.fromCharCode(97 + i) : letters(Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)));
  // agent-framework mints an image ref's nonce per process (tool-image-ledger.ts), so each is named by its first appearance.
  const nameNonces = (s) => s.replace(REF, (_, nonce, n) => {
    if (!nonces.has(nonce)) nonces.set(nonce, `n${letters(nonces.size)}`);
    return `img_${nonces.get(nonce)}_${n}`;
  });

  const templates = [];
  const slot = new Map();
  const slug = (s) => String(s).toLowerCase().replace(/\d+/g, '#').replace(/[^a-z#]+/g, '-').replace(/^-+|-+$/g, '');
  const template = (role, text, key = null) => {
    const shaped = longText(nameNonces(text));
    const words = key ? null : text.split(/\s+/);
    const base = key ?? `${slug(role)}-${slug(words.slice(0, 3).join(' ')).slice(0, 40) || 'empty'}`;
    const k = `${base}\u0000${shaped}`;
    if (!slot.has(k)) { slot.set(k, templates.length); templates.push({ base, role, words, shaped }); }
    return `\u0001${slot.get(k)}\u0001`;
  };

  const primary = batches.flatMap((x) => x.lines ?? []).find((l) => l.agent)?.agent;
  const stores = new Map();
  const storeOf = (agent) => {
    if (!stores.has(agent)) stores.set(agent, { ids: new Set(), canaryOf: new Map(), summaries: new Map(), order: null });
    return stores.get(agent);
  };
  for (const b of batches) {
    for (const [agent, st] of Object.entries(b.store ?? {})) {
      const store = storeOf(agent);
      for (const [id, canaries] of st.messages ?? []) {
        store.ids.add(String(id));
        const c = CANARY.exec(canaries?.[0] ?? '')?.[1];
        if (c) store.canaryOf.set(String(id), c);
      }
      for (const sm of st.summaries ?? []) store.summaries.set(sm.id, sm);
    }
    for (const l of b.lines ?? []) for (const m of l.messages ?? []) if (m.sources.length === 1 && m.sources[0].startsWith('r:')) storeOf(l.agent).ids.add(m.sources[0].slice(2).split('!')[0]);
  }
  const byId = (a, b) => {
    const x = Number(a), y = Number(b);
    const nx = Number.isFinite(x), ny = Number.isFinite(y);
    return nx && ny ? x - y : nx ? -1 : ny ? 1 : a < b ? -1 : a > b ? 1 : 0;
  };
  const positionOf = (agent, id) => {
    const store = storeOf(agent);
    if (!store.order) store.order = new Map([...store.ids].sort(byId).map((x, i) => [x, i]));
    return store.order.get(id);
  };
  const leaves = (agent, id, seen = new Set()) => {
    const sm = storeOf(agent).summaries.get(id);
    if (!sm || seen.has(id)) return [];
    seen.add(id);
    return sm.sources.flatMap((src) => (storeOf(agent).summaries.has(src) && sm.sourceLevel > 0 ? leaves(agent, src, seen) : [String(src)]));
  };
  const summaryName = (agent, id, level) => {
    const { canaryOf, summaries } = storeOf(agent);
    const named = leaves(agent, id).map((leaf) => canaryOf.get(leaf)).filter(Boolean);
    return `L${summaries.get(id)?.level ?? level}(${named.length ? (named.length === 1 ? named[0] : `${named[0]}-${named.at(-1)}`) : '-'})`;
  };
  const leafName = (agent, leaf) => (storeOf(agent).summaries.has(leaf) ? summaryName(agent, leaf) : storeOf(agent).canaryOf.get(String(leaf)) ?? `#${leaf}`);
  const summaryTemplate = (sm) => {
    const value = blobs.get(sm.content);
    const text = nameNonces(textOf(value?.content ?? value ?? ''));
    return template('summary', text, `summary-l${sm.level}-${createHash('sha256').update(text).digest('hex').slice(0, 8)}`);
  };
  let marks = null;
  const markName = () => {
    if (!marks) {
      marks = new Map();
      for (const [agent, store] of stores) for (const sm of store.summaries.values()) {
        const value = blobs.get(sm.content);
        for (const m of textOf(value?.content ?? value ?? '').match(MARK) ?? []) if (!marks.has(m)) marks.set(m, summaryName(agent, sm.id, sm.level));
      }
    }
    return marks;
  };
  const thinking = new Map();
  const item = (m, agent) => {
    const value = blobs.get(m.content);
    const raw = textOf(value?.content ?? value);
    if (m.sources.length === 1 && m.sources[0].startsWith('r:')) {
      const [id, why] = m.sources[0].slice(2).split('!');
      const bare = thinking.get(`${agent} ${id}`) === true && !(Array.isArray(value?.content) && value.content.some((b) => b?.type === 'thinking' || b?.type === 'redacted_thinking'));
      const after = `${why ? `!${why}` : ''}${bare ? ':no-thinking' : ''}`;
      const canary = CANARY.exec(raw)?.[1];
      if (canary && !after) return { name: canary, pos: positionOf(agent, id) };
      if (canary) return { text: `${canary}${after}` };
      const text = nameNonces(raw);
      const numbers = text.match(/\d+/g) ?? [];
      return { text: `[${template(value?.participant ?? 'message', text.replace(/\d+/g, '#'))}]${numbers.length ? `(${numbers.join(',')})` : ''}${after}` };
    }
    const ids = m.sources.map((s) => /^s:([^@]+)@?(.*)$/.exec(s));
    if (ids.every((x) => x && storeOf(agent).summaries.has(x[1]))) return { text: ids.map((x) => `${summaryName(agent, x[1], x[2])}${x[2].endsWith('~') ? '~' : ''}`).join('+') };
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
  const previous = new Map();
  const keyOf = (it) => it.name ?? it.text;
  const sha8 = (v) => createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex').slice(0, 8);
  const sentAs = new Map();
  const rounds = new Map();
  for (const agent of new Set(batches.flatMap((b) => (b.lines ?? []).map((l) => l.agent)).filter(Boolean))) {
    const paired = requestPairs(records ?? [], log, agent, { side: agent === primary ? 'primary' : 'sub' });
    for (const { line, request } of paired?.pairs ?? []) sentAs.set(`${agent}|${line.boot}|${line.seq}`, request);
    for (const request of paired?.continuations ?? []) rounds.set(request.id, { agent, request });
  }
  const heads = new Map();
  const lastHead = new Map();
  const headText = (h) => [
    `model ${h.model}`,
    `max_tokens ${h.maxTokens}`,
    `stream ${h.stream}`,
    ...(h.toolChoice ? [`tool_choice ${canonical(h.toolChoice)}`] : []),
    ...(h.thinking ? [`thinking ${canonical(h.thinking)}`] : []),
    `system ${(h.system ?? []).map((b) => {
      const text = nameNonces(b.text ?? '');
      const numbers = text.match(/\d+/g) ?? [];
      return `[${template('system', text.replace(/\d+/g, '#'))}]${numbers.length ? `(${numbers.join(',')})` : ''}${b.cache ? `^${b.cache}` : ''}`;
    }).join(' ') || '-'}`,
    `tools ${(h.tools ?? []).map((t) => `${t.name}:${String(t.sha).slice(0, 8)}`).join(' ') || '-'}`,
    ...(h.rest ? [`rest ${String(h.rest).slice(0, 8)}`] : []),
  ].join(', ');
  const messagesOf = (r) => (r.messages ?? []).map((m) => ({ role: m.role, digest: m.digest, cache: (m.blocks ?? []).map((b) => b.cache ?? null) }));
  const sentNote = (who, r) => {
    const head = r.head ? { ...r.head, stream: r.stream ?? null } : null;
    let note = '';
    if (head) {
      const key = sha8(head);
      if (!heads.has(key)) heads.set(key, headText(head));
      if (lastHead.get(who) !== key) { lastHead.set(who, key); note = `, head H:${key}`; }
    }
    return `${note}, body ${sha8(messagesOf(r))}`;
  };
  const lastCarried = new Map();
  const carriedBy = (r) => [...new Set((r.messages ?? []).flatMap((m) => (m.blocks ?? []).flatMap((b) => b.canaries ?? [])).map((c) => CANARY.exec(c)?.[1] ?? c))];
  const compileLine = (l, boot) => {
    const list = (l.messages ?? []).map((m) => item(m, l.agent));
    const marks = (l.messages ?? []).flatMap((m, i) => (m.marker ? [i + 1] : []));
    const keys = list.map(keyOf);
    const whose = `${l.agent} ${l.kind}`;
    const before = previous.get(whose);
    previous.set(whose, keys);
    let dropped = -1;
    if (before) {
      for (let n = 0; n <= before.length && dropped < 0; n++) {
        const kept = before.length - n;
        if (kept <= keys.length && (kept > 0 || n === 0) && before.slice(n).every((k, i) => keys[i] === k)) dropped = n;
      }
    }
    const added = dropped < 0 ? null : list.slice(before.length - dropped);
    const shown = dropped < 0 ? items(list) : [dropped ? `-${dropped}` : '', added.length ? `+ ${items(added)}` : ''].filter(Boolean).join(' ') || '= (as before)';
    const sent = l.kind === 'request' ? sentAs.get(`${l.agent}|${boot ?? null}|${l.seq}`) : null;
    if (sent) lastCarried.set(l.agent, carriedBy(sent));
    return `  compile${l.agent === primary ? '' : ` [${l.agent}]`}${l.kind === 'dry' ? ' dry' : ''} ${shown}${marks.length ? ` ^ ${marks.join(',')}` : ''}${sent ? sentNote(l.agent, sent) : ''}`;
  };

  const lines = [];
  const versions = (v) => Object.entries(v ?? {}).map(([k, x]) => `${k.replace('@animalabs/', '')} ${x}`).join(', ');
  lines.push(`# whole-host record ${header.configuration}`);
  lines.push(`# checkpoint ${header.release.tag}, ${header.from}: ${versions(header.release.versions)}`);
  lines.push(`# candidate: ${versions(header.candidate.versions)}`);

  const totals = { compiles: 0, dry: 0, refused: 0, other: 0, calls: 0, rounds: 0, written: 0, actions: 0 };
  const receipt = new Map();
  const known = new Map();
  const byStep = new Map();
  const at = (step) => { if (!byStep.has(step)) byStep.set(step, []); return byStep.get(step); };
  const steps = [];
  const seen = (step) => { if (!steps.includes(step)) steps.push(step); };
  const summariser = new Map((records ?? []).filter((r) => r.kind === 'summariser').map((r) => [r.id, r]));
  for (const e of log) {
    if (e.kind === 'send' && e.via === 'ipc' && e.command) { seen(e.step); at(e.step).push(`  action ${e.command}`); totals.actions++; }
    if (e.kind === 'request' && rounds.has(e.request?.id)) {
      const { agent, request } = rounds.get(e.request.id);
      seen(e.step);
      totals.rounds++;
      const before = new Set(lastCarried.get(agent) ?? []);
      const carried = carriedBy(request);
      lastCarried.set(agent, carried);
      const added = carried.filter((c) => !before.has(c));
      at(e.step).push(`  round${agent === primary ? '' : ` [${agent}]`} ${added.length ? `+ ${added.join(' ')}` : '='}${sentNote(agent, request)}`);
    }
    if (e.kind === 'request' && summariser.has(e.request?.id)) {
      const r = summariser.get(e.request.id);
      totals.calls++;
      seen(e.step);
      const carried = [...new Set(r.messages.flatMap((m) => m.blocks.flatMap((b) => b.canaries ?? [])).map((c) => CANARY.exec(c)?.[1] ?? c))];
      const words = (r.texts ?? []).map((t) => {
        const text = nameNonces(t);
        const marked = text.match(MARK);
        if (marked) return marked.map((m) => markName().get(m) ?? `S(${m.slice(4, -2)})`).join('+');
        const numbers = text.match(/\d+/g) ?? [];
        return `[${template('call', text.replace(/\d+/g, '#'))}]${numbers.length ? `(${numbers.join(',')})` : ''}`;
      });
      at(e.step).push(`  call ${[carried.length ? carried.join(' ') : '-', ...words].join(' ')} -> ${r.answer?.shape ?? 'none'}${sentNote('summariser', r)}`);
    }
    if (e.kind === 'compiles') {
      for (const [agent, st] of Object.entries(e.store ?? {})) {
        if (st.receiptHead) receipt.set(agent, st.receiptHead);
        for (const [id, , more] of st.messages ?? []) if (typeof more?.thinking === 'boolean') thinking.set(`${agent} ${id}`, more.thinking);
        for (const sm of st.summaries ?? []) {
          const was = known.get(`${agent} ${sm.id}`);
          const now = canonical({ level: sm.level, sources: sm.sources, content: sm.content, parent: sm.parent ?? null });
          known.set(`${agent} ${sm.id}`, now);
          if (was === now) continue;
          seen(e.step); at(e.step).push(`  wrote${agent === primary ? '' : ` [${agent}]`} ${summaryName(agent, sm.id, sm.level)} [${summaryTemplate(sm)}]`); totals.written++;
        }
        for (const id of st.removed ?? []) known.delete(`${agent} ${id}`);
        if (st.removed?.length) { seen(e.step); at(e.step).push(`  removed${agent === primary ? '' : ` [${agent}]`} ${st.removed.map((id) => leafName(agent, id)).join(' ')}`); }
      }
      for (const l of e.lines ?? []) {
        if (l.kind === 'other') { totals.other++; continue; }
        seen(e.step);
        if (l.outcome === 'refused' || l.error) {
          totals.refused++;
          const text = typeof l.error?.message === 'string' ? (blobs.get(l.error.message) ?? l.error.message) : '';
          at(e.step).push(`  compile${l.agent === primary ? '' : ` [${l.agent}]`} refused ${l.error?.class ?? 'unknown'}${text ? ` [${template(`error-${l.error?.class ?? 'unknown'}`, String(text).replace(/\d+/g, '#'))}]` : ''}`);
          continue;
        }
        if (l.kind === 'dry') totals.dry++; else totals.compiles++;
        at(e.step).push(compileLine(l, e.boot));
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
  lines.push(`end ${end?.ok ? 'ok' : 'failed'}`);
  for (const [agent, head] of [...receipt.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const changes = (head.changes ?? []).map(([leaf, change]) => (change ? `${leafName(agent, leaf)}/${String(change[0]).split(':')[0]}/${change[1]}/${change[2]}` : `${leafName(agent, leaf)}/removed`));
    lines.push(`receipt ${agent} #${head.sequence}${changes.length ? ` changes ${changes.join(' ')}` : ''}`);
  }
  lines.push(`totals ${canonical(totals)}`);
  const names = nameTemplates(templates, slug);
  const head = lines.findIndex((l) => !l.startsWith('#'));
  const block = ['templates', ...templates.map((t, i) => [names[i], t.shaped]).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, text]) => `T:${name} = ${text.split('\n').join('\n  ')}`)];
  const headBlock = heads.size ? ['heads', ...[...heads.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, text]) => `H:${key} = ${text}`)] : [];
  lines.splice(head < 0 ? lines.length : head, 0, ...block, ...headBlock);
  return `${lines.join('\n').replace(/\u0001(\d+)\u0001/g, (_, i) => `T:${names[i]}`)}\n`;
}

function nameTemplates(templates, slug) {
  const names = templates.map((t) => t.base);
  const groups = new Map();
  templates.forEach((t, i) => groups.set(t.base, [...(groups.get(t.base) ?? []), i]));
  const hashed = (i) => `${templates[i].base}-${createHash('sha256').update(templates[i].shaped).digest('hex').slice(0, 8)}`;
  for (const group of groups.values()) {
    if (group.length === 1) continue;
    for (const i of group) {
      const { role, words } = templates[i];
      if (!words) { names[i] = hashed(i); continue; }
      const shared = (j) => {
        const other = templates[j].words ?? [];
        let n = 0;
        while (n < words.length && n < other.length && slug(words[n]) === slug(other[n])) n++;
        return n;
      };
      const n = Math.max(3, ...group.filter((j) => j !== i).map((j) => shared(j) + 1));
      const name = `${slug(role)}-${slug(words.slice(0, n).join(' '))}`;
      names[i] = n <= words.length && name.length <= 96 ? name : hashed(i);
    }
    const count = new Map();
    for (const i of group) count.set(names[i], (count.get(names[i]) ?? 0) + 1);
    for (const i of group) if (count.get(names[i]) > 1) names[i] = hashed(i);
  }
  return names;
}
