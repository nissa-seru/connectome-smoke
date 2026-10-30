// The house configurations (H1-H4) for the context-management characterization fixture, captured from a released
// connectome-host's own code rather than copied by hand, so they track the host. Run under bun, after installing the
// release as a consumer would:
//
//   npm install --prefix DIR --ignore-scripts @animalabs/connectome-host@VERSION
//   bun lib/cm-fixture/capture.mjs DIR/node_modules/@animalabs/connectome-host > lib/cm-fixture/house.json
//
// What it records is each configuration's strategy class, the options the host passes its constructor (the
// constructor's 'caller' layer, read through configProvenance), and the compile budget the host gives the agent.
// Each arm of a check then builds its own strategy from those options, so a library default the candidate changes
// still shows. Refresh it after each connectome-host release, as the stores lane's capture is.
//
// - H1, residents: the host's builder (buildFrameworkStrategy) over a recipe naming only a model, once per model
//   the host's shipped recipes run on: the host's default for a resident on that model. The windows, kvUnified's
//   prices and the budget depend on the model, so families whose options and budget come out the same, the
//   compression model aside, are recorded as one, naming the others.
// - H2, knowledge subagents: the subagent module's own agentConfig, given the launch the module builds (its
//   SUBAGENT_STRATEGY with the parent's model as compression model).
// - H3, a passthrough recipe through the host's builder.
// - H4, agent-framework's subconscious: its construction is private to AgentFramework, so its two options are
//   taken from what its source reads (the recipe's subconscious reAnchorFraction, absent in every shipped recipe, and
//   the primary's maxMessageTokens), and the capture refuses when that source no longer reads exactly those.

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';

const hostDir = process.argv[2];
if (!hostDir) throw new Error('usage: bun capture.mjs <installed connectome-host package directory>');
const src = (rel) => join(hostDir, 'src', rel);
const pkg = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
/** An installed package's directory, by node_modules lookup from the host (exports maps hide package.json). */
function resolvePackage(name) {
  for (let dir = realpathSync(hostDir); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) throw new Error(`no ${name} installed above ${hostDir}`);
  }
}

// The subagent module keeps SUBAGENT_STRATEGY to itself; load it with one export added, and nothing else changed.
const SUBAGENT = realpathSync(src('modules/subagent-module.ts'));
Bun.plugin({
  name: 'cm-fixture-capture',
  setup(build) {
    build.onLoad({ filter: /subagent-module\.ts$/ }, ({ path }) => {
      if (realpathSync(path) !== SUBAGENT) return undefined;
      const text = readFileSync(path, 'utf8');
      if (!/\nconst SUBAGENT_STRATEGY = \{/.test(text)) throw new Error(`${path} no longer declares SUBAGENT_STRATEGY: read how it builds a launch's strategy and update the capture`);
      return { contents: `${text}\nexport { SUBAGENT_STRATEGY as __CM_FIXTURE_SUBAGENT_STRATEGY };\n`, loader: 'ts' };
    });
  },
});

const { buildFrameworkStrategy } = await import(src('framework-strategy.ts'));
const { validateRecipe, recipeModel } = await import(src('recipe.ts'));
const { effectiveContextBudgetTokens, effectiveMaxTokens } = await import(src('recipe-fit.ts'));
const subagent = await import(SUBAGENT);

/** The options a strategy's constructor was given, read from the layer it attributes to its caller. */
function callerOptions(strategy) {
  const provenance = strategy.configProvenance;
  if (!provenance) return {};
  const options = {};
  for (const [key, source] of Object.entries(provenance)) if (source === 'caller') options[key] = strategy.config[key];
  return JSON.parse(JSON.stringify(options));
}
const describe = (strategy, budget) => ({ class: strategy.constructor.name, options: callerOptions(strategy), budget });
const NAME = 'Junga';

// H1: the models the shipped recipes run a resident on.
const recipesDir = join(hostDir, 'recipes');
const models = new Map();
for (const file of readdirSync(recipesDir).filter((f) => f.endsWith('.json')).sort()) {
  const raw = JSON.parse(readFileSync(join(recipesDir, file), 'utf8'));
  const type = raw.agent?.strategy?.type ?? 'autobiographical';
  if (type !== 'autobiographical' || (raw.agent?.provider ?? 'anthropic') !== 'anthropic') continue;
  const model = recipeModel(raw, undefined);
  models.set(model, [...(models.get(model) ?? []), file]);
}
const configs = {};
const seen = new Map();
for (const [model, recipes] of [...models].sort()) {
  const recipe = validateRecipe({ name: NAME, agent: { name: NAME, model, systemPrompt: '' } });
  const strategy = buildFrameworkStrategy(recipe, model, 'UTC', undefined, NAME);
  const entry = describe(strategy, { maxTokens: effectiveContextBudgetTokens(recipe, model), reserveForResponse: effectiveMaxTokens(recipe) });
  // The compression model changes which code runs only for a Fable- or Mythos-family model, whose compression the
  // library defers until tools are declared (W7 reaches that by its own setting), so families whose options differ
  // only in it run as one.
  const { compressionModel, ...rest } = entry.options;
  const key = JSON.stringify({ ...entry, options: /fable|mythos/i.test(compressionModel ?? '') ? entry.options : rest });
  const family = `H1.${model}`;
  if (seen.has(key)) {
    configs[seen.get(key)].sameAs.push({ model, recipes });
    continue;
  }
  seen.set(key, family);
  configs[family] = { ...entry, model, recipes, sameAs: [] };
}

// H2: the subagent module's own construction, from the launch it builds.
const SUBAGENT_STRATEGY = subagent.__CM_FIXTURE_SUBAGENT_STRATEGY;
const parentModel = recipeModel(validateRecipe({ name: NAME, agent: { name: NAME, systemPrompt: '' } }), undefined);
const launch = {
  model: parentModel,
  systemPrompt: '',
  maxTokens: 4096,
  maxStreamTokens: 500_000,
  strategy: { ...SUBAGENT_STRATEGY, compressionModel: parentModel },
  allowedTools: 'all',
};
const agentConfig = subagent.SubagentModule.prototype.agentConfig.call({ config: {} }, launch, NAME);
// No contextBudgetTokens in a subagent's agent config, so agent-framework compiles with no budget and
// ContextManager.compile's own default applies: null here, and each arm's library decides it.
configs.H2 = { ...describe(agentConfig.strategy, null), model: parentModel };

// H3: a passthrough recipe through the host's builder.
const passthrough = validateRecipe({ name: NAME, agent: { name: NAME, systemPrompt: '', strategy: { type: 'passthrough' } } });
configs.H3 = describe(buildFrameworkStrategy(passthrough, parentModel, 'UTC', undefined, NAME), {
  maxTokens: effectiveContextBudgetTokens(passthrough, parentModel),
  reserveForResponse: effectiveMaxTokens(passthrough),
});

// H4: agent-framework's subconscious, from what its private construction reads.
const afDir = resolvePackage('@animalabs/agent-framework');
const afSource = readFileSync(join(afDir, 'src/framework.ts'), 'utf8');
const SUBCONSCIOUS = /const strategy = new WindowedPassthroughStrategy\(\{\s*reAnchorFraction: cfg\.reAnchorFraction,\s*(\/\/[^\n]*\n\s*)*maxMessageTokens: primaryConfig\.strategy\?\.maxMessageTokens,\s*\}\);/;
if (!SUBCONSCIOUS.test(afSource)) {
  throw new Error(`${afDir}/src/framework.ts no longer builds the subconscious's WindowedPassthroughStrategy from exactly reAnchorFraction and the primary's maxMessageTokens: read it and update the capture`);
}
const primary = configs[`H1.${parentModel}`] ?? Object.values(configs).find((c) => c.class === 'AutobiographicalStrategy');
configs.H4 = {
  class: 'WindowedPassthroughStrategy',
  options: { maxMessageTokens: primary.options.maxMessageTokens },
  budget: primary.budget,
  from: `agent-framework's createSubconsciousAgent: no shipped recipe sets subconscious.reAnchorFraction; maxMessageTokens is the primary's (${`H1.${parentModel}`})`,
};

const out = {
  host: { name: pkg(hostDir).name, version: pkg(hostDir).version },
  agentFramework: { version: pkg(afDir).version },
  contextManager: { version: pkg(resolvePackage('@animalabs/context-manager')).version },
  configs,
};
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
