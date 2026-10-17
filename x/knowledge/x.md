# X: what holds for every op

What one op learned about X that holds for others goes here; what holds for one op stays in its
`notes.md`. Every build and repair reads this file. Entries marked _(unconfirmed)_ come from general
knowledge of x.com and have not been checked against a real account yet: confirm or correct each
one the first time an op relies on it.

## Accounts and contexts

- A context is an X account. Its URL is `https://x.com/<handle>`, so the sign-in check refuses a
  saved session signed in as anyone else; plain `https://x.com` takes whichever account signs in.
- A person signs in by hand in the window (`x context:login <name>`). There is no username and
  password sign-in: X challenges automated logins.
- What is particular to one account (its lists, who it follows) goes in `tenants/<context>.md`.

## Pages _(unconfirmed)_

| What | URL |
| --- | --- |
| home timeline | `/home` |
| search | `/search?q=<query>&src=typed_query` plus `&f=live` (Latest), `&f=user` (People), `&f=media` |
| a profile | `/<handle>`; replies at `/<handle>/with_replies`, media at `/<handle>/media` |
| a post and its replies | `/<handle>/status/<id>` |
| bookmarks | `/i/bookmarks` |
| lists | `/<handle>/lists`, a list at `/i/lists/<id>` |
| notifications | `/notifications`, mentions at `/notifications/mentions` |

## Controls _(unconfirmed)_

X marks controls with `data-testid`; class names are generated and change every release.

| testid | What |
| --- | --- |
| `SideNav_AccountSwitcher_Button` | the account menu in the side nav; its text holds `@handle`. Signed in |
| `loginButton`, `login` | sign-in buttons on a signed-out page |
| `primaryColumn` | the main column every page has |
| `tweet` (an `article`) | one post in a timeline |
| `tweetText` | a post's text |
| `User-Name` | a post's author: display name, `@handle`, time |
| `reply`, `retweet`, `like` | a post's buttons; the counts are in their `aria-label` ("12 Likes. Like") |
| `emptyState` | a timeline with nothing in it |
| `toast` | a passing message, such as a rate limit |
| `error-detail` | a timeline's error in place of posts ("Something went wrong") |

- Timelines are virtualised: only the posts near the viewport are in the DOM, so reading a timeline
  means scrolling and collecting (`wd.posts`), keyed by the post's URL.
- A post's permalink is the `a` around its `time`; `time[datetime]` is ISO 8601.

## The calls behind the pages

The web app reads through GraphQL: `GET /i/api/graphql/<queryId>/<Operation>?variables=…&features=…`
(`SearchTimeline`, `UserByScreenName`, `UserTweets`, `TweetDetail`, `Bookmarks`, `ListLatestTweetsTimeline`).
Each call carries a signature (`x-client-transaction-id`) the app computes, and query ids rotate
with X's releases, so ops read these responses as the page receives them (`wd.graphql`) and never
send their own (`authoring.md`). Every response has `x-rate-limit-limit`, `-remaining` and `-reset`.

## Staying under X's limits

`bot-detection.md` is the research, with sources and dates; its ranked recommendations are what this
tool follows. In short: the person signs in by hand; installed Chrome, not Playwright's Chromium
(`x/main.ts` sets it, falling back when Chrome isn't installed); one request at a time
(`XCLI_MAX_RUNNING=1`); a person's pace; the page's own calls only; rate limits and locks stop the
op and are never retried.
