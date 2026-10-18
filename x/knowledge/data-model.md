# X's data model for x-cli

Researched 2026-10-17. The types are in `x/model.ts` (TypeBox schemas plus their static types). The
mapper from the web app's GraphQL is in `x/map/graphql.ts`, and its tests and fixtures are in
`tests/x-model.test.ts` and `tests/fixtures/x-graphql.ts`.

Tags: **[confirmed]** means a primary source or a client's captured 2026 test data shows it.
**[inferred]** means a client's parser reads it but no captured data shows it, or it is our own
reasoning. No shape here has been checked against this account yet. The first op that uses a mapper
confirms its shape and records that in `x.md`.

## Entities

```
                 ┌─────────── replyTo.post ───────────┐
                 ▼                                     │
User ◄─author── Post ──quoted (one level)──► QuotedPost | Unavailable
 ▲  ▲             ▲ ▲
 │  │             │ └──── post ──── Repost ──by──► UserRef
 │  │             │
 │  │ Entry = Post | Repost | Unavailable    (what a timeline holds)
 │  │
 │  └─ relationship (viewer → user: following, followedBy, followRequestSent/Received, blocking, blockedBy, muting)
 │
 ├── owner ── XList ── members: Page<User>          Notification ─ actors: UserRef[], targets: PostId[]
 └── Page<User | UserUnavailable>   (followers, following, list members, reposters, follow requests)

Thread = { focal, ancestors[], replies: ReplyGroup[] }      Page<T> = { items, more?, cursor?, pinned? }
Writes: Draft (text, replyTo?, quote?, media?, poll?), PostAction, UserAction, MessageDraft
```

| Type | What it is |
| --- | --- |
| `Post` (`kind: "post"`) | Something an account wrote: an original post, a reply (`replyTo`), or a quote (`quotedId`, `quoted`). |
| `Repost` (`kind: "repost"`) | Who reposted which post, and when. It is not a post by the reposter. |
| `Unavailable` (`kind: "unavailable"`) | A post X names but won't show, with a `reason` and X's own `message`. |
| `User` / `UserUnavailable` | An account. A `UserRef` (`id`, `handle`, `name`) is how other objects point to one. |
| `XList` | A list, with its owner and counts. Its members and posts are Pages. |
| `Notification` | One row of the notifications tab: `type`, `actors`, `targets`. |
| `Page<T>` | A bounded read of a timeline. |
| `Thread` | A post with its ancestors and its groups of replies. |
| `Media`, `Card`, `Poll`, `Entities`, `CommunityNote`, `Edits`, `PostCounts`, `PostViewer`, `Relationship` | The parts of the above. |

Bookmarks and likes have no type of their own. `bookmarks:list` is a `Page<Entry>`, and so is
`account:likes`. The signed-in account's own state on a post is `post.viewer` (`liked`, `reposted`,
`bookmarked`), and its state toward an account is `user.relationship`.

## Identity

- **Ids are keys. Handles are snapshots.** Post ids and user ids are decimal strings, because
  snowflakes pass 2^53 **[confirmed: API v2 returns ids as strings]**. A handle tells you what an
  account was called when it was read. Ops dedupe, compare and join by id. A handle is input only:
  an op resolves it to an id and then works with the id.
- `postUrl(id)` gives `https://x.com/i/status/<id>`, which works whatever the author is now called
  **[confirmed 2026-10-18: X redirects it to `/<handle>/status/<id>` and loads TweetDetail]**. No URL
  is stored.
- `timeOfId(id)` gives a post's time from its id (snowflake bits 22+, epoch 1288834974657)
  **[confirmed: X's snowflake format]**. When `createdAt` is missing, text output (`entryText`)
  falls back to it; no mapper fills `createdAt` from it. Ids from before snowflakes (2010-11-04,
  below about 2.97e10, such as jack/status/20) are counters with no time in
  them: `timeOfId` gives undefined, and `entryText` leaves the time out.
- A `UserRef` from the DOM has only a `handle`, because the page shows no user ids. GraphQL and the
  API always give `id` **[confirmed: rest_id in every fixture]**. If an op needs account ids, it
  reads GraphQL.
- A repost has its own status id (`Repost.id`), separate from the original post's id
  **[confirmed: twscrape raw_user_tweets.json, where the outer rest_id differs from
  retweeted_status_result's]**. The DOM shows only the original's id.

## Partial objects, unknown vs none

- **An absent field means "not loaded".** Either the source lacks it or the op didn't read it. A
  present field is what X said: `[]` means none, `0` means zero, `false` means no. `null` is never
  used. So `counts.bookmarks` absent means unknown, and `{ value: 0 }` means nobody bookmarked it.
  `media: []` means no media, and an absent `media` means it wasn't read.
- Every object has a `source` (`dom`, `graphql` or `api`), so a reader knows how complete it can be.
  A DOM post won't have `conversationId`, `entities` or exact counts. That is expected, not a bug.
- `truncated: true` marks text known to be cut short, for example a DOM post behind "Show more".
  GraphQL text is complete. A long post's full text is in `note_tweet`, and the mapper uses it
  **[confirmed: raw_search.json; twikit and twscrape both prefer note_tweet]**.
- `text` is not the same string from each source. GraphQL's `full_text` keeps a reply's leading
  `@handles` and the trailing t.co links X adds for media and a quote (`display_text_range` marks
  the part shown); the DOM's `tweetText` has neither. `entities` offsets are into GraphQL's text, so
  never apply them to a DOM post's text. The mapper doesn't keep `display_text_range` yet.
- The mapper's `clean()` drops `undefined` keys, so JSON output and `Value.Check` agree on "absent".

## Counts and exactness

`Count = { value, exact }`. GraphQL and the API give exact integers: `exact: true`, exact when read,
since counts keep moving. The DOM's screen text says "12K", but the labels the reader uses carry
the exact number, so DOM counts are exact too **[confirmed 2026-10-18: equal to GraphQL's on four
@NASA posts, 2142 to 958905 views]**; a label with "12K" in it would still become
`{ value: 12000, exact: false }`. Text output prefixes an inexact count with `~`.

| Count | GraphQL (`legacy` or top level) | API v2 `public_metrics` | DOM |
| --- | --- | --- | --- |
| replies | `reply_count` | `reply_count` | action bar label, else `reply` button aria-label |
| reposts | `retweet_count` | `retweet_count` | not shown apart from quotes |
| quotes | `quote_count` | `quote_count` | not shown apart from reposts |
| repostsAndQuotes | not set (it has the two apart) | not set | action bar label, else `retweet` / `unretweet` aria-label: X's number beside the button is reposts plus quotes **[confirmed 2026-10-18: 216 = 194 + 22, 258 = 242 + 16]** |
| likes | `favorite_count` | `like_count` | action bar label, else `like` / `unlike` aria-label |
| bookmarks | `bookmark_count` | `bookmark_count` | action bar label, else a number in `removeBookmark`'s label; `bookmark`'s is just "Bookmark" |
| views | `views.count`, a string; absent unless `state` is `EnabledWithCount` | `impression_count` | action bar label, else the analytics link's aria-label |

All GraphQL entries are **[confirmed in fixtures]**. The API names are **[confirmed: docs.x.com
data dictionary]**. The action bar is the post's `div[role=group]`, whose aria-label names its
counts in full, "264 replies, 687 reposts, 6523 likes, 3355 bookmarks, 1778078 views"
**[secondary: zendegani/XClipper src/content/tweet.ts, pushed 2026-10-17; alchaincyf/huashu-chrome
docs/经验/x.com.md, 2026-09; neither confirmed against this account]**. Neither says whether a count
of 0 is left out of it, so a count it doesn't name stays absent there. The buttons' entries are
**[inferred: knowledge/x.md, unconfirmed]**. Whether a button's aria-label carries an exact number
("1,204 Likes") while the visible text is rounded is unconfirmed: it decides whether the DOM can set
`exact: true` when the action bar has no label. A repost's own counts in GraphQL echo the original's
`retweet_count` and are otherwise 0 **[confirmed: raw_user_tweets.json]**, so `Repost` has no
counts, and the original post carries them.

A user's counts are followers, following, posts, likes, media and listed. The new user shape has no
`listed_count` **[confirmed: raw_user_by_login.json]**, so `listed` is absent there.

## Threads, conversations, replies

- `conversationId` is the id of the post that started the conversation. Every reply in it carries
  that id **[confirmed: API v2 `conversation_id`; GraphQL `conversation_id_str`]**. `replyTo.post`
  is the direct parent (`in_reply_to_status_id_str` / `referenced_tweets[type=replied_to]`).
  `replyTo.user` is that parent's author. Following parent pointers rebuilds the reply tree.
- A **self-thread** is a chain of replies where each one is by the same author as its parent:
  `replyTo.user.id === author.id`. On a post's page, TweetDetail puts the author's continuation in
  the first conversation module with `tweetDisplayType: "SelfThread"`, and the mapper sets
  `ReplyGroup.selfThread` **[confirmed: raw_tweet_details.json]**.
- `Thread` follows how X's TweetDetail is built
  (`threaded_conversation_with_injections_v2.instructions`), and `threadOf()` maps it:
  - `ancestors` are the entries before the focal `tweet-<id>`, oldest first
    **[confirmed: twikit get_tweet_by_id, which takes entries before the focal one as reply_to]**.
    A deleted ancestor is `Unavailable`.
  - `focal` is the post asked for.
  - `replies` holds one `ReplyGroup` per `conversationthread-<id>` module: a direct reply and the
    replies X shows under it **[confirmed]**. `group.more` means the module has a `ShowMore` cursor
    ("Show replies") **[confirmed: card_poll.json]**. `thread.more` means there is a `Bottom` or
    `ShowMoreThreads` cursor ("Show more replies", the lower-ranked section)
    **[confirmed: card_poll.json, article.json]**.
  - Ads (`…-promoted-tweet-…`) and "you might also like" modules are left out.
- A profile (its Posts tab too, for a self-thread, and "with replies") and a list timeline also
  group conversations into modules (`profile-conversation-<id>`, `list-conversation-<id>`), oldest
  first **[confirmed]**. `postsPage` flattens them into entries, and `readTimeline().items[].module`
  keeps the grouping for an op that wants it (and for `until`, Pagination).

## Reposts and quotes

- A repost is `Repost { by, createdAt, post }`. GraphQL nests the original at
  `legacy.retweeted_status_result.result`, and the outer `full_text` is a truncated "RT @x: …"
  **[confirmed]**. The mapper never uses the outer text. API v2 marks a repost with
  `referenced_tweets[type=retweeted]` **[confirmed: docs.x.com data dictionary examples]**.
- A quote is a `Post` with `quotedId`, plus `quoted` when X embedded the post. X embeds one level:
  the quoted post's own quote is only `quotedId` (`QuotedPost` has no `quoted`)
  **[confirmed: X embeds `quoted_status_result` one level; twscrape drops quoted posts from the
  item list (#300, #315)]**. A quoted post is not a timeline item of its own.
- A repost of a quote is a `Repost` whose `post` has `quoted`.
- X sometimes sends a nested post's author as `UserUnavailable` or as a stub. The author is then
  rebuilt from the outer post's `user_mentions` (reposts) or `quoted_status_permalink` (quotes)
  **[confirmed: twscrape #342, #343, _issue_342_343.json]**. A stub is a `User` result with
  `rest_id` and none of `core` or `legacy` (that file's third entry): its id is kept and the handle
  and name come from the outer post, when its id matches.

## Deleted, withheld, protected, unavailable

| GraphQL | Model |
| --- | --- |
| `TweetTombstone` with `tombstone.text.text` ("This Post was deleted by the Post author. Learn more") | `Unavailable`, `reason` read from the sentence (deleted, suspended, protected, withheld, age-restricted, blocked), `message` set to the sentence. Its id comes from the entry id or the quoting post. **[confirmed shape: twikit, yt-dlp; the sentences are inferred]** |
| `TweetUnavailable` with `reason` (`Protected`, `NsfwLoggedOut`, …) | `Unavailable`, `reason` from the code, no `message` (the code is not X's sentence) **[confirmed: yt-dlp]** |
| `TweetWithVisibilityResults { tweet, limitedActionResults }` | The inner post, with `limitedActions` (for example `["Reply"]`) **[confirmed: raw_list_timeline.json]** |
| an empty `tweet_results` | `Unavailable`, reason `unknown`, id from the entry **[inferred]** |
| a `TimelineTombstone` item with `tombstoneInfo.richText.text` | `Unavailable`, `reason` read from the sentence, `message` set to it **[inferred]** |
| `UserUnavailable { reason, message }` | `UserUnavailable`; `Suspended` becomes `suspended` **[confirmed: the-convocation profile.ts]**, any other reason (`NoReason` in _issue_342_343.json) `unknown`. No source names a reason for a deactivated account, so the model has none. |
| `withheld_in_countries` | `withheldIn` **[inferred: twikit user.py, v1.1 legacy field]** |

API v2 reports a missing referenced post as an `errors[]` entry next to `data` (resource_type
`tweet`) **[inferred; docs not checked]**. The DOM shows a tombstone box in place of the article
**[inferred]**.

## Pagination

`Page<T> = { items, more?, cursor?, pinned? }`. Ops never make calls of their own (`authoring.md`),
so an op can't resume a GraphQL cursor: scrolling sends the page's next request. A read is bounded
by `limit`, or by a stopping id (`until`), and a later read resumes from an id. Post ids are
time-ordered snowflakes. `cursor` is X's Bottom cursor where one response is mapped (`postsPage`,
`usersPage`), and for the API source the `next_token` an op can pass back; `app.timeline` and
`app.posts` leave it out, since a cursor past a page cut at `limit` would skip what was cut.

`more` is true when X sent a Bottom cursor, unless X said the timeline ends: a
`TimelineTerminateTimeline` with `direction: "Bottom"` **[confirmed in fixtures: raw_followers]**,
or a page with cursors and no
entries, which is how X ends a timeline that still sends a Bottom cursor **[confirmed: twscrape
api.py comment; inferred that the cursor-only page is that end]**. A page whose entries were all
left out (ads, suggestions) still has `more`, so a read scrolls on past it. A bounded read
(`app.timeline`, `app.posts`) says `more: false` when X ended the timeline or it reached `until`,
`true` when it stopped with more to read, and leaves `more` out when it can't tell (the DOM stopped
growing).

A profile's pinned post comes first, in a `TimelinePinEntry` **[confirmed: raw_user_tweets.json]**
or under the DOM's "Pinned" `socialContext` **[inferred]**, out of the timeline's order. It stays
in `items`, and `pinned` lists its id, so an op can drop or label it. `until` never stops at a
pinned entry. Where the timeline is newest first by id, an op says so (`newestFirst`) and a read
stops at the first entry whose id is at or before `until`, so a deleted `until` post still stops
it: a post by its id and a GraphQL repost by its own (when it was reposted). A DOM repost has no
id of its own, so its post's id says nothing of when it was reposted: it stops a read only when
its post is `until` itself. `until` itself stops a read by the same ids. Elsewhere
(bookmarks and likes are in the order they were saved, search's Top by rank) only `until` itself
stops a read.

A profile (Posts and with replies) and a list group a conversation into a module laid out oldest
first, a parent above its reply and a self-thread's 1/ above 2/, placed in the timeline by its
newest post **[confirmed: profile-conversation- modules of two and three items in twscrape's
raw_user_tweets.json and raw_user_tweets_and_replies.json]**. So for GraphQL (`app.timeline`) only
an entry outside a module and a module's last post compare by id; a post above it in its module
never stops a read, is left out when it is the `until` post, and is left out with its module's
last post when that stops the read. The DOM can't see modules, so for
`app.posts` only search's Latest, which has none, is newest first.

`app.posts` reads the DOM, where a tombstone has no id: it is known by the entry before it. First
in a read, it is skipped when the entry after it was seen already (it was then read the time
before); otherwise it follows on from the last entry with an id the reads before had, so one that
ends a read and starts the next is counted once. Every read is capped at 10 scrolls (`scrolls`),
and one cut short by the cap says `more`.

Cursor kinds: `Top`, `Bottom`, `ShowMore` (inside a module), `ShowMoreThreads`. Their values are
opaque strings, and Followers uses `"<n>|<n>"` **[confirmed]**. Instructions: `TimelineAddEntries`,
`TimelinePinEntry` (singular `entry`, a profile's pinned post), `TimelineAddToModule`
(`moduleItems`, inferred), `TimelineClearCache`, `TimelineTerminateTimeline` **[confirmed except
AddToModule]**.

## Where each operation's timeline is

`readTimeline` finds every `instructions` array under `data`, so one function serves all
operations **[paths confirmed: twscrape fixtures]**:

| Operation | Path | Entries |
| --- | --- | --- |
| SearchTimeline | `data.search_by_raw_query.search_timeline.timeline` | `tweet-<id>` (or `user-<id>` on People) |
| UserOriginalsTimeline (a profile's Posts tab) | `data.user.result.timeline.timeline` | `tweet-`, `profile-originals-conversation-`, `who-to-follow-` (left out) **[confirmed 2026-10-18]** |
| UserRepliesTimeline (a profile's Replies tab) | `data.user.result.timeline.timeline` | `profile-conversation-<id>` modules, the post answered first (another account's) then the account's reply; no standalone posts **[confirmed 2026-10-18]** |
| UserRepostsTimeline (a profile's Reposts tab) | `data.user.result.timeline.timeline` | `tweet-<id>`, each a `Tweet` with `legacy.retweeted_status_result` **[confirmed 2026-10-18: `repost` with its own id, `by` the account, `post` the nested original]** |
| UserTweets, UserTweetsAndReplies, UserMedia, Likes | `data.user.result.timeline.timeline` (older: `timeline_v2`) | `tweet-`, `profile-conversation-`, `who-to-follow-` (left out) |
| TweetDetail | `data.threaded_conversation_with_injections_v2` | `tweet-`, `conversationthread-`, `cursor-showmorethreads-` |
| Followers, Following, BlueVerifiedFollowers | `data.user.result.timeline.timeline` | `user-<id>` |
| ListLatestTweetsTimeline / ListMembers | `data.list.tweets_timeline.timeline` / `data.list.members_timeline.timeline` | `tweet-`, `list-conversation-` / `user-` |
| Retweeters | `data.retweeters_timeline.timeline` | `user-` |
| Bookmarks | `data.bookmark_timeline_v2.timeline` **[inferred]** | `tweet-` |
| UserByScreenName / UserByRestId | `data.user.result`, not a timeline: use `userFromResult` | |
| TweetResultByRestId | `data.tweetResult.result`: use `entryFromResult` | |

Notifications are not GraphQL in the clients: twikit reads REST `/i/api/2/notifications/all.json`
(and `mentions.json`, `verified.json`), shaped as `globalObjects.{users,tweets,notifications}` plus
timeline instructions. A notification is
`{ id, timestampMs, icon.id, message.text, template.aggregateUserActionsV1.{fromUsers,targetObjects} }`
**[confirmed: twikit client.py]**. Which call today's web app makes for `/notifications` is
unconfirmed, so there is no mapper yet. `Notification.type` comes from the icon (`heart_icon` like,
`retweet_icon` repost, `person_icon` follow) **[inferred]**, else `other`. Mentions, replies and
quotes are posts, not notifications, so `type` has no value for them; no source names a type for a
follow request either. A mapper adds a type when it has a source for it.

## Field mapping: DOM, GraphQL, API v2

GraphQL fields are in `legacy` on older posts and at the top level on posts since 2026-05
**[confirmed: twscrape utils.py to_old_obj]**. Users moved to `core`, `avatar`, `privacy`,
`relationship_counts` and other sub-objects with no `legacy` at all **[confirmed:
raw_user_by_login.json, 2026]**. The mapper reads both. "—" means the source doesn't have it.

| Model | DOM (`article[data-testid=tweet]`) | GraphQL tweet result | API v2 |
| --- | --- | --- | --- |
| `id` | permalink `a[href*=/status/]` | `rest_id` | `id` |
| `author` | `User-Name` text: name, `@handle`; no id | `core.user_results.result` (rest_id, core.screen_name, core.name) | `author_id` + `includes.users` |
| `createdAt` | `time[datetime]` | `created_at` ("Wed Jul 08 21:59:10 +0000 2026") | `created_at` (ISO) |
| `text` | `tweetText` innerText (may be `truncated`) | `note_tweet.note_tweet_results.result.text` ?? `full_text` | `note_tweet.text` ?? `text` |
| `lang` | `tweetText[lang]` (inferred) | `lang` | `lang` |
| `conversationId` | — | `conversation_id_str` | `conversation_id` |
| `replyTo` | "Replying to @x" (handle only, inferred) | `in_reply_to_status_id_str`, `in_reply_to_user_id_str`, `in_reply_to_screen_name` | `referenced_tweets[replied_to]`, `in_reply_to_user_id` |
| `quotedId` / `quoted` | the embedded quote box (inferred) | `quoted_status_id_str`, `quoted_status_result.result` | `referenced_tweets[quoted]` + `includes.tweets` |
| Repost | `socialContext` "X reposted" above the article (inferred) | `retweeted_status_result.result` | `referenced_tweets[retweeted]` |
| `entities` | links and `@`/`#` anchors, no ranges | `entities` / `note_tweet…entity_set`: `hashtags`, `symbols`, `user_mentions`, `urls`, each with `indices` | `entities.{hashtags,cashtags,mentions,urls}` with `start`/`end` |
| `media` | `tweetPhoto` img `alt`, `videoPlayer` (inferred) | `extended_entities.media[]`: `type`, `media_key`, `media_url_https`, `ext_alt_text`, `original_info`, `video_info` | `attachments.media_keys` + `includes.media` (`alt_text`, `variants`, `duration_ms`, `public_metrics.view_count`) |
| `card` | `card.wrapper` (inferred) | `card.legacy.{name, binding_values}` (title, description, vanity_url, card_url, *_image_original) | `card_uri` only; link previews in `entities.urls[].title/description/images` |
| `poll` | radio list with %, not counts | card `poll<n>choice_*`: `choiceN_label`, `choiceN_count`, `end_datetime_utc`, `duration_minutes`, `counts_are_final` | `attachments.poll_ids` + `includes.polls` (`options[].votes`, `voting_status`, `end_datetime`) |
| `hasNote` / `note` | `birdwatch-pivot` box (inferred) | `has_birdwatch_notes`; `birdwatch_pivot.{note.rest_id, subtitle.text}` (inferred: twikit) | — (the API documents none) |
| `edits` | "Last edited" label (inferred) | `edit_control.edit_tweet_ids` or `edit_control.edit_control_initial.edit_tweet_ids`, `editable_until_msecs`, `edits_remaining` | `edit_history_tweet_ids` (oldest first), `edit_controls.{editable_until, edits_remaining}` |
| `counts` | aria-labels, exact; reposts and quotes as one | see Counts | `public_metrics` |
| `viewer` | `unlike` / `unretweet` / `removeBookmark` testids mean on (inferred) | `favorited`, `retweeted`, `bookmarked` | — (separate liking/bookmark lookups) |
| `sensitive` | the "sensitive content" interstitial (inferred) | `possibly_sensitive` | `possibly_sensitive` |
| `limitedActions` | — | `TweetWithVisibilityResults.limitedActionResults.limited_actions[].action` | `reply_settings` (related, not the same) |
| `withheldIn` | — | `withheld_in_countries` (inferred) | `withheld.country_codes` |

| Model `User` | DOM (profile page) | GraphQL user result (2026 / legacy) | API v2 |
| --- | --- | --- | --- |
| `id` | — | `rest_id` | `id` |
| `handle`, `name` | `UserName` (inferred) | `core.screen_name`, `core.name` / `legacy.screen_name`, `legacy.name` | `username`, `name` |
| `bio`, `location`, `website` | `UserDescription`, `UserLocation`, `UserUrl` (inferred) | `profile_bio.description`, `location.location`, `profile_bio.entities.url.urls[0].expanded_url` / `legacy.description`, `legacy.location`, `legacy.entities.url` | `description`, `location`, `url` + `entities.url` |
| `createdAt` | `UserJoinDate` (month only) | `core.created_at` / `legacy.created_at` | `created_at` |
| `avatar`, `banner` | img src | `avatar.image_url`, `banner.image_url` / `legacy.profile_image_url_https`, `legacy.profile_banner_url` | `profile_image_url`, `profile_banner_url` |
| `protected` | lock icon | `privacy.protected` / `legacy.protected` | `protected` |
| `blue`, `verifiedType` | badge (inferred) | `is_blue_verified`, `verification.verified_type` | `verified`, `verified_type` |
| `counts` | "1,234 Following" links, approximate | `relationship_counts.{followers,following}`, `tweet_counts.{tweets,media_tweets}`, `action_counts.favorites_count` / `legacy.*_count` | `public_metrics.{followers_count,following_count,tweet_count,listed_count}` |
| `pinned` | — | `pinned_items.tweet_ids_str` / `legacy.pinned_tweet_ids_str` | `pinned_tweet_id` |
| `relationship` | Follow / Following / Pending button, "Follows you" (inferred) | `relationship_perspectives.{following,followed_by,blocking,blocked_by,muting}`, `follow_request_sent` / `legacy.*` | `connection_status[]` (following, followed_by, follow_request_sent, follow_request_received, blocking, muting) |

`XList`: GraphQL `id_str`, `name`, `description`, `mode` (Private/Public), `member_count`,
`subscriber_count`, `created_at` (ms), `user_results` (owner) **[inferred: twikit list.py]**. API v2:
`id`, `name`, `description`, `private`, `member_count`, `follower_count`, `owner_id`, `created_at`
**[confirmed]**.

Ranges in `entities` are offsets in Unicode code points, as X gives them, and `end` is exclusive
**[inferred: the v1.1 convention; the API's start/end match it]**. JavaScript strings index in
UTF-16, so slicing text after an emoji needs `Array.from(text)`. The mapper stores the offsets as X
sent them.

## How the DOM fills it

`readPosts` (`x/helpers`) reads each timeline cell in the browser and `x/map/dom.ts` maps it to an
`Entry` with `source: "dom"` **[inferred: tested against modelled HTML, tests/fixtures/x-dom.ts]**:

- `id` and `author.handle` from the permalink (`/<handle>/status/<id>`); `author.name` from
  User-Name. No account id.
- `createdAt` from `time[datetime]`; `text` and `lang` from `tweetText`, with `truncated: true` when
  `tweet-text-show-more-link` is there.
- `counts` from the action bar's aria-label where it names one (see Counts), else the buttons'
  aria-labels, via `count()`: `exact: false` when the number has K or M, else `exact: true`, since X
  rounds only with a suffix. The action bar's label was there on every post read so far (bookmarks
  came through, which only it gives). The repost count is `repostsAndQuotes`. A reply, repost or like
  button whose label has no number ("Reply") is 0 **[inferred: X writes "0 Replies. Reply"]**; a
  button with no label says nothing. Views come from the analytics link.
- An article inside `[data-testid="placementTracking"]` is an ad and is left out, as GraphQL's
  promoted entries are **[secondary: typefully/minimal-twitter css/main.css hides
  `[data-testid="placementTracking"] article`, 2026-08; it notes that a post's video has a
  placementTracking of its own, so only an article inside one is an ad]**.
- A `socialContext` "Pinned" line marks the post pinned (`Page.pinned`) **[inferred]**.
- `viewer` from which button of each pair shows (`unlike` means liked).
- A `socialContext` "reposted" line makes the entry a `Repost` with `by: { handle }` from its link,
  no `id`, and the article's post as `post`.
- An embedded quote (a `role=link` box with its own User-Name) becomes `quoted` only when it holds a
  permalink, since a `QuotedPost` needs its id; the post's own text and buttons are the ones outside it.
- A cell with no article whose text names "this post" is `Unavailable`, reason from the sentence,
  no id.

Everything else stays absent. `app.posts` keys what it has seen by id (an id-less tombstone as
Pagination says) and stops at `limit` or before `until`, as `app.timeline` does over GraphQL.

## Writes reuse the types

Writes are out of scope today (`authoring.md`). The model is ready for them without a redesign:

- `Draft { text, replyTo?: PostId, quote?: PostId, media?: { file, alt? }[], poll?: { options, durationMinutes } }`
  covers post, reply and quote. API v2's create takes the same parts: `reply.in_reply_to_tweet_id`,
  `quote_tweet_id`, `media.media_ids`, `poll.{options,duration_minutes}` **[inferred from the API
  create-post docs; not fetched]**. Limits to check: four media items, poll options 2–4 of 25
  characters, a poll lasting 5 minutes to 7 days **[inferred]**.
- `PostAction { action: like|unlike|repost|unrepost|bookmark|unbookmark|delete, post }` and
  `UserAction { action: follow|unfollow|mute|unmute|block|unblock, user }` take ids, never handles.
- `MessageDraft { to: UserId[], text }` is for DMs. There is no DM read type yet: a DM conversation
  and its messages need their own research, since the API's dm_events and the web app's DM calls
  have not been studied.
- A write's output is the object read back after it: the `Post` created, or the `PostViewer` or
  `Relationship` that changed. A write checks `viewer` or `relationship` first so it is idempotent:
  it doesn't like a post that is already liked. Following a protected account ends in
  `relationship.followRequestSent: true`, not `following`.

## Not modelled (no source, or not needed yet)

Places and geo (`place`, `coordinates`), Spaces (only as a card name, `audiospace`), Communities,
Articles (`article`), context annotations, source app, bookmark folders, DMs (reading), trends, and
API v2's `non_public_metrics`/`organic_metrics`. Add each when an op needs it, from a source.

## Open questions

1. ~~**DOM counts**~~ answered 2026-10-18: the action bar's label and the buttons' aria-labels
   carry exact numbers, 0 included, and the repost count includes quotes (`repostsAndQuotes`).
2. **Notifications**: which call does `/notifications` make today: REST `notifications/all.json`
   (twikit) or a GraphQL `NotificationsTimeline`? Check with `page:requests`, then write its mapper.
3. **Bookmarks path**: the GraphQL operation name and path (`Bookmarks`,
   `bookmark_timeline_v2`) are unconfirmed.
4. **Tombstone sentences**: the reason is read from X's English text. A non-English UI would make
   every reason `unknown`. Should the sign-in profile be pinned to English?
5. **Edited posts**: when a timeline shows an older version, does GraphQL give the latest id
   (`edit_control.initial_tweet_id`)? Should an op return the latest version, as API v2 does?
6. **The end of a timeline**: `more` now uses `TimelineTerminateTimeline` and a page with no
   entries. Does every timeline end one of those two ways on this account?
7. **Repost time**: is a repost's `created_at` when it was reposted? The fixtures suggest yes, since
   the outer and inner times differ, but this is unchecked.
8. **API v2 as a source**: there is no mapper for it, since the tool doesn't use the API
   (bot-detection.md §3.2). The field table above is what one would follow.

## Sources (accessed 2026-10-17)

- X API v2 data dictionary: https://docs.x.com/x-api/fundamentals/data-dictionary (Post, User,
  Media, Poll, Place, List, Space, Community, expansions). Quote, retweet and reply examples:
  https://docs.x.com/x-api/fundamentals/data-dictionary/reference (via Context7 `/websites/x_x-api`).
  Edits: https://docs.x.com/x-api/fundamentals/edit-posts (30 min, 5 edits, oldest first, delete
  removes the chain).
- twscrape (HEAD 568844d, 2026-10-05): `twscrape/models.py`, `twscrape/utils.py` (to_old_obj and
  to_old_rep: the 2026-05 legacy-null change, visibility wrapper, quoted-id filtering), `api.py`
  (cursors), and `tests/mocked-data/*.json` (raw_search, raw_user_tweets, raw_tweet_details,
  card_poll, article, raw_followers, raw_list_timeline, raw_retweeters, raw_user_by_login,
  _issue_342_343). https://github.com/vladkens/twscrape
- twikit (HEAD 2026-03): `twikit/tweet.py` (tweet_from_data, TweetTombstone, birdwatch_pivot,
  edit_control), `user.py`, `list.py`, `client/client.py` (get_tweet_by_id, get_notifications).
  https://github.com/d60/twikit
- the-convocation/twitter-scraper (0e528fa, 2026-03-31): `src/timeline-v2.ts`
  (TweetWithVisibilityResults, TimelinePinEntry `entry`, SelfThread), `src/tweets.ts`,
  `src/profile.ts` (UserUnavailable Suspended). https://github.com/the-convocation/twitter-scraper
- yt-dlp `yt_dlp/extractor/twitter.py` `_graphql_to_legacy` (TweetTombstone, TweetUnavailable
  reasons). https://github.com/yt-dlp/yt-dlp
- DOM, secondary (small projects that read x.com's page): typefully/minimal-twitter `css/main.css`
  (placementTracking ads, pushed 2026-08-18) https://github.com/typefully/minimal-twitter ;
  zendegani/XClipper `src/content/tweet.ts` (the action bar's aria-label, pushed 2026-10-17)
  https://github.com/zendegani/XClipper ; alchaincyf/huashu-chrome `docs/经验/x.com.md` (the same
  label, exact counts, 2026-09) https://github.com/alchaincyf/huashu-chrome
