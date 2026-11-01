import { AsyncLocalStorage } from 'node:async_hooks';
import { connect } from 'node:net';
import { lineReader } from './control.mjs';
import { blobStore, compiledLine, messagesOf, plain, receiptHeadOf, refusedLine, stateOf, storeDelta } from './recorder.mjs';

const CALLER = new AsyncLocalStorage();
const WRAPPED = Symbol.for('connectome-host.whole-host.wrapped');
const AGENT_COMPILES = ['compileWithInjections', 'compileContext'];
const UNBOUNDED = { maxTokens: Number.POSITIVE_INFINITY, reserveForResponse: 0 };

/**
 * The whole-host harness's test module, loaded as a recipe extension of kind `module`: it records every compile the
 * host makes and answers the driver's reads over the control socket. It offers no tools and injects nothing.
 */
export function register(api) {
  api.registerModule(() => new HarnessModule(process.env.FIXTURE_CONTROL));
}

export class HarnessModule {
  constructor(controlPath) {
    this.name = 'whole-host-harness';
    this.controlPath = controlPath;
    this.framework = null;
    this.sock = null;
    this.lines = [];
    this.seq = 0;
    this.assemblies = 0;
    this.blobs = blobStore();
    this.ticks = new WeakMap();
    this.agentOf = new WeakMap();
    this.seen = new Map();
  }

  async start() {}

  async stop() {
    this.sock?.destroy();
    this.sock = null;
  }

  getTools() {
    return [];
  }

  async handleToolCall(call) {
    return { success: false, isError: true, error: `There's no tool ${JSON.stringify(call?.name)}, so nothing ran: the whole-host harness module offers none.` };
  }

  async onProcess() {
    return {};
  }

  setFramework(framework) {
    if (!this.controlPath) {
      console.warn('[whole-host-harness] FIXTURE_CONTROL is unset, so the harness module records nothing');
      return;
    }
    this.framework = framework;
    const primary = framework.getPrimaryAgentName();
    const agent = primary === null ? null : framework.getAgent(primary);
    if (!agent) throw new Error(`the whole-host harness module found no primary agent to record (getPrimaryAgentName() is ${JSON.stringify(primary)})`);
    this.wrapAgentCompiles(Object.getPrototypeOf(agent));
    this.wrapManagerCompile(Object.getPrototypeOf(agent.getContextManager()));
    this.watchTicks(agent.getContextManager());
    this.connect();
  }

  /**
   * Runs each of the agent's own compiles, the ones a request is assembled from, inside a context that names the
   * agent, its manager and the assembly, so the manager's compile can tell a request's compile from every other.
   */
  wrapAgentCompiles(proto) {
    const module = this;
    for (const method of AGENT_COMPILES) {
      const original = proto[method];
      if (typeof original !== 'function' || original[WRAPPED]) continue;
      const wrapped = function (...args) {
        const assembly = ++module.assemblies;
        return CALLER.run({ agent: this.name, manager: this.getContextManager(), assembly }, () => original.apply(this, args));
      };
      wrapped[WRAPPED] = true;
      proto[method] = wrapped;
    }
  }

  wrapManagerCompile(proto) {
    const module = this;
    const original = proto.compile;
    if (typeof original !== 'function' || original[WRAPPED]) return;
    const wrapped = async function (...args) {
      const [budget, , opts] = args;
      const caller = CALLER.getStore();
      const own = caller?.manager === this;
      const dry = opts?.dryRun === true;
      module.watchTicks(this);
      const head = {
        seq: ++module.seq,
        agent: module.agentName(this, own ? caller : null),
        kind: dry ? 'dry' : own ? 'request' : 'other',
        ...(own ? { assembly: caller.assembly } : {}),
        dry,
        budget: budget === undefined ? null : plain(budget),
      };
      let result;
      try {
        result = await original.apply(this, args);
      } catch (error) {
        module.record(head, () => refusedLine(error, module.blobs));
        throw error;
      }
      module.record(head, () => compiledLine(this, budget ?? UNBOUNDED, result, module.blobs));
      return result;
    };
    wrapped[WRAPPED] = true;
    proto.compile = wrapped;
  }

  record(head, body) {
    let line;
    try {
      line = { ...head, ...body() };
    } catch (error) {
      line = { ...head, outcome: 'unrecordable', reason: String(error?.message ?? error).slice(0, 300) };
    }
    this.lines.push(line);
  }

  /** Counts the strategy's ticks in flight, its own drain's included, by an instance property on `tick`. */
  watchTicks(manager) {
    let strategy;
    try { strategy = manager.getStrategy(); } catch { return; }
    if (!strategy || this.ticks.has(strategy) || typeof strategy.tick !== 'function') return;
    const counter = { inFlight: 0 };
    this.ticks.set(strategy, counter);
    const tick = strategy.tick.bind(strategy);
    strategy.tick = (...args) => {
      counter.inFlight++;
      let p;
      try { p = tick(...args); } catch (error) { counter.inFlight--; throw error; }
      return Promise.resolve(p).finally(() => { counter.inFlight--; });
    };
  }

  ticksInFlight(manager) {
    try { return this.ticks.get(manager.getStrategy())?.inFlight ?? 0; } catch { return null; }
  }

  agentName(manager, caller) {
    if (caller) return caller.agent;
    const known = this.agentOf.get(manager);
    if (known) return known;
    for (const record of this.framework?.listAgents({ includeEnded: true }) ?? []) {
      const agent = this.framework.getAgent(record.name);
      if (agent && agent.getContextManager() === manager) {
        this.agentOf.set(manager, record.name);
        return record.name;
      }
    }
    return null;
  }

  agentNamed(name) {
    const agent = this.framework?.getAgent(String(name));
    if (!agent) throw Object.assign(new Error(`no agent ${JSON.stringify(name)} is running`), { code: -32602 });
    return agent;
  }

  managerOf(name) {
    return this.agentNamed(name).getContextManager();
  }

  connect() {
    const sock = connect(this.controlPath, () => sock.write(`${JSON.stringify({ type: 'hello', peer: 'module', pid: process.pid })}\n`));
    sock.unref();
    sock.on('error', (e) => console.error(`[whole-host-harness] control socket ${this.controlPath}: ${e.message}`));
    lineReader(sock, (msg) => {
      if (msg?.id === undefined || typeof msg.op !== 'string') return;
      Promise.resolve()
        .then(() => this.answer(msg))
        .then((result) => ({ id: msg.id, result }), (error) => ({ id: msg.id, error: { code: error?.code ?? -32000, message: String(error?.message ?? error) } }))
        .then((reply) => sock.write(`${JSON.stringify(reply)}\n`));
    });
    this.sock = sock;
  }

  async answer(msg) {
    switch (msg.op) {
      case 'take': {
        const lines = this.lines;
        this.lines = [];
        const store = {};
        for (const record of this.framework.listAgents() ?? []) {
          const agent = this.framework.getAgent(record.name);
          if (!agent) continue;
          const delta = storeDelta(agent.getContextManager(), this.seen.get(record.name), this.blobs);
          this.seen.set(record.name, delta.seen);
          if (delta.changed) store[record.name] = delta.out;
        }
        return { lines, store, blobs: this.blobs.take() };
      }
      case 'agents':
        return (this.framework.listAgents({ includeEnded: true }) ?? []).map((r) => r.name);
      case 'ticks': {
        const out = {};
        for (const record of this.framework.listAgents() ?? []) {
          const agent = this.framework.getAgent(record.name);
          if (agent) out[record.name] = this.ticksInFlight(agent.getContextManager());
        }
        return out;
      }
      case 'state': {
        // Its summaries' content goes in the answer's own blobs, never through the compile batches'
        // store: taking from that would hand a value pending for the next `take` to this read's log
        // entry, and the batches, which the record writer and the checks read, would lack it.
        const manager = this.managerOf(msg.agent);
        const own = blobStore();
        return { ...stateOf(manager, this.ticksInFlight(manager), own), blobs: own.take() };
      }
      case 'messages':
        return messagesOf(this.managerOf(msg.agent));
      case 'dry-compile': {
        // The budget the agent's own request compile would pass (agent-framework's compileBudget,
        // the context budget with the tool-result guard's reservation), unless the driver names one.
        const agent = this.agentNamed(msg.agent);
        const budget = msg.budget ?? (typeof agent.compileBudget === 'function' ? agent.compileBudget() : undefined);
        const before = this.seq;
        await agent.getContextManager().compile(budget, undefined, { dryRun: true }).catch(() => null);
        return { seq: this.lines.find((l) => l.seq > before && l.kind === 'dry')?.seq ?? null };
      }
      default:
        throw Object.assign(new Error(`the harness module has no op ${JSON.stringify(msg.op)}`), { code: -32601 });
    }
  }
}
