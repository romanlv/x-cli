# posts:search

Posts matching an X search, newest first: the search's Latest tab, not Top.

A person follows a query such as `from:NASA` or `from:NASA since:2026-01-01 filter:links` and
reads what is new since last time: they pass the newest post id an earlier read returned as
`until`, and get only the posts after it.

## The way in X

**Search's Latest tab**, `/search?q=<query>&src=typed_query&f=live`, opened with
`app.search(query, "latest")` and read with `app.timeline("SearchTimeline", …, { newestFirst: true })`.
It is the page a person reaches by typing the query in the search box on /explore, pressing Enter
and picking the Latest tab. X does the matching, with every operator; the op reads no post to
match. The page makes one `SearchTimeline` call (`product: "Latest"`, `count: 20`) on load and one
more each time it is scrolled near its bottom; its posts are newest first by id.

Other ways, and why not:

- **Search's Top tab** (the tab Enter lands on): the same matching, but ranked, not by time, so
  "newest first" and `until` mean nothing there.
- **The search filters panel and Advanced search**: they only build operators into the query
  (`from:`, `since:`, `until:`, `filter:`); the panel's "People you follow" and "Near you" are
  `filter:follows` and `near:me`. Nothing a query can't say.
- **A profile's Posts tab** (`/<handle>`): one account's posts, newest first, but only that account
  and with no text, date or link filters.
- **People, Media and Lists tabs**: accounts, posts with media only, lists; not posts matching a query.

## Inputs

| Flag | Type | Default | What |
| --- | --- | --- | --- |
| `--query` | string, required | | what a person types in X's search. Operators pass through: `from:NASA`, `since:2026-01-01`, `until:2026-06-01`, `filter:links`, `min_faves:100`. Blank (after trimming) is an `InputError`. A malformed operator such as a bare `from:` is not refused: X searches it as text |
| `--limit` | integer, 1 to 200 | 20 | at most this many entries |
| `--until` | post id (`PostId`) | none | the newest post an earlier read returned. The read stops before it, or at the first post with a lower id, so it still stops when that post was deleted. A post, not a date: `until:<date>` in the query is X's own operator and filters by day |

Nothing differs between contexts: the same query reads the same public posts on any signed-in
account. What each account sees may differ (whom it blocks or mutes, protected accounts it follows).

## Output

`Page(Entry)` from `model.ts`, mapped from the `SearchTimeline` responses by `postsPage`:

- `items`: the entries newest first, unique by id: posts, reposts and unavailable posts, each with
  its id, author (account id and handle), time, full text and exact counts (replies, reposts,
  quotes, likes, bookmarks, views; views is a live count). `from:<handle>` includes the account's
  replies.
- `more`: true when the read stopped at `limit` or after 10 scrolls with posts left; false when X
  had no more or the read reached `until`.

An empty search is a page with no items and `more: false`, not an error. Printed with `entryText`:
who, when, the text and the counts, a blank line between posts.

## Done in X

Open `https://x.com/search?q=<query>&src=typed_query&f=live` (or type the query on /explore, press
Enter, pick Latest). The op's items are the posts at the top of that page, in the same order, the
first `limit` of them; with `until`, they are the posts above that one. The counts match each
post's buttons (`retweet`'s count is the op's reposts plus quotes). Nothing is posted, liked,
reposted, followed or bookmarked.

## Errors

- `InputError` (exit 2): a blank query, a limit out of range.
- `RefusedError` (exit 4): X's rate limit (429 or code 88) or a locked account, from
  `app.timeline`; also a read stopped at a tenth of the budget with nothing read. Never retried.
- A challenge or the login page mid-run stops the op for the person to clear by hand.
