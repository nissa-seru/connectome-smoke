import { createHash } from 'node:crypto';
import { maskRunVarying } from './compare.mjs';
import { canariesOf, namingCanaries } from './names.mjs';
import { checkCompile, digest, isUnreadable, normalizeMessage, readSummaries, readable, sourceStrings } from './invariants.mjs';

const PASSTHROUGH = ['PassthroughStrategy', 'WindowedPassthroughStrategy'];

export function plain(value) {
  if (isUnreadable(value)) return value;
  return JSON.parse(JSON.stringify(value, (_k, v) => (v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v] : v)) ?? 'null');
}

export function untimed(value) {
  if (Array.isArray(value)) return value.map(untimed);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /Ms$/.test(k) ? '*' : untimed(v)]));
}

export function errorClass(error) {
  if (error && typeof error.name === 'string' && error.name !== 'Error') return error.name;
  return error?.constructor?.name ?? typeof error;
}

export function compresses(manager) {
  const strategy = readable(() => manager.getStrategy());
  return isUnreadable(strategy) ? strategy : !!strategy && !PASSTHROUGH.includes(strategy.constructor?.name);
}

// Nothing is masked here: agent-framework 0.32.0 mints its image-ref nonce per ledger, and a ledger lives as long as
// its process, so only the record writer, which sees every boot, can name the nonces alike across runs.
export function blobStore() {
  const sent = new Set();
  let fresh = new Map();
  return {
    put(value) {
      const held = plain(value);
      const id = digest(held);
      if (!sent.has(id) && !fresh.has(id)) fresh.set(id, held);
      return id;
    },
    take() {
      const out = Object.fromEntries(fresh);
      for (const id of fresh.keys()) sent.add(id);
      fresh = new Map();
      return out;
    },
  };
}

// context-manager 0.24.0 gives a compile's provenance a `messages` list parallel to its messages, each of these kinds
// (CompiledMessageSources). A compile with no provenance at all has no layout either, which check 11 already flags.
const SOURCE_KINDS = new Set(['raw', 'summary', 'injection', 'other']);

function unreadSources(compiled) {
  const sent = compiled?.messages ?? [];
  if (!compiled?.provenance || sent.length === 0) return null;
  const list = compiled.provenance.messages;
  if (!Array.isArray(list)) return `the compile's provenance gives no messages list, so its ${sent.length} messages' sources couldn't be read`;
  if (list.length !== sent.length) return `the compile's provenance gives sources for ${list.length} of its ${sent.length} messages`;
  const odd = [...new Set(list.filter((s) => !SOURCE_KINDS.has(s?.kind)).map((s) => String(s?.kind)))];
  return odd.length ? `the compile's provenance gives sources of a kind context-manager 0.24.0 doesn't: ${odd.join(', ')}` : null;
}

export function compiledLine(manager, budget, compiled, blobs, elsewhere) {
  const prov = compiled?.provenance?.messages;
  const entries = (compiled?.messages ?? []).map((m, i) => {
    const { message, marker } = normalizeMessage(m);
    const entry = { sources: prov ? sourceStrings(prov[i]) : ['o'], content: blobs.put(message) };
    if (marker) entry.marker = plain(marker);
    return entry;
  });
  let slots = [];
  const reading = elsewhere && ((ids) => { const r = elsewhere(ids); slots = r.from ?? []; return r; });
  const violations = checkCompile(manager, budget, compiled, entries, { compresses: compresses(manager), elsewhere: reading });
  const sourcesUnread = unreadSources(compiled);
  if (sourcesUnread) violations.push({ invariant: 'unreadable', detail: sourcesUnread });
  const layout = compiled?.provenance?.layout;
  return {
    outcome: 'compiled',
    messages: entries,
    system: blobs.put(compiled?.systemInjections ?? []),
    layout: !compiled?.provenance ? { unreadable: 'no provenance' } : layout ? untimed(plain({ ...layout, members: undefined })) : null,
    stats: untimed(plain(compiled?.renderStats ?? null)),
    violations,
    ...(violations.unjudged?.length ? { unjudged: violations.unjudged } : {}),
    ...(slots.length ? { slots } : {}),
  };
}

export function refusedLine(error, blobs) {
  const fields = {};
  for (const [k, v] of Object.entries(error ?? {})) if (k !== 'message' && k !== 'stack') fields[k] = v;
  return {
    outcome: 'refused',
    error: { class: errorClass(error), message: blobs.put(String(error?.message ?? error)), fields: plain(readable(() => plain(fields))) },
    violations: [],
  };
}

export function stateOf(manager) {
  return { maxLevel: plain(readable(() => manager.getMaxSummaryLevel())) };
}

// context-manager 0.24.0 keeps the kv-unified receipt chain of a strategy with `beginKvUnifiedSubmission` in its
// private `kvUnifiedReceipts`, and the chain's head at `.head`. agent-framework 0.32.0 gives it each send's acceptance
// time as wall time and a submission id made per send with the wall time in it, so both are left out.
export function receiptHeadOf(manager) {
  return plain(readable(() => {
    const strategy = manager.getStrategy();
    const chain = strategy?.kvUnifiedReceipts;
    if (chain == null) {
      if (typeof strategy?.beginKvUnifiedSubmission === 'function') throw new Error('the strategy takes kv-unified submissions but has no kvUnifiedReceipts to read its receipt chain from');
      return null;
    }
    if (!('head' in chain)) throw new Error('kvUnifiedReceipts has no head');
    const head = chain.head;
    if (!head) return null;
    if (typeof head.sequence !== 'number') throw new Error('the receipt head has no numeric sequence');
    if (!Array.isArray(head.changes)) throw new Error('the receipt head has no changes list');
    if (!head.changes.every(readableChange)) throw new Error('a receipt change lacks its leafId or value, or its value a string repHash and a numeric level and lastChangedSeq');
    return {
      sequence: head.sequence,
      receiptHash: head.receiptHash,
      parentReceiptHash: head.parentReceiptHash,
      requestHash: head.requestHash,
      layoutHash: head.layoutHash,
      changes: head.changes.map((c) => [String(c.leafId), c.value ? [c.value.repHash, c.value.level, c.value.lastChangedSeq] : null]),
    };
  }));
}

// context-manager 0.24.0's PresentationDelta: a leafId, and a value that is null for a leaf removed, or a PresentedLeaf.
function readableChange(change) {
  if (!change || typeof change !== 'object' || change.leafId == null || !('value' in change)) return false;
  const v = change.value;
  return v === null || (typeof v?.repHash === 'string' && typeof v.level === 'number' && typeof v.lastChangedSeq === 'number');
}

export function storeDelta(manager, seen, blobs) {
  const out = {};
  if (seen === undefined) {
    seen = { messages: new Map(), summaries: new Map(), head: 'null', quarantine: 'null' };
    out.whole = true;
  }
  const next = { messages: new Map(seen.messages), summaries: new Map(), head: seen.head, quarantine: seen.quarantine };
  const messages = readable(() => manager.getAllMessages());
  if (!isUnreadable(messages)) {
    next.messages = new Map();
    const added = [];
    for (const m of messages) {
      const id = String(m.id);
      const thinking = (Array.isArray(m.content) ? m.content : []).some((b) => b?.type === 'thinking' || b?.type === 'redacted_thinking');
      const canaries = namingCanaries(m.content);
      const before = seen.messages.get(id);
      next.messages.set(id, { thinking, canaries: JSON.stringify(canaries) });
      if (before === undefined) added.push(thinking ? [id, canaries, { thinking }] : [id, canaries]);
      else if (before.thinking !== thinking) added.push([id, canaries, { thinking }]);
      else if (before.canaries !== JSON.stringify(canaries)) added.push(thinking ? [id, canaries, { thinking }] : [id, canaries]);
    }
    if (added.length || out.whole) out.messages = added;
    const gone = [...seen.messages.keys()].filter((id) => !next.messages.has(id));
    if (gone.length) out.removedMessages = gone;
  } else out.messages = messages;
  const summaries = readSummaries(manager);
  if (!isUnreadable(summaries)) {
    const added = [];
    for (const s of summaries.values()) {
      const entry = { id: s.id, level: s.level, sourceLevel: s.sourceLevel, sources: s.sources, parent: s.parent, content: blobs.put(s.content ?? null) };
      const key = JSON.stringify(entry);
      next.summaries.set(s.id, key);
      if (seen.summaries.get(s.id) !== key) added.push(entry);
    }
    const removed = [...seen.summaries.keys()].filter((id) => !summaries.has(id));
    if (added.length || out.whole) out.summaries = added;
    if (removed.length) out.removed = removed;
  } else {
    out.summaries = summaries;
    next.summaries = new Map(seen.summaries);
  }
  const head = receiptHeadOf(manager);
  const headKey = JSON.stringify(head);
  if (headKey !== seen.head) { out.receiptHead = head; next.head = headKey; }
  const quarantine = quarantineOf(manager);
  const quarantineKey = JSON.stringify(quarantine);
  if (quarantineKey !== seen.quarantine) { out.quarantine = quarantine; next.quarantine = quarantineKey; }
  const unread = [messages, summaries, head, quarantine].some(isUnreadable);
  return { out, seen: next, changed: Object.keys(out).length > 0, unread };
}

// context-manager 0.24.0's AutobiographicalStrategy reports its quarantines publicly: compression's as the spans it
// holds out, each named by its chunk's `chunkSourceHash`, and merges' as records, each named by its `key`. A strategy
// without them, such as a passthrough, has none to report.
function quarantineOf(manager) {
  const strategy = readable(() => manager.getStrategy());
  if (isUnreadable(strategy)) return strategy;
  if (typeof strategy?.getMergeQuarantineStatus !== 'function') {
    const compressing = compresses(manager);
    if (isUnreadable(compressing)) return compressing;
    return compressing ? { unreadable: 'the strategy compresses but has no getMergeQuarantineStatus to read its quarantines from' } : null;
  }
  return plain(readable(() => {
    const compression = strategy.getCompressionQuarantineStatus();
    const merge = strategy.getMergeQuarantineStatus();
    return {
      compression: compression.unreadable ? null : identities(compression.spans, 'chunkSourceHash', 'a compression quarantine span'),
      merge: identities(merge.records, 'key', 'a merge quarantine record'),
    };
  }));
}

function identities(items, field, what) {
  return items.map((item) => {
    if (typeof item?.[field] !== 'string') throw new Error(`${what} has no ${field}`);
    return item[field];
  }).sort();
}

export function messagesOf(manager) {
  return plain(readable(() => manager.getAllMessages().map((m) => ({
    id: String(m.id),
    sequence: m.sequence,
    participant: String(m.participant),
    blocks: (Array.isArray(m.content) ? m.content : []).map(blockShape),
    canaries: canariesOf(m.content),
    ...(m.bodyGroupId ? { bodyGroupId: m.bodyGroupId, shardIndex: m.shardIndex ?? 0 } : {}),
    ...(m.metadata !== undefined ? { metadata: maskRunVarying(m.metadata) } : {}),
  }))));
}


function blockShape(b) {
  if (!b || typeof b !== 'object') return { type: typeof b };
  const out = { type: b.type };
  if (b.type === 'tool_use') { out.id = b.id; out.name = b.name; }
  if (b.type === 'tool_result') { out.toolUseId = b.toolUseId ?? b.tool_use_id; out.content = Array.isArray(b.content) ? b.content.map(blockShape) : textShape(String(b.content ?? '')); }
  if (typeof b.text === 'string') Object.assign(out, textShape(b.text));
  if (typeof b.thinking === 'string') Object.assign(out, textShape(b.thinking));
  return out;
}

function textShape(text) {
  const masked = maskRunVarying(text);
  return { chars: masked.length, sha256: textDigest(masked) };
}

const textDigest = (text) => (typeof text === 'string' ? createHash('sha256').update(text).digest('hex').slice(0, 16) : null);
