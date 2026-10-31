// The configurations the context-management characterization fixture runs, built in each arm from that arm's own
// library, with every size scaled by one factor so depth arrives in tens of turns rather than hundreds.
//
// C1-C9 are context-manager's own strategies at the library's defaults (merged design §1); H1-H4 are the house's,
// at the options a released connectome-host passes (house.json, written by capture.mjs). Either way the fixture
// gives a strategy only what its configuration names, then reads back the sizes the arm's library resolved, its
// defaults included, and builds the strategy again with each size divided by SCALE. So a default the candidate
// changes still shows, scaled like the rest.
//
// What scales: every numeric option whose name ends in `Tokens` (0, which means off, stays 0), and kvUnified's
// token-denominated fields (its buckets, label ceiling, adopt epsilon, and its policy's cache and continuity scales
// and recency half-life). The compile budget scales too, and a house configuration's reserve for a response, which
// is its agent's max_tokens. A size the library defaults in its code rather than in its resolved config (a strategy
// reading `this.config.NAME ?? N`, such as the level budgets and the summary target) is read from the arm's source
// and scaled with the rest, so the proportions hold at the fixture's sizes as at the host's (inCodeSizes). What
// doesn't scale: image ceilings, which count images and bytes; and the C configurations' reserve, which the strategy
// lane keeps at 2,048. A size the library compares with a literal floor of its own code scales only above that floor
// (reservedHeadroom): the compression context budget is compared with a request's input plus an output reserve of at
// least 16,000, a literal, so its headroom over the reserve scales and the reserve doesn't, and each comparison is the
// host's at scale. A literal floor under a configured size, which no configuration can move, can't be matched at all
// (the merge recall's 8,000): the rungs under it don't exist in a scaled run.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SCALE = 15;

const KV_UNIFIED_TOKENS = ['tokenBucketSize', 'continuityBucketSize', 'fidelityBucketSize', 'labelCeiling', 'adoptEpsilon'];
const KV_UNIFIED_POLICY_TOKENS = ['cacheScale', 'continuityScale', 'continuityRecencyHalfLifeTokens'];

const scaledBy = (scale) => (v) => (v === 0 ? 0 : Math.max(1, Math.round(v / scale)));

/** The strategy lane's budget (lib/strategies), scaled: the C configurations compile against it. */
export const LIBRARY_CONFIG_BUDGET = { maxTokens: 300_000, reserveForResponse: 2048 };

/**
 * Whether a configuration compresses: C3-C9 and the house's H1 (each model family's) and H2 do, and the passthroughs
 * (C1, C2, H3, H4) don't. The one place this is decided: the matrix, the driver and the recorder all ask here.
 */
export function compresses(config) {
  return /^(C[3-9]|H1(\..+)?|H2)$/.test(config);
}

/** The library's kvUnified block has no defaults; the C configuration uses the host's, from the capture. */
function hostKvUnified(house) {
  const h1 = Object.values(house.configs).find((c) => c.options?.foldingStrategy === 'kv-unified');
  if (!h1) throw new Error('house.json has no kv-unified configuration to take a kvUnified block from');
  return h1.options.kvUnified;
}

/** The C configurations' own options, before scaling: what each names beyond the library's defaults. */
function libraryOptions(name, house) {
  const auto = { compressionModel: 'claude-opus-4-6' };
  switch (name) {
    case 'C1': return { cls: 'PassthroughStrategy', options: {} };
    case 'C2': return { cls: 'WindowedPassthroughStrategy', options: {} };
    case 'C3': return { cls: 'AutobiographicalStrategy', options: auto };
    case 'C4': return { cls: 'AutobiographicalStrategy', options: { ...auto, hierarchical: false } };
    case 'C5': return { cls: 'AutobiographicalStrategy', options: { ...auto, adaptiveResolution: true, foldingStrategy: 'flat-profile' } };
    case 'C6': return { cls: 'AutobiographicalStrategy', options: { ...auto, adaptiveResolution: true, foldingStrategy: 'kv-stable' } };
    case 'C7': return { cls: 'AutobiographicalStrategy', options: { ...auto, adaptiveResolution: true, foldingStrategy: 'kv-unified', kvUnified: hostKvUnified(house) } };
    case 'C8': return { cls: 'AutobiographicalStrategy', options: { ...auto, adaptiveResolution: true, foldingStrategy: 'oldest-first' } };
    case 'C9': return { cls: 'KnowledgeStrategy', options: auto };
    default: throw new Error(`no library configuration ${name}`);
  }
}

/**
 * The library's own compile budget, for a configuration whose host gives none (H2: agent-framework compiles a
 * subagent with no budget, so ContextManager.compile's default applies). Read from the arm's source, since the
 * library doesn't export it, so a candidate that changes it still shows.
 */
export function libraryDefaultBudget(cmDir) {
  const text = readFileSync(join(cmDir, 'src/context-manager.ts'), 'utf8');
  const m = text.match(/budget\s*\?\?\s*\{\s*maxTokens:\s*([0-9_]+),\s*reserveForResponse:\s*([0-9_]+),?\s*\}/)
    ?? text.match(/maxTokens:\s*([0-9_]+),\s*\n\s*reserveForResponse:\s*([0-9_]+),?\s*\n\s*\}/);
  if (!m) throw new Error(`can't find ContextManager.compile's default budget in ${cmDir}/src/context-manager.ts: read it and update libraryDefaultBudget`);
  return { maxTokens: Number(m[1].replaceAll('_', '')), reserveForResponse: Number(m[2].replaceAll('_', '')) };
}

/**
 * A configuration's options with every size its library resolved divided by the scale; a size in `headroom` keeps
 * the floor named there and scales only what is above it.
 */
function scaleOptions(options, resolved, scaled, headroom = {}) {
  const out = { ...options };
  for (const [key, value] of Object.entries(resolved ?? {})) {
    if (!key.endsWith('Tokens') || typeof value !== 'number' || !Number.isFinite(value)) continue;
    const floor = headroom[key];
    out[key] = floor === undefined || value <= floor ? scaled(value) : floor + scaled(value - floor);
  }
  if (options.kvUnified) {
    const kv = { ...options.kvUnified, policy: { ...options.kvUnified.policy } };
    for (const key of KV_UNIFIED_TOKENS) if (typeof kv[key] === 'number') kv[key] = scaled(kv[key]);
    for (const key of KV_UNIFIED_POLICY_TOKENS) if (typeof kv.policy[key] === 'number') kv.policy[key] = scaled(kv.policy[key]);
    out.kvUnified = kv;
  }
  return out;
}

/**
 * The sizes a strategy resolved: its config, a knowledge strategy's own sizes beside it, and the sizes its code
 * defaults where the config leaves them unset.
 */
function resolvedSizes(strategy, cls, cmDir) {
  if (cls === 'PassthroughStrategy') return {};
  if (cls === 'WindowedPassthroughStrategy') {
    // Its options aren't kept as a config: the two sizes it takes, as it reports them.
    return { maxMessageTokens: strategy.maxMessageTokens ?? 0, imageStripDepthTokens: strategy.imageStripDepthTokens };
  }
  const config = strategy.config;
  if (!config || typeof config !== 'object') throw new Error(`${cls} keeps no config to read its resolved sizes from: read it and update resolvedSizes`);
  const defaults = inCodeSizes(cmDir);
  const unset = Object.fromEntries(Object.entries(defaults).filter(([key]) => config[key] === undefined));
  return { ...unset, ...config, ...(strategy.knowledgeConfig ?? {}) };
}

/**
 * The sizes the autobiographical strategy defaults in its code, `this.config.NAME ?? N` with NAME ending in `Tokens`
 * and N a number, read from the arm's source so a candidate that changes one still shows. A size defaulted to two
 * different numbers in two places can't be scaled as one: that refuses, to be read and settled here.
 */
function inCodeSizes(cmDir) {
  const text = readFileSync(join(cmDir, 'src/strategies/autobiographical.ts'), 'utf8');
  const found = {};
  for (const m of text.matchAll(/this\.config\.([A-Za-z0-9]+Tokens)\s*\?\?\s*([0-9][0-9_]*)\b/g)) {
    const value = Number(m[2].replaceAll('_', ''));
    if (found[m[1]] !== undefined && found[m[1]] !== value) {
      throw new Error(`${cmDir}/src/strategies/autobiographical.ts defaults ${m[1]} to both ${found[m[1]]} and ${value}: read it and update inCodeSizes`);
    }
    found[m[1]] = value;
  }
  return found;
}

/**
 * The sizes the autobiographical strategy compares with a literal floor of its own code, with that floor, read from the
 * arm's source: the compression context budget, which admission (compressionAdmission) and the pins-over-budget check
 * (priceRequest) compare with a request's input plus its output reserve, `Math.max(N, Math.round(targetTokens * 1.5))`
 * at every site, N a literal (16,000 at fb4cf1046). A reserve read at no site, or as two different floors, refuses, to
 * be read and settled here.
 */
function reservedHeadroom(cmDir) {
  const text = readFileSync(join(cmDir, 'src/strategies/autobiographical.ts'), 'utf8');
  const floors = new Set([...text.matchAll(/Math\.max\(\s*([0-9][0-9_]*)\s*,\s*Math\.round\(targetTokens \* 1\.5\)\s*\)/g)].map((m) => Number(m[1].replaceAll('_', ''))));
  if (floors.size !== 1) {
    throw new Error(`${cmDir}/src/strategies/autobiographical.ts states the compression output reserve's floor as ${floors.size ? [...floors].join(' and ') : 'nothing found'}: read it and update reservedHeadroom`);
  }
  return { compressionContextBudgetTokens: [...floors][0] };
}

/**
 * Build one configuration in an arm.
 * @param {object} cm the arm's context-manager module
 * @param {string} config C1-C9, or an H configuration as house.json names it (H1.MODEL, H2, H3, H4)
 * @param {object} house house.json
 * @param {string} cmDir the arm's context-manager checkout, for libraryDefaultBudget
 * @param {object} [overrides] options a workload's variant sets on top of the configuration's, before scaling
 * @returns {{ cls, strategy, budget, eager, receipts, sends, options }}
 */
export function buildConfig(cm, config, house, cmDir, overrides = {}) {
  const scaled = scaledBy(SCALE);
  let cls, options, budget;
  if (config.startsWith('H')) {
    const entry = house.configs[config];
    if (!entry) throw new Error(`house.json has no ${config}; it has ${Object.keys(house.configs).join(', ')}`);
    cls = entry.class;
    options = entry.options;
    budget = entry.budget ?? libraryDefaultBudget(cmDir);
  } else {
    ({ cls, options } = libraryOptions(config, house));
    budget = LIBRARY_CONFIG_BUDGET;
  }
  options = { ...options, ...overrides };
  const Strategy = cm[cls];
  if (typeof Strategy !== 'function') throw new Error(`this context-manager exports no ${cls}`);
  const probe = new Strategy(options);
  const passthrough = cls === 'PassthroughStrategy' || cls === 'WindowedPassthroughStrategy';
  const final = scaleOptions(options, resolvedSizes(probe, cls, cmDir), scaled, passthrough ? {} : reservedHeadroom(cmDir));
  const strategy = new Strategy(final);
  return {
    cls,
    strategy,
    options: final,
    // The C configurations keep the strategy lane's 2,048 reserve as it does; a host's reserve is its agent's
    // max_tokens, a size, and scales with the rest.
    budget: { maxTokens: scaled(budget.maxTokens), reserveForResponse: config.startsWith('C') ? budget.reserveForResponse : scaled(budget.reserveForResponse) },
    eager: final.autoTickOnNewMessage === true,
    receipts: final.foldingStrategy === 'kv-unified' && config.startsWith('H'),
    // A host sends its agent's requests and reports each one's real input total (agent-framework's
    // reportRealInputTokens), which feeds the strategy's calibration: the house's compressing configurations do.
    sends: config.startsWith('H') && compresses(config),
  };
}

/** Every configuration a run can name, house ones as house.json names them, by whether they compress. */
export function allConfigs(house) {
  const all = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', ...Object.keys(house.configs).sort()];
  return { compressing: all.filter(compresses), nonCompressing: all.filter((c) => !compresses(c)) };
}
