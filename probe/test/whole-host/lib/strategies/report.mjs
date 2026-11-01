import { existsSync, readFileSync } from 'node:fs';
import { budgets, compileInvariants, pairing, primary, reloads, declaredProducts, everyTurnAnswers, wellFormed, windowsRaw, coverage, bookkeeping, calibrationEdge, FIXTURE_AGENT, STREAM_BOUND } from './checks.mjs';

/**
 * Every check one side's run gives: its flags, the segments missing a declared product, each
 * segment's least budget headroom (checks.mjs budgets), notes (each settle at which the host
 * reported no deferred-write count, and each boot whose budget report said the agent's window,
 * not its stream bound, governs its continuation rounds), and `judged`: each check's count of
 * what it judged, `[{ check, name, judged }]`. Where a check applies to the run and judged none of
 * it, that's a couldn't-judge flag, never a pass: check 3's budgets, where the run's agent made a
 * request; checks 11 and 13, where it did with the test module on (`moduleOn`); check 12, where
 * the script has a restart with `reloadCheck`. The other checks' counts are reported only.
 * `store` is read-store.mjs's read of the run's final store copy, or null when the configuration
 * keeps no summaries to read. `agent` is the run's agent, whose panel and events the checks read;
 * `streamBound` its stream bound; `windowTokens` the stand-in's window.
 */
export function runChecks({ records, log, script, products, store, agent = FIXTURE_AGENT, streamBound = STREAM_BOUND, windowTokens, moduleOn = true }) {
  const budget = budgets(records, script, log, { agent, streamBound, windowTokens });
  // Checks 4 and 6 judge the run's own agent's requests: 4 each one, when a store was read; 6 each one at a scripted turn.
  const ownRequests = records.filter(primary).length;
  const turnSteps = new Set(script.filter((st) => Array.isArray(st.replies) && st.replies.length).map((st) => st.id));
  const turnRequests = records.filter((r) => primary(r) && turnSteps.has(r.step)).length;
  const parts = [
    { check: 1, name: 'every turn answers', flags: everyTurnAnswers(records, log, script) },
    { check: 3, name: 'request shape', flags: wellFormed(records) },
    { check: 3, name: 'budgets', flags: budget.flags, judged: budget.judged, applies: budget.requests > 0 ? `the run's agent made ${budget.requests} request(s)` : null },
    ...(store ? [{ check: 4, name: 'coverage', flags: coverage(records, store, script, log, { agent }), applies: ownRequests > 0 ? `a store was read and the run's agent made ${ownRequests} request(s)` : null }] : []),
    ...(store ? [{ check: 5, name: 'bookkeeping', flags: bookkeeping(records, store) }] : []),
    { check: 6, name: 'windows raw', flags: windowsRaw(records, script, log, store, { agent }), applies: turnRequests > 0 ? `the run's agent made ${turnRequests} request(s) at a scripted turn` : null },
    { check: 10, name: 'calibration edge', flags: calibrationEdge(log) },
    { check: 11, name: 'compile invariants', flags: compileInvariants(log), applies: moduleOn && budget.requests > 0 ? 'the test module was on and the run\'s agent made requests' : null },
    { check: 12, name: 'reloads', flags: reloads(log), applies: script.some((s) => s.reloadCheck) ? 'the script restarts with a reload check' : null },
    { check: 13, name: 'pairing', flags: pairing(records, log, agent), applies: moduleOn && budget.requests > 0 ? 'the test module was on and the run\'s agent made requests' : null },
  ];
  const judged = parts.map((p) => ({ check: p.check, name: p.name, judged: p.judged ?? p.flags.judged ?? null }));
  const unjudged = parts.filter((p) => p.applies && (p.judged ?? p.flags.judged) === 0).map((p) => ({
    check: p.check, step: 'the run', what: `judged-none:${p.name}`,
    message: `couldn't judge: check ${p.check} (${p.name}) judged nothing, though it applies (${p.applies})`,
  }));
  const flags = [...parts.flatMap((p) => p.flags), ...unjudged];
  const notes = [
    ...log.filter((e) => e.kind === 'settle' && e.phase === 'end' && e.deferredWritesReported === false).map((e) => `the host reported no deferred-write count at ${e.step}'s settle`),
    ...budget.notes,
  ];
  return { flags, missing: declaredProducts(records, script, products, store), headroom: budget.headroom, notes, judged };
}

// A flag's identity in the base comparison and in its failure name: its check, its step, and
// what it names within them, such as an operator alert's kind.
const key = (f) => `${f.check}|${f.step}|${f.what ?? ''}`;

/**
 * The expected failures, from `path` (test/whole-host/expected-failures.json): none when the
 * file isn't there. Each entry is `{ configuration, check, step, what, finding, reason }`,
 * `what` where the flag names one; an entry goes in only when a committed run meets a named
 * finding (a register entry, such as D1). Throws, naming the entry, on one that isn't of
 * that shape, names a configuration not in `names`, or repeats another's key.
 */
export function readExpected(path, names) {
  if (!existsSync(path)) return [];
  const entries = JSON.parse(readFileSync(path, 'utf-8'));
  if (!Array.isArray(entries)) throw new Error(`${path} isn't a list of entries`);
  const seen = new Set();
  entries.forEach((e, i) => {
    const bad = (why) => { throw new Error(`${path} entry ${i}: ${why}`); };
    if (!e || typeof e !== 'object') bad('isn\'t an object');
    for (const field of ['configuration', 'step', 'finding', 'reason']) if (typeof e[field] !== 'string' || !e[field]) bad(`has no ${field}`);
    if (!Number.isInteger(e.check)) bad('has no check number');
    if (e.what !== undefined && typeof e.what !== 'string') bad('has a what that isn\'t text');
    if (!names.includes(e.configuration)) bad(`names a configuration this run has none of: ${e.configuration}`);
    const k = `${e.configuration}|${key(e)}`;
    if (seen.has(k)) bad(`repeats another entry's configuration, check, step and what`);
    seen.add(k);
  });
  return entries;
}

/**
 * The per-check report: the candidate's flags and missing products, and, where the
 * candidate failed something and the base ran, whether the base fails it too. A product
 * the base didn't produce either means the segment didn't run, and counts against
 * no one. A calibration at a clamp edge makes the run invalid, and the first line says so.
 * `expected` holds the expected failures (expected-failures.json, readExpected): a flag of a
 * named finding a committed run meets, by its key (`check|step|what`), for its configuration.
 * A flag an entry covers doesn't count, and its line names the finding. An entry no flag
 * meets is a flag of its own, since the finding it names no longer shows: the change that
 * fixed it removes the entry.
 * Returns the verdict and lines with what they count: `invalid` (check 10's flags), `flags`
 * (the rest, entries no flag met among them), `expected` (the flags entries cover), `missing`
 * (`{ segment, name }`, products the candidate lacks and the base, if it ran, produced) and
 * `didntRun` (products neither side produced).
 */
export function perCheckReport({ configuration, candidate, base = null, timing = {}, expected = [] }) {
  const invalid = candidate.flags.filter((f) => f.check === 10);
  const baseFlags = new Set((base?.flags ?? []).map(key));
  const baseMissing = new Map((base?.missing ?? []).map((m) => [m.segment, new Set(m.missing)]));
  const entries = new Map(expected.filter((e) => e.configuration === configuration.name).map((e) => [key(e), e]));
  const counted = candidate.flags.filter((f) => f.check !== 10);
  const covered = counted.filter((f) => entries.has(key(f)));
  const flags = counted.filter((f) => !entries.has(key(f)));
  const met = new Set(covered.map(key));
  for (const e of entries.values()) {
    if (!met.has(key(e))) flags.push({ check: e.check, step: e.step, ...(e.what ? { what: e.what } : {}), message: `expected-failures.json expects a flag here for ${e.finding}, and the run raised none: if ${e.finding} is fixed, the change that fixed it removes the entry` });
  }
  const missing = [];
  const didntRun = [];
  for (const m of candidate.missing) {
    for (const name of m.missing) {
      if (base && baseMissing.get(m.segment)?.has(name)) didntRun.push({ segment: m.segment, name });
      else missing.push({ segment: m.segment, name });
    }
  }
  const verdict = invalid.length ? 'invalid' : flags.length || missing.length ? 'flags' : 'pass';
  const when = [
    timing.wallMs !== undefined ? `${(timing.wallMs / 1000).toFixed(1)} s` : null,
    timing.load !== undefined ? `load ${timing.load}` : null,
    timing.timerLive ? 'the 5 s maintenance timer was live' : null,
  ].filter(Boolean).join(', ');
  const lines = [];
  if (invalid.length) lines.push(`INVALID: ${invalid[0].message}${invalid.length > 1 ? ` (and ${invalid.length - 1} more)` : ''}. Its folds are clamped folds, not a store's.`);
  const findings = [...new Set(covered.map((f) => entries.get(key(f)).finding))];
  lines.push(`${configuration.name}: ${verdict === 'pass' ? 'no flags' : `${flags.length} flag(s), ${missing.length} missing product(s)`}${covered.length ? `, ${covered.length} expected (${findings.join(', ')})` : ''}${base ? ', with the base run beside it' : ''}${when ? ` (${when})` : ''}.`);
  for (const f of flags) lines.push(`- check ${f.check} at ${f.step}${f.request ? ` (${f.request})` : ''}: ${f.message}${base ? (baseFlags.has(key(f)) ? ' [base too]' : ' [not on base]') : ''}`);
  for (const f of covered) lines.push(`- check ${f.check} at ${f.step}${f.request ? ` (${f.request})` : ''}: ${f.message} [expected: ${entries.get(key(f)).finding}]`);
  for (const m of missing) lines.push(`- check 2, ${m.segment}: missing ${m.name}${base ? ' [the base produced it]' : ''}`);
  for (const m of didntRun) lines.push(`- ${m.segment} didn't run: neither side produced ${m.name}`);
  for (const n of candidate.notes ?? []) lines.push(`- ${n}`);
  if (candidate.judged?.length) lines.push(`- judged: ${candidate.judged.map((j) => `check ${j.check} ${j.name} ${j.judged ?? '?'}`).join(', ')}`);
  if (candidate.headroom?.length) lines.push(`- budget headroom, each segment's least: ${candidate.headroom.map((h) => `${h.segment} ${h.bound - h.tokens} of ${h.bound}${h.kind === 'continuation' ? ' (a stream\'s fresh input through a continuation round, against the stream bound)' : ' (a compiled request\'s whole input, against the model\'s window)'}`).join(', ')}`);
  return { verdict, lines, invalid, flags, expected: covered, missing, didntRun };
}
