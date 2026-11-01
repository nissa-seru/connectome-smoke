import { createHash } from 'node:crypto';

/**
 * The configurations the runs use, the continuation (workloads.mjs, `continuation`), and what
 * each of its segments exists to produce.
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

export const TOOL = 'mcpl--fixture--result';
export const CHANNEL = 'chat';
/** The marker in the H4 subconscious reader's system prompt. */
export const READER = '[[reader]]';
const PARTICIPANTS = ['Ash', 'Tavy', 'Wren'];
const MINUTE = 60_000;

/**
 * The configurations, each with the recipe patch the driver applies to the lane's recipe
 * (`agent`), the stand-in's view of the model (`binds`), and which segments it runs. They
 * run at residents' sizes: the budget, the reply's max tokens, the stream bound and every
 * strategy size are left to the host, which resolves them for the model as it does for a
 * recipe that leaves them out (`recipe-fit.ts`, `framework-agent-config.ts`). The stand-in's
 * window is the host's own for the model (`model-limits.ts`), which the lane reads through
 * hostFacts. The model is the host's own default (connectome-host `src/recipe.ts`,
 * `claude-opus-4-6`), which most shipped recipes run.
 * `maintenanceIntervalMs` goes at the recipe's top level only for a host that takes the key
 * (the driver asks the installed host's `unknownRecipeKeys`): connectome-host 0.15.0 refuses a
 * recipe with a key it doesn't know, and passing it through is the host change still to come.
 */
export function configurations({ model = 'claude-opus-4-6' } = {}) {
  const agent = { model, cacheKeepalive: { enabled: false } };
  const run = (name, more, summarises = true) => ({ name, agent: { ...agent, ...more.agent }, ...(more.modules ? { modules: more.modules } : {}), ...(more.subconscious ? { subconscious: more.subconscious } : {}), ...(more.judges ? { judges: more.judges } : {}), maintenanceIntervalMs: 0, binds: false, summarises });
  return {
    ...configurationsAsResidentsRun(run),
  };
}

/**
 * The workloads' configurations (workloads.mjs), as a host's recipe makes each:
 * - H1: the strategy left to the host, which makes it autobiographical, adaptive and kv-unified with its standard block
 *   (`framework-strategy.ts:162-187`): the fixture's H1 for this model, and its C7 too;
 * - H2: H1 with the subagent module on, whose knowledge subagent the workloads run inside a spawn, so the judge
 *   judges that subagent (judge.mjs judgedAgent);
 * - H3: a passthrough;
 * - H4: H1 with a persistent subconscious reader, agent-framework's WindowedPassthrough strategy, which reads what
 *   the resident's tune-out holds (`READER` in its system prompt tells its requests apart);
 * - C3h, C5h, C6h, C8h: the fixture's C3, C5, C6 and C8 at the host's defaults: classic autobiographical
 *   (`adaptiveResolution: false`), then adaptive with flat-profile, kv-stable and oldest-first folding.
 */
function configurationsAsResidentsRun(run) {
  return {
    H1: run('H1', {}),
    H2: run('H2', { modules: { subagents: true }, judges: 'subagent' }),
    H3: run('H3', { agent: { strategy: { type: 'passthrough' } } }, false),
    H4: run('H4', { subconscious: { enabled: true, systemPrompt: `${READER} You read what the resident has tuned out, and tell them what matters.` } }),
    C3h: run('C3h', { agent: { strategy: { adaptiveResolution: false } } }),
    C5h: run('C5h', { agent: { strategy: { foldingStrategy: 'flat-profile' } } }),
    C6h: run('C6h', { agent: { strategy: { foldingStrategy: 'kv-stable' } } }),
    C8h: run('C8h', { agent: { strategy: { foldingStrategy: 'oldest-first' } } }),
  };
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

function turn(id, segment, { chars, replyChars = 2400, calls = [], rounds = null, thinking = null, more = {} }) {
  const r = rng(`${id}:sizes`);
  const input = `${canary(id, 'in')} ${prose(chars, `${id}:in`)}`;
  const replies = [];
  const canaries = [canary(id, 'in')];
  const allRounds = rounds ?? (calls.length ? [calls] : []);
  if (allRounds.length || thinking) {
    let k = 0;
    allRounds.forEach((roundCalls, i) => {
      const reply = { text: `${canary(id, `r${i + 1}`)} ${prose(1200 + 15 * Math.floor(r() * 80), `${id}:r${i + 1}`)}` };
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

/** close-merge's L3 product, by name. */
export const L3_PRODUCT = 'an L3 merge request';

/**
 * The continuation, about a dozen turns from a stored store. Each segment ends
 * at a checkpoint, and `products` says what each exists to produce (declaredProducts).
 */
export function continuation() {
  const steps = [{ id: 'c.name', segment: 'name', kind: 'command', command: '/session rename fixture' }];
  const seg = (name, list) => { steps.push(...list, checkpoint(`c.${name}.cp`, name)); };
  seg('close-merge', [
    advance('c.cm.1.adv', 'close-merge', 4 * MINUTE), turn('c.cm.1', 'close-merge', { chars: 10_500, replyChars: 6000 }),
    advance('c.cm.2.adv', 'close-merge', 4 * MINUTE), turn('c.cm.2', 'close-merge', { chars: 90_000, replyChars: 4500 }),
    advance('c.cm.3.adv', 'close-merge', 4 * MINUTE), turn('c.cm.3', 'close-merge', { chars: 13_500, replyChars: 7500 }),
    advance('c.cm.4.adv', 'close-merge', 4 * MINUTE), turn('c.cm.4', 'close-merge', { chars: 9000, replyChars: 4500 }),
  ]);
  seg('tool-round', [
    advance('c.tool.adv', 'tool-round', 4 * MINUTE),
    turn('c.tool', 'tool-round', { chars: 3750, calls: [{ kind: 'prose', size: 18_000 }, { kind: 'image', width: 400, height: 300 }] }),
  ]);
  seg('parallel', [
    advance('c.par.adv', 'parallel', 4 * MINUTE),
    turn('c.par', 'parallel', { chars: 3750, calls: [{ kind: 'json', size: 7500 }, { kind: 'prose', size: 10_500 }, { kind: 'code', size: 9000 }] }),
  ]);
  seg('thinking-call', [
    advance('c.think.adv', 'thinking-call', 4 * MINUTE),
    turn('c.think', 'thinking-call', { chars: 4500, thinking: 9000, calls: [{ kind: 'prose', size: 12_000 }] }),
  ]);
  // A tool turn of several rounds, each result closing a chunk, so the compressions those
  // closes start park at agent-framework's provider gate until the turn ends, as residents'
  // do through a long turn, and the later rounds' compiles meet that debt. Its compressions
  // carry the three bad answers.
  seg('debt', [
    advance('c.debt.adv', 'debt', 4 * MINUTE),
    turn('c.debt', 'debt', {
      chars: 4500,
      rounds: [[{ kind: 'prose', size: 22_500 }], [{ kind: 'code', size: 19_500 }], [{ kind: 'json', size: 19_500 }], [{ kind: 'prose', size: 22_500 }]],
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
