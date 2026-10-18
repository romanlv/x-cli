# X: what holds for every op

What one op learned about X that holds for others goes here; what holds for one op stays in its
`notes.md`. Every build and repair reads this file. Entries marked _(unconfirmed)_ come from general
knowledge of x.com and have not been checked against a real account yet: confirm or correct each
one the first time an op relies on it.

`data-model.md` is what ops return and take (`x/model.ts`): posts, reposts, unavailable posts,
accounts, pages and threads, with where each field comes from in the DOM, GraphQL and API v2. Its
shapes are unconfirmed too; the first op that uses a mapper confirms it, in "The calls behind the
pages" below.

## Accounts and contexts

- A context is an X account. Its URL is `https://x.com/<handle>`, so the sign-in check refuses a
  saved session signed in as anyone else; plain `https://x.com` takes whichever account signs in.
- A person signs in by hand in the window (`x context:login <name>`). There is no username and
  password sign-in: X challenges automated logins. X refused ("We've temporarily limited your
  login") a sign-in in a Chrome that Playwright started, and in one with a debugging port core
  attached to, but not in Chrome started by hand (2026-10-17). So the window is the installed Chrome
  started as itself, with nothing watching it, on a profile kept in `.state/contexts/<name>/browser`;
  core reads the sign-in from that profile once the person says they are done.
- What is particular to one account (its lists, who it follows) goes in `contexts/<context>.md`.

## Pages

Search (Latest), a profile and a post's page are **confirmed** (2026-10-18); the rest are not yet.

| What | URL |
| --- | --- |
| home timeline | `/home` |
| search | `/search?q=<query>&src=typed_query` plus `&f=live` (Latest), `&f=user` (People), `&f=media` |
| a profile | `/<handle>`; replies at `/<handle>/with_replies`, media at `/<handle>/media` |
| a post and its replies | `/<handle>/status/<id>`; `/i/status/<id>` redirects there, so an id alone is enough |
| bookmarks | `/i/bookmarks` |
| lists | `/<handle>/lists`, a list at `/i/lists/<id>` |
| notifications | `/notifications`, mentions at `/notifications/mentions` |

## Controls

X marks controls with `data-testid`; class names are generated and change every release. Seen on
this account (2026-10-18): `SideNav_AccountSwitcher_Button`, `SearchBox_Search_Input`, `tweet`,
`reply`, `retweet`, `like`, `bookmark`, `caret`, the analytics link, and `AppTabBar_*_Link` in the
side nav. The rest are from secondary sources.

| testid | What |
| --- | --- |
| `SideNav_AccountSwitcher_Button` | the account menu in the side nav; its text holds `@handle`. Signed in |
| `loginButton`, `login` | sign-in buttons on a signed-out page |
| `primaryColumn` | the main column every page has |
| `cellInnerDiv` | one row of a timeline: a post, or a tombstone ("This Post was deleted…") in its place |
| `tweet` (an `article`) | one post in a timeline |
| `tweetText` | a post's text; `tweet-text-show-more-link` when it is cut short |
| `User-Name` | a post's author: display name, `@handle`, time; an embedded quote has its own |
| `UserName` | a profile's name and `@handle` above its timeline; `profile()` waits for it or "This account doesn't exist", which X draws after the main column |
| `socialContext` | the line above a post: "Ada reposted" (a repost, linking to the reposter), "Pinned" |
| `reply`, `retweet`, `like`, `bookmark` | a post's buttons; the counts are in their `aria-label`, exact even where the screen rounds ("1407 Likes. Like" under "1.4K"), 0 included ("0 Replies. Reply"); `retweet`'s counts reposts and quotes together; `bookmark`'s is just "Bookmark" **[confirmed 2026-10-18]** |
| `unretweet`, `unlike`, `removeBookmark` | the same buttons when the signed-in account has reposted, liked or bookmarked it |
| `div[role=group]` (no testid) | a post's action bar around the buttons; its `aria-label` names the counts in full: "3 replies, 5 reposts, 152 likes, 175 bookmarks, 45025 views" (secondary sources, data-model.md) |
| `placementTracking` | wraps an ad's `article` (an ad is the article inside one); a post's video has one inside the article too (typefully/minimal-twitter) |
| `emptyState` | a timeline with nothing in it |
| `toast` | a passing message, such as a rate limit |
| `error-detail` | a timeline's error in place of posts ("Something went wrong") |

- Timelines are virtualised: only the posts near the viewport are in the DOM, so reading a timeline
  means scrolling and collecting (`app.posts`), keyed by the post's id.
- A post's permalink is the `a` around its `time` (`/<handle>/status/<id>`); `time[datetime]` is ISO
  8601. Views are in the aria-label of the `a` to `…/analytics`.
- The DOM shows no account ids and no repost ids, and splits no quotes from reposts: an op that
  needs those reads GraphQL. Its counts are exact: `app.posts` matched GraphQL to the unit on
  @NASA's posts (2026-10-18), with `repostsAndQuotes` where GraphQL has `reposts` and `quotes`.

## The calls behind the pages

The web app reads through GraphQL: `GET /i/api/graphql/<queryId>/<Operation>?variables=…&features=…`
(`SearchTimeline`, `UserByScreenName`, `UserOriginalsTimeline`, `TweetDetail`, `Bookmarks`,
`ListLatestTweetsTimeline`). Seen on this account (2026-10-18): search's Latest tab calls
`SearchTimeline`; a profile calls `UserByScreenName`, and its Posts tab `UserOriginalsTimeline`, not
`UserTweets` as the open-source clients say; a post's page calls `TweetDetail` (and
`TweetResultByRestId` first). `map/graphql.ts` reads all four as they came: `postsPage`,
`userFromResult`, `threadOf`. A page also makes dozens of calls of its own (badge counts, Grok,
sidebars), and loads over a hundred scripts through its service worker, which `page:requests`
leaves out.
Each call carries a signature (`x-client-transaction-id`) the app computes, and query ids rotate
with X's releases, so ops read these responses as the page receives them (`app.graphql`) and never
send their own (`authoring.md`). Every response has `x-rate-limit-limit`, `-remaining` and `-reset`.
Where each operation puts its timeline is in data-model.md; `map/graphql.ts` reads them all.

Confirmed against this account: none yet. The first op that reads an operation through a mapper
adds it here, with the date and what differed from the mapper.

## Staying under X's limits

`bot-detection.md` is the research, with sources and dates; its ranked recommendations are what this
tool follows. In short: the person signs in by hand, in Chrome started as itself; runs in the
installed Chrome without Playwright's automation switch, and one request at a time
(`browserChannel`, `hideAutomation` and `maxRunning` in `x/domain.ts`); a person's pace;
the page's own calls only; rate limits and locks stop the op and are never retried.
