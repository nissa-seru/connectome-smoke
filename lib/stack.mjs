/**
 * Pure helpers for the source lane: parsing --change, the stack's dependency
 * graph (derived from each checkout's package.json, so it can't go stale),
 * semver range checks for the links the combined tree makes, and how an
 * install failure is classified. No I/O here, so test/stack.test.mjs can
 * exercise all of it without a run.
 */

/**
 * `<repo>=pull/<n>[@<sha>]` or `<repo>=<owner>:<branch>[@<sha>]`.
 * The pin is the head the caller saw; the lane refuses to test any other.
 */
export function parseChange(arg) {
  const m = /^([A-Za-z0-9_.-]+)=(.+)$/.exec(arg ?? '');
  if (!m) throw new Error(`--change ${arg}: expected <repo>=pull/<n> or <repo>=<owner>:<branch>, optionally ending @<sha>`);
  const repo = m[1];
  let spec = m[2];
  let pin = null;
  const at = spec.lastIndexOf('@');
  if (at > 0) {
    pin = spec.slice(at + 1);
    spec = spec.slice(0, at);
    if (!/^[0-9a-f]{7,40}$/.test(pin)) throw new Error(`--change ${arg}: the pin after @ must be 7 to 40 hex digits of a commit`);
  }
  const pull = /^pull\/(\d+)$/.exec(spec);
  if (pull) return { repo, spec, kind: 'pull', pr: Number(pull[1]), pin };
  const branch = /^([A-Za-z0-9_.-]+):(.+)$/.exec(spec);
  if (branch) return { repo, spec, kind: 'branch', owner: branch[1], branch: branch[2], pin };
  throw new Error(`--change ${arg}: expected pull/<n> or <owner>:<branch> after =`);
}

// ------------------------------------------------------------------ semver

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}

function cmp(a, b) {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;   // a release outranks its prereleases
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/** A partial version such as `1`, `1.2` or `1.2.x`, as [lower, exclusive upper]. */
function partialBounds(p) {
  const parts = p.replace(/^v/, '').split('.');
  const nums = [];
  for (const part of parts) {
    if (/^(x|X|\*)$/.test(part)) break;
    if (!/^\d+$/.test(part)) return null;
    nums.push(Number(part));
  }
  if (nums.length === 3) return null;   // a full version, not a partial one
  const lower = { major: nums[0] ?? 0, minor: nums[1] ?? 0, patch: 0, pre: null };
  if (nums.length === 0) return [lower, null];
  const upper = nums.length === 1
    ? { major: nums[0] + 1, minor: 0, patch: 0, pre: null }
    : { major: nums[0], minor: nums[1] + 1, patch: 0, pre: null };
  return [lower, upper];
}

function satisfiesComparator(v, comp) {
  if (comp === '' || comp === '*' || comp === 'x' || comp === 'latest') return true;
  let m;
  if ((m = /^\^(.+)$/.exec(comp))) {
    const b = parseVersion(m[1]);
    if (!b) { const pb = partialBounds(m[1]); if (!pb) return null; return cmp(v, pb[0]) >= 0 && (!pb[1] || cmp(v, pb[1]) < 0); }
    const upper = b.major > 0 ? { major: b.major + 1, minor: 0, patch: 0, pre: null }
      : b.minor > 0 ? { major: 0, minor: b.minor + 1, patch: 0, pre: null }
      : { major: 0, minor: 0, patch: b.patch + 1, pre: null };
    return cmp(v, b) >= 0 && cmp(v, upper) < 0;
  }
  if ((m = /^~(.+)$/.exec(comp))) {
    const b = parseVersion(m[1]);
    if (!b) { const pb = partialBounds(m[1]); if (!pb) return null; return cmp(v, pb[0]) >= 0 && (!pb[1] || cmp(v, pb[1]) < 0); }
    return cmp(v, b) >= 0 && cmp(v, { major: b.major, minor: b.minor + 1, patch: 0, pre: null }) < 0;
  }
  if ((m = /^(>=|<=|>|<|=)\s*(.+)$/.exec(comp))) {
    const b = parseVersion(m[2]);
    if (!b) return null;
    const c = cmp(v, b);
    return { '>=': c >= 0, '<=': c <= 0, '>': c > 0, '<': c < 0, '=': c === 0 }[m[1]];
  }
  const exact = parseVersion(comp);
  if (exact) return cmp(v, exact) === 0;
  const pb = partialBounds(comp);
  if (pb) return cmp(v, pb[0]) >= 0 && (!pb[1] || cmp(v, pb[1]) < 0);
  return null;
}

/**
 * Does `version` satisfy the declared `range`? true, false, or null when the
 * range is a form this doesn't read. `file:` and `link:` ranges admit
 * whatever the path holds, which is what a sibling deployment loads.
 */
export function satisfies(version, range) {
  const r = String(range ?? '').trim();
  if (/^(file|link|workspace):/.test(r)) return true;
  const v = parseVersion(version);
  if (!v) return null;
  let unknown = false;
  for (const alt of r.split('||')) {
    const comps = alt.trim().split(/\s+/).filter(Boolean);
    let all = true;
    for (const c of comps.length ? comps : ['*']) {
      const ok = satisfiesComparator(v, c);
      if (ok === null) { unknown = true; all = false; break; }
      if (!ok) { all = false; break; }
    }
    // A prerelease only satisfies a range that names a prerelease itself.
    if (all && v.pre !== null && !/-/.test(alt)) all = false;
    if (all) return true;
  }
  return unknown ? null : false;
}

// ------------------------------------------------------------------ graph

/**
 * Edges between stack packages, from what each package declares:
 * dependencies, devDependencies and peerDependencies, `file:` links included.
 * `pkgs` is [{ key, name, pj }]; an edge {dep, dependent, range, field}.
 */
export function buildGraph(pkgs) {
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const edges = [];
  for (const p of pkgs) {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(p.pj?.[field] ?? {})) {
        const dep = byName.get(name);
        if (dep && dep.key !== p.key) edges.push({ dep: dep.key, dependent: p.key, range, field });
      }
    }
  }
  return edges;
}

/**
 * Every package that depends on one of `changed`, directly or not, with the
 * edge that first reached it (breadth-first, so the shortest chain).
 */
export function dependentsOf(changed, edges) {
  const seen = new Set(changed);
  const via = new Map();
  const queue = [...changed];
  while (queue.length) {
    const cur = queue.shift();
    for (const e of edges) {
      if (e.dep !== cur || seen.has(e.dependent)) continue;
      seen.add(e.dependent);
      via.set(e.dependent, e);
      queue.push(e.dependent);
    }
  }
  return [...via.entries()].map(([pkg, e]) => ({ pkg, via: { dep: e.dep, range: e.range, field: e.field } }));
}

/** Dependencies before dependents; ties keep the order of `keys`. Throws on a cycle. */
export function topoOrder(keys, edges) {
  const set = new Set(keys);
  const indeg = new Map(keys.map((k) => [k, 0]));
  const rel = edges.filter((e) => set.has(e.dep) && set.has(e.dependent));
  for (const e of rel) indeg.set(e.dependent, indeg.get(e.dependent) + 1);
  const out = [];
  const ready = keys.filter((k) => indeg.get(k) === 0);
  while (ready.length) {
    const k = ready.shift();
    out.push(k);
    for (const e of rel) {
      if (e.dep !== k) continue;
      indeg.set(e.dependent, indeg.get(e.dependent) - 1);
      if (indeg.get(e.dependent) === 0) {
        // keep the caller's order among the newly ready
        const idx = ready.findIndex((r) => keys.indexOf(r) > keys.indexOf(e.dependent));
        if (idx < 0) ready.push(e.dependent); else ready.splice(idx, 0, e.dependent);
      }
    }
  }
  if (out.length !== keys.length) throw new Error(`dependency cycle among: ${keys.filter((k) => !out.includes(k)).join(', ')}`);
  return out;
}

// ------------------------------------------------------------------ failures

/**
 * The failing tests a test run printed, by name, as its runner prints them:
 * bun's `(fail) <suite> > <name>`, node's spec `✖ <name>`, TAP's
 * `not ok <n> - <name>`, and vitest's `× <name>` or `FAIL <file> > <name>`.
 * Node's spec reporter also closes a suite holding a failure with `✖ <suite>`;
 * a name it opened with `▶ <suite>` is a suite, and is left out. Timings are
 * stripped and each name appears once. An empty list from a run that failed
 * means the output couldn't be read, which the caller records.
 */
export function parseTestFailures(output) {
  const names = new Set();
  const suites = new Set();
  for (const raw of String(output ?? '').split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    let m;
    if ((m = /^\s*▶\s+(.+?)\s*$/.exec(line))) suites.add(m[1]);
    else if ((m = /^\s*\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?\s*$/.exec(line))) names.add(m[1]);
    else if (/^\s*✖\s+failing tests:?\s*$/.test(line)) continue;
    else if ((m = /^\s*✖\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*$/.exec(line))) names.add(m[1]);
    else if ((m = /^\s*not ok \d+ - (.+?)(?:\s+#\s.*)?\s*$/.exec(line))) names.add(m[1]);
    else if ((m = /^\s*(?:×|FAIL)\s+(.+?)(?:\s+\d+(?:\.\d+)?m?s)?\s*$/.exec(line))) names.add(m[1]);
  }
  return [...names].filter((n) => !suites.has(n));
}

/**
 * Why an install failed, from npm's own error lines:
 *   lockfile — package.json and the lockfile disagree (the commit's break)
 *   network  — registry or network trouble (the check couldn't run)
 *   disk     — out of space (the check couldn't run)
 *   other    — anything else: a postinstall, a missing package (a break)
 */
export function classifyInstallFailure(output) {
  const text = String(output ?? '');
  if (/ENOSPC|no space left on device/i.test(text)) return { cause: 'disk', infra: true };
  const npmLines = text.split('\n').filter((l) => /^npm (error|ERR!)/.test(l)).join('\n');
  if (/can only install packages when your package\.json and package-lock\.json|are not in sync|Missing: .+ from lock file|Invalid: lock file's/i.test(npmLines)) {
    return { cause: 'lockfile', infra: false };
  }
  if (/E(TIMEDOUT|CONNRESET|CONNREFUSED|AI_AGAIN|NOTFOUND)|socket hang up|network request|code E(5\d\d|429)\b|fetch failed/i.test(npmLines)) {
    return { cause: 'network', infra: true };
  }
  return { cause: 'other', infra: false };
}
