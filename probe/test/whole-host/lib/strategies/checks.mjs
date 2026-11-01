import { maskRunVarying } from './compare.mjs';
import { CANARY } from './standin.mjs';
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

/**
 * Check 11: every compile the host made keeps the per-compile invariants (invariants.mjs
 * `checkCompile`, which the harness module runs in the host's process against the manager that
 * compiled): coverage, beside-sources, budget (context-manager's own count within the plannable
 * budget and its grace), shape, thinking and pins. Flags each breach the driver's `compiles` log
 * lines carry, named by the compile's agent, kind and invariant, and each compile the module
 * couldn't record.
 */
export function compileInvariants(log = []) {
  const flags = [];
  let judged = 0;
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    for (const line of e.lines ?? []) {
      if (line.outcome === 'compiled') judged++;
      if (line.outcome === 'unrecordable') flags.push({ check: 11, step: e.step, what: `${line.agent}:${line.kind}:unrecordable`, message: `the harness module couldn't record ${line.agent}'s ${line.kind} compile ${line.seq}: ${line.reason}` });
      for (const v of line.violations ?? []) flags.push({ check: 11, step: e.step, what: `${line.agent}:${line.kind}:${v.invariant}`, detail: v.detail, message: `${line.agent}'s ${line.kind} compile ${line.seq} breaks ${v.invariant}: ${v.detail}` });
    }
  }
  return withJudged(flags, judged);
}

/**
 * Check 13: every request compile the run's agent sent reached the provider. A compile line
 * compileKinds pairs with no request the stand-in received is a request agent-framework compiled
 * and never sent, or a pairing that went wrong; either way check 3's kinds can't be trusted
 * past it, so it's a flag, at the step its batch was logged at.
 */
export function pairing(records, log = [], agent = FIXTURE_AGENT) {
  const paired = requestPairs(records, log, agent);
  if (!paired) return withJudged([], 0);
  return withJudged(paired.unpaired.map((l) => ({ check: 13, step: l.step ?? 'the run', what: `${agent}:unpaired`, message: `${agent}'s request compile ${l.seq} (assembly ${l.assembly}) went out in no request the stand-in received: a compile agent-framework never sent, or a pairing that went wrong` })), paired.pairs.length);
}

/**
 * Check 12: a restart reloads what it stopped with. For each `reload` the driver logged (a restart
 * step with `reloadCheck`), the dry compile after the boot is the one before the shutdown: the same
 * outcome, the same messages from the same stored sources with the same content, and the same
 * system injections. Content is compared with the run-varying parts masked, since an image ref's
 * nonce is per process. A compile line the log doesn't hold is couldn't-judge.
 */
export function reloads(log = []) {
  const flags = [];
  const lines = new Map();
  const blobs = {};
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    Object.assign(blobs, e.blobs ?? {});
    for (const l of e.lines ?? []) lines.set(`${e.boot}:${l.seq}`, l);
  }
  const held = (id) => JSON.stringify(maskRunVarying(blobs[id] ?? null));
  const shape = (l) => ({
    outcome: l.outcome,
    error: l.error?.class ?? null,
    messages: (l.messages ?? []).map((m) => ({ sources: m.sources, content: held(m.content) })),
    system: held(l.system),
  });
  let judged = 0;
  for (const e of log) {
    if (e.kind !== 'reload') continue;
    const [before, after] = [e.before, e.after].map((at) => (at?.seq == null ? null : lines.get(`${at.boot}:${at.seq}`) ?? null));
    const step = e.step;
    if (!before || !after) { flags.push({ check: 12, step, message: `couldn't judge the reload: the log holds no dry compile line ${!before ? 'before the restart' : 'after it'}` }); continue; }
    judged++;
    const [a, b] = [shape(before), shape(after)];
    if (a.outcome !== b.outcome || a.error !== b.error) { flags.push({ check: 12, step, message: `after the restart the dry compile ${b.outcome === 'refused' ? `refused (${b.error})` : 'compiled'}, where before it ${a.outcome === 'refused' ? `refused (${a.error})` : 'compiled'}` }); continue; }
    const n = Math.max(a.messages.length, b.messages.length);
    const at = [...Array(n).keys()].find((i) => JSON.stringify(a.messages[i]) !== JSON.stringify(b.messages[i]));
    if (at !== undefined) flags.push({ check: 12, step, message: `after the restart the dry compile differs from the one before at message ${at} of ${a.messages.length} before and ${b.messages.length} after (sources ${JSON.stringify(a.messages[at]?.sources ?? null)} before, ${JSON.stringify(b.messages[at]?.sources ?? null)} after)` });
    if (a.system !== b.system) flags.push({ check: 12, step, message: 'after the restart the dry compile\'s system injections differ from the ones before' });
  }
  return withJudged(flags, judged);
}

/**
 * A check's flags with how many items it judged, as a property the flags' list carries without
 * enumerating it (so a list compares and spreads as its flags alone): the report prints every
 * check's count, and runChecks makes zero, where a check applies, a couldn't-judge flag.
 */
export function withJudged(flags, judged) {
  Object.defineProperty(flags, 'judged', { value: judged, enumerable: false });
  return flags;
}

/** Check 1: every turn answers. Requests the stand-in refused or couldn't classify, failure
 *  events and operator alerts (agent-framework's `ops:alert`, a compression quarantine or a
 *  context-maintenance failure among them) in the run log, and checkpoints that didn't settle.
 *  A turn the script marks `mayFail` may end without an answer by design, and its workload's
 *  property judges it: its inference's failure or exhaustion, and a compile refusal's alert at
 *  its step (`context-refusal`), are left to that property. */
export function everyTurnAnswers(records, log = [], script = []) {
  const mayFail = new Set(script.filter((s) => s.mayFail).map((s) => s.id));
  const owned = (e) => mayFail.has(e.step) && (/^inference:(failed|exhausted)$/.test(e.event?.type ?? '') || (e.event?.type === 'ops:alert' && e.event.kind === 'context-refusal'));
  const flags = [];
  withJudged(flags, records.length);
  for (const r of records) {
    if (r.kind === 'unclassified') flags.push({ check: 1, step: r.step, request: r.id, message: `unclassified request: ${r.reason}` });
    else if (r.refused) flags.push({ check: 1, step: r.step, request: r.id, message: `the stand-in refused it (${r.refused})` });
  }
  for (const e of log) {
    if (e.kind === 'ipc' && owned(e)) continue;
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

/** Whether a stand-in record is the run's own agent's: the primary's, not a subagent's or a reader's (standin.mjs `agent`). */
export const ofSide = (side = 'primary') => (r) => r.kind === 'agent' && (r.agent ?? 'primary') === side;
export const primary = ofSide('primary');

/**
 * Each segment's agent requests of one side, the primary's unless `side` names the second agent's
 * (`sub`, as the stand-in's records name a subagent's or the reader's), in the order they
 * arrived, keyed by segment.
 */
function segmentAgents(records, script, side = 'primary') {
  const segmentOf = new Map(script.map((s) => [s.id, s.segment]));
  const bySegment = new Map();
  const mine = ofSide(side);
  for (const r of records) {
    if (!mine(r) || !segmentOf.has(r.step)) continue;
    const segment = segmentOf.get(r.step);
    bySegment.set(segment, [...(bySegment.get(segment) ?? []), r]);
  }
  return bySegment;
}

/** Each segment's last agent request: the one whose compile its checkpoint's panel describes. */
const segmentLasts = (records, script) => new Set([...segmentAgents(records, script).values()].map((agents) => agents.at(-1)));

/**
 * Each request assembly of `agent` in the run's log, as the harness module's compile lines
 * (module.mjs) record them: the agent's own path compiling a request, once or, where
 * `compileUnpinningOnRefusal` retries a refusal, more than once. Each is its last `request` line,
 * the compile its request was sent from (`outcome: 'compiled'`) or the refusal it ended in, with the
 * step and boot of the batch that took it. An agent assembles one request at a time, so an
 * assembly's lines come one after another; a host process numbers its compiles and assemblies from
 * 1, and a run may hold several processes (restarts, and the writer's extensions, each its own run
 * of the driver), so lines are read in log order, and one whose seq isn't above the one before it
 * starts another process's.
 */
export function assemblies(log = [], agent = FIXTURE_AGENT) {
  const out = [];
  let previous = null;
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    for (const l of e.lines ?? []) {
      if (l.agent !== agent || l.kind !== 'request' || !['compiled', 'refused'].includes(l.outcome)) continue;
      const same = previous && l.seq > previous.seq && l.assembly === previous.assembly;
      const at = { ...l, step: e.step ?? null, boot: e.boot ?? null };
      if (same) out[out.length - 1] = at;
      else out.push(at);
      previous = l;
    }
  }
  return out;
}

/**
 * Each agent request of `agent` the stand-in received, paired with the compile it was sent from
 * (K2e). The assemblies that compiled (assemblies) take the stand-in's agent requests in order: a
 * request whose last canary is the next such compile's last canary was sent from it, and any other
 * is a continuation round, which compiles nothing. agent-framework restarts a stream by compiling
 * again, and a passthrough's restart sends what a continuation would have, so the requests alone
 * would read a restart as a continuation. Returns `{ pairs, continuations, unpaired }`:
 * `pairs` `[{ line, request }]` in order, `continuations` the requests no compile was sent as, and
 * `unpaired` the compiles no request took; null where the log has no compile line for `agent`, as
 * with the module off. The stand-in tells a second agent's requests (a subagent's, the reader's)
 * from the primary's (its records' `agent`, `sub` or `primary`); `side` says which are `agent`'s,
 * the primary's where `agent` is the fixture's agent and the second agent's otherwise.
 */
export function requestPairs(records, log = [], agent = FIXTURE_AGENT, { side = agent === FIXTURE_AGENT ? 'primary' : 'sub' } = {}) {
  const sent = assemblies(log, agent).filter((l) => l.outcome === 'compiled');
  if (!sent.length) return null;
  const blobs = Object.assign({}, ...log.filter((e) => e.kind === 'compiles').map((e) => e.blobs ?? {}));
  const lineCanary = (l) => {
    for (let i = (l.messages ?? []).length - 1; i >= 0; i--) {
      const found = JSON.stringify(blobs[l.messages[i].content] ?? '').match(CANARY);
      if (found) return found.at(-1);
    }
    return null;
  };
  const requestCanary = (r) => (r.messages ?? []).flatMap((m) => (m.blocks ?? []).flatMap((b) => b.canaries ?? [])).at(-1) ?? null;
  const pairs = [];
  const continuations = [];
  let next = 0;
  for (const r of records) {
    if (r.kind !== 'agent' || (r.agent ?? 'primary') !== side) continue;
    const here = requestCanary(r);
    if (next < sent.length && here !== null && lineCanary(sent[next]) === here) pairs.push({ line: sent[next++], request: r });
    else continuations.push(r);
  }
  return { pairs, continuations, unpaired: sent.slice(next) };
}

/**
 * K2e: which agent requests a compile was sent from (requestPairs): `{ kinds, unpaired }`, each
 * request `compiled` or `continuation`, and `unpaired` the compiles no request took; null where
 * the log has no compile line for `agent`.
 */
export function compileKinds(records, log = [], agent = FIXTURE_AGENT) {
  const paired = requestPairs(records, log, agent);
  if (!paired) return null;
  const kinds = new Map();
  for (const { request } of paired.pairs) kinds.set(request.id, 'compiled');
  for (const r of paired.continuations) kinds.set(r.id, 'continuation');
  return { kinds, unpaired: paired.unpaired };
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
 * A continuation round's stream's fresh input before it: the stand-in's `input_tokens` summed from
 * the stream's compiled request (the last one before `r` in its turn) through the request before
 * `r`, as membrane sums its usage event over a stream's rounds. Null when a request on the way has
 * no `input_tokens`, or no compiled request opens the stream in `r`'s turn.
 */
function streamFreshBefore(agentRequests, r, kinds) {
  let sum = 0;
  for (let i = agentRequests.indexOf(r) - 1; i >= 0; i--) {
    const x = agentRequests[i];
    if (x.step !== r.step) return null;
    // A provider error's round reports no usage, so membrane adds nothing for it.
    if (x.answer?.shape !== 'error') {
      if (typeof x.usage?.input_tokens !== 'number') return null;
      sum += x.usage.input_tokens;
    }
    if (kinds.get(x.id) === 'compiled') return sum;
  }
  return null;
}

/**
 * Check 3's budget: each agent request of the run's agent against the bound that governs it, each
 * bound the promise of the layer that keeps it. Every request is judged, by its script segment,
 * whether or not the segment ends at a checkpoint: a workload's steps have none. The run's agent
 * is the primary, or the second agent `agent` names (a subagent, the reader), by the stand-in's
 * records' `agent`.
 * - A compiled request (its turn's first, or a restart's, as the harness module's compile lines say:
 *   compileKinds) is flagged when the stand-in's count of its whole input (system prompt, tools and messages, its usage) exceeds
 *   the model's window (`windowTokens`), the limit a provider refuses on. Whether
 *   context-manager kept its own count within the plannable budget is the compile invariants'
 *   `budget` check (compileInvariants), which reads context-manager's count: the stand-in's token
 *   model differs from context-manager's estimator by several percent either way, so the
 *   stand-in's count against the plannable budget would flag the stand-in's arithmetic.
 * - A continuation round is flagged when its stream's fresh input so far, before it, is over the
 *   stream bound: agent-framework restarts rather than continues once that passes
 *   `maxStreamTokens` (framework.ts, `lastStreamInputTokens`), and that is membrane's usage
 *   event's `inputTokens`, summed over the stream's rounds (turn-usage.ts `addRound`), each the
 *   provider's input_tokens, which leaves out cache reads and writes. So the check sums the
 *   stand-in's `input_tokens` from the stream's compiled request through the request before the
 *   continuation. A request's whole input against the stream bound would flag a warm stream
 *   agent-framework rightly continued. Every continuation's whole input is also held to the
 *   model's window, as a compiled request's is. All this unless the agent's thinking binds and its window
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
 * `planVsActual.budgetMet` and `exhausted` aren't read: `budgetMet` is false whenever the plan
 * sits between context-manager's soft target and its plannable budget (picker.ts), and neither
 * says the compile went over.
 * A run whose log holds no request compile line of the agent's, though it made requests, can't be
 * judged: nothing then tells a compiled request from a continuation round, so the check flags it,
 * naming the agent, and judges none (`judged` null, so the report counts it as unknown rather than
 * as nothing judged). A request with no usage recorded, and a segment that made no agent request,
 * are flags too, never passes. A request the stand-in answered with a provider error
 * isn't judged: no usage comes back for it, and the retry agent-framework makes is judged instead. Returns
 * `{ flags, headroom, notes, judged, requests }`, headroom being each segment's least, per kind of
 * request: `{ segment, kind, request, tokens, bound }`; `judged` the requests held to a bound and
 * `requests` the run's agent's requests.
 */
export function budgets(records, script, log = [], { agent = FIXTURE_AGENT, streamBound = STREAM_BOUND, windowTokens } = {}) {
  const flags = [];
  const headroom = [];
  let judged = 0;
  const paired = compileKinds(records, log, agent);
  const kinds = paired?.kinds ?? new Map();
  const reports = budgetReports(log, agent);
  const windowBoots = new Set();
  // The primary's requests, or a second agent's where `agent` names it (requestPairs' `side`).
  const side = agent === FIXTURE_AGENT ? 'primary' : 'sub';
  const own = records.filter((r) => r.kind === 'agent' && (r.agent ?? 'primary') === side);
  const agentRequests = own;
  if (!paired && own.length) {
    return { flags: [{ check: 3, step: 'the run', what: 'no-compile-lines', message: `couldn't judge ${agent}'s ${own.length} request(s): the log holds no request compile line of ${agent}'s, so nothing tells a compiled request from a continuation round` }], headroom: [], notes: [], judged: null, requests: own.length };
  }
  const bySegment = segmentAgents(own, script, side);
  for (const e of log) {
    if (e.kind === 'checkpoint' && !bySegment.has(e.name)) flags.push({ check: 3, step: e.step ?? e.name, message: `segment ${e.name} made no agent request` });
  }
  for (const [segment, agents] of bySegment) {
    const least = {};
    const room = (kind, r, tokens, bound) => {
      if (!least[kind] || bound - tokens < least[kind].bound - least[kind].tokens) least[kind] = { segment, kind, request: r.id, tokens, bound };
    };
    for (const r of agents) {
      // A request the stand-in answered with a provider error was refused before any count: no
      // usage comes back for it, and agent-framework's retry is the request that reaches the window.
      if (r.answer?.shape === 'error') continue;
      if (kinds.get(r.id) === 'compiled') {
        const whole = inputOf(r);
        if (whole === null || windowTokens === undefined) { flags.push({ check: 3, step: r.step, request: r.id, message: whole === null ? 'couldn\'t judge it: the stand-in recorded no usage for it' : 'couldn\'t judge it: the check was given no window' }); continue; }
        judged++;
        room('compiled', r, whole, windowTokens);
        if (whole > windowTokens) flags.push({ check: 3, step: r.step, request: r.id, message: `the stand-in counts its whole input at ${whole} tokens, over the model's ${windowTokens}-token window` });
      } else {
        const report = reports.get(r.id) ?? null;
        if (report && report.figure !== hostTokens(streamBound)) { flags.push({ check: 3, step: r.step, request: r.id, message: `couldn't judge this continuation round: the host reports ${agent}'s stream budget as ${report.figure}, and the check holds continuations to ${streamBound} (${hostTokens(streamBound)})` }); continue; }
        if (report?.window && report.windowFigure !== (windowTokens === undefined ? undefined : hostTokens(windowTokens))) { flags.push({ check: 3, step: r.step, request: r.id, message: `couldn't judge this continuation round: the host reports that ${agent}'s window, ${report.windowFigure ?? 'which it doesn\'t name'}, governs its stream, and the stand-in refuses past ${windowTokens ?? 'no window it was given'}${windowTokens === undefined ? '' : ` (${hostTokens(windowTokens)})`}` }); continue; }
        if (report?.window) { windowBoots.add(report.boot); continue; }
        const own = inputOf(r);
        if (own !== null && windowTokens !== undefined && own > windowTokens) flags.push({ check: 3, step: r.step, request: r.id, message: `the stand-in counts this continuation round's whole input at ${own} tokens, over the model's ${windowTokens}-token window` });
        const fresh = streamFreshBefore(agentRequests, r, kinds);
        if (fresh === null) { flags.push({ check: 3, step: r.step, request: r.id, message: 'couldn\'t judge this continuation round: a request of its stream before it has no usage recorded, or its stream has no compiled request in its turn' }); continue; }
        judged++;
        if (typeof r.usage?.input_tokens === 'number') room('continuation', r, fresh + r.usage.input_tokens, streamBound);
        if (fresh > streamBound && !report) flags.push({ check: 3, step: r.step, request: r.id, message: `couldn't judge this continuation round: its stream's fresh input before it was ${fresh} tokens, over the stream bound ${streamBound}, and no report of the host's stream budget for ${agent} came before it to say whether agent-framework breaks the stream there or only at the window` });
        else if (fresh > streamBound) flags.push({ check: 3, step: r.step, request: r.id, message: `a continuation round after its stream's fresh input reached ${fresh} tokens, over the stream bound ${streamBound}, past which agent-framework restarts rather than continues` });
      }
    }
    for (const k of ['compiled', 'continuation']) if (least[k]) headroom.push(least[k]);
  }
  const notes = [...windowBoots].map((boot) => `the host reported that ${agent}'s stream breaks mid-turn only at its window (boot ${boot}), so its continuation rounds weren't held to the stream bound`);
  return { flags, headroom, notes, judged, requests: own.length };
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
 * Only the run's own agent's requests are judged (a subagent's or a reader's see other
 * windows). The head is judged only for a segment that ends at a checkpoint, which reports its
 * size; a workload's segments don't. The recent window is held only to what it can hold: what
 * was stored and still is, with a store read; without one, the script's turns less what a
 * suppress step removed and the replies of a turn that ended without one.
 */
export function windowsRaw(records, script, log, store, { agent = FIXTURE_AGENT, side = 'primary' } = {}) {
  const own = ofSide(side);
  const flags = [];
  let judged = 0;
  const turns = script.filter((s) => Array.isArray(s.replies) && s.replies.length);
  const before = new Map(turns.map((s, i) => [s.id, turns.slice(Math.max(0, i - 2), i)]));
  const segmentOf = new Map(turns.map((s) => [s.id, s.segment]));
  const heads = headCounts(log, agent);
  const lasts = segmentLasts(records, script);
  const checkpointed = new Set(log.filter((e) => e.kind === 'checkpoint').map((e) => e.name));
  const order = store ? store.messages.flatMap((m) => m.canaries.filter(conversational)) : [];
  const at = new Map(order.map((c, i) => [c, i]));
  // What the recent window can hold: with a store read, what was stored and is still; without,
  // the script's turns less what a suppress step removed and the replies of a turn that ended
  // without one (an inference that failed or was exhausted at its step).
  const suppressed = new Set(script.filter((s) => s.op === 'suppress' || s.kind === 'suppress').flatMap((s) => (s.messages ?? []).map((m) => m.canary)).filter(Boolean));
  const failed = new Set(log.filter((e) => e.kind === 'ipc' && /^inference:(failed|exhausted)$/.test(e.event?.type ?? '')).map((e) => e.step));
  const held = (c, stepId) => (store ? at.has(c) : !suppressed.has(c) && !(failed.has(stepId) && /\.r\d+\]\]$/.test(c)));
  const asked = new Map();
  for (const r of records) {
    if (!own(r)) continue;
    // The step's replies so far: each earlier request of the step, but one the stand-in answered
    // with a provider error or a refusal (a scripted 529 gives no reply, and its retry is no new round).
    const n = (asked.get(r.step) ?? 0) + 1;
    asked.set(r.step, n - (['error', 'refused'].includes(r.answer?.shape) ? 1 : 0));
    if (!before.has(r.step)) continue;
    // Judged: a request held to at least one message, its head's or its recent window's.
    let heldTo = 0;
    const carried = new Set((r.messages || []).flatMap((m) => m.blocks).flatMap((b) => b.canaries || []));
    const ownInput = at.get(`[[c:${r.step}.in]]`);
    if (store && ownInput !== undefined && lasts.has(r) && checkpointed.has(segmentOf.get(r.step))) {
      const storedBefore = new Set([...order.slice(0, ownInput + 1), ...Array.from({ length: n - 1 }, (_, k) => `[[c:${r.step}.r${k + 1}]]`)]);
      if (!heads.has(segmentOf.get(r.step))) {
        flags.push({ check: 6, step: r.step, request: r.id, message: `no head size was reported at segment ${segmentOf.get(r.step)}'s checkpoint` });
      } else {
        const from = headStart(store, r.step);
        const head = store.messages.slice(from, from + heads.get(segmentOf.get(r.step))).flatMap((m) => m.canaries.filter(conversational)).filter((c) => storedBefore.has(c));
        heldTo += head.length;
        const lost = head.filter((c) => !carried.has(c));
        if (lost.length) flags.push({ check: 6, step: r.step, request: r.id, message: `the head window's ${lost.join(' ')} isn't raw` });
      }
    }
    for (const t of before.get(r.step)) {
      const wanted = [`[[c:${t.id}.in]]`, ...t.replies.map((_, k) => `[[c:${t.id}.r${k + 1}]]`)].filter((c) => held(c, t.id));
      heldTo += wanted.length;
      const missing = wanted.filter((c) => !carried.has(c));
      if (missing.length) flags.push({ check: 6, step: r.step, request: r.id, message: `the recent window lacks ${missing.join(' ')}` });
    }
    if (heldTo) judged++;
  }
  if (!store) return withJudged(flags, judged);
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
  return withJudged(flags, judged);
}

const conversational = (c) => /\.(in|r\d+)\]\]$/.test(c);

/**
 * Check 4, coverage read from the wire, against a store read (read-store.mjs): in each request
 * of the judged agent's (`side`: the primary's, or, judging a subagent, its `sub` requests against its own store),
 * every message stored before it that carries an input or reply canary (a subagent's: any canary, up to the last
 * the request carries, since the script's turns don't name its conversation) is there raw
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
export function coverage(records, store, script = [], log = [], { agent = FIXTURE_AGENT, side = 'primary' } = {}) {
  const own = ofSide(side);
  // A subagent's store is its own conversation, which the script's turns don't name: every
  // canary in it counts, and a request is held to what was stored up to the last of them it carries.
  const sub = side !== 'primary';
  const counted = sub ? () => true : conversational;
  const flags = [];
  let judged = 0;
  const segmentOf = new Map(script.map((s) => [s.id, s.segment]));
  const heads = headCounts(log, agent);
  const lasts = segmentLasts(records, script);
  const covers = new Map(store.summaries.filter((s) => s.number).map((s) => [s.number, s.covers]));
  const order = store.messages.flatMap((m) => m.canaries.filter(counted));
  const at = new Map(order.map((c, i) => [c, i]));
  const asked = new Map();
  for (const r of records) {
    if (!own(r)) continue;
    // The step's replies so far: each earlier request of the step, but one the stand-in answered
    // with a provider error or a refusal (a scripted 529 gives no reply, and its retry is no new round).
    const n = (asked.get(r.step) ?? 0) + 1;
    asked.set(r.step, n - (['error', 'refused'].includes(r.answer?.shape) ? 1 : 0));
    const shown = [];
    const unknown = [];
    for (const m of r.messages || []) {
      for (const b of m.blocks) {
        shown.push(...(b.canaries || []).filter(counted));
        for (const s of b.summaries || []) {
          if (covers.has(s)) shown.push(...covers.get(s).filter(counted));
          else unknown.push(s);
        }
      }
    }
    const ownInput = sub ? Math.max(-1, ...shown.map((x) => at.get(x) ?? -1)) : at.get(`[[c:${r.step}.in]]`);
    if (ownInput === undefined || ownInput < 0) continue;
    judged++;
    for (const s of new Set(unknown)) flags.push({ check: 4, step: r.step, request: r.id, what: 'unmapped-summary', message: `summary ${s} is in the request, and no store read maps it` });
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
          ...(b.canaries || []).filter(counted).map((c) => [c, at.get(c)]).map(([c, i]) => [c, i, raw(c, i)]),
          ...(b.summaries || []).filter((x) => covers.has(x)).map((x) => [x, Math.min(...covers.get(x).filter(counted).map((c) => at.get(c) ?? Infinity))]).map(([x, i]) => [x, i, summary(i)]),
        ].filter(([, i]) => Number.isFinite(i));
        for (const item of items) {
          const before = last[item[2]];
          if (before && item[1] < before[1] && !flags.some((f) => f.request === r.id && /store order/.test(f.message))) {
            flags.push({ check: 4, step: r.step, request: r.id, what: 'store-order', message: `it carries ${item[0]} after ${before[0]}, out of store order${head || boundary > 0 ? ` within ${within[item[2]]}` : ''}` });
          }
          last[item[2]] = item;
        }
      }
    }
    const count = new Map();
    for (const c of shown) count.set(c, (count.get(c) ?? 0) + 1);
    const wanted = [...order.slice(0, ownInput + 1), ...(sub ? [] : Array.from({ length: n - 1 }, (_, k) => `[[c:${r.step}.r${k + 1}]]`))];
    const missing = wanted.filter((c) => !count.has(c));
    const twice = wanted.filter((c) => count.get(c) > 1);
    if (missing.length) flags.push({ check: 4, step: r.step, request: r.id, what: 'not-reached', message: `${missing.length} stored message(s) reach the request neither raw nor in a summary: ${missing.slice(0, 5).join(' ')}${missing.length > 5 ? ' …' : ''}` });
    if (twice.length) flags.push({ check: 4, step: r.step, request: r.id, what: 'more-than-once', message: `${twice.length} message(s) reach the request more than once: ${twice.slice(0, 5).join(' ')}${twice.length > 5 ? ' …' : ''}` });
  }
  return withJudged(flags, judged);
}

/**
 * Check 5, the bookkeeping against what the summariser saw: every summary this run made
 * declares only sources its compression request showed, each child by its summary number,
 * by its own children's, or by the canaries of every message it covers. A source message without a canary,
 * such as a clock row or a later shard, can't be checked and is skipped.
 */
export function bookkeeping(records, store) {
  const flags = [];
  let judged = 0;
  const byNumber = new Map(store.summaries.filter((s) => s.number).map((s) => [s.number, s]));
  const byId = new Map(store.summaries.map((s) => [s.id, s]));
  const messages = new Map(store.messages.map((m) => [m.id, m]));
  for (const r of records) {
    const number = r.kind === 'summariser' ? r.answer?.summary : null;
    if (!number) continue;
    const s = byNumber.get(number);
    if (!s) continue;
    judged++;
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
  return withJudged(flags, judged);
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
  let judged = 0;
  for (const e of log) {
    if (e.kind !== 'checkpoint') continue;
    for (const m of multipliers(e.health)) {
      judged++;
      if (Math.abs(m - low) < 1e-9 || Math.abs(m - high) < 1e-9) flags.push({ check: 10, step: e.step, message: `calibration at the clamp edge (${m}) at checkpoint ${e.name}: the run is invalid` });
    }
  }
  return withJudged(flags, judged);
}

/** Check 3, the shape of each request: roles alternate, and every tool result answers a
 *  call in the message right before it, and every call before the last message is answered
 *  in the message right after it. */
export function wellFormed(records) {
  const flags = [];
  let judged = 0;
  for (const r of records) {
    if (r.kind !== 'agent' && r.kind !== 'summariser') continue;
    judged++;
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
  return withJudged(flags, judged);
}
