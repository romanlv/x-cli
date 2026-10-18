# home:posts: what the app taught

Built 2026-10-18 on the `me` context (signed in as @romitch), run through the page commands.

## Ways to do it in the app

- **Home, For you tab** (`/home`, the default): X's ranked picks. Gives: posts from accounts the
  person follows (`for_you_in_network`) mixed with ones X recommends (`for_you_phoenix_retrieval`,
  `for_you_simclusters`), the way a person sees them. Lacks: time order, so no `until`.
- **Home, Following tab**: posts of the accounts followed. Gives: the intent's "latest from
  accounts I follow". Lacks: it is not newest first. The call is `HomeLatestTimeline` with
  `enableRanking: true` and each entry's `clientEventInfo.component` is `ranked_following`; the
  ids in a page are not descending (2111404…, 2111165…, 2111666…, 2111672…, 2111625…), and a read of
  59 was not sorted. So Following can't take `until` either.
- **Home's "Manage timelines"** (button, opens a dialog): pins topics, lists and communities as extra
  tabs, with a search field. No switch for newest first or for ranking. Looked at, closed with
  Escape, nothing pinned.
- **Search with `filter:follows`** (`posts:search --query filter:follows`): newest first by id, so
  `until` would work. Not the home page: 6 of 8 posts were replies, it has no reposts, no ranking
  and no suggestions. Kept as a way for a caller who wants a time-ordered feed of followed
  accounts; not what "my home feed" is.
- **A list's timeline or a profile's Posts tab**: one list or one account at a time; not the feed.
- **The DOM** (`app.posts`): handles but no account ids and rounded counts, and an ad is drawn as
  an ordinary-looking article. The GraphQL responses carry ids, exact counts, full text and mark
  ads, so the op reads those.

Picked: the home page's two tabs, read through the page's own calls.

## Screens and waits

- Start page is the profile `/romitch`. The side nav's Home link (`AppTabBar_Home_Link`) opens
  `/home`; the op opens `/home` directly (`app.open`) as `posts:search` opens its URL.
- The tab list is drawn after the main column. Role `tab`, names "For you" and "Following", inside
  `primaryColumn`; the selected one has `aria-selected` (Playwright's `selected`). `app.homeShown()`
  waits for it; `app.homeTab(tab)` clicks a tab and waits until it is the selected one. "Manage
  timelines" is a button beside the tabs. The composer ("Post text", `tweetTextarea_0`) is above
  the posts and is never touched.
- A new page of `/home` always opened on For you, also right after a read of Following in another
  page, so the click is not kept across pages (checked with a step that said which tab `/home`
  opened on, over six runs mixing both tabs). An earlier version clicked back to the tab it found;
  removed as it was one more call to X for nothing. In the same page a reload keeps the tab
  (`page:goto /home` after a click on Following showed Following), as the page's own state.
- Switching tab makes the new tab's call; `app.timeline` listens before `open` so it hears it. The
  page's first load on For you also calls `HomeTimeline`, which the Following read ignores (it
  matches only `HomeLatestTimeline`).

## The calls behind it

For you: `GET /i/api/graphql/<queryId>/HomeTimeline?variables=…&features=…` (queryId `svLglq6U2wlTyZMGDDcLYQ`
today; it rotates). `variables`: `count: 20`, `includePromotedContent: true`,
`requestContext: "launch"`, `withCommunity: true`.

Following: `POST /i/api/graphql/<queryId>/HomeLatestTimeline` (`NmDBT3APtNxDpMqIEauu7A` today), JSON body
`{ variables: { count: 20, enableRanking: true, includePromotedContent: true, requestContext: "launch",
seenTweetIds: [...] }, features: {...} }`. `seenTweetIds` lists posts the page already showed.

Both answer `data.home.home_timeline_urt.instructions[]`, one `TimelineAddEntries` of 35 to 38 entries,
`cursor-top-…` and `cursor-bottom-…` among them. `readTimeline`/`postsPage` read it as it came
(mapper confirmed for both, nothing to fix). A page gives about 27 posts after the ads go, more
than the `count: 20` asked for.

Entry kinds seen:

- `tweet-<id>` (`TimelineTimelineItem`, result `Tweet`): a post or a repost (the result is the
  repost, the original inside); `socialContext` is absent on these.
- `promoted-tweet-<id>-<hash>` with `itemContent.promotedMetadata` (advertiser, `adMetadataContainer`)
  and `clientEventInfo.component` `for_you_promoted` / `ranked_following_promoted`: **ads**, 8 in
  each 37-entry page, in both tabs. The result is `Tweet` or `TweetWithVisibilityResults`. The
  mapper drops them by the `promoted-tweet` entry id, and again by `promotedMetadata`, and counts
  them as sent so a page of mostly ads still has more behind it. None came back in the output.
- `home-conversation-<id>` (`TimelineTimelineModule`, `displayType` `VerticalConversation`): two
  posts of one conversation (a self-reply by @dhh), the earlier first; read as two entries, the
  reply with `replyTo`. Seen on Following only.
- "Who to follow" and other suggestion modules (`who-to-follow-…`): not in the pages read (the
  sidebar's "Who to follow" is a separate call), and the mapper drops them by entry id if X adds
  them.

`clientEventInfo.component` tells whether X took a post from the accounts followed
(`for_you_in_network`) or recommended it (`for_you_phoenix_retrieval`, `for_you_simclusters`,
`for_you_phoenix_retrieval_cold`). That would help an agent looking for new accounts, but the
model has no field for it: a change for `model.ts` and `map/`, from this source, not made here.

## Output compared with the page

On one page load of Following the GraphQL mapping and the DOM (`page:posts`) agreed on every post
looked at: the same ids and text, replies, likes, bookmarks and views to the unit, and the DOM's
`repostsAndQuotes` equal to GraphQL's `reposts` + `quotes` (1 = 1 + 0). GraphQL adds author ids,
`conversationId`, `entities`, `card`, `media` and `viewer`.

## Behaviours seen

- `--limit 25` on For you: one call, 25 entries (22 posts, 3 reposts), ids unique, no ad, about 2 s.
- `--tab following --limit 60`: 59 entries unique (41 posts, 18 reposts) in 45 s, `more: true`: the
  10 scrolls ran out (a page is about 8000 px and a scroll 1800 px), as `posts:search`'s notes say.
- Ranked order: not sorted by id on either tab.
- The text view for this op ends `n posts · more past the limit`; `pageText`'s `--until` hint would
  be wrong here (`rankedPageText`).
- Rate limit: provoked by accident after about 20 fresh page loads in under an hour of exploring: X answered
  `Viewer` 429 and the op ended `x refused it: X: rate limited (Viewer, status 429); it resets at …` (exit 4),
  not retried, as x.md says. Each op run is a fresh page, so space runs out; exploring stopped there.
- Paths not taken on purpose: no like, repost, bookmark, follow or reply, and no click on
  "Manage timelines" items or on a post.

## Direct way

None: x/authoring.md rules it out. Layers 1 and 2 done; the calls are above. `page:fetch` not used.
