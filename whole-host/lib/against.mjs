import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const slug = (id) => id.replaceAll('/', '_');
export const recordPath = (dir, id) => join(dir, slug(id), `${slug(id)}.record`);

const under = (r) => `Node ${r?.node ?? '?'} on ${r?.platform ?? '?'} ${r?.arch ?? '?'}`;

export function readAgainst(dir, { lane, runs, names, runtime }) {
  const file = join(dir, 'run.json');
  if (!existsSync(file)) throw new Error(`--against ${dir} holds no run.json, so the base arm didn't finish`);
  let base;
  try { base = JSON.parse(readFileSync(file, 'utf-8')); } catch (e) { throw new Error(`--against ${file} couldn't be read: ${e.message}`); }
  if (base.lane !== lane) throw new Error(`--against ${dir} was written by the harness at lane ${String(base.lane).slice(0, 12)}, and this one is ${lane.slice(0, 12)}, so their records can't be compared`);
  if (under(base.runtime) !== under(runtime)) throw new Error(`--against ${dir} ran under ${under(base.runtime)}, and this invocation under ${under(runtime)}, so their records can't be compared`);
  const theirs = Array.isArray(base.runs) ? base.runs : [];
  if (theirs.join(',') !== runs.join(',')) throw new Error(`--against ${dir} drew its shares from ${theirs.join(', ') || 'no runs'}, and this invocation from ${runs.join(', ')}: give both arms the same --runs`);
  const results = Array.isArray(base.results) ? base.results : [];
  const ran = results.map((r) => r.run);
  if (ran.length !== names.length || names.some((n) => !ran.includes(n))) throw new Error(`--against ${dir} ran ${ran.join(', ') || 'no runs'}, and this share runs ${names.join(', ')}: give both arms the same --shard`);
  const lost = results.filter((r) => r.record != null && !existsSync(recordPath(dir, r.run)));
  if (lost.length) throw new Error(`--against ${dir}'s run.json says ${lost.map((r) => r.run).join(', ')} wrote a record, and ${lost.map((r) => relative(dir, recordPath(dir, r.run))).join(', ')} isn't there`);
  const byRun = new Map(results.map((r) => [r.run, r]));
  return { dir, release: base.release, result: (id) => byRun.get(id) };
}

const named = (versions) => Object.entries(versions ?? {}).map(([k, v]) => `${k.replace('@animalabs/', '')}@${v}`).join(' ');

export function releaseDiffers(against, release) {
  if (JSON.stringify(against.release) === JSON.stringify(release)) return null;
  return `--against ${against.dir} made its checkpoints with ${against.release?.tag ?? 'no release'} (${named(against.release?.versions)}), and this invocation with ${release.tag} (${named(release.versions)}), so the two arms' runs wouldn't start from the same stores`;
}

const flagKey = (f) => JSON.stringify([f.check, f.step, f.what ?? null, f.detail, f.whole ?? null]);

export function flagsAgainst(against, id, own) {
  if (!against) return { new: own, gone: [], kept: [] };
  const base = against.result(id);
  if (base?.record == null) return null;
  const theirs = [...(base.flags?.new ?? []), ...(base.flags?.kept ?? [])];
  const keys = theirs.map(flagKey);
  const taken = new Set();
  const out = { new: [], gone: [], kept: [] };
  for (const f of own) {
    const k = flagKey(f);
    const at = keys.findIndex((t, i) => !taken.has(i) && t === k);
    if (at < 0) out.new.push(f);
    else { taken.add(at); out.kept.push(f); }
  }
  out.gone = theirs.filter((_, i) => !taken.has(i));
  return out;
}

export function measuredOf(r, { against, base, readsFailed }) {
  if (r.outcome === 'couldnt-run') return {};
  return {
    unmeasured: r.unmeasured ?? [], ...(against ? { baseUnmeasured: base?.unmeasured ?? [] } : {}),
    readsFailed, ...(against ? { baseReadsFailed: base?.readsFailed ?? [] } : {}),
    ...(base?.outcome === 'couldnt-run' ? { baseReason: base.reason ?? '' } : {}),
  };
}

export function recordAgainst(against, id, text) {
  if (!against) return { record: 'written', base: null };
  if (against.result(id)?.record == null) return { record: 'missing', base: null };
  const base = readFileSync(recordPath(against.dir, id), 'utf-8');
  return { record: base === text ? 'same' : 'differs', base };
}
