/**
 * Would a resident stepping from one host release to another have its prompt cache
 * written anew? lanes/cache-write.mjs answers it from the stored fixtures: it boots each
 * release on a copy of each fixture's store, takes one turn (lib/stores.mjs, checkStores),
 * and compares what the two releases' requests carry before that turn's first message.
 *
 * That part of a request is what a cache read can match: the API reads a cached prefix
 * back only where every byte before the breakpoint is the same, for the same model, and
 * the turn's text carries a per-run nonce, so no stored message carries it, and everything
 * from its first carrier on is this turn's own. Settings the API renders into the prompt
 * count too. Its prompt-caching guide's "What invalidates the cache" says how far each
 * kind of change reaches, and cacheReach follows it: a tool's definition the whole cache;
 * the system prompt, `speed` or citations turned on or off the system prompt's and the
 * messages'; `tool_choice` and images present or not the messages'; the thinking
 * configuration and `output_config.effort` the messages', and on some models the tools'
 * and system prompt's too. A change of model is the whole cache by the check's own rule,
 * since a cache is kept per model. Images and citations count wherever the request's
 * messages hold them, the turn's own included, by whether any is there, as the guide's
 * rows read: "Adding/removing images anywhere in the prompt", "Enabling/disabling
 * citations". The guide doesn't place the request's API version or betas, or any other
 * setting: a fixture that differs only there is one the check can't tell for. A web
 * search toggle shows as a tools change, which the line gives the whole cache, wider than
 * the guide's system prompt's and messages': the safe side.
 *
 * Two kinds of change are ones the check can't tell for. A cache marker (`cache_control`,
 * on a block or a tool, or the request's own for automatic caching) writes "a hash of the
 * prefix ending at that block", and in the guide's lookback example a later request with
 * no marker on that block reads the entry, so the marker that ended an entry isn't in its
 * hash. Where markers sit says where entries are written and looked up, so what moving any
 * marker costs depends on where earlier requests wrote, which one pair of requests can't
 * show: the prefix is compared without them, and their places and values are a part of
 * their own. And "setting effort explicitly to the model's default is equivalent to
 * omitting it", so an effort given on one side only is one the check can't tell for, not
 * knowing the model's default.
 *
 * So two releases that send the same prefix for the same stored conversation read each
 * other's cache, and each part where they differ (differingParts) says what a stepping
 * resident writes again. Key order counts in what the API takes as given: a reordered
 * object is sent as other bytes, and the same guide warns that reordered keys in a
 * `tool_use` block break the cache. The settings, which the API renders in its own format,
 * are compared with their keys sorted, and so are the markers, by place and value, since
 * only where a marker sits and what it asks for count. JSON.parse already puts
 * integer-like keys in numeric order, so their sent order is out of reach here. Node's own
 * modules only.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Request fields that shape the answer, not the prompt, so no cache read depends on them. */
const ANSWER_ONLY = new Set(['max_tokens', 'stream', 'metadata', 'temperature', 'top_p', 'top_k', 'stop_sequences']);

/** A value with its objects' keys sorted, at every depth. */
function sorted(v) {
  if (Array.isArray(v)) return v.map(sorted);
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]));
}

/** Each block in `content` and every object inside one, at any depth (a tool result's
 *  content, a document's source, a web fetch's document), but not a tool call's input,
 *  which is the model's own data. */
function* blocks(v) {
  if (Array.isArray(v)) { for (const x of v) yield* blocks(x); return; }
  if (v === null || typeof v !== 'object') return;
  yield v;
  for (const [key, x] of Object.entries(v)) {
    if (!(key === 'input' && typeof v.type === 'string' && v.type.endsWith('tool_use'))) yield* blocks(x);
  }
}

/** Whether any message's content holds a block `is` matches. */
const anyBlock = (messages, is) => messages.some((m) => [...blocks(m?.content)].some(is));

/** A block with citations on: a document's or search result's own setting, not a reply's
 *  list of the citations it made. */
const citing = (b) => b.citations !== null && typeof b.citations === 'object' && !Array.isArray(b.citations) && b.citations.enabled === true;

/** `v` without its cache markers, each put in `marks` under its place with its keys sorted,
 *  since only where a marker sits and what it asks for count: `cache_control` on any
 *  object in a system prompt or a message, but not inside a tool call's input, which is
 *  the model's own data. Each key is defined as the object's own, so even `__proto__`
 *  stays data. */
function unmarked(v, path, marks) {
  if (Array.isArray(v)) return v.map((x, i) => unmarked(x, element(path, i, x), marks));
  if (!isObject(v)) return v;
  const out = {};
  for (const [key, x] of Object.entries(v)) {
    if (key === 'cache_control') { marks[path] = sorted(x); continue; }
    const value = key === 'input' && typeof v.type === 'string' && v.type.endsWith('tool_use') ? x : unmarked(x, at(path, key), marks);
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** The tools without their markers: a tool's marker is its own `cache_control`, put in
 *  `marks` under the tool's place, and the rest of its definition is kept whole. */
function unmarkedTools(tools, marks) {
  if (!Array.isArray(tools)) return tools ?? null;
  return tools.map((t, i) => {
    if (!isObject(t) || !Object.hasOwn(t, 'cache_control')) return t;
    marks[element('tools', i, t)] = sorted(t.cache_control);
    return Object.fromEntries(Object.entries(t).filter(([key]) => key !== 'cache_control'));
  });
}

/**
 * A recorded request's cached prefix: the model, the tools, the system prompt, `settings`
 * (every other field but those that shape only the answer, keys sorted, so a setting the
 * API adds is compared before anyone lists it), every message before the first that
 * carries `text`, whether any message holds an image and whether any has citations on (a
 * document or a search result; the guide's rules for both are toggles, counted anywhere
 * in the prompt, the turn's own messages included), the cache markers, by place, the
 * turn's own messages' included, and last the request's API version and betas, which the
 * guide doesn't place. The tools, system prompt and messages are kept without their
 * markers.
 */
export function cachedPrefix(request, text) {
  const body = request?.body ?? {};
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const own = raw.findIndex((m) => JSON.stringify(m).includes(text));
  const marks = body.cache_control === undefined ? {} : { automatic: sorted(body.cache_control) };
  const tools = unmarkedTools(body.tools, marks);
  const system = unmarked(body.system ?? null, 'system', marks);
  const messages = unmarked(raw, 'messages', marks);
  const settings = sorted(Object.fromEntries(Object.entries(body)
    .filter(([key]) => !['model', 'tools', 'system', 'messages', 'cache_control'].includes(key) && !ANSWER_ONLY.has(key))));
  return {
    model: body.model ?? null,
    tools,
    system,
    settings,
    messages: own >= 0 ? messages.slice(0, own) : messages,
    images: anyBlock(raw, (b) => b.type === 'image'),
    citations: anyBlock(raw, citing),
    markers: sorted(marks),
    'anthropic-version': request?.headers?.['anthropic-version'] ?? null,
    'anthropic-beta': request?.headers?.['anthropic-beta'] ?? null,
  };
}

const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const at = (path, key) => (/^[A-Za-z_$][\w$-]*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`);
const isObject = (v) => kind(v) === 'object';

/** An array element's place in a path, with its name where it has one, as a tool does:
 *  the base's, or the candidate's where only it has one. */
const element = (path, i, ...sides) => {
  const name = sides.map((v) => v?.name).find((n) => typeof n === 'string');
  return `${path}[${i}${name === undefined ? '' : `:${name}`}]`;
};

/**
 * The first place two values differ, walking them in order: `{ path, base, candidate }`,
 * with each side's value there (undefined where it has none), or null when they're the
 * same. Where both are strings, `offset` is where the first character that differs starts,
 * in UTF-16 units. Objects are compared key by key in their order, so a reordered object
 * differs at the first key out of place, and `path` then ends in `(key order)`. An array
 * element with a `name`, such as a tool, is named in the path: `tools[11:channel_open]`.
 */
export function firstDifference(base, candidate, path = '') {
  if (Object.is(base, candidate)) return null;
  const kb = kind(base);
  if (kb === 'string' && kind(candidate) === 'string') {
    let offset = 0;
    while (base[offset] === candidate[offset]) offset++;
    // Back to the start of a character whose two halves the strings split between them.
    const unit = base.charCodeAt(offset - 1);
    if (unit >= 0xd800 && unit <= 0xdbff) offset--;
    return { path, base, candidate, offset };
  }
  if (kb !== kind(candidate) || (kb !== 'object' && kb !== 'array')) return { path, base, candidate };
  if (kb === 'array') {
    for (let i = 0; i < Math.max(base.length, candidate.length); i++) {
      const d = firstDifference(base[i], candidate[i], element(path, i, base[i], candidate[i]));
      if (d) return d;
    }
    return null;
  }
  const keysB = Object.keys(base);
  const keysC = Object.keys(candidate);
  for (let i = 0; i < Math.max(keysB.length, keysC.length); i++) {
    const [b, c] = [keysB[i], keysC[i]];
    if (b !== c) {
      if (b !== undefined && !Object.hasOwn(candidate, b)) return { path: at(path, b), base: base[b], candidate: undefined };
      if (c !== undefined && !Object.hasOwn(base, c)) return { path: at(path, c), base: undefined, candidate: candidate[c] };
      return { path: `${path} (key order)`, base: keysB, candidate: keysC };
    }
    const d = firstDifference(base[b], candidate[b], at(path, b));
    if (d) return d;
  }
  return null;
}

/** Where differingParts splits a prefix into parts with a reach of their own. */
const SPLIT = new Set(['', 'settings', 'settings.output_config', 'markers']);

/**
 * The tools' parts, a side without tools counting as none: by name when every tool on
 * both sides has a name of its own, so a tool added, removed or changed is named as such,
 * at its place on the side that has it, and tools kept but reordered are one part,
 * `tools (order)`; by place otherwise.
 */
function toolParts(base, candidate) {
  const [b, c] = [base ?? [], candidate ?? []];
  const names = (list) => list.map((t) => t?.name);
  const named = (list) => names(list).every((n) => typeof n === 'string') && new Set(names(list)).size === list.length;
  const parts = [];
  if (named(b) && named(c)) {
    for (const name of new Set([...names(c), ...names(b)])) {
      const [i, j] = [names(b).indexOf(name), names(c).indexOf(name)];
      const d = firstDifference(b[i], c[j], `tools[${j >= 0 ? j : i}:${name}]`);
      if (d) parts.push(d);
    }
    const [kept, keptAfter] = [names(b).filter((n) => names(c).includes(n)), names(c).filter((n) => names(b).includes(n))];
    // From the first kept tool out of place, so the moved names lead the excerpt.
    const k = kept.findIndex((n, i) => n !== keptAfter[i]);
    if (k >= 0) parts.push({ path: 'tools (order)', base: kept.slice(k), candidate: keptAfter.slice(k) });
    return parts;
  }
  for (let i = 0; i < Math.max(b.length, c.length); i++) {
    const d = firstDifference(b[i], c[i], element('tools', i, b[i], c[i]));
    if (d) parts.push(d);
  }
  return parts;
}

/**
 * Every part where two prefixes differ, each by its first difference, in the prefix's
 * order: the prefix splits into its keys, its settings into theirs, `output_config` into
 * its own, and the tools into each tool (toolParts), so a change in one part can't hide a
 * change of wider reach in another, and each changed tool is named. A side without a part
 * counts as an empty one, and where splitting finds nothing the whole part's difference
 * stands.
 */
export function differingParts(base, candidate, path = '') {
  const whole = firstDifference(base, candidate, path);
  if (!whole) return [];
  if (path === 'tools' && [base, candidate].every((v) => v == null || Array.isArray(v))) {
    const parts = toolParts(base, candidate);
    return parts.length ? parts : [whole];
  }
  const splits = SPLIT.has(path) && [base, candidate].every((v) => v === undefined || isObject(v));
  if (!splits) return [whole];
  const [b, c] = [base ?? {}, candidate ?? {}];
  const parts = [...new Set([...Object.keys(b), ...Object.keys(c)])].flatMap((key) => differingParts(b[key], c[key], at(path, key)));
  return parts.length ? parts : [whole];
}

/** The three runs compareRuns takes, by the names the lane gives them. */
export const RUNS = ['base-1', 'base-2', 'candidate'];

/**
 * Each fixture's verdict from three runs of checkStores, the base release twice and the
 * candidate once (each a list of `{ version, ok, sent }`), for every fixture any run has:
 * - `same`: the candidate sends the base's prefix;
 * - `differs`: it doesn't; `parts` lists each part where it differs, and `difference` is
 *   the first of them;
 * - `unplaced`: it differs only in parts whose reach the check can't tell (`parts`): ones
 *   the caching guide doesn't place, cache markers, and an effort on one side only;
 * - `noise`: the base's own two runs differ, anywhere in the prefix, at `difference`, so
 *   a difference from the candidate couldn't be told from noise;
 * - `not run`: `missing` names the runs with no result for it, and `absent` those of them
 *   that never ran it, as against a step that failed. Without the base's two runs a
 *   difference can't be told from noise, so a fixture is judged only with all three.
 * `expected` names the fixtures the lane set out to check, so one no run has still gets
 * a verdict.
 */
export function compareRuns(base1, base2, candidate, expected = []) {
  const runs = [base1, base2, candidate].map((rs) => new Map(rs.map((r) => [r.version, r])));
  const versions = [...new Set([...expected, ...[base1, base2, candidate].flatMap((rs) => rs.map((r) => r.version))])];
  return versions.map((version) => {
    const results = runs.map((byVersion) => byVersion.get(version));
    const missing = RUNS.filter((_, i) => !(results[i]?.ok && results[i].sent));
    if (missing.length) return { version, verdict: 'not run', missing, absent: RUNS.filter((_, i) => !results[i]) };
    const [p1, p2, pc] = results.map((r) => cachedPrefix(r.sent.request, r.sent.text));
    const noise = firstDifference(p1, p2);
    if (noise) return { version, verdict: 'noise', difference: noise };
    const parts = differingParts(p1, pc);
    if (!parts.length) return { version, verdict: 'same' };
    const verdict = parts.every(untellable) ? 'unplaced' : 'differs';
    return { version, verdict, difference: parts[0], parts };
  });
}

/** The lane's exit status for its verdicts: 1 when any fixture shows a write, whatever
 *  the others show; else 2 when there are none or any couldn't be told; else 0. */
export function exitFor(verdicts) {
  if (verdicts.some((v) => v.verdict === 'differs')) return 1;
  return !verdicts.length || verdicts.some((v) => v.verdict !== 'same') ? 2 : 0;
}

/**
 * What the lane installs for each release, and as of when. A spec that names a path (as
 * `file:`, from `/`, `./` or `../`, or a packed `.tgz`), or names one that exists here, is
 * made absolute whether or not it exists, since npm would resolve it against the install
 * directory; npm then fails naming the path the cutter meant. A URL is left as given, and
 * so is a scheme after a package's name, `name@file:` included: npm resolves those. The
 * base installs as npm's `before` filter takes `baseBefore` when given, else the lane's
 * start, and the candidate as of the lane's start. That filter takes only versions
 * published by then, and reads dist-tags as they stand now.
 */
export function installSpecs({ base, candidate, baseBefore, startedAt, cwd = process.cwd(), exists = existsSync }) {
  const local = (spec) => {
    if (!spec) return spec;
    const file = spec.startsWith('file:');
    const raw = file ? spec.slice('file:'.length) : spec;
    // A URL, a tarball's or a git one, bare or after a package's name, is npm's to fetch as given.
    if (!file && /(^|@)[a-z][a-z0-9+.-]*:/i.test(raw)) return spec;
    const path = resolve(cwd, raw);
    const named = file || /^\.{0,2}\//.test(raw) || /\.(tgz|tar\.gz)$/.test(raw);
    return named || exists(path) ? `${file ? 'file:' : ''}${path}` : spec;
  };
  return { base: { spec: local(base), before: baseBefore ?? startedAt }, candidate: { spec: local(candidate), before: startedAt } };
}

/**
 * After the lane exits: a workdir the lane made (none named, no --keep) loses everything
 * but the paths in `keep`, its report and summary, when the exit code is 0, and goes when
 * nothing is left; any other workdir, or exit, is left whole.
 */
export function cleanupWorkdir({ code, work, made, keep = [] }) {
  if (code !== 0 || !made) return;
  for (const entry of readdirSync(work)) {
    const path = join(work, entry);
    if (!keep.includes(path)) rmSync(path, { recursive: true, force: true });
  }
  if (!readdirSync(work).length) rmSync(work, { recursive: true, force: true });
}

/** What the check covers, for every line it writes. */
export const CACHE_CHECK_LIMIT = "one recipe: claude-sonnet-4-5 on the anthropic provider with its default formatter, heartbeat-mcpl as the only MCPL server and the same heartbeat-mcpl for both releases, and subagents, lessons, retrieval, wake and workspace off";

/** Whether `path` is `prefix` or a place inside it. */
const under = (path, prefix) => path === prefix || ['.', '[', ' '].some((c) => path.startsWith(prefix + c));
const SYSTEM_REACH = "the system prompt's cache and the messages'";
// The reaches the check can't tell: a part the guide doesn't place, the cache markers,
// and an effort given on one side only.
const UNPLACED = "a part of the request the caching guide doesn't place";
const MARKERS = "where entries are written and looked up, which one pair of requests can't show";
const EFFORT_ONE_SIDE = "none if it's the model's default, which the check doesn't know";
const UNTOLD = new Set([UNPLACED, MARKERS, EFFORT_ONE_SIDE]);

/** What a difference at `path` writes again: by the caching guide's table, but for a change
 *  of model, the whole cache by the check's own rule, since a cache is kept per model, and
 *  for the markers, and any part the table doesn't place, a reach the check can't tell. */
export function cacheReach(path) {
  if (under(path, 'markers')) return MARKERS;
  if (under(path, 'model')) return 'the whole cache, which is kept per model';
  if (under(path, 'tools')) return 'the whole cache';
  if (under(path, 'system') || under(path, 'settings.speed') || under(path, 'citations')) return SYSTEM_REACH;
  if (under(path, 'settings.tool_choice') || under(path, 'images')) return "the messages' cache";
  if (under(path, 'settings.thinking') || under(path, 'settings.output_config.effort')) {
    return "the messages' cache, and on some models the tools' and the system prompt's too";
  }
  if (under(path, 'messages')) return "the messages' cache from that message on";
  return UNPLACED;
}

/** A part's reach: cacheReach's, but for an effort given on one side only, which writes
 *  nothing when it's the model's default. */
export function partReach(part) {
  const oneSide = (part.base === undefined) !== (part.candidate === undefined);
  return under(part.path, 'settings.output_config.effort') && oneSide ? EFFORT_ONE_SIDE : cacheReach(part.path);
}

/** Whether the check can't tell what a part's difference writes again. */
const untellable = (part) => UNTOLD.has(partReach(part));

/** The prefix's parts in its order, for ordering a line's places. */
const ORDER = ['model', 'tools', 'system', 'settings', 'messages', 'images', 'citations', 'markers', 'anthropic-version', 'anthropic-beta'];
const rank = (path) => { const i = ORDER.findIndex((part) => under(path, part)); return i < 0 ? ORDER.length : i; };

/** A value at a difference, short enough for a line. */
export function excerpt(v, max = 160) {
  const s = v === undefined ? '(none)' : JSON.stringify(v);
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max).join('')}… (${chars.length} chars)` : s;
}

/**
 * One line for a fixture's difference: where it is, and each side's value there, from a
 * little before the first character that differs where both are strings, saying how many
 * characters come before it.
 */
export function differenceLine(d, other = 'candidate') {
  if (d.offset === undefined) return `${d.path}: base ${excerpt(d.base)}, ${other} ${excerpt(d.candidate)}`;
  const before = [...d.base.slice(0, d.offset)].length;
  const from = Math.max(0, before - 20);
  const side = (s) => { const chars = [...s]; return excerpt(`${from > 0 ? '…' : ''}${chars.slice(from, from + 100).join('')}${chars.length > from + 100 ? '…' : ''}`); };
  return `${d.path}, after ${before} character${before === 1 ? '' : 's'}: base ${side(d.base)}, ${other} ${side(d.candidate)}`;
}

/** The runs, as a release's notes would say them. */
const RUN_NAMES = { 'base-1': "the base's first run", 'base-2': "the base's second run", candidate: "the candidate's run" };

/** Names joined as a sentence reads them. */
const listed = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** A fixture the check couldn't tell for, and why, in a line's words. */
function untold(v) {
  if (v.verdict === 'noise') return `${v.version}, whose base's own two runs differ at ${v.difference.path}`;
  if (v.verdict === 'unplaced') return `${v.version}, which differs only at ${listed(v.parts.map((p) => p.path))}, where the check can't tell what is written again`;
  const failed = v.missing.filter((r) => !v.absent?.includes(r));
  const why = [
    ...(failed.length ? [`whose stores step failed in ${listed(failed.map((r) => RUN_NAMES[r]))}`] : []),
    ...(v.absent?.length ? [`which ${listed(v.absent.map((r) => RUN_NAMES[r]))} never ran`] : []),
  ];
  return `${v.version}, ${why.join(', and ')}`;
}

/**
 * Where a write's fixtures differ, for the line: each reach the differences have, in the
 * prefix's order, with up to two of the places that have it and how many more, so no
 * reach is left out; each fixture's step names every place.
 */
function places(differs) {
  // A place can have more than one reach across fixtures, as an effort can, so each pair counts.
  const pairs = new Map();
  for (const p of differs.flatMap((v) => v.parts)) pairs.set(`${partReach(p)}\n${p.path}`, [partReach(p), p.path]);
  const byReach = new Map();
  for (const [reach, path] of [...pairs.values()].sort((a, b) => rank(a[1]) - rank(b[1]))) byReach.set(reach, [...(byReach.get(reach) ?? []), path]);
  return [...byReach].map(([reach, at]) => `${at.slice(0, 2).join(', ')}${at.length > 2 ? ` and ${at.length - 2} more` : ''} (${reach})`).join('; ');
}

/**
 * A fixture's verdict as the lane's step for it: `ok` when its requests are the same; a
 * write found fails, naming where it first differs and every other part that differs;
 * anything the check couldn't tell for is `infra`, saying why.
 */
export function verdictStep(v) {
  if (v.verdict === 'same') return { ok: true, message: 'the same prefix' };
  if (v.verdict === 'differs') {
    // The write is a part the guide places; any others follow it.
    const lead = v.parts.find((p) => !untellable(p)) ?? v.parts[0];
    const rest = v.parts.filter((p) => p !== lead);
    const also = rest.length ? `; it also differs at ${rest.map((p) => p.path).join(', ')}` : '';
    return { ok: false, infra: false, message: `a write, at ${differenceLine(lead)}${also}` };
  }
  if (v.verdict === 'noise') return { ok: false, infra: true, message: `couldn't tell: the base's own two runs differ at ${differenceLine(v.difference, 'its second run')}` };
  if (v.verdict === 'unplaced') return { ok: false, infra: true, message: `couldn't tell: it differs only where the check can't tell what is written again, at ${v.parts.map((p) => `${differenceLine(p)} (${partReach(p)})`).join('; ')}` };
  const failed = v.missing.filter((r) => !v.absent.includes(r));
  return { ok: false, infra: true, message: `couldn't tell: no result in ${v.missing.join(', ')}${failed.length ? ` (the stores step in ${failed.join(', ')} says why)` : ''}${v.absent.length ? `; ${v.absent.join(', ')} never ran it` : ''}` };
}

/**
 * The cache line for a release's notes, from compareRuns' verdicts. A write found in any
 * fixture leads it: every reach the differences have, with their places (places), and the
 * fixtures the check couldn't tell for. Otherwise, with any fixture it couldn't tell for,
 * or none at all, it says it couldn't tell, naming each and why. Only when every fixture
 * is the same does it say none found.
 */
export function cacheLine(verdicts) {
  const n = verdicts.length;
  const differs = verdicts.filter((v) => v.verdict === 'differs');
  const unsure = verdicts.filter((v) => v.verdict !== 'same' && v.verdict !== 'differs');
  const unsureText = unsure.map(untold).join('; ');
  if (differs.length) {
    const couldNot = unsure.length ? ` It couldn't tell for ${unsure.length}: ${unsureText}.` : '';
    return `Cache: a write found in ${differs.length} of the ${n} fixtures' requests (${CACHE_CHECK_LIMIT}), where they differ at ${places(differs)}.${couldNot}`;
  }
  if (!n || unsure.length) return `Cache: couldn't tell, for ${unsure.length} of the ${n} fixtures (${unsureText || 'no fixtures'}).`;
  return `Cache: none found in the ${n} fixtures' requests (${CACHE_CHECK_LIMIT}).`;
}
