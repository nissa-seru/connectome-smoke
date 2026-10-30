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

/**
 * What a check covers. Own set: the changed packages (every package in main
 * mode), checked in their own install. Combined set: those, every package
 * depending on them, and the host (every package in main mode). Whether the
 * host is a change or a dependent (always in main mode).
 */
export function checkScope({ keys, changedKeys, edges, mode, host }) {
  const dependents = mode === 'main' ? [] : dependentsOf(changedKeys, edges);
  const ownSet = new Set(mode === 'main' ? keys : changedKeys);
  const combinedSet = new Set(mode === 'main' ? keys : [...changedKeys, ...dependents.map((d) => d.pkg), host]);
  const reachesHost = mode === 'main' || changedKeys.includes(host) || dependents.some((d) => d.pkg === host);
  return { dependents, ownSet, combinedSet, reachesHost };
}

/** A package's typecheck: its `typecheck` script, else its repository's named command, else none. */
export function typecheckCommand(p) {
  return p.pj?.scripts?.typecheck ? 'npm run typecheck' : p.R?.typecheck ?? null;
}

/**
 * A package's tests: the script its repository's CI runs (`testScript`, run
 * with node or bash by its extension) where the checkout has it, else its
 * `test` script, else none. `has(path)` says whether the package's directory
 * holds that file.
 */
export function testCommand(p, has) {
  const s = p.R?.testScript;
  if (s && has(s)) return `${/\.m?js$/.test(s) ? 'node' : 'bash'} ${s}`;
  return p.pj?.scripts?.test ? 'npm test' : null;
}

/**
 * The merge of a change's head onto the checkout's HEAD, with its author,
 * committer and both dates (the head's committer date, `headDate`) fixed, so
 * the merge commit depends only on HEAD, the head and the spec named in its
 * message, whatever author or committer the environment names.
 */
export function mergeCommand(spec, headSha, headDate) {
  return {
    argv: ['git', 'merge', '--no-ff', '--no-edit', '-m', `smoke: merge ${spec}`, headSha],
    env: {
      GIT_AUTHOR_NAME: 'connectome-smoke', GIT_AUTHOR_EMAIL: 'smoke@localhost', GIT_AUTHOR_DATE: headDate,
      GIT_COMMITTER_NAME: 'connectome-smoke', GIT_COMMITTER_EMAIL: 'smoke@localhost', GIT_COMMITTER_DATE: headDate,
    },
  };
}

/**
 * Why the host's starts can't run, or null when they can. `fail` is true
 * when nothing earlier has failed for that reason: heartbeat-mcpl's build
 * ran without failing and still made no entry.
 */
export function startsBlocked({ hostCheckout, hostInstalled, heartbeatEntry, heartbeatBuildFailed }) {
  if (!hostCheckout) return { fail: false, why: 'no host checkout' };
  if (!hostInstalled) return { fail: false, why: 'the host\'s install failed' };
  if (heartbeatEntry.exists) return null;
  return heartbeatBuildFailed
    ? { fail: false, why: `heartbeat-mcpl's ${heartbeatEntry.path} is missing (its build failed)` }
    : { fail: true, why: `heartbeat-mcpl's build made no ${heartbeatEntry.path}` };
}

// ------------------------------------------------------------------ failures

/**
 * The failing tests a test run printed, by name, as its runner prints them:
 * bun's `(fail) <suite> > <name>`, node's spec `✖ <name>`, TAP's
 * `not ok <n> - <name>`, and vitest's `× <name>` or `FAIL <file> > <name>`.
 * Node's spec reporter also closes a suite holding a failure with `✖ <suite>`;
 * a name it opened with `▶ <suite>` is a suite, and is left out. In the list
 * of failures node prints at the end, after `✖ failing tests:`, an indented
 * line is part of a failure's details, not a test. Vitest names
 * a failing test twice, by its own name in its file's tree (`×`) and by its
 * whole path in the list of failed tests at the end (`FAIL`), so where that
 * list is there, its names are the ones taken. Timings are stripped and each
 * name appears once. An empty list from a run that failed means the output
 * couldn't be read, which the caller records.
 */
export function parseTestFailures(output) {
  const names = new Set();
  const suites = new Set();
  const vitestTree = new Set();
  const vitestListed = new Set();
  let nodeList = false;
  for (const raw of String(output ?? '').split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    let m;
    if (/^\s*✖\s+failing tests:?\s*$/.test(line)) nodeList = true;
    else if (nodeList && /^\s/.test(line)) continue;
    else if ((m = /^\s*▶\s+(.+?)\s*$/.exec(line))) suites.add(m[1]);
    else if ((m = /^\s*\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?\s*$/.exec(line))) names.add(m[1]);
    else if ((m = /^\s*✖\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*$/.exec(line))) names.add(m[1]);
    else if ((m = /^\s*not ok \d+ - (.+?)(?:\s+#\s.*)?\s*$/.exec(line))) names.add(m[1]);
    else if ((m = /^\s*×\s+(.+?)(?:\s+\d+(?:\.\d+)?m?s)?\s*$/.exec(line))) vitestTree.add(m[1]);
    else if ((m = /^\s*FAIL\s+(.+?)(?:\s+\d+(?:\.\d+)?m?s)?\s*$/.exec(line))) vitestListed.add(m[1]);
  }
  const vitest = vitestListed.size ? vitestListed : vitestTree;
  return [...names, ...vitest].filter((n) => !suites.has(n));
}

/**
 * What a test run's own runner says in its summary: how many tests failed,
 * how many errors it reports outside its tests, and whose summary it is.
 * The counts are node's `ℹ fail N`; TAP's `# fail N`; bun's `N fail`, which
 * also counts a test file that failed to load, and `N errors` (or `1
 * error`), which counts that too, and an error thrown outside any test; and
 * vitest's `Tests  N failed` and `Errors  N errors`, its count of unhandled
 * errors, which fail no test. A runner prints its summary last, so the last
 * count of failed tests wins over one a test printed earlier, such as a
 * nested run's, and an errors line counts only after it, as bun and vitest
 * print theirs. `failed` and `form` are null when no count printed at all; a
 * report cut short before its own summary takes a count a test printed
 * earlier, if one did.
 */
export function runnerSummary(output) {
  let failed = null;
  let errors = null;
  let form = null;
  const count = (n, by) => { [failed, form, errors] = [Number(n), by, null]; };
  for (const raw of String(output ?? '').split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    let m;
    if ((m = /^ℹ fail (\d+)\s*$/.exec(line))) count(m[1], 'node');
    else if ((m = /^# fail (\d+)\s*$/.exec(line))) count(m[1], 'tap');
    else if ((m = /^\s*(\d+) fail\s*$/.exec(line))) count(m[1], 'bun');
    else if ((m = /^\s*(\d+) errors?\s*$/.exec(line))) errors = Number(m[1]);
    else if ((m = /^\s*Tests\s+(\d+) failed\b/.exec(line))) count(m[1], 'vitest');
    else if ((m = /^\s*Errors\s+(\d+) errors?\b/.exec(line))) errors = Number(m[1]);
  }
  return { failed, errors, form };
}

/**
 * The failing tests node's spec reporter lists at the end of its report,
 * after `✖ failing tests:`: its own list of what failed, with the tests a
 * failing hook cancelled, a suite whose hook failed and a test that failed
 * itself besides its subtests, and without a test that failed only through
 * its subtests. null when there's no such list, as from another runner or
 * from a report cut short before it; a report cut inside it gives the names
 * listed before the cut.
 */
export function nodeFailingTests(output) {
  let listed = null;
  for (const raw of String(output ?? '').split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    let m;
    if (/^\s*✖\s+failing tests:?\s*$/.test(line)) listed = [];
    else if (listed && (m = /^✖\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*$/.exec(line))) listed.push(m[1]);
  }
  return listed;
}

/**
 * What a failing test step records of its failures: their names, the count
 * of failed tests its runner gave (`failureCount`), and whether the names
 * were read, which is when they're every failure the runner reports, so
 * that each can be weighed by name.
 *
 * Node's spec reporter lists its failures at the end, after its summary.
 * Where the summary is node's and that list printed, the list is the names,
 * since it's node's own reckoning of what failed: a test that failed itself
 * besides its subtests, a suite whose hook failed, and the tests that hook
 * cancelled. Every test the report printed as failing before the list must
 * be in it, so a list cut short before one of those is unread. A group's own
 * closing line can't be held to that, since node closes a parent that failed
 * only through its subtests the same way and leaves it out of the list, so a
 * list cut short just before a group's own entry reads as whole. Node's
 * count also takes in a test that failed only through its subtests, so it
 * can exceed the names and isn't what's compared, and a node summary with no
 * list after it is unread. Node prints no errors line, so node's check reads
 * none.
 *
 * Any other runner's count must equal the names, and it must report no error
 * outside its tests: a bun test file that wouldn't load, which bun counts as
 * a failure and an error, or an error bun or vitest reports outside any
 * test. A vitest file that wouldn't load, which vitest lists but doesn't
 * count, leaves the names one more than the count. Where two failures that
 * share a name are both named, the step is unread too, since a known name
 * can't vouch for a second failure that shares it; a node list cut short
 * after the first of them reads as whole. In each case a known test among
 * the names can't vouch for the rest of the step.
 *
 * A report cut short before any count printed is unread, unless the step
 * was stopped at its time limit: such a step has nothing to check its names
 * against, and the cross-package runner never counts it as finished, so what
 * it named before the limit is read as it stands. Once a count has printed,
 * a timed-out step is checked like any other.
 *
 * The rule reads each runner's lines wherever they are in the output, so a
 * test that prints another runner's report, or a line shaped like a count,
 * an errors line or node's list, can make the step read wrongly either way:
 * what it printed stands in for what the runner's own output lacks.
 */
export function testFailureFields(output, { timedOut = false } = {}) {
  const printed = parseTestFailures(output);
  const { failed: failureCount, errors, form } = runnerSummary(output);
  const listed = form === 'node' ? nodeFailingTests(output) : null;
  const failures = listed ?? printed;
  const all = form === 'node'
    ? listed !== null && new Set(listed).size === listed.length && printed.every((n) => listed.includes(n))
    : !errors && failureCount === failures.length;
  return { failures, failureCount, failuresParsed: failures.length > 0 && (form ? all : timedOut) };
}

/**
 * Whether a filesystem is full the way ENOSPC means it, from what
 * fs.statfsSync reports: what's left to an unprivileged process (`bavail`)
 * is under 1 GiB, or its free inodes are under 1,024. ENOSPC comes when
 * either reaches 0, and the margin allows for up to that much being freed in
 * between, by the step's own cleanup or another run's. On a filesystem small
 * enough for those to be more than 1% of it, the margin is 1%. Blocks count in `frsize`, as statvfs defines them, or in
 * `bsize` where there's no `frsize`. A filesystem that counts no inodes, as
 * btrfs doesn't, reports 0 free of 0, which isn't under.
 */
export function filesystemFull(s) {
  const bytes = (s.frsize || s.bsize) * s.bavail;
  const size = (s.frsize || s.bsize) * s.blocks;
  return bytes < Math.min(2 ** 30, size / 100) || s.ffree < Math.min(1024, s.files / 100);
}

/**
 * Whether a failed step ran out of disk: its output says ENOSPC, and one of
 * `paths`, the filesystems the step writes to by default, read with `statfs`,
 * is nearly full now. A test can print ENOSPC with the disk far from full, so
 * the text alone never decides: a filesystem that can't be read counts as one
 * with room, and when none can be, the step reads as a break. A disk that
 * filled and was freed before this reads it reads as not full, and one a step
 * filled and left full reads as full.
 */
export function diskFull(output, paths, statfs) {
  if (!/ENOSPC|no space left on device/i.test(String(output ?? ''))) return false;
  return paths.some((p) => {
    let s;
    try { s = statfs(p); } catch { return false; }
    return filesystemFull(s);
  });
}

/**
 * Why an install failed, from npm's own error lines:
 *   lockfile — package.json and the lockfile disagree (the commit's break)
 *   network  — registry or network trouble (the check couldn't run)
 *   other    — anything else: a postinstall, a missing package (a break)
 * fail() reads a full disk from the disk itself (diskFull) before the cause
 * this returns applies.
 */
export function classifyInstallFailure(output) {
  const text = String(output ?? '');
  const npmLines = text.split('\n').filter((l) => /^npm (error|ERR!)/.test(l)).join('\n');
  if (/can only install packages when your package\.json and package-lock\.json|are not in sync|Missing: .+ from lock file|Invalid: lock file's/i.test(npmLines)) {
    return { cause: 'lockfile', infra: false };
  }
  if (/E(TIMEDOUT|CONNRESET|CONNREFUSED|AI_AGAIN|NOTFOUND)|socket hang up|network request|code E(5\d\d|429)\b|fetch failed/i.test(npmLines)) {
    return { cause: 'network', infra: true };
  }
  return { cause: 'other', infra: false };
}
