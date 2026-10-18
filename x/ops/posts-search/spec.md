# posts:search

Posts matching an X search, newest first: the search's Latest tab, not Top.

A person follows a query such as `from:NASA` or `from:NASA since:2026-01-01 filter:links` and
reads what is new since last time: they pass the newest post id an earlier read returned as
`until`, and get only the posts after it.

Without `--json` they read the result in a terminal, so it prints as a compact view of what X shows.
Each post is its own block with a rule between posts. A header line names who posted and when. The
text is trimmed, with links as X shows them rather than t.co, the counts take one line, and the link
comes last, so a glance tells one post from the next. The closing line says how to read on: a higher
`--limit` for older posts, `--until` next time for only newer ones. The print is shared with every op
that prints posts (home:posts, account:posts, post:thread), so they all read alike. `--json` returns
everything, untrimmed.

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
- **The page's own text** (the DOM), for the print: it already shows links as `nasa.gov/maxpower/`
  and drops the media's link, but it has no repost time, no account ids and only rounded counts.
  The print is made from the `SearchTimeline` responses instead, whose `entities.urls` give each
  link's t.co, expanded and display forms.

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

An empty search is a page with no items and `more: false`, not an error.

The JSON is unchanged by the print: `text` keeps X's t.co links and `entities.urls` says where each
leads. The print's expanded text is derived from those two (`textWithLinks` in `model.ts`), so no
field was added for it.

`--json` prints this `Page(Entry)` whole: full text, every count, every field the mapper gives.

### Printed (without `--json`)

The print is the shared text view in `model.ts` (`entryText`, or a page formatter beside it that
uses it), not code in this op, so every op that reads posts prints the same way. It is plain text,
with no colour or other terminal codes. The text is made in the worker and kept with the request,
then shown later or piped, so it can't know whether stdout is a terminal. For the same reason it
uses no relative time ("3h ago"), which would go stale when the request is read again.

Each entry is one block, and a line of `─` (about 60 wide) goes between blocks:

```
Ada Lovelace @ada · 2026-10-18 14:05
First line of the post, with its newlines folded into spaces and runs of
spaces squeezed, links as X shows them (nasa.gov/maxpower/), wrapped at about
80 columns and cut after 4 lines or 280 characters, whichever comes first…
  ┃ Quoted Name @quoted · 2026-10-17 09:12
  ┃ The quoted post's text, trimmed shorter: 2 lines or 140 characters…
  135 replies · 226 reposts · 1.5K likes · 45K views
  https://x.com/i/status/1849…
────────────────────────────────────────────────────────────
↻ @grace reposted · 2026-10-18 15:02
Ada Lovelace @ada · 2026-10-18 13:40
…
```

- **Header**: the author's display name, then `@handle`, then the time as `YYYY-MM-DD HH:MM` in UTC,
  taken from `createdAt`, or the time of the id when there is none. A missing name leaves just the
  `@handle`.
- **Text**: the post's newlines are folded into spaces. That also rejoins the URLs the text splits
  across lines, such as "https://\nnasa.gov/…". The text is wrapped at about 80 columns and cut
  after 4 lines or 280 characters, whichever comes first, at a word boundary, ending in `…`. A post
  with no text has no text line.
- **Links**: a link prints as X shows it (the entity's `display` link, such as `nasa.gov/maxpower/`;
  its expanded link, without `https://`, where X cut the display with `…`), not as the t.co link in
  the text. A trailing t.co that only points at the post's own media is dropped, and so is a trailing
  link to the quoted post (decided: the quote is shown under the post anyway). A link to the quoted
  post inside the text stays, expanded. Text read from the DOM has no t.co links and no entities, so
  it prints as it is.
- **Quote**: a quoted post goes under the text, each line starting `  ┃ `, with its own header and
  its text cut to 2 lines or 140 characters. It has no counts and no link of its own.
- **Counts**: one line, indented two spaces: replies, reposts (or "reposts and quotes" where only
  that sum is known), likes, and views when there are any. Each noun agrees with its number:
  `1 reply`, `1 repost`, `1 like`, `1 view`. Counts of 10,000 and over are rounded
  (`12K`, `1.5M`), because `--json` keeps them exact. Entries without counts have no counts line.
- **Link**: the post's URL, indented two spaces, last in the block.
- **Repost**: a line `↻ @<reposter> reposted · <time>` (the reposter's display name before the handle
  when known; the time is when it was reposted, from the repost's `createdAt`, else from its id, and
  left out when neither is known, as for a repost read from the DOM), then the reposted post's block,
  whose header has when the original was posted.
- **Unavailable post**: one line, `[<reason>] <message or "post unavailable"> <url when there is an id>`.
- **After the last block**: when `more` is true, a closing line after one more rule:
  `<n> posts · more: raise --limit for older posts; next time --until <newest id> gets only posts
  newer than this` (`1 post` for one). The id is the newest of the items by id (a pinned post never
  counts). `--until` reads only newer posts on a later poll, not the rest of this list, so older
  posts need a higher `--limit`. When `more` is false there is no closing line. An empty page prints
  `no posts`.

## Done in X

Open `https://x.com/search?q=<query>&src=typed_query&f=live` (or type the query on /explore, press
Enter, pick Latest). The op's items are the posts at the top of that page, in the same order, the
first `limit` of them; with `until`, they are the posts above that one. The counts match each
post's buttons (`retweet`'s count is the op's reposts plus quotes). Nothing is posted, liked,
reposted, followed or bookmarked.

The print matches the page post for post, in the same order. Each block's name, `@handle` and
start of text are those of the post in the same place on the page. Its link opens that post. A
post the page shows with "Show more" ends in `…` in the print, and its full text is in `--json`.
Its links read as the page shows them (`nasa.gov/maxpower/`), and a link the page shows only as a
photo, a video or the quoted post's card is not in the print's text either. A repost's
"<name> reposted" line has, in the print, the time it was reposted, which the page doesn't show; the
reposted post's own header keeps the time the page shows for it.

## Errors

- `InputError` (exit 2): a blank query, a limit out of range.
- `RefusedError` (exit 4): X's rate limit (429 or code 88) or a locked account, from
  `app.timeline`; also a read stopped at a tenth of the budget with nothing read. Never retried.
- A challenge or the login page mid-run stops the op for the person to clear by hand.
