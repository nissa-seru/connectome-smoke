/**
 * Lanes of the source lane's check: `--lane I/N` runs lane I of a check
 * split into N lanes, each on its own machine.
 *
 * Contract with whoever runs the lanes and folds their reports into one:
 * - Every lane is given the same arguments, so every lane merges the same
 *   heads onto the same mains and computes the same plan from the same tree.
 * - The plan is the check's units, in order (planUnits). Unit k runs in lane
 *   k mod N, and only there. Every lane with units runs every prep step
 *   (clone and merge, install, own build, compose, resolution proof, combined
 *   build).
 * - Every report carries `lanes: { index, of, plan, units }`, laned or not
 *   (a run with no --lane is 0/1), except one whose --lane was refused, where
 *   `lanes` is null; `plan` and `units` are null when the run stopped before
 *   the plan existed. Every work step's record, run or skipped, carries its
 *   `unit`; prep steps carry none. A lane that stops early records one
 *   skipped step for each of its units that has no record yet.
 * - A lane with no units stops after its clones.
 * - The check's outcome is the worst of its lanes' outcomes, conflict > error
 *   > break > pass: outcomeOf over the union of the lanes' steps, with the
 *   fatal error of any lane that had one, equals the worst of outcomeOf over
 *   each lane's.
 */

/** `I/N` with 0 <= I < N; no value is 0/1. */
export function parseLane(value) {
  if (value === undefined || value === null) return { index: 0, of: 1 };
  const m = /^(0|[1-9]\d*)\/([1-9]\d*)$/.exec(String(value));
  if (!m || !Number.isSafeInteger(Number(m[2])) || Number(m[1]) >= Number(m[2])) {
    throw new Error(`--lane ${value}: expected I/N, whole numbers with 0 <= I < N, such as 0/3`);
  }
  return { index: Number(m[1]), of: Number(m[2]) };
}

/**
 * The check's units, in the order lanes take them:
 * - `<pkg>:own` for each package in the own set, in the stack's order, that
 *   has an own typecheck or test, and for the host, which also boots there;
 * - `<pkg>:combined` for each package in the combined set with a stack
 *   dependency and a typecheck or test, in dependency order;
 * - `<host>:starts`: the combined host's boots, stored fixtures and strategy
 *   fixture.
 * `checks(pkg)` says whether a package has a typecheck or a test.
 */
export function planUnits({ pkgs, order, edges, ownSet, combinedSet, host, checks }) {
  const byKey = new Map(pkgs.map((p) => [p.key, p]));
  const hasStackDeps = new Set(edges.map((e) => e.dependent));
  const own = pkgs.filter((p) => ownSet.has(p.key) && (checks(p) || p.key === host)).map((p) => `${p.key}:own`);
  const combined = order.filter((k) => combinedSet.has(k) && hasStackDeps.has(k) && checks(byKey.get(k))).map((k) => `${k}:combined`);
  return [...own, ...combined, `${host}:starts`];
}

/** The units lane `index` of `of` runs. */
export function laneUnits(plan, { index, of }) {
  return plan.filter((_, k) => k % of === index);
}

/**
 * The units a lane that stopped early at `stoppedAt` records as not run: those
 * no step record carries. A lane that ran to its end records none, so a unit it
 * planned and never ran stays unrecorded, for a fold to refuse.
 */
export function notRunUnits({ units, steps, stoppedAt }) {
  if (!stoppedAt) return [];
  const recorded = new Set(steps.map((s) => s.unit).filter(Boolean));
  return units.filter((u) => !recorded.has(u));
}

/**
 * A run's outcome from its steps: conflict, else error (refused arguments, a
 * fatal error, a step that failed because the check couldn't run, or in change
 * mode an unchanged package failing in its own tree), else break, else pass.
 * `unjudged` names those unchanged packages' steps.
 */
export function outcomeOf({ mode, fatal, steps }) {
  if (steps.some((s) => s.cause === 'conflict')) return { outcome: 'conflict', unjudged: null };
  if (fatal || steps.some((s) => s.status === 'fail' && s.infra)) return { outcome: 'error', unjudged: null };
  if (mode === 'change') {
    const mainSide = steps.filter((s) => s.status === 'fail' && s.tree === 'own' && s.changed === false);
    if (mainSide.length) return { outcome: 'error', unjudged: mainSide.map((s) => s.id) };
  }
  if (steps.some((s) => s.status === 'fail')) return { outcome: 'break', unjudged: null };
  return { outcome: 'pass', unjudged: null };
}
