/**
 * What a resident meets when a host release moves its store to a newer chronicle format,
 * for lanes/store-move.mjs: whether the store moves, whether the release still gives the
 * resident everything the release before it gave, whether a second boot on the moved store
 * does too, and whether the release before refuses the moved store without writing to it.
 *
 * chronicle's MANIFEST is the magic `RST\0` and a version byte; version 2 adds a
 * little-endian u64 of format feature bits, bit 0 for `AppendMany` records, and builds
 * that know only version 1 refuse it at open ("Unsupported store version: 2"). chronicle
 * 0.5.1's open reads the MANIFEST before it takes the store's LOCK (src/store.rs), so a
 * refusal there writes nothing.
 *
 * "Given" is judged by the record, not by the request's bytes (the cache line is
 * lib/cache-write.mjs's): a stored row, a message or a summary, is given to the resident
 * when each of its texts appears in the request's messages, as JSON carries it. A row is
 * reachable when the resident's recipe gives it history tools (agent-framework's history
 * module) and context-manager's indexed record query, which those tools read, returns it;
 * a recipe without them gives the resident no way back to a row it isn't given. Node's
 * own modules only.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const MAGIC = Buffer.from('RST\0', 'latin1');

/** Format feature bits chronicle's MANIFEST names. */
export const FEATURES = { appendMany: 1 };

/** A MANIFEST's bytes read as chronicle writes them: `{ version, features }`, or `error`. */
export function readManifest(buf) {
  if (buf.length < 5 || !buf.subarray(0, 4).equals(MAGIC)) return { error: `not a chronicle MANIFEST (${buf.length} bytes)` };
  const version = buf[4];
  if (version === 1) return buf.length === 5 ? { version, features: 0 } : { version, error: `version 1 with ${buf.length - 5} bytes after its header` };
  if (version === 2) return buf.length === 13 ? { version, features: Number(buf.readBigUInt64LE(5)) } : { version, error: `version 2 in ${buf.length} bytes, not 13` };
  return { version, error: `version ${version}, which no chronicle release writes` };
}

/** Every entry under `dir`, not following links, as a map from its path (relative, with `/`)
 *  to a digest: a file's size and sha256, a link's target, or `dir`. */
export function treeDigest(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const rel = relative(dir, p).split(sep).join('/');
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out[rel] = `link ${readlinkSync(p)}`;
      else if (st.isDirectory()) { out[rel] = 'dir'; walk(p); }
      else out[rel] = `file ${st.size} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
    }
  };
  walk(dir);
  return out;
}

/** The stores under a data directory: each directory holding a file named MANIFEST, by its
 *  path relative to `dataDir`, with what its MANIFEST reads. From a digest, so the same
 *  walk serves both. */
export function storesIn(dataDir, digest = treeDigest(dataDir)) {
  return Object.keys(digest).filter((p) => p === 'MANIFEST' || p.endsWith('/MANIFEST'))
    .map((p) => ({ store: p === 'MANIFEST' ? '.' : p.slice(0, -'/MANIFEST'.length), ...readManifest(readFileSync(join(dataDir, p))) }));
}

/** What changed between two digests: paths added, removed and changed, each sorted. */
export function treeChanges(before, after) {
  const added = Object.keys(after).filter((p) => !(p in before)).sort();
  const removed = Object.keys(before).filter((p) => !(p in after)).sort();
  const changed = Object.keys(after).filter((p) => p in before && before[p] !== after[p]).sort();
  return { added, removed, changed };
}

/** Whether every text of a row appears in a request's messages as JSON carries it. A row
 *  with no text can't be judged this way, and is `null`. */
export function givenIn(messagesJson, texts) {
  if (!texts.length) return null;
  return texts.every((t) => messagesJson.includes(JSON.stringify(t).slice(1, -1)));
}

/** The record's rows, messages and summaries, each `{ kind, id, texts }`, a message with its participant. */
export const rowsOf = (record) => [
  ...record.messages.map((m) => ({ kind: 'message', id: m.id, participant: m.participant, texts: m.texts })),
  ...record.summaries.map((s) => ({ kind: 'summary', id: s.id, texts: s.text ? [s.text] : [] })),
];

/** How many times `needle` occurs in `hay`, none overlapping. */
const occurrences = (hay, needle) => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
};

/** How many copies of a row with these texts a request's JSON carries: the fewest times any
 *  of its texts occurs there. */
export const copiesIn = (json, texts) => Math.min(...texts.map((t) => occurrences(json, JSON.stringify(t).slice(1, -1))));

/**
 * Which of `rows` the earlier release gave the resident and the later one doesn't. `before`
 * is the earlier release's requests (one or more runs: a row counts as given only where
 * every run gave it, so one only some control runs gave is `unsteady`, not lost), and
 * `after` the later's. Rows with the same texts, such as a notice a host writes after many
 * turns, can't be told apart by text, so they're judged as a group: a request gives as many
 * of them as it carries copies of their text, up to the group's size, and those given, lost
 * or unsteady are named as the group's first, next and so on, whichever rows they were.
 * Returns how many rows were given before and which (`givenRows`), those lost, the
 * unsteady ones, and how many rows have no text to judge by.
 */
export function givenCheck(rows, before, after) {
  const jsonBefore = before.map((m) => JSON.stringify(m));
  const jsonAfter = JSON.stringify(after);
  const judged = rows.filter((r) => r.texts.length);
  const groups = new Map();
  for (const r of judged) { const key = JSON.stringify(r.texts); groups.set(key, [...(groups.get(key) ?? []), r]); }
  const givenRows = []; const unsteady = []; const lost = [];
  for (const group of groups.values()) {
    const given = (json) => Math.min(group.length, copiesIn(json, group[0].texts));
    const counts = jsonBefore.map(given);
    const steady = Math.min(...counts);
    givenRows.push(...group.slice(0, steady));
    unsteady.push(...group.slice(steady, Math.max(...counts)));
    lost.push(...group.slice(Math.min(given(jsonAfter), steady), steady));
  }
  return { given: givenRows.length, givenRows, lost, unsteady, untexted: rows.length - judged.length };
}

/** Of `lost` rows, those the resident can't reach again: all of them without history tools;
 *  with them, a message the indexed query didn't return, and every summary but those the
 *  record still holds (the history tools' overview reads summaries). */
export function unreachable(lost, { historyTools, record }) {
  if (!historyTools) return lost;
  const indexed = new Set(record.indexed);
  const summaries = new Set(record.summaries.map((s) => s.id));
  return lost.filter((r) => (r.kind === 'message' ? !indexed.has(r.id) : !summaries.has(r.id)));
}

/** Whether a recipe gives its resident agent-framework's history tools. */
export const hasHistoryTools = (recipe) => Boolean(recipe?.modules?.history);

/**
 * A rollback boot's verdict: the earlier release booted on a store the later one moved.
 * `outcome` is `{ opened, error }`: whether it took a turn, and if not what it said;
 * `changes` is treeChanges over the store directories' digests, before and after.
 * Clean when it didn't open, said the store's version is one it doesn't support, and
 * changed nothing in any store.
 */
export function rollbackVerdict({ outcome, changes }) {
  const wrote = [...changes.added, ...changes.removed, ...changes.changed];
  const names = /Unsupported store version: 2/.test(outcome.error ?? '');
  return { refused: !outcome.opened, namesVersion: names, wrote, clean: !outcome.opened && names && wrote.length === 0 };
}

/** The digest's entries inside any of `stores` (paths relative to the same data directory). */
export function withinStores(digest, stores) {
  const dirs = stores.map((s) => s.store);
  return Object.fromEntries(Object.entries(digest).filter(([p]) => dirs.some((d) => d === '.' || p === d || p.startsWith(`${d}/`))));
}
