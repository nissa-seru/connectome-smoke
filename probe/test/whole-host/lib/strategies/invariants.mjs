import { createHash } from 'node:crypto';

export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJSON(v))).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`no JSON for ${value}`);
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error(`no JSON for a ${typeof value}`);
  }
  return JSON.stringify(value);
}

export const digest = (value) => createHash('sha256').update(canonicalJSON(value)).digest('hex').slice(0, 16);

export function sourceStrings(sources, name = (id) => id) {
  if (!sources || typeof sources !== 'object') return ['o'];
  if (sources.kind === 'raw') {
    return sources.bodies.map((b) => (b.complete ? `r:${name(String(b.messageId))}` : `r:${name(String(b.messageId))}!${(b.missing ?? ['unknown']).join('+')}`));
  }
  if (sources.kind === 'summary') return sources.summaries.map((s) => `s:${s.id}@${s.level}${s.partial ? '~' : ''}`);
  if (sources.kind === 'injection') return [`i:${sources.namespace}`];
  return ['o'];
}

export function normalizeMessage(message) {
  const { cacheBreakpoint, ...rest } = message;
  const blockMarkers = [];
  const content = (Array.isArray(rest.content) ? rest.content : []).map((block, i) => {
    if (!block || typeof block !== 'object') return block;
    const { cache_control: cc, ...b } = block;
    if (cc !== undefined) blockMarkers.push([i, cc]);
    if (b.type === 'image' && b.source && typeof b.source.data === 'string') {
      return { ...b, source: { ...b.source, data: undefined, sha256: createHash('sha256').update(b.source.data).digest('hex') } };
    }
    return b;
  });
  const marker = cacheBreakpoint === undefined && blockMarkers.length === 0 ? null : { message: cacheBreakpoint ?? null, blocks: blockMarkers };
  return { message: { ...rest, content }, marker };
}

export function readable(read) {
  try {
    if (typeof read !== 'function') return { unreadable: 'no such reader' };
    const value = read();
    return value === undefined ? { unreadable: 'returned undefined' } : value;
  } catch (err) {
    return { unreadable: String(err?.message ?? err).slice(0, 200) };
  }
}

export const isUnreadable = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.unreadable === 'string';

export function readSummaries(manager, name = (id) => String(id)) {
  const listed = readable(() => manager.getSummariesInRange({}));
  if (isUnreadable(listed)) return listed;
  const out = new Map();
  for (const t of listed) {
    const s = readable(() => manager.getSummary(t.id));
    if (isUnreadable(s) || s === null) return { unreadable: `getSummary(${t.id}) ${isUnreadable(s) ? s.unreadable : 'is null though listed'}` };
    out.set(String(s.id), { id: String(s.id), level: s.level, sourceLevel: s.sourceLevel, sources: (s.sourceIds ?? []).map((x) => (s.sourceLevel === 0 ? name(x) : String(x))), parent: s.parentId ?? null, tokens: s.tokens, content: s.content });
  }
  return out;
}

// agent-framework's Subconscious reader merges the residents' shared slot into its view read-only, so its compiles
// send messages its own slot doesn't hold; a view member is read from the registered agent whose slot holds it.
function readCompile(manager, compiled, messages, elsewhere) {
  const own = readable(() => manager.getAllMessages());
  if (isUnreadable(own)) return own;
  const ownIds = new Set(own.map((m) => String(m.id)));
  const layout = compiled?.provenance?.layout;
  const sentIds = messages.flatMap((m) => m.sources).filter((s) => s.startsWith('r:')).map((s) => s.slice(2).split('!')[0]);
  const members = [...new Set([...(layout?.memberIds ?? []).map(String), ...sentIds])].filter((id) => !ownIds.has(id));
  const { found = [], unfound = members } = members.length && elsewhere ? elsewhere(members) : {};
  const stored = [...own, ...found];
  const laidOut = Array.isArray(layout?.memberIds) && Array.isArray(layout?.units);
  const failed = [
    ...(laidOut ? [] : ['the compile gave no layout, so its view\'s members beyond its own slot weren\'t read']),
    ...(unfound.length ? [`view members no registered agent's slot holds: ${unfound.slice(0, 8).join(', ')}`] : []),
  ];
  const layoutRaw = new Set();
  if (laidOut) {
    let at = 0;
    for (const u of layout.units) {
      if (u.k === 'r') layoutRaw.add(String(layout.memberIds[at++]));
      else at += u.n ?? 0;
    }
  }
  const inOrder = [...stored].sort((a, b) => a.sequence - b.sequence);
  const bodyOf = new Map();
  const membersOf = new Map();
  // context-manager's bodies (body-runs.ts continuesBody): a group id names its content, so two
  // ingestions of one text share it, and a message continues the body before it only with the same
  // group id at a higher shard index.
  let key = null;
  inOrder.forEach((m, i) => {
    const prev = inOrder[i - 1];
    const continues = !!prev?.bodyGroupId && prev.bodyGroupId === m.bodyGroupId && (m.shardIndex ?? 0) > (prev.shardIndex ?? 0);
    if (!continues) key = String(m.id);
    bodyOf.set(String(m.id), key);
    membersOf.set(key, [...(membersOf.get(key) ?? []), m]);
  });
  const sequenceOf = new Map(stored.map((m) => [String(m.id), m.sequence]));
  const expanded = new Map();
  const leaves = (summaryId) => {
    if (expanded.has(summaryId)) return expanded.get(summaryId);
    expanded.set(summaryId, []);
    const s = readable(() => manager.getSummary(summaryId));
    if (isUnreadable(s) || s === null) {
      failed.push(`getSummary(${summaryId}): ${isUnreadable(s) ? s.unreadable : 'no such summary'}`);
      return [];
    }
    const out2 = [];
    if (s) for (const src of s.sourceIds ?? []) out2.push(...(s.sourceLevel === 0 ? [String(src)] : leaves(String(src))));
    const set = [...new Set(out2)];
    expanded.set(summaryId, set);
    return set;
  };
  const blocks = (m) => (Array.isArray(m?.content) ? m.content : []);
  const textOf = (m) => blocks(m).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
  const sent = compiled.messages ?? [];

  // A summary counts once however many messages carry it: the host sends a recalled memory as a question and its answer.
  const raw = new Map(), summariesSent = new Set();
  messages.forEach((m, i) => {
    for (const s of m.sources) {
      if (s.startsWith('r:')) {
        const [id, missing] = s.slice(2).split('!');
        const body = bodyOf.get(id) ?? id;
        const copy = raw.get(body) ?? { everyShard: false, text: '' };
        raw.set(body, { everyShard: copy.everyShard || !(missing ?? '').split('+').includes('shards'), text: copy.text + textOf(sent[i]) });
      } else if (s.startsWith('s:')) summariesSent.add(s.slice(2).split('@')[0]);
    }
  });
  const bySummary = new Map();
  for (const id of summariesSent) for (const leaf of leaves(id)) bySummary.set(leaf, [...(bySummary.get(leaf) ?? []), id]);
  // A raw copy of a body holds a shard when it carries every shard (context-manager marks one that
  // doesn't `!shards`; `!content` alone is every shard, altered), or when it carries that shard's text
  // (a shard with no text, by any raw copy of its body), among the shards context-manager's layout names raw.
  const partlyHeld = new Set();
  for (const [body, copy] of raw) {
    if (copy.everyShard) continue;
    let from = 0;
    const shards = [...(membersOf.get(body) ?? [])].sort((x, y) => (x.shardIndex ?? 0) - (y.shardIndex ?? 0));
    const named = shards.filter((m) => layoutRaw.has(String(m.id)));
    for (const m of named.length ? named : shards) {
      const text = textOf(m);
      const at = text.length === 0 ? from : copy.text.indexOf(text, from);
      if (at < 0) continue;
      partlyHeld.add(String(m.id));
      from = at + text.length;
    }
  }
  const held = (body, m) => {
    const copy = raw.get(body);
    return !!copy && (copy.everyShard || partlyHeld.has(String(m.id)));
  };
  return { stored, inOrder, bodyOf, membersOf, sequenceOf, leaves, blocks, textOf, sent, raw, bySummary, held, failed };
}

export function checkCompile(manager, budget, compiled, messages, { compresses = true, elsewhere } = {}) {
  const out = [];
  const read = readCompile(manager, compiled, messages, elsewhere);
  if (isUnreadable(read)) return [{ invariant: 'unreadable', detail: `getAllMessages: ${read.unreadable}; no invariant was judged` }];
  const { stored, inOrder, bodyOf, membersOf, sequenceOf, leaves, blocks, textOf, sent, raw, bySummary, held, failed } = read;
  if (isUnreadable(compresses)) out.push({ invariant: 'unreadable', detail: `getStrategy: ${compresses.unreadable}; coverage wasn't judged` });
  const compressing = compresses === true;
  const uncovered = [], twice = [], beside = [];
  for (const [body, members] of membersOf) {
    const lost = compressing ? members.filter((m) => !bySummary.has(String(m.id)) && !held(body, m)) : [];
    if (lost.length === members.length) uncovered.push(body);
    else if (lost.length) uncovered.push(`${body} (shards ${lost.map((m) => m.id).join(', ')})`);
    for (const m of members) {
      const under = bySummary.get(String(m.id)) ?? [];
      if (under.length > 1) twice.push(`${m.id} in ${under.join(', ')}`);
      if (under.length === 0 || !held(body, m)) continue;
      beside.push(`${m.id} raw beside ${under.join(', ')}`);
    }
  }
  if (uncovered.length) out.push({ invariant: 'coverage', detail: `${uncovered.length} stored bodies in no message sent: ${uncovered.slice(0, 8).join(', ')}` });
  if (twice.length) out.push({ invariant: 'coverage', detail: `${twice.length} stored messages under two summaries sent: ${twice.slice(0, 4).join('; ')}` });
  if (beside.length) out.push({ invariant: 'beside-sources', detail: `${beside.length} stored messages sent raw beside a summary of them: ${beside.slice(0, 4).join('; ')}` });

  const firstCarried = (i, head) => {
    const sentText = textOf(sent[i]);
    const shards = (membersOf.get(bodyOf.get(head) ?? head) ?? []).filter((x) => textOf(x).length > 0 && sentText.includes(textOf(x)));
    return shards.length ? Math.min(...shards.map((x) => x.sequence)) : (sequenceOf.get(head) ?? Infinity);
  };
  // After a head-window reset context-manager starts the head at the newest topic transition message (a 'Context
  // Manager' message opening "[Topic Transition]") and sends it first, then the history from before it.
  const transitions = inOrder.filter((x) => x.participant === 'Context Manager' && blocks(x).some((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.startsWith('[Topic Transition]')));
  const headStart = transitions.length ? transitions.at(-1).sequence : null;
  let inHead = false;
  let last = -Infinity, lastAt = -1;
  messages.forEach((m, i) => {
    let first = Infinity;
    for (const s of m.sources) {
      if (s.startsWith('r:')) {
        const [head, missing] = s.slice(2).split('!');
        first = Math.min(first, missing === undefined ? (sequenceOf.get(head) ?? Infinity) : firstCarried(i, head));
      }
      else if (s.startsWith('s:')) for (const b of leaves(s.slice(2).split('@')[0])) first = Math.min(first, sequenceOf.get(b) ?? Infinity);
    }
    if (first === Infinity) return;
    if (lastAt === -1 && first === headStart) inHead = true;
    if (inHead && first < headStart) { inHead = false; last = -Infinity; }
    if (first < last) out.push({ invariant: 'coverage', detail: `message ${i} covers from sequence ${first}, before message ${lastAt}'s ${last}` });
    if (first >= last) { last = first; lastAt = i; }
  });

  // context-manager's grace is 0.02 when `overBudgetGraceRatio` is unset. The count is the compile's own
  // `renderStats`, since in a host another compile of the same manager can finish before this line is written.
  const configured = readable(() => manager.getStrategy().config ?? {});
  if (isUnreadable(configured)) out.push({ invariant: 'unreadable', detail: `getStrategy: ${configured.unreadable}; budget wasn't judged` });
  const config = isUnreadable(configured) ? {} : configured;
  const rendered = compiled?.renderStats ?? readable(() => manager.getRenderStats());
  if (isUnreadable(rendered)) out.push({ invariant: 'unreadable', detail: `getRenderStats: ${rendered.unreadable}; budget wasn't judged` });
  const tokens = !isUnreadable(configured) && !isUnreadable(rendered) && rendered?.total?.tokens;
  const input = budget.maxTokens - (budget.reserveForResponse ?? 0);
  const grace = Math.max(0, config.overBudgetGraceRatio ?? 0.02);
  if (config.enforceBudget !== false && typeof tokens === 'number' && tokens > Math.floor(input * (1 + grace))) {
    out.push({ invariant: 'budget', detail: `${tokens} tokens against an input budget of ${input} and a grace of ${grace}` });
  }

  // A passthrough strategy sends every message from its window's start as stored, so a pair the store holds apart goes
  // out apart: it only promises not to open with a result whose call lies before the request's start, and not to leave
  // out a message of a pair inside the request's own span.
  const callOf = new Map(), answered = new Map(), lastCall = new Map();
  for (const m of inOrder) {
    blocks(m).forEach((b, k) => {
      if (b?.type === 'tool_use') lastCall.set(b.id, `${m.id}#${k}`);
      else if (b?.type === 'tool_result' && lastCall.has(b.toolUseId)) {
        callOf.set(`${m.id}#${k}`, lastCall.get(b.toolUseId));
        answered.set(lastCall.get(b.toolUseId), `${m.id}#${k}`);
      }
    });
  }
  const storedKeys = (i, type, id) => (messages[i]?.sources ?? []).filter((s) => s.startsWith('r:')).flatMap((s) => {
    const head = s.slice(2).split('!')[0];
    return (membersOf.get(bodyOf.get(head) ?? head) ?? []).flatMap((m) => blocks(m).flatMap((b, k) =>
      b?.type === type && (type === 'tool_use' ? b.id : b.toolUseId) === id ? [`${m.id}#${k}`] : []));
  });
  const carried = new Set(messages.flatMap((m) => m.sources).filter((s) => s.startsWith('r:'))
    .flatMap((s) => { const head = s.slice(2).split('!')[0]; return (membersOf.get(bodyOf.get(head) ?? head) ?? []).map((m) => String(m.id)); }));
  const carriedSequences = [...carried].map((id) => sequenceOf.get(id)).filter((n) => typeof n === 'number');
  const spanStart = Math.min(...carriedSequences), spanEnd = Math.max(...carriedSequences);
  const messageOf = (key) => key.slice(0, key.lastIndexOf('#'));
  const leftOut = (key) => {
    const at = sequenceOf.get(messageOf(key));
    return typeof at === 'number' && at >= spanStart && at <= spanEnd && !carried.has(messageOf(key));
  };
  const beforeStart = (key) => (sequenceOf.get(messageOf(key)) ?? Infinity) < spanStart;
  sent.forEach((m, i) => {
    blocks(m).forEach((b, j) => {
      if (b?.type === 'tool_result' && ![...blocks(sent[i - 1]), ...blocks(m).slice(0, j)].some((c) => c?.type === 'tool_use' && c.id === b.toolUseId)) {
        const keys = storedKeys(i, 'tool_result', b.toolUseId);
        const parted = compressing
          ? keys.some((key) => callOf.has(key))
          : keys.some((key) => callOf.has(key) && (leftOut(callOf.get(key)) || (i === 0 && beforeStart(callOf.get(key)))));
        if (keys.length === 0 || parted) {
          out.push({ invariant: 'shape', detail: `message ${i}: result ${b.toolUseId} answers no call in the message before it` });
        }
      }
      if (b?.type === 'tool_use' && i < sent.length - 1 && ![...blocks(m).slice(j + 1), ...blocks(sent[i + 1])].some((c) => c?.type === 'tool_result' && c.toolUseId === b.id)) {
        const keys = storedKeys(i, 'tool_use', b.id);
        const parted = compressing ? keys.some((key) => answered.has(key)) : keys.some((key) => answered.has(key) && leftOut(answered.get(key)));
        if (keys.length === 0 || parted) {
          out.push({ invariant: 'shape', detail: `message ${i}: call ${b.id} unanswered in the message after it` });
        }
      }
    });
  });

  const storedById = new Map(stored.map((m) => [String(m.id), m]));
  sent.forEach((m, i) => {
    const hasThinking = blocks(m).some((b) => b?.type === 'thinking' || b?.type === 'redacted_thinking');
    for (const s of messages[i]?.sources ?? []) {
      if (!s.startsWith('r:')) continue;
      const body = storedById.get(s.slice(2).split('!')[0]);
      const callIds = blocks(body).filter((b) => b?.type === 'tool_use').map((b) => b.id);
      if (!hasThinking || callIds.length === 0) continue;
      const missing = callIds.filter((id) => !blocks(m).some((b) => b?.type === 'tool_use' && b.id === id));
      if (missing.length) out.push({ invariant: 'thinking', detail: `message ${i} carries body ${body.id}'s thinking without its calls ${missing.join(', ')}` });
    }
  });

  const pins = readable(() => manager.listPins());
  if (isUnreadable(pins)) out.push({ invariant: 'unreadable', detail: `listPins: ${pins.unreadable}; pins weren't judged` });
  else {
    for (const p of pins) {
      const from = sequenceOf.get(String(p.firstMessageId)), to = sequenceOf.get(String(p.lastMessageId));
      if (from === undefined || to === undefined) continue;
      const allowed = p.level ?? p.maxLevel ?? 0;
      for (const m of messages) for (const s of m.sources) {
        if (!s.startsWith('s:')) continue;
        const [id, lvl] = s.slice(2).replace('~', '').split('@');
        if (Number(lvl) <= allowed) continue;
        const inside = leaves(id).find((b) => { const q = sequenceOf.get(b); return q !== undefined && q >= from && q <= to; });
        if (inside) out.push({ invariant: 'pins', detail: `summary ${id} at L${lvl} covers ${inside}, inside pin ${p.id} allowing L${allowed}` });
      }
    }
  }
  for (const f of failed) out.push({ invariant: 'unreadable', detail: `${f}; what depends on it wasn't judged` });
  return dedupe(out);
}

const dedupe = (violations) => [...new Map(violations.map((v) => [`${v.invariant}|${v.detail}`, v])).values()];
