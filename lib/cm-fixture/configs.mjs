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
// and recency half-life). The compile budget scales too. What doesn't: a size the library defaults inside its code
// rather than in its resolved config, which a strategy's config doesn't show; image ceilings, which count images
// and bytes; and the reserve for a response, which the strategy lane keeps at 2,048.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SCALE = 15;

const KV_UNIFIED_TOKENS = ['tokenBucketSize', 'continuityBucketSize', 'fidelityBucketSize', 'labelCeiling', 'adoptEpsilon'];
const KV_UNIFIED_POLICY_TOKENS = ['cacheScale', 'continuityScale', 'continuityRecencyHalfLifeTokens'];

const scaledBy = (scale) => (v) => (v === 0 ? 0 : Math.max(1, Math.round(v / scale)));

/** The strategy lane's budget (lib/strategies), scaled: the C configurations compile against it. */
export const LIBRARY_CONFIG_BUDGET = { maxTokens: 300_000, reserveForResponse: 2048 };

/** Configurations that compress, and the ones that don't (merged design §5's matrix). */
export const COMPRESSING = ['C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'H1', 'H2'];
export const NON_COMPRESSING = ['C1', 'C2', 'H3', 'H4'];

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

/** A configuration's options with every size its library resolved divided by the scale. */
function scaleOptions(options, resolved, scaled) {
  const out = { ...options };
  for (const [key, value] of Object.entries(resolved ?? {})) {
    if (key.endsWith('Tokens') && typeof value === 'number' && Number.isFinite(value)) out[key] = scaled(value);
  }
  if (options.kvUnified) {
    const kv = { ...options.kvUnified, policy: { ...options.kvUnified.policy } };
    for (const key of KV_UNIFIED_TOKENS) if (typeof kv[key] === 'number') kv[key] = scaled(kv[key]);
    for (const key of KV_UNIFIED_POLICY_TOKENS) if (typeof kv.policy[key] === 'number') kv.policy[key] = scaled(kv.policy[key]);
    out.kvUnified = kv;
  }
  return out;
}

/** The sizes a strategy resolved: its config, and a knowledge strategy's own sizes beside it. */
function resolvedSizes(strategy, cls) {
  if (cls === 'PassthroughStrategy') return {};
  if (cls === 'WindowedPassthroughStrategy') {
    // Its options aren't kept as a config: the two sizes it takes, as it reports them.
    return { maxMessageTokens: strategy.maxMessageTokens ?? 0, imageStripDepthTokens: strategy.imageStripDepthTokens };
  }
  const config = strategy.config;
  if (!config || typeof config !== 'object') throw new Error(`${cls} keeps no config to read its resolved sizes from: read it and update resolvedSizes`);
  return { ...config, ...(strategy.knowledgeConfig ?? {}) };
}

/**
 * Build one configuration in an arm.
 * @param {object} cm the arm's context-manager module
 * @param {string} config C1-C9, or an H configuration as house.json names it (H1.MODEL, H2, H3, H4)
 * @param {object} house house.json
 * @param {string} cmDir the arm's context-manager checkout, for libraryDefaultBudget
 * @param {number} [scale] what every size is divided by: SCALE, or 1 for a run at the host's own sizes
 * @param {object} [overrides] options a workload's variant sets on top of the configuration's, before scaling
 * @returns {{ strategy, budget, eager, receipts, options }}
 */
export function buildConfig(cm, config, house, cmDir, scale = SCALE, overrides = {}) {
  const scaled = scaledBy(scale);
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
  const final = scale === 1 ? options : scaleOptions(options, resolvedSizes(probe, cls), scaled);
  const strategy = new Strategy(final);
  return {
    strategy,
    options: final,
    // The C configurations keep the strategy lane's 2,048 reserve as it does; a host's reserve is its agent's
    // max_tokens, a size, and scales with the rest.
    budget: { maxTokens: scaled(budget.maxTokens), reserveForResponse: config.startsWith('C') ? budget.reserveForResponse : scaled(budget.reserveForResponse) },
    eager: final.autoTickOnNewMessage === true,
    receipts: final.foldingStrategy === 'kv-unified' && config.startsWith('H'),
  };
}

/** Every configuration a check runs, house ones as house.json names them. */
export function allConfigs(house) {
  const h = Object.keys(house.configs).sort();
  return { compressing: [...COMPRESSING.filter((c) => c.startsWith('C')), ...h.filter((c) => c.startsWith('H1') || c === 'H2')], nonCompressing: [...NON_COMPRESSING.filter((c) => c.startsWith('C')), ...h.filter((c) => c === 'H3' || c === 'H4')] };
}
