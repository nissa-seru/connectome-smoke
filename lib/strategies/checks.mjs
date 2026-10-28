/**
 * The strategy fixture's checks, from what a run recorded: the stand-in's records
 * (lib/strategies/standin.mjs, close()) and the driver's run log (lib/strategies/driver.mjs).
 * Each check returns flags, `{ check, step, request?, message }`; a flag is a break.
 */

/**
 * Check 2: each continuation segment produced what it exists for. Returns the segments
 * with a missing product, `{ segment, missing: [names] }`, in script order. A record
 * belongs to the segment of the step it arrived in.
 */
export function declaredProducts(records, script, products) {
  const segmentOf = new Map(script.map((s) => [s.id, s.segment]));
  const out = [];
  for (const [segment, wanted] of Object.entries(products)) {
    if (!script.some((s) => s.segment === segment)) continue;
    const mine = records.filter((r) => segmentOf.get(r.step) === segment);
    const missing = wanted.filter((p) => !mine.some((r) => p.test(r))).map((p) => p.name);
    if (missing.length) out.push({ segment, missing });
  }
  return out;
}

/** Check 1: every turn answers. Requests the stand-in refused or couldn't classify, failure
 *  events in the run log, and checkpoints that didn't settle. */
export function everyTurnAnswers(records, log = []) {
  const flags = [];
  for (const r of records) {
    if (r.kind === 'unclassified') flags.push({ check: 1, step: r.step, request: r.id, message: `unclassified request: ${r.reason}` });
    else if (r.refused) flags.push({ check: 1, step: r.step, request: r.id, message: `the stand-in refused it (${r.refused})` });
  }
  for (const e of log) {
    if (e.kind === 'ipc' && /^inference:(failed|exhausted)$/.test(e.event?.type ?? '')) flags.push({ check: 1, step: e.step, message: `${e.event.type}: ${e.event.error ?? e.event.reason ?? ''}`.trim() });
    if (e.kind === 'settle' && e.phase === 'end' && e.settled === false) flags.push({ check: 1, step: e.step, message: 'the checkpoint did not settle' });
  }
  return flags;
}

/** Check 3, the shape of each request: roles alternate, and every tool result answers a
 *  call in the message right before it, and every call before the last message is answered
 *  in the message right after it. */
export function wellFormed(records) {
  const flags = [];
  for (const r of records) {
    if (r.kind !== 'agent' && r.kind !== 'summariser') continue;
    const ms = r.messages || [];
    for (let i = 1; i < ms.length; i++) {
      if (ms[i].role === ms[i - 1].role) { flags.push({ check: 3, step: r.step, request: r.id, message: `messages ${i - 1} and ${i} are both ${ms[i].role}'s` }); break; }
    }
    for (let i = 0; i < ms.length; i++) {
      const calls = new Set(ms[i].blocks.filter((b) => b.type === 'tool_use').map((b) => b.toolUseId));
      const results = new Set(ms[i].blocks.filter((b) => b.type === 'tool_result').map((b) => b.toolUseId));
      const before = new Set((ms[i - 1]?.blocks || []).filter((b) => b.type === 'tool_use').map((b) => b.toolUseId));
      const after = new Set((ms[i + 1]?.blocks || []).filter((b) => b.type === 'tool_result').map((b) => b.toolUseId));
      for (const id of results) if (!before.has(id)) flags.push({ check: 3, step: r.step, request: r.id, message: `message ${i}'s result ${id} answers no call in the message before it` });
      if (i < ms.length - 1) for (const id of calls) if (!after.has(id)) flags.push({ check: 3, step: r.step, request: r.id, message: `message ${i}'s call ${id} has no result in the message after it` });
    }
  }
  return flags;
}
