import { createHash } from 'node:crypto';
import { maskRunVarying } from './compare.mjs';
import { CANARY } from './standin.mjs';
import { checkBookkeeping, checkCompile, digest, isUnreadable, normalizeMessage, readSummaries, readable, sourceStrings } from './invariants.mjs';

const PASSTHROUGH = ['PassthroughStrategy', 'WindowedPassthroughStrategy'];

/** A library value as JSON holds it: Dates as their ISO text, Maps and Sets as arrays, undefined left out. */
export function plain(value) {
  if (isUnreadable(value)) return value;
  return JSON.parse(JSON.stringify(value, (_k, v) => (v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v] : v)) ?? 'null');
}

/** A plain value with every field whose name ends in `Ms` recorded as '*'. */
export function untimed(value) {
  if (Array.isArray(value)) return value.map(untimed);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /Ms$/.test(k) ? '*' : untimed(v)]));
}

/** An error's class: its `name` where it names one, else its constructor's. */
export function errorClass(error) {
  if (error && typeof error.name === 'string' && error.name !== 'Error') return error.name;
  return error?.constructor?.name ?? typeof error;
}

/** Whether the manager's strategy compresses: every strategy but the two passthroughs. */
export function compresses(manager) {
  const strategy = readable(() => manager.getStrategy());
  return !isUnreadable(strategy) && !!strategy && !PASSTHROUGH.includes(strategy.constructor?.name);
}

/**
 * Content-addressed values for a process's lines: `put` returns a value's digest, exactly as the host held it, and
 * `take` hands over each digest's value once, the first time it's taken after the value was put. Nothing is masked
 * here: an image ref's nonce is per process, and only the run's record writer, which sees every boot, can name the
 * nonces alike across runs and keep one boot's apart from another's.
 */
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

/**
 * What a compile that returned sent and kept, as the cm-fixture's recorder writes it (its trace.mjs `compiled`):
 * each message's sources from the compile's provenance and its content's digest, the system injections' digest, the
 * layout, the render stats (the compile's own, its select's, planVsActual and the calibration among them), and the
 * per-compile invariants run against the manager that compiled.
 */
export function compiledLine(manager, budget, compiled, blobs) {
  const prov = compiled?.provenance?.messages;
  const entries = (compiled?.messages ?? []).map((m, i) => {
    const { message, marker } = normalizeMessage(m);
    const entry = { sources: prov ? sourceStrings(prov[i]) : ['o'], content: blobs.put(message) };
    if (marker) entry.marker = plain(marker);
    return entry;
  });
  const violations = checkCompile(manager, budget, compiled, entries, { compresses: compresses(manager) });
  const layout = compiled?.provenance?.layout;
  return {
    outcome: 'compiled',
    messages: entries,
    system: blobs.put(compiled?.systemInjections ?? []),
    layout: !compiled?.provenance ? { unreadable: 'no provenance' } : layout ? untimed(plain({ ...layout, members: undefined })) : null,
    stats: untimed(plain(compiled?.renderStats ?? readable(() => manager.getRenderStats()))),
    violations,
  };
}

/** What a compile that threw left: the error's class, its message's digest, and its own fields. */
export function refusedLine(error, blobs) {
  const fields = {};
  for (const [k, v] of Object.entries(error ?? {})) if (k !== 'message' && k !== 'stack') fields[k] = v;
  return {
    outcome: 'refused',
    error: { class: errorClass(error), message: blobs.put(String(error?.message ?? error)), fields: plain(readable(() => plain(fields))) },
    violations: [],
  };
}

/** The reads a workload's checks and the step records take, none of which moves anything. */
export function stateOf(manager, ticksInFlight, blobs) {
  const summaries = readSummaries(manager);
  return {
    ready: plain(readable(() => manager.isReady())),
    waiting: plain(readable(() => manager.getWaitingWork())),
    pending: plain(readable(() => manager.getPendingWork())),
    progress: untimed(plain(readable(() => manager.getStrategy().getProgressSnapshot()))),
    maxLevel: plain(readable(() => manager.getMaxSummaryLevel())),
    branch: plain(readable(() => manager.currentBranch().name)),
    ticksInFlight,
    summaries: isUnreadable(summaries) ? summaries : [...summaries.values()].map((s) => ({ ...s, content: blobs.put(s.content ?? null) })),
    receiptHead: receiptHeadOf(manager),
    violations: isUnreadable(summaries) ? [] : checkBookkeeping(summaries),
  };
}

/**
 * The kv-unified receipt chain's head (context-manager's AutobiographicalStrategy keeps it as
 * `kvUnifiedReceipts.head`), null where the strategy keeps none: its sequence, its hash and its
 * parent's, membrane's request hash and the layout hash, and each change as [leaf id, its
 * representation's hash, level, the sequence it last changed at]. Its acceptance time and
 * submission id are left out: the one is wall time and the other is made fresh per send.
 */
export function receiptHeadOf(manager) {
  return plain(readable(() => {
    const head = manager.getStrategy().kvUnifiedReceipts?.head ?? null;
    if (!head) return null;
    return {
      sequence: head.sequence,
      receiptHash: head.receiptHash,
      parentReceiptHash: head.parentReceiptHash,
      requestHash: head.requestHash,
      layoutHash: head.layoutHash,
      changes: (head.changes ?? []).map((c) => [String(c.leafId), c.value ? [c.value.repHash, c.value.level, c.value.lastChangedSeq] : null]),
    };
  }));
}

/**
 * What changed in an agent's store since `seen` (the last call's `seen`, or none): the stored
 * messages added, each as [id, its canaries]; the summaries added or changed, each with its level,
 * source level, sources, parent and its content's digest (the content in `blobs`), and those
 * removed, by id; and the receipt head where it moved. `out` holds only what changed, and `changed`
 * says whether anything did.
 */
export function storeDelta(manager, seen = { messages: new Set(), summaries: new Map(), head: 'null' }, blobs) {
  const out = {};
  const next = { messages: new Set(seen.messages), summaries: new Map(), head: seen.head };
  const messages = readable(() => manager.getAllMessages());
  if (!isUnreadable(messages)) {
    const added = [];
    for (const m of messages) {
      const id = String(m.id);
      next.messages.add(id);
      if (!seen.messages.has(id)) added.push([id, canariesOf(m.content)]);
    }
    if (added.length) out.messages = added;
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
    if (added.length) out.summaries = added;
    if (removed.length) out.removed = removed;
  } else out.summaries = summaries;
  const head = receiptHeadOf(manager);
  const headKey = JSON.stringify(head);
  if (headKey !== seen.head) { out.receiptHead = head; next.head = headKey; }
  return { out, seen: next, changed: Object.keys(out).length > 0 };
}

/**
 * The stored messages without their text: ids, order, participant, block kinds and tool ids, text sizes and digests,
 * the canaries the lane writes (standin.mjs `CANARY`) in the order the texts carry them, shards, metadata.
 */
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

function canariesOf(content) {
  const texts = [];
  const walk = (b) => {
    if (typeof b === 'string') { texts.push(b); return; }
    if (!b || typeof b !== 'object') return;
    if (typeof b.text === 'string') texts.push(b.text);
    if (b.type === 'tool_result') { if (Array.isArray(b.content)) b.content.forEach(walk); else texts.push(String(b.content ?? '')); }
  };
  (Array.isArray(content) ? content : []).forEach(walk);
  return texts.flatMap((t) => t.match(CANARY) ?? []);
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
