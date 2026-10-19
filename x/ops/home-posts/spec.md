# home:posts

The posts X shows the signed-in account on its home page, the way a person scrolling `/home` sees
them: the **For you** tab by default, or **Following**, the posts of the accounts it follows.

The caller is an agent that reads the person's X to find posts and accounts they may care about,
going through their feed over the past week, so one run must reach `--limit 200`.
Every post comes with its id and its author's id, full text, exact counts, media, links, quotes
and who reposted it, all in `--json`. The text view is the shared one every post-reading op prints.

Both tabs are **ranked by X**, not ordered by time or by id, so there is no `until`: a caller who
wants more raises `--limit`. Ads are left out. The op only reads: it never likes, reposts, follows,
bookmarks, replies or changes a setting, and the composer above the posts is never touched.

## The way in X

**The home page's two tabs**, `/home`, opened with `app.home(tab)` and read with
`app.timeline(HOME[tab].operation, () => app.home(tab), { limit })`. It is the page a person
reaches with the side nav's Home link, and the tabs they pick above the posts.

- `for-you` (the default): `/home` opens on it. Read from `HomeTimeline` (a GET), which the page
  calls on load and once more each time it is scrolled near its bottom.
- `following`: the same page after a click on its "Following" tab (role `tab`, in
  `primaryColumn`), waiting until that tab is the selected one. Read from `HomeLatestTimeline` (a
  POST, with `enableRanking: true` and `seenTweetIds`), which the click and each later scroll
  call. The `HomeTimeline` call the page made on load is ignored.

Each call sends 35 to 38 entries, about 27 posts once the ads are dropped, whatever its `count: 20`.
No direct way (x/authoring.md): the op reads what the page's own calls return.

Other ways, and why not:

- **A second call to read on**: a fresh `/home` re-ranks (two loads' ids differ) and the feed has no
  cursor, so it repeats some posts and misses others. The one read scrolls on in its page instead.

- **Search with `filter:follows`** (`posts:search --query filter:follows`): newest first by id, so
  `until` would work, but it is not the home feed. 6 of the 8 posts seen were replies, and it has
  no reposts, no ranking and no suggestions. It stays the way for a caller who wants posts of
  followed accounts in time order.
- **"Manage timelines"** (the button beside the tabs): it only pins topics, lists and communities
  as extra tabs. It has no switch for newest first or for ranking.
- **A list's timeline or a profile's Posts tab**: one list or one account at a time, not the feed.
- **The DOM** (`app.posts`): it has handles but no account ids, rounded counts, and draws an ad like
  any other post. The GraphQL responses carry ids, exact counts and full text, and mark the ads.

## Inputs

| Flag | Type | Default | What |
| --- | --- | --- | --- |
| `--tab` | `for-you` or `following` | `for-you` | which home tab to read. Any other value is an `InputError` listing these two |
| `--limit` | integer, 1 to 200 | 20 | at most this many entries; 200 takes about 4 minutes, scrolling at a person's pace ("How far a read goes") |

No `--until`: neither tab is in id order. Following is ranked too (each entry's component is
`ranked_following`), and its ids in a page are not descending.

Nothing differs between contexts in the flags. What comes back is the account's own: whom it
follows and what X ranks for it.

Picking Following is a click on the tab, as a person's. X keeps it with that page, not with the
account: a new `/home` always opened on For you, even right after a Following read in another page,
so the op puts nothing back.

## Output

`Page(Entry)` from `model.ts`, mapped from the responses by `postsPage` (confirmed for both calls,
`data.home.home_timeline_urt.instructions[]`):

- `items`: entries in the order X ranks them, unique by id: posts, reposts and unavailable posts.
  Each post has its id, author (account id, handle, name), time, full text, exact counts (replies,
  reposts, quotes, likes, bookmarks, views; views is a live count), `conversationId`, `media`,
  `card`, `entities` (the expanded links), the quoted post, `replyTo`, and `viewer` (whether the
  signed-in account liked, reposted or bookmarked it). A repost has `by`, who reposted, and the
  post inside. A conversation X groups (a `home-conversation-…` module, seen on Following: a reply
  under its post) comes as separate entries, the earlier first, with `replyTo` on the reply.
- `more`: true when the read stopped at `limit`, or ran out of scrolls, with posts left. X's end of
  the feed was not reached in any read, so a read cut at its limit says `more`.

Ads are `promoted-tweet-…` entries with `promotedMetadata`, about 8 in each page in both tabs. The
mapper drops them and still counts them as sent, so a page of mostly ads has more behind it. None
comes back as a post. A "Who to follow" module (`who-to-follow-…`) didn't appear in the pages read.
The mapper drops it by its entry id if X sends one.

`--json` prints this `Page(Entry)` whole. Why X showed a post (followed or recommended) is in the
responses but not in the model (notes.md); the op doesn't return it.

### How far a read goes

A ranked feed has no cursor and a fresh `/home` re-ranks, so a later call can't continue a read:
the one read scrolls on in its page until it has `limit`. It gets `max(10, ceil(limit / 2))`
scrolls (100 for `--limit 200`), each at a person's pace (a scroll of 1800 px, then 2 to 6 s, about
4.2 s in all), never faster. X sends its next page only after about 10 scrolls, 28 to 52 entries a
page, so 3 to 4 posts a scroll once the ads are gone. Measured on `me`:

| Read | Calls | Scrolls | Entries | Time | Covers |
| --- | --- | --- | --- | --- | --- |
| `--limit 25`, For you | 1 | none | 25 | about 2 s | |
| `--tab following --limit 200` | 6 | 47 | 200, `more: true` | about 245 s | Oct 15 to 19 |
| For you, 60 scrolls (below the op's 100) | 7 | 60 | 196, `more: true` | about 249 s | Oct 17 to 19 |

So For you needs about 63 scrolls for 200, within the 100 it gets; a read that used all 100 would
take about 7 minutes. The read also ends sooner at X's end of the feed, at a tenth of the call's
budget, and at a rate limit or lock (`RefusedError`, never retried). The budget is 500 calls for
both operations, one used per page, so a 200-post read (6 to 8 calls) stays far from a tenth.

The growing scroll count is this op's, not `app.timeline`'s default (10): the other scrolling ops
stop by `until`, and a default that grew with the limit would lengthen all their reads.

### Printed (without `--json`)

`rankedPageText` from `model.ts`, which prints the blocks of `pageText` (`posts:search`'s spec
describes them: a header, the cut text, a quote, the counts, the link, `↻ @<reposter> reposted`
above a repost). The one difference is the closing line, for a ranked timeline with no `--until`:
when `more` is true it is `<n> posts · more: raise --limit for older posts` (home is ranked, so
`--until` is not named). An empty page prints `no posts`.

## Done in X

Open `https://x.com/home` (it opens on For you). For `--tab following`, click the Following tab
instead. Then:

- The op's items are the posts at the top of that tab, in the same order, the first `limit` of them.
  X ranks each load afresh, so a new load may differ in what it picks. Check one load against
  the op's read of it, or compare by id.
- The posts marked "Ad" on the page are not among the items.
- `--tab following --limit 200` returns 200 entries, unique by id, reaching back several days (Oct 15
  to 19 on `me`), in about 4 minutes; scrolling that tab by hand shows the same posts further down.
- Each post's counts match its buttons' `aria-label` to the unit, and `retweet`'s count is the
  op's reposts plus quotes.
- Each block's link opens that post.
- A new `/home` opened after a Following read opens on For you again.

Nothing is posted, liked, reposted, followed or bookmarked.

## Errors

- `InputError` (exit 2): a `--tab` other than `for-you` or `following`, a `--limit` out of range.
- `PreconditionError` (exit 3): the home page's selected tab is neither For you nor Following.
- `RefusedError` (exit 4): X's rate limit (a 429 or code 88) or a locked account, from
  `app.timeline`. A home page left blank because `Viewer` was answered 429 counts too: it
  happened after about 20 fresh page loads in under an hour. So does a read stopped at a tenth of
  the budget with nothing read. Never retried: space runs out.
- A challenge or the login page mid-run stops the op for the person to clear by hand.
