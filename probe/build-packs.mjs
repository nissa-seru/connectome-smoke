// MEASUREMENT ONLY (probe/wh-place96, Oscar-1005 room-203 #317193): context-manager packed plain and with each
// mutant of mutants.json, for run.mjs to lay over the host as candidates.
//
//   node probe/build-packs.mjs CM_DIR MUTANTS_JSON IDS OUT_DIR
//
// CM_DIR is a context-manager checkout (fb4cf1046). Each mutant's edits are applied alone (each find occurs once),
// built with tsc (which emits despite a mutant's type error), and packed with scripts off; then its sources are put
// back. A mutant's pack is refused unless the files it edits compiled differently from the plain build and every other
// compiled file is the plain build's, so no stale or missed emit is packed. OUT_DIR/packs.json lists each pack, or
// why there's none, with the seconds it took.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const [CM, MUTANTS_JSON, IDS, OUT] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const sh = (cmd, args, { ok = true } = {}) => {
  const r = spawnSync(cmd, args, { cwd: CM, encoding: 'utf-8', timeout: 900_000, maxBuffer: 64 << 20 });
  if (ok && r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}: ${(r.stderr || r.stdout).slice(-2000)}`);
  return r;
};
const all = JSON.parse(readFileSync(MUTANTS_JSON, 'utf-8'));
const ids = IDS.split(',').map((s) => s.trim()).filter(Boolean);
const mutants = ids.map((id) => all.find((m) => m.id === id) ?? (() => { throw new Error(`no mutant ${id}`); })());
const t = () => performance.now();
const secs = (t0) => Math.round((performance.now() - t0) / 100) / 10;

const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const hashes = () => Object.fromEntries(walk(join(CM, 'dist', 'src')).map((p) => [relative(join(CM, 'dist', 'src'), p), createHash('sha256').update(readFileSync(p)).digest('hex')]));
const build = () => { rmSync(join(CM, 'dist'), { recursive: true, force: true }); return sh('npx', ['tsc'], { ok: false }); };
const pack = (label) => {
  const name = sh('npm', ['pack', '--ignore-scripts', '--pack-destination', OUT, '--loglevel=error']).stdout.trim().split('\n').at(-1);
  const dest = join(OUT, `${label}.tgz`);
  cpSync(join(OUT, name), dest);
  rmSync(join(OUT, name));
  return dest;
};

const out = [];
let t0 = t();
sh('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error']);
const ci = secs(t0);
t0 = t();
const plainBuild = build();
if (plainBuild.status !== 0) throw new Error(`the plain build failed: ${plainBuild.stdout.slice(-2000)}`);
const plain = hashes();
out.push({ id: 'plain', pack: pack('plain'), seconds: secs(t0) });
console.log(`npm ci ${ci} s; plain ${out[0].seconds} s, ${Object.keys(plain).length} compiled files`);

for (const m of mutants) {
  t0 = t();
  const saved = new Map();
  try {
    for (const e of m.edits) {
      const f = join(CM, 'src', e.file);
      if (!saved.has(f)) saved.set(f, readFileSync(f, 'utf-8'));
      const cur = readFileSync(f, 'utf-8');
      if (cur.split(e.find).length !== 2) throw new Error(`its find isn't once in ${e.file}`);
      writeFileSync(f, cur.replace(e.find, e.replace));
    }
    build();
    const now = hashes();
    // A source's compiled files: its .js, .d.ts and their maps.
    const base = (f) => f.replace(/\.(js|js\.map|d\.ts|d\.ts\.map)$/, '');
    const edited = new Set(m.edits.map((e) => e.file.replace(/\.ts$/, '')));
    const unchanged = [...edited].filter((b) => now[`${b}.js`] === plain[`${b}.js`]).map((b) => `${b}.js`);
    const strays = Object.keys({ ...plain, ...now }).filter((f) => !edited.has(base(f)) && now[f] !== plain[f]);
    if (unchanged.length) throw new Error(`its edited file(s) compiled as the plain build: ${unchanged.join(', ')}`);
    if (strays.length) throw new Error(`other compiled files differ from the plain build: ${strays.slice(0, 5).join(', ')}`);
    out.push({ id: m.id, pack: pack(m.id), seconds: secs(t0) });
  } catch (e) {
    out.push({ id: m.id, pack: null, reason: String(e.message).slice(0, 500), seconds: secs(t0) });
  } finally {
    for (const [f, text] of saved) writeFileSync(f, text);
  }
  console.log(`${m.id}: ${out.at(-1).pack ? 'packed' : `NOT packed: ${out.at(-1).reason}`} (${out.at(-1).seconds} s)`);
}
writeFileSync(join(OUT, 'packs.json'), JSON.stringify(out, null, 1));
