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
    if (e.kind === 'ipc' && e.event?.type === 'ops:alert') flags.push({ check: 1, step: e.step, what: e.event.kind, message: `the host raised an operator alert, ${e.event.kind}: ${e.event.message ?? ''}`.trim() });
    if (e.kind === 'settle' && e.phase === 'end' && e.settled === false) flags.push({ check: 1, step: e.step, message: 'the checkpoint did not settle' });
  }
  return flags;
}

/** The agent a run's checks read the host's panel and events for, as the judge names it. */
export const FIXTURE_AGENT = 'fixture';

/** agent-framework 0.28.0's stream bound when the recipe sets no `agent.maxStreamTokens`
 *  (`Agent`'s `config.maxStreamTokens ?? 150_000`; connectome-host 0.15.0 passes the recipe's on). */
export const STREAM_BOUND = 150_000;

/** A checkpoint's health panel for the run's agent: the last live compile's composition and
 *  settings, read by the agent's name. */
function panelAt(e, agent = FIXTURE_AGENT) {
  const data = e.health?.data ?? {};
  return { composition: data.contextComposition?.[agent], settings: data.runtimeSettings?.[agent] };
}

/**
 * Each checkpoint with the last agent request of its segment, the one whose compile its health
 * panel describes (connectome-host reports "render stats from its last live compile"), and how
 * many agent requests that request's step had made by then.
 */
function lastRequests(records, script, log, agent = FIXTURE_AGENT) {
  const bySegment = segmentAgents(records, script);
  const out = [];
  for (const e of log) {
    if (e.kind !== 'checkpoint') continue;
    const agents = bySegment.get(e.name) ?? [];
    const request = agents.at(-1) ?? null;
    out.push({ checkpoint: e, segment: e.name, request, agents, n: request ? agents.filter((r) => r.step === request.step).length : 0, ...panelAt(e, agent) });
  }
  return out;
}

/** Each segment's agent requests, in the order they arrived, keyed by segment. */
function segmentAgents(records, script) {
  const segmentOf = new Map(script.map((s) => [s.id, s.segment]));
  const bySegment = new Map();
  for (const r of records) {
    if (r.kind !== 'agent' || !segmentOf.has(r.step)) continue;
    const segment = segmentOf.get(r.step);
    bySegment.set(segment, [...(bySegment.get(segment) ?? []), r]);
  }
  return bySegment;
}

/** Each segment's last agent request: the one whose compile its checkpoint's panel describes. */
const segmentLasts = (records, script) => new Set([...segmentAgents(records, script).values()].map((agents) => agents.at(-1)));

/**
 * Which agent requests were compiled and which were a turn's continuation rounds, read from the
 * requests themselves (the stand-in's records), so the same records give the same kinds whatever
 * order the host's events and the requests arrived in. agent-framework 0.28.0's stream events
 * carry no id the request also carries, and a continuation's request leaves before its
 * `inference:stream_resumed` (`provideToolResults`, then `emitTrace`).
 * - A step's first agent request opens its turn: `compiled`. The driver sends each step's input
 *   after the turn before has ended.
 * - A later one is a `continuation` when it carries the step's previous agent request whole, each
 *   message by its digest (standin.mjs, T18), then the assistant's message carrying exactly the
 *   tool_use ids the stand-in answered that request with, at least one, then only the user's (the
 *   results, and any message injected mid-turn).
 * - Any other later one is `compiled`: a restart's compile, which context-manager renders afresh,
 *   or a request after one the stand-in refused or answered without a tool call.
 * - null where its record, or the step's previous request's, carries no digests: the check can't
 *   judge it.
 */
export function requestKinds(records) {
  const kinds = new Map();
  const previous = new Map();
  const digests = (r) => (r.messages?.length && r.messages.every((m) => typeof m.digest === 'string') ? r.messages.map((m) => m.digest) : null);
  for (const r of records) {
    if (r.kind !== 'agent') continue;
    const before = previous.get(r.step);
    previous.set(r.step, r);
    const mine = digests(r);
    if (mine === null) { kinds.set(r.id, null); continue; }
    if (!before) { kinds.set(r.id, 'compiled'); continue; }
    const theirs = digests(before);
    if (theirs === null) { kinds.set(r.id, null); continue; }
    const n = theirs.length;
    const minted = before.answer?.toolUseIds ?? [];
    const round = r.messages[n];
    const calls = round?.role === 'assistant' ? round.blocks.filter((b) => b.type === 'tool_use').map((b) => b.toolUseId) : null;
    const continues = mine.length > n + 1
      && theirs.every((d, i) => d === mine[i])
      && minted.length > 0 && calls !== null && calls.length === minted.length && calls.every((id, i) => id === minted[i])
      && r.messages.slice(n + 1).every((m) => m.role === 'user');
    kinds.set(r.id, continues ? 'continuation' : 'compiled');
  }
  return kinds;
}

/** A request's whole input as the stand-in's usage reported it: new input, cache read and cache write. */
function inputOf(r) {
  const u = r?.usage;
  if (!u) return null;
  const parts = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens];
  return parts.every((x) => typeof x === 'number') ? parts.reduce((a, b) => a + b, 0) : null;
}

/** A token count as connectome-host's `/budget` writes it (`fmtTokens`, src/tui.ts in 0.15.0 and `main`). */
export function hostTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** What connectome-host's `/budget` adds to an agent's line when agent-framework breaks its stream
 *  mid-turn only at its window: its thinking binds and its window is set (`windowInsteadOfBudget`,
 *  in `main` since #508). */
const WINDOW_GOVERNS = 'its stream doesn\'t break at this budget mid-turn';

/**
 * K2d: the budget report (the driver's log of `/budget` after each boot, D12) that governs each
 * agent request: the last one logged before the request, read for `agent` as `{ boot, figure,
 * window, windowFigure }`, or null where there's none before it or it has no line for the agent.
 * The driver logs a report once its output is whole, before any step runs, so a request the host
 * made on its own while the driver waited would fall under the previous boot's report, or none.
 */
function budgetReports(log, agent) {
  const governs = new Map();
  let current = null;
  for (const e of log) {
    if (e.kind === 'budget-report') {
      const line = (e.lines ?? []).find((l) => l.startsWith(`  ${agent}: `));
      current = line === undefined ? null : { boot: e.boot, figure: line.slice(agent.length + 4).split(' ')[0], window: line.includes(WINDOW_GOVERNS), windowFigure: / its (\S+) window can't hold/.exec(line)?.[1] ?? null };
    }
    if (e.kind === 'request' && e.request?.kind === 'agent') governs.set(e.request.id, current);
  }
  return governs;
}

/**
 * Check 3's budget: each agent request of the run's agent against the bound that governs it.
 * - A compiled request (its turn's first, or a restart's; requestKinds) is flagged when its
 *   messages, counted by the stand-in apart from the system prompt and tools (`messageTokens`),
 *   exceed its segment's budget less the request's own max tokens: agent-framework compiles with
 *   the context budget as `maxTokens` and the agent's `maxTokens` as `reserveForResponse`, and
 *   context-manager plans to the difference. The budget is the setting the segment's checkpoint
 *   reports (`runtimeSettings.<agent>.effectiveContextBudgetTokens`); one that moved since the
 *   checkpoint before can't be held to either number, and says so.
 * - A continuation round is flagged when the agent's request before it in the same turn already
 *   had a whole input over the stream bound, since agent-framework restarts rather than
 *   continues once a round's input passes it, unless the agent's thinking binds and its window
 *   is set: then it restarts only before a request the window can't hold, which the stand-in's
 *   window refusal flags as check 1. The host's budget report before the request says which
 *   (K2d, budgetReports): with its window clause, the continuation isn't held to the stream bound
 *   and a note says so, provided the window the clause prints is the stand-in's (`windowTokens`,
 *   as the host writes it), since the stand-in's refusal then stands in for that restart; a
 *   window that isn't makes every continuation under the report one it can't judge; with a figure
 *   other than the stream bound as the host writes it, the check holds the wrong bound, so every
 *   continuation under it can't be judged; with no report, a
 *   continuation after a round over the stream bound can't be judged, and the others are judged
 *   as the branch wouldn't change their verdict.
 * - context-manager's own verdict on the compile the panel describes (`planVsActual.budgetMet`
 *   false, or `exhausted` true) flags the segment's last compiled request.
 * A request its records don't classify, a checkpoint whose panel lacks the agent or names no
 * budget, and one whose segment made no agent request are flags, never passes. Returns
 * `{ flags, headroom, notes }`, headroom being each segment's least, per kind of request:
 * `{ segment, kind, request, tokens, bound }`.
 */
export function budgets(records, script, log = [], { agent = FIXTURE_AGENT, streamBound = STREAM_BOUND, windowTokens } = {}) {
  const flags = [];
  const headroom = [];
  const kinds = requestKinds(records);
  const reports = budgetReports(log, agent);
  const windowBoots = new Set();
  const agentRequests = records.filter((r) => r.kind === 'agent');
  let previousBudget;
  for (const { segment, agents, composition, settings, checkpoint } of lastRequests(records, script, log, agent)) {
    const step = agents.at(-1)?.step ?? checkpoint.step ?? segment;
    if (composition === undefined && settings === undefined) { flags.push({ check: 3, step, message: `segment ${segment}'s checkpoint panel has no entry for ${agent}` }); continue; }
    if (!agents.length) { flags.push({ check: 3, step, message: `segment ${segment} made no agent request for its checkpoint's panel to describe` }); continue; }
    const budget = settings?.effectiveContextBudgetTokens;
    if (typeof budget !== 'number') { flags.push({ check: 3, step, message: `segment ${segment}'s checkpoint named no budget for its compiles` }); continue; }
    const moved = previousBudget !== undefined && previousBudget !== budget;
    if (moved) flags.push({ check: 3, step, message: `couldn't judge segment ${segment}'s compiled requests: its budget moved from ${previousBudget} at the checkpoint before to ${budget}` });
    previousBudget = budget;
    const least = {};
    const room = (kind, r, tokens, bound) => {
      if (!least[kind] || bound - tokens < least[kind].bound - least[kind].tokens) least[kind] = { segment, kind, request: r.id, tokens, bound };
    };
    for (const r of agents) {
      const kind = kinds.get(r.id) ?? null;
      if (kind === null) { flags.push({ check: 3, step: r.step, request: r.id, message: 'couldn\'t judge whether it was compiled or a continuation round: the stand-in recorded no message digests for it or for its step\'s request before it' }); continue; }
      if (kind === 'compiled') {
        if (moved) continue;
        if (typeof r.messageTokens !== 'number' || typeof r.maxTokens !== 'number') { flags.push({ check: 3, step: r.step, request: r.id, message: 'couldn\'t judge it: the stand-in recorded no message count or max tokens for it' }); continue; }
        const bound = budget - r.maxTokens;
        room('compiled', r, r.messageTokens, bound);
        if (r.messageTokens > bound) flags.push({ check: 3, step: r.step, request: r.id, message: `its messages are ${r.messageTokens} tokens, over the ${bound} its compile could plan to (the budget ${budget} less its ${r.maxTokens} max tokens)` });
      } else {
        const report = reports.get(r.id) ?? null;
        if (report && report.figure !== hostTokens(streamBound)) { flags.push({ check: 3, step: r.step, request: r.id, message: `couldn't judge this continuation round: the host reports ${agent}'s stream budget as ${report.figure}, and the check holds continuations to ${streamBound} (${hostTokens(streamBound)})` }); continue; }
        if (report?.window && report.windowFigure !== (windowTokens === undefined ? undefined : hostTokens(windowTokens))) { flags.push({ check: 3, step: r.step, request: r.id, message: `couldn't judge this continuation round: the host reports that ${agent}'s window, ${report.windowFigure ?? 'which it doesn\'t name'}, governs its stream, and the stand-in refuses past ${windowTokens ?? 'no window it was given'}${windowTokens === undefined ? '' : ` (${hostTokens(windowTokens)})`}` }); continue; }
        if (report?.window) { windowBoots.add(report.boot); continue; }
        const own = inputOf(r);
        if (own !== null) room('continuation', r, own, streamBound);
        const before = agentRequests.slice(0, agentRequests.indexOf(r)).filter((x) => x.step === r.step).at(-1);
        const input = inputOf(before);
        if (input === null) { flags.push({ check: 3, step: r.step, request: r.id, message: 'couldn\'t judge this continuation round: the request before it in its turn has no usage recorded' }); continue; }
        if (input > streamBound && !report) flags.push({ check: 3, step: r.step, request: r.id, message: `couldn't judge this continuation round: the request before it had a ${input}-token input, over the stream bound ${streamBound}, and no report of the host's stream budget for ${agent} came before it to say whether agent-framework breaks the stream there or only at the window` });
        else if (input > streamBound) flags.push({ check: 3, step: r.step, request: r.id, message: `a continuation round after a ${input}-token input, over the stream bound ${streamBound}, past which agent-framework restarts rather than continues` });
      }
    }
    const lastCompiled = agents.filter((r) => kinds.get(r.id) === 'compiled').at(-1);
    const plan = composition?.planVsActual;
    if (lastCompiled && plan?.budgetMet === false) flags.push({ check: 3, step: lastCompiled.step, request: lastCompiled.id, message: `context-manager says its compile's plan didn't meet the budget (planned ${plan.planned}, actual ${plan.actual})` });
    if (lastCompiled && plan?.exhausted === true) flags.push({ check: 3, step: lastCompiled.step, request: lastCompiled.id, message: 'context-manager says its compile exhausted its plan' });
    for (const k of ['compiled', 'continuation']) if (least[k]) headroom.push(least[k]);
  }
  const notes = [...windowBoots].map((boot) => `the host reported that ${agent}'s stream breaks mid-turn only at its window (boot ${boot}), so its continuation rounds weren't held to the stream bound`);
  return { flags, headroom, notes };
}

/**
 * The head window's size at each segment's checkpoint, as the host's health panel reports the
 * last compile's composition (`contextComposition.<agent>.head.messages`), keyed by segment.
 */
export function headCounts(log, agent = FIXTURE_AGENT) {
  const counts = new Map();
  for (const e of log) {
    if (e.kind !== 'checkpoint') continue;
    const head = panelAt(e, agent).composition?.head;
    if (typeof head?.messages === 'number') counts.set(e.name, head.messages);
  }
  return counts;
}

/**
 * Where a step's request finds its head window in the store: the last topic-transition message
 * stored before the step's own input, else the store's first message. context-manager starts
 * the head there (`getHeadWindowStartIndex`, restored from the last topic transition message).
 */
export function headStart(store, step) {
  const own = store.messages.findIndex((m) => m.canaries.includes(`[[c:${step}.in]]`));
  let start = 0;
  for (let i = 0; i < (own < 0 ? store.messages.length : own); i++) if (store.messages[i].topicTransition) start = i;
  return start;
}

/**
 * Check 6: the head window and the recent window stay raw. The head is N stored messages from
 * the request's head start (headStart: the last topic transition before it, else the store's
 * first message), N the head's message count the host reported at the request's segment's
 * checkpoint (headCounts). Each segment's last agent request, the one whose compile that
 * checkpoint describes, carries raw every input and reply canary among them that was stored
 * before it, as check 4 reads that: through its own turn's input and its turn's earlier
 * replies. No earlier request is held to that head, since the head moves as the calibration
 * does and the run keeps no head for the compiles before; a head message one of them drops,
 * and the segment's last request carries, goes unseen. Each agent
 * request also carries raw the input and reply canaries of the two turns before its own.
 * And each segment's last agent request, the one whose compile the checkpoint's panel
 * describes, carries raw every input and reply canary among the newest messages stored before
 * it, as many as the raw tail the host reported (`contextComposition.<agent>.tail.messages`).
 * With no store read (a configuration that keeps no summaries) only the two turns before
 * each request are checked.
 */
export function windowsRaw(records, script, log, store, { agent = FIXTURE_AGENT } = {}) {
  const flags = [];
  const turns = script.filter((s) => Array.isArray(s.replies) && s.replies.length);
  const before = new Map(turns.map((s, i) => [s.id, turns.slice(Math.max(0, i - 2), i)]));
  const segmentOf = new Map(turns.map((s) => [s.id, s.segment]));
  const heads = headCounts(log, agent);
  const lasts = segmentLasts(records, script);
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
    if (store && ownInput !== undefined && lasts.has(r)) {
      const storedBefore = new Set([...order.slice(0, ownInput + 1), ...Array.from({ length: n - 1 }, (_, k) => `[[c:${r.step}.r${k + 1}]]`)]);
      if (!heads.has(segmentOf.get(r.step))) {
        flags.push({ check: 6, step: r.step, request: r.id, message: `no head size was reported at segment ${segmentOf.get(r.step)}'s checkpoint` });
      } else {
        const from = headStart(store, r.step);
        const head = store.messages.slice(from, from + heads.get(segmentOf.get(r.step))).flatMap((m) => m.canaries.filter(conversational)).filter((c) => storedBefore.has(c));
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
  for (const { segment, request, n, composition } of lastRequests(records, script, log, agent)) {
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
 * carries runs in store order within each window, a summary by the first message it covers,
 * since context-manager renders the head first and, after a head-window reset, the history
 * before the head after it. Each segment's last agent request is held to store order within
 * its head window (headStart and the head size its segment's checkpoint reported, which
 * describes that request's compile alone) and within everything else it carries. Any other
 * request, and one whose head size wasn't reported, is held to store order within what was
 * stored from its head's start on and within what was stored before it, so a message past its
 * head window carried ahead of the history from before its head's start goes unseen there. A tool
 * result's canary isn't required, since pruning replaces older results by design. A summary
 * number no store read maps is flagged, never counted either way.
 */
export function coverage(records, store, script = [], log = [], { agent = FIXTURE_AGENT } = {}) {
  const flags = [];
  const segmentOf = new Map(script.map((s) => [s.id, s.segment]));
  const heads = headCounts(log, agent);
  const lasts = segmentLasts(records, script);
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
    const size = lasts.has(r) ? heads.get(segmentOf.get(r.step)) : undefined;
    const from = headStart(store, r.step);
    const head = size === undefined ? null : new Set(store.messages.slice(from, from + size).flatMap((m) => m.canaries));
    const boundary = store.messages.slice(0, from).flatMap((m) => m.canaries.filter(conversational)).length;
    const raw = (c, i) => (head ? (head.has(c) ? 'head' : 'rest') : i >= boundary ? 'from' : 'before');
    const summary = (i) => (head ? 'rest' : i >= boundary ? 'from' : 'before');
    const within = { head: 'its head window', rest: 'messages past its head window', from: "what was stored from its head's start on", before: "what was stored before its head's start" };
    const last = {};
    for (const m of r.messages || []) {
      for (const b of m.blocks) {
        const items = [
          ...(b.canaries || []).filter(conversational).map((c) => [c, at.get(c)]).map(([c, i]) => [c, i, raw(c, i)]),
          ...(b.summaries || []).filter((x) => covers.has(x)).map((x) => [x, Math.min(...covers.get(x).filter(conversational).map((c) => at.get(c) ?? Infinity))]).map(([x, i]) => [x, i, summary(i)]),
        ].filter(([, i]) => Number.isFinite(i));
        for (const item of items) {
          const before = last[item[2]];
          if (before && item[1] < before[1] && !flags.some((f) => f.request === r.id && /store order/.test(f.message))) {
            flags.push({ check: 4, step: r.step, request: r.id, message: `it carries ${item[0]} after ${before[0]}, out of store order${head || boundary > 0 ? ` within ${within[item[2]]}` : ''}` });
          }
          last[item[2]] = item;
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
