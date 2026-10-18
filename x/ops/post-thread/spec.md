# post:thread

A post and the conversation around it, as a person sees it on `x.com/<handle>/status/<id>`. That
means the post in full: its author with account id, handle and name, the whole text, media, links
expanded, the quoted post, and exact counts of replies, reposts, quotes, likes, bookmarks and views.
Above it come the posts it replies to, oldest first from the conversation's root. Under it come the
replies, up to a limit.

The caller is an agent that reads the person's X to find relevant posts and accounts. So every post
and every author comes with its id, the counts are exact, and `--json` carries everything. The text
view is for a person reading in a terminal.

X can count replies on a post and show none of them, or fewer than it counts. The caller needs to
tell "there are no replies" from "there are N that X won't show, and why", in `--json` as in text.
So when X folds replies away behind a button a person can press, the op presses it and reads them,
marked with X's heading for them. When X shows fewer than it counts and the page gives no way to
read the rest, the op says so, with X's reason when X gives one. It never says both `no replies`
and "raise --limit", and `more` means only that a larger `--limit` or more scrolling would read more.

## The way in X

**The post's page**, `/i/status/<id>`, which X redirects to `/<handle>/status/<id>`, so an id alone
opens it. It is the page a person reaches by clicking a post in any timeline. The op opens it with
`app.thread(id, { limit })` and reads the `TweetDetail` calls the page makes: `threadOf` maps the
first call and `moreRepliesOf` the ones scrolling makes. There is no direct way (x/authoring.md).

- The page first calls `TweetResultByRestId` (the post alone), then `TweetDetail` (`focalTweetId`,
  `rankingMode: "Relevance"`). The first `TweetDetail` holds the ancestors, the post, and one
  `conversationthread-<id>` module per reply group, ranked by X. It ends with a `Bottom` cursor.
  On @NASA's 2110823965954637903 (76 replies), that was 39 modules, 3 of them ads, so 36 replies.
- Scrolling near the bottom makes a second `TweetDetail` with that cursor. It brings about 8 more
  groups and a `ShowMoreThreads` cursor: a fold (below). Without opening it a read gets about 44 of
  those 76 replies: `--limit 60` returned 43 after 10 scrolls, in about 35 s. On that post the fold
  left after scrolling was "Show probable spam".
- **A fold is a button a person can press.** X holds some replies back under a `ShowMoreThreads`
  cursor, which the page draws as a button whose text is the cursor's
  `displayTreatment.actionText`. The one seen is "Show probable spam": X's own quality filter, the
  module's `conversationSection` is `LowQuality`. "Show additional replies" would be the same cursor
  with other text; it has not been seen on a real page.
- **The op presses it** when scrolling has nothing left to ask for (no Bottom cursor) and the limit
  has room: the button in `primaryColumn` by its role and exact name, scrolled into view, after a
  person's pause (2 to 6 s), one press per fold and at most 2 folds a read. The press only opens the
  fold: there is no confirmation and nothing changes. It makes one `TweetDetail`, the same variables
  plus `cursor` (the fold's) and `referrer: "tweet"`, which answers a `TimelineLabel` ("Probable
  spam", drawn as a heading), the replies as modules and `TimelineTerminateTimeline` Bottom, the end.
  The op reads those replies and marks their groups with `section`. If the button can't be found
  after one more scroll, or no `TweetDetail` comes in 15 s, the op stops there and reports the
  replies as `unshown`, with the fold as the reason.
- On 2111179364872466706 (@NASA, "@GampSairy @NASAHubble Oh yeah 😎", 1 reply counted), the first
  `TweetDetail` has the ancestors and the post, no reply module, no Bottom cursor and only the
  "Show probable spam" cursor: the page shows no reply but that button. Pressed, the one reply
  (@Ryanlucyphone1) is under a "Probable spam" heading. X says nothing more about why.
- On the 76-reply NASA post, `--limit 120` read 68 replies in about 53 s, after scrolling and one
  press of "Show probable spam", with `more: false`. X ended the replies and its calls and page say
  nothing of the other 8, so they are `unshown` with no reason.
- Only the first call carries the ancestors and the post.
- Ads between the replies (`promoted-tweet-…` modules) are left out.

Other ways, and why not:

- **Search `conversation_id:<id>`** (not tried): replies by time, but no ancestors, and search's
  matching rather than the page's own conversation.
- **The post's page without pressing the fold**, as the op did before: a post whose replies are all
  folded came back with none, and `more` though no `--limit` could read them.
- **A profile's Replies tab or `to:<handle>` search**: one account's replies, not one post's.
- **A reply's own page**: reads a folded reply once its id is known, but the id is only in the fold.
- **The DOM of the post's page**: handles but no account ids, rounded counts, and text cut by "Show
  more". The `TweetDetail` response has ids, exact counts and full text.

## Inputs

| Flag | Type | Default | What |
| --- | --- | --- | --- |
| `--post` | string, required | | the post's id (digits), or a link to it: `x.com/<handle>/status/<id>`, `x.com/i/status/<id>` or `x.com/i/web/status/<id>`, on x.com or twitter.com (`www.` and `mobile.` too), with any query or fragment. The handle in a link is only a snapshot: the op keys by the id. Anything else is `InputError` |
| `--limit` | integer, 1 to 200 | 20 | at most this many replies. Every post under the post counts, in X's order, folded ones too. A fold is opened only while the limit has room |

There is no `until`. The replies come in X's ranking, which differed between two loads of the same
post, not in id order, so a later read has nothing to stop before.

Nothing differs between contexts. What one account may see can differ, such as a blocked account's
posts. Whether X folds a reply for another account has not been checked: this one does not follow
@NASA.

## Output

`Thread` from `model.ts`. `threadOf` read @NASA's post exactly, confirmed 2026-10-18 (knowledge/x.md).

- `focal`: the post (`kind: "post"`). It has its id, its author's account id, handle and name, the
  full text, exact `counts` (`replies`, `reposts`, `quotes`, `likes`, `bookmarks`, `views`), entities
  with `t.co` links expanded, media with alt text, card, poll, `quoted`, `edits`, `viewer`, and
  `replyTo` (post and account ids) when it is a reply. It is never `unavailable` in a result: a post
  that can't be read is `PreconditionError`.
- `ancestors`: the posts it replies to, oldest first, root first. When the post is 2/ of its
  author's own thread, the 1/ is an ancestor. A post above it that can't be read would be an
  `unavailable` entry, not an error (not seen yet).
- `replies`: the reply groups in X's order. On the posts read, each group held one direct reply. A
  reply's own replies were not inside its group: they are only on that reply's page. A group of the
  author's own continuation would have `selfThread: true`, and one with replies folded under it
  would have `more: true`; neither has been seen yet. **`limit` counts posts**, every post of every
  group. When the limit falls inside a group, the group is cut there and gets `more: true`. A reply
  that can't be read is an `unavailable` entry and counts.
- `more`: true only when raising `--limit`, or scrolling, would read more replies: `limit` cut them,
  the scrolls ran out, or a fold is still closed because the limit was reached first. False when X
  ended the replies, with `TimelineTerminateTimeline` Bottom. X sends a Bottom cursor on the last page
  too, so the cursor alone doesn't mean more. A fold the op could not press is not `more`.
- `folded`: with `more`, the text of the button X left closed ("Show probable spam"; empty when X gives
  none), so a caller knows a larger `--limit` opens it. Absent once the op has pressed it.
- `unshown`: `{ count, reason? }`, only when `more` is false and X counts more replies on the post
  (`focal.counts.replies`) than the read holds direct replies to it (posts whose `replyTo.post` is the
  post, and unavailable entries), folds included: `count` is the difference. `reason` is set only
  from what X gives: a fold the op could not open (`X folds them under "Show probable spam", which
  could not be opened`). A counted reply in no fold has not been seen; X's page and calls named
  nothing for the 8 on the NASA post, so the op gives no reason and does not guess one. This is how a
  caller tells "no replies" (`replies: []`, no `unshown`, no `more`) from "N that X won't show".
- A group read from a fold has `section`, the heading X draws over it ("Probable spam").
- `conversationId`: the root post's id.

`--json` prints this `Thread` whole.

### Printed (without `--json`)

`threadText` in `model.ts`, with blocks separated by a rule:

- `↑ <n> above, oldest first`, then each ancestor as `entryText` cuts it.
- `▶ the post`, then the post in the layout of a list post (`posts:search`'s spec): the header, the
  whole text (wrapped, never cut, links expanded as there), then each media item with its URL and alt
  text, the card's title, a poll's options, the quoted post cut as in a list, one counts line with the
  rounded numbers and, besides a list post's counts, its quotes and bookmarks
  (`143 replies · 209 reposts · 24 quotes · 1526 likes · 62 bookmarks · 355.7K views`), and the link.
  There is no `post <id> · author <id>` line: the ids are in `--json`.
- `↓ <n> replies, in X's order` (`1 reply`), then each reply as `entryText` cuts it. An author's continuation
  starts with `the author continues`; a group read from a fold is preceded by `under X's "Probable
  spam" fold`. A post with no replies counted prints `no replies`, and only then.
- When X counts replies it shows none of: `X counts 1 reply on this post and shows none of them; X
  gives no reason` (or `shows 3`, and `: <reason>` when X gave one). Never `no replies`.
- When `more` is true, a closing line: `more replies than these: raise --limit, or see the post on
  x.com`, or with `folded`: `more replies than these, folded under "Show probable spam": raise
  --limit to open it, or see the post on x.com`.

## Done in X

Open `https://x.com/i/status/<id>`.

- The op's post has the text, media and quote shown on the page.
- Its counts equal the labels of the buttons: `reply` gives replies, `like` gives likes, and the
  `retweet` button's count is the op's reposts plus quotes (167 = 157 + 10 on the NASA post). The
  views link rounds them ("381.6K Views" for 381,656).
- The ancestors are the posts drawn above it.
- The replies are the posts drawn under it, ads aside, in the page's order. That order can change
  from one load to the next.
- A fold: on `https://x.com/i/status/2111179364872466706` the page shows no reply, only the button
  "Show probable spam". Pressed, it shows a "Probable spam" heading and one reply by @Ryanlucyphone1:
  the op's one reply, with `section: "Probable spam"`, `more: false` and no `unshown`.
- `unshown.count` is the `reply` button's count less the direct replies drawn, folds opened.

Nothing is posted, liked, reposted, followed or bookmarked. The reply box is never touched. The only
button pressed is a fold's ("Show additional replies", "Show probable spam"), which opens replies a
person could read.

## Errors

- `InputError` (exit 2): `--post` is not an id or a link to a post, or the limit is out of range.
- `PreconditionError` (exit 3): there is no such post. The page says "Hmm...this page doesn't
  exist." and `TweetDetail`'s `tweet_results` is empty, so the op says `no post <id>`. A post that
  can't be read, because it was deleted, its account is suspended or protected, or it is withheld,
  is worded with the mapper's reason and X's message (not seen on a real page yet).
- `RefusedError` (exit 4): X's rate limit or a locked account, including the `Viewer` 429 that
  leaves the page blank, or a read stopped at a tenth of the budget with nothing read. Never retried.
- A challenge or the login page mid-run stops the op, for the person to clear by hand.
