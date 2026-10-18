# account:posts

An account's posts, read from its profile, newest first: what a person sees on `x.com/<handle>`
under **Posts**, with the account's reposts from its **Reposts** tab, and with `--with-replies` its
**Replies** tab too.

The caller is an agent that reads the person's X to find posts and accounts they may care about, so
every post comes with its id and its author's account id, full text, media, links, quotes and exact
counts, all in `--json`. The text view is the one every post-reading op prints.

A caller keeps up with an account by passing the newest post id an earlier read returned as
`--until`, and gets only what is newer. The account's pinned post is in the result, marked, and
never stops a read.

## The way in X

**The profile's tabs**, `/<handle>` (Posts), `/<handle>/reposts` and `/<handle>/with_replies` (Replies): the page a person
reaches by opening the account and picking a tab. Opened with `app.profileTimeline(handle, tab)`
(the profile, which refuses a missing, suspended or protected account) and read with
`app.timeline(operation, …, { newestFirst: true })`: the page calls `UserOriginalsTimeline` for
Posts, `UserRepostsTimeline` for Reposts and `UserRepliesTimeline` for Replies on load, and again each time it is scrolled near its
bottom. No direct way (x/authoring.md): the op reads what the page's own calls return.

- **Posts** holds the account's own posts and quotes, newest first by id, and the pinned post above
  them. It holds **no reposts and no replies**.
- **Reposts** (`/<handle>/reposts`, `UserRepostsTimeline`) holds the account's reposts, newest first
  by the repost's own id. Always read, so every read has the posts and the reposts.
- **Replies** holds the account's replies, each laid out under the post it answers (another
  account's, or the account's own for a self-thread), and nothing else: the account's standalone
  posts are not on it. It is not the old "Posts & replies" tab.
- So the op reads Posts and Reposts, and with `--with-replies` Replies as well, one after the other,
  and merges them by id.

Other ways, and why not:

- **Media tab**: a subset of Posts.
- **Search `from:<handle>`** (`posts:search --query "from:NASA"`): one call for posts and replies
  together, but no pinned post, and the set is search's matching (what its index holds), not the
  profile. Kept for a caller who wants operators (`since:`, `filter:links`).
- **The DOM** (`app.posts`): no account ids, and counts rounded above 10,000.

## Inputs

| Flag | Type | Default | What |
| --- | --- | --- | --- |
| `--handle` | string, required | | the account, with or without the `@`; letters, digits and `_`, at most 15, else `InputError` |
| `--limit` | integer, 1 to 200 | 20 | at most this many posts, the pinned one counted |
| `--until` | post id (`PostId`) | none | the newest post an earlier read returned. The read stops before it, or at the first post with a lower id, so it stops even if that post was deleted. The pinned post never stops it and is still returned |
| `--with-replies` | boolean | false | add the account's replies (the Replies tab) to its posts and reposts |

Nothing differs between contexts: a handle reads the same public posts from any signed-in account.
Only a protected account's posts depend on it, visible to an account that follows it.

## Output

`Page(Entry)` from `model.ts`, mapped from the timeline responses by `readTimeline` (confirmed on
these three operations and the pin, 2026-10-18):

- `items`: the pinned post first, if the account has one and it was read, then the rest strictly
  newest first by id (a repost by its own id), each once. Each is a `post` or a `repost` (its own id, `by` the
  account, `post` the original with its author's account id and exact counts). A `post`: its id, author (account id, handle, name), time,
  full text, exact counts (replies, reposts and quotes apart, likes, bookmarks, views), entities
  (mentions, links with their expanded urls), media, card, `quoted`, and for a reply `replyTo` (the
  parent's post id and account). The id order puts a self-thread's 2/ above its 1/, where X draws 1/
  above 2/. A limit keeps the newest posts, also through a self-thread.
- `pinned`: the pinned post's id, when it is in `items`.
- `more`: true when posts were left past `limit` or after 10 scrolls; false when X ended the
  timeline (each tab read) or the read reached `until`; absent when X didn't
  say.

An account with no posts is a page with no items and `more: false`, not an error.

Without `--json` it prints with `pageText`, as `posts:search` does: a block per post (who, when, the
cut text, the counts), the pinned one starting with a line `📌 pinned`, and when `more` is true a
closing `<n> posts · more: pass --until <id>`, the newest id among the unpinned posts.

## Done in X

Open `https://x.com/<handle>`: the op's items are the posts at the top of the Posts tab, the pinned
one first (its "Pinned" line), the same posts in id order, interleaved by id with the reposts at the
top of `/<handle>/reposts`. With `--with-replies`, open the Replies
tab too: the account's own replies there (not the posts above them) are in the items as well,
interleaved with the posts by id. Each post's counts match its buttons' labels (the `retweet`
button's count is the op's reposts plus quotes). With `--until` set to an id from the page, the
items are the posts above it. Nothing is posted, liked, reposted, followed or bookmarked.

## Errors

- `InputError` (exit 2): a handle that is not an X handle; a limit out of range.
- `PreconditionError` (exit 3): no such account ("This account doesn't exist"); a suspended account
  ("Account suspended"); a protected account the signed-in account can't see ("These posts are
  protected"). The last two go by the page's text and have not been seen on a real account yet.
- `RefusedError` (exit 4): X's rate limit (429 or code 88) or a locked account, or a read stopped at
  a tenth of the budget with nothing read. Never retried.
- A challenge or the login page mid-run stops the op for the person to clear by hand.
