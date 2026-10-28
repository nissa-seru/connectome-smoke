import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ipcConnect, send, sleep, spawnHost, stopHost } from '../common.mjs';
import { lineReader, listenForPeers } from './control.mjs';
import { scaleKvUnified } from './script.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'mcpl-server.mjs');
const PRELOAD = join(HERE, 'virtual-date.mjs');
const SETTLE_PASSES = 16;
const BOOT_MS = 120_000;
const TURN_MS = 120_000;
const COMMAND_MS = 60_000;
const MAINTAIN_MS = 120_000;
const SHUTDOWN_MS = 30_000;

const COMMANDS = {
  session: (lines) => {
    if (lines.some((l) => /^Session renamed to /.test(l))) return 'done';
    if (lines.some((l) => /^(Usage: \/session rename|No active session)/.test(l))) return 'failed';
    return null;
  },
  budget: (lines) => {
    if (lines.some((l) => /^Stream budget set to /.test(l))) return 'done';
    if (lines.some((l) => /^(Invalid token count|No agents)/.test(l))) return 'failed';
    return null;
  },
  newtopic: (lines) => {
    if (lines.some((l) => /^(Topic reset failed:|\/newtopic refused:|No context manager)/.test(l))) return 'failed';
    const at = lines.indexOf('Topic reset. Transition summary:');
    return at >= 0 && lines.length > at + 1 ? 'done' : null;
  },
};

/**
 * What the installed host says of itself that the lane's recipe for
 * `configuration` depends on: whether it takes a top-level
 * `maintenanceIntervalMs`, and its own standard kv-unified block for the
 * configuration's recipe and model. Evaluated with bun from the host's source.
 */
export function hostFacts({ hostDir, configuration }) {
  const recipe = laneRecipe({ configuration: { ...configuration, kvUnifiedScale: undefined }, facts: { takesMaintenanceInterval: false }, control: '', channels: [], boot: 0 });
  const model = recipe.agent.model;
  const src = (f) => JSON.stringify(join(hostDir, 'src', f));
  const code = [
    `const { unknownRecipeKeys } = await import(${src('recipe.ts')});`,
    `const { standardKvUnifiedConfig } = await import(${src('framework-strategy.ts')});`,
    'console.log(JSON.stringify({',
    '  takesMaintenanceInterval: unknownRecipeKeys({ maintenanceIntervalMs: 0 }).length === 0,',
    `  kvUnified: standardKvUnifiedConfig(${JSON.stringify(recipe)}, ${JSON.stringify(model)}),`,
    '}));',
  ].join('\n');
  const r = spawnSync('bun', ['-e', code], { cwd: hostDir, encoding: 'utf-8', timeout: 60_000, env: { ...process.env, NO_COLOR: '1' } });
  const line = (r.stdout || '').trim().split('\n').at(-1);
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`couldn't read the installed host's recipe facts (bun exited ${r.status}): ${(r.stderr || r.stdout || '').trim().slice(-2000)}`);
  }
}

const BASE_AGENT = { name: 'fixture', provider: 'anthropic', systemPrompt: 'You are the strategy fixture\'s agent.' };

/** The lane's recipe for one boot, from the configuration and the installed host's facts. */
export function laneRecipe({ configuration, facts, control, channels, boot }) {
  const agent = { ...BASE_AGENT, ...configuration.agent };
  if (configuration.kvUnifiedScale !== undefined) {
    agent.strategy = { ...agent.strategy, kvUnified: scaleKvUnified(facts.kvUnified, configuration.kvUnifiedScale) };
  }
  return {
    name: `Strategy fixture (${configuration.name})`,
    agent,
    ...(facts.takesMaintenanceInterval && configuration.maintenanceIntervalMs !== undefined ? { maintenanceIntervalMs: configuration.maintenanceIntervalMs } : {}),
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: [SERVER],
        env: { FIXTURE_CONTROL: control, FIXTURE_CHANNELS: channels.join(','), FIXTURE_BOOT: String(boot) },
        enabledFeatureSets: ['fixture'],
        allowHostCommands: true,
      },
    },
    modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false, ...configuration.modules },
  };
}

/**
 * The lane's recipe for `configuration` as the writer's key takes it, and its
 * hash: the recipe without what changes from run to run or with where the lane
 * runs from (the control socket, the boot, the paths of node and the server).
 */
export function recipeIdentity({ configuration, facts, channels }) {
  const recipe = laneRecipe({ configuration, facts, control: '', channels, boot: 0 });
  const { command, args, ...fixture } = recipe.mcpServers.fixture;
  const { FIXTURE_CONTROL, FIXTURE_BOOT, ...env } = fixture.env;
  return { ...recipe, mcpServers: { ...recipe.mcpServers, fixture: { ...fixture, env } } };
}

export const recipeHash = (opts) => createHash('sha256').update(JSON.stringify(recipeIdentity(opts))).digest('hex');

class RunFailure extends Error {}

/**
 * Run `steps` (lib/strategies/script.mjs) through the installed host at
 * `hostDir`, on the store at `storeDir`, against `standin`.
 * - The host's `Date` starts at `epoch` (ms) and moves only on `advance` steps.
 * - Every turn arrives on the fixture server's channel, and ends when the
 *   agent's turn has ended: its speech, then its stream's
 *   `inference:published_complete`. The run then settles: `maintain` until
 *   every agent is ready.
 * - Each step is set on the stand-in before it begins, and stays set through
 *   the settle after it. A stand-in can serve several runs in turn; each
 *   run's log holds only the requests that arrived while it ran.
 * - `logPath` gets one JSON line per record, its `kind` one of boot, ready,
 *   send, ipc (each host event, as `event`, with its arrival time), request
 *   (each stand-in arrival), settle (each pass, then `phase: 'end'` with
 *   `settled`), advance, checkpoint (with the health panel as `health`), copy,
 *   shutdown, exit, failure and end, each with `seq`, `wall` (ms since the run
 *   began), `clock` (virtual ms) and `step`.
 * Resolves with `{ ok, failure, clockEnd, copies, timing }` whatever happens:
 * a failure (an unclassified request, a failed turn, a refused command, an
 * unsettled checkpoint, the host exiting, a wait past its bound) stops the
 * run, shuts the host down, and is named in `failure`.
 */
export async function runScript({ steps, configuration, standin, hostDir, facts, work, storeDir, epoch, logPath }) {
  mkdirSync(work, { recursive: true });
  mkdirSync(storeDir, { recursive: true });
  const t0 = performance.now();
  const wall = () => Math.round((performance.now() - t0) * 10) / 10;
  let seq = 0;
  let clock = epoch;
  let current = null;
  const log = (kind, fields = {}) => appendFileSync(logPath, `${JSON.stringify({ seq: seq++, wall: wall(), clock, step: current?.id ?? null, kind, ...fields })}\n`);
  const channels = [...new Set(steps.filter((s) => s.kind === 'channel').map((s) => s.channel))];
  const control = join(tmpdir(), `fx-${process.pid}-${Math.random().toString(36).slice(2, 8)}.ctl`);
  const ctl = await listenForPeers(control);
  const watchers = new Set();
  const poke = () => { for (const w of [...watchers]) w(); };
  let failure = null;
  const fail = (f) => { if (!failure) { failure = f; log('failure', f); } poke(); };
  const until = (check, timeoutMs, label, { pollMs = 0 } = {}) => new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); clearInterval(poll); watchers.delete(attempt); };
    const attempt = () => {
      if (failure) { stop(); reject(new RunFailure(failure.reason)); return; }
      const v = check();
      if (v) { stop(); resolve(v); }
    };
    const timer = setTimeout(() => { stop(); fail({ step: current?.id ?? null, reason: `${label}: nothing after ${timeoutMs} ms` }); reject(new RunFailure(label)); }, timeoutMs);
    const poll = pollMs ? setInterval(attempt, pollMs) : undefined;
    watchers.add(attempt);
    attempt();
  });

  let ended = false;
  standin.setClock(clock);
  standin.onRequest((r) => {
    if (ended) return;
    log('request', { request: r });
    if (r.kind === 'unclassified') fail({ step: current?.id ?? null, reason: `the stand-in got a request it couldn't classify (${r.reason ?? r.id})` });
  });

  let host = null;
  let boots = 0;
  const timing = { boots: [], steps: [] };
  const copies = [];

  async function boot() {
    const b = { n: ++boots, events: [], stopping: false };
    const started = performance.now();
    const recipe = laneRecipe({ configuration, facts, control, channels, boot: b.n });
    const recipePath = join(work, `recipe-${b.n}.json`);
    writeFileSync(recipePath, JSON.stringify(recipe, null, 2));
    const sockPath = join(tmpdir(), `fx-${process.pid}-${b.n}.sock`);
    rmSync(sockPath, { force: true });
    const since = { server: ctl.generation('server'), clock: ctl.generation('clock') };
    log('boot', { boot: b.n, recipePath, storeDir });
    const env = { ANTHROPIC_BASE_URL: standin.url, ANTHROPIC_API_KEY: 'sk-ant-fixture', TZ: 'UTC', FIXTURE_CONTROL: control, FIXTURE_EPOCH_MS: String(clock) };
    const { child, out } = spawnHost({ hostDir, recipePath, dataDir: storeDir, cwd: work, sockPath, env, preload: PRELOAD });
    Object.assign(b, { child, out, sockPath });
    host = b;
    child.once('exit', (code, signal) => {
      log('exit', { boot: b.n, code, signal, expected: b.stopping });
      if (!b.stopping) fail({ step: current?.id ?? null, reason: `the host exited (${code ?? signal}) ${tail(out)}` });
      poke();
    });
    await until(() => existsSync(sockPath), BOOT_MS, `boot ${b.n}: the host's IPC socket`, { pollMs: 50 });
    for (let attempt = 0; !b.sock; attempt++) {
      try { b.sock = await ipcConnect(sockPath); } catch (e) {
        if (attempt >= 40 || failure) throw new RunFailure(`boot ${b.n}: couldn't connect to IPC: ${e.message}`);
        await sleep(50);
      }
    }
    lineReader(b.sock, (e) => {
      const at = wall();
      b.events.push({ at, e });
      log('ipc', { at, event: e });
      poke();
    });
    await until(() => b.events.some(({ e }) => e.type === 'lifecycle' && e.phase === 'ready'), BOOT_MS, `boot ${b.n}: lifecycle ready`);
    await ctl.waitConnected('server', { since: since.server, timeoutMs: BOOT_MS });
    await ctl.waitConnected('clock', { since: since.clock, timeoutMs: BOOT_MS });
    timing.boots.push(Math.round(performance.now() - started));
    log('ready', { boot: b.n, ms: timing.boots.at(-1) });
  }

  async function shutdown() {
    const b = host;
    if (!b) return;
    host = null;
    b.stopping = true;
    if (b.child.exitCode === null && b.child.signalCode === null) {
      if (b.sock) send(b.sock, { type: 'shutdown' });
      await new Promise((r) => { b.child.once('exit', r); setTimeout(r, SHUTDOWN_MS); });
    }
    try { b.sock?.destroy(); } catch { /* gone */ }
    stopHost(b.child);
    writeFileSync(join(work, `host-${b.n}.log`), b.out.join(''));
    log('shutdown', { boot: b.n, hostLog: join(work, `host-${b.n}.log`) });
  }

  const eventAfter = (from, test) => host.events.slice(from).find(({ e }) => test(e));

  async function settle() {
    for (let pass = 1; pass <= SETTLE_PASSES; pass++) {
      const t = performance.now();
      const answer = await ctl.hostCommand({ command: 'maintain' }, { timeoutMs: MAINTAIN_MS });
      const agents = answer?.maintenance?.agents ?? [];
      log('settle', { phase: 'pass', pass, ms: Math.round(performance.now() - t), ok: answer?.ok, ran: answer?.maintenance?.ran, runId: answer?.maintenance?.history?.[0]?.id ?? null, agents });
      if (answer?.ok && agents.every((a) => a.ready === true)) {
        log('settle', { phase: 'end', settled: true, passes: pass });
        return pass;
      }
    }
    log('settle', { phase: 'end', settled: false, passes: SETTLE_PASSES });
    fail({ step: current?.id ?? null, reason: `the run didn't settle in ${SETTLE_PASSES} maintenance passes` });
    throw new RunFailure('unsettled');
  }

  async function channelTurn(step) {
    const from = host.events.length;
    const message = { channelId: step.channel, messageId: step.id, author: { id: `u-${String(step.participant).toLowerCase()}`, name: step.participant }, topic: step.topic, text: step.text, at: clock };
    log('send', { via: 'channel', message: { ...message, text: `${step.text.length} chars` } });
    await ctl.deliver(message, { timeoutMs: TURN_MS });
    const ended = await until(() => eventAfter(from, (e) => e.type === 'inference:speech' || /^inference:(failed|exhausted|aborted)$/.test(e.type)), TURN_MS, `turn ${step.id}: its speech`);
    if (ended.e.type !== 'inference:speech') {
      fail({ step: step.id, reason: `the turn ended in ${ended.e.type}: ${JSON.stringify(ended.e).slice(0, 1500)}` });
      throw new RunFailure(ended.e.type);
    }
    const speechAt = host.events.indexOf(ended);
    await until(() => eventAfter(speechAt, (e) => e.type === 'inference:published_complete'), TURN_MS, `turn ${step.id}: its stream's end`);
    await settle();
  }

  async function command(step) {
    const name = /^\/(\S+)/.exec(step.command)?.[1];
    const ends = COMMANDS[name];
    if (!ends) {
      fail({ step: step.id, reason: `the driver doesn't know when ${JSON.stringify(step.command)} ends` });
      throw new RunFailure('unknown command');
    }
    const from = host.events.length;
    log('send', { via: 'ipc', command: step.command });
    send(host.sock, { type: 'command', command: step.command });
    const lines = () => host.events.slice(from).filter(({ e }) => e.type === 'command-output').map(({ e }) => String(e.text));
    const outcome = await until(() => ends(lines()), COMMAND_MS, `command ${step.command}`);
    if (outcome === 'failed') {
      fail({ step: step.id, reason: `${step.command} failed: ${lines().join(' | ').slice(0, 1500)}` });
      throw new RunFailure('command failed');
    }
  }

  async function advance(step) {
    await settle();
    const to = clock + step.ms;
    await ctl.advance(to);
    log('advance', { from: clock, to });
    clock = to;
    standin.setClock(clock);
  }

  async function checkpoint(step, last) {
    await settle();
    const corrId = `${step.id}:health`;
    const from = host.events.length;
    send(host.sock, { type: 'panel-request', op: 'health', corrId });
    const panel = await until(() => eventAfter(from, (e) => e.type === 'panel-response' && e.corrId === corrId), COMMAND_MS, `checkpoint ${step.id}: the health panel`);
    log('checkpoint', { name: step.name, health: panel.e });
    if (!step.copyStore) return;
    await shutdown();
    const dest = join(work, 'copies', step.name ?? step.id);
    rmSync(dest, { recursive: true, force: true });
    cpSync(storeDir, dest, { recursive: true });
    const sessions = existsSync(join(dest, 'sessions')) ? readdirSync(join(dest, 'sessions')).map((id) => join(dest, 'sessions', id)) : [];
    copies.push({ step: step.id, name: step.name, path: dest, sessions, clock });
    log('copy', { path: dest, sessions });
    if (!last) await boot();
  }

  async function restart(step) {
    await settle();
    await shutdown();
    await boot();
  }

  const KINDS = { channel: channelTurn, command, advance, restart };
  try {
    await boot();
    for (const [i, step] of steps.entries()) {
      current = step;
      standin.setStep(step);
      const started = performance.now();
      if (step.kind === 'checkpoint') await checkpoint(step, i === steps.length - 1);
      else if (KINDS[step.kind]) await KINDS[step.kind](step);
      else { fail({ step: step.id, reason: `the driver has no step kind ${JSON.stringify(step.kind)}` }); throw new RunFailure('unknown kind'); }
      timing.steps.push({ id: step.id, kind: step.kind, ms: Math.round(performance.now() - started) });
    }
  } catch (e) {
    if (!failure) fail({ step: current?.id ?? null, reason: e instanceof RunFailure ? e.message : String(e?.stack || e).slice(0, 3000) });
    if (host) log('host-output', { boot: host.n, tail: tail(host.out) });
  } finally {
    await shutdown();
    await ctl.close();
    ended = true;
    log('end', { ok: !failure, clockEnd: clock });
  }
  return { ok: !failure, failure, clockEnd: clock, copies, timing };
}

const tail = (out) => out.join('').split('\n').slice(-30).join('\n');
