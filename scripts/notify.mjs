#!/usr/bin/env node
/**
 * Post the run's lane summaries to Discord (webhook in $DISCORD_WEBHOOK).
 * Reads every summary-*.md under the evidence dir (downloaded artifacts).
 * In the workflow each run writes summary-<lane>-<runtime>.md. $LANES (the
 * lanes the run requested, comma-separated) and $RUNTIMES (the workflow's
 * runtime list, JSON) say which runs to expect, and the post names each one
 * whose summary never reached it; without either, nothing can be checked,
 * and the post fails saying so. $FULL is 'true' for a run of every lane, and
 * $RESULT_PUBLISHED and $RESULT_SOURCE are the lane jobs' results: a job
 * that ran a requested lane and didn't end in success turns the post red.
 *
 * It also decides whether the workflow remembers the set as tested, and
 * writes remember=true to $GITHUB_OUTPUT when it does: once a run of every
 * lane had a result from every requested run, a summary passing or
 * failing, and the post went out or can't until someone acts (there's no
 * webhook, or Discord refused it for a reason the next poll would meet
 * too). A post that didn't go out for a passing reason, or a step stopped
 * before the post settled, writes nothing, so a later poll runs the set
 * again and posts.
 *
 * So that a passing failure doesn't cost a rerun of every lane, the post
 * is tried again within the step, three tries in all: after a rate limit,
 * once the wait Discord's answer gives is over (up to five minutes); after
 * a server error, a request that got no answer, or a rate limit whose
 * answer gives no wait, after a second, then two. A request that got no
 * answer may have been taken, so a later try, or a later poll's post, can
 * be a second copy.
 *
 * Without a webhook it prints what it would post. It then exits 0, or 1
 * under GitHub Actions, where an empty webhook means the secret is missing
 * and nobody was told.
 *
 * Usage: node scripts/notify.mjs <evidence-dir>
 */
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const dir = process.argv[2] ?? 'evidence';
const webhook = process.env.DISCORD_WEBHOOK;
const runUrl = process.env.RUN_URL ?? '';
const reason = process.env.REASON ?? '';

// What the post must say beyond the summaries.
const problems = [];
const why = (e) => e.code ?? e.message;

function* walk(d) {
  let ents;
  try { ents = readdirSync(d); }
  catch (e) { problems.push(`the evidence folder ${d} couldn't be read (${why(e)})`); return; }
  for (const n of ents) {
    const p = join(d, n);
    let isDir;
    try { isDir = statSync(p).isDirectory(); }
    catch (e) { problems.push(`the evidence entry ${p} couldn't be read (${why(e)})`); continue; }
    if (isDir) yield* walk(p);
    else if (/^summary-.*\.md$/.test(n)) yield p;
  }
}

// Each summary by the run that wrote it: summary-<lane>-<runtime>.md.
const summaries = new Map();
for (const p of [...walk(dir)].sort()) {
  try { summaries.set(basename(p).slice('summary-'.length, -'.md'.length), readFileSync(p, 'utf-8').trim()); }
  catch (e) { problems.push(`the summary ${p} couldn't be read (${why(e)})`); }
}

// The requested runs are the requested lanes on every runtime. A run whose
// summary isn't here never reported: its setup failed, it was cut off, or
// its evidence wasn't uploaded or downloaded. Its siblings' summaries can't
// stand in for it, so each is named.
const lanes = (process.env.LANES ?? '').split(',').map((l) => l.trim()).filter(Boolean);
if (lanes.length === 0) problems.push("the requested lanes (LANES) weren't given, so no run could be checked for a summary");
let runtimes = [];
try {
  runtimes = JSON.parse(process.env.RUNTIMES ?? '');
  if (!Array.isArray(runtimes) || runtimes.length === 0) throw new Error('not a list of runtimes');
  if (!runtimes.every((rt) => ['name', 'node', 'bun'].every((k) => typeof rt?.[k] === 'string' && rt[k] !== ''))) throw new Error('a runtime without a name, node or bun');
} catch {
  runtimes = [];
  problems.push("the workflow's runtime list (RUNTIMES) couldn't be read, so no run could be checked for a summary");
}
const requested = lanes.flatMap((lane) => runtimes.map((rt) => ({ lane, rt, run: `${lane}-${rt.name}` })));
for (const { lane, rt, run } of requested) {
  if (!summaries.has(run)) problems.push(`${lane} on ${rt.name} (Node ${rt.node}, Bun ${rt.bun}): no summary reached the report (infra/error)`);
}
// Every requested run reported, with a summary that says something.
const complete = requested.length > 0 && requested.every(({ run }) => summaries.get(run));

// A summary's verdict is on its first line; later lines can quote anything.
const passed = (s) => s.split('\n')[0].includes('✅ PASS');
const failing = [...summaries].filter(([, s]) => !passed(s));
const passing = [...summaries.values()].filter(passed);
// A lane job can end other than in success after its runs wrote passing
// summaries (a later step failed, or it was cancelled), and the post doesn't
// read green while the run doesn't. A job counts only when the run requested
// one of its lanes: the published job's legs for other lanes run nothing.
if (failing.length === 0 && problems.length === 0) {
  for (const [job, its, name] of [['Published lane', ['published', 'latest'], 'RESULT_PUBLISHED'], ['Source-main lane', ['source'], 'RESULT_SOURCE']]) {
    const result = process.env[name];
    if (!its.some((l) => lanes.includes(l)) || result === 'success') continue;
    problems.push(result ? `the ${job} job ended '${result}', though every summary it wrote passes` : `the ${job} job's result (${name}) wasn't given`);
  }
}

const allPass = failing.length === 0 && problems.length === 0;
const verdict = !allPass
  ? 'FAILURES'
  : process.env.FULL === 'true' ? 'all lanes pass' : `${lanes.join(', ')} ${lanes.length === 1 ? 'passes' : 'pass'}`;
const head = `${allPass ? '🟢' : '🔴'} **connectome-smoke** — ${verdict}${reason ? ` · _${reason}_` : ''}${runUrl ? ` · <${runUrl}>` : ''}`;
// Discord caps a message at 2000 characters; keep one message: each
// summary's head, versions and failing lines. What needs attention comes
// first, so a cut drops every passing summary before any failure. The cut
// falls at a line boundary, and a last line says the post was cut. Each
// line is kept to 300 characters, the cap lib/common.mjs puts on a step's
// detail, so one long line can't push later failures out.
const LINE = 300;
const lines = (s) => {
  const ls = s.split('\n');
  return [ls[0], ls[1] ?? '', ...ls.slice(2).filter((l) => /^(lag|nested|✗|fatal)/.test(l))];
};
const body = [
  ...problems.map((m) => `✗ ${m}`),
  ...failing.flatMap(([run, s]) => (s ? lines(s) : [`✗ ${run}: its summary is empty`])),
  ...passing.flatMap(lines),
].map((l) => (l.length > LINE ? `${l.slice(0, LINE - 1)}…` : l));
const LIMIT = 2000;
const CUT = "… cut at Discord's 2,000-character limit; each summary is on the run's page";
let content = [head, ...body].join('\n');
if (content.length > LIMIT) content = `${content.slice(0, content.lastIndexOf('\n', LIMIT - CUT.length - 1))}\n${CUT}`;
// A cut, here or in a lane's summary, can split an emoji's surrogate pair;
// what's posted is well-formed, with U+FFFD in place of a half.
content = content.toWellFormed();

// Whether the set may be remembered once the post settles: a run of every
// lane, with a result from every requested run.
const rememberable = process.env.FULL === 'true' && complete;
const remember = () => {
  if (rememberable && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'remember=true\n');
};

if (!webhook) {
  remember();
  console.log('(no DISCORD_WEBHOOK) would post:\n' + content);
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.error(`DISCORD_WEBHOOK is empty here: the repository secret is missing, so nothing was posted${rememberable ? '. The set is remembered, so once the secret is set, a manual run posts the current set' : ''}.`);
    process.exit(1);
  }
  process.exit(0);
}
const TRIES = 3;
const MAX_WAIT_S = 300;
const tries = [];
for (let n = 1; ; n++) {
  let waitMs = n * 1000;
  try {
    const res = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) });
    if (res.ok) {
      remember();
      console.log('posted:\n' + content);
      process.exit(0);
    }
    const answer = await res.text();
    tries.push(`${res.status} ${answer.slice(0, 300)}`.trim());
    if (res.status !== 429 && res.status < 500) {
      remember();
      console.error(`discord webhook: refused: ${tries.join('; ')}. Trying again would be refused the same way${rememberable ? ', so the set is remembered; once that is fixed, a manual run posts the current set' : ''}.`);
      process.exit(1);
    }
    if (res.status === 429) {
      let after;
      try { after = JSON.parse(answer).retry_after; } catch {}
      if (typeof after === 'number' && after >= 0) {
        if (after > MAX_WAIT_S) { tries.push(`Discord asked for a wait of ${after}s, longer than ${MAX_WAIT_S}s`); break; }
        waitMs = after * 1000;
      }
    }
  } catch (e) {
    tries.push(`no answer (${e.cause?.code ?? e.message})`);
  }
  if (n === TRIES) break;
  await new Promise((r) => setTimeout(r, waitMs));
}
console.error(`discord webhook: not delivered: ${tries.join('; ')}. Nothing was remembered, so a later poll runs the set again and tries the post again.`);
process.exit(1);
