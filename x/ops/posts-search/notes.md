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
