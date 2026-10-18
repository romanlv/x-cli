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

Thread = { focal, ancestors[], replies: ReplyGroup[] }      Page<T> = { items, more?, cursor? }
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
  **[inferred: X redirects /i/status/ to the canonical URL]**. No URL is stored.
- `timeOfId(id)` gives a post's time from its id (snowflake bits 22+, epoch 1288834974657)
  **[confirmed: X's snowflake format]**. When `createdAt` is missing, this fills it.
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
- The mapper's `clean()` drops `undefined` keys, so JSON output and `Value.Check` agree on "absent".

## Counts and exactness

`Count = { value, exact }`. GraphQL and the API give exact integers: `exact: true`, exact when read,
since counts keep moving. The DOM writes "12K", which becomes `{ value: 12000, exact: false }`.
Text output prefixes an inexact count with `~`.

| Count | GraphQL (`legacy` or top level) | API v2 `public_metrics` | DOM |
| --- | --- | --- | --- |
| replies | `reply_count` | `reply_count` | `reply` button aria-label |
| reposts | `retweet_count` | `retweet_count` | `retweet` / `unretweet` aria-label |
| quotes | `quote_count` | `quote_count` | not shown in the timeline |
| likes | `favorite_count` | `like_count` | `like` / `unlike` aria-label |
| bookmarks | `bookmark_count` | `bookmark_count` | `bookmark` aria-label (unconfirmed) |
| views | `views.count`, a string; absent unless `state` is `EnabledWithCount` | `impression_count` | the analytics link's aria-label |

All GraphQL entries are **[confirmed in fixtures]**. The API names are **[confirmed: docs.x.com
data dictionary]**. The DOM entries are **[inferred: knowledge/x.md, unconfirmed]**. Whether the
aria-labels carry exact numbers ("1,204 Likes") while the visible text is rounded is unconfirmed: it
decides whether the DOM can set `exact: true`. A repost's own counts in GraphQL echo the original's
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
- A profile's "with replies" tab and a list timeline also group conversations into modules
  (`profile-conversation-<id>`, `list-conversation-<id>`) **[confirmed]**. `postsPage` flattens them
  into entries, and `readTimeline().items[].module` keeps the grouping for an op that wants it.

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
  **[confirmed: twscrape #342, #343, _issue_342_343.json]**.

## Deleted, withheld, protected, unavailable

| GraphQL | Model |
| --- | --- |
| `TweetTombstone` with `tombstone.text.text` ("This Post was deleted by the Post author. Learn more") | `Unavailable`, `reason` read from the sentence (deleted, suspended, protected, withheld, age-restricted, blocked), `message` set to the sentence. Its id comes from the entry id or the quoting post. **[confirmed shape: twikit, yt-dlp; the sentences are inferred]** |
| `TweetUnavailable` with `reason` (`Protected`, `NsfwLoggedOut`, …) | `Unavailable` **[confirmed: yt-dlp]** |
| `TweetWithVisibilityResults { tweet, limitedActionResults }` | The inner post, with `limitedActions` (for example `["Reply"]`) **[confirmed: raw_list_timeline.json]** |
| an empty `tweet_results` | `Unavailable`, reason `unknown`, id from the entry **[inferred]** |
| `UserUnavailable { reason, message }` | `UserUnavailable`; `Suspended` becomes `suspended` **[confirmed: the-convocation profile.ts]** |
| `withheld_in_countries` | `withheldIn` **[inferred: twikit user.py, v1.1 legacy field]** |

API v2 reports a missing referenced post as an `errors[]` entry next to `data` (resource_type
`tweet`) **[inferred; docs not checked]**. The DOM shows a tombstone box in place of the article
**[inferred]**.

## Pagination

`Page<T> = { items, more?, cursor? }`. Ops never make calls of their own (`authoring.md`), so an op
can't resume a GraphQL cursor: scrolling sends the page's next request. A read is bounded by
`limit`, or by a stopping id or time (`until`), and a later read resumes from an id. Post ids are
time-ordered snowflakes. `cursor` holds X's Bottom cursor for the record, and for the API source,
where it is the `next_token` an op can pass back. `more` is inferred: X sends a Bottom cursor on the
last page too **[confirmed: twscrape api.py comment]**. So "items and a cursor" means there may be
more. `TimelineTerminateTimeline` marks a true end **[confirmed in fixtures]**, but the mapper
doesn't use it yet.

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
`retweet_icon` repost, `person_icon` follow) **[inferred]**. Mentions and replies are posts.

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
| `counts` | aria-labels, approximate | see Counts | `public_metrics` |
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
- `counts` from the buttons' aria-labels via `count()`: `exact: false` when the number has K or M,
  else `exact: true`, since X rounds only with a suffix (open question 1 confirms it). A button with
  no number in its label is 0. Views come from the analytics link; quotes aren't shown.
- `viewer` from which button of each pair shows (`unlike` means liked).
- A `socialContext` "reposted" line makes the entry a `Repost` with `by: { handle }` from its link,
  no `id`, and the article's post as `post`.
- An embedded quote (a `role=link` box with its own User-Name) becomes `quoted` only when it holds a
  permalink, since a `QuotedPost` needs its id; the post's own text and buttons are the ones outside it.
- A cell with no article whose text names "this post" is `Unavailable`, reason from the sentence,
  no id.

Everything else stays absent. `app.posts` keys what it has seen by id (an id-less tombstone by the
entry before it) and stops at `limit` or before `until`, as `app.timeline` does over GraphQL.

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

1. **DOM counts**: do the aria-labels carry exact numbers? This decides `exact` for DOM counts.
2. **Notifications**: which call does `/notifications` make today: REST `notifications/all.json`
   (twikit) or a GraphQL `NotificationsTimeline`? Check with `page:requests`, then write its mapper.
3. **Bookmarks path**: the GraphQL operation name and path (`Bookmarks`,
   `bookmark_timeline_v2`) are unconfirmed.
4. **Tombstone sentences**: the reason is read from X's English text. A non-English UI would make
   every reason `unknown`. Should the sign-in profile be pinned to English?
5. **Edited posts**: when a timeline shows an older version, does GraphQL give the latest id
   (`edit_control.initial_tweet_id`)? Should an op return the latest version, as API v2 does?
6. **Should `more` use `TimelineTerminateTimeline`** to say "no more" for sure?
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
