# x: a CLI that writes its own commands

`x` reads X (Twitter) from the command line, on your own signed-in account. It started with no
commands at all. When you ask for one it doesn't have, a team of coding agents explores X in a real
browser, writes the command, tests it against the live site, reviews it on a second model, and
merges it. The next call runs it as plain code: no model, no tokens, as fast as X's pages load.

```sh
$ x request "posts matching a search, newest first"
request R-0001 filed

$ x request:status R-0001 --wait
R-0001 · building (check) · posts:search: posts matching a search, newest first
  ✓ intake   3m
  ✓ explore  8m
  ✓ spec     34s
  ✓ write    1m
  ▸ check    9m · review 2 · checker (gpt-6.1-sol)
  ...
R-0001: done
result: built posts:search (1 revision(s)): New op, and the first X op, so it sets the shape…
commit: 6dbd11c

$ x posts:search --query "from:NASA" --limit 1
NASA @NASA · 2026-10-16 19:42
The aircraft lineup just keeps getting bigger. ✈️ MAX POWER, a new aerospace
expo, is set for Nov. 7-8 @NASAKennedy — featuring flyovers and static displays…
  142 replies · 209 reposts · 1525 likes · 355.3K views
  https://x.com/i/status/2111180963661435219
```

## What it built in one afternoon

Every op below was asked for in a sentence and built by the agents, starting from an empty
`x/ops/`. Nobody wrote op code by hand.

| Asked for | Op built | Time | Cost | Revisions |
| --- | --- | ---: | ---: | ---: |
| posts matching a search, newest first | `posts:search` | 31m | $2.18 | 1 |
| fix the text output, it's a wall of text | `posts:search` (change) | 8m | $1.03 | 0 |
| who an account follows, who I follow | `account:following` | 38m | $5.31 | 4 |
| my home feed, For you and Following | `home:posts` | 21m | $2.42 | 0 |
| an account's posts, from its profile | `account:posts` | 46m | $3.44 | 2 |
| a post and its thread | `post:thread` | 33m | $2.68 | 1 |
| an account's followers | `account:followers` | 31m | $1.51 | 1 |
| accounts matching a search | `accounts:search` | 11m | $1.29 | 0 |
| the accounts X suggests I follow | `accounts:suggested` | 15m | $1.52 | 1 |

Eight ops in 3h54m of runs, for $21 at list prices. The ops themselves are about 300 lines in
all, because most of what a build learns goes into code and notes every later op shares. Over these
nine builds, the shared helpers grew from 503 to 853 lines and the agents' notes on X itself from
98 to 171. The last builds, which mostly reused what earlier ones had learned, took 11 and
15 minutes.

## How it improves itself

```
 x <op> ...      ─▶ op exists? ─yes─▶ run it (Playwright code) ─▶ result
                        │ no                │ fails, and it's the op's fault
                        ▼                   ▼
 x request "…"   ─▶  request ledger  ◀── repair request, filed by the runner
                        │
                        ▼
              one workflow run per request, in its own git worktree and sandbox
              intake ─▶ explore ─▶ spec ─▶ write ─▶ verify ─▶ review ⇄ revise ─▶ merge
                        │
                        ▼
              one commit on main: "R-0004 build home:posts"
```

- **Intake** (planner, a strong model) decides whether to build it at all: in scope, not a
  duplicate of an op or another open request. A request to post, like or follow is declined.
- **Explore** (builder, a cheaper model) surveys the ways X could serve the request through a real
  browser session, reading only, and writes what each gives. Every page command is traced, so the
  code is written from what worked rather than from memory.
- **Spec** (planner) writes what the op reads, its inputs, and what done looks like on X.
- **Write** (builder) writes the op from the spec and the trace, then runs it as a caller would
  until each example gives what the spec says.
- **Verify** runs every example with no agent involved: the code works or it doesn't.
- **Review** (checker, a different vendor's model, in its own browser) runs the op on an input of
  its own and checks the result on X itself, so it doesn't share the builder's assumptions.
- **Revise** loops for as long as each round gets further than the last. When one doesn't, a
  troubleshooter on the strongest model takes over, and only after that is a person asked one
  specific question (`x request:answer R-0012 "…"`).
- **Merge** rebases on main, re-verifies every op when shared code changed, and fast-forwards.

It repairs itself the same way. When an op fails and rules (not a model) decide it is the op's
fault rather than a sign-out or a rate limit, the runner saves a failure bundle (screenshot, page
snapshot, network calls, recent history) and files a repair. The caller gets exit 5 and a request
id, and `--wait` reruns the call once the fix is merged.

### What makes the next build faster

Knowledge moves up as it is confirmed, so each op leaves the tool better at building the next one:

| Level | Where | Example |
| --- | --- | --- |
| One op | `x/ops/<op>/notes.md` | the pages tried, the calls behind them, quirks |
| All of X | `x/knowledge/x.md` | which GraphQL operation a page loads, confirmed against live responses |
| Shapes | `x/model.ts`, `x/map/` | one `Post`/`User`/`Thread` model every op returns |
| Code | `x/helpers/` | `app.timeline(...)`, written once, used by every op |

The first op built becomes the reference that later builds copy, once a person has reviewed it.

## An op is small

All of `posts:search`, as the agents wrote it:

```ts
export default defineOp({
  name: "posts:search",
  description: "Posts matching a search, newest first",
  input: Type.Object({
    query: Type.String({ description: "what to search for; X's operators work (from:, since:, filter:links)" }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "at most this many posts (20)" })),
    until: Type.Optional({ ...PostId, description: "stop before this post, the newest an earlier read returned" }),
  }),
  output: Page(Entry),
  async run({ app, step }, input) {
    const query = input.query.trim();
    if (!query) throw new InputError("query is empty: give X's search something, such as `from:NASA`");
    return step("read posts", () =>
      app.timeline("SearchTimeline", () => app.search(query, "latest"), {
        limit: input.limit ?? 20,
        until: input.until,
        newestFirst: true,
      }),
    );
  },
  format: pageText,
});
```

Next to it, in `x/ops/posts-search/`: `spec.md` (what it should do), `notes.md` (what the pages
taught), `examples.json` (inputs that worked) and `history.jsonl` (every run). An op reads the
GraphQL responses X's own page fetches, so it gets exact counts, ids and full text without ever
making a call of its own.

## Guardrails

The agents drive a real, personal account, so the limits are in code, not only in prompts:

- **Read only.** No op posts, likes, reposts, follows or changes a setting, and neither does
  anything an agent does while exploring. Intake declines requests that would.
- **Nothing is built by accident.** Calling an op that doesn't exist fails and names the ops close
  to it; only `--request` files one.
- **Only a person signs in.** `x context:login` opens your installed Chrome as itself, with no
  automation flags and nothing attached, and reads the session afterwards. Agents never see
  credentials.
- **Sandboxed agents.** Each run's agents write only their own worktree, read only their account's
  saved session, and reach no network but their model's. The browser stays on the host.
- **Every change is a reviewed commit.** `git log` is the tool's growth history and `git revert`
  undoes a bad build. The request ledger keeps what was asked for, including what was declined.
- **A person's pace.** One page at a time per account, one build at a time, and a rate limit is
  exit 4, never a retry loop.

## Try it

You need [bun](https://bun.sh), Google Chrome, `awf` (the agent workflow runner the builds run on)
and the Claude Code and Codex CLIs for the agents.

```sh
bun install && bunx playwright install chromium
bin/x context:add me --url https://x.com/<your handle>
bin/x context:login me          # sign in by hand in the window, then press Enter
bin/x help                      # the ops it has
bin/x request "the replies under a post, oldest first"
bin/x request:status R-0001 --wait
```

Builds run Claude in a sandbox (`"sandbox": true` in `workflows.json`), where it can't use the
keychain login. Give it a token: run `claude setup-token` and put the token in the checkout's
`.env`, as `CLAUDE_CODE_OAUTH_TOKEN=…`, or export it.

For agents and scripts, every command takes `--json` and prints `{ ok, data, error, next }`, where
`next` lists the commands worth running next. Exit codes say what happened: 0 done, 2 bad input,
3 signed out or not found, 4 X refused (rate limit), 5 a request was filed or is open.

Automating X may break its terms of service. Use it on your own account, at a person's pace, and
at your own risk.

## For another site

`core/` knows nothing about X: the CLI, the request queue, the worker, the browser layer and the
workflows that build and repair ops are site-agnostic. A new site is a new domain folder (its
sign-in check, a few helpers, and an `authoring.md` that says what its ops may and may not do), and
then requests. [`docs/new-site.md`](docs/new-site.md) has the steps.

## More

- [`DESIGN.md`](DESIGN.md): how all of it works, and why.
- [`docs/prompts.md`](docs/prompts.md): every prompt the agents get, filled in for a sample request.
- [`x/knowledge/bot-detection.md`](x/knowledge/bot-detection.md): what X watches for, and how the
  tool keeps a low profile.
