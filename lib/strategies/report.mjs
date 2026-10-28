import { declaredProducts, everyTurnAnswers, wellFormed, windowsRaw, coverage, bookkeeping, calibrationEdge } from './checks.mjs';

/**
 * Every check one side's run gives: its flags and the segments missing a declared product.
 * `store` is read-store.mjs's read of the run's final store copy, or null when the
 * configuration keeps no summaries to read.
 */
export function runChecks({ records, log, script, products, store }) {
  const flags = [
    ...everyTurnAnswers(records, log),
    ...wellFormed(records),
    ...(store ? coverage(records, store) : []),
    ...(store ? bookkeeping(records, store) : []),
    ...windowsRaw(records, script),
    ...calibrationEdge(log),
  ];
  return { flags, missing: declaredProducts(records, script, products) };
}

const key = (f) => `${f.check}|${f.step}`;

/**
 * The per-check report: the candidate's flags and missing products, and, where the
 * candidate failed something and the base ran, whether the base fails it too. A product
 * the base didn't produce either means the segment didn't run, and counts against
 * no one. A calibration at a clamp edge makes the run invalid, and the first line says so.
 * Returns the verdict and lines with what they count: `invalid` (check 10's flags), `flags`
 * (the rest), `missing` (`{ segment, name }`, products the candidate lacks and the base,
 * if it ran, produced) and `didntRun` (products neither side produced).
 */
export function perCheckReport({ configuration, candidate, base = null, timing = {} }) {
  const invalid = candidate.flags.filter((f) => f.check === 10);
  const baseFlags = new Set((base?.flags ?? []).map(key));
  const baseMissing = new Map((base?.missing ?? []).map((m) => [m.segment, new Set(m.missing)]));
  const flags = candidate.flags.filter((f) => f.check !== 10);
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
  lines.push(`${configuration.name}: ${verdict === 'pass' ? 'no flags' : `${flags.length} flag(s), ${missing.length} missing product(s)`}${base ? ', with the base run beside it' : ''}${when ? ` (${when})` : ''}.`);
  for (const f of flags) lines.push(`- check ${f.check} at ${f.step}${f.request ? ` (${f.request})` : ''}: ${f.message}${base ? (baseFlags.has(key(f)) ? ' [base too]' : ' [not on base]') : ''}`);
  for (const m of missing) lines.push(`- check 2, ${m.segment}: missing ${m.name}${base ? ' [the base produced it]' : ''}`);
  for (const m of didntRun) lines.push(`- ${m.segment} didn't run: neither side produced ${m.name}`);
  return { verdict, lines, invalid, flags, missing, didntRun };
}
