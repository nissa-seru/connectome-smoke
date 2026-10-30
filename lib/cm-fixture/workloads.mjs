// The workloads of the context-management characterization fixture (merged design §5), and the matrix of runs a
// check makes. Each workload drives a Run (driver.mjs) through context-manager's public API only, so the same
// script runs against both arms.
//
// W1 and W2 build a store from empty; every other workload continues a copy of a checkpoint the base wrote at
// W2's end (W1's for the configurations that don't compress), in both arms, so a divergence shows in the workload
// whose behaviour moved rather than cascading from a different W2.
//
// Messages carry a canary first, c<seed>.<turn>.<role> (u: the user's turn, a: the agent's call, r: the tool's
// result, b: the agent's reply), so a reader of any request can see which raw messages it carries.

import { COMPRESSING, NON_COMPRESSING, SCALE } from './configs.mjs';

export const AGENT = 'Junga';

/** Characters per message at the fixture's scale (the host's sizes over SCALE, about 3.5 characters a token). */
const SIZES = {
  user: [30, 120],
  call: [80, 300],
  result: [200, 900],
  reading: [600, 800],
  reply: [60, 240],
};

/** A size from its range, at the run's scale: the ranges are for SCALE, so a run at the host's sizes writes 15 times more. */
function between(w, [lo, hi]) {
  const k = SCALE / w.scale;
  return Math.round(k * (lo + Math.floor(w.rng() * (hi - lo + 1))));
}

/**
 * One turn as a resident has it: the user writes, the host compiles, the agent calls a tool, the result comes back,
 * the agent replies, and compression catches up.
 * @param {object} [o] { reading: tool results of reading size; user, call, result, reply: text to use instead }
 */
export async function turn(w, n, o = {}) {
  w.step(n);
  w.add('User', [{ type: 'text', text: `${w.c(n, 'u')} ${o.user ?? w.prose(between(w, SIZES.user))}` }]);
  await w.compile();
  const id = `t${w.seed}_${n}`;
  w.add(AGENT, [
    { type: 'text', text: `${w.c(n, 'a')} ${o.call ?? w.prose(between(w, SIZES.call))}` },
    { type: 'tool_use', id, name: 'read_file', input: { path: `notes/${n}.md` } },
  ]);
  w.add('User', [{ type: 'tool_result', toolUseId: id, toolName: 'read_file', content: `${w.c(n, 'r')} ${o.result ?? w.prose(between(w, o.reading ? SIZES.reading : SIZES.result))}` }]);
  w.add(AGENT, [{ type: 'text', text: `${w.c(n, 'b')} ${o.reply ?? w.prose(between(w, SIZES.reply))}` }]);
  await w.settle();
  await w.endStep();
}

/** Each workload: what it starts from, how many turns, and its script. `turns` is set by sensitivity sizing. */
export const WORKLOADS = {
  W1: {
    from: null,
    turns: 120,
    async run(w) {
      for (let n = 1; n <= w.job.turns; n++) await turn(w, n);
    },
  },
  W2: {
    from: null,
    turns: 120,
    async run(w) {
      for (let n = 1; n <= w.job.turns; n++) await turn(w, n, { reading: true });
    },
  },
};

/**
 * The runs of one check, as jobs: { id, config, workload, variant, seed, turns, from, save }. `from` and `save` are
 * checkpoint keys, CONFIG/WORKLOAD@STEP:BASE, BASE being the base's commit (12 digits). A from-empty W1 or W2 saves
 * its end as the checkpoint its configuration's continuations start from, in the base arm only.
 * @param {object} house house.json
 * @param {string} base the base commit
 * @param {'base'|'candidate'} arm
 */
export function matrix(house, base, arm) {
  const b = base.slice(0, 12);
  const h = Object.keys(house.configs).sort();
  const compressing = [...COMPRESSING.filter((c) => c.startsWith('C')), ...h.filter((c) => c.startsWith('H1') || c === 'H2')];
  const nonCompressing = [...NON_COMPRESSING.filter((c) => c.startsWith('C')), ...h.filter((c) => c === 'H3' || c === 'H4')];
  const jobs = [];
  const job = (config, workload, variant, from, save, scale = SCALE) => {
    const id = variant ? `${config}/${workload}/${variant}` : `${config}/${workload}`;
    jobs.push({ id, config, workload, variant: variant ?? null, seed: seedOf(id), turns: WORKLOADS[workload].turns, scale, from, save: arm === 'base' ? save : null });
  };
  const key = (config, workload) => `${config}/${workload}@${WORKLOADS[workload].turns}:${b}`;
  for (const c of compressing) {
    job(c, 'W1', null, null, null);
    job(c, 'W2', null, null, key(c, 'W2'));
  }
  for (const c of nonCompressing) job(c, 'W1', null, null, key(c, 'W1'));
  // The house's compressing configurations once at their own sizes, so the host's sizes are seen once (§5).
  for (const c of compressing.filter((c) => c.startsWith('H'))) for (const w of ['W1', 'W2']) job(c, w, 'real', null, null, 1);
  for (const [name, wl] of Object.entries(WORKLOADS)) {
    if (wl.from === null) continue;
    for (const c of compressing) {
      for (const variant of wl.variants?.(c) ?? [null]) if (wl.runs?.(c, variant) ?? true) job(c, name, variant, key(c, 'W2'), null);
    }
    if (wl.nonCompressing) for (const c of nonCompressing) job(c, name, null, key(c, 'W1'), null);
  }
  return jobs;
}

/** A run's seed: a number from its id, so a run's script is the same in both arms and stable as the matrix grows. */
export function seedOf(id) {
  let x = 2166136261;
  for (const ch of id) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0;
  return 100 + (x % 9000);
}
