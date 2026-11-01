import { FIXTURE_AGENT, assemblies, requestPairs, withJudged } from './checks.mjs';
import { png } from './png.mjs';
import { CHANNEL, READER, TOOL } from './script.mjs';

/**
 * The context-manager characterization fixture's nine workloads (connectome-smoke `lib/cm-fixture/workloads.mjs` at
 * 10cb728), as a host's residents meet them: every step a channel turn, a host command, the panel, the web UI, a
 * restart, the stand-in model's answers or a read the checks make (`reach-v2.md` §2, room-203 #315093 to #315561).
 * What only a direct call to context-manager made has left for its own suite.
 *
 * `steps(ctx)` is the run's script for the driver (driver.mjs, runScript), where `ctx` is `{ seed, configuration,
 * variant }`. `check(run, ctx)` reads the run's log entries and the stand-in's records, `{ log, records }`, and returns
 * the breaches of the one property the workload exists to check, `[{ step, message }]`. `from` says where a run
 * starts: null from an empty store, 'checkpoint' from its configuration's checkpoint (W2's end where the
 * configuration summarises, W1's where it doesn't). `standin` is what the run's stand-in starts with, and `recipe`
 * what the run's recipe adds to its configuration's.
 *
 * Every message a step writes carries a canary, `[[c:SEED.STEP.PART]]`: `in` the channel message, `rK` the agent's
 * k-th reply, `callK` the k-th call's result, `x` a marked message's poison, `arr` an arrival during a tool.
 */

/**
 * Characters per message: the fixture's sizes, which were at 1/15 of the host's, times 15. A pasted `document` is about
 * six of a house configuration's 10,000-token message cap, so it's stored in six shards or more.
 */
const SIZES = {
  user: [450, 1800],
  call: [1200, 4500],
  result: [3000, 13500],
  reading: [9000, 12000],
  reply: [900, 3600],
  large: [45000, 60000],
  document: [240000, 270000],
};

const PARTICIPANTS = ['Ash', 'Tavy', 'Wren'];
/**
 * A budget no store fits, asked so agent-framework's preflight names the lowest an operator can set (the driver's
 * `edge`); the panel takes none at or below the response reserve.
 */
const edge = (ctx) => ctx.reserve + 1000;
const WORDS = ('river stone lantern harbor quiet orchard ledger signal meadow copper window thread garden compass winter '
  + 'bridge morning letter answer kettle market island pencil shadow ribbon station velvet canyon basket').split(' ');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash32(s) {
  let x = 2166136261;
  for (const ch of s) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0;
  return x;
}

function prose(chars, seed) {
  const r = mulberry32(hash32(seed));
  let s = '';
  while (s.length < chars) {
    const n = 6 + Math.floor(r() * 12);
    const words = Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]);
    s += `${words[0][0].toUpperCase()}${words.join(' ').slice(1)}. `;
  }
  return s.slice(0, chars).trimEnd();
}

export const canary = (seed, step, part) => `[[c:${seed}.${step}.${part}]]`;

/** A 16×16 PNG whose tile colours follow from `seed`. */
function image(seed) {
  let k = seed >>> 0;
  return png(16, 16, (m) => { k = (Math.imul(k, 1103515245) + 12345) >>> 0; return (k >>> 16) % m; });
}

/**
 * A run's step writer: `turn(step, o)` is one channel turn as a host drives a resident's: the message arrives, the
 * agent calls the fixture server's tool in `rounds` rounds of `calls` calls each (none with `calls: 0`), each result
 * comes back, and the agent replies. `o`: `user` (its text instead of prose), `size` (the user text's range), `mark`
 * (a marker written after the canaries, with the poison canary `x`), `attach` (an image with the message), `result`
 * (the k-th call's tool input, given its canary), `callId` (the k-th call's own tool id), `thinking` (the first
 * round's thinking, in characters), `arrival` (`{ after: k }`: a message arrives while call k runs), `more` (any other
 * step fields).
 */
function writer(ctx, workload) {
  const r = mulberry32(hash32(`${ctx.seed}:${workload}`));
  const between = ([lo, hi]) => lo + Math.floor(r() * (hi - lo + 1));
  const c = (step, part) => canary(ctx.seed, step, part);
  const id = (step) => `${ctx.seed}.${step}`;
  const turn = (step, o = {}) => {
    const sid = id(step);
    const canaries = [c(step, 'in')];
    const poison = o.mark ? ` ${c(step, 'x')} ${o.mark}` : '';
    const text = `${c(step, 'in')}${poison} ${o.user ?? prose(between(o.size ?? SIZES.user), `${sid}:in`)}`;
    const calls = o.calls ?? 1;
    const rounds = calls === 0 ? 0 : (o.rounds ?? 1);
    const replies = [];
    let k = 0;
    for (let i = 0; i < rounds; i++) {
      const roundCalls = [];
      for (let j = 0; j < calls; j++) {
        k++;
        const callCanary = c(step, `call${k}`);
        canaries.push(callCanary);
        const input = o.result ? o.result(k, callCanary) : { kind: 'prose', size: between(SIZES.result), canary: callCanary };
        roundCalls.push({ name: TOOL, input: o.arrival?.after === k ? { ...input, hold: true } : input, ...(o.callId?.(k) ? { id: o.callId(k) } : {}) });
      }
      replies.push({
        text: `${c(step, `r${i + 1}`)} ${prose(between(SIZES.call), `${sid}:r${i + 1}`)}`,
        ...(o.thinking && i === 0 ? { thinking: prose(o.thinking, `${sid}:think`) } : {}),
        calls: roundCalls,
      });
    }
    replies.push({ text: `${c(step, `r${rounds + 1}`)} ${prose(between(SIZES.reply), `${sid}:r${rounds + 1}`)}` });
    const arrival = o.arrival ? { after: c(step, `call${o.arrival.after}`), participant: 'Tavy', text: `${c(step, 'arr')} ${prose(between(SIZES.user), `${sid}:arr`)}` } : null;
    if (arrival) canaries.push(c(step, 'arr'));
    return {
      id: sid, segment: workload, kind: 'channel', channel: CHANNEL, participant: PARTICIPANTS[Math.floor(r() * PARTICIPANTS.length)], topic: workload,
      text, canaries, replies,
      ...(o.attach ? { images: [{ data: image(hash32(sid)), mimeType: 'image/png' }] } : {}),
      ...(arrival ? { arrival } : {}),
      ...(o.more ?? {}),
    };
  };
  const other = (step, kind, fields) => ({ id: id(step), segment: workload, kind, ...fields });
  return { turn, other, c, id, between, size: between, SIZES };
}

/**
 * Knowledge sorts a message by its tools' names, which in a host are the fixture server's one tool, so the fixture's
 * phase plan comes down to how many calls a turn makes, in how many rounds.
 */
const PHASE_PLAN = [
  { calls: 1, rounds: 3 }, { calls: 1, rounds: 3 }, { calls: 1, rounds: 3 },
  { calls: 0 }, { calls: 0 }, { calls: 0 },
  { calls: 1, rounds: 3 }, { calls: 1, rounds: 3 },
  { calls: 1, rounds: 2 }, { calls: 1, rounds: 2 },
  { calls: 1, rounds: 3 }, { calls: 1, rounds: 3 },
  { calls: 2 },
  { calls: 1 },
  { calls: 0 },
  { calls: 1 }, { calls: 1 },
];
const phaseTurn = (n) => PHASE_PLAN[(n - 1) % PHASE_PLAN.length];

const READING_PLAN = [
  { calls: 1, rounds: 2 }, { calls: 1, rounds: 2 }, { calls: 1, rounds: 2 },
  { calls: 1 }, { calls: 1 }, { calls: 0 },
  { calls: 1, rounds: 2 }, { calls: 1 },
  { calls: 0, paste: true },
  { calls: 0 },
];
const readingTurn = (n) => READING_PLAN[(n - 1) % READING_PLAN.length];

/**
 * The turn that turns the tool-result guard on, as an agent does: `toolsets--open` on its settings, then
 * `agent_settings`. Neither result carries a canary, so the step names its requests by what they say instead.
 */
function guardTurn(w, step) {
  const t = w.turn(step, { calls: 0 });
  const said = (k) => `${w.c(step, `r${k}`)} ${prose(200, `${w.id(step)}:r${k}`)}`;
  return {
    ...t,
    replies: [
      { text: said(1), calls: [{ name: 'toolsets--open', input: { toolset: 'settings' } }] },
      { text: said(2), calls: [{ name: 'toolsets--act', input: { tool: 'agent_settings', args: { action: 'update', tool_result_guard: true } } }] },
      { text: said(3) },
    ],
    also: ['agent_settings', 'tool_result_guard'],
  };
}

/**
 * A knowledge subagent's run as one turn of the primary's (H2): the primary spawns it, synchronously, with a task; the
 * subagent works through `rounds`, each `{ calls }`, the tool inputs of one reply, and then reports; the primary
 * answers the report. The subagent's requests are told by the marker in the system prompt the spawn gives it. Its
 * whole run is one turn of the subagent, so only its first request compiles; the rest are continuation rounds. Each
 * of its replies waits until compression is idle, as the fixture settled between steps, so the background compression
 * its rounds start doesn't race them, and the run has one outcome (J60304: two in eight without).
 */
function subagentTurn(w, ctx, step, rounds) {
  const marker = `[[knowledge:${ctx.seed}]]`;
  const sid = w.id(step);
  const subCanaries = [w.c(step, 'task')];
  const subReplies = rounds.map((round, i) => {
    const calls = round.calls.map((input, j) => {
      const callCanary = w.c(step, `s${i + 1}call${j + 1}`);
      subCanaries.push(callCanary);
      return { name: TOOL, input: { ...input, canary: callCanary } };
    });
    return { text: `${w.c(step, `s${i + 1}`)} ${prose(w.between(SIZES.call), `${sid}:s${i + 1}`)}`, calls, settle: true };
  });
  const report = w.c(step, 'report');
  subReplies.push({ text: `${report} ${prose(w.between(SIZES.reply), `${sid}:report`)}`, settle: true });
  const t = w.turn(step, { calls: 0 });
  return {
    ...t,
    canaries: [...t.canaries, report],
    replies: [
      { text: `${w.c(step, 'r1')} ${prose(200, `${sid}:r1`)}`, calls: [{ name: 'subagent--spawn', input: { name: `knowledge-${ctx.seed}`, systemPrompt: `${marker} You are the fixture's knowledge subagent.`, task: `${w.c(step, 'task')} ${prose(w.between(SIZES.user), `${sid}:task`)}`, sync: true } }] },
      { text: `${w.c(step, 'r2')} ${prose(w.between(SIZES.reply), `${sid}:r2`)}` },
    ],
    sub: { marker, canaries: subCanaries, replies: subReplies },
  };
}

/**
 * Under H4: the resident tunes the channel out, as it would with `tune_out` (its cadence a day, so no timer reads for
 * it during a run, and its wake budget 64, past which the coordinator ends the tune-out); then each held message is
 * addressed to the resident, which wakes the subconscious reader, and the reader reports it with `deliver_summary` and
 * ends its turn with `skip_reply` (a reader's plain prose has no destination, and the host asks it again). A reader's
 * request is named by the held message's canary anywhere in it, or by its wake notice, all a window cut to the edge
 * holds. `before` (by held message, from 1) is steps the driver takes before that message's turn; with `mayFail`,
 * a reader's turn may end exhausted or aborted, logged as turn-failed, as W8's turns may at the edge.
 */
function tunedOut(w, steps, count, o = {}) {
  const t = w.turn('tune', { calls: 0 });
  steps.push({
    ...t,
    replies: [
      { text: `${w.c('tune', 'r1')} ${prose(200, `${w.id('tune')}:r1`)}`, calls: [{ name: 'tune_out', input: { channelId: CHANNEL, cadenceSeconds: 86400, maxWakes: 64 } }] },
      { text: `${w.c('tune', 'r2')} ${prose(200, `${w.id('tune')}:r2`)}` },
    ],
    namedAnywhere: true,
  });
  for (let k = 1; k <= count; k++) {
    for (const step of o.before?.[k] ?? []) steps.push(step);
    const held = w.turn(`h${k}`, { calls: 0 });
    steps.push({
      ...held,
      tags: ['chat:addressed'],
      reader: 'Subconscious',
      ...(o.mayFail ? { mayFail: true } : {}),
      replies: [],
      sub: {
        marker: READER,
        canaries: [w.c(`h${k}`, 'in')],
        namedAnywhere: true,
        also: ['addressed message'],
        replies: [
          { calls: [{ name: 'deliver_summary', input: { text: `${w.c(`h${k}`, 'read')} ${prose(w.between(SIZES.reply), `${w.id(`h${k}`)}:read`)}`, channelId: CHANNEL } }] },
          { calls: [{ name: 'skip_reply', input: {} }] },
        ],
      },
    });
  }
}

function markdownPaste(seed, step, target) {
  const window = target * 4;
  let s = `${canary(seed, step, 'in')} `;
  const fill = (to) => { if (s.length < to) s += prose(Math.round(to) - s.length, `${seed}.${step}:${s.length}`); };
  const kind = step.endsWith('h') ? 'headings' : step.endsWith('i') ? 'fence' : 'blank';
  if (kind === 'headings') { fill(0.4 * window); s += '\n## Notes\n'; fill(0.75 * window); s += '\n### Detail\n'; }
  else if (kind === 'fence') { fill(0.3 * window); s += '\n```\nconst x = 1;\n```\n'; fill(0.75 * window); s += '\n\n'; }
  else { fill(0.4 * window); s += '\n\n'; fill(0.75 * window); s += '\n'; }
  fill(2.5 * window);
  return s;
}

const entries = (run, kind) => run.log.filter((e) => e.kind === kind);
const readsOf = (run, op) => entries(run, 'read').filter((e) => e.op === op);
/** The test module's compile lines, each with the step whose settle or shutdown took it and the boot that made it. */
const compileLines = (run) => entries(run, 'compiles').flatMap((e) => e.lines.map((l) => ({ ...l, step: e.step, boot: e.boot })));
const canaryRe = (seed) => new RegExp(`^\\[\\[c:${seed}\\.([^.\\]]+)\\.([a-z0-9]+)\\]\\]$`);

/** Every block of an agent request's record, with its message's index and role. */
const blocksOf = (record) => (record.messages ?? []).flatMap((m, i) => m.blocks.map((b) => ({ i, role: m.role, b })));

/** A configuration that summarises: everything but a passthrough. */
const summarises = (configuration) => configuration.summarises !== false;

export const WORKLOADS = {
  /**
   * W1 builds a store from empty over 70 turns of the phase plan's tool rounds. Under H4 the resident then tunes the
   * channel out, and the reader reads six held messages, with an `/undo` before the fourth.
   */
  W1: {
    from: null,
    turns: 70,
    property: 'grows: L1, L2 and L3 summaries form as the store grows (configurations that summarise)',
    steps(ctx) {
      const w = writer(ctx, 'W1');
      const steps = [];
      for (let n = 1; n <= this.turns; n++) steps.push(w.turn(n, { ...phaseTurn(n), ...(n === this.turns ? { more: { reads: ['state'] } } : {}) }));
      if (ctx.configurationName === 'H4') tunedOut(w, steps, 6, { before: { 4: [w.other('undo', 'command', { command: '/undo' })] } });
      return steps;
    },
    check(run, ctx) {
      if (!summarises(ctx.configuration)) return [];
      const last = readsOf(run, 'state').at(-1);
      if (!last) return withJudged([{ step: null, message: 'couldn\'t judge: the run logged no state read' }], 0);
      const got = last.answer?.maxLevel;
      return withJudged(typeof got === 'number' && got >= 3 ? [] : [{ step: last.step ?? null, message: `the store reached L${got ?? '?'} in ${this.turns} turns, short of L3` }], 1);
    },
  },

  /** W2 builds a store from empty over 70 turns of reading-sized results, with a pasted document every tenth turn and an image every seventh. */
  W2: {
    from: null,
    turns: 70,
    property: 'reads: reading-sized tool results compress as they come; its end reaches L3 (the store is ready after each turn, which the driver\'s settle requires)',
    steps(ctx) {
      const w = writer(ctx, 'W2');
      const steps = [];
      for (let n = 1; n <= this.turns; n++) {
        const plan = readingTurn(n);
        steps.push(w.turn(n, {
          calls: plan.calls,
          rounds: plan.rounds,
          ...(plan.paste ? { size: SIZES.document } : {}),
          attach: n % 7 === 0,
          result: (k, canaryText) => ({ kind: 'prose', size: w.between(SIZES.reading), canary: canaryText }),
          ...(n === this.turns ? { more: { reads: ['state'] } } : {}),
        }));
      }
      return steps;
    },
    check(run, ctx) {
      return WORKLOADS.W1.check.call(this, run, ctx);
    },
  },

  /** W4: four turns whose first round's call is led by signed thinking, each answered in its turn. */
  W4: {
    from: 'checkpoint',
    turns: 4,
    property: 'thinking: no call this workload makes goes out parted from the thinking that led to it',
    steps(ctx) {
      const w = writer(ctx, 'W4');
      return Array.from({ length: this.turns }, (_, i) => w.turn(i + 1, { thinking: w.between(SIZES.call), callId: () => `t${ctx.seed}_${i + 1}` }));
    },
    check(run, ctx) {
      const own = new RegExp(`^t${ctx.seed}_\\d+$`);
      const out = [];
      let judged = 0;
      for (const r of run.records.filter((x) => x.kind === 'agent')) {
        for (const m of r.messages ?? []) {
          const calls = m.blocks.filter((b) => b.type === 'tool_use' && own.test(String(b.toolUseId))).map((b) => b.toolUseId);
          if (!calls.length) continue;
          judged++;
          if (!m.blocks.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking')) out.push({ step: r.step, message: `request ${r.id}: a call went out without its thinking (${calls.join(', ')})` });
        }
      }
      return withJudged(out, judged);
    },
  },

  /**
   * W5: the agent turns the tool-result guard on, so every later round's results are added held and settled by an
   * edit; then twelve turns, every fourth led by a large reply, every second answered by a large text, an image and
   * text in one result.
   */
  W5: {
    from: 'checkpoint',
    turns: 12,
    property: 'shards: a body larger than the message cap, stored in parts, never goes out with its tool blocks lost',
    steps(ctx) {
      const w = writer(ctx, 'W5');
      const steps = [guardTurn(w, 'g')];
      for (let n = 1; n <= this.turns; n++) {
        const big = n % 2 === 0;
        const t = w.turn(n, {
          callId: () => `t${ctx.seed}_${n}`,
          result: (k, canaryText) => (big
            ? { kind: 'mixed', size: w.between(SIZES.large), width: 64, height: 48, canary: canaryText }
            : { kind: 'prose', size: w.between(SIZES.result), canary: canaryText }),
          more: { reads: ['messages'] },
        });
        if (n % 4 === 1) t.replies[0].text = `${w.c(n, 'r1')} ${prose(w.between(SIZES.large), `${w.id(n)}:large`)}`;
        steps.push(t);
      }
      return steps;
    },
    check(run, ctx) {
      return toolBlocksLost(run, ctx);
    },
  },

  /**
   * W6, by turn modulo four: 0, two calls in one round; 1, one id called in two rounds; 2, at turn 2, a call the
   * fixture server never answers, which agent-framework answers with an error once the server's request timeout (the
   * recipe's `requestTimeoutMs`) passes, and a plain round otherwise; 3, a round whose call message an operator then
   * suppresses through the web UI, leaving its result stored.
   */
  W6: {
    from: 'checkpoint',
    turns: 12,
    property: 'tools: no request carries a tool result without its call before it, or a call without its result after it but in the last message',
    recipe: { fixtureServer: { requestTimeoutMs: 2000 } },
    needs: { webui: true },
    steps(ctx) {
      const w = writer(ctx, 'W6');
      const steps = [];
      for (let n = 1; n <= this.turns; n++) {
        switch (n % 4) {
          case 0:
            steps.push(w.turn(n, { calls: 2 }));
            break;
          case 1:
            steps.push(w.turn(n, { rounds: 2, callId: () => `t${ctx.seed}_reuse_${n}` }));
            break;
          case 2:
            steps.push(w.turn(n, n === 2 ? { result: (k, canaryText) => ({ kind: 'prose', size: 400, canary: canaryText, hold: true }), more: { also: ['server didn\'t answer within'] } } : {}));
            break;
          default:
            steps.push(w.turn(n));
            steps.push(w.other(`${n}.suppress`, 'suppress', { messages: [{ canary: w.c(n, 'r1') }] }));
        }
      }
      return steps;
    },
    /**
     * Judged by check 11's `shape` invariant on each compile. The requests the stand-in receives can't show a breach:
     * membrane repairs both shapes on the wire by design (`normalize-tool-pairs.ts`: a synthetic result for an
     * unanswered call, an orphan result turned into text).
     */
    check() {
      return [];
    },
  },

  /**
   * W7: modes marks seven turns with the stand-in's one-off and refusing failures; throws marks two provider errors;
   * merges-refused and merges-rejected set the stand-in to refuse or reject every merge; fable-no-tools and no-tools
   * run an agent permitted no tools from empty, whose 32 turns say more each, as its tool results would have.
   */
  W7: {
    from: 'checkpoint',
    turns: 21,
    property: 'failures: a refused chunk is quarantined alone, and no other chunk\'s compression request carries its text',
    variants: ['modes', 'merges-refused', 'merges-rejected', 'fable-no-tools', 'no-tools', 'throws'],
    owns: (variant) => (variant === 'merges-refused' ? [{ check: 1, what: 'refusal-offpath' }] : []),
    fromEmpty: (variant) => variant === 'fable-no-tools' || variant === 'no-tools',
    standin: (variant) => ({ refuseMerges: variant === 'merges-refused', rejectMerges: variant === 'merges-rejected' }),
    recipe: (variant) => ({
      ...(variant === 'fable-no-tools' || variant === 'no-tools' ? { agent: { allowedTools: [] } } : {}),
      ...(variant === 'fable-no-tools' ? { agent: { allowedTools: [], strategy: { compressionModel: 'claude-fable-5-1' } } } : {}),
    }),
    steps(ctx) {
      const w = writer(ctx, 'W7');
      const MARKS = { 3: 'fx:refuse', 6: 'fx:empty', 9: 'fx:thinking', 12: 'fx:max-tokens', 15: 'fx:overlong', 18: 'fx:throw', 21: 'fx:merge-refuse' };
      const noTools = ['fable-no-tools', 'no-tools'].includes(ctx.variant);
      const turns = noTools ? 32 : this.turns;
      if (ctx.configurationName === 'H2') {
        const rounds = [];
        for (let n = 1; n <= turns; n++) {
          const plan = phaseTurn(n);
          for (let k = 0; plan.calls && k < (plan.rounds ?? 1); k++) rounds.push({ calls: Array.from({ length: plan.calls }, () => ({ kind: 'prose', size: w.between(SIZES.result) })) });
        }
        return [subagentTurn(w, ctx, 1, rounds)];
      }
      const steps = [];
      for (let n = 1; n <= turns; n++) {
        const mark = ctx.variant === 'modes' ? MARKS[n] : ctx.variant === 'throws' ? { 3: 'fx:throw', 5: 'fx:fail' }[n] : null;
        if (mark) steps.push(w.turn(n, { mark, calls: 0 }));
        else if (noTools) steps.push(w.turn(n, { calls: 0, size: SIZES.reading }));
        else steps.push(w.turn(n, ctx.variant === 'merges-refused' ? phaseTurn(n) : {}));
      }
      return steps;
    },
    check(run, ctx) {
      const out = [];
      const re = canaryRe(ctx.seed);
      const turnsOf = (r) => (r.sent?.canaries ?? []).map((x) => re.exec(x)).filter(Boolean).map((m) => Number(m[1])).filter(Number.isFinite);
      const calls = run.records.filter((r) => r.kind === 'summariser');
      if (ctx.variant === 'modes') {
        const poison = canary(ctx.seed, 3, 'x');
        const carrying = calls.filter((r) => (r.sent?.canaries ?? []).includes(poison));
        if (!carrying.length) return withJudged([{ step: null, message: `couldn't judge: no summariser call carried the marked ${poison}` }], 0);
        const cascade = carrying.filter((r) => ['refusal', 'rejection'].includes(r.answer?.shape) && turnsOf(r).some((t) => t >= 5));
        if (cascade.length) out.push({ step: null, message: `${cascade.length} refused or rejected calls for other chunks carried the quarantined ${poison} (steps ${[...new Set(cascade.map((r) => r.step))].join(', ')})` });
        return withJudged(out, carrying.length);
      }
      if (ctx.variant === 'merges-refused') {
        const refused = calls.filter((r) => r.answer?.shape === 'refusal');
        const alerts = run.log.filter((e) => e.kind === 'ipc' && e.event?.type === 'ops:alert' && e.event.kind === 'refusal-offpath');
        if (!refused.length) return withJudged([{ step: null, message: 'couldn\'t judge: the stand-in refused no merge' }], 0);
        if (alerts.length !== refused.length) out.push({ step: null, message: `${refused.length} refused merge(s) raised ${alerts.length} off-path refusal alert(s), where each raises one` });
        return withJudged(out, refused.length);
      }
      if (ctx.variant === 'throws') {
        const newest = (r) => Math.max(-1, ...turnsOf(r));
        const stepTurn = (r) => Number(String(r.step ?? '').split('.')[1]);
        const l1 = calls.filter((r) => r.level === 1);
        const f = l1.findIndex((r) => r.answer?.shape === 'throw');
        const k = f === -1 ? -1 : l1.findIndex((r, i) => i > f && r.step !== l1[f].step);
        if (k !== -1 && newest(l1[k]) === newest(l1[f])) {
          const waited = l1.slice(k + 1).find((r) => r.step === l1[k].step && newest(r) > newest(l1[f]) && newest(r) < stepTurn(l1[k]));
          if (waited) out.push({ step: l1[k].step, message: `the chunk whose call failed at ${l1[f].step} went again before one whose messages had all arrived (newest at turn ${newest(waited)})` });
        }
        return withJudged(f === -1 || k === -1 ? [{ step: null, message: 'couldn\'t judge: no failed chunk call was followed by another chunk\'s' }] : out, f === -1 || k === -1 ? 0 : 1);
      }
      return out;
    },
  },

  /**
   * W8: the budget cut at once through the panel to 0.6 at turn 5, and to the edge at turn 9: the lowest
   * agent-framework's preflight allows, by asking for a budget no store fits (the driver's `edge`, which a cut to 0.6
   * below the folded floor meets too); restored at turn 13.
   * A turn may fail meanwhile. Under H4, the sixteen are held messages the reader reads, the cuts going to the reader.
   */
  W8: {
    from: 'checkpoint',
    turns: 16,
    property: 'tight: with the budget lowered to the edge and restored, a configuration that compiled every turn before the lowering does so again within two steps of the restore',
    variants: ['enforced', 'unenforced'],
    recipe: (variant) => ({ agent: { strategy: { enforceBudget: variant === 'enforced' } } }),
    steps(ctx) {
      const w = writer(ctx, 'W8');
      const budget = ctx.budget;
      const cut = (step, tokens) => w.other(`${step}.budget`, 'panel', { op: 'settings-update', params: { contextBudgetTokens: tokens, immediate: true }, edge: { reserve: ctx.reserve } });
      if (ctx.configurationName === 'H4') {
        const forReader = (step, tokens) => { const c = cut(step, tokens); return { ...c, params: { ...c.params, agent: 'Subconscious' } }; };
        const steps = [];
        tunedOut(w, steps, this.turns, { mayFail: true, before: { 5: [forReader('h5', Math.round(budget * 0.6))], 9: [forReader('h9', edge(ctx))], 13: [forReader('h13', budget)] } });
        return steps;
      }
      const steps = [];
      for (let n = 1; n <= this.turns; n++) {
        if (n === 5) steps.push(cut(n, Math.round(budget * 0.6)));
        if (n === 9) steps.push(cut(n, edge(ctx)));
        if (n === 13) steps.push(cut(n, budget));
        steps.push(w.turn(n, { more: { mayFail: true } }));
      }
      return steps;
    },
    check(run, ctx) {
      if (ctx.configurationName === 'H4') return restoredWithin(run, 'Subconscious', (k) => `${ctx.seed}.h${k}`, 'the reader\'s turn');
      return restoredWithin(run, FIXTURE_AGENT, (n) => `${ctx.seed}.${n}`, 'step');
    },
  },

  /**
   * W9: twenty turns, with after them: 2, three markdown pastes (adaptive configurations); 3, a restart with the
   * harness's reload check; 4, the panel's pins; 5, the tail and (kv-stable) a prepared window through the panel;
   * 6, a restart with the witnessed options; 7, a fork through the subagent tool; 8, a restart with a changed system
   * prompt; before 9, three exchanges with no tool; 10, a pin; 11, a level pin; 13, an undo and a redo, each with a
   * dry compile; 14, the unpin; 15, a head reset; before 16, the guard turned on, so 16's result is settled by an
   * edit; 17, 16's message suppressed; 18, a message arriving while its call runs (native formatter only); 19, a
   * restart with a larger head window.
   */
  W9: {
    from: 'checkpoint',
    turns: 20,
    property: 'lifecycle: a store closed and reopened sends the request it sent before',
    needs: { webui: true, subagents: true },
    steps(ctx) {
      const w = writer(ctx, 'W9');
      const { budget, adaptive, folding, native } = ctx;
      const dry = { op: 'dry-compile', budget: { maxTokens: budget, reserveForResponse: ctx.reserve } };
      const panel = (step, op, params) => w.other(step, 'panel', { op, params });
      const command = (step, text, more = {}) => w.other(step, 'command', { command: text, ...more });
      const steps = [];
      for (let n = 1; n <= this.turns; n++) {
        if (n === 9) for (const k of ['a', 'b', 'c']) steps.push(w.turn(`9${k}`, { calls: 0, size: SIZES.reading }));
        if (n === 16) steps.push({ ...guardTurn(w, '16g'), namedAnywhere: true });
        steps.push(w.turn(n, { ...(n === 18 && native ? { arrival: { after: 1 } } : {}), ...(n >= 16 ? { more: { namedAnywhere: true } } : {}) }));
        switch (n) {
          case 2:
            if (adaptive) for (const k of ['h', 'i', 'j']) steps.push({ ...w.turn(`2${k}`, { calls: 0 }), text: markdownPaste(ctx.seed, `2${k}`, 3000) });
            break;
          case 3:
            steps.push(w.other('3.reopen', 'restart', { reloadCheck: true }));
            break;
          case 4:
            steps.push(panel(`4.pins`, 'pins', {}));
            break;
          case 5:
            steps.push({ ...panel('5.tail', 'settings-update', { tailTokens: 15000 }), expect: summarises(ctx.configuration) ? 'ok' : 'refused' });
            if (folding === 'kv-stable') steps.push(panel('5.prepare', 'settings-update', { contextBudgetTokens: Math.round(budget * 0.6), transitionPaceTokens: 10000 }));
            break;
          case 6:
            steps.push(w.other('6.witnessed', 'restart', { agent: { strategy: { witnessedBeforeSequence: { sequenceOf: w.c(6, 'r2') }, witnessedIdentityReminder: 'This stretch is a record you inherited, not your own experience.' } } }));
            break;
          case 7: {
            const fork = w.turn('7f', { calls: 0 });
            const marker = `[[fork:${ctx.seed}]]`;
            steps.push({
              ...fork,
              canaries: [...fork.canaries, w.c('7f', 'task'), w.c('7f', 'f1')],
              replies: [
                { text: `${w.c('7f', 'r1')} forking`, calls: [{ name: 'subagent--fork', input: { name: `fork-${ctx.seed}`, task: `${w.c('7f', 'task')} ${prose(300, `${w.id('7f')}:task`)}`, systemPrompt: `${marker} You are the fork.`, sync: true } }] },
                { text: `${w.c('7f', 'r2')} ${prose(300, `${w.id('7f')}:r2`)}` },
              ],
              sub: { marker, canaries: [w.c('7f', 'task')], replies: [{ text: `${w.c('7f', 'f1')} ${prose(400, `${w.id('7f')}:f1`)}` }] },
            });
            break;
          }
          case 8:
            steps.push(w.other('8.prompt', 'restart', { agent: { systemPrompt: 'You are the strategy fixture\'s agent, with a prompt an operator changed.' } }));
            if (folding === 'kv-stable') steps.push(panel('8.prepare', 'settings-update', { contextBudgetTokens: Math.round(budget * 0.6), transitionPaceTokens: 50000 }));
            break;
          case 10:
            steps.push({ ...panel('10.pin', 'pin-add', { firstMessageId: { canary: w.c(1, 'in') }, lastMessageId: { canary: w.c(1, 'r2') }, name: `w9-${ctx.seed}` }), expect: summarises(ctx.configuration) ? 'ok' : 'refused' });
            break;
          case 11:
            steps.push({ ...panel('11.pin-level', 'pin-add', { firstMessageId: { canary: w.c(2, 'in') }, lastMessageId: { canary: w.c(2, 'r2') }, level: 1 }), expect: summarises(ctx.configuration) ? 'ok' : 'refused' });
            break;
          case 13:
            steps.push(command('13.undo', '/undo', { reads: [dry] }));
            steps.push(command('13.redo', '/redo', { reads: [dry] }));
            break;
          case 14:
            if (summarises(ctx.configuration)) steps.push(panel('14.unpin', 'pin-remove', { pinId: { pin: `w9-${ctx.seed}` } }));
            break;
          case 15:
            steps.push(command('15.newtopic', '/newtopic A new topic.', summarises(ctx.configuration) ? {} : { expect: 'failed' }));
            break;
          case 17:
            steps.push(w.other('17.suppress', 'suppress', { messages: [{ canary: w.c(16, 'in') }] }));
            break;
          case 19:
            steps.push(w.other('19.head', 'restart', { agent: { strategy: { headWindowTokens: 8000 } } }));
            break;
          default:
            break;
        }
      }
      return steps;
    },
    /** Judged by check 12, the reload check, on step 3's restart; the restarts at 6, 8 and 19 change options on purpose. */
    check() {
      return [];
    },
  },

  /**
   * W11: pins at level 0, at max level 0, on a tool result, at max level 2 and at level 1 on single plain messages of
   * the checkpoint's store, a document mark, and a level pin over turn 1, through a cut to 0.35 (or the lowest the
   * preflight allows) and a restore; a turn may fail at the edge. Under H1, step 2's first request meets a provider
   * error agent-framework retries.
   */
  W11: {
    from: 'checkpoint',
    turns: 14,
    property: 'protections: pins and document marks an operator puts on older messages hold through a budget cut and a restore (the pins invariant reads each compile)',
    steps(ctx) {
      const w = writer(ctx, 'W11');
      const budget = ctx.budget;
      const pin = (step, first, last, opts = {}) => w.other(step, 'panel', { op: 'pin-add', params: { firstMessageId: first, lastMessageId: last, ...opts } });
      const steps = [];
      for (let n = 1; n <= this.turns; n++) {
        if (n === 9) steps.push(w.other('9.budget', 'panel', { op: 'settings-update', params: { contextBudgetTokens: Math.round(budget * 0.35), immediate: true }, edge: { reserve: ctx.reserve } }));
        if (n === 13) steps.push(w.other('13.budget', 'panel', { op: 'settings-update', params: { contextBudgetTokens: budget, immediate: true } }));
        const failFirst = n === 2 && ctx.configurationName === 'H1';
        const t = w.turn(n, { more: { mayFail: true } });
        if (failFirst) t.replies = [{ error: { status: 529, type: 'overloaded_error', message: 'stand-in: overloaded, once' } }, ...t.replies];
        steps.push(t);
        switch (n) {
          case 2:
            steps.push(pin('2.level0', { storeAt: 0.10 }, { storeAt: 0.10 }, { level: 0 }));
            steps.push(pin('2.max0', { storeAt: 0.14 }, { storeAt: 0.14 }, { maxLevel: 0 }));
            break;
          case 3:
            steps.push(pin('3.result', { storeAt: 0.30, withBlock: 'tool_result' }, { storeAt: 0.30, withBlock: 'tool_result' }));
            break;
          case 4:
            steps.push(pin('4.max2', { storeAt: 0.45 }, { storeAt: 0.45 }, { maxLevel: 2 }));
            steps.push(pin('4.level1', { storeAt: 0.55 }, { storeAt: 0.55 }, { level: 1 }));
            break;
          case 8:
            steps.push(pin('8.document', { storeAt: 0.20 }, { storeAt: 0.20 }, { kind: 'document', maxLevel: 1 }));
            steps.push(pin('8.level1', { canary: w.c(1, 'in') }, { canary: w.c(1, 'r2') }, { level: 1 }));
            break;
          default:
            break;
        }
      }
      return steps;
    },
    check() {
      return [];
    },
  },
};

/**
 * W8's property for one agent's turns, numbered 1 to 16 with the restore before 13: each turn's outcome is its first
 * request assembly's (checks.mjs assemblies, so a refusal retried within the assembly reads as what it ended in). Turns
 * 1-4 must have compiled for the restore to be judged; where they didn't, the property can't be judged, and says so
 * rather than passing. Then turns 15 and 16 must compile.
 */
function restoredWithin(run, agent, stepOf, noun) {
  const firstByStep = new Map();
  for (const a of assemblies(run.log, agent)) if (!firstByStep.has(a.step)) firstByStep.set(a.step, a);
  const outcome = (n) => firstByStep.get(stepOf(n))?.outcome ?? 'no request';
  const before = [1, 2, 3, 4].filter((n) => outcome(n) !== 'compiled');
  if (before.length) return [{ step: stepOf(before[0]), message: `couldn't judge the restore: ${before.map((n) => `${noun} ${n} ${outcome(n)}`).join(', ')}, before the budget was lowered` }];
  return [15, 16].filter((n) => outcome(n) !== 'compiled').map((n) => ({ step: stepOf(n), message: `${noun} ${n}: ${outcome(n)} ${n - 13} turn(s) after the budget was restored` }));
}

/**
 * W5's property over a run: each stored message holding tool blocks that a request's compile sent whole (`r:ID`, a
 * complete raw body) went out with every one of those blocks. Each compile is paired with the request it was sent as
 * (checks.mjs requestPairs); a continuation round compiles nothing. Judged: each such body in each paired request.
 */
function toolBlocksLost(run) {
  const messages = readsOf(run, 'messages').at(-1)?.answer ?? [];
  const toolIds = new Map();
  for (const m of messages) {
    const ids = m.blocks.filter((b) => b.type === 'tool_use' || b.type === 'tool_result').map((b) => b.id ?? b.toolUseId);
    const key = m.bodyGroupId ?? m.id;
    if (ids.length) toolIds.set(key, [...(toolIds.get(key) ?? []), ...ids]);
  }
  const groupOf = new Map(messages.map((m) => [m.id, m.bodyGroupId ?? m.id]));
  const paired = requestPairs(run.records, run.log, FIXTURE_AGENT);
  if (!paired) return withJudged([{ step: null, message: 'couldn\'t judge: the log holds no request compile line to pair with the requests' }], 0);
  const out = [];
  let judged = 0;
  for (const { line, request } of paired.pairs) {
    const sent = new Set(blocksOf(request).filter((x) => x.b.type === 'tool_use' || x.b.type === 'tool_result').map((x) => x.b.toolUseId));
    const whole = new Set((line.messages ?? []).flatMap((m) => m.sources ?? []).filter((s) => /^r:[^!]+$/.test(s)).map((s) => groupOf.get(s.slice(2))).filter(Boolean));
    for (const key of whole) {
      if (!toolIds.has(key)) continue;
      judged++;
      const lost = toolIds.get(key).filter((id) => !sent.has(id));
      if (lost.length) out.push({ step: request.step, message: `request ${request.id}: ${key} went out whole but without its tool blocks ${[...new Set(lost)].join(', ')}` });
    }
  }
  return withJudged(out, judged);
}

/**
 * The runs a check makes, CONFIGURATION/WORKLOAD[/VARIANT], from the fixture's (room-203 #315555, #315561): C7 is H1 in
 * a host, and C4, C2, C9 and W11's store that refuses writes leave for context-manager's suite (reach-v2 §1).
 */
export const RUNS = [
  'H1/W1', 'H4/W1',
  'C3h/W2', 'H1/W2',
  'H3/W4',
  'C5h/W5',
  'C8h/W6',
  'C3h/W7/modes', 'C3h/W7/throws', 'C3h/W7/merges-refused', 'C3h/W7/fable-no-tools', 'C3h/W7/no-tools',
  'H1/W7/merges-refused', 'H1/W7/merges-rejected', 'H2/W7/merges-refused',
  'C3h/W8/unenforced', 'C6h/W8/enforced', 'H1/W8/enforced', 'H4/W8/unenforced',
  'H3/W9', 'C3h/W9', 'C6h/W9', 'H1/W9',
  'C6h/W11', 'H1/W11',
];

/** A run's seed: a number from its id, so its script is the same in every version and stable as the list grows. */
export function seedOf(id) {
  return 100 + (hash32(id) % 900000);
}

const merge = (a = {}, b = {}) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge(a[k], v) : v;
  return out;
};

/**
 * One run of the list, given the configurations (script.mjs) and the installed host's facts for its configuration
 * (driver.mjs, hostFacts): `{ id, workload, variant, seed, configuration, standin, from, steps, check, owns }`.
 * `from` is the checkpoint it continues, `CONFIGURATION/W2` (W1 for a configuration that doesn't summarise), or null
 * from empty; `configuration` is its configuration with the workload's recipe and what its steps need merged in;
 * `standin` is the stand-in's start; `steps()` its script; `check({ log, records })` its property's breaches, with
 * a non-enumerable `judged` count (checks.mjs withJudged) where the property judges a run itself; `owns` the harness
 * checks' flags, each `{ check, what }`, that the workload makes by design and its property judges.
 */
export function runOf(id, configurations, facts) {
  const [configName, workloadName, variant = null] = id.split('/');
  const base = configurations[configName];
  const workload = WORKLOADS[workloadName];
  if (!base || !workload || (variant !== null && !(workload.variants ?? []).includes(variant))) throw new Error(`no run ${id}: no such configuration, workload or variant`);
  const recipe = typeof workload.recipe === 'function' ? workload.recipe(variant) : workload.recipe ?? {};
  const modules = {
    ...(workload.needs?.webui ? { webui: { host: '127.0.0.1', port: 0 } } : {}),
    ...(workload.needs?.subagents ? { subagents: true } : {}),
  };
  const configuration = merge(merge(base, Object.keys(modules).length ? { modules } : {}), recipe);
  const strategy = configuration.agent?.strategy ?? {};
  const adaptive = strategy.type !== 'passthrough' && strategy.adaptiveResolution !== false;
  const seed = seedOf(id);
  const ctx = {
    seed,
    variant,
    configuration,
    configurationName: configName,
    budget: facts.budget,
    reserve: facts.maxTokens,
    adaptive,
    folding: adaptive ? strategy.foldingStrategy ?? 'kv-unified' : null,
    native: configuration.agent?.formatter !== 'anthropic-xml',
  };
  const fromEmpty = workload.from === null || workload.fromEmpty?.(variant) || configName === 'H2';
  return {
    id,
    workload: workloadName,
    variant,
    seed,
    configuration,
    standin: typeof workload.standin === 'function' ? workload.standin(variant) : {},
    from: fromEmpty ? null : `${configName}/${base.summarises === false ? 'W1' : 'W2'}`,
    steps: () => workload.steps(ctx),
    check: (run) => workload.check(run, ctx),
    owns: typeof workload.owns === 'function' ? workload.owns(variant) : workload.owns ?? [],
  };
}
