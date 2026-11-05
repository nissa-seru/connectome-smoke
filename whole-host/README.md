# Whole-host records

`whole-host/` drives connectome-host against a stand-in for Anthropic's API, through a set of workload runs, and writes one record per run. Each run's recipe loads the host's context strategy and the fixture's own MCPL server. It turns off the subagents module (H2's configuration and W9's workload turn it back on), the lessons, retrieval, wake and workspace modules, cache keepalive and the context maintenance timer (`driver.mjs`'s recipe, `script.mjs`'s configurations). A record says what every request the run sent carried.

The context view runs it twice for a pull request in context-manager, agent-framework, membrane or connectome-host: once with the base branch's tip, the base arm, and once with the pull request merged onto it, the head arm, with everything else installed from the host's lockfile; laying a pull request's packages over it with `npm install` can move another package from its locked version where their own version ranges require it. A change that moves what the resident's requests carry changes the head arm's records, and how they differ from the base arm's is what the view shows. Both arms run this harness, from this repository, so a change to the harness moves both arms alike.

## Running it

`node whole-host/run.mjs --host DIR` drives the connectome-host checkout at `DIR` through every run, judges each, and writes its record. With `--against BASE`, it compares each run's record with the base arm's in `BASE`. It exits 0 when every run's record is the same as the base arm's, with no flag new or gone (or, with no `--against`, written, with no flag at all), and its self-check, where one ran, the same; 1 when a record differs or has no base record to compare with, a flag is new or gone, or a self-check differs; and 2 when a run or its self-check couldn't run, a run didn't measure or a read failed on either arm ("Flags across the arms"), or the invocation stopped before running anything. A run whose `report.txt` can't be written ends the invocation there, as an uncaught error, which exits 1.

The harness imports only Node's own modules, and Bun's in the test module the host loads, so it needs no install of its own. `npm ci` in `whole-host/` installs context-manager for one unit test, `readStore`'s, and `npm test` runs the unit tests.

- `--host DIR` names the connectome-host checkout to drive, by its `package.json`. It's required. Without `--overlay` the candidate is `DIR`'s own install, so `DIR` needs `npm ci` first; with one, the harness copies `DIR` and installs the copy itself. The release whose checkpoints the runs start from is cloned from the repository `DIR`'s `package.json` names, at the tag `stack.json` names.
- `--against BASE` compares each run's record with the one the base arm wrote, where `BASE` is the base arm's `--out`. The invocation stops before it runs anything, exit 2, unless `BASE/run.json` was written by the same harness (its `lane`, which covers `lib/`, `run.mjs` and `stack.json` less its `seconds`) under the same Node version, platform and architecture, from the same `--runs` and for the same `--shard`, with each record it lists present; once the release is installed, it stops the same way unless the base arm's checkpoints came from the same release and stack. Otherwise a difference could be put down to the change that isn't the change's. `seconds` is left out of the lane because it shapes only the shares, which the `--shard` check covers. The candidate isn't compared, since it's what the two arms are run to tell apart, and neither is the environment the host inherits. A run the base arm couldn't run has no record there, so its record is `missing`. Only a run whose record `differs` gets a view.
- `--runs A,B` runs only those (`CONFIGURATION/WORKLOAD[/VARIANT]`, as `workloads.mjs` `RUNS` lists them), each named once.
- `--overlay PACK.tgz` lays a packed agent-framework, context-manager, membrane or chronicle over `--host`'s install, to see what a change to one of them does to the host. A host change is a change to the `--host` checkout itself.
- `--checkpoints DIR` keeps the runs' starting checkpoints in `DIR` between invocations, keyed by the lane, the release's versions, the run that writes each, its configuration, the clock's start and its steps. The environment the host inherits isn't in the key. Both arms of a view can share it, since their checkpoints come from the same release.
- `--self-check` drives each run a second time with the test module's recording off, and fails a run whose request bodies differ once the run-varying values are masked in both, wherever they appear, cache markers included, where a record writes a marker whole: every record rests on recording changing nothing the host sends. It compares the bodies alone, not the headers, path or query; the record's heads hold the path, the query and the `anthropic-beta` and `anthropic-version` headers. With recording off the driver sets `FIXTURE_RECORD=off`, and otherwise leaves it unset, dropping a runner's own, so a runner's setting can't turn the recording arm off. An arm with recording off that logged compile batches anyway can't be judged, nor can one whose drive failed, and the summary names which arm. Where they differ, the first differing pair of request bodies is kept in the run's evidence, under `self-check/`. The context view runs it on the head arm. A change whose effect recording happened to hide would leave every record as it was, so only the self-check would show it, and it also shows a head whose requests vary from one drive to the next.
- `--shard i/n` runs share `i` of `n`, balanced by the seconds `stack.json` records. Both arms of a view take the same share.
- `--workdir DIR` keeps the run's installs and stores in `DIR`, which must be empty or new, since the release is installed there and every run's store starts there. The candidate is `--host`'s own install unless `--overlay` is given, when it's installed there too.
- `--out DIR` chooses where each run's record, `report.txt` and view are written, and `run.json` and `summary.md`; it's `DIR/out` under the work directory when not given. It must be empty or new, since it holds one invocation's evidence: otherwise an invocation that stopped partway could leave an earlier `run.json` naming records it had replaced. `run.json` names the harness (`lane`), the runs the shares were drawn from (`runs`, in `RUNS` order), the Node version, platform and architecture it ran under (`runtime`), the release that wrote the checkpoints with its stack (`release`), the candidate's stack and overlays (`candidate`), each run's and checkpoint's seconds, and each run's result: its outcome (`pass`, `flags`, `invalid` or `couldnt-run`) and the reason it couldn't run, its record (`same`, `differs`, `missing` or `written`, or `null` when it couldn't run), its flags, `new`, `gone` and `kept` against the base arm's ("Flags across the arms", below), its counts (`counts`) of request compiles, of the requests the stand-in classified as the summariser's, requests to summarise messages (`compressions`: level 1, whatever the instruction, a compression's, a transition's or a subagent's) and requests to merge summaries (`merges`: every level above it), each counted under the level it asked for whether or not it was answered, and of quarantines entered (`quarantines` is `'not-reported'` or `{compression, merge}`, each a count or `'unreadable'`), the reads of the test module's that failed (`readsFailed`, such as `receipt` or `merge quarantines`, and with `--against`, `baseReadsFailed`), the base arm's reason where it couldn't run the run (`baseReason`, its record then `missing`, and its summary row saying "the base arm couldn't run it: …"), and its self-check (`selfCheck`, whose `outcome` is `same`, `differs` or `couldnt-run`, the last with its `reason`).
- `--update-seconds` merges this invocation's seconds, each run's and each checkpoint's, over the ones `stack.json` records, which `--shard` balances by. It writes the file through a temporary one, so an interrupted write leaves the old file whole. Two invocations writing at once each keep their own merge, and the later one's stands.

Records are made on Linux. The test module stamps each request compile from the machine's monotonic clock, which it reads there (`module.mjs`), under Bun through `clock_gettime` in `libc.so.6`. A run whose compiles carry no stamp is refused as couldn't-run (`record.mjs`, `unrecordable`), so every run couldn't run anywhere but Linux, and under Bun on a Linux whose C library isn't at `libc.so.6`, such as a plain musl one.

A run that throws anywhere in its own work, from being set up to its self-check, or whose checkpoint couldn't be made, couldn't run, with the reason in the invocation's output and summary; the other runs go on, unless its `report.txt` can't be written, which ends the invocation. A self-check whose drive with recording off failed couldn't run, and one whose bodies differ fails, but neither makes its run couldn't-run: the run's record is still written and compared, and the invocation exits 2 or 1. A run whose last take of the test module's compiles at a host's shutdown fails is a failed run, its record ending `end failed`, since it lost what was compiled after the last settle.

A run that continues another starts from that run's checkpoint, written by the release `stack.json` names, installed from that release's own lockfile, so the records show the candidate against a fixed starting store. A run that continues none (W1, W2 and others) starts empty under the candidate. Moving to a newer release is a change of its own.

## Reading a record

A record opens with one header line: the run, and the checkpoint it starts from (`empty` for one that starts empty). No record names a version, so a candidate that differs from the base arm's only in its version, as a release's `npm version` makes it, moves no record. The versions are in each arm's `run.json`: the release that writes the checkpoints with its stack, and the candidate's stack, with the Bun that ran.

Then come two blocks. Each text the stack wrote is written once for each role
it's sent in, in `templates`, and each request head once, in `heads`; the lines
below name them.

- **`T:KEY = TEXT`.** A key is the text's role, its first three words with
  numbers as `#`, and the first 12 hex digits of the sha256 of the text as
  written, which for a text over 4,096 bytes is its `{ sha256, bytes, head,
  tail }` form:
  `T:user-clock-#-#-utc-9b6932fc9102 = Clock: #:# UTC`. A summary's key is
  instead `summary-lN-` and the first 12 hex digits of the sha256 of its whole
  text, the digits a long summary's `sha256` begins with. A key depends on its
  text alone, so a text leaving the set renames no other, and a one-word edit
  to a text renames it in every line that carries it, since each of those
  requests did change. Two different texts taking one key, a 48-bit
  collision, make the record refuse to be written, naming both. A
  summary's text is keyed by its level and that hash. A line that names a
  template gives its numbers after it: `[T:user-clock-#-#-utc-9b6932fc9102](12,10)`.
  A text's later lines are indented two spaces. A text over 4,096 bytes is
  written as `{ sha256, bytes, head, tail }`.
- **`H:KEY = model …, max_tokens …, stream …, thinking …, system …, tools …`.**
  One per distinct request head, keyed by a hash of it: the model, its limits,
  `tool_choice` and `thinking` as sent, each system block as a template with
  its cache marker (`^5m`, `^1h`, or `^null` for a `cache_control` sent as null) and a hash of any other field it carries
  (`{HASH}`), each tool by name and a hash of its whole
  definition, the `anthropic-beta` and `anthropic-version` headers, the
  path where it isn't `/v1/messages` and the query where there's one, and
  `rest`, a hash of anything else on the request body, where there's any.

Then each step of the run, in order, with what it made happen. Within a step,
the lines of requests are in the order the stand-in received them:

- **`compile ITEMS ^ N,M, head H:KEY, body HASH`**: a compile context-manager
  made and the request it was sent as.
  - **ITEMS** are the messages it sent. A stored message is named by the
    canary its text carries (`p.12.in`, `c.tool.call1`), or by its occurrence
    (`p.12.in:2`) where an earlier message in its store carries that canary
    too, and a run of messages stored next to each other as a range
    (`p.3.in-p.9.r1`). A message sent raw without one is its template. A
    summary is its level and the first and last messages it covers,
    `L1(p.3.in-p.5.r1)`, with `~` after it where only part of it went. A
    stored message without a canary is named, there and in the receipt line,
    by the nearest earlier message in its store that carries one and its place
    after it (`p.3.r1+2`), or by its place from the store's start (`start+3`),
    as check 11's flags name it. Names are as each store stood at the settle
    after that compile's step, where the log takes its store delta, so a later
    step's edit renames nothing earlier, and a message the delta reports
    removed anchors no name from then on.
  - **`!content` or `!shards`** after a name: context-manager's own provenance
    says that body went altered, or without all its shards. **`:no-thinking`**:
    the stored message holds thinking and the copy sent holds none. Either way
    it stands alone, outside any range.
  - **`compile -N + ITEMS`**: the agent's previous compile of the same kind
    (request or dry) less its first N items, then ITEMS added. So a change
    shows on the line of the request it changed. `= (as before)` is that
    previous compile again. Where no such N leaves the previous compile's
    items at the start of this one, as when an earlier item's form changed,
    the compile is written whole.
  - **`^ N,M`**: the places, in the list context-manager compiled, of the
    messages it marked for caching. The stand-in judges no cache marker; each
    is recorded as sent, a plain one as its TTL and any other shape whole. A
    marker on a message block or inside a tool result, wherever it was added,
    is held in the body hash; this list is context-manager's own marks, so a
    marker an adapter adds after the compile, or one nested in a tool result's
    blocks, moves the body hash without a place here. One on a system block
    shows in the head, after that block's template (`^5m`). One on a tool, on
    a message itself or on the body is held only in the tool's definition
    hash, the message's digest or the head's `rest`. A change to any of them
    moves the record, though only a system block's is written out.
  - **`head H:KEY`** appears when the agent's head differs from its previous
    request's. **`body HASH`** is a hash of each message as sent, digest and
    cache markers, so a change to any of them moves it, apart from the forms
    the record writes alike, listed after this list.
  - **`compile dry`** is a dry compile, which sends nothing.
    **`compile refused CLASS [T:…]`** is one that threw.
  - **`compile [AGENT]`** is another agent's than the fixture's own, such as a
    subagent or a reader, whichever compiled first.
- **`round + CANARIES, body HASH`**: a continuation round, a request sent with
  no compile of its own, with the canaries it carries beyond the agent's
  previous request. A request no compile pairs with is a round too, under
  `[sub]` where no agent of the stand-in's subagent side compiled at all.
- **`call CARRIED [T:…] -> SHAPE, head H:KEY, body HASH`**: a request to the
  summariser. CARRIED are the canaries of the messages it carried, each
  summary it carried by its name. The templates are its own words, such as its
  instruction. SHAPE is the stand-in's answer.
- **`unclassified CARRIED, head H:KEY, body HASH`**: a request the stand-in
  could tell neither as an agent's nor as the summariser's, such as one whose
  compression instruction it doesn't recognise or states no target length;
  one it can't count under a level, since its instruction opens as a merge
  instruction does but names no level, or names a level (`Ln`) in none of
  the forms the stand-in reads, as a merge reworded to open as an L1
  instruction would (an L1 instruction that quotes a level from the
  conversation, as the host's frontdesk transition quotes the user's open
  questions verbatim, is refused the same way, so its run doesn't measure,
  or counted under the quoted level where the quote takes one of the
  stand-in's forms; no workload's text names one, as a unit test pins); or
  one to any route but a
  POST to a path ending in `/v1/messages`, `count_tokens` included, which no
  run sends. So is a summariser retry whose hint doesn't fit what it
  re-sends. A request re-sends one the stand-in answered badly, and whose
  re-send it hasn't yet answered well, when it has the same level, target
  and canaries, and the same summaries for an L1 request or the same last
  summary for a merge, since context-manager 0.24.0 re-sends a merge with
  whichever prior summaries its halved recall budget fits, its sources last.
  After an answer that was only thinking, or empty, the re-send must carry a
  retry hint, after one cut at `max_tokens` none, and a hint with nothing to
  re-send is refused too. Since context-manager retries the merge at the head
  of its queue until it is written or quarantined, a hintless merge alike in
  level, target and canaries to one cut at `max_tokens` and not yet answered
  well on a re-send can only be that re-send, so one that ends with another
  summary is refused. The stand-in sees no quarantine, so once context-manager
  quarantines such a merge, its re-sends all refused, later merges alike in
  those three are refused too, and the run can't be compared. A merge whose
  sources went raw, so that its last summary is its newest prior, and whose
  retry dropped that prior, isn't read as a re-send, so it is refused, with a
  hint or without, and its run can't be compared though nothing is wrong. Its
  retry can drop that prior only if the prior alone runs past the halved
  recall budget, 50,000 tokens at a first retry, half the 100,000 that
  `compressionRecallBudgetTokens` defaults to. Summariser requests name no
  agent, so a second agent's merge alike to one the stand-in answered badly
  couldn't be told from its re-send, and no run that queues a bad answer has
  a second agent that can compress, a subagent or a subconscious, as a unit
  test pins. Check 1 fails the run, naming the stand-in's
  reason, and the line
  lets the view show the request. The line carries no method, and a body that
  doesn't parse, or parses to a falsy value such as `null`, gets no head, so no
  path or query either; for a route the stand-in doesn't serve, the reason
  names the method and the path.
- **`action COMMAND`**: a host command the workload sent.
- **`wrote NAME [T:…]`** and **`removed NAMES`**: a summary the store added or
  changed, with its text, and those it removed. The driver takes the test
  module's compiles as each boot becomes ready, before the steps that follow
  it, and a manager's first take in a process lists its store whole. What it
  lists at the first boot is the store as the run began, so a checkpoint's
  summaries aren't written. What it lists after a restart is compared with
  what the record knew, so a summary the reloaded store lacks is `removed` at
  the restart's step, and a message it lacks names nothing from then on. An
  agent first seen later in the run, such as a subagent, has every summary it
  holds written.
- **`checkpoint NAME`**: where the script took a checkpoint, under its step's `step` line, which a step with nothing else to show still has.

The record ends with `end ok` or `end failed`, then each agent's last receipt,
`receipt AGENT #SEQ changes LEAF/KIND/LEVEL/LAST …` (`LEAF/removed` for a leaf
it removed), `totals`, and `judged`, each check's count of what it judged,
so a drop in a count that stays above zero moves a line. An agent whose last
reported receipt head is none, or couldn't be read, has no receipt line.

Image refs carry a nonce agent-framework mints for each process, so the record
names each nonce by the order it first appears (`img_na_1`, `img_nb_1`), and
the digests a body hash takes name it by its first appearance in that request
(`img_N1_1`). A fork's call id ends in a random UUID where the fork's own call
isn't in context, so the digests name each such UUID the same way. So a
request naming two image ledgers, or a call and a result naming different
forks, still differs from one that names one. The naming goes by the text's
form, so a text written in that form by anything else is named the same way.
The stand-in's thinking signatures hash the request ahead of them and the
thinking itself, and carry a digest of the thinking alone: a signature's
first 22 characters bind it to the request ahead of it and its last 21 are
the thinking's own, so it keeps the length of one digest, and the price of a
block, which counts its signature's characters, doesn't move. On every
configuration, a request whose latest assistant message holds a thinking block
whose text no longer matches that digest is refused with the extended-thinking
page's 400: "If thinking blocks are modified, the API returns a 400
`invalid_request_error` whose message contains `thinking` or
`redacted_thinking` blocks in the latest assistant message cannot be
modified" (https://platform.claude.com/docs/en/build-with-claude/extended-thinking,
`modifiedThinking`). Where the model binds, the stand-in checks every
assistant message's thinking this way, refusing an
edited block with that error's wording at its own index. That wording names
the latest message, and applying it to any message is the stand-in's own
reading of the troubleshooting page, which says that where a signature
"didn't verify", "`prefix_mismatch_behavior` doesn't apply. Edited thinking
text returns a different error", without limiting that error to the latest
message (https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting).
Where the model doesn't bind, only the latest message is checked. On a
configuration whose model binds, a block whose text verifies but whose
signature no longer matches the request ahead of it is dropped where the
request asks `drop_block`, as the host's binding requests do, and refused
otherwise (`unbound` and `bindingRefusal`). The digests mask the signatures. The
stand-in's summary of a request is seeded from the canaries it carried, and
names the last of them, in an order of digit runs by number and the rest by
code unit, which needs no collation data that could differ between machines.

The stand-in prices the prompt cache by its own model of the provider's, from
the prompt-caching page
(https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and the
thinking page's "Thinking and prompt caching"
(https://platform.claude.com/docs/en/build-with-claude/thinking). It reads a
request's prefix as tools, then system, then messages. It reads back the
longest prefix it holds unexpired that ends within the page's lookback of a
cache marker: "The system checks at most 20 positions for each breakpoint,
counting the breakpoint itself as the first", where "a run of consecutive
`tool_use` blocks counts as one position, and so does a run of consecutive
`tool_result` blocks" ("How automatic prefix checking works"). It writes each
later marker's prefix for its own
lifetimes of 5 minutes or an hour. It doesn't write a prefix shorter than the
model's minimum cacheable length ("Cache limitations": 4,096 tokens for Claude
Opus 4.6 and 512 for Claude Opus 5.5), measured in its own pricing. The
messages' prefixes key on the thinking configuration, its mode and
`budget_tokens`, which the prompt-caching page says is rendered into the
prompt, so changing it always invalidates the messages cache. Tools and
system don't key on it: that page says they're invalidated too "on models
that render the configuration ahead of them", and neither page names one.
The key is the configuration as sent, so a request that sends its model's
default explicitly reads as a change, where the thinking page says setting a
parameter to its default is the same as omitting it. The messages' prefixes
also key on whether the request sends any image, in a message or a tool
result, since the prompt-caching page says adding or removing images anywhere
in the prompt invalidates the messages cache.

The prompt-caching page's "What invalidates the cache" also keys the
messages cache on `tool_choice` and `output_config.effort`, and the system
and messages caches on `speed`. No run sends any of them, so the stand-in
refuses a request that carries `tool_choice`, `speed` or `output_config` as
unclassified, naming the field, and the run fails. It does the same for a
model it knows no minimum for. So a host change that starts sending one stops
the runs, naming it, rather than reading as a cache read the provider
wouldn't give.

The stand-in prices text at its own rates, prose at 2.2 characters a token and
denser text at fewer, about 1.3 times context-manager 0.24.0's own estimate of
2.9 and 2.3 (`message-store.ts`), so context-manager's calibration has a gap to
close. It binds a signed thinking block to the system prompt, the tools, the
model, the body's other fields but `stream` and `metadata`, and the messages
before it, cache markers aside (`bindingIdentity`). The workloads size what
they send by the host's own limits: a document is several times the host's
default message cap of 10,000 tokens (`framework-strategy.ts`), so it's stored
in shards, and a large reply stays within the host's default reply ceiling of
16,384 tokens (`recipe-fit.ts`) at the stand-in's prose rate. An agent turns
the tool-result guard on with `toolsets--open` on its settings, then
`agent_settings`. While the stand-in holds a subagent's reply, the driver waits
for compression to go idle by maintenance passes rather than a settle, since
the turn whose request is held keeps the host from draining.

The harness leans on this host's own behaviour in five more places. A
recipe that leaves the strategy unset gets autobiographical, adaptive and
kv-unified with the standard block (`framework-strategy.ts`), and on
claude-opus-5-5 the host passes agent-framework's `thinkingBinding` and the
drop control (anima-research/connectome-host#500). A binding configuration
boots with the host's binding probe off (`THINKING_BINDING_PROBE`), since the
host shapes requests alike for no probe outcome and for an account that
refuses or drops a changed block (`logging-adapter.ts` tells only `shows`
apart). `/budget` writes a header, then a line per agent, `  <name>: …`,
which is how the driver knows the report has ended. A maintenance pass
names each agent it reports by `agentName`, which is how a settle finds the
run's own agent, and returns at once while a compression the host's
auto-tick started is in flight, and no event marks that work's end, so a
settle waits for the test module's tick counts too. And the web UI, which
W6 and W9 open, is a WebSocket to
`/ws` on the URL the host logs (`[webui] listening on <url>`), whose welcome
names the session (`welcome.session.id`), which a session-changing message
such as `suppress` must carry.

A store read the test module couldn't make is a line of its own,
`unreadable messages: REASON`, `unreadable summaries: REASON` or
`unreadable receipt: REASON`. An agent that has left agent-framework's
registry, which deregisters an ephemeral agent at its run's end without
closing its manager, is read from the manager kept from its compiles, until
its compression ticks settle and while a take of it reads unreadable, so what
a take couldn't read is still reported once it can be.

A request's line, with the head in force for it, changes whenever what that
request sends changes, apart from what the record leaves out or writes alike
and the run-varying values it masks by their pattern in the messages, the
system prompt and the digests of the tools and the body's other fields, the
run's own text included (an image-ref nonce in any string there but a block's
cache marker, which it writes whole, while a marker on a tool, the body or a
message's own fields is masked inside its digest with the rest; a fork call's UUID in the system prompt and the
digests, though a message's or summary's text the record writes from a compile
keeps it as it is; and the signature of any object typed `thinking`), a change to one of which alone moves no line.
The head's other fields, the model, `max_tokens`, `tool_choice`, `thinking`,
the tools' names, the headers, the path and the query, it writes unmasked,
and no run puts such a value in them. It leaves
out every header but `anthropic-beta` and `anthropic-version`, and keeps the
betas as a set, so their order and repeats move nothing. It writes alike an
omitted or null `system`, an empty list, and any other value that is neither a
string nor a list, while a string, the empty one included, is one text block;
an omitted, null or empty `tools`; a system prompt sent as a string and
as one text block, a system block's null or missing text and an empty one,
and its null or missing `type`; an omitted `thinking` and a null one; any
`stream` but `true` and none; a block's ephemeral cache marker with no TTL and
one of `5m`, though on a tool, the body or a message's own fields, where it is
part of a digest, the two differ; and a message's string
content and one text block, and its null or missing content, or any that is
neither a string nor a list, and an empty list. It writes alike an omitted and
a null `model`, an omitted and a null `max_tokens`, and an omitted, null or
empty `messages`, each of which the stand-in refuses. A `tool_choice`, even a null one, is refused as
unclassified, as above, and the head writes a null one as none. A head is named only on the
first line of its agent's under it, so a later request under a changed head
keeps its line, and the view still names it.

A line can also change when nothing its request sends does. Its delta is from
its agent's previous compile of the same kind, so a change to that compile
moves it too. A summary is named by the messages context-manager's provenance
says it covers, so a change to that provenance renames it. And `^` lists
context-manager's own cache marks, so a mark moved between the compile and the
request's assembly moves the line, with the body hash unchanged. No change to
one text renames another, since each key comes from its own text. The record's
other lines record the store and the run: summaries written and removed, reads
that failed, actions, checkpoints and the end.

## The view of what changed

The record diff says that a request changed. The view, which `run.mjs` writes
beside a head arm's record that differs from the base arm's, says what the resident received. A
request it shows is one whose line, read without its head note and with the
head in force for it, differs from the base arm's. A removed request
line (one carrying a body hash) identical to an added one elsewhere is a
request sent at another place. Within each hunk of the diff, an added
request line pairs with the removed one of its kind and agent it shares most
items with, among those written the same way, as a change or whole, while
any is left; a removed one left unpaired is a request the head no longer
sends. The pairing is the view's best reading; the record diff beside it is
what holds.

- **`summary.md`** has one row per run: its outcome (`pass`, its flags' count,
  `invalid`, or why it couldn't run, then the self-check's outcome where one
  ran), whether its record matched the base arm's, and for one that differs how many requests
  changed, then its counts. Those are, across every agent, the request compile
  calls made and refused (a refusal whose retry compiled counts as one of
  each), the requests to summarise messages and to merge summaries (as `run.json`'s `counts`, above), and the compression and merge quarantines entered during the run, each counted once per agent by its identity (a compression quarantine by its span's `chunkSourceHash`, so a chunk re-cut into a new span counts anew; a merge quarantine by its record's `key`). They're counted as the test module's takes of the store saw them, at each boot's ready, at each settle's end, after a reload's dry compile and at shutdown, so one that entered and cleared between two takes isn't counted. A kind is `unreadable` when any agent's read of it failed at any take, and both are `not reported` when no agent's strategy reports quarantines, as on a passthrough. Then the stored messages raw, summarised and left out at the last
  compile of the agent its checks judge (named in the row, H2's knowledge
  subagent for H2), the tokens sent (cached and uncached input), and the
  compile lines whose check 11 entries hold a breach or a part it couldn't
  judge; a compile it couldn't record isn't among them. `?` is a count the run
  couldn't give. Where anything isn't clean, the table is followed by where
  each run's report, record and view are in the evidence, then every flag of each flagged run. A missing product and a
  calibration edge, which a report counts apart from its flags, are in the
  run's `report.txt`.
- **`<run>/view.md`**, for each run whose record differs from the base arm's,
  has a section for each request whose record lines changed. Each section has
  its record line in its heading, cut at 200 characters (a changed line's
  moved items follow it whole, and a new or moved request's whole line is in
  the record diff), then, for an agent's request, the ledger of where each
  message of its turn's compile's view went (raw, raw with its body
  incomplete, under which summary, or left out: its one unit in
  context-manager's layout, so a message sent raw shows raw even where a
  summary sent also covers it, which check 11 flags), headed "As
  context-manager compiled it", since agent-framework can still drop a row after the compile,
  then the request's system prompt, tools and messages as the resident
  received them (its model, `max_tokens`, `stream`, `tool_choice`, thinking,
  headers, path and query, and `rest`, a digest of every other body field, are
  in the record's head line, named by key on the first request's line under
  it):
  - the stack's words, verbatim: the system prompt, each tool's definition,
    templates, notices and framing. The run's content is marked in messages
    alone. Run content a host put into the system prompt or a tool's
    description would show there verbatim, as stack words, while the record's
    head line still moves;
  - the run's own content, as its mark, its length and a short head, with
    `chars a–b of n` where only part of it went, thinking included. A stretch
    shorter than 32 characters is never taken as the run's, and one shorter
    than 47 may not be, since the index keeps a 32-character key every 16
    characters, so it shows verbatim whoever wrote it: a short reply, an image
    result's bare canary, or a heading context-manager split into a block of
    its own. A run span ends where the request's text stops matching the text
    the run generated, so if a stack text continues a cut run text with the
    very characters the run text goes on with, those characters show inside
    the span. A change there still shows, as a different span and the changed
    words;
  - a message's fields besides its role and content, shown beside its role,
    and a block's fields besides those its line shows, shown beside its type,
    each masked as the message's digest masks it. A transcript of a request
    holding a result opens with the form nearly every result in the runs
    takes, content as a string with `is_error: false`. A result in that form
    is unmarked, and one departing from
    it says how, as `(content as blocks)` or `(no is_error)`, since the digest
    tells those forms apart and a mark on every line would show no change;
  - a tool's definition already shown in that view is named again rather
    than repeated, and so is any other stack text of 200 characters or more;
    a shorter one always shows.
- **On GitHub,** the job's summary holds `summary.md`'s text and then as many
  views as fit within its 1 MiB, GitHub's limit for one step's summary
  ("Step isolation and limits" in its workflow commands reference), naming
  each one that didn't fit and where it is in the evidence the job keeps, or,
  where even those names wouldn't fit, saying how many didn't. Where
  `summary.md` itself is longer, the summary holds as much of it as fits and
  says how many flags it left out; every flag is in `summary.md` and in its
  run's `report.txt`. The evidence is what `--out` holds. An invocation
  appends to whatever the step's summary file already holds, as a view's
  second arm does after its first in one step, so it takes only what the file
  leaves of that 1 MiB, and adds nothing where even its notes wouldn't fit.
  A run that couldn't run shows no view there, and keeps none in `--out`,
  even one written before it failed.

## The differences as data

With `--against`, `entries.json` at `--out`'s root groups every difference between the two arms' records into entries, one per kind of difference, for the context view's reader. It's `[]` when no record differs. A run whose record differs has at least one place: two records that differ where no kind of difference is found, such as only in their order or a trailing newline, fail the run as couldn't run, "its differences couldn't be grouped", so a run never reads as differing with nothing to show. Each entry is `{id, describe, count, runs, places, examples}`:

- **`id`** is the first 12 hex of the sha256 of the entry's signature, so one kind of difference has the same id in every share's file.
- **The signature** is the kind of difference. For a record line, it's the line's kind (its first word) and, for a line that changed, the tokens it lost and the tokens it gained, each set with hex runs of 8 or more written `H`, digit runs `#` and canaries `C`, any trailing `…` dropped (the mark a token repeated in a row takes, though one the line itself ends a token with goes too), then sorted, each once. For a template or head text, it's the text's role and which arm alone has it. The role is its key less a final 12-hex digest, masked as tokens are, and with each run of hex letters and `#` that holds both, such as a memory id `m#add#` from `[[s:M56add800]]`, and a memory id of digits alone, `m#` or `memory-#` from `[[s:M12345678]]`, written `H`, so a fork's text names one role whatever its memory. A step only one arm recorded, one whose lines are in only one arm's record (a step that writes no lines, such as a WebUI suppress, has no section, so a step both arms ran reads so when only one wrote lines for it), and a changed header, are kinds of their own.
- **`describe`** says the kind in words, such as "`compile` lines whose `H p.C,` became `H L#(p.#), p.C`".
- **`places`** lists each `{run, step, digest}` it occurs at, in `RUNS` order and then the record's; `count` is how many, and `runs` which runs. `digest` is the first 12 hex of the sha256 of the place's two sides, filled as the examples' are, so two entries whose places are the same have the same text at every place, not only at the first. Each place stands for one difference and carries its own digest, so merging the shares' entries by `id` and sorting their places stably by their run's position in `RUNS`, and by nothing else, gives the same list whatever the split, with the first example's place first.
- **`examples`** has one `{run, step, before, after}` for each run the entry occurs in, at that run's first place, in `RUNS` order: its two sides, whole, the record line or text before and after, empty where one arm has none. A template's text has each `#` filled with the number its first use on that side names, unless that use names another count of numbers, when it's left as written. One per run lets whoever shows an entry take its example from whichever of its runs it chooses, such as the first run it could compare. Merging the shares' entries concatenates the examples and sorts them by their run's position in `RUNS`, as it does places; with one example per run, that order is unique, so the examples, like the places, come out the same whatever the split.

Within each step, lines are paired by the harness's longest-common-subsequence diff: in each stretch of lines that differ, a removed line pairs with the first unpaired added line of its kind, and the rest are in one arm only. A template or head text is never paired across the arms: its key is a digest of its own text, so two texts of one role may be two different texts, such as two summaries, and the grouping doesn't claim one became the other. Each is in one arm only, and the reader, not the grouping, says which correspond. Every differing line is in exactly one entry: two records whose one key names two texts, which only a collision of the keys' digests could give, fail the run at the grouping stage, as two records that differ with no difference found do.

## What each run's checks judge

Each run's `report.txt` lists its flags and the checks' counts. A flag, a note or a reason the record or the
summary shows cut short, such as a thrown error, a command's output or a long
list of names, has its whole text on the line under it, `  whole: …`; a run
that couldn't run has its reason there, whole the same way. Two reasons are
exceptions: a failed read's, of a store, a strategy or pins, shows its first
200 characters, with no whole in `report.txt`, though the run's `log.jsonl`
keeps the whole of the test module's own reads of a store's messages, its
summary listing, its receipt and its quarantine, and a self-check's that couldn't run is in the summary and the job's
log but not `report.txt`, with no whole where it was cut. A host's whole
output is each boot's `host-N.log`, in the run's directory, or in
`checkpoints/RUN/` for the drive that writes RUN's checkpoint; a failure that
shows the host's last lines names that file.

- **Check 1: every turn answers.** It flags a request the stand-in refused or
  couldn't classify, an inference that failed or was exhausted, an operator
  alert the host raised, a step that didn't settle, and a turn whose
  answer the host reported it couldn't route to its channel. A step a workload
  marks `mayFail` may fail by design: its failure and its context refusal are
  its workload's property to judge. Workloads mark only the turns a budget cut
  can make fail: W8's and H4's reader's from the first cut through the two
  turns after the restore, which W8's property allows, and W11's from its cut
  to its restore. A step marked `retries` meets a scripted error that
  agent-framework retries, so check 1 owns only that `inference:failed`, and
  the turn must still answer. Check 1 also flags a step that leaves a scripted
  reply unused, its agent's or its subagent's, since a run that doesn't use
  its script hasn't exercised what the script sets up, such as W9's fork. A
  step marked `mayFail` whose failure check 1 owns is exempt: its host
  refused before asking for the rest.
- **Check 2: declared products.** A continuation segment that declares a
  product exists to produce it, such as a merge, a request carrying both
  results with one an image, or a thinking-led call. Check 2 fails a segment
  that didn't. A configuration can declare no product for a segment, as one
  that doesn't summarise does for its merges, and check 2 then judges nothing
  there. A product that needs the final store, where the run has none, is
  counted beside the judged.
- **Check 3: budgets.** It holds each request the run's agent sent, as the
  stand-in received it, to the bound that governs it. The stand-in counts
  tokens by its own model, several percent from context-manager's estimate
  either way, so it holds requests to the provider's window; context-manager's
  own count against its budget is check 11's.
  - **A compiled request**, a turn's first or a stream restart's, is held to the
    model's window by the stand-in's count of its whole input.
  - **A continuation round** is held to agent-framework's stream bound by its
    stream's fresh input before it, the `input_tokens` summed from the turn's
    compiled request onward, as membrane sums its usage. A subagent's bound is
    the one its launch notice states.
  - **Where the host reports, for a binding model, that the agent's window and
    not its stream bound breaks its stream,** rounds aren't held to the stream
    bound, and the report's notes say so.
  - **A request answered with a provider error isn't judged,** and its retry is.
  - **It can't judge** a request with no usage, a host report of a bound other
    than the one it holds, or an agent with requests and no compile line. Each
    is a flag of its own.
  - **Where a `/budget` report has no line for the run's agent,** or writes it
    in neither of the two forms the host writes, its budget and last use alone
    or followed by the window clause, which bound governs can't be read, so the
    check judges nothing and the run can't be compared. A subagent, launched
    after the boot's report, isn't looked for in it.
- **Check 4: coverage.** Every stored input and reply goes out in each request,
  raw or inside a summary sent, once, and in store order within its window.
  It applies where the run's store was read and holds a summary: a run that
  completed under a configuration that compresses (`judge.mjs`), so not H3's
  passthrough runs. A store with no summaries is check 5's `no-summaries`
  flag, and checks 4 and 5 judge nothing of it, as in
  C3h/W7/fable-no-tools, which raises that flag at context-manager 0.24.0, since with a Fable-family compression model and no tools declared every L1 is deferred. A request
  whose own input the final store doesn't hold isn't judged, and the report's
  judged line counts those beside what it judged. A subagent's inputs carry
  canaries of their own rather than a step's `.in`, so a subagent request's
  own input is the newest stored message it carries, and a message stored
  after it isn't asked for.
- **Check 5: bookkeeping.** Every summary declares only sources its
  compression request showed: the inputs and replies it covers, or the
  summaries it merges. For a subagent, whose inputs and replies carry canaries
  of their own, every source it covers. For the primary agent, a summary of
  tool results alone holds nothing to its request, and isn't counted as
  judged; nor is a merge of such a summary when neither its number nor its
  sources' numbers were sent, since a merge can carry it as its sources raw.
  Where the store holds a summary a summariser request wrote and check 5
  judged none, that's a couldn't-judge flag. A summariser answer whose summary
  the final store doesn't hold, and a source nothing of which carries a canary
  to tell by, are counted beside the judged. A source the store read doesn't
  hold is a flag. A summary context-manager wrote with no summariser request,
  such as a quiet stretch's, carries no stand-in mark, so check 5 can't judge
  it, and the report's notes name it.
- **Check 6: windows raw.** Each request carries raw the two turns before its
  own, less what an operator suppressed before it, and each segment's last
  request the head and the raw tail the host reported at its checkpoint. A
  message of those two turns that the final store doesn't hold isn't asked
  for, and the judged line counts those. Each checkpoint tail judged counts
  as judged, and one whose last input the final store doesn't hold is counted
  beside. Judging none is a flag only for the primary agent's requests. For
  H2 it runs on the knowledge subagent's requests, which its checks judge, and
  judges none of them, since the subagent's store holds no turn the window
  asks for.
- **Check 10: calibration edge.** A calibration multiplier at the clamp's edge
  (0.6 or 1.8) makes the run invalid, since its folds are clamped. It reads
  the multipliers in the host's health panel, at each checkpoint and at the
  run's end, and applies to an adaptive configuration whose panel reports a
  context composition. A read that failed, the panel answering `ok: false`
  or naming a `contextComposition` read failure, is a couldn't-judge flag,
  and so is a completed adaptive run that logged no end-of-run read, read or
  skipped. A panel that reports none holds nothing it could
  judge: the host's panel gives an agent's composition from its last live
  compile, and context-manager keeps none after a branch switch until the
  next one. H4/W1's `/undo` switches the resident's branch while it's tuned
  out, so its end panel reports none.
- **Check 11: compile invariants.** What the test module found wrong with each
  compile context-manager made, judged on what it sent against the store it
  compiled from, as it stands when the compile returns: the agent's own slot,
  and for an agent whose view merges another's, such as the Subconscious
  reader, the members of its view that slot holds. Each flag is named
  `agent:kind:invariant`.
  - **`coverage`:** where the strategy compresses, every stored shard goes out,
    raw or under a summary sent, and no stored message goes out under two.
    A summary sent in more than one message counts once: context-manager's
    autobiographical strategy sends a summary as a recall pair, a question and
    its answer. A raw copy of a body holds a shard when it carries every shard,
    which context-manager says by not marking it `!shards`, or when it carries
    that shard's text. Text is matched among the shards context-manager's
    layout sends raw, where it names any of that body's, and a shard with no
    text is held by any raw copy of its body.
    Each message covers nothing earlier than the one before it, in store order,
    except that after a head-window reset the head, which starts at the newest
    topic transition, goes first and the history from before it follows. A
    message is placed by the earliest stored message it carries: a raw copy by
    the earliest shard whose text it holds, among those context-manager's
    layout sends raw, each occurrence of a shard's text taken once, in order,
    so a repeated copy takes its own; or, where it holds none, by the first of
    those shards if it is the body's one copy and carries every shard.
  - **`beside-sources`:** no stored message goes out raw beside a summary of it.
  - **`budget`:** a compile that enforces its budget sends no more than its
    input budget plus the strategy's grace, or refuses. A compile given no
    budget is held to context-manager's own default. A compile is judged on
    its own render stats, a dry one's included, never the manager's last live
    compile's. A compile whose strategy gives no render stats, such as
    passthrough, isn't judged for its budget: the report counts those
    compiles beside check 11's judged ones, by strategy, and so does the
    record's `totals` line.
  - **`shape`:** a call and its result that the store holds together aren't
    sent apart. A passthrough's promise is narrower: no request opens with a
    result whose call lies before its start.
  - **`thinking`:** a stored body's thinking goes out with its calls, or not at
    all.
  - **`pins`:** a summary sent over pinned messages is at a level the pin
    allows.
  - **Couldn't-judge flags,** which say what wasn't judged rather than that
    context-manager broke something:
    - **`unplaced`:** what store order couldn't place: a raw copy that holds
      none of its shards' text, where the body goes out in several messages or
      its one copy doesn't carry every shard; a copy of a body no
      slot read holds; or a summary none of whose messages a slot read holds.
      The order is judged without it, and the report counts what it couldn't
      place beside check 11's judged compiles.
    - **`unreadable`:** a read an invariant needs failed, so that invariant
      wasn't judged, and the report counts it beside check 11's judged
      compiles as a read that failed. Two are judgements of what was read
      rather than failed reads, and aren't counted so: a compile whose
      strategy gives render stats gave none, and a pin names a message the
      compile's view doesn't hold.
  - **`unrecordable`:** the module couldn't record the compile at all.
- **Check 12: reloads.** At a restart with a reload check, the dry compile
  after the boot matches the one before the shutdown: the same outcome, the
  same messages from the same stored sources with the same content, the same
  system injections. Two dry compiles that refused alike show no compile on
  either side, so that reload is couldn't-judge.
- **Check 13: pairing.** Every request compile reached a request: the first of
  its agent's requests to arrive at the stand-in after it, before the agent
  compiled again. The module stamps each request compile as it hands it back,
  and the stand-in each request as it arrives, both from the machine's
  monotonic clock on Linux, so the order is what happened. Any other request
  is a round. This rests on one agent's requests going one at a time, and on
  where agent-framework 0.32.0 makes a request compile, one made through the
  agent's `compileWithInjections` or `compileContext`: only at a stream's
  start, a restart included (at the context budget, or the tool-result guard's
  retry), with a compile refused and repeated within one start counted once.
  A compile is the request's only while agent-framework's call that assembles
  the request is open; one that work the call started makes after the call
  settles isn't the request's.
  Nothing in agent-framework's or connectome-host's own code calls
  `compileContext` or the direct inference API. A request compile that didn't
  go out while the agent's stream still had a round to send would pair with
  that round, as a restart's compile does. It judges
  each agent that compiles, its subagents and readers included, with a count of
  its own. It can't judge an agent where a compile or request carries no
  stamp, as on another platform, or where a pair's request doesn't end on its
  compile's last canary, which a clock the two processes don't share would
  show. The stand-in tells only the configuration's own agent's requests from
  the rest, so where two other agents compile, each gets a couldn't-judge flag
  instead.
- **Check 14: the workload's own property,** which `workloads.mjs` states for
  each workload. A property either counts what it judged or names the check
  that judges it, and is then held to that check's count. A completed run
  whose property does neither, or names a check that judged nothing, is a
  couldn't-judge flag. The continuation names check 2, W7's variants but
  merges-refused and chunk-refused check 1, which flags every alert not
  owned, and W9 check 12. W7's
  chunk-refused puts a mark in its third turn's message, and the stand-in
  refuses every summariser request that carries the mark, wherever it sits:
  its system prompt, its tools, or any block of any message.
  The property judges each such request, those the stand-in refuses for
  another reason first included: an L1 request may carry it only in its
  messages after context-manager's notice that opens the slice to remember,
  and a merge not at all. context-manager sends that notice once, and a
  slice may quote it, so an L1 request that carries the mark in its messages
  with no notice, or with more than one, can't be judged, and the run can't be
  compared. One that carries it outside them is ahead of the slice. As merges-refused does
  for its merges, it also takes
  check 1's off-path refusal alerts and holds each step to one per refused
  request. W5
  takes each body from every messages read, so a body removed before the
  run's last read is still judged in the requests that sent it. W4 judges
  each of its own calls: its script gives each reply one call with its
  thinking ahead of it, and membrane merges two replies left adjacent, as
  when the result between them and the second's thinking are both dropped,
  into one message, so each call needs a thinking block between the call
  before it and itself. W11 judges each pin it adds, the first included, by
  the panel's list after it: exactly one new pin, and none of the earlier
  ones gone.
- **Check 15: binding control.** On a model that binds thinking and takes the
  drop control, every agent request carries
  `thinking.block_binding.prefix_mismatch_behavior: drop_block`, the host's
  own rule, and asks for the `thinking-binding-controls-2026-08-01` beta that
  control needs, which membrane adds whenever it sends `block_binding`.
  Without them an enforcing account refuses a request carrying a changed
  block.

Each check reports how many items it judged, on the report's `judged` line.
A count shown as `?` is one the check couldn't establish, and its own flag
says why. Where a check applies to a run and judged nothing, that's a
couldn't-judge flag, never a pass.

## Flags across the arms

With `--against`, each run's flags are compared with the base arm's, and its result in `run.json` lists them as `new` (raised on the head and not the base), `gone` (raised on the base and not the head) and `kept` (raised on both). Each is the flag's check, its step (`the run` for a run-level flag, a segment's name for a missing product), its kind (`what`, where it has one), its detail as the report shows it, cut where the report cuts it (its message, for a flag with no detail), and, where that was cut, `whole`, the first 12 hex of the sha256 of the whole text. Flags are compared by those five, counted one for one, so two flags that differ only past the cut are two flags, and a flag the head raises once more than the base is `new` once. A check 11 flag is compared by its detail, not its message, since its message names its compile by number, which a change earlier in the run can move. A check 10 clamp edge and check 2's missing products are compared as flags too, though the report counts them apart from its flags. With no `--against`, every flag is `new`. A run the base arm couldn't run, or the head couldn't, has no `flags`.

A flag both arms raise is the stack's before the change as much as after it, so it moves nothing: a known finding shows as `kept` until a change fixes it, when it shows as `gone`. A `gone` flag beside a `new` one at the same check and step usually means a flag's detail moved, such as a count or a message index that changed. Read the two details to tell a finding that moved from one that went and another that came.

A run that didn't measure is another matter, kept or not, since a base arm that didn't measure doesn't make the head's run a measurement. Each result lists in `unmeasured` how its run didn't: "the run failed", "its folds were clamped (check 10)", or "check N (NAME) judged nothing" for each check that applies to the run and judged nothing, a completed run's workload property among them whenever its count is 0, whether or not the property also says why. Its summary row says so after its outcome, as "didn't measure: …", each of the base arm's marked "(base arm)", and so does the invocation's output. With `--against`, `baseUnmeasured` lists the base arm's. A run with either list non-empty can't be compared, and the invocation exits 2. The same holds for a run whose `readsFailed` or `baseReadsFailed` names a failed read, said in its row as "a read failed: …", since a broken read on either arm shows as a difference between them, through a record line, a check 11 flag or an unknown count, and none of those is the change's. A run that stops the same way in both arms would otherwise give the same record up to the stop, and a kept flag, for a run that never reached the rest of its script.

## When the format changes

A change to what a record writes changes the records of both arms alike, so it adds no difference of its own to a view of a pull request, though it can change which of the pull request's differences a view can show; it updates this file in the same change.
