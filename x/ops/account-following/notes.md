# account:following: what the app taught

Explored 2026-10-18 on the `me` context (signed in as @romitch, 121 following), through the page
commands. Read only: nothing was followed, unfollowed or changed.

## Ways to do it in the app

- **A profile's "Following" link** (`/<handle>`, the link "121 Following") opens
  `/<handle>/following`, tabs "Verified Followers", "Followers", "Following" (on other accounts also
  "Followers you know" and "Affiliates"). Gives: every account the profile follows as `UserCell`
  rows (name, handle, bio, a Following/Follow button), for the signed-in account and for any public
  one. Lacks: counts and "follows you" only in the GraphQL behind it, not the rows.
- **The URL `/<handle>/following`** is the same page; loading it directly makes the same calls
  (`UserByScreenName`, then `Following`). The person's way and the op's land on one page.
- **Search, People tab** (`/search?q=…&f=user`): finds accounts by name or handle (it answered
  "dhh" with @dhh marked Following), but has no "followed by X" filter. It matches accounts, not the
  follow edge. Not the intent.
- **Search operators** (`filter:follows`, `from:`): posts from people the signed-in account follows,
  not the accounts, and not another account's follows. Not the intent.
- **Tabs "Followers" / "Verified Followers" / "Followers you know"**: the other direction
  (`account:followers`, a follow-up). Not this op.
- **Lists** (`/<handle>/lists`): an account's own grouping, not who it follows.

Picked: the profile's Following page, read through its `Following` call. It is the only way that
lists the follow edge of any public account, and X orders and pages it.
`--handle` filters nothing by value (no search for a value is needed), so there is no search to prefer.

## Screens and waits

- Start page is the profile `/romitch`. `link "121 Following"` (no testid) is there; click it, the
  page becomes `/romitch/following`, title "People followed by Roman (@romitch) / X", tab "Following"
  selected. `/NASA/following` direct: title "People followed by NASA (@NASA) / X".
- Rows are `data-testid=UserCell` (a `button` on the list). **The "Who to follow" sidebar has
  `UserCell` listitems too** (with a "Follow @x" button, testid `<id>-follow`): never read the DOM
  by `UserCell` alone. The op reads the `Following` response, not the DOM.
- The signed-in account's handle: `SideNav_AccountSwitcher_Button` text holds `@handle`; the me
  context has no handle written down.
- A handle that does not exist: `/this_handle_does_not_exist_zz9/following` is a "Page not found / X"
  page with no `Following` call at all (only the HTML). Go through `app.profile(handle)`, which turns
  "This account doesn't exist" into `PreconditionError`, before opening the list.
- A protected account the viewer does not follow: not reached (no known protected account to open
  without guessing; none is in the contexts). _(unconfirmed)_ Expected: the profile loads, the list
  is empty or an error shows in place of rows; the op must tell that from an empty follow list
  (`protected: true` and `relationship.following` not true -> `PreconditionError`).

## The call behind it

`GET /i/api/graphql/<queryId>/Following?variables=…&features=…` (queryId was `ath0FIohYC_c3Hj3SsxoCg`
today; it rotates). `variables`: `userId` (the profile's rest id), `count: 20`,
`includePromotedContent: false`, `withGrokTranslatedBio: true`; scrolling adds `cursor`
(`"<n>|<n>"`). `userId` comes from `UserByScreenName` (`screen_name`), which the page calls first.
The page also made `GET /i/api/1.1/friends/following/list.json?…&count=3&with_total_count=true`
once (a v1.1 call for a few rows); the list does not use it.

Response: `data.user.result.timeline.timeline.instructions[]`; the first page has
`TimelineClearCache`, `TimelineTerminateTimeline` (direction Top) and one `TimelineAddEntries`; later
pages only `TimelineAddEntries`; the last also has `TimelineTerminateTimeline` direction Bottom.
Entries are `user-<id>` (`TimelineTimelineItem`, `itemContent.__typename` `TimelineUser`,
`user_results.result.__typename` `User`) plus `cursor-top-…` and `cursor-bottom-…`.
`user_results.result` carries `rest_id`, `core.{name,screen_name,created_at}`,
`profile_bio.description`, `relationship_counts.{followers,following}`, `tweet_counts`,
`action_counts.favorites_count`, `privacy.protected`, `is_blue_verified`, `avatar`, `banner`,
`relationship_perspectives.{following,followed_by,blocking,blocked_by,muting}`,
`follow_request_sent`.

- **X sends more than `count`**: count 20 returned 50 users on @romitch's pages and 67 on NASA's
  first. The pages were 50, 50 and 21 users = 121, the profile's count. No duplicates.
- **Order**: not by user id. Entry `sortIndex` descends and the user ids are not monotonic (probably newest
  follow first; not checked against a follow date, which X does not send), so no `until`.
- The last page: `TimelineTerminateTimeline` Bottom, `cursor-bottom` value `0|…`; `usersPage` gives
  `more: false` there and `more: true` on the first two.

`usersPage` / `readTimeline` read the three pages as they came: 121 users, handle, name, bio, counts
(exact) and `relationship` on all; nothing differed, nothing to fix in the mapper. On @romitch's
list `relationship` was following true for all 121 and followedBy true for 2: "follows me back"
reads off the output.

## What `app` lacks

`app.timeline(operation, open, bound)` returns `XPage<Entry>`: it keeps only posts (`isEntry`) and
`gather` keys and orders entries. The op needs the same loop for accounts: a helper
(`app.users`) that listens for `Following` (or any `Followers`, `ListMembers`), reads each response
with `usersPage`, stops at `limit`, at the end, at the budget (tenth of `x-rate-limit-limit`) or at
`scrolls`, scrolling a person's pace like `timeline`. `Followers` and `BlueVerifiedFollowers` share
it, so it is a helper, not code in this op.

## Direct way

None: x/authoring.md rules it out. Layers 1 and 2 done; the call is above. `page:fetch` not used.

## Built (op.ts) 2026-10-18

Tried as a caller on `me`:

- `--limit 5`: 5 accounts, lauren @poteto first, as the page's first row; `more: true`.
- `--handle NASA --limit 30`: 30, unique, @NASAHubble first (the page's first row), `more: true`.
- `--limit 200`: 121 unique, `more: false`, = the profile's "121 Following"; `followedBy` true for 2
  (@rekdaus, @LeavingCda).
- `--handle zz9qxk_nope_77`: exit 3 "no account @zz9qxk_nope_77" (from `app.profile`). A handle over 15
  characters or with other characters is exit 2. `--limit 500`: exit 2, "--limit must be <= 200".
- The protected-account branch (`app.follows` looks for "these posts are protected" on the profile,
  then for the link) is written from what X shows on a protected profile and is unconfirmed: no
  protected account was reached.
- Helpers added: `app.users` (the accounts of a list call, bound by `limit` and `scrolls`),
  `app.follows` (profile, then the count link), `app.me` (`signedInHandle`, moved from domain.ts).

## Repaired 2026-10-18: a rate-limited start page

Verify's third example (`--limit 200`) failed before the op ran: exit 3, "could not tell whether
"me" is signed in: https://x.com/romitch showed neither x's pages nor a sign-in". Reproduced: in a
fresh browser on the saved sign-in, X answered the `Viewer` call every page load makes with 429, and
the page stayed blank (no side nav, no main column, no message) for 15 s. The exploring session's page,
loaded long before, was fine. The limit came from the builder's ~30 runs in ten minutes, each a fresh
browser, and it had reset ten minutes later. The op was not at fault. The fault was core calling X's
refusal a precondition:
- `x/domain.ts` `prepareBrowser` now keeps each page's last 429 from X's GraphQL (`watchLimits`,
  in `limitsOf`'s words), and `refusal` reports it when the page shows no main column
  (`refusedLoad`).
- `core/browser.ts`: a sign-in check that can't tell asks the domain's `refusal` before calling the
  page unknown, so that case is exit 4 with when it resets.

Afterwards, as a caller: `--limit 200` 121 unique, `more: false`, followedBy @rekdaus and
@LeavingCda; `--limit 5` @poteto, @gavinpurcell, @theo, @dhh, @0xblacklight, `more: true`, the
first five rows of `/romitch/following`; `--handle NASA --limit 30` 30 unique, @NASAHubble,
@NASAWebb, @Space_Station, @esa, @NASAArtemis first, the page's rows, each "Follow" and
`following: false`. `--handle @`, `--handle bad!handle`, `--limit 500`, `--limit 0`: exit 2.
`--handle zz9qxk_nope_77`: exit 3.
