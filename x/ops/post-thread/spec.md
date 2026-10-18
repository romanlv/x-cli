# post:thread

A post and the conversation around it, as a person sees it on `x.com/<handle>/status/<id>`. That
means the post in full: its author with account id, handle and name, the whole text, media, links
expanded, the quoted post, and exact counts of replies, reposts, quotes, likes, bookmarks and views.
Above it come the posts it replies to, oldest first from the conversation's root. Under it come the
replies, up to a limit.

The caller is an agent that reads the person's X to find relevant posts and accounts. So every post
and every author comes with its id, the counts are exact, and `--json` carries everything. The text
view is for a person reading in a terminal.

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
  groups and a `ShowMoreThreads` cursor, which X draws as the button "Show additional replies". The
  op never presses it. So a read gets about 44 of those 76 replies and says `more`: `--limit 60`
  returned 43 after 10 scrolls, in about 35 s.
- Only the first call carries the ancestors and the post.
- Ads between the replies (`promoted-tweet-…` modules) are left out.

Other ways, and why not:

- **Search `conversation_id:<id>`** (not tried): replies by time, but no ancestors, and search's
  matching rather than the page's own conversation.
- **A profile's Replies tab or `to:<handle>` search**: one account's replies, not one post's.
- **The DOM of the post's page**: handles but no account ids, rounded counts, and text cut by "Show
  more". The `TweetDetail` response has ids, exact counts and full text.

## Inputs

| Flag | Type | Default | What |
| --- | --- | --- | --- |
| `--post` | string, required | | the post's id (digits), or a link to it: `x.com/<handle>/status/<id>`, `x.com/i/status/<id>` or `x.com/i/web/status/<id>`, on x.com or twitter.com (`www.` and `mobile.` too), with any query or fragment. The handle in a link is only a snapshot: the op keys by the id. Anything else is `InputError` |
| `--limit` | integer, 1 to 200 | 20 | at most this many replies. Every post under the post counts, in X's order |

There is no `until`. The replies come in X's ranking, which differed between two loads of the same
post, not in id order, so a later read has nothing to stop before.

Nothing differs between contexts. What one account may see can differ, such as a blocked account's
posts.

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
- `more`: true when replies were left out, whether `limit` cut them, the "Show additional replies"
  section holds more, or the scrolls ran out. False when X ended the replies, with
  `TimelineTerminateTimeline` Bottom. X sends a Bottom cursor on the last page too, so the cursor
  alone doesn't mean more.
- `conversationId`: the root post's id.

`--json` prints this `Thread` whole.

### Printed (without `--json`)

`threadText` in `model.ts`, with blocks separated by a rule:

- `↑ <n> above, oldest first`, then each ancestor as `entryText` cuts it.
- `▶ the post`, then the post in full. This shows the header, a line `post <id> · author <account
  id>` (with `· replies to <id>` when it is a reply), the whole text, each media item with its URL and
  alt text, each expanded link, the card's title, a poll's options, the quoted post with its id and
  text, and one line of exact counts with thousands separators.
- `↓ <n> replies, in X's order`, then each reply as `entryText` cuts it. An author's continuation
  starts with `the author continues`. A post with no replies prints `no replies`.
- When `more` is true, a closing line: `more replies than these: raise --limit, or see the post on
  x.com`.

## Done in X

Open `https://x.com/i/status/<id>`.

- The op's post has the text, media and quote shown on the page.
- Its counts equal the labels of the buttons: `reply` gives replies, `like` gives likes, and the
  `retweet` button's count is the op's reposts plus quotes (167 = 157 + 10 on the NASA post). The
  views link rounds them ("381.6K Views" for 381,656).
- The ancestors are the posts drawn above it.
- The replies are the posts drawn under it, ads aside, in the page's order. That order can change
  from one load to the next.

Nothing is posted, liked, reposted, followed or bookmarked. The reply box is never touched, and
"Show additional replies" is never pressed.

## Errors

- `InputError` (exit 2): `--post` is not an id or a link to a post, or the limit is out of range.
- `PreconditionError` (exit 3): there is no such post. The page says "Hmm...this page doesn't
  exist." and `TweetDetail`'s `tweet_results` is empty, so the op says `no post <id>`. A post that
  can't be read, because it was deleted, its account is suspended or protected, or it is withheld,
  is worded with the mapper's reason and X's message (not seen on a real page yet).
- `RefusedError` (exit 4): X's rate limit or a locked account, including the `Viewer` 429 that
  leaves the page blank, or a read stopped at a tenth of the budget with nothing read. Never retried.
- A challenge or the login page mid-run stops the op, for the person to clear by hand.
