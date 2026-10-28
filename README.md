# connectome-smoke

Smoke tests for the **published** Connectome stack — proof that what is on
npm installs from nothing, builds, boots, and takes a turn — plus a
separate lane for the repos' `main` branches laid out the way fleet boxes
deploy them.

Runs on GitHub Actions: every 30 minutes it polls the registry and runs
when the set of published versions changed (debounced, so a cascading
release membrane → cm → af → host is tested once, settled), or on demand.
Results go to `#connectome-ops` (Discord webhook) and the run's job summary.

## Lanes

| lane | what it proves |
|---|---|
| `published` | `npm install @animalabs/connectome-host` (+ heartbeat-mcpl, discord-mcpl) into an empty dir resolves, postinstall builds the web UI, chronicle's native binding loads, the host's TS source typechecks against the published deps' `.d.ts`, the host boots headless on the mock provider with a real MCPL server, takes a turn, serves `/healthz` (auth enforced), writes a provider receipt, offers the MCPL tools to the model, shuts down clean — then boots **again** on the same store and takes a second turn. Reports each package's resolved version vs. its `latest` tag (caret on 0.x is minor-locked, so a consumer can legitimately be behind — the report shows it) and nested duplicate copies of core packages (fails on core). |
| `latest` | same, with every `@animalabs/*` forced to its `latest` dist-tag via npm overrides — "is newest-of-everything coherent?" |
| `source` | clone `main` of voice-kit, mcpl-core-ts, membrane, context-manager, agent-framework, connectome-host, mcpl-harness, heartbeat-mcpl, discord-mcpl, portal (protocol/client/mcpl/relay); per package, in its own install: strict `npm ci` → build → typecheck → test, in `file:`-link order (voice-kit before discord-mcpl and portal-relay), and the host booted twice. Then compose every stack package into one tree (a single `@animalabs` symlink root, nested copies removed; chronicle from npm — Rust), prove under node and bun that every package resolves its stack dependencies to the checkouts, and build, typecheck and test every package with a stack dependency there; typecheck, test and boot the host there, then boot it on each stored fixture (below). With `--change`, one repository is at its change merged onto `main` (see below). |
| `stores` | the host — a published release, or one already built with `--host-dir` — boots on a **copy of each store an earlier host release wrote** (`fixtures/stores/<version>/`) and takes a turn. The anthropic provider runs against a local stand-in that records each request, and a fixture passes only if the request carries both of the fixture's stored turns and the heartbeat tools: proof the old history was read, not just opened. |
| `cache-write` | whether a resident stepping from one host release to another would have its **prompt cache written again**. It installs the base (`--base`, default `latest`) and the candidate (`--candidate`, a spec or a packed release) as a consumer would, each as npm's `before` filter takes the lane's start, or the base as it takes `--base-before`. It runs the `stores` check on every fixture under the base twice and the candidate once, with the base's heartbeat-mcpl for both, and compares what each request carries before the turn's first message: the model, the tools, the system prompt, the request's settings (such as `tool_choice`, `thinking`, `output_config` and `speed`, and any the API adds, with their keys sorted; not `max_tokens`, `stream`, `metadata` or sampling, which shape only the answer), the earlier messages, key order included, whether its messages hold an image or anything with citations on, the cache markers, apart from the rest, and its API version and betas. Its cache line names each reach the differences have, by the API's caching guide (a change of model reaches the whole cache by the check's own rule, since a cache is kept per model), in the request's order, with up to two of the places that have it and how many more; each fixture's step names every place, each changed tool among them. A fixture that differs only where the guide doesn't place is one it can't tell for. It prints the line before its report path and result lines, and the summary carries it after its headline. The base's second run is a control: where it differs from the first anywhere, that fixture's verdict is `noise`, and the lane can't tell. Noise means something in the request changes between two runs of the same release, so find what before running again. |
| `strategies` | the **context-management strategy fixture** (`lib/strategies/`): a host continues a deep session store, cached per configuration, for about a dozen turns against a scripted stand-in for the Anthropic API, and the run is judged against what the strategies promise. Inside the `source` lane it's the step `connectome-host:combined:strategies:default`; this lane writes the cache it continues from (`write`) and checks a host by hand (`check`). See below. |

Every lane leaves `report.json`, `summary.md`, the host's output and the full
IPC event stream as artifacts.

## Run locally

Needs node ≥ 20, npm, bun (the host runs under bun), git.

```sh
node lanes/published.mjs                       # consumer view
node lanes/published.mjs --lane latest         # newest-of-everything
node lanes/source.mjs                          # mains, ~10 min
node lanes/source.mjs --change connectome-host=pull/231 --out out/   # one PR merged onto main
node lanes/stores.mjs                          # latest host on every stored fixture
node lanes/stores.mjs --host-dir <host checkout> --heartbeat <heartbeat-mcpl entry>
node lanes/cache-write.mjs --candidate <packed release .tgz>   # against latest; --base, --base-before
node scripts/capture-store.mjs --version 0.9.0 # add one release's fixture
```

Options: `--workdir DIR` (default: a temp dir, deleted on pass unless
`--keep`; the source lane never deletes it, and `cache-write` keeps the default
one's report and summary on a pass and all of it otherwise, as evidence for its
failing steps: remove it when you're done; given a directory, `cache-write` makes
its own inside it and deletes nothing there), `--report FILE`, `--summary FILE`, and for the `stores` and `published`
lanes `--host @animalabs/connectome-host@<spec>`.
Exit 0 = pass. The source lane's own options and exit codes are below. The
`cache-write` lane exits 1 when any fixture shows a write, whatever the others
show; else 0 when every fixture's requests are the same; else 2, when it can't
tell.

**What the cache check can't see:** it covers one recipe: claude-sonnet-4-5 on
the anthropic provider with its default formatter, heartbeat-mcpl as the only
MCPL server, and subagents, lessons, retrieval, wake and workspace off. A
resident on another model or formatter, with other servers or with those
modules on, is covered only if a fixture runs its recipe. Both releases run
with the base's heartbeat-mcpl, so what a heartbeat-mcpl release of its own
changes isn't measured. So its line reads "none found in the fixtures'
requests", not "no resident's cache is rewritten". Both releases are
installed as of the lane's start, by npm's `before` filter, which takes only
versions published by then and reads dist-tags as they stand now. So it measures
what the host release changes, not what a resident's older dependencies would;
`--base-before` installs the base as that filter takes an earlier time. The
caching guide doesn't place the request's API version or betas, or a setting it
doesn't name, and the line says so for a difference there. A web search toggle
shows as a tools change, which the line gives the whole cache, wider than the
guide's system prompt and messages. A cache marker that moves, appears, goes or
changes its TTL, and an effort given on one side only, are differences it can't
tell for: the marker that ended an entry isn't in that entry's hash, as the
guide's lookback example shows, and what moving any marker costs depends on where
earlier requests wrote; and an effort set to the model's default writes nothing,
by the guide, a default the check doesn't know.

## Checking a change before it merges (source lane)

`--change <repo>=pull/<n>` or `--change <repo>=<owner>:<branch>`, either optionally ending `@<commit>` to pin the head you saw. It's repeatable: changes in different repositories are checked together, and several in one repository are merged in the order given. A pull request's head is fetched from the base repository's `refs/pull/<n>/head`, so a fork's PR needs nothing more; a branch is fetched from `<owner>`'s fork of the repository. Each change is merged onto `main` with `--no-ff`, in a clone with its whole history, so the result is exactly what merging now would leave on `main`.

`--main <repo>=<commit>` pins a repository's `main` to that full 40-character commit, in either mode. A change then merges onto that commit. Passing every repository's `main` from an earlier change run's `report.json` (`repos.<repo>.main`) gives a main-mode baseline at exactly the mains that run used.

`--out DIR` (default: the workdir) receives `report.json`, `summary.md` and `logs/`, one log per step, with the host's output and IPC events. `report.json` is rewritten after every step, so a run killed from outside leaves a partial report with no `outcome`.

What a change run checks:
- **The changed repository in its own install,** as a fleet box runs it after the merge: its lockfile's dependencies from npm, only `file:` siblings linked. Install, build, typecheck, tests, and for the host both boots.
- **The combined tree,** for the changed packages and every package that depends on them, directly or not, read from each checkout's `package.json`: build, typecheck and tests against the other repositories' `main`. The host is always checked there: typecheck, tests, both boots.

`report.json` holds `outcome`, `change` (each change's base, head, merge base and merge commits), `repos` (each repository's commit, its `main`, and the tracked files an install changed), `packages` (lockfile, its hash, the install command, and what npm resolved where no lockfile is committed), `toolchain`, `dependents` (with the declared dependency that put each there), `links` (each link the combined tree made, the range the dependent declares and whether it admits the linked version), `resolution` (the proof, per package, dependency and runtime) and `steps`. Each step has a stable `id`, `<package>:<tree>:<stage>` such as `agent-framework:combined:test`, or `<package>:install`, `<repo>:clone`, `compose:link`, `compose:resolution`; the ids are the same in main mode, which checks every package in its own install and every package with a stack dependency in the combined tree, so a change run's failure can be compared with a main run's. (A package with no stack dependency has no combined steps: its combined tree would be its own.) A failing test step also has `failures`, its failing tests by name as its runner printed them; `failureCount`, the runner's count of failed tests from its summary, or `null` when the output has no count, as when a report is cut short before it; and `failuresParsed`, true when there's at least one name, the names are every failure the runner reports, and it reports no error outside its tests (bun's and vitest's errors line). For node's spec reporter the names are the list of failures it prints after its summary, and every test it printed as failing before must be in that list (a group's own closing line can't be held to it, since node closes a parent that failed only through its subtests the same way and leaves it out); its count can exceed them, since it takes in a test that failed only through its subtests. For any other runner they must be as many as its count. A step stopped at its time limit before any count printed has `failuresParsed` true when there's at least one name. A test that prints another runner's report into the step's output can make these read wrongly, since its lines stand in for what the runner's own output lacks.

| exit | `outcome` | meaning |
|---|---|---|
| 0 | `pass` | every step passed |
| 1 | `break` | a step failed: tests, a typecheck, a build, a boot, a step's own timeout, or an install the commit breaks (a lockfile that doesn't match `package.json`) |
| 2 | `error` | the check couldn't run: a clone or fetch failed, a pinned head moved or a pinned main was unreachable, the registry or network failed, a step failed saying ENOSPC while the filesystem of its directory, the temp directory or the home directory was nearly full (`diskFull` in `lib/stack.mjs`), a tool was missing, or the arguments were refused |
| 3 | `conflict` | a change doesn't merge cleanly; `conflict` names the change, what it was merged onto, and the files |

## Stored fixtures (`fixtures/stores/`)

Each `fixtures/stores/<host version>/` holds the data directory that host release left after two turns with the heartbeat server (`data/`), and `fixture.json`, its provenance:
- the dependencies as a consumer had them while that release was `latest` (npm's `before` set to one second before the next release was published), with every resolved `@animalabs` version;
- the toolchain and platform it was written on, smoke's commit, and each capture step;
- the two turns' texts, which the check looks for in the new turn's request;
- any absolute paths of the capture's work directory found in the store, which a copied store carries but a resident's never moves away from.

`node scripts/capture-store.mjs --version <v>` makes one, and `--missing` captures every published release that has none, so a new host release gets its fixture the same way. Hosts before 0.8.0 have no `mock` provider, so capture and check both use the anthropic provider against `lib/fake-anthropic.mjs`, a local stand-in reached through `ANTHROPIC_BASE_URL` that records every request.

The source lane runs the check on the combined tree's host, after its two boots: one step per fixture, `connectome-host:combined:stores:<version>`, skipped when those boots fail. The `stores` lane runs it alone, on a published host or one given with `--host-dir`, with steps `stores:<version>`. A fixture passes only if its turn completes and the request carries both stored turns and the heartbeat tools. A fixture without readable provenance or data can't be checked, which is the check failing to run (`infra`, exit 2), not a break.

**What this can't see:** a mock session holds only the shapes ordinary turns write, not what a resident's long history holds (summaries, compression state, images, tool results at scale). Each release is resolved at one point of its range. The fixtures are written by today's node and bun. And releases stand in for residents who run `main`.

## The strategy fixture (`lib/strategies/`)

**In a check of a change.** The `source` lane runs it on the combined tree's host, as the step `connectome-host:combined:strategies:default`, whenever the host is a changed package or one of their dependents, and always in main mode. It copies the newest cached store for the default configuration, continues it under the host checked, and judges the run. A flag, or a product the run should have produced and didn't, fails the step, and the step's `failures` name each one as `check N at STEP` or `check 2 at SEGMENT: PRODUCT`, the same from run to run, so the known red list can name one. When the candidate fails something, the same run goes again under each changed repository's `main`, built in a worktree beside its checkout and swapped in at the composed root for that run alone; the step's text then says which failures `main` shares. A failure `main` shares still fails the step, until its owner lists it as known red. A product neither side produced isn't a failure: that segment didn't run, and the text says so. Nor is an L3 merge, where the store's trial found none within its bound: the text says L3 wasn't exercised at this cut.

**The cache.** On the VPS it's `~/.cache/connectome-smoke/strategies` (`--strategies-cache` in the `source` lane, `--cache` here, name another). Each entry is one configuration's store, about 50 MB at 350 turns, under a key of the lane's version, the configuration, its recipe and the stack's versions, with bun's. The lane's version is a hash of every file under `lib/strategies/` and of `lib/common.mjs`, so a change to anything else in this repository keeps the cache. A check continues the newest entry for its lane version and configuration, whichever releases wrote it, and names them. A write keeps the newest two entries per lane version and configuration and removes other lane versions' entries a day after they were written.

**Writing it.** `node lanes/strategies.mjs write [--candidate <spec or packed release>] [--configurations a,b]` installs connectome-host as a consumer would (its last release without `--candidate`), writes each configuration's prefix through it, finds by trial the shortest prefix whose continuation produces every product (by `TRIAL` in `lib/strategies/script.mjs`: from its minimum, in its step, up to its bound; at the bound the entry records what was still missing), and runs the hard checks over it. It exits 1 when the hard checks flag, or when the trial reached its bound lacking any product besides an L3 merge, naming each, since no check on that cut would exercise it. Merging a change to `lib/strategies/` or `lib/common.mjs` into this fork's `main`: run `write` first, from that change's head on the VPS (`on-vps node lanes/strategies.mjs write`), so the cache holds an entry for its lane version before any check needs one. A check that finds none writes one from the last releases, under the key's lock, says so in its report with the time it took, and other checks wait on that lock.

**By hand.** `node lanes/strategies.mjs check --host-dir <host checkout or install> --install-dir <where its stack resolves>` runs one check, with no base. Exit 0 pass, 1 a failure, 2 couldn't run.

## Triggering

- **Manual:** Actions → *connectome smoke* → *Run workflow* (choose lanes;
  `force` runs even if the published set is unchanged) — or
  `gh workflow run smoke.yml -R anima-research/connectome-smoke`.
- **Automatic:** the 30-min poll. `scripts/manifest.mjs` hashes the set of
  `latest` versions; a run is skipped when that hash was already tested (an
  Actions cache entry `tested-<hash>`, saved only after the lanes completed)
  or when the newest publish is younger than `DEBOUNCE_MINUTES` (20).
- **From a publish workflow** (optional): `repository_dispatch` with
  `event_type: npm-publish` — treated as a poll tick, still debounced.

## What a failure means

- `npm install` fails → the published set is un-installable (a dep range
  points at nothing, a postinstall breaks, a native binary is missing).
- `typecheck published host src` fails → the host ships source that does
  not compile against the `.d.ts` its own dependency ranges resolve to.
- `boot #1` fails → the stack does not take a turn; the step detail carries
  the host's last 40 output lines and `*.events.jsonl` has every IPC event.
- `boot #2` fails → the store written by boot #1 does not reload.
- `source` per-repo failures name the repo and stage; `install` failures on
  discord-mcpl / portal-relay are usually the `file:` sibling not building.
- `<pkg>:own:*` fails → the package breaks in its own install, as a fleet box would run it.
- `<pkg>:combined:*` fails, `own` passes → the package breaks against another repository's `main`. Check `links` first: a link the declared range doesn't admit means the failure may come from an unreleased version, not from the change.
- `compose:resolution` fails → some package loaded a stack dependency from somewhere other than its checkout, so nothing after it would have tested the checkouts; the step names each one.

## Secrets

`DISCORD_WEBHOOK` — the `#connectome-ops` webhook (same one fleet-watch
uses). Absent, the notifier prints instead of posting.
