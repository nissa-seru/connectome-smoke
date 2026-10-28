import { createHash } from 'node:crypto';

/**
 * The strategy fixture's conversation: the configurations it runs, the deep store's prefix,
 * the per-check continuation, and what each segment exists to produce.
 *
 * Every step has an `id`, its `segment` and a `kind` the driver executes (lib/strategies/driver.mjs).
 * A turn is a `channel` step: a message on the fixture server's channel `CHANNEL`, from
 * `participant`, under `topic`, as residents get their turns, with IPC kept for commands.
 * A step that makes the agent run carries `replies`, one per agent request the turn
 * makes, in order (a tool round is two requests in one stream, which ends in one speech), and
 * `canaries`, the canaries whose appearance in a request's last message makes it this step's
 * agent request.
 * Every message the script writes carries a canary naming its step: the input `[[c:ID.in]]`,
 * the k-th reply `[[c:ID.rK]]`, the k-th call's result `[[c:ID.callK]]`.
 */

/** Budgets are the host's defaults (connectome-host 0.15.0: a 300,000-token budget, a
 *  4,000-token head, context-manager's 3,000-token chunks, 2,000-token summaries, a
 *  10,000-token message cap) scaled by this, so a few hundred turns reach L2 and L3. */
export const SCALE = 1 / 15;
export const TOOL = 'mcpl--fixture--result';
export const CHANNEL = 'chat';
const PARTICIPANTS = ['Ash', 'Tavy', 'Wren'];
const MINUTE = 60_000;

const scaled = (n) => Math.round(n * SCALE);

/**
 * The model families full runs add to the default's `claude-opus-4-6`: one for each other
 * pairing of the cache-read price kv-unified weighs (connectome-host `call-pricing.ts`,
 * `anthropicBaseRate`) with context-manager's Fable/Mythos branch, which defers a
 * summariser's chunks before the host declares its tools and drops `tools` on its last
 * retry (`autobiographical.ts`, `isToolsLessRefusingSummarizer`). Opus 4.6 reads at the
 * default 0.1x without the branch.
 */
export const FULL_RUN_MODELS = [
  'claude-opus-5-5', // 0.05x, no branch
  'claude-fable-5-1', // 0.025x, with the branch
  'claude-fable-5', // 0.1x, with the branch
];

/**
 * The configurations, each with the recipe patch the driver applies to the lane's recipe
 * (`agent`), the stand-in's view of the model (`windowTokens`, `binds`), and which segments
 * it runs. `kvUnifiedScale` asks the lane to take the host's own `standardKvUnifiedConfig`
 * for the model and scale its token-sized fields (scaleKvUnified), so the fixture follows
 * the host under test rather than a copy of it. The model is the host's own default
 * (connectome-host `src/recipe.ts`, `claude-opus-4-6`), which most shipped recipes run.
 * `maintenanceIntervalMs` goes at the recipe's top level only for a host that takes the key
 * (the driver asks the installed host's `unknownRecipeKeys`): connectome-host 0.15.0 refuses a
 * recipe with a key it doesn't know, and passing it through is the host change still to come.
 */
export function configurations({ model = 'claude-opus-4-6' } = {}) {
  const agent = {
    model,
    contextBudgetTokens: scaled(300_000),
    maxTokens: 2048,
    cacheKeepalive: { enabled: false },
  };
  const strategy = {
    headWindowTokens: scaled(4000),
    targetChunkTokens: scaled(3000),
    summaryTargetTokens: scaled(2000),
    maxMessageTokens: scaled(10_000),
  };
  return {
    default: { name: 'default', agent: { ...agent, strategy }, kvUnifiedScale: SCALE, maintenanceIntervalMs: 0, windowTokens: 200_000, binds: false, summarises: true },
    passthrough: { name: 'passthrough', agent: { ...agent, strategy: { type: 'passthrough' } }, maintenanceIntervalMs: 0, windowTokens: 200_000, binds: false, summarises: false },
  };
}

/** The host's standard kv-unified block with its token-sized fields scaled. */
export function scaleKvUnified(standard, scale = SCALE) {
  const tokenSized = (key) => /Scale$|BucketSize$|HalfLifeTokens$|^labelCeiling$|^adoptEpsilon$/.test(key);
  const walk = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? walk(v) : tokenSized(k) && typeof v === 'number' ? Math.max(1, Math.round(v * scale)) : v]));
  return walk(standard);
}

// ---------------------------------------------------------------- text

const WORDS = ('river stone lantern harbor quiet orchard ledger signal meadow copper window thread garden compass winter '
  + 'bridge morning letter answer kettle market island pencil shadow ribbon station velvet canyon basket').split(' ');

/** A deterministic pseudo-random sequence seeded by a string. */
function rng(seed) {
  let k = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) || 1;
  return () => { k = (k * 1103515245 + 12345) % 2147483648; return k / 2147483648; };
}

function prose(chars, seed) {
  const r = rng(seed);
  let s = '';
  while (s.length < chars) {
    const n = 6 + Math.floor(r() * 12);
    const words = Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]);
    s += words[0][0].toUpperCase() + words.join(' ').slice(1) + '. ';
  }
  return s.slice(0, chars).trimEnd();
}

const canary = (id, part) => `[[c:${id}.${part}]]`;

// ---------------------------------------------------------------- steps

function turn(id, segment, { chars, replyChars = 160, calls = [], rounds = null, thinking = null, more = {} }) {
  const r = rng(`${id}:sizes`);
  const input = `${canary(id, 'in')} ${prose(chars, `${id}:in`)}`;
  const replies = [];
  const canaries = [canary(id, 'in')];
  const allRounds = rounds ?? (calls.length ? [calls] : []);
  if (allRounds.length || thinking) {
    let k = 0;
    allRounds.forEach((roundCalls, i) => {
      const reply = { text: `${canary(id, `r${i + 1}`)} ${prose(80 + Math.floor(r() * 80), `${id}:r${i + 1}`)}` };
      if (thinking && i === 0) reply.thinking = prose(thinking, `${id}:think`);
      reply.calls = roundCalls.map((c) => {
        const callCanary = canary(id, `call${++k}`);
        canaries.push(callCanary);
        return { name: TOOL, input: { ...c, canary: callCanary } };
      });
      replies.push(reply);
    });
    const last = allRounds.length + 1;
    replies.push({ text: `${canary(id, `r${last}`)} ${prose(replyChars, `${id}:r${last}`)}` });
  } else {
    replies.push({ text: `${canary(id, 'r1')} ${prose(replyChars, `${id}:r1`)}` });
  }
  const participant = PARTICIPANTS[Math.floor(r() * PARTICIPANTS.length)];
  return { id, segment, kind: 'channel', channel: CHANNEL, participant, topic: segment, text: input, canaries, replies, ...more };
}

const advance = (id, segment, ms) => ({ id, segment, kind: 'advance', ms });
const checkpoint = (id, segment, more = {}) => ({ id, segment, kind: 'checkpoint', name: segment, ...more });

/**
 * The length trial's search, in prefix turns: the writer tries `min`, then each length `step`
 * on, up to `bound`, and keeps the first whose continuation produces every declared product.
 */
export const TRIAL = { min: 13, step: 1, bound: 80 };

/** close-merge's L3 product, by name: an entry whose trial missed only this one within the bound is checked for L2 merges only. */
export const L3_PRODUCT = 'an L3 merge request';

/**
 * The prefix of `turns` turns that builds a configuration's deep store, settled turn by
 * turn by the driver. Mostly chat of varied length, with a tool round, parallel calls, a
 * thinking-led call and a long message at fixed intervals, as residents' stores hold them.
 * The clock advances four virtual minutes before each turn, so a clock row lands every two
 * or three turns, as at a resident's pace.
 */
export function prefix(turns) {
  return [{ id: 'p.name', segment: 'prefix', kind: 'command', command: '/session rename fixture' }, ...extend(0, turns), checkpoint('p.end', 'prefix', { copyStore: true })];
}

/**
 * The prefix's steps for turns `from + 1` to `to`: what a store of `from` prefix turns
 * needs to become one of `to`, without the session's naming or the end checkpoint. Turn
 * `i` is the same in every call.
 */
export function extend(from, to) {
  const steps = [];
  for (let i = from + 1; i <= to; i++) {
    const id = `p.${i}`;
    const r = rng(id);
    steps.push(advance(`${id}.adv`, 'prefix', 4 * MINUTE));
    if (i === 1) steps.push(turn(id, 'prefix', { chars: 150, replyChars: 120 }));
    else if (i % 17 === 0) steps.push(turn(id, 'prefix', { chars: 6000 }));
    else if (i % 13 === 0) steps.push(turn(id, 'prefix', { chars: 300, calls: [{ kind: 'json', size: 600 }, { kind: 'prose', size: 900 }, { kind: 'code', size: 700 }] }));
    else if (i % 11 === 0) steps.push(turn(id, 'prefix', { chars: 300, thinking: 400, calls: [{ kind: 'prose', size: 800 }] }));
    else if (i % 7 === 0) steps.push(turn(id, 'prefix', { chars: 250, calls: [{ kind: 'prose', size: 1200 }] }));
    else steps.push(turn(id, 'prefix', { chars: 120 + Math.floor(r() * 900), replyChars: 80 + Math.floor(r() * 500) }));
  }
  return steps;
}

/**
 * The per-check continuation, about a dozen turns from a stored store. Each segment ends
 * at a checkpoint, and `products` says what each exists to produce (declaredProducts).
 */
export function continuation() {
  const steps = [{ id: 'c.name', segment: 'name', kind: 'command', command: '/session rename fixture' }];
  const seg = (name, list) => { steps.push(...list, checkpoint(`c.${name}.cp`, name)); };
  seg('close-merge', [
    advance('c.cm.1.adv', 'close-merge', 4 * MINUTE), turn('c.cm.1', 'close-merge', { chars: 700, replyChars: 400 }),
    advance('c.cm.2.adv', 'close-merge', 4 * MINUTE), turn('c.cm.2', 'close-merge', { chars: 6000, replyChars: 300 }),
    advance('c.cm.3.adv', 'close-merge', 4 * MINUTE), turn('c.cm.3', 'close-merge', { chars: 900, replyChars: 500 }),
    advance('c.cm.4.adv', 'close-merge', 4 * MINUTE), turn('c.cm.4', 'close-merge', { chars: 600, replyChars: 300 }),
  ]);
  seg('tool-round', [
    advance('c.tool.adv', 'tool-round', 4 * MINUTE),
    turn('c.tool', 'tool-round', { chars: 250, calls: [{ kind: 'prose', size: 1200 }, { kind: 'image', width: 400, height: 300 }] }),
  ]);
  seg('parallel', [
    advance('c.par.adv', 'parallel', 4 * MINUTE),
    turn('c.par', 'parallel', { chars: 250, calls: [{ kind: 'json', size: 500 }, { kind: 'prose', size: 700 }, { kind: 'code', size: 600 }] }),
  ]);
  seg('thinking-call', [
    advance('c.think.adv', 'thinking-call', 4 * MINUTE),
    turn('c.think', 'thinking-call', { chars: 300, thinking: 600, calls: [{ kind: 'prose', size: 800 }] }),
  ]);
  // A tool turn of several rounds, each result closing a chunk, so the compressions those
  // closes start park at agent-framework's provider gate until the turn ends, as residents'
  // do through a long turn, and the later rounds' compiles meet that debt. Its compressions
  // carry the three bad answers.
  seg('debt', [
    advance('c.debt.adv', 'debt', 4 * MINUTE),
    turn('c.debt', 'debt', {
      chars: 300,
      rounds: [[{ kind: 'prose', size: 1500 }], [{ kind: 'code', size: 1300 }], [{ kind: 'json', size: 1300 }], [{ kind: 'prose', size: 1500 }]],
      more: { badAnswers: ['thinking-only', 'empty', 'max-tokens'] },
    }),
  ]);
  steps.at(-1).copyStore = true;
  return steps;
}

/**
 * What each continuation segment exists to produce, per configuration. A product is checked
 * from the stand-in's records (check 2); a segment whose product is missing names it.
 */
export function products(configuration) {
  const summarises = configuration.summarises !== false;
  const steps = continuation();
  const long = canary(steps.filter((s) => s.segment === 'close-merge' && s.kind === 'channel').reduce((a, b) => (b.text.length > a.text.length ? b : a)).id, 'in');
  const imageCall = steps.find((s) => s.segment === 'tool-round' && s.kind === 'channel').replies.flatMap((r) => r.calls ?? []).find((c) => c.input.kind === 'image').input.canary;
  return {
    'close-merge': summarises
      ? [
        { name: 'an L1 compression request', test: (r) => r.kind === 'summariser' && r.level === 1 && r.answer?.shape === 'summary' },
        { name: 'a merge request', test: (r) => r.kind === 'summariser' && r.level >= 2 && r.answer?.shape === 'summary' },
        { name: L3_PRODUCT, test: (r) => r.kind === 'summariser' && r.level >= 3 && r.answer?.shape === 'summary' },
        { name: 'the long message stored in parts', fromStore: (store) => storedInParts(store, long) },
      ]
      : [],
    'tool-round': [
      { name: 'a request carrying both results, one an image', test: (r) => r.kind === 'agent' && resultsIn(r.messages.at(-1)) === 2 && r.messages.at(-1).blocks.some((b) => b.type === 'tool_result' && b.images > 0) },
    ],
    parallel: [
      { name: 'a request carrying the three results', test: (r) => r.kind === 'agent' && resultsIn(r.messages.at(-1)) === 3 },
      { name: 'the tool round\'s image as its placeholder', test: (r) => r.kind === 'agent' && r.messages.some((m) => m.blocks.some((b) => b.type === 'tool_result' && (b.canaries || []).includes(imageCall) && !b.images)) },
    ],
    'thinking-call': [
      { name: 'the call\'s request carrying the reply\'s thinking', test: (r) => r.kind === 'agent' && r.messages.some((m) => m.role === 'assistant' && m.blocks.some((b) => b.type === 'thinking' && typeof b.signature === 'string' && b.signature.startsWith('fx1.'))) },
    ],
    debt: summarises
      ? [
        { name: 'a compression after the turn, and none between its rounds', test: (r, mine) => r.kind === 'summariser' && parkedThrough(mine) && r.seq > Math.max(...mine.filter((x) => x.kind === 'agent').map((x) => x.seq)) },
        { name: 'a thinking-only answer', test: (r) => r.answer?.shape === 'thinking-only' },
        { name: 'an empty answer', test: (r) => r.answer?.shape === 'empty' },
        { name: 'an answer cut at max_tokens', test: (r) => r.answer?.shape === 'max-tokens' },
      ]
      : [],
  };
}

const resultsIn = (message) => (message?.blocks || []).filter((b) => b.type === 'tool_result').length;

/** The store holds the message carrying `input` as two or more messages of one body group. */
function storedInParts(store, input) {
  const first = store.messages.find((m) => m.canaries.includes(input));
  return Boolean(first?.bodyGroupId) && store.messages.filter((m) => m.bodyGroupId === first.bodyGroupId).length >= 2;
}

/** No summariser request came between a segment's first and last agent requests. */
function parkedThrough(records) {
  const agents = records.filter((x) => x.kind === 'agent').map((x) => x.seq);
  if (agents.length < 2) return false;
  const [first, last] = [Math.min(...agents), Math.max(...agents)];
  return !records.some((x) => x.kind === 'summariser' && x.seq > first && x.seq < last);
}
