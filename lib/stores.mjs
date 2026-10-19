/**
 * Stores written by earlier host releases (the cross-package check's part 4).
 *
 * captureStore() installs one published host release as a consumer would have had it
 * while it was `latest` (npm's `before` set to the next release's publish time), takes
 * two turns on a fresh data directory, and keeps that directory as a fixture with its
 * provenance. checkStores() boots a given host on a copy of each fixture and takes a turn.
 *
 * Both use the anthropic provider against a local stand-in (lib/fake-anthropic.mjs):
 * hosts before 0.8.0 have no `mock` provider, and the stand-in records each request,
 * so the check can see that the stored turns reached the model (the proof that the old
 * store was read, not just opened). Zero dependencies.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, cpSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { sh, waitFor, sleep, spawnHost, stopHost, ipcConnect, ipcReader, send, pickWebPort } from './common.mjs';
import { startFakeAnthropic } from './fake-anthropic.mjs';

export const STACK = ['chronicle', 'membrane', 'context-manager', 'agent-framework', 'connectome-host', 'mcpl-core', 'heartbeat-mcpl']
  .map((p) => `@animalabs/${p}`);

/** The recipe both capture and check use: anthropic provider, headless, heartbeat MCPL, web UI on loopback. */
export function storeRecipe({ webPort, auth, heartbeatEntry, dataDir }) {
  return {
    name: 'Connectome Smoke (stores)',
    description: 'stored-store check: anthropic provider against a local stand-in, headless, heartbeat MCPL',
    agent: {
      name: 'smoke',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
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

/**
 * Boot the host headless on `dataDir`, send one text, wait for the reply and idle, shut down.
 * Throws with the host's last output lines on any failure. Leaves <label>.events.jsonl and
 * <label>.host.log in `work` regardless.
 */
export async function driveTurn({ hostDir, recipePath, dataDir, work, label, env, text, reply, bootTimeoutMs = 120_000 }) {
  mkdirSync(dataDir, { recursive: true });
  // Unix socket paths cap at about 104 bytes on macOS, so keep it short and outside the work directory.
  const sockPath = join(tmpdir(), `cs-st-${process.pid}-${label}.sock`);
  const { child, out } = spawnHost({ hostDir, recipePath, dataDir, cwd: work, sockPath, env });
  let sock; let events = [];
  const die = (msg) => { const tail = out.join('').split('\n').slice(-40).join('\n'); throw new Error(`${msg}\n--- host output tail ---\n${tail}`); };
  try {
    await waitFor(() => child.exitCode !== null || existsSync(sockPath), bootTimeoutMs, `${label}: ipc socket`);
    if (child.exitCode !== null) die(`host exited ${child.exitCode} before opening ipc`);
    for (let attempt = 0; ; attempt++) {
      try { sock = await ipcConnect(sockPath); break; } catch (e) { if (attempt >= 20 || child.exitCode !== null) die(`ipc connect failed: ${e.message}`); await sleep(250); }
    }
    events = ipcReader(sock);
    await waitFor(() => events.some((e) => e.type === 'lifecycle' && e.phase === 'ready') || child.exitCode !== null, 30_000, `${label}: lifecycle:ready`);
    if (child.exitCode !== null) die(`host exited ${child.exitCode} before ready`);
    const bad = events.filter((e) => /^mcpl:server-(connect-failed|error)$/.test(e.type));
    if (bad.length) die(`MCPL server trouble: ${JSON.stringify(bad.slice(0, 3)).slice(0, 1500)}`);
    send(sock, { type: 'text', content: text });
    await waitFor(() => events.some((e) => e.type === 'message:added' && e.source === 'external-message') || child.exitCode !== null, 30_000, `${label}: message:added (external-message)`);
    await waitFor(() => events.some((e) => e.type === 'inference:speech' && String(e.content).includes(reply)) || events.some((e) => /^inference:(failed|exhausted)$/.test(e.type)) || child.exitCode !== null, 60_000, `${label}: inference:speech carrying the reply`);
    const failed = events.filter((e) => /^inference:(failed|exhausted)$/.test(e.type));
    if (failed.length) die(`inference failures: ${JSON.stringify(failed[0]).slice(0, 1500)}`);
    if (child.exitCode !== null) die(`host exited ${child.exitCode} during the turn`);
    await waitFor(() => events.some((e) => e.type === 'lifecycle' && e.phase === 'idle'), 30_000, `${label}: lifecycle:idle`);
    send(sock, { type: 'shutdown' });
    const code = await new Promise((r) => { if (child.exitCode !== null) r(child.exitCode); else { child.once('exit', r); setTimeout(() => r('timeout'), 20_000); } });
    if (code !== 0) die(`shutdown exit code ${code}`);
    return { events: events.length };
  } finally {
    try { sock?.destroy(); } catch { /* noop */ }
    stopHost(child);
    try { writeFileSync(join(work, `${label}.events.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n'); } catch { /* noop */ }
    try { writeFileSync(join(work, `${label}.host.log`), out.join('')); } catch { /* noop */ }
  }
}

/** What resolved in an install directory, for each stack package present. */
export function resolvedVersions(installDir) {
  const out = {};
  for (const p of STACK) {
    const pj = join(installDir, 'node_modules', p, 'package.json');
    if (existsSync(pj)) out[p] = JSON.parse(readFileSync(pj, 'utf-8')).version;
  }
  return out;
}

/** Every file under `dir` whose bytes contain `needle`, with the count of occurrences. */
export function filesContaining(dir, needle) {
  const hits = [];
  const n = Buffer.from(needle);
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      const buf = readFileSync(p);
      let count = 0; let i = buf.indexOf(n);
      while (i >= 0) { count++; i = buf.indexOf(n, i + n.length); }
      if (count) hits.push({ file: relative(dir, p), count });
    }
  };
  walk(dir);
  return hits;
}

function toolNames(body) {
  return Array.isArray(body?.tools) ? body.tools.map((t) => t?.name).filter(Boolean) : [];
}

/**
 * Install one host release as of `before`, take two turns, keep the data directory.
 * Writes `<out>/data/` and `<out>/fixture.json`. Returns the provenance.
 */
export async function captureStore({ step, version, before, work, out, smokeCommit }) {
  const installDir = join(work, 'install');
  const dataDir = join(work, 'data');
  mkdirSync(installDir, { recursive: true });
  const prov = {
    host: version, before, capturedAt: new Date().toISOString(), source: 'run', smokeCommit: smokeCommit ?? null,
    toolchain: {
      node: process.version,
      bun: (sh('bun', ['-v'], { cwd: work, allowFail: true }).stdout || '').trim() || null,
      npm: (sh('npm', ['-v'], { cwd: work, allowFail: true }).stdout || '').trim() || null,
      platform: `${process.platform}-${process.arch}`,
    },
    resolved: {}, turns: [], steps: [], absolutePaths: [], requests: 0,
  };
  const record = async (name, fn) => { const ok = await step(name, fn); prov.steps.push({ name, ok }); return ok; };

  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'connectome-smoke-capture', private: true, version: '0.0.0', type: 'module' }, null, 2));
  const installed = await record(`capture ${version}: npm install as of ${before}`, () => {
    const r = sh('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', `@animalabs/connectome-host@${version}`, '@animalabs/heartbeat-mcpl'],
      { cwd: installDir, timeout: 900_000, env: { npm_config_before: before } });
    prov.resolved = resolvedVersions(installDir);
    return Object.entries(prov.resolved).map(([k, v]) => `${k.replace('@animalabs/', '')}@${v}`).join(' ') + '\n' + (r.stdout + r.stderr).trim().split('\n').slice(-2).join('\n');
  });
  if (!installed) return prov;

  const hostDir = join(installDir, 'node_modules', '@animalabs', 'connectome-host');
  const heartbeatEntry = join(installDir, 'node_modules', '@animalabs', 'heartbeat-mcpl', 'dist', 'src', 'index.js');
  const nonce = Math.random().toString(36).slice(2, 10);
  const reply = `SMOKE-REPLY ${nonce}`;
  const fake = await startFakeAnthropic({ reply });
  try {
    const webPort = await pickWebPort();
    const auth = { username: 'smoke', password: `pw-${Math.random().toString(36).slice(2)}` };
    const recipePath = join(work, 'stores-recipe.json');
    writeFileSync(recipePath, JSON.stringify(storeRecipe({ webPort, auth, heartbeatEntry, dataDir }), null, 2));
    const env = { ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: 'sk-ant-smoke-fake' };
    for (const n of [1, 2]) {
      const text = `smoke capture ${version} turn ${n} ${nonce}`;
      const ok = await record(`capture ${version}: boot ${n}, one turn`, async () => {
        const r = await driveTurn({ hostDir, recipePath, dataDir, work, label: `capture${n}`, env, text, reply });
        return `events=${r.events} requests=${fake.messageRequests().length}`;
      });
      prov.turns.push({ n, text, reply, ok });
      if (!ok) break;
    }
  } finally {
    prov.requests = fake.messageRequests().length;
    prov.tools = [...new Set(fake.messageRequests().flatMap((r) => toolNames(r.body)))];
    await fake.close();
  }
  prov.nonce = nonce;
  if (existsSync(dataDir)) {
    prov.absolutePaths = filesContaining(dataDir, work);
    mkdirSync(out, { recursive: true });
    cpSync(dataDir, join(out, 'data'), { recursive: true });
  }
  prov.pass = prov.steps.every((s) => s.ok) && prov.turns.length === 2;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'fixture.json'), JSON.stringify(prov, null, 2) + '\n');
  return prov;
}

/** Fixtures under `fixturesDir`, sorted by version, each `{ version, dir }`. */
export function listFixtures(fixturesDir) {
  if (!existsSync(fixturesDir)) return [];
  const cmp = (a, b) => { const pa = a.split('.').map(Number); const pb = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); return 0; };
  return readdirSync(fixturesDir).filter((d) => statSync(join(fixturesDir, d)).isDirectory()).sort(cmp).map((version) => ({ version, dir: join(fixturesDir, version) }));
}

/** The check couldn't run on a fixture (its provenance or data unreadable): the source lane records it as infra, not a break. */
export class CouldNotRun extends Error {
  constructor(message) { super(message); this.smokeInfra = true; this.smokeCause = 'fixture'; }
}

/**
 * Boot `hostDir` on a copy of each fixture and take one turn. Each fixture is one step,
 * named `stores:<version>`, which passes only if the turn completes and the request it
 * sends carries both of the fixture's stored turns and the heartbeat tools. A fixture that
 * is missing its data or provenance throws CouldNotRun inside its step.
 *
 * `meta` (optional), as for bootTwice: `idPrefix` makes each step's id
 * `<idPrefix>:stores:<version>` and its stage `stores:<version>`, the rest is merged into
 * every step's record, with the paths of its host log and IPC events.
 *
 * Each result's `sent` holds the turn's text and the request that first carried it, as
 * the stand-in recorded it, for the cache check (lib/cache-write.mjs); null where the step
 * failed before that request was found, as when the turn failed.
 */
export async function checkStores({ step, hostDir, heartbeatEntry, work, fixturesDir, only, meta = null }) {
  const results = [];
  let fixtures = listFixtures(fixturesDir);
  if (only?.length) fixtures = fixtures.filter((f) => only.includes(f.version));
  for (const f of fixtures) {
    let couldNotRun = false;
    let sent = null;
    const runDir = join(work, 'stores', f.version);
    let m = {};
    if (meta) {
      const { idPrefix, ...rest } = meta;
      m = { ...rest, id: `${idPrefix}:stores:${f.version}`, stage: `stores:${f.version}`, log: join(runDir, 'check.host.log'), events: join(runDir, 'check.events.jsonl') };
    }
    const ok = await step(`stores:${f.version}`, async () => {
      let prov;
      try { prov = JSON.parse(readFileSync(join(f.dir, 'fixture.json'), 'utf-8')); }
      catch (e) { couldNotRun = true; throw new CouldNotRun(`fixture ${f.version}: no readable fixture.json (${e.message})`); }
      if (!existsSync(join(f.dir, 'data')) || !prov.pass || prov.turns?.length !== 2) {
        couldNotRun = true;
        throw new CouldNotRun(`fixture ${f.version}: no complete capture to check (data present: ${existsSync(join(f.dir, 'data'))}, capture pass: ${prov.pass})`);
      }
      const dataDir = join(runDir, 'data');
      mkdirSync(runDir, { recursive: true });
      cpSync(join(f.dir, 'data'), dataDir, { recursive: true });
      const nonce = Math.random().toString(36).slice(2, 10);
      const reply = `SMOKE-REPLY ${nonce}`;
      const fake = await startFakeAnthropic({ reply });
      try {
        const webPort = await pickWebPort();
        const auth = { username: 'smoke', password: `pw-${Math.random().toString(36).slice(2)}` };
        const recipePath = join(runDir, 'stores-recipe.json');
        writeFileSync(recipePath, JSON.stringify(storeRecipe({ webPort, auth, heartbeatEntry, dataDir }), null, 2));
        const text = `smoke check on ${f.version} ${nonce}`;
        await driveTurn({ hostDir, recipePath, dataDir, work: runDir, label: 'check', env: { ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: 'sk-ant-smoke-fake' }, text, reply });
        const reqs = fake.messageRequests();
        const last = reqs.find((r) => JSON.stringify(r.body?.messages ?? []).includes(text));
        if (!last) throw new Error(`no request carried this turn's text (${reqs.length} requests)`);
        sent = { text, request: last };
        const messages = JSON.stringify(last.body.messages);
        const missing = prov.turns.filter((t) => !messages.includes(t.text)).map((t) => `turn ${t.n}`);
        if (missing.length) throw new Error(`the stored ${missing.join(' and ')} did not reach the request: the host opened the store but didn't read its history`);
        const tools = toolNames(last.body);
        if (!tools.some((t) => /heartbeat/.test(t))) throw new Error(`heartbeat MCPL tools not in the request (tools: ${tools.slice(0, 12).join(', ') || 'none'})`);
        return `stored turns 1-2 in the request; ${reqs.length} request(s); tools ${tools.filter((t) => /heartbeat/.test(t)).join(',')}`;
      } finally { await fake.close(); }
    }, m);
    results.push({ version: f.version, ok, couldNotRun, sent });
  }
  return results;
}
