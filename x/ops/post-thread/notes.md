# post:thread: what the app taught

Built 2026-10-18 on the `me` context (signed in as @romitch), run through the page commands. The
first op to read `TweetDetail` through `threadOf`.

## Ways to do it in the app

- **The post's page** (`/i/status/<id>`, or a click on a post in any timeline): the post in full, the
  posts above it, the replies under it. Gives everything the intent asks for, in one call
  (`TweetDetail`). Lacks: replies in time order (X's "Relevant" ranking, which varies between loads),
  and the lower-ranked replies, behind "Show additional replies".
- **Search `conversation_id:<id>`** (not tried; from general knowledge): replies by time, but no
  ancestors and no page-level filtering. Not the conversation as the page shows it; kept as an idea
  for a caller who wants a time-ordered read of one conversation.
- **A profile's Replies tab / `to:<handle>` search**: one account's replies, not one post's.
- **The DOM of the post's page** (`page:posts`): handles but no account ids, counts rounded, text
  cut by "Show more". The GraphQL response has ids, exact counts and full text.

Picked: the post's page, read through its own `TweetDetail` calls.

## Screens and waits

- Start page is the profile `/romitch`. `page:goto https://x.com/i/status/<id>` lands on
  `/<handle>/status/<id>` (title: `<Name> on X: "<text>"`). The page has headings "Post" and
  "Conversation", the post as the first `article` (`tweet`), a reply composer ("Post text",
  `tweetTextarea_0`, "Reply" disabled) that is never touched, then one `article` per reply.
  Buttons: `reply`, `retweet`, `like`, `bookmark` with exact counts in their labels ("76 Replies. Reply",
  "167 reposts. Repost" = 157 reposts + 10 quotes), "View quotes", the views link ("381.6K Views").
- **Calls**, in order: `TweetResultByRestId` (the focal post alone), then `TweetDetail` (GET,
  `variables`: `focalTweetId`, `with_rux_injections: false`, `rankingMode: "Relevance"`,
  `includePromotedContent: true`, `withCommunity`, `withBirdwatchNotes`, `withVoice`; the same
  `features` as other operations). Reply sorting is `rankingMode: "Relevance"` and `metadata.scribeConfig.page` is
  `ranked_replies`.
- **TweetDetail's shape**: `data.threaded_conversation_with_injections_v2.instructions`: a
  `TimelineClearCache`, a `TimelineAddEntries` and `TimelineTerminateTimeline` Top (always) and Bottom
  (when there are no more replies). Entries: `tweet-<id>` for each ancestor and then the focal post
  (`tweetDisplayType: "Tweet"`, or `"SelfThread"` when the post is 2/ of its author's own thread),
  then one `conversationthread-<id>` module (`VerticalConversation`) per reply group, then
  `cursor-bottom-…`. A page of the NASA post (76 replies): 39 modules of one post each, 3 of them ads
  (`conversationthread-<id>-promoted-tweet-<id>-<hash>`), so 36 replies, then a `Bottom` cursor.
  `threadOf` read the focal post exactly: counts (157 reposts, 10 quotes, 1,119 likes, 50 bookmarks,
  381,656 views), the photo with its alt text, the mention, the `t.co` link expanded to its target,
  `edits`, `viewer`. Replies carry `in_reply_to_status_id_str` and `in_reply_to_user_id_str`
  (`replyTo.post`, `.user`).
- **More replies need a scroll.** Scrolling near the page's bottom makes a second `TweetDetail`, with
  `cursor` (the Bottom one) and `referrer: "tweet"` in its variables: 8 more modules, a `cursor-top`
  and `cursor-showmorethreads-…`, no focal post, no ancestors. That is the button "Show additional
  replies": a click, never pressed. So a read gets about 44 replies of 76 and says `more`: with
  `--limit 60` the op got 43 after 10 scrolls (about 35 s). `app.thread` keeps each response as it
  comes and counts a scroll idle only at the page's bottom, as `timeline` does.
- **Only the first call has the ancestors and the focal post.** A reply's page (checked on
  2111406695117406494, a reply to the NASA post) has `tweet-<root>`, `tweet-<focal>`, its replies as
  modules; the root is first, so ancestors are oldest first. Sub-replies did not come inside their
  parents' modules in what was read: a reply with `reply_count` 1 was a module of one post, and its
  reply is only on its own page. So "a reply's own sub-replies" are not in the conversation of the
  post below, only one level; `limit` counts the posts that are there.
- **A post that doesn't exist** (2110823965954637000): the page says "Hmm...this page doesn't exist.
  Try searching for something else." with a Search button; `TweetResultByRestId` answers
  `{"data":{"tweetResult":{}}}` and `TweetDetail` has a `tweet-<id>` entry with `tweet_results: {}`
  and a Bottom cursor with the Terminate Bottom. `threadOf` reads that as an unavailable post of
  reason "unknown"; the op says "no post <id>" (exit 3). A deleted, protected or suspended focal post
  has not been seen: the mapper reads a `TweetTombstone` or `TweetUnavailable` into a reason, and the
  op words it from that.
- **`more` was wrong in `threadOf`**: X sends a Bottom cursor on the last page too, with the
  Terminate Bottom, so a post with no replies (or all of them read) came back `more: true`. It now
  follows `ended` as `hasMore` does; test in `tests/x-model.test.ts`.
- The reply order is X's and differs between loads: the same post's first five replies were
  girlquants, Laura, Bellio, Leo, Snekso on one load and girlquants, Bellio, Laura, Leo, Snekso on
  the next. So no id order, no `until`.
- The self-thread: LNGSHOT's post 2111834710901240114 was entry `tweet-…` with display type
  `SelfThread` under its 1/ (`tweet-2111834706245566559`), so the 1/ is an ancestor. A continuation
  by the author under the post arrives as a module whose items are `SelfThread`; the mapper marks the
  group `selfThread: true` (not seen on a real page; the fixture has it).
- Pace: a Viewer 429 stopped the first call of the session ("X: rate limited (Viewer, status 429)"
  with its reset time); one wait for the reset and it ran. The reads were spaced out, one page at a
  time.

## Not seen yet

- A focal or ancestor post that is deleted, protected, withheld or from a suspended account.
- A "Show replies" fold inside a module (`group.more`), a quote of an unavailable post.
- A conversation of the person's own, and a reply from a blocked account.

## Example data

The ancestor example is NASA's own post 2108221043743793212 (2026-10-08, "They're back! Crew-12
splashed down…"), a reply to NASA's own post 2108201013681303933: a large, long-lived account's old
post, with a video, one ancestor and 41 replies (20 read by default). An earlier example, a reply
by a small account, was replaced: it could go away.

## R-0011: replies X counts but shows none of (2026-10-18, `me`)

The request: 2111179364872466706 (@NASA, "@GampSairy @NASAHubble Oh yeah 😎", a reply to a reply, 1 reply
counted) printed `no replies` and `more replies than these: raise --limit`.

### Ways to do it in the app

- **The post's page, as today**: shows the post and no reply, then a button "Show probable spam"
  under the composer. Lacks: the reply, which is under that button.
- **The same page, pressing "Show probable spam"** (picked): a heading "Probable spam" and the one
  reply (`@Ryanlucyphone1`, "@NASA @GampSairy @NASAHubble", 0 replies, 0 likes, 2 views). A person
  reads it that way; the button only opens a fold (a read, like "Show more" on a long post).
- **Search `conversation_id:<id>` / `to:NASA`**: not tried; search leaves out the same low-quality
  replies for most viewers, and it has no ancestors. No reason for the fold either.
- **The reply's own page** (`/i/status/<reply id>`): reads once the id is known, but the id is only
  in the fold, so it adds nothing.

### What X does with it

- The first `TweetDetail` (`rankingMode: "Relevance"`) has `tweet-<ancestor>` ×2, `tweet-<focal>`, then
  **no module**, and `cursor-showmorethreads-<id>` with `content.cursorType: "ShowMoreThreads"` and
  **`displayTreatment.actionText: "Show probable spam"`**, then `TimelineTerminateTimeline` Top only (no
  Bottom cursor). `readTimeline` called that `more` (a ShowMoreThreads cursor, no Bottom, not ended); so
  `more: true` with `replies: []`, and the text said `no replies` too.
- Pressing the button (`getByRole("button", { name: "Show probable spam", exact: true })` in
  `primaryColumn`; no test id, no confirmation) makes **one `TweetDetail`**: the same variables plus
  `cursor` (the ShowMoreThreads value) and `referrer: "tweet"`. It answers `TimelineAddEntries` of
  `label-0` (`TimelineLabel`, `text: "Probable spam"`), `conversationthread-<id>` (a module, its
  `clientEventInfo.details.conversationDetails.conversationSection: "LowQuality"`), a `cursor-top` and a
  `cursor-bottom`, then `TimelineTerminateTimeline` Bottom: the end. The page draws a "Probable spam"
  heading over the reply.
- So **X's reason is its own label**: "Probable spam" (`LowQuality`), given by the heading and the button
  text; X says nothing more (no per-reply reason, no filter name, nothing about who may see it). The
  same page does not say whether it is the same for another viewer; this one is the signed-in
  account's, which does not follow @NASA.
- The "Show additional replies" fold (NASA's 76-reply post) is the same cursor type with another
  `actionText`; the op presses it by the same rule (only when scrolling is done). Not pressed on a
  real page in this build (it would be ~35 s of reads on a big post): the rule is the one proved on
  the spam fold, the button name comes from X's `actionText`.
- Not seen: a reply that is counted but sits in no fold (deleted since, hidden by its author or the
  post's, an account the viewer blocked or muted, limited replies). Nothing in the page or its calls
  would name the reason, so the output says `unshown` with no reason rather than guess.

### Waits and pace

- The button is on the page once `TweetDetail` has arrived; the op scrolls it into view, pauses as a
  person would (2 to 6 s), presses, and waits for the next `TweetDetail` (15 s at most). If the button
  isn't found (scrolled out of a virtualised list), one scroll and a second try; then `unshown` with
  the fold's name as the reason, and no `more`.
- `more` is true only if `limit` was reached before the fold was opened (then `folded` names it) or
  scrolls ran out.

Checked afterwards on the 76-reply NASA post (2110823965954637903, `--limit 120`, ~53 s): after the
scrolls the fold left was also "Show probable spam" (not "Show additional replies"; the earlier note's
button name was a guess). The op pressed it once: 68 replies read, 6 or more of them under the "Probable
spam" section, `more: false`, and `unshown: { count: 8 }` with no reason (76 counted, 68 shown; X's page and
calls say nothing about the 8). So the rule for "Show additional replies" itself is still unseen.

### Verify and the `Viewer` limit (2026-10-18, troubleshooter)

- A verify run failed every post:thread example with exit 4, `rate limited (Viewer, status 429)`,
  and so did the posts:search example that came right after them. The op was not at fault: the
  builder's runs had used up X's page loads (knowledge/x.md, "A rate-limited `Viewer`"). After the
  reset, with the runs spaced out, every example passed without a change to the op.
- On 2108221043743793212 (41 replies counted) the default `--limit 20` filled up before the fold was
  reached: 20 replies, `more: true`, `folded: "Show probable spam"`, and the text closes with
  `more replies than these, folded under "Show probable spam": raise --limit to open it`.
- On the page, 2111179364872466706 shows "1 Reply" and only the button "Show probable spam".
  Pressed, it shows a "Probable spam" heading over @Ryanlucyphone1's reply 2111213769502212255,
  which is the op's one reply with `section: "Probable spam"`, `more: false` and no `unshown`.
