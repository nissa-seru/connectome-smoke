import { createHash } from 'node:crypto';

/** JSON with every object's keys sorted, so equal values have equal text. */
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

/** A value's digest: the first 16 hex digits of the SHA-256 of its canonical JSON. A blob's id. */
export const digest = (value) => createHash('sha256').update(canonicalJSON(value)).digest('hex').slice(0, 16);

/**
 * One compiled message's provenance (`CompileProvenance.messages[i]`) as source strings, each message named by
 * `name` (the store id when left out):
 * - a raw body, `r:NAME`, or `r:NAME!WHAT` with WHAT the body's `missing` reasons joined by `+` when it isn't
 *   complete;
 * - a summary, `s:ID@LEVEL`, with `~` after it when the summary is partial;
 * - an injection, `i:NAMESPACE`; anything else, `o`.
 */
export function sourceStrings(sources, name = (id) => id) {
  if (!sources || typeof sources !== 'object') return ['o'];
  if (sources.kind === 'raw') {
    return sources.bodies.map((b) => (b.complete ? `r:${name(String(b.messageId))}` : `r:${name(String(b.messageId))}!${(b.missing ?? ['unknown']).join('+')}`));
  }
  if (sources.kind === 'summary') return sources.summaries.map((s) => `s:${s.id}@${s.level}${s.partial ? '~' : ''}`);
  if (sources.kind === 'injection') return [`i:${sources.namespace}`];
  return ['o'];
}

/**
 * A compiled message as sent, with its cache markers taken out and returned apart: `{ message, marker }`. The
 * message-level `cacheBreakpoint` and each block's `cache_control` are markers; `marker` is null when there are
 * none. An image block's base64 data is replaced by its SHA-256, so a trace holds no image bytes.
 */
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

/** `read()`'s value, or `{ unreadable: REASON }` when the reader is missing or throws. */
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

/**
 * Every summary the store holds, by id, with its sources, through `getSummariesInRange` and `getSummary`; level-0
 * sources by their trace names.
 */
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

/**
 * The invariants a compiled request breaks (the merged design's §4: coverage, budget, shape, pins, thinking,
 * beside-sources). A raw copy names a body stored as shards by its first shard's id, as compile provenance does, and
 * a summary names the shards it covers, so a body's shards can each be under a different summary. A stored body
 * sent in no message breaks coverage only where the configuration compresses.
 */
export function checkCompile(manager, budget, compiled, messages, { compresses: compressing = true } = {}) {
  const out = [];
  const stored = readable(() => manager.getAllMessages());
  if (isUnreadable(stored)) return out;
  const inOrder = [...stored].sort((a, b) => a.sequence - b.sequence);
  const bodyOf = new Map();
  const membersOf = new Map();
  const firstOfGroup = new Map();
  for (const m of inOrder) {
    const key = m.bodyGroupId ? (firstOfGroup.get(m.bodyGroupId) ?? (firstOfGroup.set(m.bodyGroupId, String(m.id)), String(m.id))) : String(m.id);
    bodyOf.set(String(m.id), key);
    membersOf.set(key, [...(membersOf.get(key) ?? []), m]);
  }
  const sequenceOf = new Map(stored.map((m) => [String(m.id), m.sequence]));
  const expanded = new Map();
  // The stored messages a summary covers, each shard by itself.
  const leaves = (summaryId) => {
    if (expanded.has(summaryId)) return expanded.get(summaryId);
    expanded.set(summaryId, []);
    const s = manager.getSummary(summaryId);
    const out2 = [];
    if (s) for (const src of s.sourceIds ?? []) out2.push(...(s.sourceLevel === 0 ? [String(src)] : leaves(String(src))));
    const set = [...new Set(out2)];
    expanded.set(summaryId, set);
    return set;
  };
  const blocks = (m) => (Array.isArray(m?.content) ? m.content : []);
  const textOf = (m) => blocks(m).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
  const sent = compiled.messages ?? [];

  // Coverage: each body raw or under a summary sent, and each stored message under no more than one summary sent; a
  // summary counts once however many messages carry it (a recalled memory is a question and its answer).
  const raw = new Map(), summariesSent = new Set();
  messages.forEach((m, i) => {
    for (const s of m.sources) {
      if (s.startsWith('r:')) {
        const [id, missing] = s.slice(2).split('!');
        const body = bodyOf.get(id) ?? id;
        const copy = raw.get(body) ?? { complete: true, text: '' };
        raw.set(body, { complete: copy.complete && missing === undefined, text: copy.text + textOf(sent[i]) });
      } else if (s.startsWith('s:')) summariesSent.add(s.slice(2).split('@')[0]);
    }
  });
  const bySummary = new Map();
  for (const id of summariesSent) for (const leaf of leaves(id)) bySummary.set(leaf, [...(bySummary.get(leaf) ?? []), id]);
  const uncovered = [], twice = [], beside = [];
  for (const [body, members] of membersOf) {
    if (compressing && !raw.has(body) && !members.some((m) => bySummary.has(String(m.id)))) uncovered.push(body);
    for (const m of members) {
      const under = bySummary.get(String(m.id)) ?? [];
      if (under.length > 1) twice.push(`${m.id} in ${under.join(', ')}`);
      const copy = raw.get(body);
      if (!copy || under.length === 0) continue;
      // A whole raw copy holds every shard; a partial one holds a summarised shard where it holds that shard's text.
      const own = textOf(m);
      if (copy.complete || (own.length > 0 && copy.text.includes(own))) beside.push(`${m.id} raw beside ${under.join(', ')}`);
    }
  }
  if (uncovered.length) out.push({ invariant: 'coverage', detail: `${uncovered.length} stored bodies in no message sent: ${uncovered.slice(0, 8).join(', ')}` });
  if (twice.length) out.push({ invariant: 'coverage', detail: `${twice.length} stored messages under two summaries sent: ${twice.slice(0, 4).join('; ')}` });
  if (beside.length) out.push({ invariant: 'beside-sources', detail: `${beside.length} stored messages sent raw beside a summary of them: ${beside.slice(0, 4).join('; ')}` });

  // Store order: what each message covers starts no earlier than what the message before it covers. A partial raw
  // copy of a body stored as shards starts at the first shard whose text it carries, not at the body's first shard.
  const firstCarried = (i, head) => {
    const sentText = textOf(sent[i]);
    const shards = (membersOf.get(bodyOf.get(head) ?? head) ?? []).filter((x) => textOf(x).length > 0 && sentText.includes(textOf(x)));
    return shards.length ? Math.min(...shards.map((x) => x.sequence)) : (sequenceOf.get(head) ?? Infinity);
  };
  // After a head-window reset the head starts at the newest topic transition message, which the strategy finds as
  // the library does at load (a 'Context Manager' message whose text opens "[Topic Transition]"), and goes first: a
  // request that opens with it holds the head, then the history from before it, in store order each.
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

  // Budget: a compile that enforces its budget sends no more than the input budget (what it was given less its
  // reserve) and the strategy's grace above it (`overBudgetGraceRatio`, 0.02 when unset), or refuses. The count is
  // the compile's own (`renderStats`, its select's stats, which context-manager reads before anything else selects),
  // since in a host another compile of the same manager can finish before this one's line is written; the manager's
  // getRenderStats, which the fixture read when it chose its own compile timing, only where a compile carries none.
  const configured = readable(() => manager.getStrategy().config ?? {});
  const config = isUnreadable(configured) ? {} : configured;
  const rendered = compiled?.renderStats ?? readable(() => manager.getRenderStats());
  const tokens = !isUnreadable(rendered) && rendered?.total?.tokens;
  const input = budget.maxTokens - (budget.reserveForResponse ?? 0);
  const grace = Math.max(0, config.overBudgetGraceRatio ?? 0.02);
  if (config.enforceBudget !== false && typeof tokens === 'number' && tokens > Math.floor(input * (1 + grace))) {
    out.push({ invariant: 'budget', detail: `${tokens} tokens against an input budget of ${input} and a grace of ${grace}` });
  }

  // Shape: a pair the store holds isn't sent parted. In the store a result answers the nearest call before it with its
  // id. A result of such a pair answers a call in the message before it or earlier in its own, and a call of such a
  // pair, but in the last message, is answered in the message after it or later in its own. A block the store itself
  // holds unpaired breaks nothing here. A block no raw source holds, such as a stub, is held to the same rule as a pair's.
  // A passthrough (a configuration that doesn't compress) sends every message from its window's start as stored, so a
  // result whose call lies before that start goes out as stored, and a pair the store holds apart goes out apart. Its
  // promise is narrower: no request opens with a result whose call the store holds before the request's start, and no
  // message of a pair inside the request's own span is left out of it.
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
  // The stored blocks of `type` with `id` among the bodies a sent message carries raw.
  const storedKeys = (i, type, id) => (messages[i]?.sources ?? []).filter((s) => s.startsWith('r:')).flatMap((s) => {
    const head = s.slice(2).split('!')[0];
    return (membersOf.get(bodyOf.get(head) ?? head) ?? []).flatMap((m) => blocks(m).flatMap((b, k) =>
      b?.type === type && (type === 'tool_use' ? b.id : b.toolUseId) === id ? [`${m.id}#${k}`] : []));
  });
  // The stored messages the request carries raw, and the span of the store they run over.
  const carried = new Set(messages.flatMap((m) => m.sources).filter((s) => s.startsWith('r:'))
    .flatMap((s) => { const head = s.slice(2).split('!')[0]; return (membersOf.get(bodyOf.get(head) ?? head) ?? []).map((m) => String(m.id)); }));
  const carriedSequences = [...carried].map((id) => sequenceOf.get(id)).filter((n) => typeof n === 'number');
  const spanStart = Math.min(...carriedSequences), spanEnd = Math.max(...carriedSequences);
  const messageOf = (key) => key.slice(0, key.lastIndexOf('#'));
  // Whether a pair's other block sits in a stored message inside the request's span that the request leaves out.
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

  // A call stays with its thinking: a stored body's thinking and its calls go out in one message, or not at all.
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

  // Pins: a summary sent over a pinned message is at a level the pin allows.
  const pins = readable(() => manager.listPins());
  if (!isUnreadable(pins)) {
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
  return dedupe(out);
}

const dedupe = (violations) => [...new Map(violations.map((v) => [`${v.invariant}|${v.detail}`, v])).values()];
