// The driver of the context-management characterization fixture: runs one configuration through one workload
// against one arm's context-manager, in this process, calling the recorder (events.mjs' RECORDER_CALLS) as it goes.
// It runs under bun, which loads context-manager from its `src` as residents' hosts do.
//
// Determinism, which the trace's comparison rests on:
// - the clock is virtual (`Date` is replaced for the process), set at a run's start and advanced at each step;
// - the model is the stand-in (standin.mjs), whose answers depend on what a request carries, never on time;
// - a library configuration drains by an explicit `tick()` loop after each turn, as its default
//   `autoTickOnNewMessage: false` leaves it to its host; a house configuration that compresses eagerly (H1, H2) is
//   left to its own drain, and the driver waits, by turns of the event loop and never for a length of time, until
//   no compression is in flight and none has started for QUIET_TURNS turns;
// - nothing reads the real clock for a decision.
//
// A continuation starts from a copy of a checkpoint store a released context-manager wrote (checkpoints.mjs): its
// store, and the clock it stopped at.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { StandinAdapter, StandinError, STANDIN_VERSION, mulberry32, mergeLevel } from './standin.mjs';
import { buildConfig, compresses, SCALE } from './configs.mjs';
import { normalizeMessage, sourceStrings } from './events.mjs';
import { checkpointPath } from './pool.mjs';

// ---------------------------------------------------------------------------------------------------------------
// The virtual clock, installed before any arm's library is loaded.

const RealDate = globalThis.Date;
export const EPOCH = RealDate.UTC(2026, 0, 5, 9, 0, 0);
let now = EPOCH;
function VirtualDate(...args) {
  if (!new.target) return new RealDate(now).toString();
  return Reflect.construct(RealDate, args.length === 0 ? [now] : args, new.target);
}
VirtualDate.prototype = RealDate.prototype;
VirtualDate.now = () => now;
VirtualDate.parse = RealDate.parse;
VirtualDate.UTC = RealDate.UTC;
Object.defineProperty(VirtualDate, 'name', { value: 'Date' });
Object.defineProperty(RealDate.prototype, 'constructor', { value: VirtualDate, writable: true, configurable: true, enumerable: false });
globalThis.Date = VirtualDate;

// Zero-delay timers the process has pending: an eager drain schedules each next tick on one (setTimeout 0), so
// a drain is still going while one is pending. Delayed timers (a call's deadline) don't count.
let zeroTimers = 0;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const pendingZero = new Set();
globalThis.setTimeout = function setTimeout(fn, ms, ...args) {
  if (!(ms > 0) && typeof fn === 'function') {
    let handle;
    const run = (...a) => { if (pendingZero.delete(handle)) zeroTimers--; return fn(...a); };
    handle = realSetTimeout(run, ms, ...args);
    pendingZero.add(handle);
    zeroTimers++;
    return handle;
  }
  return realSetTimeout(fn, ms, ...args);
};
globalThis.clearTimeout = function clearTimeout(handle) {
  if (pendingZero.delete(handle)) zeroTimers--;
  return realClearTimeout(handle);
};

export const clock = {
  set(ms) { now = ms; },
  advance(ms) { now += ms; },
  now: () => now,
};

/** Virtual time between steps: a resident's turn every four minutes. */
export const STEP_MS = 4 * 60 * 1000;
/** Turns of the event loop with nothing in flight and no call started, after which an eager drain counts as quiet. */
const QUIET_TURNS = 3;
/** The most turns of the event loop an eager drain may take before the run fails as one that never settles. */
const EAGER_LIMIT = 200_000;
/** The most ticks an explicit drain makes in one settle before it's a runaway. */
const TICK_LIMIT = 400;
/** Ticks in a row that change nothing, after which an explicit drain stops: the library won't do its queue now. */
const STUCK_TICKS = 3;

const AGENT = 'Junga';
const NAMESPACE = 'agents/junga';
/** What the agent's requests carry before their messages: agent-framework hashes this as the immutable prefix. */
const SYSTEM = `You are ${AGENT}. [cm-fixture:agent]`;
/** Every tool the workloads call (workloads.mjs' PHASE_PLAN names the rest), declared as a host declares its agent's. */
export const TOOLS = ['read_file', 'mcpl:read', 'mcpl:search', 'zulip:search', 'zulip:read', 'subagent:spawn', 'subagent:status', 'lessons:create', 'lessons:update', 'lessons:create-draft']
  .map((name) => ({ name, description: `The ${name} tool.`, inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }));
/** agent-framework's stableHash of { tools, system } (agent.ts' immutablePrefixHash): any fixed digest serves. */
const IMMUTABLE_PREFIX = createHash('sha256').update(JSON.stringify({ tools: TOOLS, system: SYSTEM })).digest('hex');

// ---------------------------------------------------------------------------------------------------------------
// An arm: one context-manager tree, loaded once per worker process.

/**
 * Load an arm's library from its tree, and membrane from the base's tree (one membrane for both arms, so membrane's
 * formatting is the same on each side and every difference in a request is context-manager's).
 */
export async function loadArm({ name, cmDir, membraneDir, commit }) {
  const cm = await import(join(cmDir, 'src/index.ts'));
  const membranePath = Bun.resolveSync('@animalabs/membrane', membraneDir);
  const membrane = await import(membranePath);
  const pkg = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  let membraneVersion = null;
  for (let dir = membranePath; dir !== '/'; dir = join(dir, '..')) {
    if (existsSync(join(dir, 'package.json')) && pkg(dir).name === '@animalabs/membrane') { membraneVersion = pkg(dir).version; break; }
  }
  // Where the library's own code lives, for telling its throws from the driver's: the tree, its real path, and the
  // real path of its packages (a copy of the tree may share another's node_modules through a link).
  const roots = [cmDir, realpathSync(cmDir)];
  if (existsSync(join(cmDir, 'node_modules'))) roots.push(realpathSync(join(cmDir, 'node_modules')));
  // The tree's own Chronicle, for a run that hands the manager a store of its own (a workload's `ownStore`).
  const chronicle = await import(Bun.resolveSync('@animalabs/chronicle', cmDir));
  return { name, cm, cmDir, libraryRoots: [...new Set(roots)], membrane, membraneVersion, chronicle, library: { commit, version: pkg(cmDir).version } };
}

// ---------------------------------------------------------------------------------------------------------------
// A run.


class DriverError extends Error {
  constructor(message) { super(message); this.name = 'DriverError'; }
}

/**
 * The view filter agent-framework opens a house configuration's manager with (framework.ts at a64cfc010f), so the
 * strategy reads through a filtered view as a resident's does:
 * - H1 and H3, a resident (createAgent, :15943-15973): held rows (metadata.tuneOut) and another agent's stored
 *   context injections (stored-injections.ts' mark under metadata.contextInjection) are left out;
 * - H4, the subconscious (createSubconsciousAgent, :16048-16059): another agent's stored injections are left out;
 * - H2, a knowledge subagent the subagent module spawns (createEphemeralAgent, :10896-10903): no filter (it opens
 *   isolated, which the fixture doesn't model).
 * The fixture writes neither mark, so every message passes; what changes is that the strategy reads the filtered
 * view's code.
 */
function hostViewFilter(config, agent) {
  const anotherAgentsInjection = (metadata) => {
    const mark = metadata?.contextInjection;
    if (mark === null || typeof mark !== 'object') return false;
    const { agent: owner, namespace, contentHash, part, parts } = mark;
    const valid = typeof owner === 'string' && typeof namespace === 'string' && typeof contentHash === 'string'
      && Number.isInteger(part) && Number.isInteger(parts) && part >= 0 && part < parts;
    return valid && owner !== agent;
  };
  if (/^H1(\.|$)/.test(config) || config === 'H3') return (message) => !message.metadata?.tuneOut && !anotherAgentsInjection(message.metadata);
  if (config === 'H4') return (message) => !anotherAgentsInjection(message.metadata);
  return undefined;
}

/** Marks an error the driver made as a host or a provider would (an admission deferral), not as its own defect. */
const INJECTED = Symbol('cm-fixture.injected');

/** A fault the workload injected into the store it handed the manager (Run.open). */
class InjectedFault extends Error {
  constructor(message) { super(message); this.name = 'InjectedFault'; }
}

/**
 * Run one job in an arm, writing its trace through the recorder.
 * @param {object} job { id, config, workload, variant, seed, from, save }: `from` is a checkpoint key to continue,
 *   or null; `save` is the key to save this run's end as a checkpoint under, or null.
 * @param {object} arm loadArm()'s result
 * @param {object} env { house, workloads, openRecorder, traceFile, checkpointDir, workDir, fixtureVersion }
 */
export async function runJob(job, arm, env) {
  const started = performance.now();
  const work = mkdtempSync(join(env.workDir ?? tmpdir(), 'cmfx-'));
  const storePath = join(work, 'store');
  if (job.from) {
    const at = checkpointPath(env.checkpointDir, job.from);
    if (!existsSync(join(at, 'clock.json'))) throw new DriverError(`no checkpoint ${job.from} at ${at}`);
    cpSync(join(at, 'store'), storePath, { recursive: true });
    clock.set(JSON.parse(readFileSync(join(at, 'clock.json'), 'utf8')).now);
  } else {
    clock.set(EPOCH);
  }

  const workload = env.workloads[job.workload];
  if (!workload) throw new DriverError(`no workload ${job.workload}`);
  let rec = null;
  let run = null;
  const standin = new StandinAdapter({
    onCall: (call) => {
      rec?.call(call);
      run?.calls.push({ step: run.n, carried: call.carried, kind: call.answer.kind, merge: mergeLevel(call.request?.messages ?? []) !== null });
    },
    // A provider's rejection of a request (the stand-in's rejectMerges): what the arm's membrane makes of Anthropic's
    // HTTP 400 invalid_request_error, as its own adapter classifies one. A membrane without the classifier leaves it
    // unset, so a rejection is a fixture defect there rather than an unclassified throw.
    ...(typeof arm.membrane.errorFromProviderStatus === 'function' ? {
      reject: (request) => arm.membrane.errorFromProviderStatus({
        provider: 'anthropic',
        status: 400,
        body: { type: 'error', error: { type: 'invalid_request_error', message: 'fixture: this request is rejected' } },
        rawRequest: request,
      }),
    } : {}),
  });
  const membrane = new arm.membrane.Membrane(standin, { formatter: new arm.membrane.NativeFormatter() });
  const scale = job.scale ?? SCALE;
  const overrides = workload.overrides?.(job.variant, job.config) ?? {};
  const built = buildConfig(arm.cm, job.config, env.house, arm.cmDir, overrides);
  rec = await env.openRecorder({
    file: env.traceFile,
    header: {
      run: job.id,
      config: job.config,
      workload: job.workload,
      variant: job.variant ?? null,
      arm: arm.name,
      seed: job.seed,
      scale,
      from: job.from ?? null,
      library: arm.library,
      membrane: { version: arm.membraneVersion },
      fixture: { version: env.fixtureVersion, standin: STANDIN_VERSION, clock: { epoch: new RealDate(EPOCH).toISOString(), stepMs: STEP_MS } },
    },
  });
  run = new Run({ job, arm, built, standin, membrane, rec, storePath, workload, house: env.house, overrides });
  let failure = null;
  try {
    await run.open('open', { namespace: NAMESPACE, from: job.from ?? null });
    await workload.run(run);
    await rec.checkpoint(run.manager, 'end');
    if (job.save) run.save(checkpointPath(env.checkpointDir, job.save));
  } catch (err) {
    failure = { error: err, where: !standin.fatal && thrownByLibrary(err, arm) ? 'library' : 'driver' };
    if (standin.fatal && !(err instanceof StandinError)) failure.error = standin.fatal;
  } finally {
    try { run.closeStore(); } catch { /* already closed, or the failure above */ }
  }
  await rec.end(failure);
  rmSync(work, { recursive: true, force: true });
  return { id: job.id, ok: failure === null, error: failure ? String(failure.error?.message ?? failure.error) : null, ms: Math.round(performance.now() - started) };
}

/** What a workload drives: the manager through the public API, with every call recorded. */
export class Run {
  constructor({ job, arm, built, standin, membrane, rec, storePath, workload, house, overrides }) {
    this.job = job;
    this.house = house;
    this.overrides = overrides;
    /** The stand-in's calls so far, { step, carried, kind, merge }, for a workload's own property. */
    this.calls = [];
    this.arm = arm;
    this.built = built;
    this.strategy = built.strategy;
    this.budget = { ...built.budget };
    this.standin = standin;
    this.membrane = membrane;
    /** While true, a provider wait stands: the manager's compression calls are deferred by admission (holdAdmission). */
    this.admissionHeld = false;
    this.deferred = { calls: 0, merges: 0 };
    this.managerMembrane = this.admitting(membrane);
    /** The view a house host's manager reads through (hostViewFilter), or none for a C configuration. */
    this.viewFilter = hostViewFilter(job.config, AGENT);
    this.rec = rec;
    this.storePath = storePath;
    this.workload = workload;
    this.manager = null;
    this.pendingTick = null;
    this.ticksInFlight = 0;
    this.watchTicks(this.strategy);
    this.submissions = 0;
    this.rng = mulberry32(job.seed);
    this.n = 0;
    this.addsInStep = 0;
    this.addNames = new Map();
  }

  get eager() { return this.built.eager; }
  get scale() { return this.job.scale ?? SCALE; }
  /** Whether this run's configuration compresses (configs.mjs' compresses). */
  get compresses() { return compresses(this.job.config); }

  /**
   * Count the strategy's ticks in flight, its own drain's included: the drain calls `this.tick`, which this
   * instance property answers. With the zero-delay timers above, it's how the driver knows an eager drain has ended
   * rather than paused for I/O.
   */
  watchTicks(strategy) {
    if (typeof strategy.tick !== 'function') return;
    const tick = strategy.tick.bind(strategy);
    strategy.tick = (...args) => {
      this.ticksInFlight++;
      let p;
      try { p = tick(...args); } catch (err) { this.ticksInFlight--; throw err; }
      return Promise.resolve(p).finally(() => { this.ticksInFlight--; });
    };
  }
  get seed() { return this.job.seed; }

  /** The canary a workload puts at the head of each message it writes: c<seed>.<turn>.<role>. */
  c(n, role) { return `c${this.job.seed}.${n}.${role}`; }

  /** Deterministic prose of about `chars` characters, from this run's own sequence. */
  prose(chars) {
    let s = '';
    while (s.length < chars) {
      const n = 2 + Math.floor(this.rng() * 8);
      for (let i = 0; i < n; i++) s += String.fromCharCode(97 + Math.floor(this.rng() * 26));
      s += this.rng() < 0.08 ? '. ' : ' ';
    }
    return s.slice(0, chars).trimEnd();
  }

  checkFatal() {
    if (this.standin.fatal) throw this.standin.fatal;
  }

  async open(op, args) {
    // A workload whose variant faults the store's writes opens the store itself and hands the manager a wrapper, as a
    // host may through the public `store` option: every method is the store's, but a state write whose id
    // `refuseStateWrites` names throws an InjectedFault, as a full or failing disk would.
    let source = { path: this.storePath };
    if (this.workload.ownStore?.(this.job.variant)) {
      this.ownedStore = this.arm.chronicle.JsStore.openOrCreate({ path: this.storePath, blobCacheSize: 1000 });
      const run = this;
      source = { store: new Proxy(this.ownedStore, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (typeof value !== 'function') return value;
          if (prop !== 'setStateJson') return value.bind(target);
          return (id, state) => {
            if (run.refuseStateWrites?.(String(id))) {
              run.refusedStateWrites = (run.refusedStateWrites ?? 0) + 1;
              throw new InjectedFault(`the store refused the state write for ${JSON.stringify(String(id))}`);
            }
            return value.call(target, id, state);
          };
        },
      }) };
    }
    this.manager = await this.arm.cm.ContextManager.open({
      ...source, strategy: this.strategy, membrane: this.managerMembrane, namespace: NAMESPACE,
      ...(this.viewFilter ? { viewFilter: this.viewFilter } : {}),
    });
    this.rec.action(op, args);
    if (op === 'open' && this.workload.toolsAtOpen?.(this.job.variant) === false) return;
    this.declareTools();
  }

  /** Declare the agent's tools, as a host does before its first request: an agent permitted none declares []. */
  declareTools(tools = TOOLS) {
    this.manager.setToolDefinitions(tools);
    this.rec.action('tools', { tools: tools.map((t) => t.name) });
  }

  /**
   * The membrane the manager's compression calls go through, as agent-framework hands its context managers one
   * (membraneAdmitting, framework.ts at a64cfc010f): while a provider wait stands for the agent's model
   * (holdAdmission), a call is refused before it's made, as refuseHeldProviderModel refuses it: a retryable rate limit
   * marked providerAdmission 'deferred', stating the wait's end. The agent's own requests (send()) use the plain one.
   */
  admitting(membrane) {
    const run = this;
    return new Proxy(membrane, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'complete' && typeof value === 'function') {
          return async (...args) => {
            if (run.admissionHeld) {
              run.deferred.calls++;
              if (mergeLevel(args[0]?.messages ?? []) !== null) run.deferred.merges++;
              throw Object.assign(new run.arm.membrane.MembraneError({
                type: 'rate_limit',
                retryable: true,
                retryAfterMs: STEP_MS,
                message: 'fixture: a provider wait holds this model, so the call is not made',
                rawError: undefined,
              }), { providerAdmission: 'deferred', [INJECTED]: true });
            }
            return Reflect.apply(value, target, args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  /**
   * A provider wait for the agent's model, from now until released: the manager's compression calls are deferred
   * meanwhile. The release records how many were, and how many of those were merges, so the record says whether the
   * wait met the work it was placed for.
   */
  holdAdmission(held) {
    if (held) {
      this.admissionHeld = true;
      this.deferred = { calls: 0, merges: 0 };
      this.rec.action('admission', { held: true });
    } else {
      this.admissionHeld = false;
      this.rec.action('admission', { held: false }, { ...this.deferred });
    }
  }

  /** Begin step n. */
  step(n) {
    this.n = n;
    this.addsInStep = 0;
    clock.advance(STEP_MS);
    this.rec.step(n);
  }

  /**
   * Add a message, as a host stores one, with addMessage's options if given (a hold at add, `holdCompression`, is
   * recorded as an action after the add). Returns its store id; addName() gives the name records use for it.
   */
  add(participant, content, options) {
    const id = options === undefined ? this.manager.addMessage(participant, content) : this.manager.addMessage(participant, content, undefined, undefined, options);
    this.rec.added(participant, content, id);
    const name = `a${this.n}.${this.addsInStep++}`;
    this.addNames.set(id, name);
    if (options?.holdCompression) this.rec.action('hold-at-add', { message: name });
    return id;
  }

  /** The name a record gives a message this run added (`a<step>.<n>`), which stays put across versions. */
  addName(id) {
    return this.addNames.get(id) ?? `store:${id}`;
  }

  /**
   * Any other public-API call, recorded with what it returned. A call the library refuses is recorded with its
   * error's class as its result, since a refusal is behaviour, and the workload goes on. A throw from anywhere but
   * the library (the workload's own code) ends the run as the driver's.
   */
  async act(op, args, call) {
    let result;
    try {
      result = await call(this.manager);
    } catch (err) {
      this.checkFatal();
      if (!thrownByLibrary(err, this.arm)) throw new DriverError(`the workload's own ${op} threw: ${err?.stack ?? err}`);
      result = { refused: err?.name ?? 'Error' };
    }
    this.rec.action(op, args, result === undefined ? undefined : result);
    return result;
  }

  /** Change the budget the next compiles use. */
  setBudget(budget) {
    this.budget = { ...budget };
    this.rec.action('budget', { ...budget });
  }

  /**
   * Compile, as a host does before each of its agent's requests. A house configuration that compresses also sends
   * the request, as its host does (send()). A refusal is recorded as behaviour; a throw from anywhere but the library
   * ends the run as the driver's.
   */
  async compile() {
    this.checkFatal();
    const budget = { ...this.budget };
    const options = this.built.receipts ? { kvUnifiedImmutablePrefixHash: IMMUTABLE_PREFIX } : undefined;
    let compiled;
    try {
      compiled = await this.manager.compile(budget, undefined, options);
    } catch (err) {
      this.checkFatal();
      if (!thrownByLibrary(err, this.arm)) throw new DriverError(`a compile threw outside the library: ${err?.stack ?? err}`);
      this.rec.refused(this.manager, budget, err);
      return null;
    }
    this.rec.compiled(this.manager, budget, compiled);
    if (this.built.sends) await this.send(compiled, budget);
    return compiled;
  }

  /**
   * Send a compiled request through membrane as agent-framework does, and report what the provider says it cost.
   * - For a kv-unified agent (H1): bind the compile to a submission when membrane hands over its wire receipt, and
   *   accept it with that receipt once the stand-in answers. The receipt's markers are membrane's own count for the
   *   request, so a compile whose markers don't match its layout keeps no cache reference here, as for a resident.
   * - For each (H1, H2): report the response's input total with the system prompt and tools it sent
   *   (reportRealInputTokens, agent-framework's framework.ts:26285 at v0.30.0), which feeds the calibration.
   */
  async send(compiled, budget) {
    const strategy = this.manager.getStrategy();
    const kv = this.built.receipts;
    const submissionId = `${AGENT}:${this.job.id}:${++this.submissions}`;
    const layoutHash = createHash('sha256').update(JSON.stringify(compiled.messages)).digest('hex');
    let receipt = null;
    const request = {
      messages: compiled.messages,
      system: SYSTEM,
      tools: TOOLS,
      config: { model: 'claude-opus-4-6', maxTokens: budget.reserveForResponse },
      ...(kv ? {
        cacheMarkers: 'cm-owned',
        onCacheWireReceipt: (r) => {
          receipt = r;
          strategy.beginKvUnifiedSubmission({ submissionId, requestHash: r.requestHash, layoutHash });
        },
      } : {}),
    };
    // A workload may have the next request fail after it's sent, once its wire receipt has bound, as a provider
    // error after sending would (failNextSend, once).
    const failing = this.failNextSend === true;
    if (failing) this.failNextSend = false;
    let response;
    try {
      response = await this.membrane.complete(request);
      if (failing) throw new Error('fixture: the provider failed this request after it was sent');
    } catch (err) {
      if (receipt) strategy.reportKvUnifiedFailed?.(submissionId);
      if (kv) this.rec.receipt({ accepted: false, failed: true, withReference: this.cacheReference(strategy) }, this.manager);
      return;
    }
    const real = response?.usage?.inputTokens;
    if (typeof real === 'number') {
      try {
        // A workload may report a total with no use first, as a host that read a provider's usage wrong would.
        if (this.nanBeforeReports) strategy.reportRealInputTokens?.(NaN);
        strategy.reportRealInputTokens?.(real, { system: SYSTEM, tools: TOOLS });
      } catch (err) {
        // A report the library lets a store fault escape from: behaviour, recorded (the library calls persisting the
        // calibration best-effort).
        if (!thrownByLibrary(err, this.arm)) throw err;
        this.rec.action('report', { total: 'the response\'s' }, { refused: err?.name ?? 'Error' });
      }
    }
    if (!kv) return;
    if (!receipt) {
      this.rec.receipt({ accepted: false, withReference: this.cacheReference(strategy) }, this.manager);
      return;
    }
    strategy.reportKvUnifiedAccepted({ submissionId, acceptedAt: Date.now(), wireReceipt: receipt });
    let head;
    try { head = strategy.kvUnifiedReceipts.head; } catch { head = { unreadable: 'no kvUnifiedReceipts.head' }; }
    this.rec.receipt({ accepted: true, withReference: this.cacheReference(strategy), head }, this.manager);
  }

  /** Whether the strategy's receipt chain holds a cache reference. It keeps the chain to itself; a version that names
   *  it otherwise reads as unreadable. */
  cacheReference(strategy) {
    try { return strategy.kvUnifiedReceipts.cache != null; } catch { return { unreadable: 'no kvUnifiedReceipts.cache' }; }
  }

  /**
   * Give an eager drain the time a host's event loop would have, as while a tool runs: wait until it's quiet. A
   * configuration whose host drains explicitly gets nothing here; it drains at settle().
   */
  async yieldToDrain() {
    this.checkFatal();
    if (this.eager) await this.quiet();
    this.checkFatal();
  }

  /** Let compression catch up after a turn, as the configuration's host would. */
  async settle() {
    this.checkFatal();
    if (this.eager) await this.quiet();
    else await this.drain();
    this.checkFatal();
  }

  /**
   * An explicit drain, as a host that ticks its agent's store does: tick until ready. It stops early when the
   * stand-in holds the call a tick waits on (W10), and when STUCK_TICKS ticks in a row change nothing (no call, and
   * the strategy's progress snapshot as it was): the queue has work the library won't do now (a quarantine, a hold,
   * compression deferred for tools), which the step's `ready` records as behaviour. A drain still moving at
   * TICK_LIMIT ticks is a runaway, and the driver's to answer for.
   */
  async drain() {
    let idle = 0;
    const state = () => {
      let progress;
      try { progress = JSON.stringify(this.manager.getStrategy().getProgressSnapshot?.() ?? null); } catch { progress = null; }
      return `${this.standin.state().calls}|${progress}`;
    };
    for (let k = 0; k < TICK_LIMIT; k++) {
      if (!this.pendingTick && this.manager.isReady()) return;
      const before = state();
      const tick = this.pendingTick ?? watch(this.manager.tick());
      this.pendingTick = null;
      if (await this.parkedBefore(tick)) {
        this.pendingTick = tick;
        return;
      }
      if (tick.error) {
        // A tick the library rejects, such as a merge whose provider call failed (the lane pauses and the tick
        // rethrows), ends this drain as it ends an agent's maintenance pass in agent-framework, which reports the
        // failure and ticks again at its next pass (framework.ts:7228-7250 at a64cfc010f). It's behaviour, recorded.
        if (!thrownByLibrary(tick.error, this.arm)) throw tick.error;
        this.rec.action('tick', {}, { refused: tick.error?.name ?? 'Error' });
        return;
      }
      if (state() === before) {
        if (++idle >= STUCK_TICKS) return;
      } else {
        idle = 0;
      }
    }
    throw new DriverError(`an explicit drain was still moving after ${TICK_LIMIT} ticks`);
  }

  /** Whether the stand-in parks every call in flight before `watched` settles. */
  async parkedBefore(watched) {
    for (let k = 0; k < EAGER_LIMIT; k++) {
      if (watched.settled) return false;
      const s = this.standin.state();
      if (s.inFlight > 0 && s.inFlight === s.parked) return true;
      await nextTurn();
    }
    throw new DriverError(`a tick neither settled nor waited on a held answer in ${EAGER_LIMIT} turns of the event loop`);
  }

  /**
   * An eager drain left to run: wait until it has ended, with no tick in flight, no zero-delay timer pending (the
   * drain's next tick) and no call in flight, for QUIET_TURNS turns in a row; or until every call in flight is one
   * the stand-in holds (W10). Never a wait for a length of time.
   */
  async quiet() {
    let still = 0;
    for (let k = 0; k < EAGER_LIMIT; k++) {
      await nextTurn();
      const s = this.standin.state();
      if (s.inFlight > 0 && s.inFlight === s.parked) return;
      if (s.inFlight === 0 && this.ticksInFlight === 0 && zeroTimers === 0) {
        if (++still >= QUIET_TURNS) return;
      } else {
        still = 0;
      }
    }
    throw new DriverError(`an eager drain never ended in ${EAGER_LIMIT} turns of the event loop`);
  }

  /** Let n parked answers through (W10's pacing), recorded as the workload's action. */
  release(n) {
    this.standin.release(n);
    this.rec.action('release-answers', { n });
  }

  /** End the step, after its last settle. */
  async endStep() {
    await this.rec.endStep(this.manager);
  }

  /** A phase's checkpoint. */
  async checkpoint(name) {
    await this.rec.checkpoint(this.manager, `phase:${name}`);
  }

  violation(invariant, detail) {
    this.rec.violation(invariant, detail);
  }

  /**
   * A dry compile, as a host previews its agent's context (agent-framework's previews and its API's context view):
   * nothing is committed. Recorded as an action with what it would send (compileSummary), or the library's refusal.
   */
  async dryCompile(budget = this.budget) {
    this.checkFatal();
    const options = { ...(this.built.receipts ? { kvUnifiedImmutablePrefixHash: IMMUTABLE_PREFIX } : {}), dryRun: true };
    return this.act('dry-compile', { maxTokens: budget.maxTokens }, async (m) => this.compileSummary(await m.compile({ ...budget }, undefined, options)));
  }

  /**
   * What a compile would send, for an action's result: each message's sources as a record names them, and which
   * messages carry a cache marker. For a compile that isn't the run's own (a dry one, a derived context's).
   */
  compileSummary(compiled) {
    const prov = compiled?.provenance?.messages;
    const messages = compiled?.messages ?? [];
    return {
      sources: messages.map((_, i) => (prov ? sourceStrings(prov[i], (id) => this.addName(id)) : ['o']).join(' ')),
      markers: messages.flatMap((m, i) => (normalizeMessage(m).marker ? [i] : [])),
    };
  }

  /** A strategy instance of another configuration at this run's scale, for a derived context of another kind. */
  strategyOf(config) {
    return buildConfig(this.arm.cm, config, this.house, this.arm.cmDir).strategy;
  }

  /** A new strategy instance of this run's configuration, as a derived context takes one. */
  freshStrategy() {
    return buildConfig(this.arm.cm, this.job.config, this.house, this.arm.cmDir, { ...this.overrides, ...(this.reopened ?? {}) }).strategy;
  }

  /** Close the manager, and the store the run handed it if the run opened that itself (open()). */
  closeStore() {
    try {
      this.manager?.close();
    } finally {
      const owned = this.ownedStore;
      this.ownedStore = null;
      owned?.close?.();
    }
  }

  /** Close the store and open it again with a new strategy instance of the configuration, `extra` options on top. */
  async reopen(extra = {}) {
    this.closeStore();
    // Options set at one reopen stay for the next, as a host's recipe keeps them.
    this.reopened = { ...(this.reopened ?? {}), ...extra };
    this.built = buildConfig(this.arm.cm, this.job.config, this.house, this.arm.cmDir, { ...this.overrides, ...this.reopened });
    this.strategy = this.built.strategy;
    this.watchTicks(this.strategy);
    await this.open('reopen', extra);
  }

  /** Save this run's end as a checkpoint: the store, and the clock it stopped at. */
  save(at) {
    this.closeStore();
    rmSync(at, { recursive: true, force: true });
    mkdirSync(at, { recursive: true });
    cpSync(this.storePath, join(at, 'store'), { recursive: true });
    writeFileSync(join(at, 'clock.json'), JSON.stringify({ now: clock.now() }));
  }
}

function watch(promise) {
  const w = { settled: false, error: null };
  w.promise = promise.then(() => { w.settled = true; }, (err) => { w.settled = true; w.error = err; });
  return w;
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Whether a throw came from the library: its top stack frame with a file is under the arm's context-manager tree,
 * its own `src` or the packages it installs, wherever they really live (libraryRoots). Anything else, the workload's
 * own code above all, is the driver's.
 */
function thrownByLibrary(err, arm) {
  // A fault the workload injected (into the store, or a host's admission deferral), which the library let escape:
  // the library's behaviour.
  if (err instanceof InjectedFault || err?.[INJECTED] === true) return true;
  for (const line of String(err?.stack ?? '').split('\n').slice(1)) {
    const m = line.match(/\(?(?:file:\/\/)?(\/[^()]+?):\d+:\d+\)?\s*$/);
    if (m) return arm.libraryRoots.some((root) => m[1].startsWith(`${root}/`));
  }
  return false;
}
