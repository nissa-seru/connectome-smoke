import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { format } from 'node:util';
import {
  SCHEMA, ACTION_OPS, INVARIANTS, canonicalJSON, digest, eventProblem, normalizeMessage, sourceStrings, logTag,
  maskTiming, readable, isUnreadable, addedName,
} from './events.mjs';
import { compresses } from './configs.mjs';

const CONSOLE = ['log', 'info', 'warn', 'error', 'debug'];

/** A library value as JSON holds it: Dates as their ISO text, Maps and Sets as arrays, undefined left out. */
function plain(value) {
  if (isUnreadable(value)) return value;
  return JSON.parse(JSON.stringify(value, (_k, v) => (v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v] : v)) ?? 'null');
}

/** A plain value with every field whose name ends in `Ms` recorded as '*'. */
function untimed(value) {
  if (Array.isArray(value)) return value.map(untimed);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /Ms$/.test(k) ? '*' : untimed(v)]));
}

/**
 * The recorder the driver calls while one run goes (events.mjs, RECORDER_CALLS), writing the run's trace to `file`.
 * `header` is the `run` event's fields but `kind` and `schema`.
 */
export async function openRecorder({ file, header }) {
  return new Recorder(file, header);
}

class Recorder {
  constructor(file, header) {
    mkdirSync(dirname(file), { recursive: true });
    this.fd = openSync(file, 'w');
    this.blobsWritten = new Set();
    this.stepNo = 0;
    this.ordinals = new Map();
    this.pending = [];
    this.stepViolations = [];
    this.tags = new Map();
    this.lines = [];
    this.previous = null;
    this.summariesSeen = null;
    this.names = new Map();
    this.groupNames = new Map();
    this.groupChecked = new Set();
    this.t0 = performance.now();
    this.closed = false;
    this.compresses = compresses(header.config);
    this.write({ kind: 'run', schema: SCHEMA, ...header });
    this.restore = {};
    for (const name of CONSOLE) {
      this.restore[name] = console[name];
      console[name] = (...args) => this.logged(format(...args));
    }
  }

  write(event) {
    const problem = eventProblem(event);
    if (problem) throw new Error(`recorder: refusing a malformed ${event?.kind ?? 'event'}: ${problem}`);
    writeSync(this.fd, `${canonicalJSON(event)}\n`);
  }

  blob(value) {
    const v = plain(value);
    const id = digest(v);
    if (!this.blobsWritten.has(id)) {
      this.write({ kind: 'blob', id, value: v });
      this.blobsWritten.add(id);
    }
    return id;
  }

  ordinal(kind) {
    const n = this.ordinals.get(kind) ?? 0;
    this.ordinals.set(kind, n + 1);
    return n;
  }

  logged(line) {
    this.tags.set(logTag(line), (this.tags.get(logTag(line)) ?? 0) + 1);
    this.lines.push(this.blob(maskTiming(line)));
  }

  takeLogs() {
    const logs = Object.fromEntries([...this.tags.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    const lines = this.lines;
    this.tags = new Map();
    this.lines = [];
    return { logs, lines };
  }

  flush() {
    for (const e of this.pending) this.write(e);
    this.pending = [];
  }

  step(n) {
    if (!Number.isInteger(n) || n <= this.stepNo) throw new Error(`recorder: step ${n} after step ${this.stepNo}`);
    this.flush();
    this.stepNo = n;
    this.ordinals = new Map();
  }

  added(participant, content, id) {
    const n = this.ordinal('action');
    this.names.set(String(id), addedName(this.stepNo, n));
    this.pending.push({ kind: 'action', step: this.stepNo, n, op: 'add', args: { participant, content: this.blob(content) }, result: plain(id) });
  }

  /** The trace's name for each store id (events.mjs, addedName); a shard is its body's name with `#INDEX`. */
  nameOf(manager) {
    return (raw) => {
      const id = String(raw);
      const known = this.names.get(id);
      if (known) return known;
      const m = readable(() => manager.getMessage(id));
      if (m && !isUnreadable(m) && m.bodyGroupId) {
        const body = this.groupName(manager, m.bodyGroupId);
        if (body) {
          const name = `${body}#${m.shardIndex ?? 0}`;
          this.names.set(id, name);
          return name;
        }
      }
      return id;
    };
  }

  groupName(manager, groupId) {
    if (!this.groupNames.has(groupId)) {
      for (const [id, name] of this.names) {
        if (this.groupChecked.has(id)) continue;
        this.groupChecked.add(id);
        const m = readable(() => manager.getMessage(id));
        if (m && !isUnreadable(m) && m.bodyGroupId && !this.groupNames.has(m.bodyGroupId)) this.groupNames.set(m.bodyGroupId, name);
      }
    }
    return this.groupNames.get(groupId) ?? null;
  }

  action(op, args = {}, result) {
    if (!ACTION_OPS.includes(op)) throw new Error(`recorder: unknown action ${op}`);
    const e = { kind: 'action', step: this.stepNo, n: this.ordinal('action'), op, args: plain(args) };
    if (result !== undefined) e.result = plain(result);
    this.pending.push(e);
  }

  compiled(manager, budget, compiled) {
    const prov = compiled?.provenance?.messages;
    const name = this.nameOf(manager);
    const sizes = [];
    const byStoreId = (compiled.messages ?? []).map((m, i) => {
      const { message, marker } = normalizeMessage(m);
      const content = this.blob(message);
      sizes.push(canonicalJSON(plain(message)).length);
      const entry = { sources: prov ? sourceStrings(prov[i]) : ['o'], content };
      if (marker) entry.marker = plain(marker);
      return entry;
    });
    const violations = checkCompile(manager, budget, compiled, byStoreId, { compresses: this.compresses });
    const messages = byStoreId.map((m, i) => ({ ...m, sources: prov ? sourceStrings(prov[i], name) : ['o'] }));
    const layout = compiled?.provenance?.layout;
    const e = {
      kind: 'compile', step: this.stepNo, n: this.ordinal('compile'), budget: plain(budget), outcome: 'compiled', messages,
      system: this.blob(compiled.systemInjections ?? []),
      layout: !compiled?.provenance ? { unreadable: 'no provenance' } : layout ? untimed(plain({ ...layout, members: undefined, memberIds: (layout.memberIds ?? []).map(name) })) : null,
      stats: untimed(plain(readable(() => manager.getRenderStats()))),
      violations,
    };
    const ids = messages.map((m) => m.content);
    if (this.previous) e.rewritten = rewrittenShare(this.previous, ids, sizes);
    this.previous = ids;
    this.pending.push(e);
  }

  refused(_manager, budget, error) {
    const fields = {};
    for (const [k, v] of Object.entries(error ?? {})) if (k !== 'message' && k !== 'stack') fields[k] = v;
    const e = {
      kind: 'compile', step: this.stepNo, n: this.ordinal('compile'), budget: plain(budget), outcome: 'refused',
      error: { class: errorClass(error), message: this.blob(String(error?.message ?? error)), fields: plain(readable(() => plain(fields))) },
      violations: [],
    };
    this.pending.push(e);
  }

  receipt({ accepted, withReference }) {
    const last = [...this.pending].reverse().find((e) => e.kind === 'compile');
    if (!last) throw new Error('recorder: a receipt with no compile in this step');
    last.receipt = { accepted: !!accepted, withReference: !!withReference };
  }

  call({ request, target, carried, answer }) {
    const a = { kind: answer.kind };
    if (answer.text !== undefined) a.text = this.blob(answer.text);
    this.pending.push({ kind: 'call', step: this.stepNo, n: this.ordinal('call'), carried: [...new Set(carried)].sort(), target, request: this.blob(request), answer: a });
  }

  violation(invariant, detail) {
    if (!INVARIANTS.includes(invariant)) throw new Error(`recorder: unknown invariant ${invariant}`);
    this.stepViolations.push({ invariant, detail: String(detail) });
  }

  async endStep(manager) {
    const name = this.nameOf(manager);
    const now = readSummaries(manager, name);
    const written = [], removed = [];
    if (!isUnreadable(now)) {
      const before = this.summariesSeen ?? new Map();
      for (const [id, s] of now) if (!before.has(id)) written.push({ id, level: s.level, sources: s.sources, content: this.blob(s.content) });
      for (const id of before.keys()) if (!now.has(id)) removed.push(id);
      this.summariesSeen = now;
    }
    const { logs, lines } = this.takeLogs();
    this.flush();
    this.write({
      kind: 'step', step: this.stepNo, written, removed,
      waiting: plain(readable(() => manager.getWaitingWork())), pending: plain(readable(() => manager.getPendingWork())),
      ready: plain(readable(() => manager.isReady())), logs, lines, violations: this.stepViolations,
    });
    this.stepViolations = [];
  }

  async checkpoint(manager, label) {
    this.flush();
    const name = this.nameOf(manager);
    const messages = readable(() => manager.getAllMessages().map((m) => [name(m.id), String(m.participant), this.blob(m.content)]));
    const summaries = readSummaries(manager, name);
    const summaryList = isUnreadable(summaries) ? summaries : [...summaries.values()].map((s) => ({ id: s.id, level: s.level, sourceLevel: s.sourceLevel, sources: s.sources, parent: s.parent, tokens: s.tokens, content: this.blob(s.content) }));
    this.write({
      kind: 'checkpoint', step: this.stepNo, label,
      messages: plain(messages), summaries: plain(summaryList),
      pins: plain(readable(() => manager.listPins().map((p) => ({ ...p, firstMessageId: name(p.firstMessageId), lastMessageId: name(p.lastMessageId) })))),
      holds: plain(readable(() => [...manager.getCompressionHoldDetails().entries()].map(([id, info]) => [name(id), info]))),
      waiting: plain(readable(() => manager.getWaitingWork())),
      pending: plain(readable(() => manager.getPendingWork())),
      ready: plain(readable(() => manager.isReady())),
      maxLevel: plain(readable(() => manager.getMaxSummaryLevel())),
      derivation: plain(readable(() => manager.getDerivation())),
      branches: plain(readable(() => manager.listBranches().map((b) => ({ id: b.id, name: b.name, head: b.head })))),
      settings: plain(readable(() => manager.getHotContextSettings())),
      violations: isUnreadable(summaries) ? [] : checkBookkeeping(summaries),
    });
  }

  async end(failure = null) {
    if (this.closed) return;
    this.flush();
    const { logs, lines } = this.takeLogs();
    const e = { kind: 'end', ok: !failure, wallMs: Math.round(performance.now() - this.t0) };
    if (failure) e.error = { class: errorClass(failure.error), message: this.blob(String(failure.error?.stack ?? failure.error)), where: failure.where };
    if (lines.length > 0) { e.logs = logs; e.lines = lines; }
    for (const name of CONSOLE) console[name] = this.restore[name];
    this.write(e);
    closeSync(this.fd);
    this.closed = true;
  }
}

function errorClass(error) {
  if (error && typeof error.name === 'string' && error.name !== 'Error') return error.name;
  return error?.constructor?.name ?? typeof error;
}

/** The share, 0 to 1, of this request's content after the first message where it differs from the previous one. */
function rewrittenShare(previous, ids, sizes) {
  let i = 0;
  while (i < ids.length && i < previous.length && ids[i] === previous[i]) i++;
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  return Math.round((sizes.slice(i).reduce((a, b) => a + b, 0) / total) * 1e6) / 1e6;
}

/**
 * Every summary the store holds, by id, with its sources, through `getSummariesInRange` and `getSummary`; level-0
 * sources by their trace names.
 */
function readSummaries(manager, name = (id) => String(id)) {
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

  // Store order: what each message covers starts no earlier than what the message before it covers.
  let last = -Infinity, lastAt = -1;
  messages.forEach((m, i) => {
    let first = Infinity;
    for (const s of m.sources) {
      if (s.startsWith('r:')) first = Math.min(first, sequenceOf.get(s.slice(2).split('!')[0]) ?? Infinity);
      else if (s.startsWith('s:')) for (const b of leaves(s.slice(2).split('@')[0])) first = Math.min(first, sequenceOf.get(b) ?? Infinity);
    }
    if (first === Infinity) return;
    if (first < last) out.push({ invariant: 'coverage', detail: `message ${i} covers from sequence ${first}, before message ${lastAt}'s ${last}` });
    if (first >= last) { last = first; lastAt = i; }
  });

  // Budget: a compile that enforces its budget sends no more than the input budget (what it was given less its
  // reserve) and the strategy's grace above it (`overBudgetGraceRatio`, 0.02 when unset), or refuses.
  const configured = readable(() => manager.getStrategy().config ?? {});
  const config = isUnreadable(configured) ? {} : configured;
  const rendered = readable(() => manager.getRenderStats());
  const tokens = !isUnreadable(rendered) && rendered?.total?.tokens;
  const input = budget.maxTokens - (budget.reserveForResponse ?? 0);
  const grace = Math.max(0, config.overBudgetGraceRatio ?? 0.02);
  if (config.enforceBudget !== false && typeof tokens === 'number' && tokens > Math.floor(input * (1 + grace))) {
    out.push({ invariant: 'budget', detail: `${tokens} tokens against an input budget of ${input} and a grace of ${grace}` });
  }

  // Shape: a pair the store holds isn't sent parted. In the store a result answers the nearest call before it with its
  // id. A result of such a pair answers a call in the message before it, and a call of such a pair, but in the last
  // message, is answered in the message after it. A block the store itself holds unpaired breaks nothing here. A block
  // no raw source holds, such as a stub, is held to the same rule as a pair's.
  // A passthrough (a configuration that doesn't compress) sends every message from its window's start as stored, so a
  // result whose call lies before that start goes out as stored, and a pair the store holds apart goes out apart. Its
  // promise is narrower: no request opens with a tool result, and no message of a pair inside the request's own span
  // is left out of it (Oscar-1005, #300707).
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
  sent.forEach((m, i) => {
    for (const b of blocks(m)) {
      if (b?.type === 'tool_result' && !blocks(sent[i - 1]).some((c) => c?.type === 'tool_use' && c.id === b.toolUseId)) {
        const keys = storedKeys(i, 'tool_result', b.toolUseId);
        const parted = compressing ? keys.some((key) => callOf.has(key)) : i === 0 || keys.some((key) => callOf.has(key) && leftOut(callOf.get(key)));
        if (keys.length === 0 || parted) {
          out.push({ invariant: 'shape', detail: `message ${i}: result ${b.toolUseId} answers no call in the message before it` });
        }
      }
      if (b?.type === 'tool_use' && i < sent.length - 1 && !blocks(sent[i + 1]).some((c) => c?.type === 'tool_result' && c.toolUseId === b.id)) {
        const keys = storedKeys(i, 'tool_use', b.id);
        const parted = compressing ? keys.some((key) => answered.has(key)) : keys.some((key) => answered.has(key) && leftOut(answered.get(key)));
        if (keys.length === 0 || parted) {
          out.push({ invariant: 'shape', detail: `message ${i}: call ${b.id} unanswered in the message after it` });
        }
      }
    }
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

/** At each level, no two summaries share a source. */
export function checkBookkeeping(summaries) {
  const out = [];
  const owner = new Map();
  for (const s of summaries.values()) {
    for (const src of s.sources) {
      const key = `${s.level}:${src}`;
      if (owner.has(key)) out.push({ invariant: 'bookkeeping', detail: `L${s.level} summaries ${owner.get(key)} and ${s.id} share source ${src}` });
      else owner.set(key, s.id);
    }
  }
  return dedupe(out);
}

const dedupe = (violations) => [...new Map(violations.map((v) => [`${v.invariant}|${v.detail}`, v])).values()];
