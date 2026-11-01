import { assemblies, FIXTURE_AGENT } from './checks.mjs';

function canaryNames(log, agent) {
  const canaryOf = new Map();
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    const messages = e.store?.[agent]?.messages;
    for (const [id, canaries] of Array.isArray(messages) ? messages : []) if (canaries?.length) canaryOf.set(String(id), canaries[0]);
  }
  return canaryOf;
}

function namedLedger(log, line) {
  if (!line?.ledger) return null;
  if (line.ledger.unreadable) return { unreadable: line.ledger.unreadable };
  const canaryOf = canaryNames(log, line.agent);
  const name = (id) => canaryOf.get(String(id)) ?? `#${id}`;
  const span = ([from, to, n]) => ({ from: name(from), to: name(to), n });
  return {
    raw: line.ledger.raw.map(span),
    summaries: line.ledger.summaries.map(([id, level, spans]) => ({ id, level, spans: spans.map(span) })),
    out: line.ledger.out.map(span),
    counts: line.ledger.counts,
  };
}

const spanText = (s) => (s.n === 1 ? s.from : `${s.from}–${s.to} (${s.n})`);

function ledgerLines(ledger) {
  if (!ledger) return ['- no ledger: the compile line carries none'];
  if (ledger.unreadable) return [`- no ledger: the store couldn't be read (${ledger.unreadable})`];
  const n = (spans) => spans.reduce((sum, s) => sum + s.n, 0);
  return [
    `- raw (${ledger.counts.raw}): ${ledger.raw.map(spanText).join(', ') || 'none'}`,
    ...ledger.summaries.map((s) => `- in ${s.id}${s.level === null ? '' : ` (L${s.level})`} (${n(s.spans)}): ${s.spans.map(spanText).join(', ')}`),
    `- left out (${ledger.counts.out}): ${ledger.out.map(spanText).join(', ') || 'none'}`,
  ];
}

// The run's requests, calls and quarantines are counted across every agent, since a configuration's work can be its
// subagent's or another module's; a compile's ledger is one agent's, so raw, summarised and left out are `agent`'s.
export function moduleCounts(log, records, agent = FIXTURE_AGENT) {
  const agents = [...new Set(log.filter((e) => e.kind === 'compiles').flatMap((e) => (e.lines ?? []).filter((l) => l.kind === 'request').map((l) => l.agent)))];
  const asm = agents.flatMap((a) => assemblies(log, a));
  const sent = asm.filter((l) => l.outcome === 'compiled');
  const summariser = records.filter((r) => r.kind === 'summariser');
  const quarantine = new Map();
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    for (const [a, st] of Object.entries(e.store ?? {})) if (st && 'quarantine' in st) quarantine.set(a, st.quarantine);
  }
  const known = [...quarantine.values()].filter((q) => q && typeof q.merge === 'number');
  const ledger = assemblies(log, agent).filter((l) => l.outcome === 'compiled').at(-1)?.ledger;
  const last = ledger && !ledger.unreadable ? ledger.counts : null;
  return {
    compiles: sent.length,
    refused: asm.length - sent.length,
    compressions: summariser.filter((r) => r.level === 1).length,
    merges: summariser.filter((r) => typeof r.level === 'number' && r.level > 1).length,
    ...(known.length ? { quarantines: known.reduce((n, q) => n + (q.compression ?? 0) + q.merge, 0) } : {}),
    ...(last ? { raw: last.raw, summarised: last.summarised, out: last.out } : {}),
    invariantLines: log.filter((e) => e.kind === 'compiles').flatMap((e) => e.lines ?? []).filter((l) => (l.violations ?? []).length > 0).length,
  };
}

export function ledgerOf(log, line) {
  return ledgerLines(namedLedger(log, line));
}
