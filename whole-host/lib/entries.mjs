import { createHash } from 'node:crypto';
import { lcsSteps } from './view.mjs';

const HEX = /[0-9a-f]{8,}/g;
const NUM = /\d+/g;
const CANARY = /#(?:\.#)*\.[a-z][a-z0-9#]*(?:\+#)?/g;
const mask = (s) => s.replace(HEX, 'H').replace(NUM, '#');

function shape(s) {
  const out = [];
  for (const t of mask(s).replace(CANARY, 'C').split(' ')) {
    if (out.length && (out.at(-1) === t || out.at(-1) === `${t}…`)) out[out.length - 1] = `${t}…`;
    else out.push(t);
  }
  return out.join(' ');
}

const tokens = (s) => [...new Set(shape(s).split(' ').filter(Boolean).map((t) => t.replace(/…+$/, '')))].sort().join(' ');
const HEX_SLUG = /[a-f#]*(?:[a-f]#|#[a-f])[a-f#]*/g;
const role = (key) => mask(key.replace(/-[0-9a-f]{12}$/, '')).replace(HEX_SLUG, 'H');
const kindOf = (line) => line.split(' ', 1)[0];

function parse(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const rec = { header: lines[0] ?? '', templates: new Map(), heads: new Map(), steps: new Map(), tail: [] };
  let block = 'header';
  let key = null;
  let step = null;
  for (const line of lines.slice(1)) {
    if (line === 'templates' || line === 'heads') { block = line; continue; }
    if (line.startsWith('step ')) { block = 'steps'; step = line.slice(5); rec.steps.set(step, []); continue; }
    if ((block === 'templates' || block === 'heads') && !line.startsWith('  ')) {
      const at = line.indexOf(' = ');
      key = at < 0 ? line : line.slice(0, at);
      rec[block].set(key, at < 0 ? '' : line.slice(at + 3));
      continue;
    }
    if (block === 'templates' || block === 'heads') { rec[block].set(key, `${rec[block].get(key)}\n${line}`); continue; }
    if (block === 'steps' && line.startsWith('  ')) { rec.steps.get(step).push(line.slice(2)); continue; }
    if (block === 'steps' && line.startsWith('checkpoint ')) { rec.steps.get(step).push(line); continue; }
    block = 'tail';
    rec.tail.push(line);
  }
  return rec;
}

function filled(side, text) {
  const at = side.indexOf(' = ');
  if (!side.startsWith('T:') || at < 0) return side;
  const key = side.slice(0, at);
  const template = side.slice(at + 3);
  const use = new RegExp(`\\[${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\(([^)]*)\\)`).exec(text);
  const parts = template.split('#');
  const numbers = use ? use[1].split(',') : null;
  if (!numbers || numbers.length !== parts.length - 1) return side;
  return `${key} = ${parts.map((p, i) => `${p}${numbers[i] ?? ''}`).join('')}`;
}

function hunks(a, b) {
  const out = [];
  let hunk = null;
  for (const [op, i, j] of lcsSteps(a, b)) {
    if (op === '=') { hunk = null; continue; }
    if (!hunk) { hunk = { gone: [], came: [] }; out.push(hunk); }
    if (op === '-') hunk.gone.push(a[i]); else hunk.came.push(b[j]);
  }
  return out;
}

function tokenDiff(a, b) {
  const [gone, came] = hunks(a.split(' '), b.split(' ')).reduce(([g, c], h) => [[...g, ...h.gone], [...c, ...h.came]], [[], []]);
  return [gone.join(' '), came.join(' ')];
}

export function differencesOf(run, baseText, headText) {
  const base = parse(baseText);
  const head = parse(headText);
  const out = [];
  const add = (sig, describe, step, before, after) => out.push({ sig, describe, place: { run, step }, before: filled(before, baseText), after: filled(after, headText) });
  if (base.header !== head.header) add(['header'], 'the record header changed', 'header', base.header, head.header);
  for (const section of ['templates', 'heads']) {
    const b = base[section];
    const h = head[section];
    for (const k of b.keys()) if (!h.has(k)) add([section, role(k), 'only in base'], `${section} ${role(k)}: text only in base`, section, `${k} = ${b.get(k)}`, '');
    for (const k of h.keys()) if (!b.has(k)) add([section, role(k), 'only in head'], `${section} ${role(k)}: text only in head`, section, '', `${k} = ${h.get(k)}`);
  }
  const lines = (step, gone, came) => {
    for (const hunk of hunks(gone, came)) {
      const used = new Set();
      for (const r of hunk.gone) {
        const k = kindOf(r);
        const j = hunk.came.findIndex((a, x) => !used.has(x) && kindOf(a) === k);
        if (j < 0) { add(['line', k, 'only in base'], `\`${k}\` lines only in base`, step, r, ''); continue; }
        used.add(j);
        const [tr, ta] = tokenDiff(r, hunk.came[j]);
        add(['line', k, 'changed', tokens(tr), tokens(ta)], `\`${k}\` lines whose \`${tokens(tr)}\` became \`${tokens(ta)}\``, step, r, hunk.came[j]);
      }
      hunk.came.forEach((a, x) => { if (!used.has(x)) add(['line', kindOf(a), 'only in head'], `\`${kindOf(a)}\` lines only in head`, step, '', a); });
    }
  };
  for (const step of new Set([...base.steps.keys(), ...head.steps.keys()])) {
    if (!base.steps.has(step) || !head.steps.has(step)) {
      add(['step', `only in ${base.steps.has(step) ? 'base' : 'head'}`], 'a step only one arm ran', step, (base.steps.get(step) ?? []).join('\n'), (head.steps.get(step) ?? []).join('\n'));
      continue;
    }
    lines(step, base.steps.get(step), head.steps.get(step));
  }
  lines('end', base.tail, head.tail);
  return out;
}

export function entriesOf(differences) {
  const byId = new Map();
  for (const d of differences) {
    const id = createHash('sha256').update(JSON.stringify(d.sig)).digest('hex').slice(0, 12);
    if (!byId.has(id)) byId.set(id, { id, describe: d.describe, places: [], example: { place: d.place, before: d.before, after: d.after } });
    byId.get(id).places.push({ ...d.place, digest: createHash('sha256').update(JSON.stringify([d.before, d.after])).digest('hex').slice(0, 12) });
  }
  return [...byId.values()].map(({ id, describe, places, example }) => ({ id, describe, count: places.length, runs: [...new Set(places.map((p) => p.run))], places, example }));
}
