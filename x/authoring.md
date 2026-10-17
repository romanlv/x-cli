# Writing an X op

Every build and repair reads this first. It says how an op is written here; the reference op shows it.

## The reference op

There is none yet. The first op built through the build workflow becomes the reference once a
person has reviewed it line by line, and this section then names it. Until then, follow this file
and `knowledge/x.md`; the first build should be a plain read (a search, or a profile's posts) so it
sets the shape every later op copies.

## What x does

`x` gets information out of X for the person whose account it is signed in as: search results, an
account's posts, a thread, bookmarks, lists, notifications. **It only reads.** No op posts, replies,
likes, reposts, follows, bookmarks, sends a message or changes a setting, and nothing an agent does
while exploring does either. A request for an op that writes is declined at intake.

## An op's folder

`ops/<noun>-<verb>/`, for the op `<noun>:<verb>` (`posts:search`, `post:thread`, `account:posts`):

| File            | Holds                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------- |
| `op.ts`         | the Playwright code, as named steps, and the direct way when there is one                    |
| `spec.md`       | what the op reads, its inputs and outputs, what done looks like on X                         |
| `notes.md`      | what the pages taught: URLs, data-testids, quirks, waits that mattered, the calls behind them. Append only |
| `examples.json` | inputs that worked, each tagged with its context: `[{ "context": "me", "input": {…} }]`      |
| `history.jsonl` | written by the runner, one line per call; not committed                                      |

## op.ts

```ts
import { defineOp, Type } from "../../op";

export default defineOp({
  name: "posts:search",
  description: "Posts matching a search, newest first", // one line, for `x help`
  input: Type.Object({
    query: Type.String({ description: "what to search for; X's operators work (from:, since:, filter:links)" }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "at most this many posts (20)" })),
  }),
  output: Type.Array(Type.Object({ url: Type.String(), handle: Type.String(), time: Type.String(), text: Type.String() })),
  async run({ wd, step }, input) {
    await step("open search", () => wd.search(input.query, "latest"));
    const posts = await step("read posts", () => wd.posts({ limit: input.limit ?? 20 }));
    return posts.map(({ url, handle, time, text }) => ({ url, handle, time: time ?? "", text }));
  },
});
```

This is a sketch, not a built op: the first real one replaces it here.

- **Name every step.** A failure says `failed at "read posts"`, and its bundle holds a screenshot and
  the page's controls at that moment.
- **Read the output from X**, from what the page or its calls returned. Never return the input.
- **Inputs are flags.** Each property of `input` is a `--flag` (camelCase becomes kebab-case), and its
  `description` is the help text. Values that differ between accounts (a list's id, the account's own
  handle) are inputs or come from `knowledge/tenants/<context>.md`, never constants in `op.ts`.
- **Bound every read.** A timeline never ends, so every op that scrolls takes a `limit` (with a
  default) or a stopping point (`--since`, a post id), and the help says which.
- **Use the helpers** in `helpers/index.ts` (`wd`): `open`, `search`, `profile`, `posts`, `graphql`, `errors`.
  When a move holds for every X page and isn't there, add it there, not in the op. A move written out
  in two ops is a helper.
- **Prefer `data-testid`**, then role and name, then text. X's class names are generated and change
  with every release: never target them. The exploring trace (`page:trace`) has the locator each
  command used.
- **Errors that aren't the op's fault are thrown as such**, so triage files no repair:
  `InputError` (exit 2: a bad handle, a limit out of range), `PreconditionError` (exit 3: an account or
  post that isn't there, a protected account), `RefusedError` (exit 4: X said no: a rate limit, a
  locked account). `wd.open()` already turns X's rate-limit and lock messages into `RefusedError`.
- **Find with X's own search**: an op that finds posts by a value uses X search and its operators
  (`from:`, `to:`, `since:`, `until:`, `filter:`, `min_faves:`), and lets X match. Reading a whole
  timeline to filter in the op is a last resort, and notes.md says what was tried.
- **Read what the page's own calls returned, with no `direct` way.** X tells its own app's calls
  from anyone else's (a per-call signature, query ids that change with every release, Chrome's
  TLS fingerprint), so an op never makes calls of its own, and never writes a `direct` function: a
  separate HTTP client is the riskiest thing this tool could do to the account. Instead `run` reads
  the GraphQL responses the page fetches: `wd.graphql("SearchTimeline", () => wd.search(q))` returns
  the JSON the screen is drawn from, which carries more than the DOM (exact counts, ids, full text).
  Scrolling fetches the next page of it. Find the operation with `page:requests` while exploring, as
  the `direct-calls` skill says, and write its shape in notes.md. Where the DOM has all the op needs,
  reading the DOM (`wd.posts`) is fine.

## Pace and limits

X limits each account, not each op, and a locked account stops every op. So:

- One page at a time per account: no parallel calls, no parallel pages.
- Scroll and fetch at a person's pace (the helpers' `posts` already does); never tighten it.
- A rate limit is `RefusedError`, with when it resets when X says so. Never retry in a loop.
  `wd.graphql` does this for X's error codes 88 (rate limited) and 326 (locked).
- A challenge, a captcha or the login page mid-run is the person's to clear, by hand: stop, never
  try to get past it.

## Test data

`x` only reads, so there is no test data to create: examples and checks read public posts and
accounts that are stable (large, long-lived accounts; old posts that won't be deleted), or the
signed-in account's own pages. Never post, like, follow or change anything to make something to read.
