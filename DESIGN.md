# x: a self-building CLI for reading X

## Goal

`x` is a CLI that gets information out of X (Twitter) for the person whose account it is signed in as, by driving a real browser, and writes its own code for any read it has not done before. It is built on the machinery of `workday-cli`: the same `core/`, the same request queue, the same awf workflows that build and repair ops. Only the domain folder, `x/`, is new.

The reads it should end up covering:

- search posts, with X's operators (`from:`, `since:`, `filter:`, `min_faves:`)
- an account's profile and its posts
- a post's thread and replies
- the signed-in account's bookmarks, lists, and notifications

It only reads. Nothing it does, and nothing an agent does while building it, posts, likes, follows, sends a message or changes a setting. A request for an op that writes is declined at intake.

Ops start from none: the first op built through the workflows is reviewed by a person line by line and becomes the reference every later build copies (`x/authoring.md`). Everything after it is built on request.

The tool talks to X through the browser on the person's own sign-in. Once signed in, an op may call the web app's own endpoints with the browser session's cookies where that is faster than scrolling (see [Browser layer](#browser-layer)). X watches for automation, so pace and limits are part of the design ([Staying under X's limits](#staying-under-xs-limits)). Out of scope: X's paid developer API, writing to X, and running on a schedule.

## Core and domain

`core/` never imports from `x/`. It is the template's machinery, unchanged but for names (`XCLI_*` environment variables) and one hook: a domain's `appUrl` is also given the context's URL.

```
core/                       the reusable part: knows nothing of X
  cli.ts                    command parsing, help, output envelope, exit codes
  contexts.ts               named contexts (here: accounts) and their saved sign-ins
  ops.ts                    op registry, defineOp, step(), the runner, triage
  requests.ts               request ledger and the worker loop
  browser.ts                sessions and the `page` commands
  workflows/                awf workflows: build.ts (new ops, changes), repair.ts
x/                          the domain
  domain.ts                 sign-in check, the account a context names, page:search, page:posts
  helpers/                  Playwright moves every X page shares (open, search, profile, posts, errors)
  knowledge/                x.md, bot-detection.md, tenants/<context>.md
  ops/<op>/                 one folder per op
  authoring.md              how to write an op here; read-only rules; names the reference op
```

The workflows take the domain folder as an argument and read its `authoring.md`, knowledge and ops; they never name X. Their test-data rules come from `authoring.md` too, which for X says: read only.

## Interface

The CLI is the whole interface. Whoever calls it, a person or an agent, sees commands and text output, and never Playwright, selectors or a browser API. It follows airkit's conventions, so an agent that knows one knows the other.

```
$ x posts:search --query "from:jack bitcoin" --limit 3
url: https://x.com/jack/status/…
...

$ x account:posts --handle nosuchaccount_
error: no account @nosuchaccount_

$ x post:thread --url https://x.com/jack/status/20
error: there is no op post:thread; add --request to have it built
Next: to have it built, with anything the call doesn't say
  x post:thread --url https://x.com/jack/status/20 --request "…"

$ x post:thread --url https://x.com/jack/status/20 --request "replies too, oldest first"
request R-0001 filed: no op post:thread yet
Next: check on it
  x request:status R-0001 --wait
```

- **Nothing is built by accident.** A call to an op that doesn't exist fails with exit 2 and names the ops close to it; only `--request` files it.
- **Ops are `noun:verb`** (`posts:search`, `account:posts`, `post:thread`, `bookmarks:list`). `x help` lists them, grouped by noun; `x <op> --help` comes from the op's spec and input schema, so a new op documents itself.
- **One account per call.** Every call runs as the current context, or the one `--context` names (see [Accounts and contexts](#accounts-and-contexts)).
- **Text by default, `--json` for code.** The JSON is airkit's envelope: `{ "ok", "data", "error", "next" }`, where `next` lists `{ hint, cmd }` for what to run next.
- **Errors say what to do next.** A bad input says what is valid; a signed-out session says how to sign in; a rate limit says so; a filed request says how to check on it.
- **stdout is only the result.** Progress goes to stderr; a failure prints nothing to stdout.

| Exit | Meaning |
| --- | --- |
| 0 | done |
| 1 | unexpected error |
| 2 | bad input |
| 3 | precondition: no context, signed out, account or post not found |
| 4 | X refused it: a rate limit, a locked or limited account |
| 5 | pending: a request was filed or is open (op missing, changing or being repaired) |
| 6 | `--wait` gave up before the request finished |

## At a glance

An implemented op is all code: no model call, no tokens, as fast as X's pages allow. Coding agents are involved only through requests: an op that does not exist, a change to one, or a repair.

```
                    ┌───────────────────────────────────────────────┐
 x <op> ...       ─▶│ op exists? ─yes─▶ run the op (Playwright code) │─ok─▶ result on stdout
                    └─────┬───────────────────────┬─────────────────┘
                          │ no                    │ failed
                          │                       ▼
                          │                 triage (rules)
                          │                 │              │
                          │            op's fault     data, login, browser
                          │                 │              └─▶ error + next hint, exit 1-4
                          ▼                 ▼
 x request "…"       ─▶ request ledger  R-0012 received
 <op> --request ["…"] ─▶   │
                           ▼
                     worker: one awf run per request (run id = R-0012)
                     build (new, change) or repair
                     own worktree, own browser session
                           │  verified and reviewed
                           ▼
                     merged to main ─▶ the next call runs it as code
```

Triage is rules only, so a failing op never calls a model either. Not the op's fault: signed out, an account or post that is not there, a rate limit, the browser failing to start. Anything else is filed as a repair request.

## Requests

Building an op can take half an hour, so every change to the tool goes through a request: filed, queued, worked as its own awf run, and checked on later. Nothing blocks the caller unless it asks to wait.

### Filing one

| How | Kind |
| --- | --- |
| `x request "the replies under a post"` | whatever intake decides: new, change or duplicate |
| `x post:thread --url https://x.com/jack/status/20 --request ["…"]` (no such op) | new; the flags given are the first draft of its inputs, the text adds what they don't say |
| `x posts:search ... --request "also the quoted post"` | change to that op; the rest of the call is the example |
| an op fails and triage says it is the op's fault | repair, filed by the runner with the failure bundle |

A request records the context it was filed in, and its run works as that account. Each way of filing prints the request id and exits 5. `--wait` on any of them blocks until the request finishes, then runs the original call on the new op.

### Following one

- `x request:status R-0012 [--wait]` — state, the stage it is in, the awf run id, and the result, the reason it stopped, or the question it is waiting on. While it waits, it shows each stage of the run with its time, and the running one's turn, agent and last step, from awf's view of the run (`awf runs <id> --json` and its `turns.jsonl`)
- `x requests [--state building]` — the ledger, newest first
- `x request:answer R-0012 "…"` — answer a blocked request's question; its run continues from the stage that asked
- `x request:cancel R-0012 ["why"]` — end a request that isn't finished: its run, if one is going, is stopped, and its worktree removed. A retry takes it up again from the start
- `x request:retry R-0012` — put a deferred or failed request back in the queue

Detail beyond that is awf's: `awf runs R-0012` and `awf logs R-0012`.

### The ledger and the worker

Every request is kept, whatever happens to it, in `.state/requests/`: `ledger.jsonl` has one line per event, and `R-0012.json` the request's current state. The ledger is the record of what the tool was asked for, including what it did not do; `git log` is the record of what it built.

```
received ─▶ building ─▶ done
   │           ├──────▶ failed  ─▶ (retry)
   │           ├──────▶ blocked ─▶ (answer) ─▶ building
   │           ├──────▶ deferred ─▶ (retry)    needs something the tool cannot get yet
   │           ├──────▶ declined               out of scope, unsafe, or too vague to act on
   │           └──────▶ duplicate              an op already does it, or an open request asks for it
   └───────────────────▶ cancelled ─▶ (retry)    request:cancel, from any state that isn't final
```

The worker is a loop: it takes the oldest received request and starts an awf run for it, at most two at a time. Filing a request starts the worker if none is running. Deferred, declined and duplicate are decided by the run's first stage, intake, so they show up as outcomes of a run that ended early.

Two requests for the same thing don't both get built:

- **One intake at a time.** The worker starts a run that begins at intake only while no other is in intake, so each intake sees what the one before it decided. Repairs have no intake and run beside it.
- **Intake sees the open requests.** Each one's id, state, op and text are in the prompt. When one already asks for the same thing, intake answers *same*, and the request ends as its duplicate; its status points to the request that builds it.
- **The op lock.** A run takes a lock on its op once intake has named it, and a second request for that op waits. That catches two names intake would have to guess are the same.
- **After a lock wait, intake again.** A request that waited on an op's lock before building anything drops its worktree and starts again at intake, against main as the other request left it. There it usually ends as a duplicate, or becomes a change to what was built. One that waited with work in its worktree continues where it stopped.

A repair is filed once per op and step: while it is open, a call that fails the same way joins it instead of filing another.

## Operations

An operation (op) is one read as a folder of plain files that agents write and people can read. `x posts:search` runs `x/ops/posts-search/op.ts`.

| File | Holds | Written by |
| --- | --- | --- |
| `op.ts` | the Playwright code, built from named steps, and the direct way | build, repair |
| `spec.md` | what the op reads, its inputs and outputs, what counts as done | build |
| `notes.md` | what the pages taught: URLs, testids, quirks, waits that mattered, the calls behind them | build, repair (append only) |
| `examples.json` | inputs that worked, each tagged with the context it worked in | build, repair |
| `history.jsonl` | one line per run: context, ok or failed, at which step, how long | the runner |

An op exports one `defineOp` with a typed input, a typed output and a `run` function (`x/authoring.md` has the shape).

- **Steps are named** so a failure points at one (`failed at "read posts"`), and each step leaves a screenshot and an accessibility snapshot when it fails.
- **Output is read from X**, never echoed from input.
- **`wd` is the helper library** (`x/helpers/`), for moves every X page shares: open a page, run a search, open a profile, scroll a timeline collecting posts, read X's refusals. X marks controls with `data-testid`, which the helpers target first.
- **Every read is bounded**: a `limit` with a default, or a stopping point, since a timeline never ends.
- **Ops are the same for every account.** What differs (a list id, the account's own handle) comes in as input or from the account's knowledge file.

`x ops` lists what exists, with each op's last result and whether a request is open on it.

## Accounts and contexts

A context is an X account, named as in `kubectl config use-context`: a nickname, a URL and a saved sign-in.

```
$ x context:add me --url https://x.com/<your handle>
$ x context:login me        # headed browser; the person signs in, 2FA included
$ x contexts
* me   https://x.com/<handle>   signed in, 2h ago
```

- **The URL names the account.** `https://x.com/<handle>` makes the sign-in check refuse a session signed in as anyone else (`elsewhere`); runs start from that profile. Plain `https://x.com` accepts whichever account signs in and starts from `/home`.
- **Only a person signs in**, in the window. There is no username and password sign-in for X: automated logins are what X challenges hardest. The saved sign-in is `.state/contexts/<name>/auth.json`; agents never see or type credentials.
- **A request keeps the context it was filed in**, so switching contexts never moves a running build to another account.
- **Account knowledge** lives in `x/knowledge/tenants/<name>.md` (core's word for a context's file is "tenant"), and examples are tagged by context.
- **Signed out mid-run**, a run stops `blocked` with "sign in again: x context:login me" as its question, and continues once that is done.

## Browser layer

Playwright does all the browser work, behind the CLI.

- **Each call and each run gets its own browser.** An op call launches headless Chromium with its context's saved sign-in, runs, and closes. Each awf run, and the checker inside it, gets its own browser the same way, so two runs never share a page.
- **Headless by default, `--headed` to watch.** A person can watch any op or run, and step in on a stuck screen.
- **Exploring uses the same CLI.** Agents drive the page through `x page` commands, attached to a named session that stays open between calls. The session comes from `--session` or `XCLI_SESSION`, which the workflow sets for each agent (`R-0012`, and `R-0012-check` for the checker).

| Command | Prints |
| --- | --- |
| `x page` | URL, title and the accessibility tree, each control with a ref such as `e14` |
| `x page:click e14` | the tree after the click, with what changed marked |
| `x page:posts [n]` | the posts on the page, as the helpers read them |
| `x page:search "<query>" [latest]` | X search for a query, on a tab |
| `x page:shot` | the path of a screenshot |
| `x page:requests [all \| n [body]]` | the session's recent calls (the last 30; `all` for every kept one) under the command that made them, the newest JSON and event-stream ones numbered; `n` prints one with its headers and bodies, `n body` only its response |
| `x page:fetch <url> [Name: value ...] [body]` | one call on the session's sign-in, as an op's direct way would make it; prints status, content type and body |

- **Exploring leaves a trace.** Every `page` command is logged with the locator Playwright used, to `trace.jsonl` in the run. Writing `op.ts` starts from what worked, not from the agent's memory of it.
- **The page's own calls, not direct ones.** core lets an op have a `direct` way, plain HTTP on the saved cookies with no browser. X ops don't use it: X signs each call, rotates its query ids and sits behind Cloudflare's fingerprinting, so a separate client is what it flags (`x/knowledge/bot-detection.md`). Instead an op reads the GraphQL responses the page fetches (`wd.graphql`), which carry more than the screen shows. The builder finds them with `page:requests`, as the `direct-calls` skill says.
- **Installed Chrome, one request at a time.** `x/main.ts` sets `XCLI_BROWSER_CHANNEL=chrome` (core falls back to Playwright's Chromium when Chrome isn't installed) and `XCLI_MAX_RUNNING=1`, so one request's browsers use the account at a time.
- **Signed in for as long as runs need it.** While a request runs, the worker opens the app every five minutes and saves the fresh cookies, and open sessions nudge their page (template behaviour; whether X needs it is an open question).
- **A sign-in check runs before every op:** is the context's session still signed in to its URL. If not, it exits 3 with how to sign in again, and no request is filed, because no agent can fix a login.

## Build workflow: new ops and changes

`core/workflows/build.ts` handles both a new op and a change to one. The worker starts it as `awf run core/workflows/build.ts --id R-0012 -- R-0012`, so the awf run id is the request id.

Three agents work in it, and all run on their own: the **planner**, on a strong model, decides what to build, says what the person wants, and once the app has been surveyed writes the spec everything after is judged against; the **builder**, on a cheaper one, keeps its session from explore on, where the bulk of the turns are; the **checker** is a fresh agent on another model, in its own browser session, so it does not share the builder's assumptions. Panes open in awf's own Herdr session, so the caller does not need to be in Herdr; it only has to be installed.

1. **intake** — the planner reads the request against the existing ops, the knowledge and the other open requests, and decides: build it, or end the run as deferred, declined or duplicate: of an op that does it, or of an open request that asks for the same (*same*). A duplicate costs one short turn and never opens a browser.
   With build, it writes the **intent**: what the person wants and why, what they expect back, what is unclear. Nothing about screens: nobody has opened the app yet.
2. **explore** — the builder surveys the ways on X a person could serve the intent (search and its tabs and operators, profiles, a post's page, bookmarks, lists), writes what each gives in `notes.md`, picks one, and does the task once that way through `x page`, reading only, leaving a trace. To find records by a value it uses the app's own search. If no way serves the intent, the request ends deferred with what was tried; if the ways differ in what the person gets back, it asks. For a change, only the part that changes.
3. **spec** — the planner writes or updates `spec.md` from the intent and the builder's notes: what the person wants, the way the op uses and the others with why not, inputs, outputs, what done looks like on X. It may choose another way the builder found; the op is written to the spec.
4. **write** — the builder writes `op.ts` to the spec, from the trace and notes, with `authoring.md` and the reference op open, using the helpers and adding one when a move does not hold for every X page yet; a read gets its direct way too. `examples.json` gets an input for each case the spec tells apart. Then it tries the op as a caller would, and fixes it until all of this holds: each example's output is what the spec says, checked on X; a direct way gives the same output as `--browser`; a bad input exits 2 saying what is valid; `ci:fast` passes. Verify after it only confirms, with no agent.
5. **verify** — `x` itself runs the op on every example for this context; an op with a direct way runs each both ways, and the two outputs must match. No agent is in this step: either the code works or it does not.
6. **review** — the checker runs the op on an input of its own, not an example, and finds what it read on X itself (open the posts, the profile). It reads the builder's last answer, with what it says it ran, as claims to check. It reads the change against the intent and the spec, `authoring.md` and the reference op: values copied from exploration that should be inputs, logic that belongs in a helper, steps without names.
7. **revise** — a failed verify or a blocking review finding goes back to the builder, which fixes it and tries the op as a caller would again, as in write, for as long as each round gets further than the one before (see [When agents get stuck](#when-agents-get-stuck)). The checker marks each finding blocking or minor; with only minor ones, the builder fixes them in one turn and nobody reviews again. Rounds run the repository's fast checks (`ci:fast`: lint, types, unit and workflow tests, seconds); the full suite (`ci:check`, with the browser e2e tests) runs once, before approval. If it is still not right, see [When agents get stuck](#when-agents-get-stuck).
8. **merge** — the run works in its own git worktree on `req/R-0012`. It rebases on main, re-runs verify for every op whose helpers changed, and fast-forwards main: one commit, `R-0012 build post:thread`.

### Models and the sandbox: `workflows.json`

`workflows.json` at the checkout's root names each agent's harness and model (`planner`, `builder`, `checker`, `troubleshooter`, each as awf takes a runtime, an alias included) and whether agents run in a sandbox. An agent it leaves out keeps its default; a run reads the file once, when it starts.

With `"sandbox": true` the team shares one srt sandbox per run:

- **Writes** only its worktree, a CLI home of the request's own (`.state/sandboxes/R-0012`: sessions, traces, dry runs, failures) and a short socket directory (`/tmp/wd-R-0012`).
- **Reads** its context's saved sign-in where it is (`XCLI_CONTEXTS_DIR`), and awf's source for the type-check. Not the checkout, `.state`, other worktrees or `~`.
- **Reaches** no network but its model's, and the harnesses' own web search is off: it would reach past the allowlist. The browser stays on the host, since Chromium doesn't start under srt: a host browser server, one per run, ending with it, listens on a socket in that directory, and the CLI connects to it (`XCLI_BROWSER`). Its session daemons bind their sockets there too.
- **Checks** with `ci:sandbox`, which is `ci:fast` without the workflow tests: `awf test` can't run under srt, and neither can the e2e tests, which need a port for their mock app. The workflow still runs the full checks on the host and hands their failures over as output.
- **More**, when `"sandbox"` is an object instead of `true`: `{"network": ["docs.playwright.dev"], "read": ["../shared"], "write": [...]}` adds domains and paths (from the checkout's root) to the above. Agents read the account's sign-in and what it can see, so a domain added is somewhere they could send both.
- The worktree gets `node_modules` of its own, from bun's cache: bun resolving through a link to the checkout's would need the checkout readable.
- Claude in a sandbox signs in with `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`), from the environment the worker starts from or the checkout's `.env` (gitignored); codex copies its login in.

What isn't sandboxed yet: verify and the checks run the agents' code on the host. That is the next boundary, for models trusted less.

Nobody edits the main checkout by hand; people and agents change the tool in worktrees, so a fast-forward never meets a dirty tree, and the next call runs the merged code.

Each step is an awf stage, so a stopped run continues from the stage that stopped (`request:retry` or `request:answer`), and the run's record shows what each agent did and what it cost.

## Repair workflow

Repairs start themselves. When an op fails and triage blames the op, the runner saves a failure bundle and files a repair request, and the worker picks it up like any other. The caller gets exit 5 and the request id; with `--wait`, the original call runs again once the repair is merged.

The failure bundle sits in `.state/failures/<op>/<time>/`:

- the error, the failed step's name, the inputs and the context
- a screenshot and an accessibility snapshot at the moment it failed
- the page URL and the session's recent network calls
- the op's last ten `history.jsonl` lines, which show whether it ever worked

`core/workflows/repair.ts` skips intake, since the request came from the tool itself, and puts a diagnosis in front of the build workflow's loop. The same two agents do the work:

1. **diagnose** — the builder agent opens its own browser session, reproduces the failure with `x page` on inputs shaped like the failed one, and writes what changed in `notes.md`. A failed direct way is reproduced by running the op without `--browser` and comparing the calls the browser way makes now with those in the notes. A failure it cannot reproduce ends the request `failed` as flaky, with the bundle.
2. **patch** — the builder makes the smallest change to `op.ts` or a helper that fixes it, adds an example through the failed step, and tries the op as a caller would, as in write.
3. **verify, review, revise, merge** — as in the build workflow, with every example for the context re-run, so a fix for one case cannot break another.

An op whose repair ended `failed` is marked `broken` in `x ops`, and calls to it exit 5 pointing at that request until it is retried.

## When agents get stuck

Agents solve problems by default; a person is asked only when they cannot.

Rounds go on while they make progress, not for a fixed count. A round makes progress when its check gets further than the last one's (verify, then the fast checks, the review, the full checks) or stops at the same place with fewer problems (failed examples, blocking findings). After the full checks fail, reaching the review again counts, since it is a fresh look at changed code. The count is per attempt: a run continued after a person's answer starts its rounds again.

1. **The builder and checker** revise for as long as each round makes progress.
2. **A troubleshooter** takes over at the first round that doesn't: one generic agent, the same for every request, on the strongest model, opened fresh with the run's whole record (spec, trace, notes, failures, review findings). It may change anything the builder could, including the spec and the helpers, and goes on while its rounds make progress.
3. **A person** comes last, at the troubleshooter's first round without progress, or after eight rounds in all. The run stops `blocked` with one specific question ("this account can't see @someone's posts: which public account should the examples read?"), and `x request:answer` continues it from that stage.

A signed-out session is no agent's to fix: the run signs in again from `.env.<context>` when the checkout has it, and otherwise skips straight to step 3.

## Prompts

Everything the workflows tell an agent is in `core/workflows/prompts.ts`: the instructions each agent is opened with, each stage's prompt, and the problems a round hands to the next. The workflows decide when a prompt is sent and to whom; prompts.ts decides what it says. [`docs/prompts.md`](docs/prompts.md) shows every prompt filled in for a sample request, in the order a run sends them; `bun run docs:prompts` writes it, and a test fails when it is out of date.

Every stage prompt starts with the request's whole brief and ends with what a person has answered so far, since an agent may start fresh at any stage. Text goes where it holds:

| What | Where |
| --- | --- |
| How the workflow runs: stages, rounds, what to answer | `core/workflows/prompts.ts`, which never names the domain |
| How an op is written, and the reference op | `authoring.md` in the domain folder |
| What the app, and each account, are like | `knowledge/` |
| One op's screens and quirks | `ops/<op>/notes.md` |

The agents are told to read the last three; only the first is in a prompt.

## Knowledge

The tool should get faster at building with every op, because what one op learns about X is there for the next.

| Level | Where | Example |
| --- | --- | --- |
| One op | `ops/<op>/notes.md` | "Latest search loads 20 posts per scroll; the cursor is in the last entry" |
| All of X | `knowledge/x.md` | "a post's permalink is the link around its `time`" |
| Detection and limits | `knowledge/bot-detection.md` | what X watches for, rate-limit headers, what keeps a low profile |
| One account | `knowledge/tenants/<context>.md` | its lists, its own handle |
| Code | `helpers/` | `wd.posts({ limit })`, written once and used by every op |

Promotion moves knowledge up a level, as in the template: a note not specific to its op goes into `x.md` too; a move written out in two ops becomes a helper; a person's answer is written where it belongs.

## Guardrails

Agents drive a real, personal X account, so the limits are set in code and in the domain's rules, not only in prompts.

- **Read only.** No op writes, and `authoring.md` (which every agent reads, and whose test-data rules the prompts defer to) forbids anything that changes the account. Intake declines requests to write.
- **The context's account only.** The sign-in check refuses to run when the session is signed in as another account than the context names.
- **One account, one page at a time.** X limits each account, so ops don't fetch in parallel, scroll at a person's pace, and turn a rate limit into exit 4, never a retry loop or a repair.
- **Done means read from X.** An op's output comes from what X returned, and the checker confirms it on its own.
- **Every self-edit is a commit** on its request's branch, merged only after verify and review, so `git log` is the tool's growth history and `git revert` undoes a bad change.
- **Bounded spend.** As in the template: a time limit per run, eight revise rounds at most, two runs at a time.

## Staying under X's limits

X detects automation and limits or locks accounts that look like it. `x/knowledge/bot-detection.md` has the research, with sources; the design follows its recommendations, which are summarised at its top.

## Open questions

- [ ] One request at a time still opens two browsers on the account (the builder's and the checker's), and the worker's keep-signed-in touch a third. Watch whether X minds.
- [ ] The e2e tests and their mock app were Workday's and were not copied. A mock X (a sign-in page, a search page, a profile with posts) would let `ci:check` cover the runner, the browser and the helpers again.
- [ ] Does the worker's keep-signed-in nudge (opening the app every five minutes while requests run) look like automation to X? Workday needed it; X sessions last weeks, so it may be better off.

