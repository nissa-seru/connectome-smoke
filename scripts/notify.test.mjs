// What notify.mjs posts for a run's evidence: without a webhook it prints
// the post, and with one, a webhook this process serves answers it. Run
// with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const NOTIFY = fileURLToPath(new URL('./notify.mjs', import.meta.url));
const RUNTIMES = JSON.stringify([
  { name: 'floor', node: '22.12.0', bun: '1.4.3' },
  { name: 'middle', node: '24', bun: 'latest' },
  { name: 'newest', node: 'latest', bun: 'latest' },
]);
const ALL = ['published', 'latest', 'source'];
const LEGS = ['floor', 'middle', 'newest'];
const CUT = "… cut at Discord's 2,000-character limit; each summary is on the run's page";

/** A lane's summary as lib/common.mjs's finish() writes it: the verdict on
 *  its first line, the versions on its second, then a line per step, with
 *  `fails` failing steps whose detail is `detail`, and any `extra` lines. */
function summary(lane, verdict, { fails = 1, detail = 'boot failed', extra = [] } = {}) {
  return `**connectome-smoke · ${lane}** — ${verdict === 'pass' ? '✅ PASS' : '❌ FAIL'} (30s, linux-x64, node v22.12.0, bun 1.4.3)\n` +
    'host 0.10.2 · af 0.22.1 · cm 0.14.1 · membrane 0.5.87 · chronicle 0.4.0 · mcpl-core 0.2.2\n' +
    '✓ npm install\n' +
    (verdict === 'pass' ? '' : Array.from({ length: fails }, (_, i) => `✗ step ${i + 1} — ${detail}\n`).join('')) +
    extra.map((l) => `${l}\n`).join('');
}

/** Run notify.mjs on evidence as the workflow downloads it: one artifact
 *  directory per run, holding summary-<lane>-<runtime>.md. `runs` maps each
 *  run to its summary; a run left out wrote nothing. `env` overrides what
 *  the workflow sets, and an undefined value leaves that variable unset.
 *  With `noEvidence`, the evidence folder doesn't exist, and `prepare` can
 *  change it before the run. Returns the exit status, what it would post,
 *  its stderr, and what it wrote to $GITHUB_OUTPUT. */
function run(runs, env = {}, opts = {}) {
  const { tmp, dir, vars, result } = setUp(runs, env, opts);
  try {
    const r = spawnSync(process.execPath, [NOTIFY, dir], { encoding: 'utf-8', env: vars });
    return result(r.status, r.stdout, r.stderr);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The evidence folder, environment and result reader run() and runAsync()
 *  share. */
function setUp(runs, env, { noEvidence = false, prepare = () => {} } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'notify-test-'));
  const dir = join(tmp, 'evidence');
  const output = join(tmp, 'github-output');
  if (!noEvidence) mkdirSync(dir);
  for (const [r, text] of Object.entries(runs)) {
    mkdirSync(join(dir, `${r}-evidence`));
    writeFileSync(join(dir, `${r}-evidence`, `summary-${r}.md`), text);
  }
  prepare(dir);
  const vars = {
    PATH: process.env.PATH, LANES: ALL.join(','), FULL: 'true', RUNTIMES,
    RESULT_PUBLISHED: 'success', RESULT_SOURCE: 'success', GITHUB_OUTPUT: output, ...env,
  };
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete vars[k];
  const result = (status, stdout, stderr) => ({
    status,
    // What it would post, or posted: the lines after its first, without
    // console.log's closing newline.
    out: stdout.split('\n').slice(1).join('\n').replace(/\n$/, ''),
    stderr,
    output: existsSync(output) ? readFileSync(output, 'utf-8') : '',
  });
  return { tmp, dir, vars, result };
}

/** run(), without blocking this process, so a webhook it serves can answer.
 *  A run still going after 30 s is stopped, and its status is null. */
async function runAsync(runs, env = {}, opts = {}) {
  const { tmp, dir, vars, result } = setUp(runs, env, opts);
  try {
    const child = spawn(process.execPath, [NOTIFY, dir], { env: vars });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8').on('data', (c) => { stdout += c; });
    child.stderr.setEncoding('utf-8').on('data', (c) => { stderr += c; });
    const stop = setTimeout(() => child.kill(), 30_000);
    const [status] = await once(child, 'close');
    clearTimeout(stop);
    return result(status, stdout, stderr);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Post `runs` (every run passing, unless given) to a webhook this process
 *  serves, which gives the posts `answers` in turn: a status, or { status,
 *  body }. With `answers` null, the webhook is a port nothing listens on.
 *  Returns runAsync()'s result, and the posts the webhook got, each with
 *  when it came. */
async function deliver(answers, env = {}, runs = every()) {
  const posts = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf-8').on('data', (c) => { body += c; }).on('end', () => {
      posts.push({ at: Date.now(), body });
      const answer = answers[posts.length - 1] ?? 500;
      const { status, body: text = '' } = typeof answer === 'number' ? { status: answer } : answer;
      res.writeHead(status, { 'content-type': 'application/json' }).end(text);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  if (answers === null) {
    server.close();
    await once(server, 'close');
  }
  try {
    return { ...(await runAsync(runs, { DISCORD_WEBHOOK: `http://127.0.0.1:${port}/`, ...env })), posts };
  } finally {
    if (answers !== null) server.close();
  }
}

/** What notify.mjs would post, where it exits 0. */
function post(runs, env = {}, opts = {}) {
  const r = run(runs, env, opts);
  assert.equal(r.status, 0, r.stderr);
  return r.out;
}

/** Every run of `lanes` on every runtime, passing. */
const every = (lanes = ALL) => Object.fromEntries(lanes.flatMap((l) => LEGS.map((r) => [`${l}-${r}`, summary(l, 'pass')])));

test('every requested run passing posts "all lanes pass", whole', () => {
  const out = post(every());
  assert.match(out, /^🟢 \*\*connectome-smoke\*\* — all lanes pass/);
  assert.doesNotMatch(out, /✗/);
  const lines = out.split('\n');
  assert.equal(lines.length, 1 + 9 * 2, 'the head, then every summary\'s two lines');
  assert.match(lines.at(-1), /^host 0\.10\.2 · .* mcpl-core 0\.2\.2$/, 'the last summary\'s versions line is kept');
  assert.ok(!out.includes(CUT), 'a post under the limit has no cut line');
});

test('a run that wrote no summary is named, though its lane\'s other runs passed', () => {
  const runs = every();
  delete runs['published-middle'];
  const out = post(runs);
  assert.match(out, /^🔴 \*\*connectome-smoke\*\* — FAILURES/);
  assert.match(out, /✗ published on middle \(Node 24, Bun latest\): no summary reached the report/);
});

test('a run that wrote no summary is named beside a sibling that failed', () => {
  const runs = every();
  runs['published-floor'] = summary('published', 'fail');
  delete runs['published-newest'];
  const out = post(runs);
  assert.match(out, /✗ published on newest \(Node latest, Bun latest\): no summary reached the report/);
  assert.match(out, /❌ FAIL/);
});

test('a run of some lanes expects only those, and says which passed', () => {
  assert.match(post(every(['source']), { LANES: 'source', FULL: 'false' }), /^🟢 \*\*connectome-smoke\*\* — source passes/);
  assert.match(post(every(['published', 'latest']), { LANES: 'published,latest', FULL: 'false' }), /^🟢 \*\*connectome-smoke\*\* — published, latest pass/);
});

test('lanes written with spaces are the same lanes', () => {
  const out = post(every(), { LANES: 'published, latest , source' });
  assert.match(out, /^🟢 \*\*connectome-smoke\*\* — all lanes pass/);
});

test('a cut drops passing summaries before the missing run and the failure, at a line boundary, and says so', () => {
  // Seven passing summaries, one failing with two long failure lines, and a
  // run that wrote nothing: about 2,300 characters before the cut.
  const runs = every();
  runs['source-newest'] = summary('source', 'fail', { fails: 2, detail: 'x'.repeat(250) });
  delete runs['latest-floor'];
  const out = post(runs);
  const lines = out.split('\n');
  assert.ok(out.length <= 2000, `the post is ${out.length} characters`);
  assert.equal(lines.at(-1), CUT);
  const missing = lines.findIndex((l) => /^✗ latest on floor .*no summary reached the report/.test(l));
  const failure = lines.findIndex((l) => l.includes('❌ FAIL'));
  const kept = lines.filter((l) => l.includes('✅ PASS')).length;
  assert.ok(missing === 1, 'the missing run comes first');
  assert.ok(failure > missing && lines.slice(failure).filter((l) => /^✗ step \d — x+$/.test(l)).length === 2, 'the failure follows with both its lines');
  assert.ok(lines.findIndex((l) => l.includes('✅ PASS')) > failure, 'passing summaries come last');
  assert.ok(kept > 0 && kept < 7, `${kept} of 7 passing summaries were kept`);
  assert.match(lines.at(-2), /(✅ PASS \(30s, linux-x64, node v22\.12\.0, bun 1\.4\.3\)|^host 0\.10\.2 · .* mcpl-core 0\.2\.2)$/, 'the cut falls between whole lines');
});

test('when failures fill most of the post, every failure is kept and passing summaries are what\'s cut', () => {
  // Three failing summaries of about 550 characters each and six passing
  // ones: the failures fit, and the passing summaries are what's cut.
  const runs = every();
  for (const r of ['latest-middle', 'published-floor', 'source-newest']) runs[r] = summary(r.split('-')[0], 'fail', { fails: 2, detail: 'z'.repeat(180) });
  const out = post(runs);
  const lines = out.split('\n');
  assert.ok(out.length <= 2000, `the post is ${out.length} characters`);
  assert.equal(lines.at(-1), CUT);
  const heads = lines.flatMap((l, i) => (l.includes('❌ FAIL') ? [i] : []));
  assert.equal(heads.length, 3, 'all three failures are kept');
  assert.equal(lines.filter((l) => /^✗ step \d — z+$/.test(l)).length, 6, 'with both lines each');
  const firstPass = lines.findIndex((l) => l.includes('✅ PASS'));
  assert.ok(firstPass === -1 || firstPass > heads.at(-1), 'no passing summary comes before a failure');
  assert.ok(lines.filter((l) => l.includes('✅ PASS')).length < 6, 'passing summaries were cut');
});

test('failures past the limit are cut only after every passing summary', () => {
  // Six failing summaries, far past the limit together, and three passing.
  const runs = every();
  for (const l of ['published', 'latest']) for (const r of LEGS) runs[`${l}-${r}`] = summary(l, 'fail', { fails: 3, detail: 'y'.repeat(250) });
  const out = post(runs);
  const lines = out.split('\n');
  assert.ok(out.length <= 2000, `the post is ${out.length} characters`);
  assert.equal(lines.at(-1), CUT);
  assert.doesNotMatch(out, /✅ PASS/, 'every passing summary is cut');
  assert.ok(lines.filter((l) => l.includes('❌ FAIL')).length < 6, 'failures are cut too');
  // The evidence sorts by run, so latest-floor comes first.
  assert.match(lines[1], /^\*\*connectome-smoke · latest\*\* — ❌ FAIL/);
});

test('a problem line past 300 characters is cut to 300 too', () => {
  const name = 'r'.repeat(400);
  const out = post({}, { LANES: 'source', FULL: 'false', RUNTIMES: JSON.stringify([{ name, node: '22.12.0', bun: '1.4.3' }]) });
  const line = out.split('\n').find((l) => l.startsWith('✗ source on r'));
  assert.equal(line.length, 300);
  assert.ok(line.endsWith('…'), 'the cut line ends in an ellipsis');
});

test('a line past 300 characters is cut to 300, so the failures after it still fit', () => {
  const runs = every();
  runs['latest-floor'] = summary('latest', 'fail', { extra: [`fatal: ${'q'.repeat(2500)}`] });
  runs['source-newest'] = summary('source', 'fail');
  const lines = post(runs).split('\n');
  const fatal = lines.find((l) => l.startsWith('fatal: '));
  assert.equal(fatal.length, 300);
  assert.ok(fatal.endsWith('…'), 'the cut line ends in an ellipsis');
  assert.ok(lines.some((l) => /^\*\*connectome-smoke · source\*\* — ❌ FAIL/.test(l)), 'the failure after the long line is in the post');
});

test('the head carries the run\'s reason and a link to the run\'s page', () => {
  const out = post(every(), { REASON: 'new published set (newest publish 25m ago)', RUN_URL: 'https://github.com/o/r/actions/runs/1' });
  assert.equal(out.split('\n')[0], '🟢 **connectome-smoke** — all lanes pass · _new published set (newest publish 25m ago)_ · <https://github.com/o/r/actions/runs/1>');
});

test('a post of exactly 2,000 characters is whole, and one more is cut', () => {
  // One failing summary whose lag lines set the post's length, each under
  // the 300-character line cap. A lag line of m w's adds m + 5 characters:
  // its newline, "lag " and the w's.
  const runsWith = (ms) => ({ ...every(), 'source-floor': summary('source', 'fail', { extra: ms.map((m) => `lag ${'w'.repeat(m)}`) }) });
  const toAdd = 2000 - post(runsWith([])).length;
  const k = Math.ceil(toAdd / 250);
  const ms = Array.from({ length: k }, (_, i) => Math.floor(toAdd / k) + (i < toAdd % k ? 1 : 0) - 5);
  assert.ok(toAdd > 0 && ms.every((m) => m > 0 && m + 4 < 300), `lag lines of ${ms} w's`);
  const exact = post(runsWith(ms));
  assert.equal(exact.length, 2000);
  assert.ok(!exact.includes(CUT), 'exactly at the limit, nothing is cut');
  const over = post(runsWith([...ms.slice(0, -1), ms.at(-1) + 1]));
  assert.ok(over.length <= 2000, `the post is ${over.length} characters`);
  assert.equal(over.split('\n').at(-1), CUT);
});

test('a summary\'s lag, nested and fatal lines are kept, and its passing steps aren\'t', () => {
  const runs = every();
  runs['latest-newest'] = summary('latest', 'fail', { extra: ['lag af 0.22.1 < 0.23.0', 'nested membrane 0.5.86 under af', 'fatal: chronicle binding missing', 'a line of host output'] });
  const out = post(runs);
  for (const l of ['lag af 0.22.1 < 0.23.0', 'nested membrane 0.5.86 under af', 'fatal: chronicle binding missing']) {
    assert.ok(out.split('\n').includes(l), `"${l}" is in the post`);
  }
  assert.doesNotMatch(out, /✓ npm install|a line of host output/);
});

test('a runtime list that can\'t be read, isn\'t a list, is empty, has an entry without a name, node or bun, or is unset fails the post', () => {
  for (const runtimes of [
    'not json', '{"name": "floor", "node": "22.12.0", "bun": "1.4.3"}', '[]', '[null]', '[1]',
    '[{"node": "22.12.0", "bun": "1.4.3"}]', '[{"name": "", "node": "22.12.0", "bun": "1.4.3"}]',
    '[{"name": "floor", "bun": "1.4.3"}]', '[{"name": "floor", "node": "", "bun": "1.4.3"}]', '[{"name": "floor", "node": "22.12.0"}]',
    undefined,
  ]) {
    const out = post(every(), { RUNTIMES: runtimes });
    assert.match(out, /^🔴 .* FAILURES/, `RUNTIMES=${runtimes}`);
    assert.match(out, /runtime list \(RUNTIMES\) couldn't be read/, `RUNTIMES=${runtimes}`);
  }
});

test('without the requested lanes the post fails', () => {
  for (const lanes of ['', undefined]) {
    const out = post(every(), { LANES: lanes });
    assert.match(out, /^🔴 .* FAILURES/, `LANES=${lanes}`);
    assert.match(out, /✗ the requested lanes \(LANES\) weren't given/, `LANES=${lanes}`);
  }
});

test('an evidence folder that can\'t be read is named', () => {
  const out = post({}, {}, { noEvidence: true });
  assert.match(out, /^🔴 .* FAILURES/);
  assert.match(out, /^✗ the evidence folder .*evidence couldn't be read \(ENOENT\)$/m);
  assert.match(out, /✗ source on newest .*no summary reached the report/);
});

test('an evidence entry that can\'t be read is named, and the rest is still read', () => {
  const out = post(every(), {}, { prepare: (dir) => symlinkSync(join(dir, 'nowhere'), join(dir, 'dangling')) });
  assert.match(out, /^🔴 .* FAILURES/);
  assert.match(out, /^✗ the evidence entry .*dangling couldn't be read \(ENOENT\)$/m);
  assert.doesNotMatch(out, /no summary reached the report/);
});

test('a summary that can\'t be read is named, and its run counts as missing', { skip: process.getuid?.() === 0 && 'root can read a file whatever its mode' }, () => {
  const out = post(every(), {}, { prepare: (dir) => chmodSync(join(dir, 'source-floor-evidence', 'summary-source-floor.md'), 0) });
  assert.match(out, /^✗ the summary .*summary-source-floor\.md couldn't be read \(EACCES\)$/m);
  assert.match(out, /✗ source on floor .*no summary reached the report/);
});

test('an empty summary is named by its run', () => {
  const runs = every();
  runs['latest-middle'] = '';
  const out = post(runs);
  assert.match(out, /^🔴 .* FAILURES/);
  assert.match(out, /^✗ latest-middle: its summary is empty$/m);
});

test('a lane job that didn\'t end in success while every summary passed turns the post red', () => {
  for (const [result, line] of [['failure', /✗ the Published lane job ended 'failure', though every summary it wrote passes/], ['cancelled', /✗ the Published lane job ended 'cancelled'/], [undefined, /✗ the Published lane job's result \(RESULT_PUBLISHED\) wasn't given/]]) {
    const out = post(every(), { RESULT_PUBLISHED: result });
    assert.match(out, /^🔴 .* FAILURES/, `RESULT_PUBLISHED=${result}`);
    assert.match(out, line, `RESULT_PUBLISHED=${result}`);
    assert.doesNotMatch(out, /Source-main lane job/, `RESULT_PUBLISHED=${result}`);
  }
  const out = post(every(), { RESULT_SOURCE: 'failure' });
  assert.match(out, /^🔴 .* FAILURES/);
  assert.match(out, /✗ the Source-main lane job ended 'failure', though every summary it wrote passes/);
  assert.doesNotMatch(out, /Published lane job/);
});

test('a lane job counts only when the run requested one of its lanes', () => {
  const out = post(every(['source']), { LANES: 'source', FULL: 'false', RESULT_PUBLISHED: 'failure' });
  assert.match(out, /^🟢 \*\*connectome-smoke\*\* — source passes/);
});

test('a lane job\'s end isn\'t named when the post already names a missing or failing run', () => {
  const missing = every();
  delete missing['published-middle'];
  const failing = every();
  failing['latest-floor'] = summary('latest', 'fail');
  for (const [what, runs] of [['missing', missing], ['failing', failing]]) {
    const out = post(runs, { RESULT_PUBLISHED: 'failure' });
    assert.match(out, /^🔴 .* FAILURES/, what);
    assert.doesNotMatch(out, /lane job/, what);
  }
});

test('the verdict is read from the summary\'s first line', () => {
  const runs = every();
  runs['source-floor'] = summary('source', 'fail', { detail: 'expected "✅ PASS" in the output' });
  assert.match(post(runs), /^🔴 .* FAILURES/);
});

test('a run of every lane with every requested run\'s summary, passing or failing, is remembered once the post settles', () => {
  assert.equal(run(every()).output, 'remember=true\n');
  const failing = every();
  failing['published-floor'] = summary('published', 'fail');
  assert.equal(run(failing).output, 'remember=true\n');
});

test('nothing is remembered for a run of some lanes, a summary missing or empty, or nothing to check against', () => {
  // Each run gets as far as printing what it would post, which comes after
  // the memory is decided, so nothing remembered is a decision, not a stop.
  const notRemembered = (r, what) => {
    assert.equal(r.status, 0, `${what}: ${r.stderr}`);
    assert.match(r.out, /^(🟢|🔴) \*\*connectome-smoke\*\*/, `${what}: it printed what it would post`);
    assert.equal(r.output, '', what);
  };
  notRemembered(run(every(['source']), { LANES: 'source', FULL: 'false' }), 'a run of some lanes');
  notRemembered(run(every(), { FULL: undefined }), 'FULL not given');
  const missing = every();
  delete missing['source-middle'];
  notRemembered(run(missing), 'a summary missing');
  const empty = every();
  empty['source-middle'] = '';
  notRemembered(run(empty), 'a summary empty');
  notRemembered(run(every(), { LANES: '' }), 'LANES empty');
  notRemembered(run(every(), { RUNTIMES: '[]' }), 'RUNTIMES empty');
  notRemembered(run({}, {}, { noEvidence: true }), 'no evidence folder');
});

test('a lane job that ends cancelled after every summary arrived turns the post red, and the set is still remembered', () => {
  const r = run(every(), { RESULT_PUBLISHED: 'cancelled' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.out, /^🔴 \*\*connectome-smoke\*\* — FAILURES/);
  assert.match(r.out, /^✗ the Published lane job ended 'cancelled', though every summary it wrote passes$/m);
  assert.equal(r.output, 'remember=true\n', 'every run gave a result');
});

test('a local run, with no $GITHUB_OUTPUT, prints what it would post and exits 0', () => {
  const r = run(every(), { GITHUB_OUTPUT: undefined });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.out, /^🟢 \*\*connectome-smoke\*\* — all lanes pass/);
});

test('in Actions an empty webhook fails the step, naming the secret, and the set is remembered', () => {
  const r = run(every(), { GITHUB_ACTIONS: 'true', DISCORD_WEBHOOK: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^DISCORD_WEBHOOK is empty here: the repository secret is missing, so nothing was posted\. The set is remembered, so once the secret is set, a manual run posts the current set\.$/m);
  assert.match(r.out, /^🟢 \*\*connectome-smoke\*\* — all lanes pass/, 'it prints what it would have posted');
  assert.equal(r.output, 'remember=true\n', 'the next poll would find no webhook either');
  const some = run(every(['source']), { GITHUB_ACTIONS: 'true', DISCORD_WEBHOOK: '', LANES: 'source', FULL: 'false' });
  assert.equal(some.status, 1);
  assert.match(some.stderr, /^DISCORD_WEBHOOK is empty here: the repository secret is missing, so nothing was posted\.$/m, 'a run of some lanes remembers nothing, and says nothing of it');
  assert.equal(some.output, '');
});

test('a post the webhook takes is sent once, as the content it prints, and the set is remembered', async () => {
  const r = await deliver([204]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.posts.length, 1);
  const { content } = JSON.parse(r.posts[0].body);
  assert.match(content, /^🟢 \*\*connectome-smoke\*\* — all lanes pass/);
  assert.equal(r.out, content, 'what it prints after "posted:" is what it sent');
  assert.equal(r.output, 'remember=true\n');
});

test('a post the webhook refuses fails the step at once, naming the answer, and the set is remembered', async () => {
  const refused = { status: 404, body: '{"message": "Unknown Webhook", "code": 10015}' };
  const r = await deliver([refused, 204]);
  assert.equal(r.status, 1);
  assert.equal(r.posts.length, 1, 'a refusal isn\'t tried again');
  assert.match(r.stderr, /^discord webhook: refused: 404 \{"message": "Unknown Webhook", "code": 10015\}\. Trying again would be refused the same way, so the set is remembered; once that is fixed, a manual run posts the current set\.$/m);
  assert.equal(r.output, 'remember=true\n', 'the next poll would be refused too');
  const some = await deliver([refused], { LANES: 'source', FULL: 'false' }, every(['source']));
  assert.equal(some.status, 1);
  assert.match(some.stderr, /^discord webhook: refused: 404 .*\. Trying again would be refused the same way\.$/m, 'a run of some lanes remembers nothing, and says nothing of it');
  assert.equal(some.output, '');
});

test('a server error is tried again, and the post is delivered', async () => {
  const r = await deliver([503, 204]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.posts.length, 2);
  assert.equal(r.posts[1].body, r.posts[0].body, 'the same post again');
  assert.equal(r.output, 'remember=true\n');
});

test('a rate limit is waited out as long as Discord says, then the post is delivered', async () => {
  const r = await deliver([{ status: 429, body: '{"message": "You are being rate limited.", "retry_after": 1.5, "global": false}' }, 204]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.posts.length, 2);
  const gap = r.posts[1].at - r.posts[0].at;
  assert.ok(gap >= 1400 && gap < 2500, `the second try came ${gap} ms after the first`);
  assert.equal(r.output, 'remember=true\n');
});

test('a rate limit with no usable retry_after is waited a second, then two', async () => {
  // Not JSON at all, then a retry_after Discord's docs never give: each try
  // waits as a server error's would.
  const html = { status: 429, body: '<html>Too Many Requests</html>' };
  const r = await deliver([html, { status: 429, body: '{"retry_after": -1}' }, html]);
  assert.equal(r.status, 1);
  assert.equal(r.posts.length, 3);
  const [first, second] = [r.posts[1].at - r.posts[0].at, r.posts[2].at - r.posts[1].at];
  assert.ok(first >= 900 && first < 1900, `the second try came ${first} ms after the first`);
  assert.ok(second >= 1900, `the third try came ${second} ms after the second`);
  assert.match(r.stderr, /^discord webhook: not delivered: 429 <html>Too Many Requests<\/html>; 429 \{"retry_after": -1\}; 429 <html>Too Many Requests<\/html>\. Nothing was remembered/m);
  assert.equal(r.output, '');
});

test('a rate limit longer than five minutes fails the step without waiting it out, and leaves the set to a later poll', async () => {
  const r = await deliver([{ status: 429, body: '{"retry_after": 3600}' }, 204]);
  assert.equal(r.status, 1);
  assert.equal(r.posts.length, 1);
  assert.match(r.stderr, /not delivered: 429 \{"retry_after": 3600\}; Discord asked for a wait of 3600s, longer than 300s\. Nothing was remembered, so a later poll runs the set again and tries the post again\.$/m);
  assert.equal(r.output, '');
});

test('three passing refusals fail the step, naming each, and leave the set to a later poll', async () => {
  const limited = { status: 429, body: '{"retry_after": 0.01}' };
  const r = await deliver([limited, limited, limited, 204]);
  assert.equal(r.status, 1);
  assert.equal(r.posts.length, 3, 'three tries in all');
  assert.match(r.stderr, /not delivered: 429 \{"retry_after": 0\.01\}; 429 \{"retry_after": 0\.01\}; 429 \{"retry_after": 0\.01\}\. Nothing was remembered/m);
  assert.equal(r.output, '');
});

test('a post that gets no answer is tried three times, fails the step, and leaves the set to a later poll', async () => {
  const r = await deliver(null);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not delivered: no answer \(ECONNREFUSED\); no answer \(ECONNREFUSED\); no answer \(ECONNREFUSED\)\. Nothing was remembered/m);
  assert.equal(r.output, '');
});

test('a cut that splits an emoji in two leaves the post well-formed', async () => {
  // A failure line whose 299th character is the first half of an emoji, so
  // the 300-character cap keeps that half alone.
  const detail = `${'e'.repeat(298 - '✗ step 1 — '.length)}🟢 and more`;
  const r = await deliver([204], {}, { ...every(), 'source-floor': summary('source', 'fail', { detail }) });
  assert.equal(r.status, 0, r.stderr);
  const { content } = JSON.parse(r.posts[0].body);
  const line = content.split('\n').find((l) => l.startsWith('✗ step 1 — e'));
  assert.equal(line.length, 300);
  assert.equal(line.at(-2), '\uFFFD', 'the half is replaced');
  assert.ok(content.isWellFormed(), 'what the webhook got is well-formed');
});
