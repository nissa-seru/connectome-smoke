/**
 * The strategy fixture's checks, from what a run recorded: the stand-in's records
 * (lib/strategies/standin.mjs, close()) and the driver's run log (lib/strategies/driver.mjs).
 * Each check returns flags, `{ check, step, request?, message }`; a flag is a break.
 */

/**
 * Check 2: each continuation segment produced what it exists for. Returns the segments
 * with a missing product, `{ segment, missing: [names] }`, in script order. A record
 * belongs to the segment of the step it arrived in. A product read from the store
 * (`fromStore`) is judged where `store`, the side's store read, is given, and waits on
 * none where it isn't (the writer's length trial reads no store).
 */
export function declaredProducts(records, script, products, store = null) {
  const segmentOf = new Map(script.map((s) => [s.id, s.segment]));
  const out = [];
  for (const [segment, wanted] of Object.entries(products)) {
    if (!script.some((s) => s.segment === segment)) continue;
    const mine = records.filter((r) => segmentOf.get(r.step) === segment);
    const missing = wanted.filter((p) => (p.fromStore ? store !== null && !p.fromStore(store) : !mine.some((r) => p.test(r, mine)))).map((p) => p.name);
    if (missing.length) out.push({ segment, missing });
  }
  return out;
}

/** Check 1: every turn answers. Requests the stand-in refused or couldn't classify, failure
 *  events and operator alerts (agent-framework's `ops:alert`, a compression quarantine or a
 *  context-maintenance failure among them) in the run log, and checkpoints that didn't settle. */
export function everyTurnAnswers(records, log = []) {
  const flags = [];
  for (const r of records) {
    if (r.kind === 'unclassified') flags.push({ check: 1, step: r.step, request: r.id, message: `unclassified request: ${r.reason}` });
    else if (r.refused) flags.push({ check: 1, step: r.step, request: r.id, message: `the stand-in refused it (${r.refused})` });
  }
  for (const e of log) {
    if (e.kind === 'ipc' && /^inference:(failed|exhausted)$/.test(e.event?.type ?? '')) flags.push({ check: 1, step: e.step, message: `${e.event.type}: ${e.event.error ?? e.event.reason ?? ''}`.trim() });
    if (e.kind === 'ipc' && e.event?.type === 'ops:alert') flags.push({ check: 1, step: e.step, message: `the host raised an operator alert, ${e.event.kind}: ${e.event.message ?? ''}`.trim() });
    if (e.kind === 'settle' && e.phase === 'end' && e.settled === false) flags.push({ check: 1, step: e.step, message: 'the checkpoint did not settle' });
  }
  return flags;
}

/** A checkpoint's health panel for its (one) agent: the last live compile's composition and settings. */
function panelAt(e) {
  const data = e.health?.data ?? {};
  const first = (o) => (o && typeof o === 'object' ? Object.values(o)[0] : undefined);
  return { composition: first(data.contextComposition), settings: first(data.runtimeSettings) };
}

/**
 * Each checkpoint with the last agent request of its segment, the one whose compile its health
 * panel describes (connectome-host reports "render stats from its last live compile"), and how
 * many agent requests that request's step had made by then.
 */
function lastRequests(records, script, log) {
  const segmentOf = new Map(script.map((s) => [s.id, s.segment]));
  const out = [];
  for (const e of log) {
    if (e.kind !== 'checkpoint') continue;
    const agents = records.filter((r) => r.kind === 'agent' && segmentOf.get(r.step) === e.name);
    const request = agents.at(-1) ?? null;
    out.push({ checkpoint: e, segment: e.name, request, n: request ? agents.filter((r) => r.step === request.step).length : 0, ...panelAt(e) });
  }
  return out;
}

/**
 * Check 3's budget: at each checkpoint, its segment's last agent request is flagged when
 * context-manager says that compile's plan failed (`planVsActual.budgetMet` false or
 * `exhausted` true), and when its messages, counted by the stand-in apart from the system
 * prompt and tools (`messageTokens`), exceed the budget that compile was given
 * (`runtimeSettings.<agent>.effectiveContextBudgetTokens`). A checkpoint with no agent request,
 * no budget or no count is flagged too. Returns `{ flags, headroom }`, headroom being each
 * checkpoint's `{ segment, request, messageTokens, budget }`.
 */
export function budgets(records, script, log = []) {
  const flags = [];
  const headroom = [];
  for (const { segment, request, composition, settings, checkpoint } of lastRequests(records, script, log)) {
    const step = checkpoint.step ?? segment;
    if (!request) { flags.push({ check: 3, step, message: `segment ${segment} made no agent request for its checkpoint's panel to describe` }); continue; }
    const budget = settings?.effectiveContextBudgetTokens;
    const plan = composition?.planVsActual;
    if (typeof budget !== 'number') { flags.push({ check: 3, step: request.step, request: request.id, message: `segment ${segment}'s checkpoint named no budget for its last compile` }); continue; }
    if (typeof request.messageTokens !== 'number') { flags.push({ check: 3, step: request.step, request: request.id, message: 'the stand-in recorded no message count for it' }); continue; }
    headroom.push({ segment, request: request.id, messageTokens: request.messageTokens, budget });
    if (plan?.budgetMet === false) flags.push({ check: 3, step: request.step, request: request.id, message: `context-manager says its compile's plan didn't meet the budget (planned ${plan.planned}, actual ${plan.actual})` });
    if (plan?.exhausted === true) flags.push({ check: 3, step: request.step, request: request.id, message: 'context-manager says its compile exhausted its plan' });
    if (request.messageTokens > budget) flags.push({ check: 3, step: request.step, request: request.id, message: `its messages are ${request.messageTokens} tokens, over the ${budget} its compile was given` });
  }
  return { flags, headroom };
}

/**
 * The head window's size at each segment's checkpoint, as the host's health panel reports the
 * last compile's composition (`contextComposition.<agent>.head.messages`), keyed by segment.
 */
export function headCounts(log) {
  const counts = new Map();
  for (const e of log) {
    if (e.kind !== 'checkpoint') continue;
    const composition = e.health?.data?.contextComposition;
    const agent = composition && Object.values(composition)[0];
    if (typeof agent?.head?.messages === 'number') counts.set(e.name, agent.head.messages);
  }
  return counts;
}

/**
 * Check 6: the head window and the recent window stay raw. The head is the first N stored
 * messages, N the head's message count the host reported at the request's segment's
 * checkpoint (headCounts), and each agent request carries raw every input and reply canary
 * among them that was stored before it, as check 4 reads that: through its own turn's input
 * and its turn's earlier replies. That takes the head to start at the store's first message,
 * as it does with no head-window reset; the panel reports the head's size, not where it
 * starts. Each agent
 * request also carries raw the input and reply canaries of the two turns before its own.
 * And each segment's last agent request, the one whose compile the checkpoint's panel
 * describes, carries raw every input and reply canary among the newest messages stored before
 * it, as many as the raw tail the host reported (`contextComposition.<agent>.tail.messages`).
 * With no store read (a configuration that keeps no summaries) only the two turns before
 * each request are checked.
 */
export function windowsRaw(records, script, log, store) {
  const flags = [];
  const turns = script.filter((s) => Array.isArray(s.replies) && s.replies.length);
  const before = new Map(turns.map((s, i) => [s.id, turns.slice(Math.max(0, i - 2), i)]));
  const segmentOf = new Map(turns.map((s) => [s.id, s.segment]));
  const heads = headCounts(log);
  const order = store ? store.messages.flatMap((m) => m.canaries.filter(conversational)) : [];
  const at = new Map(order.map((c, i) => [c, i]));
  const asked = new Map();
  for (const r of records) {
    if (r.kind !== 'agent') continue;
    const n = (asked.get(r.step) ?? 0) + 1;
    asked.set(r.step, n);
    if (!before.has(r.step)) continue;
    const carried = new Set((r.messages || []).flatMap((m) => m.blocks).flatMap((b) => b.canaries || []));
    const ownInput = at.get(`[[c:${r.step}.in]]`);
    if (store && ownInput !== undefined) {
      const storedBefore = new Set([...order.slice(0, ownInput + 1), ...Array.from({ length: n - 1 }, (_, k) => `[[c:${r.step}.r${k + 1}]]`)]);
      if (!heads.has(segmentOf.get(r.step))) {
        flags.push({ check: 6, step: r.step, request: r.id, message: `no head size was reported at segment ${segmentOf.get(r.step)}'s checkpoint` });
      } else {
        const head = store.messages.slice(0, heads.get(segmentOf.get(r.step))).flatMap((m) => m.canaries.filter(conversational)).filter((c) => storedBefore.has(c));
        const lost = head.filter((c) => !carried.has(c));
        if (lost.length) flags.push({ check: 6, step: r.step, request: r.id, message: `the head window's ${lost.join(' ')} isn't raw` });
      }
    }
    for (const t of before.get(r.step)) {
      const wanted = [`[[c:${t.id}.in]]`, ...t.replies.map((_, k) => `[[c:${t.id}.r${k + 1}]]`)];
      const missing = wanted.filter((c) => !carried.has(c));
      if (missing.length) flags.push({ check: 6, step: r.step, request: r.id, message: `the recent window lacks ${missing.join(' ')}` });
    }
  }
  if (!store) return flags;
  const stepOf = new Map(script.map((s) => [s.id, s]));
  for (const { segment, request, n, composition } of lastRequests(records, script, log)) {
    if (!request) continue;
    const size = composition?.tail?.messages;
    if (typeof size !== 'number') { flags.push({ check: 6, step: request.step, request: request.id, message: `no tail size was reported at segment ${segment}'s checkpoint` }); continue; }
    const step = stepOf.get(request.step);
    const earlier = (step?.replies ?? []).slice(0, Math.max(0, n - 1));
    const storedBefore = new Set([`[[c:${request.step}.in]]`, ...earlier.map((_, k) => `[[c:${request.step}.r${k + 1}]]`), ...earlier.flatMap((reply) => (reply.calls ?? []).map((c) => c.input?.canary))]);
    let at = -1;
    store.messages.forEach((m, i) => { if (m.canaries.some((c) => storedBefore.has(c))) at = i; });
    if (at < 0) continue;
    const tail = store.messages.slice(Math.max(0, at - size + 1), at + 1).flatMap((m) => m.canaries.filter(conversational));
    const carried = new Set((request.messages || []).flatMap((m) => m.blocks).flatMap((b) => b.canaries || []));
    const lost = tail.filter((c) => !carried.has(c));
    if (lost.length) flags.push({ check: 6, step: request.step, request: request.id, message: `the reported tail's ${lost.join(' ')} isn't raw` });
  }
  return flags;
}

const conversational = (c) => /\.(in|r\d+)\]\]$/.test(c);

/**
 * Check 4, coverage read from the wire, against a store read (read-store.mjs): in each agent
 * request, every message stored before it that carries an input or reply canary is there raw
 * or inside a summary whose number is there, no such message is there twice, and what it
 * carries runs in store order, a summary by the first message it covers. A tool
 * result's canary isn't required, since pruning replaces older results by design. A summary
 * number no store read maps is flagged, never counted either way.
 */
export function coverage(records, store) {
  const flags = [];
  const covers = new Map(store.summaries.filter((s) => s.number).map((s) => [s.number, s.covers]));
  const order = store.messages.flatMap((m) => m.canaries.filter(conversational));
  const at = new Map(order.map((c, i) => [c, i]));
  const asked = new Map();
  for (const r of records) {
    if (r.kind !== 'agent') continue;
    const n = (asked.get(r.step) ?? 0) + 1;
    asked.set(r.step, n);
    const ownInput = at.get(`[[c:${r.step}.in]]`);
    if (ownInput === undefined) continue;
    const shown = [];
    const unknown = [];
    for (const m of r.messages || []) {
      for (const b of m.blocks) {
        shown.push(...(b.canaries || []).filter(conversational));
        for (const s of b.summaries || []) {
          if (covers.has(s)) shown.push(...covers.get(s).filter(conversational));
          else unknown.push(s);
        }
      }
    }
    for (const s of new Set(unknown)) flags.push({ check: 4, step: r.step, request: r.id, message: `summary ${s} is in the request, and no store read maps it` });
    let last = null;
    for (const m of r.messages || []) {
      for (const b of m.blocks) {
        const items = [
          ...(b.canaries || []).filter(conversational).map((c) => [c, at.get(c)]),
          ...(b.summaries || []).filter((x) => covers.has(x)).map((x) => [x, Math.min(...covers.get(x).filter(conversational).map((c) => at.get(c) ?? Infinity))]),
        ].filter(([, i]) => Number.isFinite(i));
        for (const item of items) {
          if (last && item[1] < last[1] && !flags.some((f) => f.request === r.id && /store order/.test(f.message))) {
            flags.push({ check: 4, step: r.step, request: r.id, message: `it carries ${item[0]} after ${last[0]}, out of store order` });
          }
          last = item;
        }
      }
    }
    const count = new Map();
    for (const c of shown) count.set(c, (count.get(c) ?? 0) + 1);
    const wanted = [...order.slice(0, ownInput + 1), ...Array.from({ length: n - 1 }, (_, k) => `[[c:${r.step}.r${k + 1}]]`)];
    const missing = wanted.filter((c) => !count.has(c));
    const twice = wanted.filter((c) => count.get(c) > 1);
    if (missing.length) flags.push({ check: 4, step: r.step, request: r.id, message: `${missing.length} stored message(s) reach the request neither raw nor in a summary: ${missing.slice(0, 5).join(' ')}${missing.length > 5 ? ' …' : ''}` });
    if (twice.length) flags.push({ check: 4, step: r.step, request: r.id, message: `${twice.length} message(s) reach the request more than once: ${twice.slice(0, 5).join(' ')}${twice.length > 5 ? ' …' : ''}` });
  }
  return flags;
}

/**
 * Check 5, the bookkeeping against what the summariser saw: every summary this run made
 * declares only sources its compression request showed, each child by its summary number,
 * by its own children's, or by the canaries of every message it covers. A source message without a canary,
 * such as a clock row or a later shard, can't be checked and is skipped.
 */
export function bookkeeping(records, store) {
  const flags = [];
  const byNumber = new Map(store.summaries.filter((s) => s.number).map((s) => [s.number, s]));
  const byId = new Map(store.summaries.map((s) => [s.id, s]));
  const messages = new Map(store.messages.map((m) => [m.id, m]));
  for (const r of records) {
    const number = r.kind === 'summariser' ? r.answer?.summary : null;
    if (!number) continue;
    const s = byNumber.get(number);
    if (!s) continue;
    const sentCanaries = new Set(r.sent?.canaries || []);
    const sentSummaries = new Set(r.sent?.summaries || []);
    // A child was shown by its own number, by its children's (an L3 merge is shown L1
    // memories), or by the canaries of every message it covers.
    const shown = (child, seen = new Set()) => {
      if (seen.has(child.id)) return false;
      seen.add(child.id);
      if (child.number && sentSummaries.has(child.number)) return true;
      if (child.sourceLevel > 0 && child.sourceIds.length && child.sourceIds.every((id) => byId.has(id) && shown(byId.get(id), seen))) return true;
      return child.covers.filter(conversational).every((c) => sentCanaries.has(c));
    };
    const unseen = [];
    for (const id of s.sourceIds) {
      if (s.sourceLevel === 0) {
        const own = messages.get(id)?.canaries.filter(conversational) ?? [];
        if (own.some((c) => !sentCanaries.has(c))) unseen.push(id);
      } else {
        const child = byId.get(id);
        if (!child) { unseen.push(id); continue; }
        if (!shown(child)) unseen.push(id);
      }
    }
    if (unseen.length) flags.push({ check: 5, step: r.step, request: r.id, message: `summary ${number} (${s.id}, L${s.level}) declares ${unseen.length} source(s) its request didn't show: ${unseen.slice(0, 5).join(', ')}` });
  }
  return flags;
}

/** Every calibration multiplier a health snapshot reports, wherever it sits. */
function multipliers(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (value.calibration && typeof value.calibration.multiplier === 'number') out.push(value.calibration.multiplier);
  for (const v of Object.values(value)) multipliers(v, out);
  return out;
}

/**
 * Check 10: a calibration multiplier at either clamp edge (context-manager clamps it to
 * 0.6–1.8) makes the run invalid, since its folds are clamped folds, not a store's. Read from
 * the health panel each checkpoint records.
 */
export function calibrationEdge(log = [], { low = 0.6, high = 1.8 } = {}) {
  const flags = [];
  for (const e of log) {
    if (e.kind !== 'checkpoint') continue;
    for (const m of multipliers(e.health)) {
      if (Math.abs(m - low) < 1e-9 || Math.abs(m - high) < 1e-9) flags.push({ check: 10, step: e.step, message: `calibration at the clamp edge (${m}) at checkpoint ${e.name}: the run is invalid` });
    }
  }
  return flags;
}

/** Check 3, the shape of each request: roles alternate, and every tool result answers a
 *  call in the message right before it, and every call before the last message is answered
 *  in the message right after it. */
export function wellFormed(records) {
  const flags = [];
  for (const r of records) {
    if (r.kind !== 'agent' && r.kind !== 'summariser') continue;
    const ms = r.messages || [];
    for (let i = 1; i < ms.length; i++) {
      if (ms[i].role === ms[i - 1].role) { flags.push({ check: 3, step: r.step, request: r.id, message: `messages ${i - 1} and ${i} are both ${ms[i].role}'s` }); break; }
    }
    for (let i = 0; i < ms.length; i++) {
      const calls = new Set(ms[i].blocks.filter((b) => b.type === 'tool_use').map((b) => b.toolUseId));
      const results = new Set(ms[i].blocks.filter((b) => b.type === 'tool_result').map((b) => b.toolUseId));
      const before = new Set((ms[i - 1]?.blocks || []).filter((b) => b.type === 'tool_use').map((b) => b.toolUseId));
      const after = new Set((ms[i + 1]?.blocks || []).filter((b) => b.type === 'tool_result').map((b) => b.toolUseId));
      for (const id of results) if (!before.has(id)) flags.push({ check: 3, step: r.step, request: r.id, message: `message ${i}'s result ${id} answers no call in the message before it` });
      if (i < ms.length - 1) for (const id of calls) if (!after.has(id)) flags.push({ check: 3, step: r.step, request: r.id, message: `message ${i}'s call ${id} has no result in the message after it` });
    }
  }
  return flags;
}
