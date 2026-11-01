import { assemblies, FIXTURE_AGENT } from './checks.mjs';

function canaryNames(log, agent) {
  const own = new Map(), others = new Map();
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    for (const [name, store] of Object.entries(e.store ?? {})) {
      const into = name === agent ? own : others;
      for (const [id, canaries] of Array.isArray(store?.messages) ? store.messages : []) if (canaries?.length) into.set(String(id), canaries[0]);
    }
  }
  return (id) => own.get(id) ?? others.get(id);
}

// context-manager's layout of a compile (buildRenderedLayout): the view's members in order, and one unit per raw
// member (`p` where its body went out incomplete), per run under the same summaries, and per run left out.
function fates(layout) {
  if (!Array.isArray(layout?.memberIds) || !Array.isArray(layout?.units)) return null;
  const ids = layout.memberIds.map(String);
  const raw = [], incomplete = [], out = [], under = new Map();
  let at = 0;
  for (const u of layout.units) {
    if (u.k === 'r') (u.p ? incomplete : raw).push(ids[at++]);
    else {
      const run = ids.slice(at, at + u.n);
      at += u.n;
      if (u.k === 'o') out.push(...run);
      else for (const [id, level] of u.sm ?? []) under.set(id, { level, ids: [...(under.get(id)?.ids ?? []), ...run] });
    }
  }
  if (at !== ids.length) return null;
  const summarised = new Set([...under.values()].flatMap((s) => s.ids));
  return { ids, raw, incomplete, under, out, counts: { raw: raw.length + incomplete.length, summarised: summarised.size, out: out.length } };
}

export function ledgerOf(log, line) {
  const f = fates(line?.layout);
  if (!f) return [`- no ledger: the compile line carries no layout context-manager gave${line?.layout?.unreadable ? ` (${line.layout.unreadable})` : ''}`];
  const canaryOf = canaryNames(log, line.agent);
  const position = new Map(f.ids.map((id, i) => [id, i]));
  const name = (id) => canaryOf(id) ?? `#${id}`;
  const spans = (ids) => {
    const runs = [];
    for (const id of ids) {
      const last = runs.at(-1);
      if (last && position.get(id) === position.get(last.to) + 1) { last.to = id; last.n++; } else runs.push({ from: id, to: id, n: 1 });
    }
    return runs.map((r) => (r.n === 1 ? name(r.from) : `${name(r.from)}–${name(r.to)} (${r.n})`)).join(', ') || 'none';
  };
  return [
    `- raw (${f.raw.length}): ${spans(f.raw)}`,
    ...(f.incomplete.length ? [`- raw, its body incomplete (${f.incomplete.length}): ${spans(f.incomplete)}`] : []),
    ...[...f.under].map(([id, s]) => `- in ${id} (L${s.level}) (${s.ids.length}): ${spans(s.ids)}`),
    `- left out (${f.out.length}): ${spans(f.out)}`,
  ];
}

export function moduleCounts(log, records, agent = FIXTURE_AGENT) {
  const agents = [...new Set(log.filter((e) => e.kind === 'compiles').flatMap((e) => (e.lines ?? []).filter((l) => l.kind === 'request').map((l) => l.agent)))];
  const asm = agents.flatMap((a) => assemblies(log, a));
  const made = asm.filter((l) => l.outcome === 'compiled');
  const summariser = records.filter((r) => r.kind === 'summariser');
  const quarantine = new Map();
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    for (const [a, st] of Object.entries(e.store ?? {})) if (st && 'quarantine' in st) quarantine.set(a, st.quarantine);
  }
  const reported = [...quarantine.values()];
  const known = reported.every((q) => typeof q?.compression === 'number' && typeof q?.merge === 'number');
  const last = fates(assemblies(log, agent).filter((l) => l.outcome === 'compiled').at(-1)?.layout)?.counts;
  return {
    compiles: made.length,
    refused: asm.length - made.length,
    compressions: summariser.filter((r) => r.level === 1).length,
    merges: summariser.filter((r) => typeof r.level === 'number' && r.level > 1).length,
    ...(reported.length && known ? { quarantines: reported.reduce((n, q) => n + q.compression + q.merge, 0) } : {}),
    ...(last ? { raw: last.raw, summarised: last.summarised, out: last.out } : {}),
    invariantLines: log.filter((e) => e.kind === 'compiles').flatMap((e) => e.lines ?? []).filter((l) => (l.violations ?? []).length > 0).length,
  };
}
