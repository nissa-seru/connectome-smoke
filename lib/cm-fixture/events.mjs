import { createHash } from 'node:crypto';

/**
 * The context-manager characterization fixture's trace: what one run of one configuration through one workload
 * records, one JSON event per line, and the calls the driver makes to the recorder while the run goes. The driver
 * (driver.mjs) runs the workload and calls the recorder; the recorder (trace.mjs) writes the events; the comparison
 * (compare.mjs) reads the base's and the candidate's trace of one run and says what diverged, in which class.
 *
 * A trace is a file of events in the order they happened. The first is `run`, the last is `end`; a trace without
 * an `end` was cut off, and the comparison refuses it. Every event has `kind`. Events inside a step have `step`, the
 * workload's turn number from 1 (0 for what the driver does before its first turn), and `n`, the event's ordinal
 * among events of its kind in that step, from 0.
 *
 * Kinds, and how the comparison reads each field. "Fixture" fields are the driver's and must be equal in both arms
 * of a run; a difference there is a fixture defect, and the comparison stops on it rather than report a divergence.
 * Every other field belongs to one class of the merged design's report (outcome, selection, bytes, summariser,
 * store, log, cache, invariant), or is reported only.
 *
 * - `run`: { kind, schema, run, config, workload, variant, arm, seed, scale, from, library, membrane, fixture,
 *   only? }
 *   `run`, `config`, `workload`, `variant`, `seed`, `scale`, `from`, `membrane.version` and `fixture.version` are
 *   fixture fields. `arm` is 'base' or 'candidate'. `from` is the checkpoint key a continuation starts from, or
 *   null for a run from empty. `library` ({ commit, version }) is reported only: it differs between arms by design.
 *   `only: 'candidate'` declares a run of a configuration the base can't run, such as a mode the change adds: it
 *   runs in the candidate alone, twice, and is read for its invariants and its determinism rather than compared.
 * - `blob`: { kind, id, value }. A value named by its digest (`digest(value)`), written once per trace, before the
 *   first event that names it. Message content, requests, summary content, log lines and error messages are blobs.
 * - `action`: { kind, step, n, op, args, result? }. A public-API call the workload made: `op` one of ACTION_OPS.
 *   `args` is a fixture field (for `add`, { participant, content: blob }); `result` is what the library returned,
 *   store class, but for `add`, whose result is the store id, reported only.
 * - `compile`: { kind, step, n, budget, outcome, error?, messages?, system?, layout?, stats?, rewritten?,
 *   receipt?, violations }
 *   - `budget` ({ maxTokens, reserveForResponse }) is a fixture field.
 *   - `outcome` ('compiled' or 'refused') and `error.class` are outcome class. `error.message` (a blob) and the
 *     error's own fields (`error.fields`, such as `clearedBy`, the floor and the budget) are reported only.
 *   - `messages`: one entry per compiled message, { sources, content, marker? }. `sources` is the message's
 *     provenance as source strings (`sourceStrings`), each stored message named by `addedName` where the run added
 *     it; the list of every message's sources is selection class. Wherever a trace names a stored message (sources,
 *     checkpoint messages, summaries' level-0 sources, pins, holds, the layout's member ids), it uses that name.
 *     `content` is a blob of the message as sent with cache markers taken out (`normalizeMessage`): bytes class,
 *     compared only between messages whose sources match. `marker` is the message's cache marker, kept apart from
 *     its bytes: selection class.
 *   - `system`: a blob of the system injections, bytes class.
 *   - `layout` (the provenance's rendered layout, without its store sequence numbers) and `stats`
 *     (`getRenderStats()`): selection class, compared only where `messages` and `system` are equal in both arms.
 *     Every field of either whose name ends in `Ms` is a timing, recorded as '*'.
 *   - `rewritten`: the share of this request's content, 0 to 1, that differs from the previous compiled request in
 *     the run, by content with markers taken out; absent on a run's first compile. `receipt` ({ accepted,
 *     withReference }) is what the driver reported for this compile (H1). Both cache class.
 *   - `violations`: the invariants this compile breaks, each { invariant, detail } with `invariant` one of
 *     INVARIANTS: invariant class.
 * - `call`: { kind, step, n, carried, target, request, answer }. One summariser request as the stand-in got it.
 *   `carried` is the set of canaries and recalled summary ids the request carries, its sources and its context
 *   together, sorted, without repeats. The comparison pairs the calls of a step by `carried`: a call only one arm
 *   made is a summariser divergence, and the rest compare field by field. `target` is the token target the
 *   request's own wording states. `request` is a blob of the request's messages and system as membrane formatted
 *   them. `answer` is { kind, text? }: `kind` one of ANSWER_KINDS, `text` a blob when the stand-in answered with
 *   text. All summariser class.
 * - `step`: { kind, step, written, removed, waiting, pending, ready, logs, lines, violations }. Written once the
 *   step's last settle is done.
 *   - `written`: the summaries present now and not at the previous step, each { id, level, sources, content }
 *     with `content` a blob: what came of the step's summariser answers, summariser class. `removed`: the summary
 *     ids present at the previous step and not now, store class.
 *   - `waiting` (`getWaitingWork()`), `pending` (`getPendingWork()`) and `ready` (`isReady()`): store class.
 *   - `logs`: { tag: count } of the lines the library logged during the step, by `logTag`: log class. `lines`:
 *     the step's lines as blobs, each with its timing fields masked (`maskTiming`), in order: reported only.
 *   - `violations`: checks the workload itself made in this step and found broken (`violation()` on the
 *     recorder), as in a compile: invariant class.
 * - `checkpoint`: { kind, step, label, messages, summaries, pins, holds, waiting, pending, ready, maxLevel,
 *   derivation, branches, settings, violations }. The store read through the public API at a phase's end
 *   (`label` 'phase:NAME') and at the run's end ('end'). `messages` is [id, participant, content blob] for each
 *   stored message; `summaries` is each summary's { id, level, sourceLevel, sources, parent, tokens, content };
 *   `branches` is each branch's { id, name, head }, without the creation time the store's native clock sets. All
 *   store class, `violations` invariant class.
 * - `end`: { kind, ok, error?, wallMs, logs?, lines? }. `ok` false with `error` ({ class, message: blob, where:
 *   'library' or 'driver' }) when the run stopped on a throw outside a compile: outcome class. `wallMs` is reported
 *   only. `logs` and `lines` are the lines logged after the last step, as in a step, when there are any.
 *
 * A field the library at one arm doesn't expose (a method one version lacks, or a read that throws) is
 * `{ unreadable: REASON }` rather than a throw (`readable()`). The comparison reports an unreadable field beside a
 * readable one, and never as a match.
 */
export const SCHEMA = 1;

export const KINDS = ['run', 'blob', 'action', 'compile', 'call', 'step', 'checkpoint', 'end'];

/** The public-API calls a workload makes besides compiling, as `action.op`. */
export const ACTION_OPS = [
  'open', 'add', 'tools', 'reopen', 'pin', 'pin-level', 'unpin', 'hold', 'release-hold', 'settings', 'derive',
  'remove', 'edit', 'reset-head', 'budget', 'release-answers', 'close', 'dry-compile', 'branch-at', 'switch',
  'construct', 'tick', 'lock', 'mark-document', 'report', 'fault',
];

/** The merged design's invariants (§4), and the workload's own checks, as `violations[].invariant`. */
export const INVARIANTS = [
  'coverage', 'budget', 'shape', 'windows', 'bookkeeping', 'dropped', 'pins', 'thinking', 'beside-sources',
  'workload',
];

/** How the stand-in answered a summariser request, as `call.answer.kind`. */
export const ANSWER_KINDS = ['text', 'refusal', 'empty', 'thinking-only', 'max-tokens', 'over-long', 'throw', 'held'];

const CONFIG = /^(C[1-9]|H[1-4](\.[a-z0-9][a-z0-9.-]*)?)$/;
const WORKLOAD = /^W([1-9]|1[01])$/;
const VARIANT = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A run's id, `CONFIG/WORKLOAD` or `CONFIG/WORKLOAD/VARIANT`: CONFIG is C1–C9 or H1–H4, an H configuration
 * optionally naming its model family after a dot (`H1.claude-opus-4-6`); WORKLOAD is W1–W11; VARIANT names a
 * workload's setting, such as W7's ladder rung or W10's speculative setting.
 */
export function runId({ config, workload, variant = null }) {
  const id = variant === null ? `${config}/${workload}` : `${config}/${workload}/${variant}`;
  parseRunId(id);
  return id;
}

/** `{ config, workload, variant }` from a run id, or a throw naming what's wrong with it. */
export function parseRunId(id) {
  const parts = typeof id === 'string' ? id.split('/') : [];
  const [config, workload, variant = null] = parts;
  if (parts.length < 2 || parts.length > 3 || !CONFIG.test(config) || !WORKLOAD.test(workload) || (variant !== null && !VARIANT.test(variant))) {
    throw new Error(`not a run id: ${JSON.stringify(id)} (CONFIG/WORKLOAD[/VARIANT], CONFIG C1-C9 or H1-H4[.family], WORKLOAD W1-W11)`);
  }
  return { config, workload, variant };
}

/** The file a run's trace is written to, inside an arm's trace directory. */
export const traceFileName = (id) => `${parseRunId(id) && id.replaceAll('/', '__')}.jsonl`;

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
 * A stored message's name in a trace: `aSTEP.N` for a message this run added (its `add` action's step and ordinal),
 * and its store id for one that was in the store when the run opened it. A store numbers its messages from a sequence
 * its summaries and other records share, so one message's id differs between two arms once their summaries do; its
 * `add` doesn't.
 */
export const addedName = (step, n) => `a${step}.${n}`;

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

/** The tag a logged line is counted under: its leading `[NAME]`, such as `[compression-quarantine]`, or '(untagged)'. */
export function logTag(line) {
  const m = /^\s*\[([^\]\s]{1,80})\]/.exec(String(line));
  return m ? m[1] : '(untagged)';
}

/**
 * A logged line with what varies between runs of one tree masked: the value of every field whose name ends in `Ms`
 * (`compileMs=12`, `planMs: 3`), and the ` ns=NAMESPACE` suffix context-manager's diagnostics add.
 */
export function maskTiming(line) {
  return String(line)
    .replace(/\b([A-Za-z]*Ms)(\s*[=:]\s*)-?[0-9]+(\.[0-9]+)?/g, '$1$2*')
    .replace(/ ns=\S+/g, '');
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

const isInt = (v) => Number.isInteger(v) && v >= 0;
const isId = (v) => typeof v === 'string' && /^[0-9a-f]{16}$/.test(v);
const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isViolations = (v) => Array.isArray(v) && v.every((x) => x && INVARIANTS.includes(x.invariant) && typeof x.detail === 'string');
const isError = (v) => v && typeof v.class === 'string' && isId(v.message);

const FIELDS = {
  run: { required: ['schema', 'run', 'config', 'workload', 'variant', 'arm', 'seed', 'scale', 'from', 'library', 'membrane', 'fixture'], optional: ['only'] },
  blob: { required: ['id', 'value'], optional: [] },
  action: { required: ['step', 'n', 'op', 'args'], optional: ['result'] },
  compile: { required: ['step', 'n', 'budget', 'outcome', 'violations'], optional: ['error', 'messages', 'system', 'layout', 'stats', 'rewritten', 'receipt'] },
  call: { required: ['step', 'n', 'carried', 'target', 'request', 'answer'], optional: [] },
  step: { required: ['step', 'written', 'removed', 'waiting', 'pending', 'ready', 'logs', 'lines', 'violations'], optional: [] },
  checkpoint: { required: ['step', 'label', 'messages', 'summaries', 'pins', 'holds', 'waiting', 'pending', 'ready', 'maxLevel', 'derivation', 'branches', 'settings', 'violations'], optional: [] },
  end: { required: ['ok', 'wallMs'], optional: ['error', 'logs', 'lines'] },
};

/** Why `event` isn't a well-formed event of this schema, or null when it is. */
export function eventProblem(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return 'not an object';
  const spec = FIELDS[event.kind];
  if (!spec) return `unknown kind ${JSON.stringify(event.kind)}`;
  for (const f of spec.required) if (!(f in event)) return `${event.kind} without ${f}`;
  for (const f of Object.keys(event)) if (f !== 'kind' && !spec.required.includes(f) && !spec.optional.includes(f)) return `${event.kind} with unknown field ${f}`;
  if ('step' in event && !isInt(event.step)) return `${event.kind}.step is not a whole number`;
  if ('n' in event && !isInt(event.n)) return `${event.kind}.n is not a whole number`;
  switch (event.kind) {
    case 'run':
      if (event.schema !== SCHEMA) return `schema ${event.schema}, not ${SCHEMA}`;
      try { const p = parseRunId(event.run); if (p.config !== event.config || p.workload !== event.workload || p.variant !== event.variant) return 'run id disagrees with config, workload or variant'; } catch (err) { return err.message; }
      if (event.arm !== 'base' && event.arm !== 'candidate') return `arm ${JSON.stringify(event.arm)}`;
      if (event.from !== null && typeof event.from !== 'string') return 'run.from is neither null nor a checkpoint key';
      if ('only' in event && !(event.only === 'candidate' && event.arm === 'candidate')) return 'run.only is \'candidate\', on a candidate\'s run, or absent';
      return null;
    case 'blob':
      return isId(event.id) && event.id === digest(event.value) ? null : 'blob id is not its value\'s digest';
    case 'action':
      return ACTION_OPS.includes(event.op) ? null : `unknown action ${JSON.stringify(event.op)}`;
    case 'compile':
      if (event.outcome !== 'compiled' && event.outcome !== 'refused') return `outcome ${JSON.stringify(event.outcome)}`;
      if (event.outcome === 'refused' && !isError(event.error)) return 'a refused compile without its error';
      if (event.outcome === 'compiled' && !(Array.isArray(event.messages) && event.messages.every((m) => isStrings(m.sources) && isId(m.content)))) return 'a compiled compile without its messages';
      if (!isViolations(event.violations)) return 'compile.violations malformed';
      if ('rewritten' in event && !(typeof event.rewritten === 'number' && event.rewritten >= 0 && event.rewritten <= 1)) return 'compile.rewritten is not a share';
      return null;
    case 'call':
      if (!isStrings(event.carried) || !isInt(event.target) || !isId(event.request)) return 'call fields malformed';
      if (event.carried.some((c, i) => i > 0 && !(event.carried[i - 1] < c))) return 'call.carried is not sorted without repeats';
      if (!event.answer || !ANSWER_KINDS.includes(event.answer.kind)) return 'call.answer.kind unknown';
      return null;
    case 'step':
      if (!Array.isArray(event.written) || !isStrings(event.removed) || typeof event.logs !== 'object' || !Array.isArray(event.lines) || !isViolations(event.violations)) return 'step fields malformed';
      return null;
    case 'checkpoint':
      if (typeof event.label !== 'string' || !(event.label === 'end' || event.label.startsWith('phase:'))) return `checkpoint label ${JSON.stringify(event.label)}`;
      return isViolations(event.violations) ? null : 'checkpoint.violations malformed';
    case 'end':
      if (typeof event.ok !== 'boolean') return 'end.ok is not a boolean';
      if (!event.ok && !(isError(event.error) && (event.error.where === 'library' || event.error.where === 'driver'))) return 'a failed end without its error';
      return null;
    default:
      return null;
  }
}

/**
 * A trace's text read into `{ header, events, blobs, end }`, each blob resolvable from `blobs` by id. A malformed
 * event, a blob named before it's written, a trace that doesn't open with `run` or doesn't close with `end` is a
 * throw naming the line, never a partial trace.
 */
export function readTrace(text, name = 'trace') {
  const blobs = new Map();
  const events = [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let header = null, end = null;
  const named = (id, at) => { if (!blobs.has(id)) throw new Error(`${name}:${at}: names blob ${id} before it's written`); };
  lines.forEach((line, i) => {
    const at = i + 1;
    let event;
    try { event = JSON.parse(line); } catch { throw new Error(`${name}:${at}: not JSON`); }
    const problem = eventProblem(event);
    if (problem) throw new Error(`${name}:${at}: ${problem}`);
    if (end) throw new Error(`${name}:${at}: an event after end`);
    if (i === 0 && event.kind !== 'run') throw new Error(`${name}:1: a trace opens with run, not ${event.kind}`);
    if (i > 0 && event.kind === 'run') throw new Error(`${name}:${at}: a second run`);
    if (event.kind === 'blob') { blobs.set(event.id, event.value); return; }
    for (const id of blobIds(event)) named(id, at);
    if (event.kind === 'run') header = event;
    else if (event.kind === 'end') end = event;
    else events.push(event);
  });
  if (!header) throw new Error(`${name}: empty`);
  if (!end) throw new Error(`${name}: no end; the run was cut off`);
  return { header, events, blobs, end };
}

/** The blob ids an event names. */
export function blobIds(event) {
  const ids = [];
  const add = (v) => { if (isId(v)) ids.push(v); };
  switch (event.kind) {
    case 'action': add(event.args?.content); break;
    case 'compile':
      add(event.error?.message); add(event.system);
      for (const m of event.messages ?? []) add(m.content);
      break;
    case 'call': add(event.request); add(event.answer?.text); break;
    case 'step':
      for (const s of event.written) add(s.content);
      for (const l of event.lines) add(l);
      break;
    case 'checkpoint':
      if (Array.isArray(event.messages)) for (const m of event.messages) add(m[2]);
      if (Array.isArray(event.summaries)) for (const s of event.summaries) add(s.content);
      break;
    case 'end':
      add(event.error?.message);
      for (const l of event.lines ?? []) add(l);
      break;
    default: break;
  }
  return ids;
}

/**
 * What the driver calls on the recorder, in this order, for one run (trace.mjs implements it):
 *
 *   const rec = await openRecorder({ file, header })    // header: the `run` event's fields but kind and schema
 *   rec.action('open', args)                             // step 0: open, tools, settings before the first turn
 *   for each turn n from 1:
 *     rec.step(n)                                        // the step's events follow
 *     rec.added(participant, content, id)                // after each addMessage, with the id it returned: action 'add'
 *     rec.action(op, args, result)                       // after each other public-API call the workload makes
 *     rec.compiled(manager, budget, compiled)            // after a compile returns
 *     rec.refused(manager, budget, error)                // or after it throws
 *     rec.receipt({ accepted, withReference })           // H1: after reporting the step's latest compile's receipt
 *     rec.call({ request, target, carried, answer })     // from the stand-in, as it answers each summariser request
 *     rec.violation(invariant, detail)                   // a check the workload makes itself, such as W9's twin
 *     await rec.endStep(manager)                         // after the step's last settle
 *   await rec.checkpoint(manager, label)                 // at a phase's end, and 'end' before closing
 *   await rec.end(error)                                 // last; error is null, or { error, where } on a throw
 *
 * The recorder takes console.log, info, warn, error and debug from openRecorder to end, counting each line by its
 * tag; the driver writes nothing through console while a run goes. `call` may come between `step` and `endStep`
 * at any point, since a summariser request can be made during addMessage (eager compression), compile or a tick.
 */
export const RECORDER_CALLS = ['action', 'step', 'added', 'compiled', 'refused', 'receipt', 'call', 'violation', 'endStep', 'checkpoint', 'end'];
