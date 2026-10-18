# suggestions:list: what the app taught

Explored 2026-10-18 on the `me` context (signed in as @romitch, 121 following), through the page
commands. Read only: nothing was followed, dismissed or changed. The start page is `/romitch`.

## Ways to do it in the app

- **The Connect page, `/i/connect_people`** (title "Follow / X"; tabs "Who to follow" and "Creators
  for you"; heading "Suggested for you"). Gives: the fullest list, 100 accounts in one call, each a
  `UserCell` with name, handle, bio and a Follow button; the GraphQL behind it carries exact counts,
  ids and the viewer's relationship. Lacks: a reason (see below), and it is not stable between loads.
- **The "Who to follow" sidebar** (right column on every page, `UserCell` listitems with a
  `<id>-follow` button and a "Show more" link to the Connect page). Gives: 3 accounts
  (`SidebarUserRecommendations`, `variables.profileUserId` is the viewer's own id). Lacks: everything
  the Connect page has, and 97 accounts. Not enough.
- **The "Creators for you" tab** on the Connect page: 20 accounts picked as creators
  (`ConnectTabTimeline` with `context: {"isCreatorOnlyConnectTab":true}`, entry
  `creators-only-connect-tab-0`). A different list, a subset of the intent's "who X suggests I follow";
  not read by this op.
- **Search's People tab** (`/search?q=…&f=user`): accounts matching a word, not X's suggestions for
  this account. Not the intent.
- **A profile's "Following"/"Followers" tabs** ("Followers you know"): the follow edge, not suggestions.
- **The home For you timeline** has "Who to follow" modules among its posts (`who-to-follow…` entries,
  dropped by `readTimeline`'s NOISE): a few accounts at an unpredictable place. Not the intent.

Picked: **the Connect page, "Who to follow" tab**, read through its `ConnectTabTimeline` call. It is the
fuller list and the sidebar's "Show more" leads to it. No value is searched for, so no search applies.

## Screens and waits

- `page:goto https://x.com/i/connect_people` loads the tab "Who to follow" already selected; no click.
  The first call, `ConnectTabTimeline`, was in by 3 s.
- The DOM is virtualised: 28 `UserCell` buttons were in the page after load though the response holds
  100. Never read the DOM here. The right-hand sidebar adds 3 more `UserCell` listitems (testid
  `<id>-follow`): another list, another call.
- **Scrolling makes no further call.** The response has no cursor and ends the timeline
  (`TimelineTerminateTimeline` TopAndBottom), so 100 is all there is: `more` is false.
- The tab "Creators for you" click makes a second `ConnectTabTimeline`; it must not be clicked by the op.

## The call behind it

`GET /i/api/graphql/<queryId>/ConnectTabTimeline?variables=…&features=…` (queryId `IMQS8zyOjCLnWBkm6wNcQg`
today; it rotates). `variables`: `count: 20` (ignored: X sent 100), `context: "{}"` (a JSON string; the
creators tab sends `"{\"isCreatorOnlyConnectTab\":true}"`). The page also makes `ExploreSidebar` and
`SidebarUserRecommendations` (the sidebar's 3).

Response: `data.connect_tab_timeline.timeline.instructions[]`: `TimelineClearCache`,
`TimelineTerminateTimeline` (TopAndBottom), one `TimelineAddEntries` with ONE entry,
`mergeallcandidatesmodule-2`, a `TimelineTimelineModule` (`header.text` "Suggested for you",
`displayType` Vertical, `clientEventInfo.component` `people_connect_module`) whose `items[]` are
`mergeallcandidatesmodule-2-user-<id>` (`itemContent.__typename` `TimelineUser`, `userDisplayType`
`User`, `user_results.result` a full `User`: `rest_id`, `core`, `profile_bio`, `relationship_counts`,
`tweet_counts`, `relationship_perspectives`, ...). No cursor entries. `usersPage` read it as it came:
100 of 100, exact counts, `more` false (nothing differed, no fixture change needed).

Per item, `itemContent` has only `__typename`, `itemType`, `userDisplayType`, `user_results`; the item's
`clientEventInfo.details.timelinesDetails` has `injectionType: "MergeAllCandidatesModule"` and opaque
base64 `controllerData` / `sourceData` (thrift, no readable text).

## Is there a reason? No

**X gave no reason for any of the 100 suggestions, nor for the sidebar's 3, nor the creators' 20**: no
`socialContext`, no "Followed by", no topic or "Popular in your area" in the response (grepped), and
none in the page text of the cells (bio only). The reason shows on X's *profile* page for an account
("Followed by A, B"), a separate call per account that the op does not make. So the model gets no
reason field now; if X starts sending `socialContext` on a `TimelineUser` it is added then, from that
source. `relationship.followedBy` (does this suggestion follow me) is there and counts as the only
"why" the data has.

## Does the list change between loads? Yes

Two loads 25 s apart: 100 accounts each, **70 in common, a different order** (first load began @p_nawrot,
@simongerman600, @PierrePoilievre; the second @CP24, @p_nawrot, @Tesla). So an example can not name an
account: `examples.json` uses only `limit`, and verify can compare "ways" only on the count and the
shape, not the accounts. A `--limit` cut is of X's order for that load. All 100 were `following: false`.

## Not tried

- Scoping to another account ("similar to @x"): the page has no input for it (the profile's "similar
  accounts" is `SimilarUsers`/profile recommendations, a different call). Not read.
- No direct way (x/authoring.md): the op reads the page's own `ConnectTabTimeline`.
