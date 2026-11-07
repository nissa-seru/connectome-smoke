/**
 * Long stores: what a resident's data directory holds after tens of turns, which the
 * two-turn fixtures under fixtures/stores/ don't. Context-manager's summaries and the
 * compressed windows that replace older turns only exist once a conversation has run
 * past its recent window, so these stores take many turns, on a recipe whose strategy
 * budgets are small enough that compression starts after tens of turns rather than
 * thousands (LONG_AGENT).
 *
 * captureLongStore() installs a published host release as an npm consumer gets it
 * (npm's `before` set as for captureStore), takes its turns over two boots against the
 * local stand-in for Anthropic, keeps the data directory with its provenance, and then
 * checks the release itself on a copy: it boots, takes one turn, and the request it
 * sends carries the summaries it wrote.
 *
 * The stand-in answers context-manager's compression calls with a summary of its own,
 * told apart by the summary system prompt context-manager sends with them. Each summary
 * carries the store's nonce and its number, so a later request shows which ones the
 * resident is given. Zero dependencies.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh, waitFor, sleep, spawnHost, stopHost, ipcConnect, ipcReader, send, pickWebPort } from './common.mjs';
import { startFakeAnthropic } from './fake-anthropic.mjs';
import { storeRecipe, resolvedVersions, filesContaining } from './stores.mjs';
import { listenForPeers } from './strategies/control.mjs';

/** This repository's root, where the tune-out store's MCPL server lives. */
const SMOKE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The opening of the in-band marker context-manager puts before the chunk it compresses
 * (0.24.2's COMPRESSION_MARKER, src/strategies/autobiographical.ts:513). A compression
 * call is otherwise the resident's own request, with its system prompt, tools and earlier
 * turns, so a request whose messages carry this is a compression call.
 */
export const COMPRESSION_MARKER_OPENING = 'You will soon form a new memory, get ready.';

/**
 * The budgets the long stores' recipes run under: a context budget well below what 40
 * turns of about 400 tokens need, so the strategy has to give the resident summaries in
 * place of older turns, a reply cap that leaves that budget room, and a recent window and
 * chunk size small enough to compress after tens of turns.
 */
export const LONG_AGENT = {
  maxTokens: 1024,
  contextBudgetTokens: 10000,
  strategy: { recentWindowTokens: 2000, targetChunkTokens: 500, summaryTargetTokens: 150 },
};

const WORDS = ('the resident kept a careful log of each message it read and answered while the smoke check '
  + 'walked through its turns one by one so that a later boot could find every part of what it had said').split(' ');

/** Deterministic filler, `count` words starting at an offset `seed`, so each turn's text differs. */
export function filler(seed, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(WORDS[(seed * 7 + i) % WORDS.length]);
  return out.join(' ');
}

export const turnTag = (n) => `t${String(n).padStart(3, '0')}`;

/** The text a long store's turn sends: its tag and the nonce, then about 120 words. */
export function turnText(variant, n, nonce) {
  return `smoke long ${variant} turn ${turnTag(n)} ${nonce}. ${filler(n, 120)}.`;
}

/** The reply the stand-in gives a turn: what the driver waits for, then about 120 words. */
export const turnReply = (n, nonce) => `SMOKE-REPLY ${nonce} ${turnTag(n)}`;

/**
 * A merge call, which consolidates earlier summaries into one at a higher level, carries
 * no marker: it ends with context-manager's merge instruction (formatMergeInstruction,
 * formatWitnessedMergeInstruction and formatReadingMergeInstruction, autobiographical.ts:836
 * on in 0.24.2 and :840 on in 0.25.0, the same text in both), which names the level it
 * writes in one of these ways.
 */
export const MERGE_INSTRUCTION = /consolidate into a single L\d+ memory|Consolidate them into a single L\d+ memory|consolidating at L\d+/;

export function isMergeRequest(body) {
  return MERGE_INSTRUCTION.test(lastUserText(body));
}

/** A call that writes a summary: a chunk's compression, or a merge. */
export function isCompressionRequest(body) {
  return JSON.stringify(body?.messages ?? []).includes(COMPRESSION_MARKER_OPENING) || isMergeRequest(body);
}

function lastUserText(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role !== 'user') continue;
    const c = msgs[i].content;
    return typeof c === 'string' ? c : JSON.stringify(c);
  }
  return '';
}

const blocksOf = (c) => (typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : []);

/** The tool_result blocks of a request's last message, when it's the user's. */
function lastToolResults(body) {
  const last = Array.isArray(body?.messages) ? body.messages.at(-1) : null;
  return last?.role === 'user' ? blocksOf(last.content).filter((b) => b?.type === 'tool_result') : [];
}

/** A tool_result block as `{ isError, text }`. */
const resultOf = (b) => ({ isError: !!b.is_error, text: blocksOf(b.content).map((x) => x.text ?? `[${x.type}]`).join(' ') });

/** The tag of the latest turn a request's user messages name, as `t<nnn>`, or null. */
function turnTagOf(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role !== 'user') continue;
    for (const b of blocksOf(msgs[i].content)) {
      const m = b?.type === 'text' ? /turn (t\d{3}) /.exec(b.text) : null;
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * The tune-out store's plan: at turn `at` the resident tunes out `channelId` with a summary
 * cadence of `cadenceSeconds` (0.32.0's floor), then `deliveries` messages arrive in that
 * channel, so the subconscious's reader has traffic to read when the cadence comes.
 */
export const TUNE_OUT = { channelId: 'smoke-room', at: 30, cadenceSeconds: 30, deliveries: 3 };

/** The subconscious's voice in these recipes, which its reader's requests carry. */
export const READER_VOICE = 'You read for smoke while they are tuned out. Report briefly.';

export function isReaderRequest(body) {
  return JSON.stringify(body?.system ?? '').includes(READER_VOICE) || JSON.stringify(body?.messages ?? []).includes(READER_VOICE);
}

/**
 * The stand-in's answer for a long store. A compression call gets
 * `SMOKE-SUMMARY <nonce> s<k>` and a few dozen words; any other call gets the reply
 * for the latest turn its user messages name, or `SMOKE-REPLY <nonce> t???` when they name none.
 * `summaries` collects each summary's number and text, in the order they were given.
 *
 * With `tuneOut` (TUNE_OUT), the resident's request for turn `tuneOut.at` is answered with a
 * `tune_out` call instead, and the request after it, which carries the call's result, with
 * that turn's reply. A request from the subconscious's reader (isReaderRequest) is answered
 * with a `deliver_summary` call, `SMOKE-READER <nonce> r<k>`, and the request carrying its
 * result with a line of text. `tuneOut.results` and `readers` record what came back.
 */
export function longReplier(nonce, { tuneOut = null } = {}) {
  const summaries = [];
  const readers = [];
  const tuned = tuneOut ? { asked: false, results: [] } : null;
  const reply = (body) => {
    if (isCompressionRequest(body)) {
      const k = summaries.length + 1;
      const kind = isMergeRequest(body) ? 'merge' : 'chunk';
      const text = `SMOKE-SUMMARY ${nonce} s${k}: ${kind === 'merge' ? 'earlier memories' : 'earlier turns'} of the smoke conversation, ${filler(k, 40)}.`;
      summaries.push({ k, kind, text });
      return text;
    }
    const results = lastToolResults(body);
    if (tuneOut && isReaderRequest(body)) {
      if (results.length) {
        readers.at(-1)?.results.push(...results.map(resultOf));
        return { text: `SMOKE-READER ${nonce} done.` };
      }
      const k = readers.length + 1;
      const text = `SMOKE-READER ${nonce} r${k}: the ${tuneOut.channelId} traffic so far, ${filler(k + 11, 30)}.`;
      readers.push({ k, text, results: [] });
      return { calls: [{ name: 'deliver_summary', input: { text, channelId: tuneOut.channelId } }] };
    }
    const tag = turnTagOf(body) ?? 't???';
    const n = tag === 't???' ? 0 : Number(tag.slice(1));
    if (tuneOut && n === tuneOut.at) {
      if (!results.length && !tuned.asked) {
        tuned.asked = true;
        return { calls: [{ name: 'tune_out', input: { channelId: tuneOut.channelId, cadenceSeconds: tuneOut.cadenceSeconds } }] };
      }
      if (results.length) tuned.results.push(...results.map(resultOf));
    }
    return `SMOKE-REPLY ${nonce} ${tag}. ${filler(n + 3, 120)}.`;
  };
  return { reply, summaries, readers, tuned };
}

/**
 * The recipe a long store runs: the stored-store recipe with the small strategy
 * budgets, and, for `subconscious`, a subconscious with reader forks and subagents on
 * (the recipe of the cache-write lane's second Nov 6 run). `tuneout` is `subconscious` with
 * the strategy fixture's MCPL server (lib/strategies/mcpl-server.mjs) registering
 * TUNE_OUT.channelId, since 0.32.0's tune_out refuses a channel nothing registered:
 * `smokeRoot` is this repository's root, `controlPath` the fixture's control socket
 * (lib/strategies/control.mjs) and `boot` the boot's ordinal.
 */
export function longRecipe({ variant, webPort, auth, heartbeatEntry, dataDir, smokeRoot, controlPath, boot }) {
  const r = storeRecipe({ webPort, auth, heartbeatEntry, dataDir });
  r.name = `Connectome Smoke (long store: ${variant})`;
  r.description = `long stored-store capture (${variant}): anthropic provider against a local stand-in, headless, heartbeat MCPL, small strategy budgets`;
  r.agent.maxTokens = LONG_AGENT.maxTokens;
  r.agent.contextBudgetTokens = LONG_AGENT.contextBudgetTokens;
  r.agent.strategy = { ...LONG_AGENT.strategy };
  if (variant === 'subconscious' || variant === 'tuneout') {
    r.subconscious = { enabled: true, reader: 'forks', model: 'claude-sonnet-4-5', voice: READER_VOICE };
    r.modules.subagents = true;
  }
  if (variant === 'tuneout') {
    r.mcpServers.fixture = {
      command: 'node',
      args: [join(smokeRoot, 'lib', 'strategies', 'mcpl-server.mjs')],
      env: { FIXTURE_CONTROL: controlPath, FIXTURE_CHANNELS: TUNE_OUT.channelId, FIXTURE_BOOT: boot },
      enabledFeatureSets: ['fixture'],
    };
  } else if (variant !== 'plain' && variant !== 'subconscious') {
    throw new Error(`no long-store variant ${variant}`);
  }
  return r;
}

/** The markers a captured recipe holds in place of the run's own values (fillRecipe). */
export const RUN_MARKERS = {
  heartbeatEntry: '{{heartbeatEntry}}', dataDir: '{{dataDir}}', webPort: { $run: 'webPort' }, auth: { $run: 'auth' },
  smokeRoot: '{{smokeRoot}}', controlPath: '{{controlPath}}', boot: '{{boot}}',
};

/**
 * A captured recipe with the run's own values put back: each `{{name}}` inside a string
 * (heartbeatEntry, dataDir, and for `tuneout` smokeRoot, controlPath and boot), and
 * `{ "$run": name }` for a whole value. Nothing else changes; a marker with no value throws.
 */
export function fillRecipe(recipe, values) {
  const fill = (v) => {
    if (typeof v === 'string') {
      return v.replace(/\{\{(\w+)\}\}/g, (_, name) => {
        if (values[name] === undefined) throw new Error(`fillRecipe: no value for {{${name}}}`);
        return String(values[name]);
      });
    }
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === '$run') {
        if (!(v.$run in values)) throw new Error(`fillRecipe: no value for ${v.$run}`);
        return values[v.$run];
      }
      return Object.fromEntries(keys.map((k) => [k, fill(v[k])]));
    }
    return v;
  };
  return fill(recipe);
}

/** Each session's MANIFEST format version: the byte after the "RST\0" magic, or null. */
export function manifestVersions(dataDir) {
  const out = {};
  const dir = join(dataDir, 'sessions');
  if (!existsSync(dir)) return out;
  for (const id of readdirSync(dir)) {
    const p = join(dir, id, 'MANIFEST');
    if (!existsSync(p)) continue;
    const b = readFileSync(p);
    out[id] = b.length === 5 && b.subarray(0, 4).toString('latin1') === 'RST\0' ? b[4] : null;
  }
  return out;
}

/**
 * Wait until the stand-in `fake` has had no new request, of any kind, for `ms`: then no
 * compression or merge call is in flight. It looks only at `fake.requests`, the stand-in's
 * record of every request in arrival order. Gives up after 10 minutes.
 */
export async function waitQuiet(fake, ms, label = `the stand-in quiet for ${ms}ms`) {
  let seen = fake.requests.length; let since = Date.now();
  await waitFor(() => {
    if (fake.requests.length !== seen) { seen = fake.requests.length; since = Date.now(); }
    return Date.now() - since >= ms;
  }, 600_000, label);
}

/**
 * Boot the host headless on `dataDir`, take each of `turns` in order (send its text, wait
 * for the speech carrying its reply, then idle, then `settleMs` of quiet, then `afterTurn(turn)`
 * when given), wait until the stand-in has had no new request for `quietMs`, and shut down. Throws with the host's last output lines on any
 * failure. Leaves <label>.events.jsonl and <label>.host.log in `work` regardless.
 */
export async function driveTurns({ hostDir, recipePath, dataDir, work, label, env, turns, fake, afterTurn = null, quietMs = 5_000, settleMs = 1_500, bootTimeoutMs = 120_000, turnTimeoutMs = 120_000 }) {
  mkdirSync(dataDir, { recursive: true });
  const sockPath = join(tmpdir(), `cs-ls-${process.pid}-${label}.sock`);
  const { child, out } = spawnHost({ hostDir, recipePath, dataDir, cwd: work, sockPath, env });
  let sock; let events = [];
  const die = (msg) => { const tail = out.join('').split('\n').slice(-40).join('\n'); throw new Error(`${msg}\n--- host output tail ---\n${tail}`); };
  const quiet = (ms, what) => waitQuiet(fake, ms, what);
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
    for (const t of turns) {
      const from = events.length;
      send(sock, { type: 'text', content: t.text });
      const after = () => events.slice(from);
      await waitFor(() => after().some((e) => e.type === 'inference:speech' && String(e.content).includes(t.reply)) || after().some((e) => /^inference:(failed|exhausted)$/.test(e.type)) || child.exitCode !== null, turnTimeoutMs, `${label}: speech carrying ${t.reply}`);
      const failed = after().filter((e) => /^inference:(failed|exhausted)$/.test(e.type));
      if (failed.length) die(`inference failure at ${t.reply}: ${JSON.stringify(failed[0]).slice(0, 1500)}`);
      if (child.exitCode !== null) die(`host exited ${child.exitCode} at ${t.reply}`);
      const spoke = from + after().findIndex((e) => e.type === 'inference:speech' && String(e.content).includes(t.reply));
      await waitFor(() => events.slice(spoke).some((e) => e.type === 'lifecycle' && e.phase === 'idle'), 60_000, `${label}: idle after ${t.reply}`);
      t.ok = true;
      // A resident's turns come minutes apart, and compression runs between them. These come
      // as fast as the stand-in answers, so each waits for compression to go quiet first.
      await quiet(settleMs, `${label}: the stand-in quiet for ${settleMs}ms after ${t.reply}`);
      if (afterTurn) await afterTurn(t);
    }
    // Compression runs behind the turns: let it finish before the shutdown.
    await quiet(quietMs, `${label}: the stand-in quiet for ${quietMs}ms`);
    send(sock, { type: 'shutdown' });
    const code = await new Promise((r) => { if (child.exitCode !== null) r(child.exitCode); else { child.once('exit', r); setTimeout(() => r('timeout'), 30_000); } });
    if (code !== 0) die(`shutdown exit code ${code}`);
    return { events: events.length };
  } finally {
    try { sock?.destroy(); } catch { /* noop */ }
    stopHost(child);
    try { writeFileSync(join(work, `${label}.events.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n'); } catch { /* noop */ }
    try { writeFileSync(join(work, `${label}.host.log`), out.join('')); } catch { /* noop */ }
  }
}

/** Every summary tag (`s<k>`) of `nonce` a request's messages carry, and every turn tag. */
export function tagsIn(body, nonce) {
  const s = JSON.stringify(body?.messages ?? []);
  const summaries = [...new Set([...s.matchAll(new RegExp(`SMOKE-SUMMARY ${nonce} (s\\d+)`, 'g'))].map((m) => m[1]))];
  const turns = [...new Set([...s.matchAll(new RegExp(`turn (t\\d{3}) ${nonce}`, 'g'))].map((m) => m[1]))].sort();
  return { summaries, turns };
}

/**
 * Install `version` as of `before`, take `turnCount` turns over two boots on a fresh data
 * directory, keep it at `<out>/data/` with its provenance in `<out>/fixture.json`, then boot
 * the same install on a copy and take one turn (`check` in the provenance). Returns the provenance.
 */
export async function captureLongStore({ step, version, before, work, out, smokeCommit, variant, turnCount }) {
  const installDir = join(work, 'install');
  const dataDir = join(work, 'data');
  mkdirSync(installDir, { recursive: true });
  const prov = {
    host: version, variant, before, capturedAt: new Date().toISOString(), source: 'run', smokeCommit: smokeCommit ?? null,
    toolchain: {
      node: process.version,
      bun: (sh('bun', ['-v'], { cwd: work, allowFail: true }).stdout || '').trim() || null,
      npm: (sh('npm', ['-v'], { cwd: work, allowFail: true }).stdout || '').trim() || null,
      platform: `${process.platform}-${process.arch}`,
    },
    resolved: {}, agent: JSON.parse(JSON.stringify(LONG_AGENT)),
    recipe: longRecipe({ variant, ...RUN_MARKERS }),
    standIn: {
      module: 'lib/fake-anthropic.mjs', replier: 'longReplier(nonce), lib/long-stores.mjs',
      compression: `a request whose messages carry "${COMPRESSION_MARKER_OPENING}" (context-manager's compression marker), or whose last message is its merge instruction (${MERGE_INSTRUCTION}), gets "SMOKE-SUMMARY <nonce> s<k>: " and 40 words, k counting from 1 across both kinds`,
      otherwise: 'every other request gets "SMOKE-REPLY <nonce> <turn tag>. " and 120 words, the tag (t001...) taken from the last user message',
    },
    turns: [], boots: [], steps: [], absolutePaths: [],
    requests: 0, compressionRequests: 0, summaries: [], manifest: {}, check: null,
  };
  const record = async (name, fn) => { const ok = await step(name, fn); prov.steps.push({ name, ok }); return ok; };

  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'connectome-smoke-capture', private: true, version: '0.0.0', type: 'module' }, null, 2));
  const installed = await record(`long ${variant} ${version}: npm install as of ${before}`, () => {
    const r = sh('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', `@animalabs/connectome-host@${version}`, '@animalabs/heartbeat-mcpl'],
      { cwd: installDir, timeout: 900_000, env: { npm_config_before: before } });
    prov.resolved = resolvedVersions(installDir);
    return Object.entries(prov.resolved).map(([k, v]) => `${k.replace('@animalabs/', '')}@${v}`).join(' ') + '\n' + (r.stdout + r.stderr).trim().split('\n').slice(-2).join('\n');
  });
  if (!installed) return prov;

  const hostDir = join(installDir, 'node_modules', '@animalabs', 'connectome-host');
  const heartbeatEntry = join(installDir, 'node_modules', '@animalabs', 'heartbeat-mcpl', 'dist', 'src', 'index.js');
  const nonce = Math.random().toString(36).slice(2, 10);
  prov.nonce = nonce;
  const tuneOut = variant === 'tuneout' ? TUNE_OUT : null;
  const replier = longReplier(nonce, { tuneOut });
  const fake = await startFakeAnthropic({ reply: replier.reply });
  const env = { ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: 'sk-ant-smoke-fake' };
  const auth = { username: 'smoke', password: `pw-${Math.random().toString(36).slice(2)}` };
  // The tune-out store's channel: the strategy fixture's server and its control socket.
  const controlPath = join(tmpdir(), `cs-lsc-${process.pid}.sock`);
  const peers = tuneOut ? await listenForPeers(controlPath) : null;
  const deliveries = [];
  const afterTurn = tuneOut ? async (t) => {
    if (t.n !== tuneOut.at) return;
    if (!replier.tuned.asked) throw new Error(`turn ${t.n}: the stand-in never asked for tune_out`);
    const failed = replier.tuned.results.filter((r) => r.isError);
    if (!replier.tuned.results.length || failed.length) throw new Error(`tune_out's result: ${JSON.stringify(replier.tuned.results)}`);
    await peers.waitConnected('server');
    for (let k = 1; k <= tuneOut.deliveries; k++) {
      const message = { channelId: tuneOut.channelId, messageId: `smoke-room-${nonce}-${k}`, author: { id: 'robin', name: 'Robin' }, text: `smoke room message ${k} ${nonce}: ${filler(k + 20, 20)}.`, at: Date.now() };
      deliveries.push({ messageId: message.messageId, text: message.text, accepted: !!(await peers.deliver(message)) });
    }
    // The reader reads at the tune-out's cadence; wait for it, then for quiet.
    const deadline = Date.now() + (tuneOut.cadenceSeconds + 60) * 1000;
    while (!replier.readers.length && Date.now() < deadline) await sleep(500);
    await waitQuiet(fake, 3_000);
  } : null;
  const recipeFor = (b, values) => fillRecipe(prov.recipe, { ...values, smokeRoot: SMOKE_ROOT, controlPath, boot: String(b) });
  try {
    const webPort = await pickWebPort();
    const recipePath = join(work, 'long-recipe.json');
    const all = Array.from({ length: turnCount }, (_, i) => ({ n: i + 1, text: turnText(variant, i + 1, nonce), reply: turnReply(i + 1, nonce), ok: false }));
    const half = Math.ceil(turnCount / 2);
    for (const [b, turns] of [[1, all.slice(0, half)], [2, all.slice(half)]]) {
      const ok = await record(`long ${variant} ${version}: boot ${b}, ${turns.length} turns`, async () => {
        writeFileSync(recipePath, JSON.stringify(recipeFor(b, { webPort, auth, heartbeatEntry, dataDir }), null, 2));
        const before = fake.messageRequests().length;
        const r = await driveTurns({ hostDir, recipePath, dataDir, work, label: `capture${b}`, env, turns, fake, afterTurn });
        prov.boots.push({ boot: b, turns: turns.map((t) => t.n), requests: fake.messageRequests().length - before });
        return `events=${r.events} requests=${fake.messageRequests().length - before} summaries so far=${replier.summaries.length}`;
      });
      if (!ok) break;
    }
    prov.turns = all.map(({ n, text, reply, ok }) => ({ n, text, reply, ok }));
  } finally {
    prov.requests = fake.messageRequests().length;
    prov.compressionRequests = fake.messageRequests().filter((r) => isCompressionRequest(r.body)).length;
    // Every message request by what it was: a chunk's compression, a merge, or by its model and max_tokens.
    prov.requestKinds = {};
    for (const r of fake.messageRequests()) {
      const k = isMergeRequest(r.body) ? 'merge' : isCompressionRequest(r.body) ? 'chunk' : `${r.body?.model} max_tokens ${r.body?.max_tokens}`;
      prov.requestKinds[k] = (prov.requestKinds[k] ?? 0) + 1;
    }
    prov.summaries = replier.summaries;
    if (tuneOut) {
      prov.tuneOut = { plan: tuneOut, asked: replier.tuned.asked, results: replier.tuned.results, deliveries, readers: replier.readers };
      prov.requestKinds.reader = fake.messageRequests().filter((r) => isReaderRequest(r.body) && !isCompressionRequest(r.body)).length;
    }
    await fake.close();
    await peers?.close();
  }
  if (existsSync(dataDir)) {
    prov.manifest = manifestVersions(dataDir);
    prov.absolutePaths = filesContaining(dataDir, work);
    mkdirSync(out, { recursive: true });
    cpSync(dataDir, join(out, 'data'), { recursive: true });
  }
  const captured = prov.steps.every((s) => s.ok) && prov.turns.length === turnCount && prov.turns.every((t) => t.ok);

  if (captured) {
    await record(`long ${variant} ${version}: the release boots on a copy and gives the resident its summaries`, async () => {
      const runDir = join(work, 'check');
      const copy = join(runDir, 'data');
      mkdirSync(runDir, { recursive: true });
      cpSync(dataDir, copy, { recursive: true });
      const checkNonce = Math.random().toString(36).slice(2, 10);
      const text = `smoke long check on ${variant} ${checkNonce}`;
      const reply = `SMOKE-REPLY ${checkNonce}`;
      const cfake = await startFakeAnthropic({ reply: (body) => (isCompressionRequest(body) ? `SMOKE-SUMMARY ${checkNonce} check` : `${reply}.`) });
      const cpeers = tuneOut ? await listenForPeers(controlPath) : null;
      try {
        const webPort = await pickWebPort();
        const recipePath = join(runDir, 'long-recipe.json');
        // The lane's way: the captured recipe with this boot's own values (fillRecipe).
        writeFileSync(recipePath, JSON.stringify(recipeFor(3, { webPort, auth, heartbeatEntry, dataDir: copy }), null, 2));
        await driveTurns({ hostDir, recipePath, dataDir: copy, work: runDir, label: 'check', env: { ...env, ANTHROPIC_BASE_URL: cfake.url }, turns: [{ text, reply }], fake: cfake });
        const reqs = cfake.messageRequests();
        const first = reqs.find((r) => !isCompressionRequest(r.body) && JSON.stringify(r.body?.messages ?? []).includes(text));
        if (!first) throw new Error(`no request carried the check's text (${reqs.length} requests)`);
        const tags = tagsIn(first.body, nonce);
        prov.check = { text, requests: reqs.length, summariesGiven: tags.summaries, turnsGiven: tags.turns, manifestAfter: manifestVersions(copy) };
        if (tuneOut) {
          const s = JSON.stringify(first.body?.messages ?? []);
          prov.check.readerTextsGiven = [...new Set([...s.matchAll(new RegExp(`SMOKE-READER ${nonce} (r\\d+)`, 'g'))].map((m) => m[1]))];
          prov.check.tuneOutNotices = (s.match(/Tune-out/g) ?? []).length;
        }
        if (!tags.summaries.length) throw new Error(`the request carried none of the store's ${prov.summaries.length} summaries (turns given: ${tags.turns.join(',')})`);
        return `summaries given: ${tags.summaries.join(',')}; turns given verbatim: ${tags.turns.length} of ${turnCount}`;
      } finally { await cfake.close(); await cpeers?.close(); }
    });
  }
  prov.pass = prov.steps.every((s) => s.ok) && captured;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'fixture.json'), JSON.stringify(prov, null, 2) + '\n');
  return prov;
}
