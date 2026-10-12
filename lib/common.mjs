/**
 * Shared plumbing for the smoke lanes: step/report bookkeeping, shell,
 * IPC client, and the host boot exercise (the part that proves the stack
 * takes a turn, not just that it installs).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as netConnect, createServer } from 'node:net';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A port for a host's web UI. It's drawn at random from 20000-32767, below
 * the ephemeral ranges Linux (32768-60999) and macOS (49152-65535) give
 * outgoing connections, so an open connection can't be holding it. It's
 * taken only if it binds on 127.0.0.1 now; another listener can still take
 * it between this probe and the host's own bind.
 */
export async function pickWebPort(tries = 20) {
  for (let i = 0; i < tries; i++) {
    const port = 20000 + Math.floor(Math.random() * 12768);
    const free = await new Promise((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`no free port in 20000-32767 after ${tries} tries`);
}
export async function waitFor(check, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { const v = check(); if (v) return v; await sleep(50); }
  throw new Error(`timeout after ${timeoutMs}ms waiting for: ${label}`);
}
const indent = (s) => s.split('\n').map((l) => '    ' + l).join('\n');

/** Report + step runner. Every step's outcome and duration lands in the JSON report. */
export function makeReport(lane, extra = {}) {
  const t0 = Date.now();
  const report = {
    lane, startedAt: new Date().toISOString(), node: process.version,
    bun: (spawnSync('bun', ['-v'], { encoding: 'utf-8' }).stdout || '').trim() || null,
    platform: `${process.platform}-${process.arch}`, steps: [], pass: null, ...extra,
  };
  const log = (m) => console.log(`[smoke:${lane} +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  /**
   * Run one step. `meta` (optional) is merged into the step's record: the
   * source lane gives each step a stable `id`, its `repo`, `pkg`, `tree` and
   * `stage`, and the path of its full log. A thrown error may carry `cause`
   * and `infra` (true when the check couldn't run, rather than finding a
   * break), which land on the record too.
   */
  function step(name, fn, meta = {}) {
    const s = { name, ...meta, status: 'fail', ok: false, ms: 0, detail: '' };
    const st = Date.now();
    return Promise.resolve().then(fn)
      .then((detail) => { s.ok = true; s.status = 'pass'; s.detail = typeof detail === 'string' ? detail : ''; })
      .catch((err) => {
        s.ok = false; s.status = 'fail'; s.detail = String(err?.stack || err).slice(0, 6000);
        if (err?.smokeCause) s.cause = err.smokeCause;
        if (err?.smokeInfra) s.infra = true;
        if (err?.smokeFields) Object.assign(s, err.smokeFields);
      })
      .then(() => { s.ms = Date.now() - st; report.steps.push(s); log(`${s.ok ? 'PASS' : 'FAIL'} ${s.id ?? name} (${s.ms}ms)${s.ok ? '' : '\n' + indent(s.detail)}`); return s.ok; });
  }
  /** Record a step that didn't run, and why. A skip is neither a pass nor a failure. */
  function skip(name, reason, meta = {}) {
    report.steps.push({ name, ...meta, status: 'skip', ok: true, ms: 0, detail: reason });
    log(`SKIP ${meta.id ?? name}: ${reason}`);
  }
  return { report, step, skip, log, t0 };
}

export function sh(cmd, cmdArgs, { cwd, env = {}, timeout = 600_000, allowFail = false } = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd, env: { ...process.env, ...env }, encoding: 'utf-8', timeout, maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${cmdArgs.join(' ')} (cwd ${cwd}) exited ${r.status}${r.signal ? ' signal ' + r.signal : ''}\n${(r.stdout + '\n' + r.stderr).trim().slice(-3000)}`);
  }
  return r;
}

export function findFile(dir, re) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) { const f = findFile(p, re); if (f) return f; }
    else if (re.test(ent.name)) return p;
  }
  return null;
}

// ---------------------------------------------------------------- IPC client
export function ipcConnect(path, timeoutMs = 5000) {
  return new Promise((res, rej) => {
    const s = netConnect(path);
    const t = setTimeout(() => { s.destroy(); rej(new Error(`ipc connect timeout ${path}`)); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); res(s); });
    s.once('error', (e) => { clearTimeout(t); rej(e); });
  });
}
export function ipcReader(sock) {
  const events = []; let buf = '';
  sock.on('data', (c) => {
    buf += c.toString('utf-8'); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { /* ignore */ }
    }
  });
  return events;
}
export const send = (sock, obj) => sock.write(JSON.stringify(obj) + '\n');

// ---------------------------------------------------------------- recipe
/**
 * The smoke recipe: mock provider with a deterministic reply carrying the
 * run nonce, web UI on loopback with basic auth, the heartbeat MCPL server
 * over stdio. Every optional module off — this is the stack's spine.
 */
export function makeRecipe({ nonce, webPort, auth, heartbeatEntry, dataDir }) {
  return {
    name: 'Connectome Smoke',
    description: 'stack smoke: mock provider, headless, heartbeat MCPL',
    agent: {
      name: 'smoke',
      provider: 'mock',
      mock: { echoMode: false, defaultResponse: `SMOKE-REPLY ${nonce}` },
      systemPrompt: 'You are the connectome smoke agent.',
    },
    mcpServers: {
      heartbeat: {
        command: 'node',
        args: [heartbeatEntry, '--stdio'],
        env: { HEARTBEAT_CONFIG_FILE: join(dataDir, 'heartbeat-config.json'), HEARTBEAT_REMINDERS_FILE: join(dataDir, 'heartbeat-reminders.json') },
        enabledFeatureSets: ['heartbeat'],
      },
    },
    modules: {
      subagents: false, lessons: false, retrieval: false, wake: false, workspace: false,
      webui: { host: '127.0.0.1', port: webPort, basicAuth: auth },
    },
  };
}

// ---------------------------------------------------------------- boot
export function spawnHost({ hostDir, recipePath, dataDir, cwd, sockPath, env = {} }) {
  const out = [];
  const child = spawn('bun', [join(hostDir, 'src', 'index.ts'), recipePath, '--headless', '--socket-path', sockPath], {
    cwd,
    env: { ...process.env, DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', NO_COLOR: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => out.push(d.toString()));
  child.stderr.on('data', (d) => out.push(d.toString()));
  return { child, out };
}

/**
 * Boot the host headless and drive one full turn:
 *   ipc ready → /help → text → message:added → inference:speech (nonce) →
 *   lifecycle:idle → /healthz 200 with auth, 401 without → llm-calls receipt
 *   → heartbeat tools offered to the model → shutdown exit 0.
 * Leaves <label>.events.jsonl and <label>.host.log in `work` regardless.
 */
export async function exerciseBoot({ hostDir, recipePath, dataDir, work, label, webPort, auth, nonce, bootTimeoutMs = 120_000, env = {} }) {
  mkdirSync(dataDir, { recursive: true });
  // Unix socket paths cap at ~104 bytes on macOS — keep it short and outside
  // the (possibly deep) workdir.
  const sockPath = join(tmpdir(), `cs-${process.pid}-${label}.sock`);
  try { rmSync(sockPath, { force: true }); } catch { /* noop */ }
  const { child, out } = spawnHost({ hostDir, recipePath, dataDir, cwd: work, sockPath, env });
  let sock; let events = [];
  const die = (msg) => { const tail = out.join('').split('\n').slice(-40).join('\n'); throw new Error(`${msg}\n--- host output tail ---\n${tail}`); };
  try {
    await waitFor(() => child.exitCode !== null || existsSync(sockPath), bootTimeoutMs, `${label}: ipc socket`);
    if (child.exitCode !== null) die(`host exited ${child.exitCode} before opening ipc`);
    for (let attempt = 0; ; attempt++) {
      try { sock = await ipcConnect(sockPath); break; }
      catch (e) { if (attempt >= 20 || child.exitCode !== null) die(`ipc connect failed: ${e.message}`); await sleep(250); }
    }
    events = ipcReader(sock);
    await waitFor(() => events.some((e) => e.type === 'lifecycle' && e.phase === 'ready'), 30_000, `${label}: lifecycle:ready`);

    send(sock, { type: 'command', command: '/help' });
    await waitFor(() => events.filter((e) => e.type === 'command-output').length >= 3, 10_000, `${label}: /help output`);

    const mcplBad = events.filter((e) => /^mcpl:server-(connect-failed|error)$/.test(e.type));
    if (mcplBad.length) die(`MCPL server trouble: ${JSON.stringify(mcplBad.slice(0, 3)).slice(0, 1500)}`);

    const text = `smoke ${label} ${nonce} ${Date.now()}`;
    send(sock, { type: 'text', content: text });
    await waitFor(() => events.some((e) => e.type === 'message:added' && e.source === 'external-message'), 30_000, `${label}: message:added (external-message)`);
    const speech = await waitFor(() => events.find((e) => e.type === 'inference:speech' && e.agentName === 'smoke' && String(e.content).includes(`SMOKE-REPLY ${nonce}`)), 60_000, `${label}: inference:speech carrying the recipe nonce`);
    await waitFor(() => events.some((e) => e.type === 'lifecycle' && e.phase === 'idle'), 30_000, `${label}: lifecycle:idle`);
    const failed = events.filter((e) => /^inference:(failed|exhausted)$/.test(e.type));
    if (failed.length) die(`inference failures: ${JSON.stringify(failed[0]).slice(0, 1500)}`);

    const authz = { authorization: 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64') };
    const res = await fetch(`http://127.0.0.1:${webPort}/healthz`, { headers: authz });
    if (res.status !== 200) die(`/healthz → ${res.status}`);
    const health = await res.json();
    const unauth = await fetch(`http://127.0.0.1:${webPort}/healthz`);
    if (unauth.status === 200) die('/healthz served WITHOUT auth');

    const llmLog = findFile(dataDir, /llm-calls.*\.jsonl$/);
    if (!llmLog) die('no llm-calls*.jsonl receipt written');
    const calls = readFileSync(llmLog, 'utf-8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const offered = new Set(calls.flatMap((c) => c?.requestSummary?.toolNames ?? []));
    const hbTools = [...offered].filter((t) => /heartbeat/.test(t));
    if (!hbTools.length) die(`heartbeat MCPL tools never offered to the model (receipt toolNames: ${[...offered].slice(0, 12).join(', ')})`);

    send(sock, { type: 'shutdown' });
    const code = await new Promise((r) => { if (child.exitCode !== null) r(child.exitCode); else { child.once('exit', r); setTimeout(() => r('timeout'), 20_000); } });
    if (code !== 0) die(`shutdown exit code ${code}`);
    return { speech: String(speech.content).slice(0, 120), healthKeys: Object.keys(health).slice(0, 12), events: events.length, hbTools };
  } finally {
    try { sock?.destroy(); } catch { /* noop */ }
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* noop */ } }
    try { rmSync(sockPath, { force: true }); } catch { /* noop */ }
    try { writeFileSync(join(work, `${label}.events.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n'); } catch { /* noop */ }
    try { writeFileSync(join(work, `${label}.host.log`), out.join('')); } catch { /* noop */ }
  }
}

/**
 * Two boots on one data dir: fresh, then a store reload with a second turn.
 * `meta` (optional) gives the source lane's step records: `idPrefix` makes
 * the ids `<idPrefix>:boot-1` and `<idPrefix>:boot-2`, the rest is merged
 * into both. `skip` (optional) records boot 2 as skipped when boot 1 fails.
 */
export async function bootTwice({ step, skip, hostDir, heartbeatEntry, work, dataDir, label = 'boot', meta = null }) {
  const webPort = await pickWebPort();
  const auth = { username: 'smoke', password: `pw-${Math.random().toString(36).slice(2)}` };
  const nonce = Math.random().toString(36).slice(2, 10);
  mkdirSync(dataDir, { recursive: true });
  const recipePath = join(work, `${label}-recipe.json`);
  writeFileSync(recipePath, JSON.stringify(makeRecipe({ nonce, webPort, auth, heartbeatEntry, dataDir }), null, 2));
  const m = (n) => {
    if (!meta) return {};
    const { idPrefix, ...rest } = meta;
    return { ...rest, id: `${idPrefix}:boot-${n}`, stage: `boot-${n}`, log: join(work, `${label}${n}.host.log`), events: join(work, `${label}${n}.events.jsonl`) };
  };
  const ok1 = await step(`${label} #1: ready → /help → turn → idle → /healthz → receipt → mcpl tools → shutdown`, async () => {
    const r = await exerciseBoot({ hostDir, recipePath, dataDir, work, label: `${label}1`, webPort, auth, nonce });
    return `speech="${r.speech}" mcpl-tools=[${r.hbTools.join(',')}] health=[${r.healthKeys.join(',')}] events=${r.events}`;
  }, m(1));
  if (!ok1) {
    if (skip) skip(`${label} #2: reload store → second turn → shutdown`, 'boot 1 failed', m(2));
    return false;
  }
  return step(`${label} #2: reload store → second turn → shutdown`, async () => {
    const r = await exerciseBoot({ hostDir, recipePath, dataDir, work, label: `${label}2`, webPort, auth, nonce });
    return `speech="${r.speech}" events=${r.events}`;
  }, m(2));
}

/** Write report.json + summary.md and exit with the verdict. */
export function finish({ report, t0, reportPath, summaryPath, headline, extraLines = [] }) {
  report.finishedAt = new Date().toISOString();
  report.pass = report.steps.length > 0 && report.steps.every((s) => s.ok) && !report.fatal;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  const lines = [
    `**connectome-smoke · ${report.lane}** — ${report.pass ? '✅ PASS' : '❌ FAIL'} (${((Date.now() - t0) / 1000).toFixed(0)}s, ${report.platform}, node ${report.node}, bun ${report.bun})`,
    headline,
    ...extraLines,
  ];
  for (const s of report.steps) lines.push(`${s.ok ? '✓' : '✗'} ${s.name}${s.ok ? '' : ' — ' + s.detail.split('\n')[0].slice(0, 300)}`);
  if (report.fatal) lines.push(`fatal: ${report.fatal.split('\n')[0]}`);
  writeFileSync(summaryPath, lines.join('\n') + '\n');
  console.log(`[smoke:${report.lane}] report → ${reportPath}`);
  console.log(`[smoke:${report.lane}] RESULT: ${report.pass ? 'PASS' : 'FAIL'}`);
  // A lane may set report.exitCode to say more than pass or fail, such as 2 for "couldn't run".
  process.exit(Number.isInteger(report.exitCode) ? report.exitCode : (report.pass ? 0 : 1));
}

export function parseArgs(argv) {
  const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
  /** Every value of a repeatable option, in the order given. */
  const opts = (name) => argv.flatMap((a, i) => (a === `--${name}` && i + 1 < argv.length ? [argv[i + 1]] : []));
  const flag = (name) => argv.includes(`--${name}`);
  return { opt, opts, flag };
}
