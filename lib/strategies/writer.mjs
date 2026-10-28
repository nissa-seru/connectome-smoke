import { createHash } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The key of a configuration's deep store: its lane version, configuration, recipe and stack versions. */
export function entryKey({ lane, configurationName, recipeHash, versions }) {
  const sorted = Object.fromEntries(Object.keys(versions).sort().map((k) => [k, versions[k]]));
  return createHash('sha256').update(JSON.stringify({ lane, configurationName, recipeHash, versions: sorted })).digest('hex');
}

const readEntry = (dir) => {
  try { return JSON.parse(readFileSync(join(dir, 'entry.json'), 'utf-8')); } catch { return null; }
};

/**
 * The newest complete entry under `cacheRoot` for `lane` (the lane's version) and
 * `configurationName`, whichever stack versions wrote it, as `{ dir, entry }`;
 * null when there is none. It takes no lock.
 */
export function findEntry({ cacheRoot, lane, configurationName }) {
  if (!existsSync(cacheRoot)) return null;
  const found = readdirSync(cacheRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => ({ dir: join(cacheRoot, d.name), entry: readEntry(join(cacheRoot, d.name)) }))
    .filter(({ entry }) => entry?.complete === true && entry.lane === lane && entry.configurationName === configurationName)
    .sort((a, b) => b.entry.writtenAt.localeCompare(a.entry.writtenAt));
  return found[0] ?? null;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function takeLock(path, waitMs) {
  const me = { pid: process.pid, host: hostname(), since: new Date().toISOString() };
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, JSON.stringify(me));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let holder = null;
    try { holder = JSON.parse(readFileSync(path, 'utf-8')); } catch { /* being written, or gone */ }
    if (holder && holder.host === me.host && !alive(holder.pid)) {
      rmSync(path, { force: true });
      continue;
    }
    if (Date.now() >= until) {
      throw new Error(`another writer holds ${path}${holder ? ` (pid ${holder.pid} on ${holder.host}, since ${holder.since})` : ''}, after ${waitMs} ms of waiting`);
    }
    await sleep(Math.min(1000, Math.max(10, until - Date.now())));
  }
}

/**
 * Write the deep store for `key` under `cacheRoot`, unless a complete entry
 * for it is there by the time this writer holds the key's lock.
 * - `keyParts`: `{ lane, configurationName, recipeHash, versions }`.
 * - `script`: `prefix(turns)` (its steps from an empty store), `extend(from,
 *   to)` (the steps of turns `from + 1` to `to`), and the length trial's
 *   `min`, `step` and `bound`, in turns.
 * - `runSteps({ steps, storeDir, epoch, label })` runs steps on the store at
 *   `storeDir` from virtual time `epoch`, resolving `{ ok, failure, clockEnd }`.
 * - `trial({ dataDir, epoch })` runs the continuation on a copy and resolves
 *   `{ missing }`, the declared products it didn't produce.
 * - `hardChecks({ dataDir, epoch })` resolves the outcome of the hard checks
 *   over the written store, recorded as it is.
 * Resolves `{ dir, entry, written }`; rejects naming why when a run fails, a
 * trial or the hard checks can't run, or the lock stays held past `lockWaitMs`.
 */
export async function writeEntry({ cacheRoot, key, keyParts, script, runSteps, trial, hardChecks, epoch, work, lockWaitMs = 30 * 60_000 }) {
  mkdirSync(cacheRoot, { recursive: true });
  const dir = join(cacheRoot, key);
  const release = await takeLock(join(cacheRoot, `.${key}.lock`), lockWaitMs);
  const tmp = join(cacheRoot, `.${key}.tmp`);
  try {
    const existing = readEntry(dir);
    if (existing?.complete === true) return { dir, entry: existing, written: false };
    rmSync(tmp, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    const storeDir = join(tmp, 'store');
    mkdirSync(storeDir, { recursive: true });
    mkdirSync(work, { recursive: true });

    const run = async (steps, at, label) => {
      const res = await runSteps({ steps, storeDir, epoch: at, label });
      if (!res.ok) throw new Error(`the ${label} failed: ${res.failure?.reason ?? JSON.stringify(res.failure)}`);
      return res.clockEnd;
    };
    let turns = script.min;
    let clock = await run(script.prefix(turns), epoch, `prefix of ${turns} turns`);
    const lengths = [];
    for (;;) {
      const copy = join(work, `trial-${turns}`);
      rmSync(copy, { recursive: true, force: true });
      cpSync(storeDir, copy, { recursive: true });
      const { missing } = await trial({ dataDir: copy, epoch: clock });
      rmSync(copy, { recursive: true, force: true });
      lengths.push({ turns, missing });
      if (missing.length === 0 || turns >= script.bound) break;
      const next = Math.min(turns + script.step, script.bound);
      clock = await run(script.extend(turns, next), clock, `prefix's turns ${turns + 1} to ${next}`);
      turns = next;
    }
    const checks = await hardChecks({ dataDir: storeDir, epoch: clock });
    const entry = {
      ...keyParts,
      key,
      prefixTurns: turns,
      clockEnd: clock,
      trial: { lengths, missing: lengths.at(-1).missing },
      hardChecks: checks,
      writtenAt: new Date().toISOString(),
      complete: true,
    };
    writeFileSync(join(tmp, 'entry.json'), JSON.stringify(entry, null, 1));
    renameSync(tmp, dir);
    return { dir, entry, written: true };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    release();
  }
}
