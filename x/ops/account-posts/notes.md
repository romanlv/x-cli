# account:posts: what the app taught

Built 2026-10-18 on the `me` context (signed in as @romitch), run through the page commands. Read
@NASA (no pinned post; 92M followers, posts and replies daily), @OpenAI (a pinned post) and
@AnthropicAI (none).

## Ways to do it in the app

- **A profile's Posts tab** (`/<handle>`, role `tab` "Posts"): the account's own posts and quotes,
  newest first by id, the pinned post above them. Gives: ids, exact counts, the pin. Lacks: reposts
  and replies (see below).
- **A profile's Replies tab** (`/<handle>/with_replies`): the account's replies, each in a
  conversation module under the post it answers. Gives: the replies with their parent. Lacks: the
  account's standalone posts, so it is not "Posts & replies".
- **A profile's Reposts tab** (`/<handle>/reposts`, `UserRepostsTimeline`): the account's reposts,
  newest first, each a `Tweet` with `legacy.retweeted_status_result`. Read by this op, always: the
  intent wants each post and repost keyed by id. `readTimeline` maps it as `repost` entries (own id,
  `by` the account, `post` the original with its author's account id and exact counts).
- **A profile's Media tab**: posts with media only; a subset of Posts.
- **Search `from:<handle>`** (`posts:search --query from:NASA`): one `SearchTimeline` for everything
  the account wrote, replies included, newest first by id. Gives: a single call for "with replies".
  Lacks: the pinned post, the profile's own ordering and what X's search index has dropped; it is
  the search's matching, not the profile. Kept as a way for a caller who wants a feed filtered with
  operators (`since:`, `filter:links`).
- **The DOM** (`app.posts`): handles but no account ids, and rounded counts above 10,000.

Picked: the profile's Posts tab, and with `--with-replies` the Posts tab then the Replies tab,
merged by id. The profile is what the intent names ("from its profile"), carries the pin, and the
page's own two calls give exact counts and ids. Search was not picked as the way to the profile,
since it has no pin and is a different set; and the old single "Posts & replies" tab is gone.

## What each tab does with reposts and replies (decided here)

- **Posts**: no reposts, no replies. Seen on @NASA and @OpenAI: every entry an own post or quote.
- **Replies**: replies only, plus the first post of a self-thread (its root). @NASA's newest
  originals (2111180963661435219, 2111093273800356092) are not in the first page. The posts it
  answered by others are the first item of each module, and are not the account's.
- **Reposts**: its own tab, `UserRepostsTimeline`; the op reads it on every call, so reposts come with the
  posts, merged by the repost's own id.
- **The other side of a reply**: the Replies tab sends the post replied to (another account's) as
  the module's first item. The op leaves it out (`keep` on the author's handle): the op is the
  account's posts, so an agent that reads it gets the account's replies and not strangers' posts,
  and `replyTo.post` / `replyTo.user` name the parent. A self-thread's earlier posts are the
  account's own and stay. The agent that wants the conversation reads the thread with `post:thread`
  on the `replyTo` id when that op exists.

## Screens and waits

- Start page is the profile `/romitch`. Its tab list is role `tablist` (`ScrollSnap-List`) with tabs
  "Posts", "Replies", "Reposts", "Media" (this X has no "Posts & replies"); clicking "Replies" went to
  `/NASA/with_replies` and called `UserRepliesTimeline`, "Reposts" went to `/NASA/reposts`. The op
  opens the URL directly (as `posts:search` does) and saves a page load; no click on a tab.
- A pinned post is an `article` with a `socialContext` "Pinned" line (`data-testid=socialContext`),
  seen on @OpenAI's first article. A profile that does not exist shows "This account doesn't
  exist" after the main column (`app.profile` waits for `UserName` or that text).
- The first page lands about 2 s after the main column. Scrolling brings the next call at the
  bottom of the page; `app.timeline` does that at a person's pace.
- Suspended ("Account suspended") and protected ("These posts are protected") profiles are checked
  by their text; **not seen** on a real account (no test account). A protected profile makes no
  timeline call, so `profileTimeline` waits for a post, the empty state or that text before the
  read.

## The calls behind it

All `GET /i/api/graphql/<queryId>/<Operation>?variables=…&features=…&fieldToggles=…`, read as the
page makes them (query ids rotate; today `QLGv_wL7wziqsHhU0K100w` for Originals,
`X9Te-FyiGcoV2qNrnx9w3w` for Replies, `jVw4ob-dDfVzoaz2G6NpVA` for Reposts).

- `UserByScreenName` (`screen_name`), once per page load: the account and its id.
- `UserOriginalsTimeline` (Posts): `variables` `{ userId, count: 20, includePromotedContent: true,
  withQuickPromoteEligibilityTweetFields: true, withVoice: true }`. Answers
  `data.user.result.timeline.timeline.instructions[]`: `TimelineClearCache`, a `TimelinePinEntry`
  (`entry.entryId` `tweet-<id>`, only when pinned; @OpenAI), and one `TimelineAddEntries` of 22 to 23
  entries: `tweet-<id>` items, a `who-to-follow-<id>` module (left out by the mapper), `cursor-top-`
  and `cursor-bottom-`. 20 posts in a page.
- `UserRepliesTimeline` (Replies): `variables` `{ userId, count: 20, includePromotedContent: true,
  withCommunity: true, withVoice: true }`. Same envelope. Entries are
  `profile-conversation-<id>` modules (`items[].entryId` `…-tweet-<id>`), the other account's post
  first, then the account's reply, ordered by the account's reply id, newest first; 20 modules, a
  module of one for a reply to a post that is not shown, one of seven for a long self-thread.
- Sidebar calls on the page (`SidebarUserRecommendations`, `ProfileSpotlightsQuery`,
  `ExploreSidebar`) are not the timeline.

### Mapper confirmed (2026-10-18)

`readTimeline` read all three as they came. Posts and Replies: ids, author ids, counts, `replyTo`,
`quoted`, media, entities and the pin all came out right, and counts matched the page to the unit
(139 replies, 205 + 24 reposts and quotes = the DOM's 229 reposts, on 2111180963661435219; likes
moved 1504 to 1506 between reads). Nothing in the mapper or its fixtures needed a fix. The
Reposts tab (now always read) maps to `repost` entries: its own id, `by` the account with its id, `post` the
original with its author's account id and exact counts (repost 2111148671219753420 by NASA 11348282 of
2111147283160998281, counts equal to the response's).

## Output compared with the page

The first posts of @NASA matched the Posts tab on the screen: the same text, order and counts (the
buttons' labels, as in the first `page` of the session). `--with-replies` interleaves them by id with the
replies; a reply's `replyTo` is the parent's id and account,.

## Behaviours seen

- `--handle NASA --limit 5`: one `UserOriginalsTimeline` call.
- `--with-replies --limit 12`: two page loads one after the other, 12 unique posts, strictly
  descending ids, replies and originals mixed; `more: true`; 4.5 s for the whole run.
- `--limit 45 --with-replies`: 45 unique posts, descending; `more: true`.
- `--until 2110823965954637903` on @NASA: the two newer posts, `more: false`. A first run of this
  call returned an empty page once with no error (not seen again in three more); if it comes back,
  look at how `timeline` handles a first page that has no posts.
- @OpenAI `--with-replies --limit 8`: the pinned post first (2107894997538525580, `pinned` names it),
  a self-thread 1/ 2/ 3/ in id order, a quote with `quoted` (the quoted post's account and text).
- A handle that does not exist: `error: no account @…` (exit 3). A bad handle `not a handle`: exit 2.
  `--limit 0`: exit 2.
- Verify once got `UserOriginalsTimeline answered 200 without JSON` on `@NASA --with-replies` (not reproduced in five
  runs after). `app.timeline` now keeps each response's body as it arrives and skips a 200 with none, waiting 5 s for
  another call before it reports it.
- Pace: spaced the runs 8 to 10 s apart; no 429 seen.
- Paths not taken on purpose: no follow, no like, repost, bookmark, no click on "More" or on a post.

## Direct way

None: x/authoring.md rules it out. Layers 1 and 2 done; the calls are above. `page:fetch` not used.

## Review fixes (2026-10-18)

- A limit that cut through a self-thread kept the first posts read, which are the oldest of a module
  (X lays 1/ above 2/). `gather.page` now keeps, for a newest-first timeline, the pinned posts and the
  newest of the rest by id (a unit test covers it), before the op merges.
- Reposts are always read, from the Reposts tab; Posts + Reposts (+ Replies) are three page loads
  one after the other. After about 30 fresh page loads in ten minutes X answered `Viewer` 429
  (`x refused it`, exit 4, resets in ~10 min), so space example runs out.
