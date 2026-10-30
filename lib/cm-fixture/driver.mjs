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
// A continuation starts from a copy of a checkpoint the base wrote: its store, and the clock it stopped at.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { StandinAdapter, StandinError } from './standin.mjs';
import { buildConfig, SCALE } from './configs.mjs';

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
/** The most ticks an explicit drain makes in one settle. */
const TICK_LIMIT = 400;

const AGENT = 'Junga';
const NAMESPACE = 'agents/junga';
/** What the agent's requests carry before their messages: agent-framework hashes this as the immutable prefix. */
const SYSTEM = `You are ${AGENT}. [cm-fixture:agent]`;
export const TOOLS = [
  { name: 'read_file', description: 'Read part of a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];
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
  return { name, cm, cmDir, membrane, membraneVersion, library: { commit, version: pkg(cmDir).version } };
}

// ---------------------------------------------------------------------------------------------------------------
// A run.

/** Where a checkpoint's store and clock are kept, under a checkpoint directory. */
export const checkpointPath = (dir, key) => join(dir, key.replaceAll('/', '__').replaceAll(':', '_').replaceAll('@', '-at-'));

class DriverError extends Error {
  constructor(message) { super(message); this.name = 'DriverError'; }
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
  const standin = new StandinAdapter({ onCall: (call) => rec?.call(call) });
  const membrane = new arm.membrane.Membrane(standin, { formatter: new arm.membrane.NativeFormatter() });
  const scale = job.scale ?? SCALE;
  const built = buildConfig(arm.cm, job.config, env.house, arm.cmDir, scale);
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
      fixture: { version: env.fixtureVersion },
    },
  });
  const run = new Run({ job, arm, built, standin, membrane, rec, storePath, workload, house: env.house });
  let failure = null;
  try {
    await run.open('open', { namespace: NAMESPACE, from: job.from ?? null });
    await workload.run(run);
    await rec.checkpoint(run.manager, 'end');
    if (job.save) run.save(checkpointPath(env.checkpointDir, job.save));
  } catch (err) {
    failure = { error: err, where: err instanceof DriverError || err instanceof StandinError || standin.fatal ? 'driver' : 'library' };
    if (standin.fatal && !(err instanceof StandinError)) failure.error = standin.fatal;
  } finally {
    try { run.manager?.close(); } catch { /* already closed, or the failure above */ }
  }
  await rec.end(failure);
  rmSync(work, { recursive: true, force: true });
  return { id: job.id, ok: failure === null, error: failure ? String(failure.error?.message ?? failure.error) : null, ms: Math.round(performance.now() - started) };
}

/** What a workload drives: the manager through the public API, with every call recorded. */
export class Run {
  constructor({ job, arm, built, standin, membrane, rec, storePath, workload, house }) {
    this.job = job;
    this.house = house;
    this.arm = arm;
    this.built = built;
    this.strategy = built.strategy;
    this.budget = { ...built.budget };
    this.standin = standin;
    this.membrane = membrane;
    this.rec = rec;
    this.storePath = storePath;
    this.workload = workload;
    this.manager = null;
    this.pendingTick = null;
    this.ticksInFlight = 0;
    this.watchTicks(this.strategy);
    this.submissions = 0;
    this.rng = seededRandom(job.seed);
    this.n = 0;
  }

  get eager() { return this.built.eager; }
  get scale() { return this.job.scale ?? SCALE; }

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
    this.manager = await this.arm.cm.ContextManager.open({ path: this.storePath, strategy: this.strategy, membrane: this.membrane, namespace: NAMESPACE });
    this.rec.action(op, args);
    this.manager.setToolDefinitions(TOOLS);
    this.rec.action('tools', { tools: TOOLS.map((t) => t.name) });
  }

  /** Begin step n. */
  step(n) {
    this.n = n;
    clock.advance(STEP_MS);
    this.rec.step(n);
  }

  /** Add a message, as a host stores one. */
  add(participant, content) {
    const id = this.manager.addMessage(participant, content);
    this.rec.added(participant, content, id);
    return id;
  }

  /** Any other public-API call, recorded with what it returned. */
  async act(op, args, call) {
    const result = await call(this.manager);
    this.rec.action(op, args, result === undefined ? undefined : result);
    return result;
  }

  /** Change the budget the next compiles use. */
  setBudget(budget) {
    this.budget = { ...budget };
    this.rec.action('budget', { ...budget });
  }

  /** Compile, as a host does before each of its agent's requests; a house kv-unified configuration also sends it. */
  async compile() {
    this.checkFatal();
    const budget = { ...this.budget };
    const options = this.built.receipts ? { kvUnifiedImmutablePrefixHash: IMMUTABLE_PREFIX } : undefined;
    let compiled;
    try {
      compiled = await this.manager.compile(budget, undefined, options);
    } catch (err) {
      this.checkFatal();
      this.rec.refused(this.manager, budget, err);
      return null;
    }
    this.rec.compiled(this.manager, budget, compiled);
    if (this.built.receipts) await this.send(compiled, budget);
    return compiled;
  }

  /**
   * Send a compiled request through membrane as agent-framework does for a kv-unified agent: bind the compile to a
   * submission when membrane hands over its wire receipt, and accept it with that receipt once the stand-in answers.
   * The receipt's markers are membrane's own count for the request, so a compile whose markers don't match its
   * layout keeps no cache reference here as it wouldn't for a resident.
   */
  async send(compiled, budget) {
    const strategy = this.manager.getStrategy();
    const submissionId = `${AGENT}:${this.job.id}:${++this.submissions}`;
    const layoutHash = createHash('sha256').update(JSON.stringify(compiled.messages)).digest('hex');
    let receipt = null;
    const request = {
      messages: compiled.messages,
      system: SYSTEM,
      tools: TOOLS,
      config: { model: 'claude-opus-4-6', maxTokens: budget.reserveForResponse },
      cacheMarkers: 'cm-owned',
      onCacheWireReceipt: (r) => {
        receipt = r;
        strategy.beginKvUnifiedSubmission({ submissionId, requestHash: r.requestHash, layoutHash });
      },
    };
    try {
      await this.membrane.complete(request);
    } catch (err) {
      if (receipt) strategy.reportKvUnifiedFailed?.(submissionId);
      this.rec.receipt({ accepted: false, withReference: false });
      return;
    }
    if (!receipt) {
      this.rec.receipt({ accepted: false, withReference: false });
      return;
    }
    strategy.reportKvUnifiedAccepted({ submissionId, acceptedAt: Date.now(), wireReceipt: receipt });
    // The strategy keeps its receipt chain to itself; a version that names it otherwise reads as unreadable.
    let withReference;
    try { withReference = strategy.kvUnifiedReceipts.cache != null; } catch { withReference = { unreadable: 'no kvUnifiedReceipts.cache' }; }
    this.rec.receipt({ accepted: true, withReference });
  }

  /** Let compression catch up after a turn, as the configuration's host would. */
  async settle() {
    this.checkFatal();
    if (this.eager) await this.quiet();
    else await this.drain();
    this.checkFatal();
  }

  /** An explicit drain: tick until ready, stopping early when the stand-in holds the call a tick waits on. */
  async drain() {
    for (let k = 0; k < TICK_LIMIT; k++) {
      if (!this.pendingTick && this.manager.isReady()) return;
      const tick = this.pendingTick ?? watch(this.manager.tick());
      this.pendingTick = null;
      if (await this.parkedBefore(tick)) {
        this.pendingTick = tick;
        return;
      }
      if (tick.error) throw tick.error;
    }
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

  /** Close the store and open it again with a new strategy instance of the same configuration. */
  async reopen() {
    this.manager.close();
    this.built = buildConfig(this.arm.cm, this.job.config, this.house, this.arm.cmDir, this.scale);
    this.strategy = this.built.strategy;
    this.watchTicks(this.strategy);
    await this.open('reopen', {});
  }

  /** Save this run's end as a checkpoint: the store, and the clock it stopped at. */
  save(at) {
    this.manager.close();
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

function seededRandom(seed) {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
}
