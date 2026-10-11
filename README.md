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
| `source` | clone `main` of voice-kit, mcpl-core-ts, membrane, context-manager, agent-framework, connectome-host, mcpl-harness, heartbeat-mcpl, discord-mcpl, portal (protocol/client/mcpl/relay); per package, in its own install: strict `npm ci` → build → typecheck → test, in `file:`-link order (voice-kit before discord-mcpl and portal-relay), and the host booted twice. Then compose every stack package into one tree (a single `@animalabs` symlink root, nested copies removed; chronicle from npm — Rust), prove under node and bun that every package resolves its stack dependencies to the checkouts, and build, typecheck and test every package with a stack dependency there; typecheck, test and boot the host there. With `--change`, one repository is at its change merged onto `main` (see below). |
| `stores` | the host — a published release, or one already built with `--host-dir` — boots on a **copy of each store an earlier host release wrote** (`fixtures/stores/<version>/`) and takes a turn. The anthropic provider runs against a local stand-in that records each request, and a fixture passes only if the request carries both of the fixture's stored turns and the heartbeat tools: proof the old history was read, not just opened. |

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
node scripts/capture-store.mjs --version 0.9.0 # add one release's fixture
```

Options: `--workdir DIR` (default: a temp dir, deleted on pass unless
`--keep`; the source lane never deletes it), `--report FILE`, `--summary FILE`, `--host @animalabs/connectome-host@<spec>`.
Exit 0 = pass. The source lane's own options and exit codes are below.

## Checking a change before it merges (source lane)

`--change <repo>=pull/<n>` or `--change <repo>=<owner>:<branch>`, either optionally ending `@<commit>` to pin the head you saw. It's repeatable: changes in different repositories are checked together, and several in one repository are merged in the order given. A pull request's head is fetched from the base repository's `refs/pull/<n>/head`, so a fork's PR needs nothing more; a branch is fetched from `<owner>`'s fork of the repository. Each change is merged onto `main` with `--no-ff`, in a clone with its whole history, so the result is exactly what merging now would leave on `main`.

`--main <repo>=<commit>` pins a repository's `main` to that full 40-character commit, in either mode. A change then merges onto that commit. Passing every repository's `main` from an earlier change run's `report.json` (`repos.<repo>.main`) gives a main-mode baseline at exactly the mains that run used.

`--out DIR` (default: the workdir) receives `report.json`, `summary.md` and `logs/`, one log per step, with the host's output and IPC events. `report.json` is rewritten after every step, so a run killed from outside leaves a partial report with no `outcome`.

What a change run checks:
- **The changed repository in its own install,** as a fleet box runs it after the merge: its lockfile's dependencies from npm, only `file:` siblings linked. Install, build, typecheck, tests, and for the host both boots.
- **The combined tree,** for the changed packages and every package that depends on them, directly or not, read from each checkout's `package.json`: build, typecheck and tests against the other repositories' `main`. The host is always checked there: typecheck, tests, both boots.

`report.json` holds `outcome`, `change` (each change's base, head, merge base and merge commits), `repos` (each repository's commit, its `main`, and the tracked files an install changed), `packages` (lockfile, its hash, the install command, and what npm resolved where no lockfile is committed), `toolchain`, `dependents` (with the declared dependency that put each there), `links` (each link the combined tree made, the range the dependent declares and whether it admits the linked version), `resolution` (the proof, per package, dependency and runtime) and `steps`. Each step has a stable `id`, `<package>:<tree>:<stage>` such as `agent-framework:combined:test`, or `<package>:install`, `<repo>:clone`, `compose:link`, `compose:resolution`; the ids are the same in main mode, which checks every package in its own install and every package with a stack dependency in the combined tree, so a change run's failure can be compared with a main run's. (A package with no stack dependency has no combined steps: its combined tree would be its own.)

| exit | `outcome` | meaning |
|---|---|---|
| 0 | `pass` | every step passed |
| 1 | `break` | a step failed: tests, a typecheck, a build, a boot, a step's own timeout, or an install the commit breaks (a lockfile that doesn't match `package.json`) |
| 2 | `error` | the check couldn't run: a clone or fetch failed, a pinned head moved or a pinned main was unreachable, the registry or network failed, the disk filled, a tool was missing, or the arguments were refused |
| 3 | `conflict` | a change doesn't merge cleanly; `conflict` names the change, what it was merged onto, and the files |

## Stored fixtures (`fixtures/stores/`)

Each `fixtures/stores/<host version>/` holds the data directory that host release left after two turns with the heartbeat server (`data/`), and `fixture.json`, its provenance:
- the dependencies as a consumer had them while that release was `latest` (npm's `before` set to one second before the next release was published), with every resolved `@animalabs` version;
- the toolchain and platform it was written on, smoke's commit, and each capture step;
- the two turns' texts, which the check looks for in the new turn's request;
- any absolute paths of the capture's work directory found in the store, which a copied store carries but a resident's never moves away from.

`node scripts/capture-store.mjs --version <v>` makes one, and `--missing` captures every published release that has none, so a new host release gets its fixture the same way. Hosts before 0.8.0 have no `mock` provider, so capture and check both use the anthropic provider against `lib/fake-anthropic.mjs`, a local stand-in reached through `ANTHROPIC_BASE_URL` that records every request.

The `stores` lane runs the check on a published host or one given with `--host-dir`: one step per fixture, `stores:<version>`. A fixture passes only if its turn completes and the request carries both stored turns and the heartbeat tools. A fixture without readable provenance or data can't be checked, which is the check failing to run (`infra`, exit 2), not a break.

**What this can't see:** a mock session holds only the shapes ordinary turns write, not what a resident's long history holds (summaries, compression state, images, tool results at scale). Each release is resolved at one point of its range. The fixtures are written by today's node and bun. And releases stand in for residents who run `main`.

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
