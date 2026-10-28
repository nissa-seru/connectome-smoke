import { createHash } from 'node:crypto';

/**
 * The strategy fixture's conversation: the configurations it runs, the deep store's prefix,
 * the per-check continuation, and what each segment exists to produce.
 *
 * Every step has an `id`, its `segment` and a `kind` the driver executes (lib/strategies/driver.mjs).
 * A step that makes the agent run (`text`) carries `replies`, one per agent request the turn
 * makes, in order, `speeches` (how many `inference:speech` events end it), and `canaries`, the
 * canaries whose appearance in a request's last message makes it this step's agent request.
 * Every message the script writes carries a canary naming its step: the input `[[c:ID.in]]`,
 * the k-th reply `[[c:ID.rK]]`, the k-th call's result `[[c:ID.callK]]`.
 */

/** Budgets are the host's defaults (connectome-host 0.15.0: a 300,000-token budget, a
 *  4,000-token head, context-manager's 3,000-token chunks, 2,000-token summaries, a
 *  10,000-token message cap) scaled by this, so a few hundred turns reach L2 and L3. */
export const SCALE = 1 / 15;
export const TOOL = 'mcpl--fixture--result';
const MINUTE = 60_000;

const scaled = (n) => Math.round(n * SCALE);

/**
 * The configurations, each with the recipe patch the driver applies to the lane's recipe
 * (`agent`), the stand-in's view of the model (`windowTokens`, `binds`), and which segments
 * it runs. `kvUnifiedScale` asks the lane to take the host's own `standardKvUnifiedConfig`
 * for the model and scale its token-sized fields (scaleKvUnified), so the fixture follows
 * the host under test rather than a copy of it.
 */
export function configurations({ model = 'claude-sonnet-4-5' } = {}) {
  const agent = {
    model,
    contextBudgetTokens: scaled(300_000),
    maxTokens: 2048,
    maintenanceIntervalMs: 0,
    cacheKeepalive: { enabled: false },
  };
  const strategy = {
    headWindowTokens: scaled(4000),
    targetChunkTokens: scaled(3000),
    summaryTargetTokens: scaled(2000),
    maxMessageTokens: scaled(10_000),
  };
  return {
    default: { name: 'default', agent: { ...agent, strategy }, kvUnifiedScale: SCALE, windowTokens: 200_000, binds: false, summarises: true },
    passthrough: { name: 'passthrough', agent: { ...agent, strategy: { type: 'passthrough' } }, windowTokens: 200_000, binds: false, summarises: false },
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

function turn(id, segment, { chars, replyChars = 160, calls = [], thinking = null, more = {} }) {
  const r = rng(`${id}:sizes`);
  const input = `${canary(id, 'in')} ${prose(chars, `${id}:in`)}`;
  const replies = [];
  const canaries = [canary(id, 'in')];
  if (calls.length || thinking) {
    const first = { text: `${canary(id, 'r1')} ${prose(80 + Math.floor(r() * 80), `${id}:r1`)}` };
    if (thinking) first.thinking = prose(thinking, `${id}:think`);
    first.calls = calls.map((c, k) => {
      const callCanary = canary(id, `call${k + 1}`);
      canaries.push(callCanary);
      return { name: TOOL, input: { ...c, canary: callCanary } };
    });
    replies.push(first);
    if (first.calls.length) replies.push({ text: `${canary(id, 'r2')} ${prose(replyChars, `${id}:r2`)}` });
  } else {
    replies.push({ text: `${canary(id, 'r1')} ${prose(replyChars, `${id}:r1`)}` });
  }
  return { id, segment, kind: 'text', text: input, canaries, replies, speeches: replies.length, ...more };
}

const advance = (id, segment, ms) => ({ id, segment, kind: 'advance', ms });
const checkpoint = (id, segment, more = {}) => ({ id, segment, kind: 'checkpoint', name: segment, ...more });

/**
 * The prefix of `turns` turns that builds a configuration's deep store, settled turn by
 * turn by the driver. Mostly chat of varied length, with a tool round, parallel calls, a
 * thinking-led call and a long message at fixed intervals, as residents' stores hold them.
 * The clock advances four virtual minutes before each turn, so a clock row lands every two
 * or three turns, as at a resident's pace.
 */
export function prefix(turns) {
  const steps = [{ id: 'p.name', segment: 'prefix', kind: 'command', command: '/session rename fixture' }];
  for (let i = 1; i <= turns; i++) {
    const id = `p.${i}`;
    const r = rng(id);
    steps.push(advance(`${id}.adv`, 'prefix', 4 * MINUTE));
    if (i % 17 === 0) steps.push(turn(id, 'prefix', { chars: 6000 }));
    else if (i % 13 === 0) steps.push(turn(id, 'prefix', { chars: 300, calls: [{ kind: 'json', size: 600 }, { kind: 'prose', size: 900 }, { kind: 'code', size: 700 }] }));
    else if (i % 11 === 0) steps.push(turn(id, 'prefix', { chars: 300, thinking: 400, calls: [{ kind: 'prose', size: 800 }] }));
    else if (i % 7 === 0) steps.push(turn(id, 'prefix', { chars: 250, calls: [{ kind: 'prose', size: 1200 }] }));
    else steps.push(turn(id, 'prefix', { chars: 120 + Math.floor(r() * 900), replyChars: 80 + Math.floor(r() * 500) }));
  }
  steps.push(checkpoint('p.end', 'prefix', { copyStore: true }));
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
  seg('held', [
    turn('c.held.1', 'held', { chars: 900, more: { summaries: 'hold' } }),
    turn('c.held.2', 'held', { chars: 900, more: { summaries: 'hold' } }),
    turn('c.held.3', 'held', { chars: 600, more: { summaries: 'release', badAnswers: ['thinking-only', 'empty', 'max-tokens'] } }),
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
  return {
    'close-merge': summarises
      ? [
        { name: 'an L1 compression request', test: (r) => r.kind === 'summariser' && r.level === 1 && r.answer?.shape === 'summary' },
        { name: 'a merge request', test: (r) => r.kind === 'summariser' && r.level >= 2 && r.answer?.shape === 'summary' },
      ]
      : [],
    'tool-round': [
      { name: 'a request carrying both results, one an image', test: (r) => r.kind === 'agent' && resultsIn(r.messages.at(-1)) === 2 && r.messages.at(-1).blocks.some((b) => b.type === 'tool_result' && b.images > 0) },
    ],
    parallel: [
      { name: 'a request carrying the three results', test: (r) => r.kind === 'agent' && resultsIn(r.messages.at(-1)) === 3 },
    ],
    'thinking-call': [
      { name: 'the call\'s request carrying the reply\'s thinking', test: (r) => r.kind === 'agent' && r.messages.some((m) => m.role === 'assistant' && m.blocks.some((b) => b.type === 'thinking' && typeof b.signature === 'string' && b.signature.startsWith('fx1.'))) },
    ],
    held: summarises
      ? [
        { name: 'an agent request while a summary is held', test: (r) => r.kind === 'agent' && r.heldAtArrival > 0 },
        { name: 'a thinking-only answer', test: (r) => r.answer?.shape === 'thinking-only' },
        { name: 'an empty answer', test: (r) => r.answer?.shape === 'empty' },
        { name: 'an answer cut at max_tokens', test: (r) => r.answer?.shape === 'max-tokens' },
      ]
      : [],
  };
}

const resultsIn = (message) => (message?.blocks || []).filter((b) => b.type === 'tool_result').length;
