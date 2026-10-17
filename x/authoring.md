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
import { defineOp, Type } from "../../op";

export default defineOp({
  name: "posts:search",
  description: "Posts matching a search, newest first",
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

## X's rules for ops

- **Bound every read.** A timeline never ends, so every op that scrolls takes a `limit` (with a
  default) or a stopping point (`--since`, a post id), and the help says which.
- **The helpers** (`wd`) are `open`, `search`, `profile`, `posts`, `graphql` and `errors`.
- **Target `data-testid`**, then role and name, then text. X's class names change with every release.
- **Errors**: `InputError` for a bad handle or a limit out of range; `PreconditionError` for an
  account or post that isn't there, or a protected account; `RefusedError` for a rate limit or a
  locked account. `wd.open()` already turns X's rate-limit and lock messages into `RefusedError`.
- **Find with X's own search** and its operators (`from:`, `to:`, `since:`, `until:`, `filter:`,
  `min_faves:`).
- **No `direct` way: read what the page's own calls returned.** X tells its own app's calls from
  anyone else's (a per-call signature, query ids that change with every release, Chrome's TLS
  fingerprint), so an op never makes calls of its own and never writes a `direct` function: a
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
