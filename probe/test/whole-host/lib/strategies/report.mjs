import { existsSync, readFileSync } from 'node:fs';
import { budgets, compileInvariants, ofSide, pairing, reloads, declaredProducts, everyTurnAnswers, wellFormed, windowsRaw, coverage, bookkeeping, calibrationEdge, FIXTURE_AGENT, STREAM_BOUND } from './checks.mjs';

/**
 * Every check one side's run gives: its flags, the segments missing a declared product, each
 * segment's least budget headroom (checks.mjs budgets), notes (each boot whose budget report
 * said the agent's window, not its stream bound, governs its continuation rounds), and
 * `judged`: each check's count of
 * what it judged, `[{ check, name, judged }]`. Where a check applies to the run and judged none of
 * it, that's a couldn't-judge flag, never a pass: check 3's budgets, where the run's agent made a
 * request; checks 11 and 13, where it did (the module is always on in a judged run); check 12, where
 * the script has a restart with `reloadCheck`. The other checks' counts are reported only.
 * `store` is read-store.mjs's read of the run's final store copy, or null when the configuration
 * keeps no summaries to read. `agent` is the run's agent, whose panel and events the checks read;
 * `side` is which of the stand-in's records are that agent's requests (`primary`, or `sub` for a
 * subagent's), the fixture's agent's being the primary's; checks 4 and 6 judge only those.
 * `streamBound` its stream bound; `windowTokens` the stand-in's window.
 * Checks 4 and 6 apply where the agent made a request (4 with a store read; 6 at a scripted turn after the first, and
 * only for the primary: a subagent's turns aren't the script's, so its windows go uncounted there and
 * check 4 holds its requests to its store).
 */
export function runChecks({ records, log, script, products, store, agent = FIXTURE_AGENT, side = agent === FIXTURE_AGENT ? 'primary' : 'sub', streamBound = STREAM_BOUND, windowTokens }) {
  const own = ofSide(side);
  const budget = budgets(records, script, log, { agent, streamBound, windowTokens });
  const ownRequests = records.filter(own).length;
  // Check 6 holds a request to the two scripted turns before its step's, so it applies to requests at a turn after the first.
  const laterTurns = new Set(script.filter((st) => Array.isArray(st.replies) && st.replies.length).slice(1).map((st) => st.id));
  const turnRequests = records.filter((r) => own(r) && laterTurns.has(r.step)).length;
  const missing = declaredProducts(records, script, products, store);
  const declared = Object.values(products ?? {}).flat().length;
  const parts = [
    { check: 1, name: 'every turn answers', flags: everyTurnAnswers(records, log, script) },
    { check: 2, name: 'declared products', flags: [], judged: missing.judged, applies: declared > 0 ? `the run declares ${declared} product(s)` : null },
    { check: 3, name: 'request shape', flags: wellFormed(records) },
    { check: 3, name: 'budgets', flags: budget.flags, judged: budget.judged, applies: budget.requests > 0 ? `the run's agent made ${budget.requests} request(s)` : null },
    ...(store ? [{ check: 4, name: 'coverage', flags: coverage(records, store, script, log, { agent, side }), applies: ownRequests > 0 ? `a store was read and the run's agent made ${ownRequests} request(s)` : null }] : []),
    ...(store ? [{ check: 5, name: 'bookkeeping', flags: bookkeeping(records, store) }] : []),
    { check: 6, name: 'windows raw', flags: windowsRaw(records, script, log, store, { agent, side }), applies: side === 'primary' && turnRequests > 0 ? `the run's agent made ${turnRequests} request(s) at a scripted turn after the first` : null },
    { check: 10, name: 'calibration edge', flags: calibrationEdge(log) },
    { check: 11, name: 'compile invariants', flags: compileInvariants(log), applies: budget.requests > 0 ? 'the run\'s agent made requests' : null },
    { check: 12, name: 'reloads', flags: reloads(log), applies: script.some((s) => s.reloadCheck) ? 'the script restarts with a reload check' : null },
    { check: 13, name: 'pairing', flags: pairing(records, log, agent), applies: budget.requests > 0 ? 'the run\'s agent made requests' : null },
  ];
  const judged = parts.map((p) => ({ check: p.check, name: p.name, judged: p.judged ?? p.flags.judged ?? null }));
  const unjudged = parts.filter((p) => p.applies && (p.judged ?? p.flags.judged) === 0).map((p) => ({
    check: p.check, step: 'the run', what: `judged-none:${p.name}`,
    message: `couldn't judge: check ${p.check} (${p.name}) judged nothing, though it applies (${p.applies})`,
  }));
  const flags = [...parts.flatMap((p) => p.flags), ...unjudged];
  return { flags, missing, headroom: budget.headroom, notes: budget.notes, judged };
}

// A flag's identity in an expected failure's key and in its failure name: its check, its step, and
// what it names within them, such as an operator alert's kind.
const key = (f) => `${f.check}|${f.step}|${f.what ?? ''}`;

/**
 * The expected failures, from `path` (test/whole-host/expected-failures.json): none when the
 * file isn't there. Each entry is `{ configuration, check, step, what, match?, finding, reason }`
 * and covers the flags of one known finding (`finding`: a public issue where one exists, else
 * a short self-contained name) that a committed run meets: its check, step and `what`, the
 * kind of flag within its check, and, given `match`, a regular expression found in the flag's
 * detail (a check 11 violation's own words, such as "allowing L0") or, for a flag with no
 * detail, its message. An entry covers one kind of flag,
 * so one with no `what` is refused: a check whose flags name no kind can have no entry until
 * they do, since its entry would cover a new loss at that step as the old finding. Entries that
 * share a key each carry a different `match`, since one without would cover the others' flags.
 * Throws, naming the entry, on one that isn't of that shape, names a configuration not in
 * `names`, or repeats or overlaps another.
 */
export function readExpected(path, names) {
  if (!existsSync(path)) return [];
  const entries = JSON.parse(readFileSync(path, 'utf-8'));
  if (!Array.isArray(entries)) throw new Error(`${path} isn't a list of entries`);
  const byKey = new Map();
  entries.forEach((e, i) => {
    const bad = (why) => { throw new Error(`${path} entry ${i}: ${why}`); };
    if (!e || typeof e !== 'object') bad('isn\'t an object');
    for (const field of ['configuration', 'step', 'finding', 'reason']) if (typeof e[field] !== 'string' || !e[field]) bad(`has no ${field}`);
    if (!Number.isInteger(e.check)) bad('has no check number');
    if (typeof e.what !== 'string' || !e.what) bad('has no what: an entry covers one kind of flag, so its check\'s flags must name their kind');
    if (e.match !== undefined) {
      if (typeof e.match !== 'string' || !e.match) bad('has a match that isn\'t text');
      try { new RegExp(e.match); } catch (err) { bad(`has a match that isn't a regular expression: ${err.message}`); }
    }
    if (!names.includes(e.configuration)) bad(`names a configuration this run has none of: ${e.configuration}`);
    const k = `${e.configuration}|${key(e)}`;
    const others = byKey.get(k) ?? [];
    if (others.some((o) => o.match === e.match)) bad(`repeats another entry's configuration, check, step, what and match`);
    if (others.length && (e.match === undefined || others.some((o) => o.match === undefined))) bad('shares its configuration, check, step and what with another entry, and one of them has no match, so it would cover the other\'s flags');
    byKey.set(k, [...others, e]);
  });
  return entries;
}

/**
 * The per-check report: the candidate's flags and missing products. A calibration at a clamp edge makes the run invalid, and the first line says so.
 * `expected` holds the expected failures (expected-failures.json, readExpected): a flag of a
 * named finding a committed run meets, by its key (`check|step|what`) and its `match`, for its
 * configuration. A flag an entry covers doesn't count, and its line names the finding. An entry
 * no flag meets is a flag of its own, since the finding it names no longer shows: the change
 * that fixed it removes the entry.
 * Returns the verdict and lines with what they count: `invalid` (check 10's flags), `flags`
 * (the rest, entries no flag met among them), `expected` (the flags entries cover) and
 * `missing` (`{ segment, name }`, products the candidate lacks).
 */
export function perCheckReport({ configuration, candidate, expected = [] }) {
  const invalid = candidate.flags.filter((f) => f.check === 10);
  const entries = expected.filter((e) => e.configuration === configuration.name).map((e) => ({ e, re: e.match === undefined ? null : new RegExp(e.match) }));
  const coverOf = (f) => entries.filter(({ e, re }) => key(e) === key(f) && (!re || re.test(f.detail ?? f.message ?? '')));
  const counted = candidate.flags.filter((f) => f.check !== 10);
  const covered = [];
  const flags = [];
  const met = new Set();
  for (const f of counted) {
    const by = coverOf(f);
    if (!by.length) { flags.push(f); continue; }
    covered.push({ f, finding: [...new Set(by.map((x) => x.e.finding))].join('; ') });
    for (const x of by) met.add(x);
  }
  for (const x of entries) {
    const { e } = x;
    if (!met.has(x)) flags.push({ check: e.check, step: e.step, what: e.what, message: `expected-failures.json expects a flag here for ${e.finding}${e.match ? ` matching /${e.match}/` : ''}, and the run raised none: if ${e.finding} is fixed, the change that fixed it removes the entry` });
  }
  const missing = candidate.missing.flatMap((m) => m.missing.map((name) => ({ segment: m.segment, name })));
  const verdict = invalid.length ? 'invalid' : flags.length || missing.length ? 'flags' : 'pass';
  const lines = [];
  if (invalid.length) lines.push(`INVALID: ${invalid[0].message}${invalid.length > 1 ? ` (and ${invalid.length - 1} more)` : ''}. Its folds are clamped folds, not a store's.`);
  const findings = [...new Set(covered.map((c) => c.finding))];
  lines.push(`${configuration.name}: ${verdict === 'pass' ? 'no flags' : `${flags.length} flag(s), ${missing.length} missing product(s)`}${covered.length ? `, ${covered.length} expected (${findings.join(', ')})` : ''}.`);
  for (const f of flags) lines.push(`- check ${f.check} at ${f.step}${f.request ? ` (${f.request})` : ''}: ${f.message}`);
  for (const { f, finding } of covered) lines.push(`- check ${f.check} at ${f.step}${f.request ? ` (${f.request})` : ''}: ${f.message} [expected: ${finding}]`);
  for (const m of missing) lines.push(`- check 2, ${m.segment}: missing ${m.name}`);
  for (const n of candidate.notes ?? []) lines.push(`- ${n}`);
  if (candidate.judged?.length) lines.push(`- judged: ${candidate.judged.map((j) => `check ${j.check} ${j.name} ${j.judged ?? '?'}`).join(', ')}`);
  if (candidate.headroom?.length) lines.push(`- budget headroom, each segment's least: ${candidate.headroom.map((h) => `${h.segment} ${h.bound - h.tokens} of ${h.bound}${h.kind === 'continuation' ? ' (a stream\'s fresh input through a continuation round, against the stream bound)' : ' (a compiled request\'s whole input, against the model\'s window)'}`).join(', ')}`);
  return { verdict, lines, invalid, flags, expected: covered.map((c) => c.f), missing };
}

export function workloadReport({ id, workload, owns = [], judged, breaches, completed, expected = [] }) {
  const isOwned = (f) => owns.some((o) => o.check === f.check && (o.what === undefined || o.what === f.what));
  const judgedFlags = judged.flags.filter((f) => !isOwned(f));
  const owned = judged.flags.length - judgedFlags.length;
  const flags = [...judgedFlags, ...breaches.map((b) => ({ check: 14, step: b.step ?? 'the run', ...(b.what ? { what: b.what } : {}), message: `${workload}'s property: ${b.message}` }))];
  const counts = [...(judged.judged ?? []), ...(typeof breaches.judged === 'number' ? [{ check: 14, name: 'property', judged: breaches.judged }] : [])];
  if (completed && breaches.judged === 0 && !breaches.length) flags.push({ check: 14, step: 'the run', what: 'judged-none:property', message: `couldn't judge: ${workload}'s property judged nothing, though the run completed` });
  const notes = [...(judged.notes ?? []), ...(owned ? [`${owned} flag(s) are ${workload}'s by design, judged by its property (runOf owns)`] : [])];
  return perCheckReport({ configuration: { name: id }, candidate: { flags, missing: judged.missing ?? [], notes, headroom: judged.headroom, judged: counts }, expected });
}
