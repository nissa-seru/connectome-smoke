// The workloads of the context-management characterization fixture (merged design §5), and the matrix of runs a
// check makes. Each workload drives a Run (driver.mjs) through context-manager's public API only, so the same script
// runs against any version.
//
// W1 and W2 build a store from empty. Every other workload continues a copy of a checkpoint store: W2's end for the
// configurations that compress, W1's for the ones that don't, written by a released context-manager and kept with
// the records, so a continuation's record moves only when its own behaviour does.
//
// Messages carry a canary first, c<seed>.<turn>.<role> (u: the user's turn, a: the agent's call, r: the tool's
// result, b: the agent's reply, plus x for a workload's extra messages), so a reader of any request can see which raw
// messages it carries.
//
// Each workload states the one property it exists to check, as `property` in its definition, and checks it as it
// goes, reporting a breach through w.violation('workload', ...). The property is hand-written and no regeneration of
// the records touches it. A known defect's breach is named in fixtures/cm-fixture/expected-failures.json.

import { deflateSync } from 'node:zlib';
import { allConfigs, SCALE } from './configs.mjs';

export const AGENT = 'Junga';

/** Characters per message at the fixture's scale (the host's sizes over SCALE, about 3.5 characters a token). */
const SIZES = {
  user: [30, 120],
  call: [80, 300],
  result: [200, 900],
  reading: [600, 800],
  reply: [60, 240],
  large: [3000, 4000],
  // A pasted document: about six of a house configuration's message cap (667 tokens at this scale), so it's stored in
  // six shards or more, and a chunk of two of them is at most a third of the body, past the library's reading-mode
  // threshold of a half (detectDocContext) wherever the chunker's boundaries fall.
  document: [16000, 18000],
};

/** A size from its range, at the run's scale: the ranges are for SCALE, so a run at the host's sizes writes 15 times more. */
function between(w, [lo, hi]) {
  const k = SCALE / w.scale;
  return Math.round(k * (lo + Math.floor(w.rng() * (hi - lo + 1))));
}

const text = (t) => ({ type: 'text', text: t });
const toolCall = (id, name, path) => ({ type: 'tool_use', id, name, input: { path } });
const call = (id, path) => toolCall(id, 'read_file', path);
const result = (id, content, toolName = 'read_file') => ({ type: 'tool_result', toolUseId: id, toolName, content });

/**
 * One turn as a host drives a resident: the user's message arrives and the host compiles at once for the agent's
 * request; the agent calls a tool, and while the tool runs the host's event loop is free; the result is stored and
 * the host compiles at once for the agent's next request; the agent replies, and the agent idles until the next
 * message. A configuration that compresses eagerly gets its drain where a host would give it one: while the tool
 * runs, and while the agent idles (w.yieldToDrain, w.settle). Returns the turn's first compile.
 * @param {object} [o] { reading: tool results of reading size; user, call, result, reply: text to use instead }
 */
export async function turn(w, n, o = {}) {
  w.step(n);
  const user = [text(`${w.c(n, 'u')} ${o.user ?? w.prose(between(w, o.paste ? SIZES.document : SIZES.user))}`)];
  if (o.attach) user.push(image(w.seed * 1000 + n));
  w.add('User', user);
  const compiled = await w.compile();
  if (o.again && compiled) {
    // The same inputs compiled again at once. What a caller can see of a second solve (KS-23, KS-6): the request's
    // messages are the first's, but for where the cache markers sit (the measured slot follows the previous compile,
    // so the second request's prefix is the whole request), and the second solve queues no compression work the first
    // didn't, since the queue takes a requested chunk only once. (A drain may take work from the queue meanwhile, so
    // only a rise counts.) The compression requests that work brings are in the record.
    const queued = () => {
      const p = w.manager.getStrategy().getProgressSnapshot?.();
      return p ? [p.l1QueueLength + p.l1WaitingOnTools, p.mergeQueueLength + p.mergesWaitingOnTools] : [0, 0];
    };
    const unmarked = (c) => JSON.stringify((c?.messages ?? []).map((m) => { const { cacheBreakpoint, ...r } = m; return r; }));
    const before = queued();
    const second = await w.compile();
    if (second && unmarked(second) !== unmarked(compiled)) {
      w.violation('workload', `step ${n}: the same inputs, compiled twice in a row, sent two different requests`);
    }
    const after = queued();
    if (after[0] > before[0] || after[1] > before[1]) {
      w.violation('workload', `step ${n}: the same inputs, compiled twice in a row, queued more work the second time: ${before.join('/')} L1/merges, then ${after.join('/')}`);
    }
  }
  const tools = o.tools ?? ['read_file'];
  // A tool loop: each round, the agent calls the turn's tools in one message, their results come back in one
  // message, and the host compiles for the agent's next request.
  for (let round = 0; tools.length > 0 && round < (o.rounds ?? 1); round++) {
    const ids = tools.map((_, k) => `t${w.seed}_${n}${round ? `r${round}` : ''}${k ? `_${k}` : ''}`);
    const said = round === 0 ? `${w.c(n, 'a')} ${o.call ?? w.prose(between(w, SIZES.call))}` : w.prose(between(w, SIZES.call));
    w.add(AGENT, [text(said), ...tools.map((name, k) => toolCall(ids[k], name, `notes/${n}-${round}.md`))]);
    await w.yieldToDrain();
    const size = o.large ? SIZES.large : o.reading ? SIZES.reading : SIZES.result;
    w.add('User', ids.map((id, k) => result(id, `${k || round ? '' : `${w.c(n, 'r')} `}${o.result ?? w.prose(between(w, size))}`, tools[k])));
    await w.compile();
  }
  w.add(AGENT, [text(`${w.c(n, 'b')} ${o.reply ?? w.prose(between(w, SIZES.reply))}`)]);
  await w.settle();
  await w.endStep();
  return compiled;
}

/**
 * The tools a turn calls, by a phase plan: Knowledge sorts a message by its tools' names (lesson, then subagent, then
 * research; synthesis for no tool or any other name, and a result takes its call's phase), so the plan gives it runs
 * of each phase, each long enough to pass its phase's chunk size, and the edges between them. Other strategies don't
 * read tool names; for them the plan only varies which turns call a tool.
 */
const PHASE_PLAN = [
  // research by the default prefix, three rounds a turn, so a run of it passes research's chunk size
  { tools: ['mcpl:read'], rounds: 3 }, { tools: ['mcpl:search'], rounds: 3 }, { tools: ['mcpl:read'], rounds: 3 },
  { tools: [] }, { tools: [] }, { tools: [] },                                 // synthesis: dialogue with no tool
  { tools: ['subagent:spawn'], rounds: 3 }, { tools: ['subagent:status'], rounds: 3 },   // subagent
  { tools: ['lessons:create'], rounds: 2 }, { tools: ['lessons:update'], rounds: 2 },    // lessons, by exact name
  { tools: ['zulip:search'], rounds: 3 }, { tools: ['zulip:read'], rounds: 3 },          // the other research prefix
  { tools: ['subagent:spawn', 'mcpl:read'] },                                  // both kinds in one message: subagent
  { tools: ['lessons:create-draft'] },                                         // a lesson name's prefix only: synthesis
  { tools: [] },                                                               // one synthesis turn between tool phases
  { tools: ['read_file'] }, { tools: ['read_file'] },                          // a tool no prefix names: synthesis
];
export const PHASE_TOOLS = [...new Set(PHASE_PLAN.flatMap((p) => p.tools))];
const phaseTurn = (n) => PHASE_PLAN[(n - 1) % PHASE_PLAN.length];

/**
 * W2's plan: reading, mostly research in two-round loops, broken by dialogue and a subagent now and then, and a
 * document the user pastes, larger than the house configurations' message cap, which they store in parts (a strategy
 * compresses a chunk of a much larger body in reading mode).
 */
const READING_PLAN = [
  { tools: ['mcpl:read'], rounds: 2 }, { tools: ['mcpl:read'], rounds: 2 }, { tools: ['zulip:read'], rounds: 2 },
  { tools: ['mcpl:read'] }, { tools: ['zulip:read'] }, { tools: [] },
  { tools: ['subagent:spawn'], rounds: 2 }, { tools: ['subagent:status'] },
  { tools: [], paste: true },                                             // the user pastes a document: sharded
  { tools: [] },
];
const readingTurn = (n) => READING_PLAN[(n - 1) % READING_PLAN.length];

/** The depth a from-empty run must reach: L3 where the strategy merges, L1 where it doesn't (hierarchical: false). */
async function reachesDepth(w) {
  if (!w.compresses) return;
  // What ran: the strategy's resolved config, so a library whose default turned merges off asks for L1 alone.
  const want = w.strategy.config?.hierarchical === false ? 1 : 3;
  let got;
  try { got = w.manager.getMaxSummaryLevel(); } catch { got = null; }
  if (got === null || got < want) w.violation('workload', `the store reached L${got ?? '?'} in ${w.job.turns} turns, short of L${want}`);
}

// ---------------------------------------------------------------------------------------------------------------
// What a compiled request carries, for the workloads' own properties.

/** Every block of a compiled request in order, with its message's index and role, tool results' content opened. */
function blocks(compiled) {
  const out = [];
  (compiled?.messages ?? []).forEach((m, i) => {
    for (const b of Array.isArray(m.content) ? m.content : []) {
      out.push({ i, participant: m.participant, b });
      if (b.type === 'tool_result' && Array.isArray(b.content)) for (const inner of b.content) out.push({ i, participant: m.participant, b: inner, inResult: true });
    }
  });
  return out;
}
const toolUseId = (b) => b.id;
const toolResultId = (b) => b.toolUseId ?? b.tool_use_id;

/** Tool results with no call before them, and calls with no result after them (the last message's calls aside). */
function unpairedTools(compiled) {
  const all = blocks(compiled).filter((x) => !x.inResult);
  const called = new Set();
  const lastIndex = (compiled?.messages?.length ?? 0) - 1;
  const orphans = [];
  for (const { b } of all) {
    if (b.type === 'tool_use') called.add(toolUseId(b));
    if (b.type === 'tool_result' && !called.has(toolResultId(b))) orphans.push(toolResultId(b));
  }
  const answered = new Set(all.filter((x) => x.b.type === 'tool_result').map((x) => toolResultId(x.b)));
  const unanswered = all.filter((x) => x.b.type === 'tool_use' && !answered.has(toolUseId(x.b)) && x.i !== lastIndex).map((x) => toolUseId(x.b));
  return { orphans, unanswered };
}

// ---------------------------------------------------------------------------------------------------------------
// Deterministic PNG images for W3: a small solid-colour image per seed, as a host stores a screenshot.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A size×size RGB PNG of one colour, from `seed`, as base64. */
export function png(seed, size = 16) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) { row[1 + x * 3] = (seed * 37) & 255; row[2 + x * 3] = (seed * 91) & 255; row[3 + x * 3] = (seed * 53 + x) & 255; }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const image = (seed) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(seed) } });

/** Library defaults the workloads lean on (context-manager 0.24.2's DEFAULT_AUTOBIOGRAPHICAL_CONFIG.maxLiveImages). */
const MAX_LIVE_IMAGES = 6;

// ---------------------------------------------------------------------------------------------------------------
// The workloads. `turns` is the default length; sensitivity sizing sets each to the fewest turns at which its
// readiness mutant still flags.

export const WORKLOADS = {
  W1: {
    from: null,
    // The fewest turns, with margin, at which every configuration that merges reaches L3: the latest first L3 by run
    // was H1's, at turn 57 at the fixture's scale and 69 at the host's (J56952, J56920).
    turns: 70,
    realTurns: 80,
    property: 'grows: L1, L2 and L3 summaries form as the store grows (compressing configurations; L1 alone where merges are off)',
    async run(w) {
      for (let n = 1; n <= w.job.turns; n++) await turn(w, n, phaseTurn(n));
      await reachesDepth(w);
    },
  },

  W2: {
    from: null,
    // Its end is the checkpoint continuations start from, so it reaches the same depth as W1 (H1's first L3 at 54 and
    // 55 by run).
    turns: 70,
    realTurns: 80,
    property: 'reads: reading-sized tool results compress as they come, and the store is ready after each turn; its end reaches L3',
    async run(w) {
      for (let n = 1; n <= w.job.turns; n++) {
        await turn(w, n, { reading: true, ...readingTurn(n), attach: n % 7 === 0 });
        if (w.compresses && !w.manager.isReady()) w.violation('workload', `step ${n}: not ready after the turn's compression settled`);
      }
      await reachesDepth(w);
    },
  },

  W3: {
    from: 'checkpoint',
    nonCompressing: true,
    turns: 24,
    property: `images: no request carries more than ${MAX_LIVE_IMAGES} live images, an image in a tool result included, under a strategy that limits them (passthrough sends every image, PT-12)`,
    async run(w) {
      const limits = w.built.cls !== 'PassthroughStrategy';
      for (let n = 1; n <= w.job.turns; n++) {
        w.step(n);
        const content = [text(`${w.c(n, 'u')} ${w.prose(between(w, SIZES.user))}`)];
        if (n % 3 === 0) content.push(image(w.seed * 1000 + n));
        w.add('User', content);
        const compiled = await w.compile();
        if (compiled) {
          const live = blocks(compiled).filter((x) => x.b.type === 'image').length;
          if (limits && live > MAX_LIVE_IMAGES) w.violation('workload', `step ${n}: the request carries ${live} live images, over ${MAX_LIVE_IMAGES}`);
        }
        const id = `t${w.seed}_${n}`;
        w.add(AGENT, [text(`${w.c(n, 'a')} ${w.prose(between(w, SIZES.call))}`), call(id, `shots/${n}.png`)]);
        const res = n % 2 === 0
          ? [text(`${w.c(n, 'r')} ${w.prose(80)}`), image(w.seed * 1000 + 500 + n)]
          : `${w.c(n, 'r')} ${w.prose(between(w, SIZES.result))}`;
        w.add('User', [result(id, res)]);
        w.add(AGENT, [text(`${w.c(n, 'b')} ${w.prose(between(w, SIZES.reply))}`)]);
        await w.settle();
        await w.endStep();
      }
    },
  },

  W4: {
    from: 'checkpoint',
    nonCompressing: true,
    turns: 24,
    property: 'thinking: no call this workload makes goes out parted from the thinking that led to it, a call whose result lands a turn later included',
    async run(w) {
      let late = null;
      // The calls W4 itself makes carry thinking; the checkpoint's history never had any, so only W4's are checked.
      const own = new RegExp(`^t${w.seed}_\\d+$`);
      for (let n = 1; n <= w.job.turns; n++) {
        w.step(n);
        if (late) {
          w.add('User', [result(late.id, `${w.c(late.n, 'r')} ${w.prose(between(w, SIZES.result))}`)]);
          late = null;
        }
        w.add('User', [text(`${w.c(n, 'u')} ${w.prose(between(w, SIZES.user))}`)]);
        const compiled = await w.compile();
        if (compiled) {
          for (const m of compiled.messages) {
            const content = Array.isArray(m.content) ? m.content : [];
            const calls = content.filter((b) => b.type === 'tool_use').map(toolUseId).filter((id) => own.test(String(id)));
            if (calls.length && !content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking')) {
              w.violation('workload', `step ${n}: a call went out without its thinking (${calls.join(', ')})`);
            }
          }
        }
        const id = `t${w.seed}_${n}`;
        w.add(AGENT, [
          { type: 'thinking', thinking: `${w.c(n, 'k')} ${w.prose(between(w, SIZES.call))}`, signature: `sig-${w.seed}-${n}` },
          text(`${w.c(n, 'a')} ${w.prose(60)}`),
          call(id, `notes/${n}.md`),
        ]);
        if (n % 2 === 0) late = { id, n };
        else w.add('User', [result(id, `${w.c(n, 'r')} ${w.prose(between(w, SIZES.result))}`)]);
        if (!late) w.add(AGENT, [text(`${w.c(n, 'b')} ${w.prose(between(w, SIZES.reply))}`)]);
        await w.settle();
        await w.endStep();
      }
    },
  },

  W5: {
    from: 'checkpoint',
    nonCompressing: true,
    turns: 20,
    property: 'shards: a body larger than the message cap, stored in parts, never goes out with its tool blocks lost',
    async run(w) {
      const toolIds = new Map(); // add's store id -> the tool ids its body holds
      for (let n = 1; n <= w.job.turns; n++) {
        w.step(n);
        w.add('User', [text(`${w.c(n, 'u')} ${w.prose(between(w, SIZES.user))}`)]);
        const compiled = await w.compile();
        if (compiled) {
          const sent = new Set(blocks(compiled).filter((x) => x.b.type === 'tool_use' || x.b.type === 'tool_result').map((x) => toolUseId(x.b) ?? toolResultId(x.b)));
          const raw = new Set((compiled.provenance?.messages ?? []).flatMap((p) => (p.kind === 'raw' ? p.bodies.filter((b) => b.complete).map((b) => b.messageId) : [])));
          for (const [mid, ids] of toolIds) {
            if (!raw.has(mid)) continue;
            const lost = ids.filter((id) => !sent.has(id));
            if (lost.length) w.violation('workload', `step ${n}: ${w.addName(mid)} went out whole but without its tool blocks ${lost.join(', ')}`);
          }
        }
        const id = `t${w.seed}_${n}`;
        if (n % 4 === 1) {
          // A call and its own result in one message, as a server tool's are, inside a large body.
          const own = `s${w.seed}_${n}`;
          const mid = w.add(AGENT, [
            text(`${w.c(n, 'a')} ${w.prose(between(w, SIZES.large))}`),
            call(own, `search/${n}`),
            result(own, `${w.c(n, 'x')} ${w.prose(between(w, SIZES.large))}`),
            text(w.prose(200)),
            call(id, `notes/${n}.md`),
          ]);
          toolIds.set(mid, [own, id]);
        } else {
          w.add(AGENT, [text(`${w.c(n, 'a')} ${w.prose(between(w, SIZES.call))}`), call(id, `notes/${n}.md`)]);
        }
        const big = n % 2 === 0;
        const rid = w.add('User', [result(id, big
          ? [text(`${w.c(n, 'r')} ${w.prose(between(w, SIZES.large))}`), image(w.seed * 1000 + n), text(w.prose(between(w, SIZES.large)))]
          : `${w.c(n, 'r')} ${w.prose(between(w, SIZES.result))}`)]);
        if (big) toolIds.set(rid, [id]);
        w.add(AGENT, [text(`${w.c(n, 'b')} ${w.prose(between(w, SIZES.reply))}`)]);
        await w.settle();
        await w.endStep();
      }
    },
  },

  W6: {
    from: 'checkpoint',
    nonCompressing: true,
    turns: 20,
    // Two promises, by configuration (Oscar-1005 #300279, as #300707 amends it). The compressing configurations strip
    // unpaired blocks, so no request of theirs carries one. A passthrough sends every message from its request's
    // start as stored: none is left out of the span, and each shape W6 stores (an id's first call when the id is used
    // again, a lost call, a result whose call isn't stored) goes out with its block. That no request opens with a
    // result whose call isn't in it is the recorder's `shape` invariant, under every workload.
    property: 'tools: under a configuration that compresses, no request carries a tool result without its call before it, or a call without its result after it but in the last message; under a passthrough, every stored message from the request\'s first goes out, and a stored unpaired call or result goes out as stored',
    async run(w) {
      const stored = []; // W6's own unpaired blocks: { msg, type, id }
      // The stored messages a passthrough request leaves out of its own span: every body from the request's first
      // stored message on is in it, a body stored in shards counted once, by its head.
      const leftOut = (compiled) => {
        const sent = (compiled.provenance?.messages ?? []).flatMap((p) => (p?.kind === 'raw' ? (p.bodies ?? []).map((b) => String(b.messageId)) : []));
        if (!sent.length) return [];
        const bodies = w.manager.getAllMessages().filter((m) => !m.bodyGroupId || (m.shardIndex ?? 0) === 0).map((m) => String(m.id));
        const from = bodies.indexOf(sent[0]);
        if (from < 0) return [];
        const have = new Set(sent);
        return bodies.slice(from).filter((id) => !have.has(id));
      };
      const kept = (compiled, s) => {
        const prov = compiled.provenance?.messages ?? [];
        const i = prov.findIndex((p) => p?.kind === 'raw' && (p.bodies ?? []).some((b) => String(b.messageId) === String(s.msg)));
        if (i < 0) return true; // its message isn't in this request
        const content = Array.isArray(compiled.messages[i]?.content) ? compiled.messages[i].content : [];
        return content.some((b) => b?.type === s.type && (s.type === 'tool_use' ? toolUseId(b) : toolResultId(b)) === s.id);
      };
      for (let n = 1; n <= w.job.turns; n++) {
        w.step(n);
        w.add('User', [text(`${w.c(n, 'u')} ${w.prose(between(w, SIZES.user))}`)]);
        const compiled = await w.compile();
        if (compiled && w.compresses) {
          const { orphans, unanswered } = unpairedTools(compiled);
          if (orphans.length) w.violation('workload', `step ${n}: tool results with no call before them: ${orphans.join(', ')}`);
          if (unanswered.length) w.violation('workload', `step ${n}: calls with no result after them: ${unanswered.join(', ')}`);
        } else if (compiled) {
          const lost = stored.filter((s) => !kept(compiled, s));
          if (lost.length) w.violation('workload', `step ${n}: stored unpaired blocks went out without their block: ${lost.map((s) => s.id).join(', ')}`);
          const gaps = leftOut(compiled);
          if (gaps.length) w.violation('workload', `step ${n}: stored messages inside the request's span left out: ${gaps.map((id) => w.addName(id)).join(', ')}`);
        }
        const a = `t${w.seed}_${n}a`, b = `t${w.seed}_${n}b`;
        switch (n % 4) {
          case 0: // parallel calls and results
            w.add(AGENT, [text(`${w.c(n, 'a')} ${w.prose(between(w, SIZES.call))}`), call(a, `a/${n}`), call(b, `b/${n}`)]);
            w.add('User', [result(a, `${w.c(n, 'r')} ${w.prose(between(w, SIZES.result))}`), result(b, w.prose(between(w, SIZES.result)))]);
            break;
          case 1: { // an id used again before its first result
            const r = `t${w.seed}_reuse`;
            stored.push({ msg: w.add(AGENT, [text(`${w.c(n, 'a')} ${w.prose(between(w, SIZES.call))}`), call(r, `r/${n}`)]), type: 'tool_use', id: r });
            w.add(AGENT, [text(w.prose(60)), call(r, `r/${n}-again`)]);
            w.add('User', [result(r, `${w.c(n, 'r')} ${w.prose(between(w, SIZES.result))}`)]);
            break;
          }
          case 2: // a call nobody answers
            stored.push({ msg: w.add(AGENT, [text(`${w.c(n, 'a')} ${w.prose(between(w, SIZES.call))}`), call(a, `lost/${n}`)]), type: 'tool_use', id: a });
            break;
          default: { // a result whose call isn't stored
            const ghost = `t${w.seed}_ghost_${n}`;
            w.add(AGENT, [text(`${w.c(n, 'a')} ${w.prose(between(w, SIZES.call))}`)]);
            stored.push({ msg: w.add('User', [result(ghost, `${w.c(n, 'r')} ${w.prose(between(w, SIZES.result))}`)]), type: 'tool_result', id: ghost });
          }
        }
        w.add(AGENT, [text(`${w.c(n, 'b')} ${w.prose(between(w, SIZES.reply))}`)]);
        await w.settle();
        await w.endStep();
      }
    },
  },

  W7: {
    from: 'checkpoint',
    turns: 24,
    property: 'failures: a refused chunk is quarantined alone, and no other chunk\'s compression request carries its text',
    // merges-refused: the stand-in refuses every merge, so unmerged L1s pile up, as when merges starve (#412's failure
    // mode), and a strategy's L1 selection has to ration them. Its turns follow W1's phase plan, so the L1s that pile
    // up are of every phase, research's three-round loops most of all, as Knowledge's per-phase caps ration them.
    // from-c5 (C9 only): Knowledge set over a store an adaptive autobiographical strategy wrote (setStrategy onto
    // another strategy's store), with merges refused, so its L1 selection meets summaries of no phase among its own.
    variants: (config) => [
      'modes', 'deferred', 'merges-refused',
      ...(['C3', 'C7'].includes(config) ? ['source-only', 'split'] : []),
      ...(config === 'C9' ? ['from-c5'] : []),
    ],
    fromConfig: (config, variant) => (variant === 'from-c5' ? 'C5' : config),
    overrides(variant) {
      if (variant === 'source-only') return { compressionSourceOnlyFallback: true };
      if (variant === 'split') return { compressionSourceOnlyFallback: true, compressionSplitFallback: true };
      if (variant === 'deferred') return { compressionModel: 'claude-fable-5-1' };
      return {};
    },
    toolsAtOpen: (variant) => variant !== 'deferred',
    async run(w) {
      const MARKS = { 3: 'fx:refuse', 6: 'fx:empty', 9: 'fx:thinking', 12: 'fx:max-tokens', 15: 'fx:overlong', 18: 'fx:throw', 21: 'fx:merge-refuse' };
      if (['merges-refused', 'from-c5'].includes(w.job.variant)) w.standin.refuseMerges = true;
      const quiet = ['deferred', 'merges-refused', 'from-c5'].includes(w.job.variant);
      const poisoned = (quiet ? [] : [3]).map((n) => w.c(n, 'x'));
      // With merges refused, research's L1s pass Knowledge's research cap (0.3 of the L1 room) by about turn 28 at
      // the fixture's sizes (J57513: 1,430 of 1,683 tokens at turn 24 under C9), so this variant runs longer.
      const turns = w.job.variant === 'merges-refused' ? 32 : w.job.turns;
      for (let n = 1; n <= turns; n++) {
        if (w.job.variant === 'deferred' && n === 10) { w.step(n); w.declareTools(); await w.settle(); await w.endStep(); continue; }
        const mark = quiet ? null : (w.job.variant === 'modes' ? MARKS[n] : (n === 3 ? 'fx:refuse' : null));
        if (mark) {
          w.step(n);
          w.add('User', [text(`${w.c(n, 'x')} ${mark} ${w.prose(between(w, SIZES.user))}`)]);
          await w.compile();
          w.add(AGENT, [text(`${w.c(n, 'b')} ${w.prose(between(w, SIZES.reply))}`)]);
          await w.settle();
          await w.endStep();
        } else {
          await turn(w, n, w.job.variant === 'merges-refused' ? phaseTurn(n) : {});
        }
      }
      // The cascade: a refused call that carries the poisoned text and a message two turns or more after it is
      // another chunk's compression, poisoned by a quarantined chunk left in its context.
      for (const p of poisoned) {
        const turnOf = (c) => Number(c.split('.')[1]);
        const pTurn = turnOf(p);
        const cascade = w.calls.filter((c) => c.kind === 'refusal' && c.carried.includes(p) && c.carried.some((x) => /^c\d+\.\d+\.[a-z]$/.test(x) && x.startsWith(`c${w.seed}.`) && turnOf(x) >= pTurn + 2));
        if (cascade.length) w.violation('workload', `${cascade.length} refused calls for other chunks carried the quarantined ${p} (steps ${[...new Set(cascade.map((c) => c.step))].join(', ')})`);
      }
    },
  },

  W8: {
    from: 'checkpoint',
    nonCompressing: true,
    turns: 20,
    property: 'tight: with the budget lowered to the edge and restored, a configuration that compiled every turn before the lowering does so again within two steps of the restore',
    variants: () => ['enforced', 'unenforced'],
    overrides: (variant) => ({ enforceBudget: variant === 'enforced' }),
    async run(w) {
      const normal = { ...w.budget };
      let restoredAt = null;
      let fitBefore = true; // every compile of the turns before the lowering went through
      for (let n = 1; n <= w.job.turns; n++) {
        if (n === 5) w.setBudget({ ...normal, maxTokens: Math.round(normal.maxTokens * 0.6) });
        if (n === 9) w.setBudget({ ...normal, maxTokens: Math.round(normal.maxTokens * 0.35) });
        if (n === 13) { w.setBudget(normal); restoredAt = n; }
        // A host's preview of the context at a smaller room than the turn's (agent-framework previews at a caller's
        // budget): it commits nothing, so the turn's compile after it is the one it would have been. At step 11 the
        // preview's room is below the newest message alone, where a compile would refuse and a preview reports.
        await w.dryCompile({ ...w.budget, maxTokens: n === 11 ? 50 : Math.round(w.budget.maxTokens / 2) });
        // kv-stable's solve under a lowered budget escalates: its turn's request is compiled twice, to check that a
        // second solve sends the same messages and queues no new work (KS-23).
        const compiled = await turn(w, n, { again: w.built.options.foldingStrategy === 'kv-stable' });
        if (n < 5 && !compiled) fitBefore = false;
        if (fitBefore && restoredAt !== null && n >= restoredAt + 2 && !compiled) w.violation('workload', `step ${n}: still refusing ${n - restoredAt} steps after the budget was restored`);
      }
    },
  },

  W9: {
    from: 'checkpoint',
    nonCompressing: true,
    turns: 20,
    property: 'lifecycle: a store closed and reopened sends the request it sent before',
    async run(w) {
      const added = [];
      const stepStart = []; // where in `added` each step's messages begin
      let held = [];
      let pin = null;
      for (let n = 1; n <= w.job.turns; n++) {
        const before = w.manager.getAllMessages().length;
        stepStart[n] = added.length;
        await turn(w, n);
        added.push(...w.manager.getAllMessages().slice(before).map((m) => m.id));
        const at = (k) => added[Math.max(0, added.length - 1 - k)];
        switch (n) {
          case 3: { // the reload check: the same request after a close and reopen
            const before = await w.compile();
            await w.reopen();
            const after = await w.compile();
            const strip = (c) => JSON.stringify((c?.messages ?? []).map((m) => { const { cacheBreakpoint, ...r } = m; return r; }));
            if (strip(before) !== strip(after)) w.violation('workload', 'step 3: the request after a reopen differs from the one before it');
            break;
          }
          case 5:
            await w.act('settings', { tailTokens: 1000 }, (m) => m.updateHotContextSettings({ tailTokens: Math.round(15000 / w.scale) }));
            // A gradual move to a smaller context window, which adaptive kv-stable alone prepares (a host's context
            // settings): later compiles aim at the prepared window at the given pace.
            if (w.built.options.foldingStrategy === 'kv-stable' && w.built.options.adaptiveResolution) {
              const update = { preparedWindowTokens: Math.round(w.budget.maxTokens * 0.6), transitionPaceTokens: Math.round(10000 / w.scale) };
              await w.act('settings', update, (m) => m.updateHotContextSettings(update));
            }
            // A recipe's out-of-range re-anchor setting, which the windowed strategy refuses at construction (WP-4).
            if (w.built.cls === 'WindowedPassthroughStrategy') {
              await w.act('construct', { reAnchorFraction: 1.5 }, () => { new w.arm.cm.WindowedPassthroughStrategy({ ...w.built.options, reAnchorFraction: 1.5 }); return 'built'; });
            }
            break;
          case 7: {
            // A derived context at the head, reusing the parent's rendering frontier (derive's default solve), as
            // agent-framework's ephemeral runs derive one: its first compile, with the markers it places.
            const derive = async (branch, strategy) => w.act('derive', { branch, strategy: strategy.constructor.name }, async (m) => {
              const derived = await m.derive({ branch, strategy });
              try {
                return w.compileSummary(await derived.compile({ ...w.budget }));
              } finally {
                derived.close?.();
              }
            });
            await derive('fixture-derived', w.freshStrategy());
            // A windowed child of a compressing parent: it takes no other strategy's frontier (WP-26).
            if (w.compresses) await derive('fixture-derived-windowed', w.strategyOf('C2'));
            break;
          }
          case 8:
            // The prepared window again, at a pace a group's fold fits in: step 6's reopen dropped step 5's runtime
            // settings, and step 5's pace, by Gordon-2414's reading, is smaller than any fold. The plan sits above the
            // window here, so it can move toward it (KS-17, KC-4, KC-8, KC-14).
            if (w.built.options.foldingStrategy === 'kv-stable' && w.built.options.adaptiveResolution) {
              const update = { preparedWindowTokens: Math.round(w.budget.maxTokens * 0.6), transitionPaceTokens: Math.round(50000 / w.scale) };
              await w.act('settings', update, (m) => m.updateHotContextSettings(update));
            }
            break;
          case 13: {
            // An undo and a redo, as a host moves the store's branch under an open manager: a branch at the end of
            // step 11's turn (a turn's boundary, so no tool call is left without its result), a compile there, and the
            // branch it left, compiled again.
            const from = w.manager.currentBranch().name;
            const point = added[stepStart[12] - 1];
            const back = await w.act('branch-at', { message: w.addName(point), name: 'fixture-undo' }, (m) => m.branchAt(point, 'fixture-undo'));
            if (typeof back === 'string') {
              await w.act('switch', { branch: 'the step-13 branch' }, (m) => m.switchBranch(back));
              await w.compile();
              await w.act('switch', { branch: 'the run\'s branch' }, (m) => m.switchBranch(from));
              await w.compile();
            }
            break;
          }
          case 6: {
            // An inherited record: everything before this step's newest message is witnessed, not lived, from now on,
            // so this run's earlier turns, still raw, compress with the witnessed instruction and reminder once they
            // leave the recent window.
            const pin = w.manager.getMessage(added.at(-1))?.sequence;
            if (typeof pin === 'number') await w.reopen({ witnessedBeforeSequence: pin, witnessedIdentityReminder: 'This stretch is a record you inherited, not your own experience.' });
            break;
          }
          case 9: {
            // A hold that lands on chunks already queued: the stand-in parks every compression call, more of the
            // conversation arrives so chunks queue behind the parked one, and then the hold lands on messages from
            // steps 5 and 6 before any call for their chunks goes out. A hold keeps the message and everything after
            // it out of compression, so a queued chunk holding any of them must wait.
            w.standin.pace(0);
            for (let k = 0; k < 3; k++) {
              w.add('User', [text(`${w.c(n, `u${k}`)} ${w.prose(between(w, SIZES.reading))}`)]);
              w.add(AGENT, [text(`${w.c(n, `b${k}`)} ${w.prose(between(w, SIZES.reply))}`)]);
            }
            await w.settle();
            held = [added[stepStart[5]], added[stepStart[6]]];
            await w.act('hold', { messages: held.map((id) => w.addName(id)) }, (m) => m.holdCompression(held));
            w.release(Infinity);
            w.standin.pace(Infinity);
            await w.settle();
            break;
          }
          case 10:
            pin = await w.act('pin', { first: w.addName(added[0]), last: w.addName(added[3]) }, (m) => m.pinRange(added[0], added[3]));
            break;
          case 11:
            await w.act('pin-level', { first: w.addName(added[4]), last: w.addName(added[7]), level: 1 }, (m) => m.pinAtLevel(added[4], added[7], 1));
            break;
          case 12: {
            // A removal into a held chunk, as #417's fix met it.
            const inside = held[0];
            await w.act('remove', { message: w.addName(inside) }, (m) => m.removeMessage(inside));
            await w.act('release-hold', { messages: held.slice(1).map((id) => w.addName(id)) }, (m) => m.releaseCompression(held.slice(1)));
            break;
          }
          case 14:
            if (typeof pin === 'string') await w.act('unpin', { pin: 'the step-10 pin' }, (m) => m.unpin(pin));
            break;
          case 15:
            await w.act('reset-head', { text: 'A new topic.' }, (m) => m.resetHeadWindow('A new topic.'));
            break;
          case 16: {
            // An edit as a host makes one: new words in the same shape, so a tool result stays the result of its call
            // (a result staged with a placeholder and filled in later, as holdCompression's doc describes).
            const target = at(1);
            const words = `${w.c(n, 'e')} ${w.prose(between(w, SIZES.reply))}`;
            const content = (w.manager.getMessage(target)?.content ?? []).map((b) => {
              if (b?.type === 'tool_result') return { ...b, content: words };
              if (b?.type === 'text') return { ...b, text: words };
              return b;
            });
            await w.act('edit', { message: w.addName(target) }, (m) => m.editMessage(target, content));
            break;
          }
          case 17: {
            // A removal outside any tool cycle: step 16's user message (a host suppressing a message), so no call or
            // result is left without its pair by the removal itself.
            const target = added[stepStart[16]];
            await w.act('remove', { message: w.addName(target) }, (m) => m.removeMessage(target));
            break;
          }
          case 19: // a reopen with a grown head window (J56719's Knowledge case)
            await w.reopen({ headWindowTokens: Math.round(8000 / w.scale) });
            break;
          default:
            break;
        }
      }
    },
  },

  W10: {
    from: 'checkpoint',
    turns: 30,
    property: 'pressure: with compression slower than intake and the speculation cap set, merges still get calls during the backlog',
    runs: (config) => ['C3', 'C5', 'C6', 'C7', 'C8'].includes(config) || config.startsWith('H1'),
    variants: () => ['uncapped', 'capped'],
    overrides: (variant) => (variant === 'capped' ? { maxSpeculativeL1s: 6 } : {}),
    async run(w) {
      const level2 = () => { try { return w.manager.getSummariesInRange({ level: 2 }).length + w.manager.getSummariesInRange({ level: 3 }).length; } catch { return 0; } };
      const start = level2();
      w.standin.pace(1);
      for (let n = 1; n <= w.job.turns; n++) {
        if (n === 12) {
          // A compile made while a compression is in flight: the next call is held across it.
          w.step(n);
          w.standin.holdNext();
          w.add('User', [text(`${w.c(n, 'u')} ${w.prose(between(w, SIZES.user))}`)]);
          await w.settle();
          await w.compile();
          w.standin.releaseHeld();
          w.standin.pace(1);
          w.add(AGENT, [text(`${w.c(n, 'b')} ${w.prose(between(w, SIZES.reply))}`)]);
          await w.settle();
          await w.endStep();
          continue;
        }
        w.release(1);
        await turn(w, n, { reading: true });
      }
      w.release(Infinity);
      await w.settle();
      if (w.job.variant === 'capped' && level2() === start) w.violation('workload', `no merge landed in ${w.job.turns} turns of backlog`);
    },
  },

  W11: {
    from: 'checkpoint',
    turns: 20,
    property: 'protections: pins, locks and document marks a caller puts on older messages hold through a budget cut that escalates and a restore (the pins invariant reads each compile), and a report with no usable total teaches the calibration nothing',
    // The two folding strategies that read pins and locks: kv-stable (C6) and kv-unified (C7, the H1s).
    runs: (config) => config === 'C6' || config === 'C7' || config.startsWith('H1'),
    // Under the H1s, which report every response's input total to the calibration, a variant whose store refuses the
    // calibration's state writes: the library persists the calibration best-effort (calibration's P4).
    variants: (config) => (config.startsWith('H1') ? [null, 'state-write-fails'] : [null]),
    ownStore: (variant) => variant === 'state-write-fails',
    async run(w) {
      const normal = { ...w.budget };
      // Older messages, which every configuration here folds: picked by their place in the checkpoint's store, which
      // is the same store in every version.
      const old = w.manager.getAllMessages();
      const oldAt = (f) => old[Math.min(old.length - 1, Math.floor(old.length * f))].id;
      const oldFrom = (f, pred) => old.slice(Math.floor(old.length * f)).find(pred)?.id ?? oldAt(f);
      const isResult = (m) => (m.content ?? []).some((b) => b?.type === 'tool_result');
      const name = (id) => w.addName(id);
      const pin = (first, last, opts) => w.act('pin', { first: name(first), last: name(last), ...opts }, (m) => m.pinRange(first, last, opts));
      const lock = (id) => w.act('lock', { message: name(id) }, (m) => m.getStrategy().lockChunk(id));
      const added = [];
      // A report with no usable total before every real one (calibration's C4): it teaches nothing, so the real report
      // after it is learned from as before. Only the H1s send, so only they report.
      await w.act('report', { total: 'NaN, before each real report' }, () => { w.nanBeforeReports = true; });
      // The variant's store refuses every calibration state write from the first turn to the last.
      if (w.job.variant === 'state-write-fails') {
        await w.act('fault', { refuse: 'calibration state writes' }, () => { w.refuseStateWrites = (id) => id.includes('calibration'); });
      }
      for (let n = 1; n <= w.job.turns; n++) {
        // A budget cut to 0.35, where kv-stable's solve escalates (as W8's), and the restore.
        if (n === 9) w.setBudget({ ...normal, maxTokens: Math.round(normal.maxTokens * 0.35) });
        if (n === 13) w.setBudget(normal);
        const before = w.manager.getAllMessages().length;
        await turn(w, n);
        added.push(...w.manager.getAllMessages().slice(before).map((m) => m.id));
        switch (n) {
          case 2: // A pin at level 0 (KS-8) and one that folds no deeper than 0 (KS-9).
            await pin(oldAt(0.10), oldAt(0.12), { level: 0 });
            await pin(oldAt(0.14), oldAt(0.16), { maxLevel: 0 });
            break;
          case 3: // A pinned message that's all tool result, so its salience is the floor's (KS-16).
            { const r = oldFrom(0.30, isResult); await pin(r, r, {}); }
            break;
          case 4: // A locked message that also carries a cap on its level, before the budget moves (KS-11).
            await lock(oldAt(0.45));
            await pin(oldAt(0.45), oldAt(0.45), { maxLevel: 2 });
            break;
          case 5: { // A lock with a level pin over it (KS-24 B), and a lock on the message after the pin's range (A).
            await lock(oldAt(0.55));
            await w.act('pin-level', { first: name(oldAt(0.54)), last: name(oldAt(0.56)), level: 1 }, (m) => m.pinAtLevel(oldAt(0.54), oldAt(0.56), 1));
            const after = old[old.findIndex((m) => m.id === oldAt(0.56)) + 1]?.id;
            if (after) await lock(after);
            break;
          }
          case 6: // A document that folds no deeper than L1, inside older history (KC-26 to KC-28 need it under a group
            // the plan sends at L3, which C6's compile here doesn't: J57851).
            { const d = oldAt(0.20); await w.act('mark-document', { message: name(d), maxLevel: 1 }, (m) => m.markDocument(d, { maxLevel: 1 })); }
            break;
          case 8: // A level pin on this run's first messages before the cut. (KS-26 needs held messages with no L1 of
            // their own; by J57792's record these already have theirs, so this doesn't reach it.)
            await w.act('pin-level', { first: name(added[0]), last: name(added[3]), level: 1 }, (m) => m.pinAtLevel(added[0], added[3], 1));
            break;
        }
      }
      // The variant's fault ends here, and the record says how many writes it refused: the calibration writes only
      // when its multiplier moves past its dead band, so a run whose multiplier never moves refuses none, and then
      // the variant reaches nothing.
      if (w.job.variant === 'state-write-fails') {
        await w.act('fault', { refuse: 'nothing' }, () => { const refusedWrites = w.refusedStateWrites ?? 0; w.refuseStateWrites = null; return { refusedWrites }; });
      }
    },
  },
};

/**
 * The runs of one check, as jobs: { id, config, workload, variant, seed, turns, scale, from, save }. `from` and
 * `save` are checkpoint keys, CONFIG/WORKLOAD@TURNS: W1 and W2 from empty can save their end as the checkpoint their
 * configuration's continuations start from (when writing checkpoints); a continuation names the one it starts from.
 * @param {object} house house.json
 * @param {{ writeCheckpoints?: boolean }} [o]
 */
export function matrix(house, o = {}) {
  const { compressing, nonCompressing } = allConfigs(house);
  const jobs = [];
  const job = (config, workload, variant, from, save, scale = SCALE) => {
    const id = variant ? `${config}/${workload}/${variant}` : `${config}/${workload}`;
    jobs.push({ id, config, workload, variant: variant ?? null, seed: seedOf(id), turns: WORKLOADS[workload].turns, scale, from, save: o.writeCheckpoints ? save : null });
  };
  const key = (config, workload) => `${config}/${workload}@${WORKLOADS[workload].turns}`;
  for (const c of compressing) {
    job(c, 'W1', null, null, null);
    job(c, 'W2', null, null, key(c, 'W2'));
  }
  for (const c of nonCompressing) job(c, 'W1', null, null, key(c, 'W1'));
  // The house's compressing configurations once at their own sizes, so the host's sizes are seen once (§5).
  for (const c of compressing.filter((c) => c.startsWith('H'))) {
    for (const w of ['W1', 'W2']) {
      job(c, w, 'real', null, null, 1);
      jobs.at(-1).turns = WORKLOADS[w].realTurns;
    }
  }
  for (const [name, wl] of Object.entries(WORKLOADS)) {
    if (wl.from === null) continue;
    for (const c of compressing) {
      if (wl.runs && !wl.runs(c)) continue;
      for (const variant of wl.variants?.(c) ?? [null]) job(c, name, variant, key(wl.fromConfig?.(c, variant) ?? c, 'W2'), null);
    }
    if (wl.nonCompressing) for (const c of nonCompressing) for (const variant of wl.variants?.(c) ?? [null]) job(c, name, variant, key(c, 'W1'), null);
  }
  // Canaries tell runs' messages apart by seed (W7's cascade check relies on it), and a continuation's messages sit
  // beside its checkpoint's: no two runs, and no run and its checkpoint, may share one.
  const seeds = new Map();
  for (const j of jobs) {
    if (seeds.has(j.seed)) throw new Error(`runs ${seeds.get(j.seed)} and ${j.id} share seed ${j.seed}: change seedOf`);
    seeds.set(j.seed, j.id);
  }
  return jobs;
}

/** A run's seed: a number from its id, so a run's script is the same in every version and stable as the matrix grows. */
export function seedOf(id) {
  let x = 2166136261;
  for (const ch of id) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0;
  return 100 + (x % 900000);
}
