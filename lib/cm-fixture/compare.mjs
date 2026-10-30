import { canonicalJSON, digest, isUnreadable } from './events.mjs';

/**
 * The base's and the candidate's trace of one run (readTrace's result each), compared event by event.
 *
 * Returns { run, status, defect?, divergences, first, invariants, totals, signatures }:
 * - `status` is 'same', 'diverged', or 'defect' when the two traces aren't of one run as the driver ran it: a fixture
 *   field differs, the driver ended either run (`end.error.where` 'driver'), or the events don't line up. A defect is
 *   the fixture's to fix; nothing about the library is read from it.
 * - `divergences`: each { class, at, what, change?, order }, `class` one of the report's classes, `at` the event's key
 *   (`kind`, `step`, `n` or `label`), `what` a line saying what differs, `change` the hash of what changed for a change
 *   that has a before and an after of its own (a message's bytes, a request, a target, a summary's text, a log tag's
 *   count), and `order` the candidate event's position, by which `first` is the earliest.
 * - `invariants`: { new, known, fixed }, each violation with the event it came from: `new` the candidate's alone,
 *   `known` both arms', `fixed` the base's alone, matched by event and invariant.
 * - `totals`: { base, candidate }, each { compiles, refused, calls, written, rewritten, receipts, withReference }.
 * - `signatures`: { changes, traces }. `changes` maps each hash of what changed to its { class, field, before, after }.
 *   `traces` maps each class that diverged with no before and after of its own (outcome, selection, summariser,
 *   store, cache) to the hash of the candidate's own trace for that class.
 * - `blocking`: the divergences no record can accept: a compile the base made that the candidate refuses, and each
 *   new invariant violation.
 */
export function compareRun(base, candidate) {
  const run = candidate.header.run;
  const defect = (why) => ({ run, status: 'defect', defect: why, divergences: [], first: null, invariants: { new: [], known: [], fixed: [] }, totals: { base: totals(base), candidate: totals(candidate) }, signatures: { changes: {}, traces: {} }, blocking: [] });
  for (const f of ['run', 'config', 'workload', 'variant', 'seed', 'scale', 'from']) {
    if (canonicalJSON(base.header[f]) !== canonicalJSON(candidate.header[f])) return defect(`run.${f} differs: ${JSON.stringify(base.header[f])} against ${JSON.stringify(candidate.header[f])}`);
  }
  for (const f of ['membrane', 'fixture']) {
    if (canonicalJSON(base.header[f]?.version) !== canonicalJSON(candidate.header[f]?.version)) return defect(`run.${f}.version differs: ${base.header[f]?.version} against ${candidate.header[f]?.version}`);
  }
  for (const [arm, t] of [['base', base], ['candidate', candidate]]) {
    if (t.end.error?.where === 'driver') return defect(`the driver ended the ${arm}'s run: ${t.end.error.class}: ${String(t.blobs.get(t.end.error.message)).split('\n')[0]}`);
  }

  const out = [];
  const add = (cls, at, what, order, change) => out.push(change ? { class: cls, at, what, change: change.hash, order } : { class: cls, at, what, order });
  const changes = {};
  const changed = (cls, field, before, after) => {
    const sig = { class: cls, field, before, after };
    const hash = digest(sig);
    changes[hash] = sig;
    return { hash };
  };
  const B = (id) => base.blobs.get(id), C = (id) => candidate.blobs.get(id);

  const index = (t) => {
    const m = new Map();
    t.events.forEach((e, i) => m.set(keyOf(e), { e, i }));
    return m;
  };
  const bi = index(base), ci = index(candidate);
  const orderOf = (k) => ci.get(k)?.i ?? (bi.get(k)?.i ?? 0) + 0.5;

  // Actions: the driver's arguments must agree, and what the library returned is store class.
  for (const k of new Set([...bi.keys(), ...ci.keys()])) {
    if (!k.startsWith('action|')) continue;
    const b = bi.get(k)?.e, c = ci.get(k)?.e;
    if (!b || !c) return defect(`${k} is in one arm's trace only`);
    const argsB = b.op === 'add' ? { ...b.args, content: B(b.args.content) } : b.args;
    const argsC = c.op === 'add' ? { ...c.args, content: C(c.args.content) } : c.args;
    if (b.op !== c.op || canonicalJSON(argsB) !== canonicalJSON(argsC)) return defect(`${k}: the driver did ${b.op} ${canonicalJSON(argsB).slice(0, 120)} in the base and ${c.op} ${canonicalJSON(argsC).slice(0, 120)} in the candidate`);
    if (c.op !== 'add' && canonicalJSON(b.result ?? null) !== canonicalJSON(c.result ?? null)) add('store', at(c), `${c.op} returned ${short(b.result)} in the base and ${short(c.result)} in the candidate`, orderOf(k));
  }

  // Compiles.
  const blocking = [];
  const inv = { new: [], known: [], fixed: [] };
  for (const k of new Set([...bi.keys(), ...ci.keys()])) {
    if (!k.startsWith('compile|')) continue;
    const b = bi.get(k)?.e, c = ci.get(k)?.e;
    if (!b || !c) return defect(`${k} is in one arm's trace only`);
    if (canonicalJSON(b.budget) !== canonicalJSON(c.budget)) return defect(`${k}: budgets differ`);
    const o = orderOf(k);
    classifyViolations(inv, b, c);
    if (b.outcome !== c.outcome || (b.outcome === 'refused' && b.error.class !== c.error.class)) {
      const d = { class: 'outcome', at: at(c), what: `base ${b.outcome === 'compiled' ? 'compiled' : `refused (${b.error.class})`}, candidate ${c.outcome === 'compiled' ? 'compiled' : `refused (${c.error.class})`}`, order: o };
      out.push(d);
      if (b.outcome === 'compiled' && c.outcome === 'refused') blocking.push(d);
      continue;
    }
    if (b.outcome === 'refused') continue;
    const sb = b.messages.map((m) => m.sources.join(' ')), sc = c.messages.map((m) => m.sources.join(' '));
    const mb = b.messages.map((m) => canonicalJSON(m.marker ?? null)), mc = c.messages.map((m) => canonicalJSON(m.marker ?? null));
    if (sb.join('\n') !== sc.join('\n')) add('selection', at(c), `the request carries ${describeSelection(sb, sc)}`, o);
    else if (mb.join('\n') !== mc.join('\n')) add('selection', at(c), 'the same messages with cache markers placed differently', o);
    // Bytes, between messages whose sources match: the k-th message with given sources in each arm, since a recalled
    // memory goes out as two messages with one summary's sources.
    const byB = new Map();
    const nth = (seen, key) => { const k = (seen.get(key) ?? 0); seen.set(key, k + 1); return `${key}#${k}`; };
    const seenB = new Map(), seenC = new Map();
    b.messages.forEach((m) => byB.set(nth(seenB, m.sources.join(' ')), m));
    let bytesSame = sb.join('\n') === sc.join('\n');
    for (const m of c.messages) {
      const other = byB.get(nth(seenC, m.sources.join(' ')));
      if (!other || other.content === m.content) continue;
      bytesSame = false;
      const [before, after] = span(canonicalJSON(B(other.content)), canonicalJSON(C(m.content)));
      add('bytes', at(c), `message ${m.sources.join(' ')}: ${clip(before)} became ${clip(after)}`, o, changed('bytes', 'message', before, after));
    }
    if (b.system !== c.system) {
      bytesSame = false;
      const [before, after] = span(canonicalJSON(B(b.system)), canonicalJSON(C(c.system)));
      add('bytes', at(c), `system: ${clip(before)} became ${clip(after)}`, o, changed('bytes', 'system', before, after));
    }
    if (bytesSame) {
      if (canonicalJSON(b.layout ?? null) !== canonicalJSON(c.layout ?? null)) add('selection', at(c), 'the same request with a different rendered layout', o);
      if (canonicalJSON(b.stats ?? null) !== canonicalJSON(c.stats ?? null)) add('selection', at(c), `the same request with different render stats: ${describeDiff(b.stats, c.stats)}`, o);
      if (canonicalJSON(b.receipt ?? null) !== canonicalJSON(c.receipt ?? null)) add('cache', at(c), `the same request with a different receipt: ${short(b.receipt)} against ${short(c.receipt)}`, o);
    }
  }
  for (const v of inv.new) blocking.push({ class: 'invariant', at: v.at, what: `new ${v.invariant}: ${v.detail}`, order: v.order ?? 0 });

  // Summariser calls, paired within a step by what each request carried.
  const callsByStep = (t) => {
    const m = new Map();
    for (const e of t.events) if (e.kind === 'call') {
      const key = `${e.step}|${e.carried.join(',')}`;
      m.set(key, [...(m.get(key) ?? []), e]);
    }
    return m;
  };
  const cb = callsByStep(base), cc = callsByStep(candidate);
  for (const key of new Set([...cb.keys(), ...cc.keys()])) {
    const xs = cb.get(key) ?? [], ys = cc.get(key) ?? [];
    for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
      const b = xs[i], c = ys[i];
      const o = c ? orderOf(keyOf(c)) : orderOf(keyOf(b));
      if (!b || !c) { add('summariser', at(c ?? b), `a summariser request carrying ${(c ?? b).carried.length} items made in the ${c ? 'candidate' : 'base'} only`, o); continue; }
      if (b.target !== c.target) add('summariser', at(c), `target ${b.target} became ${c.target}`, o, changed('summariser', 'target', String(b.target), String(c.target)));
      if (b.request !== c.request) {
        const [before, after] = span(canonicalJSON(B(b.request)), canonicalJSON(C(c.request)));
        add('summariser', at(c), `request: ${clip(before)} became ${clip(after)}`, o, changed('summariser', 'request', before, after));
      }
      if (b.answer.kind !== c.answer.kind) add('summariser', at(c), `answered ${b.answer.kind} in the base and ${c.answer.kind} in the candidate`, o);
    }
  }

  // Steps: what came of the answers, the store's state, and the logs.
  for (const k of new Set([...bi.keys(), ...ci.keys()])) {
    if (!k.startsWith('step|')) continue;
    const b = bi.get(k)?.e, c = ci.get(k)?.e;
    if (!b || !c) return defect(`${k} is in one arm's trace only`);
    const o = orderOf(k);
    classifyViolations(inv, b, c);
    const shape = (s) => `${s.level}|${s.sources.join(',')}`;
    const wb = new Map(b.written.map((s) => [shape(s), s])), wc = new Map(c.written.map((s) => [shape(s), s]));
    for (const key of new Set([...wb.keys(), ...wc.keys()])) {
      const x = wb.get(key), y = wc.get(key);
      if (!x || !y) { add('summariser', at(c), `an L${(x ?? y).level} summary over ${(x ?? y).sources.length} sources written in the ${y ? 'candidate' : 'base'} only`, o); continue; }
      if (x.content !== y.content) {
        const [before, after] = span(String(B(x.content)), String(C(y.content)));
        add('summariser', at(c), `L${x.level} summary text: ${clip(before)} became ${clip(after)}`, o, changed('summariser', 'summary', before, after));
      }
    }
    if (canonicalJSON(b.removed) !== canonicalJSON(c.removed)) add('store', at(c), `summaries removed: ${short(b.removed)} against ${short(c.removed)}`, o);
    for (const f of ['waiting', 'pending', 'ready']) {
      if (canonicalJSON(b[f]) !== canonicalJSON(c[f])) add('store', at(c), `${f}: ${describeDiff(b[f], c[f])}`, o);
    }
    for (const tag of new Set([...Object.keys(b.logs), ...Object.keys(c.logs)])) {
      const x = b.logs[tag] ?? 0, y = c.logs[tag] ?? 0;
      if (x !== y) add('log', at(c), `[${tag}] logged ${x} times in the base and ${y} in the candidate`, o, changed('log', tag, String(x), String(y)));
    }
  }

  // Checkpoints: the store as each arm leaves it. A summary's text is the summariser's, compared where it's written.
  for (const k of new Set([...bi.keys(), ...ci.keys()])) {
    if (!k.startsWith('checkpoint|')) continue;
    const b = bi.get(k)?.e, c = ci.get(k)?.e;
    if (!b || !c) return defect(`${k} is in one arm's trace only`);
    const o = orderOf(k);
    classifyViolations(inv, b, c);
    for (const f of ['messages', 'summaries', 'pins', 'holds', 'waiting', 'pending', 'ready', 'maxLevel', 'derivation', 'branches', 'settings']) {
      const strip = (v) => (f === 'summaries' && Array.isArray(v) ? v.map(({ content, ...s }) => s) : v);
      const x = strip(b[f]), y = strip(c[f]);
      if (isUnreadable(x) || isUnreadable(y)) {
        if (!(isUnreadable(x) && isUnreadable(y))) add('store', at(c), `${f} unreadable in the ${isUnreadable(x) ? 'base' : 'candidate'}`, o);
        continue;
      }
      if (canonicalJSON(x) !== canonicalJSON(y)) add('store', at(c), `${f}: ${describeDiff(x, y)}`, o);
    }
  }

  // The run's end.
  if (base.end.ok !== candidate.end.ok || (base.end.error?.class ?? null) !== (candidate.end.error?.class ?? null)) {
    add('outcome', { kind: 'end' }, `the run ended ${endText(base)} in the base and ${endText(candidate)} in the candidate`, candidate.events.length);
  }
  if (canonicalJSON(base.end.logs ?? {}) !== canonicalJSON(candidate.end.logs ?? {})) {
    for (const tag of new Set([...Object.keys(base.end.logs ?? {}), ...Object.keys(candidate.end.logs ?? {})])) {
      const x = base.end.logs?.[tag] ?? 0, y = candidate.end.logs?.[tag] ?? 0;
      if (x !== y) add('log', { kind: 'end' }, `[${tag}] logged ${x} times after the last step in the base and ${y} in the candidate`, candidate.events.length, changed('log', tag, String(x), String(y)));
    }
  }

  out.sort((a, b) => a.order - b.order);
  const traces = {};
  for (const cls of new Set(out.filter((d) => !d.change).map((d) => d.class))) traces[cls] = digest(classTrace(candidate, cls));
  return {
    run, status: out.length === 0 && inv.new.length === 0 && inv.fixed.length === 0 ? 'same' : 'diverged',
    divergences: out, first: out[0] ? firstView(out[0], base, candidate) : null,
    invariants: inv, totals: { base: totals(base), candidate: totals(candidate) },
    signatures: { changes, traces }, blocking,
  };
}

/**
 * A candidate-only run (`run.only`), from its two runs: { run, status, defect?, invariants, totals, signatures }.
 * `status` is 'defect' when the two runs differ (the fixture or the library isn't deterministic there) or the driver
 * ended either, and otherwise 'solo'. Every invariant the run breaks is `new` and blocks, since no base holds it.
 * `signatures.traces.solo` is the hash of the run's whole trace, by which the change's record names its behaviour.
 */
export function compareSolo(first, second) {
  const run = first.header.run;
  const totalsOf = { base: null, candidate: totals(first) };
  const defect = (why) => ({ run, status: 'defect', defect: why, divergences: [], first: null, invariants: { new: [], known: [], fixed: [] }, totals: totalsOf, signatures: { changes: {}, traces: {} }, blocking: [] });
  for (const t of [first, second]) if (t.end.error?.where === 'driver') return defect(`the driver ended a run: ${t.end.error.class}`);
  const body = (t) => canonicalJSON([t.events, t.end.ok, t.end.error?.class ?? null, t.end.logs ?? null]);
  if (body(first) !== body(second)) return defect('two runs of the candidate-only configuration differ: not deterministic');
  const inv = { new: [], known: [], fixed: [] };
  for (const e of first.events) for (const v of e.violations ?? []) inv.new.push({ ...v, at: at(e) });
  const blocking = inv.new.map((v) => ({ class: 'invariant', at: v.at, what: `${v.invariant}: ${v.detail}`, order: 0 }));
  return { run, status: 'solo', divergences: [], first: null, invariants: inv, totals: totalsOf, signatures: { changes: {}, traces: { solo: digest(JSON.parse(body(first))) } }, blocking };
}

const keyOf = (e) => (e.kind === 'checkpoint' ? `checkpoint|${e.label}` : e.kind === 'step' ? `step|${e.step}` : `${e.kind}|${e.step}|${e.n}`);
const at = (e) => (e.kind === 'checkpoint' ? { kind: e.kind, label: e.label } : e.kind === 'step' ? { kind: e.kind, step: e.step } : { kind: e.kind, step: e.step, n: e.n });
const short = (v) => { const s = canonicalJSON(v ?? null); return s.length > 80 ? `${s.slice(0, 77)}...` : s; };
const clip = (s) => (s === '' ? '(nothing)' : JSON.stringify(s.length > 120 ? `${s.slice(0, 117)}...` : s));
const endText = (t) => (t.end.ok ? 'ok' : `on ${t.end.error.class}`);

function classifyViolations(inv, b, c) {
  const key = (v) => v.invariant;
  const xs = b.violations ?? [], ys = c.violations ?? [];
  const inB = new Set(xs.map(key)), inC = new Set(ys.map(key));
  for (const v of ys) (inB.has(key(v)) ? inv.known : inv.new).push({ ...v, at: at(c) });
  for (const v of xs) if (!inC.has(key(v))) inv.fixed.push({ ...v, at: at(b) });
}

/** The differing middle of two texts: what's left once their common start and end are taken off. */
export function span(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const norm = (s) => s.replace(/\bL[0-9]+-[0-9]+\b/g, 'L#');
  return [norm(a.slice(i, a.length - j)), norm(b.slice(i, b.length - j))];
}

function describeSelection(sb, sc) {
  const setB = new Set(sb), setC = new Set(sc);
  const gone = sb.filter((s) => !setC.has(s)), came = sc.filter((s) => !setB.has(s));
  const list = (xs) => (xs.length > 4 ? `${xs.slice(0, 4).join('; ')} and ${xs.length - 4} more` : xs.join('; '));
  if (gone.length === 0 && came.length === 0) return 'the same messages in another order';
  return `${came.length ? `${list(came)}` : 'nothing'} where the base carries ${gone.length ? list(gone) : 'nothing'}`;
}

function describeDiff(x, y) {
  if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
    const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => canonicalJSON(x[k] ?? null) !== canonicalJSON(y[k] ?? null));
    return keys.slice(0, 4).map((k) => `${k} ${short(x[k])} against ${short(y[k])}`).join('; ');
  }
  if (Array.isArray(x) && Array.isArray(y)) {
    const i = x.findIndex((v, n) => canonicalJSON(v) !== canonicalJSON(y[n] ?? null));
    return `${x.length} against ${y.length} entries, first differing at ${i === -1 ? x.length : i}: ${short(x[i === -1 ? x.length : i])} against ${short(y[i === -1 ? x.length : i])}`;
  }
  return `${short(x)} against ${short(y)}`;
}

/** The candidate's own trace for one class, whose hash a record accepts a divergence of that class by. */
function classTrace(t, cls) {
  const ev = t.events;
  switch (cls) {
    case 'outcome': return [ev.filter((e) => e.kind === 'compile').map((e) => [e.step, e.n, e.outcome, e.error?.class ?? null]), t.end.ok, t.end.error?.class ?? null];
    case 'selection': return ev.filter((e) => e.kind === 'compile').map((e) => [e.step, e.n, (e.messages ?? []).map((m) => [m.sources, m.marker ?? null]), e.layout ?? null, e.stats ?? null]);
    case 'summariser': return [ev.filter((e) => e.kind === 'call').map((e) => [e.step, e.carried, e.answer.kind]), ev.filter((e) => e.kind === 'step').map((e) => [e.step, e.written.map((s) => [s.level, s.sources])])];
    case 'store': return [
      ev.filter((e) => e.kind === 'action').map((e) => [e.step, e.n, e.result ?? null]),
      ev.filter((e) => e.kind === 'step').map((e) => [e.step, e.removed, e.waiting, e.pending, e.ready]),
      ev.filter((e) => e.kind === 'checkpoint').map((e) => ({ ...e, summaries: Array.isArray(e.summaries) ? e.summaries.map(({ content, ...s }) => s) : e.summaries, violations: undefined })),
    ];
    case 'cache': return ev.filter((e) => e.kind === 'compile').map((e) => [e.step, e.n, e.receipt ?? null]);
    default: return [];
  }
}

function totals(t) {
  const out = { compiles: 0, refused: 0, calls: 0, written: 0, rewritten: 0, receipts: 0, withReference: 0 };
  for (const e of t.events) {
    if (e.kind === 'compile') {
      out.compiles++;
      if (e.outcome === 'refused') out.refused++;
      if (typeof e.rewritten === 'number') out.rewritten += e.rewritten;
      if (e.receipt) { out.receipts++; if (e.receipt.withReference) out.withReference++; }
    }
    if (e.kind === 'call') out.calls++;
    if (e.kind === 'step') out.written += e.written.length;
  }
  out.rewritten = Math.round(out.rewritten * 1000) / 1000;
  return out;
}

/** The first divergence with both arms' structural lines for its event, and the candidate's next few events' keys. */
function firstView(d, base, candidate) {
  const find = (t) => t.events.find((e) => canonicalJSON(at(e)) === canonicalJSON(d.at)) ?? null;
  const line = (e) => {
    if (!e) return null;
    if (e.kind === 'compile') return e.outcome === 'compiled' ? e.messages.map((m) => m.sources.join(' ')).join(' | ') : `refused: ${e.error.class}`;
    if (e.kind === 'step') return `written ${e.written.map((s) => `L${s.level}(${s.sources.length})`).join(' ')}; logs ${canonicalJSON(e.logs)}`;
    if (e.kind === 'call') return `carried ${e.carried.length}, target ${e.target}, ${e.answer.kind}`;
    return short(e);
  };
  const b = find(base), c = find(candidate);
  const i = c ? candidate.events.indexOf(c) : -1;
  return { ...d, base: line(b), candidate: line(c), after: i < 0 ? [] : candidate.events.slice(i + 1, i + 4).map((e) => keyOf(e)) };
}
