# Writing an X op

Every build and repair reads `core/instructions/authoring.md` first, for how any op is written, and
then this file, for what is particular to X. Where the two differ, this file wins.

## The reference op

There is none yet. The first op built through the build workflow becomes the reference once a
person has reviewed it line by line, and this section then names it. Until then, follow the two
authoring files and `knowledge/x.md`; the first build should be a plain read (a search, or a
profile's posts) so it sets the shape every later op copies.

## What x does

`x` gets information out of X for the person whose account it is signed in as: search results, an
account's posts, a thread, bookmarks, lists, notifications. **It only reads.** No op posts, replies,
likes, reposts, follows, bookmarks, sends a message or changes a setting, and nothing an agent does
while exploring does either. A request for an op that writes is declined at intake.

Ops are named for what they read: `posts:search`, `post:thread`, `account:posts`, `bookmarks:list`.

## A sketch of an op

```ts
import { Entry, entryText, Page, PostId } from "../../model";
import { defineOp, Type } from "../../op";

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
    return step("read posts", () =>
      app.timeline("SearchTimeline", () => app.search(input.query, "latest"), { limit: input.limit ?? 20, until: input.until }),
    );
  },
  format: (page) => page.items.map(entryText).join("\n\n"),
});
```

This is a sketch, not a built op: the first real one replaces it here.

## X's rules for ops

- **Outputs are the model.** `model.ts` has the types every op returns (`knowledge/data-model.md` is
  the design): a timeline is `Page(Entry)` (posts, reposts and unavailable posts), a post's page a
  `Thread`, an account a `User`, followers `Page(Type.Union([User, UserUnavailable]))`. Inputs reuse
  its types too (`PostId`, `UserId`). An op adds no output shape of its own for what the model has;
  what it lacks is added to `model.ts` and data-model.md, from a source, not in one op.
- **Ids are the keys, handles are snapshots.** An output names posts and accounts by id; a handle is
  only what an account was called when read. An op that takes a handle resolves it and keys by id.
- **Bound every read.** A timeline never ends, so every op that scrolls takes a `limit` (with a
  default) and may take `until`, a post id that a later read stops before (the newest one an earlier
  read returned), and the help says which. Never a cursor: ops make no calls, so they can't resume
  one of X's.
- **Read GraphQL through the mappers.** `app.timeline(operation, open, { limit, until })` is a
  timeline's posts as the page and scrolling fetch them, `app.thread(id)` a post's TweetDetail,
  `app.user(handle)` its UserByScreenName. For any other call, `app.graphql` returns the raw JSON
  and `map/graphql.ts` maps it (`postsPage`, `usersPage`, `threadOf`, `userFromResult`,
  `listFromResult`); an op never picks fields out of X's JSON itself. `app.posts` reads the same
  timeline from the DOM, with handles but no account ids and rounded counts.
- **`format` is `entryText`** for posts, so a person reads who, when, the text and the counts.
- **The first op to use a mapper confirms it.** The mappers follow open-source clients, not this
  account's responses yet: the first op that uses one compares its output with what the page
  received (`page:requests <n> body`), fixes the mapper and its fixture where they differ, and
  records the shape as confirmed in `knowledge/x.md`.
- **The helpers** (`app`) are `open`, `search`, `profile`, `posts`, `timeline`, `thread`, `user`,
  `graphql` and `errors`.
- **Target `data-testid`**, then role and name, then text. X's class names change with every release.
- **Errors**: `InputError` for a bad handle or a limit out of range; `PreconditionError` for an
  account or post that isn't there, or a protected account; `RefusedError` for a rate limit or a
  locked account. `app.open()` already turns X's rate-limit and lock messages into `RefusedError`.
- **Find with X's own search** and its operators (`from:`, `to:`, `since:`, `until:`, `filter:`,
  `min_faves:`).
- **No `direct` way: read what the page's own calls returned.** X tells its own app's calls from
  anyone else's (a per-call signature, query ids that change with every release, Chrome's TLS
  fingerprint), so an op never makes calls of its own and never writes a `direct` function: a
  separate HTTP client is the riskiest thing this tool could do to the account. Instead `run` reads
  the GraphQL responses the page fetches, which carry more than the DOM (exact counts, ids, full
  text). Find the operation with `page:requests` while exploring, as the `direct-calls` skill says,
  and write its shape in notes.md.

## Pace and limits

X limits each account, not each op, and a locked account stops every op. So:

- One page at a time per account: no parallel calls, no parallel pages.
- Scroll and fetch at a person's pace (the helpers' `posts` already does); never tighten it.
- A rate limit is `RefusedError`, with when it resets when X says so. Never retry in a loop.
  `app.graphql` does this for X's error codes 88 (rate limited) and 326 (locked).
- A challenge, a captcha or the login page mid-run is the person's to clear, by hand: stop, never
  try to get past it.

## Test data

`x` only reads, so there is no test data to create: examples and checks read public posts and
accounts that are stable (large, long-lived accounts; old posts that won't be deleted), or the
signed-in account's own pages. Never post, like, follow or change anything to make something to read.
