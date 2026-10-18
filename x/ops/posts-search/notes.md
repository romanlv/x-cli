# posts:search: what the app taught

Built 2026-10-18 on the `me` context (signed in as @romitch), run through the page commands.

## Ways to do it in the app

- **Search box on /explore** (`SearchBox_Search_Input`, a combobox; fill, press Enter) opens
  `/search?q=…&src=typed_query` on the Top tab. The tabs Top, Latest, People, Media, Lists follow;
  the Latest tab is `&f=live`. Gives: X's own matching with every operator, newest first on
  Latest. Lacks: Top is ranked, not by time, so it is no use for `until`.
- **Search filters panel** on the results (radios "From anyone / People you follow", "Anywhere /
  Near you") and **Advanced search** link. They build the same operators into the query
  (`from:`, `since:`, `until:`, `filter:`); the panel adds the people-you-follow and near-you
  scopes, which a query can do too (`filter:follows`, `near:me`). Nothing the query can't say.
- **A profile's Posts tab** (`/<handle>`) gives one account's posts newest first, but only that
  account, without text, date or link filters. It lacks the query.
- **The URL itself** (`/search?q=<query>&src=typed_query&f=live`) is the same as the box; the op
  opens it with `app.search`, as `x.md` says. The person's way and the op's land on one page.
- **People / Media / Lists tabs**: accounts, posts with media only, lists; not the intent.

Picked: the search's Latest tab. X matches the query; the op reads no post to match.

## Screens and waits

- Start page is the profile `/romitch`. Search and explore (`AppTabBar_Explore_Link`) opens
  `/explore`; `SearchBox_Search_Input` there. Enter opens search on Top; the `Latest` tab
  (role tab, name "Latest") loads `&f=live`.
- The Latest page makes one `SearchTimeline` call on load, `count: 20`, `product: "Latest"`.
  The next page comes when the page is scrolled near its bottom (see below).

## The call behind it

`GET /i/api/graphql/<queryId>/SearchTimeline?variables=…&features=…` (queryId was
`irezafrnzav4Ulf1vDkEBg` today; it rotates). `variables`: `rawQuery` (the query as typed),
`count: 20`, `querySource: "typed_query"`, `product: "Latest"`, plus flags; scrolling adds `cursor`.
Response: `data.search_by_raw_query.search_timeline.timeline.instructions[]`, one
`TimelineAddEntries` with 20 entries `tweet-<id>` (`TimelineTimelineItem`, result `__typename`
`Tweet`) and two `TimelineTimelineCursor` entries (`cursor-top-…`, `cursor-bottom-0`). Newest first
by id, all in one page, no modules (no conversation grouping) on Latest. `postsPage` /
`readTimeline` read it as it came (mapper confirmed, nothing to fix).

Latest from `from:NASA` includes replies the account made (a post starting "@GampSairy …").

## Output compared with the page

DOM and GraphQL agree: replies 135, likes 1492, bookmarks 62, DOM `repostsAndQuotes` 226 = GraphQL
`reposts` 202 + `quotes` 24. Views differ by a few between reads (live count). GraphQL adds author
ids, `conversationId`, `entities` and `reply` links.

## Behaviours seen

- **Empty result** (`from:NASA xqzvkwjh9917`): a page with no posts, `more: false`. Not an error.
- **Malformed operator** (`from:`, nothing after it): X doesn't reject it, it searches it as text
  and returns posts. A malformed query never fails; only an empty one is refused by the op.
- **`until`** at a post id in the read stops before it; with an id that no post has (between two
  posts) it stops at the first post below it. Across scrolled pages it stopped at the right post
  (25 posts before the 26th of a 30-post read).
- **`until:` in the query** is X's date operator and works on its own; the op's `until` is a post id.
  The help says which is which.
- Rate limit: not provoked (never retried when it happens: `app.timeline` throws `RefusedError`).
  Latest search's budget headers are read as for every timeline.

## Scrolling (a fix in the helpers)

`app.timeline` stopped after 3 scrolls that brought no new call, but X asks for the next page only
when the page's bottom is near: a 20-post page is about 8000 px, one scroll 1800 px, so the first
three scrolls never did, and `--limit 45` returned 20 with `more: true`. The helpers now count a
scroll as idle only when it reached the bottom of the page, and move the pointer over the main
column before the wheel. With it `--limit 45` read 45 in 44 s, sorted, no duplicates.

## Direct way

None: x/authoring.md rules it out. Layers 1 and 2 done; the call is above. `page:fetch` not used.

## Change R-0002: compact text output (no new way in X)

Only how the result prints changes; the way in X stays search's Latest, read through `SearchTimeline`.
Checked 2026-10-18 on `me` (`page:search "from:NASA" latest`, `page:posts 4`): the page and the
data are as above, and nothing in the app serves a "compact view": X has none, it is the op's print.

- What the entries give for a text view: `author.name` and `author.handle`, `createdAt` (else the
  time of the id), `text` with its own newlines and bare URLs split onto their own lines
  ("https://\nnasa.gov/maxpower/" from the DOM), `counts` (replies, reposts or repostsAndQuotes,
  likes, views), `quoted`, and for a repost `by` and `post`. `entryText` printed only the handle
  and the ISO time, the whole text, and the counts line, with one blank line between posts.
- Replies by the account appear in `from:` searches, so a header line may need "replying" context
  that the model lacks only if `reply` is absent; none is needed to separate posts.
- The text view lives in `model.ts` (`entryText`, shared by every post-reading op); `--json` is the
  `Page(Entry)` untouched.

### Built: the print (R-0002)

`pageText` in `model.ts` (the op's `format`) builds on `entryText`: header, text folded and cut to
4 lines / 280 chars, `┃` quote cut to 2 lines / 140, a counts line (10K and over rounded), the link,
a `─` rule between blocks, `no posts` for an empty page, and a closing `n posts · more: pass --until
<first id>` when `more`. Plain text, no colour: the text is made in the worker and kept. Ran on `me`:
`from:NASA --limit 5` (5 blocks, closing line), `--until` example, the 30-post links query (30
blocks), the empty query result (`no posts`), a blank query (exit 2), `--json` still whole.

## Change R-0010: how posts read as text (no new way in X)

Only the shared text in `model.ts` changes (`entryText`, `pageText`, `rankedPageText`, `threadText`),
for posts:search, home:posts, account:posts and post:thread together. The way in X stays search's
Latest, read through `SearchTimeline`. Start page was the profile `/romitch`; checked 2026-10-18 on `me`.

Ways to get a text a person or agent can act on, and what each gives:

- **The search page itself** (Latest tab): what a person reads. Shows links as `nasa.gov/maxpower/`,
  cuts a long link with `…` (`x.com/i/broadcasts/1…`), drops the media's own link, "1 reply" singular
  in the buttons' aria-label ("1 Reply"), and a repost line "NASA reposted" with no time. It lacks
  the time of a repost and any hint how to read on.
- **`SearchTimeline` responses** (the op's source): `entities.urls` has `url` (t.co), `expanded_url`
  and `display_url` per link, with code-point offsets into `full_text`; the media's own t.co is in
  `entities.media`, not in `urls`, and sits last in the text. A quote's link is in `urls` with
  `expanded_url` `x.com/<h>/status/<quoted id>`, also last. This serves the intent; the DOM text has
  no t.co and no entities, so it is already right.
- **Search's Top tab**: ranked, not in id order, so it would take only `--limit` in the hint; the op
  reads Latest only, so `pageText` always names `--until`. Home takes only `--limit`.

What the screen taught (live, `from:NASA filter:links --limit 4`, `post:thread`, `account:posts`,
`home:posts`):

- `display_url` can end in `…` (`x.com/i/broadcasts/1…`): then the expanded link, without `https://`,
  is printed.
- The trailing t.co that only points at the post's media is the one no `urls` entity names; a trailing
  link to the quoted post is in `urls`, and is dropped too (the quote is shown under the post).
- A repost's `createdAt` (else the time of its own id) is when it was reposted; the block under it
  has when the original was posted. A DOM repost has neither, so the line has no time.
- "more" hint: `--until` returns only posts newer than the id on a later read, so it never reads the
  rest of this list: older posts need a higher `--limit`.
- The focal post of `post:thread` prints as a list post, with quotes and bookmarks added to the counts
  line, its text wrapped but not cut.
- No JSON field was added: the text with links expanded is derived from `text` and `entities` by
  `textWithLinks` in `model.ts`, so `--json` is as before.
- A verify run of every op's examples back to back (2026-10-18) got a 429 on `Viewer` for posts:search
  and post:thread, resetting at 18:21Z: exit 4 as it should be, not the op's fault. Rerun one at a
  time after the reset, all four examples gave what the spec says, and the search page (Latest) had
  the same posts in the same order, its links shown as the print shows them (`nasa.gov/maxpower/`).

## Change R-0013: lean JSON for agents (no new way in X)

The way in X stays search's Latest, read through `SearchTimeline`; only what the mapper keeps of each post
changes, in `model.ts` (`Media`) and `map/graphql.ts` (`mediaOf`), for every op that returns posts. Start page
was the profile `/romitch`; checked 2026-10-18 on `me`.

Ways to get posts an agent can read cheaply, and what each gives:

- **Search's Latest tab, `SearchTimeline`** (the op's way): newest first, every operator; each media item arrives
  with `media_key`, `original_info` and `video_info.variants` (an m3u8 and four mp4 bitrates). Serves the intent
  once the mapper keeps less.
- **Search's Top tab**: ranked, no `until`; same per-post payload, so no leaner.
- **The DOM** (the page's articles): no media variants at all, but no ids, entities or exact counts; it is
  the fallback `source: "dom"`, which has no `media` and is unchanged.

Measured, live, `posts:search --query "from:NASA filter:videos" --limit 20 --json` (all 20 posts carry a video, so
the worst case), 2026-10-18: **44,075 bytes before, 30,506 after (-31%)**. Before, media was 20,528 of the 44,075
(variants 16,830, key 620, width/height 528); `author` was 1,140 (2.6%), `counts` 4,622 (10%), `viewer` 1,220 and
`edits` 2,040. Kept: `author` (id, handle, name; a post's author never had an avatar or banner here, a `User` has
them only where the account is the item), `counts`, `viewer`, `edits`, since each is a small share and an agent
uses counts to judge a post. The print (`pageText`) is unchanged: it used only media type, url and alt.

What the screen taught: a video's variants were an m3u8 (no bitrate) and mp4s with `bitrate` (632000 to
10368000 on a 1080x1920 clip); the best mp4 is the highest bitrate, and a gif has a single mp4. `video` is that
mp4's url, `stream` the m3u8's, each left out when X sends none. A 429 on `Viewer` (exit 4) stopped one early
run, resetting 20:09Z; the rerun after it was fine.

### R-0013, review: the author keeps blue, verifiedType and followers

The first cut left a post's author as `{ id, handle, name }` only, which dropped signals an agent uses to judge
an account. They are back on `UserRef` (from the author's GraphQL result, `userRefFromResult`): `blue`,
`verifiedType`, and `followers` (the one count that tells a big account from a small one; the other account counts,
bio, avatar and banner stay on `User`). Measured live, same query (`from:NASA filter:videos --limit 20 --json`,
2026-10-18): **44,075 bytes before, 32,186 after (-27%)**. The three fields cost about 1,700 bytes of the 32,186
(5%): `blue` + `verifiedType` 820, `followers` the rest. Not a large share, so they stay. (The 30,506 above was
before they were added.)
