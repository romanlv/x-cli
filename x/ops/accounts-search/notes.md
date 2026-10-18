# accounts:search: what the app taught

Explored 2026-10-18 on the `me` context (signed in as @romitch), through the page commands. Read only:
nothing was followed or changed. The start page is the profile `/romitch`.

## Ways to do it in the app

- **Search, People tab** (side nav "Search and explore" -> `/explore`, the `SearchBox_Search_Input`
  combobox, type, Enter -> `/search?q=<query>&src=typed_query` on Top, tab "People" ->
  `&f=user`; the URL opens the same page, and `app.search(query, "people")` does that). Gives: accounts
  matching the query by name, handle and bio, as `UserCell` rows (name, handle, a Follow/Following
  button, a bio cut to two lines), 20 per call, more on scroll. The call behind it carries exact counts,
  id and `relationship_perspectives`. Lacks: nothing the intent needs; the DOM rows lack counts, so
  the op reads the response. Picked.
- **Search, Top tab**: mixes posts with a few accounts. Not a list of accounts.
- **Search, Lists tab / Latest / Media**: lists, posts, media. Not accounts.
- **Search box typeahead dropdown** (`search/typeahead.json`, `result_type=users`): the few accounts
  X suggests while typing, unpaged, v1.1, no counts. Less than the People tab.
- **The sidebar "Search filters"** (on any results page: "From anyone" / "People you follow",
  "Anywhere" / "Near you"): narrows the results. Not needed; the person's query is searched as typed.
  Not tried (it would change the page's URL parameters, not the account).
- **Who to follow** (sidebar / `/i/connect_people`): X's suggestions, not matched to a query. A different
  list (R-0009).
- **Advanced search** (link under the filters): builds a post query. Not accounts.
- **A profile's Following / Followers**: only one account's edges. Not a search by value.

Picked: search's People tab, read through its `SearchTimeline` call. It is X's own matching, so the op
matches nothing itself.

## Screens and waits

- `/search?q=…&src=typed_query&f=user`: title "<query> - Search / X", tabs Top, Latest, People, Media,
  Lists (role tab), rows `data-testid=UserCell` (`button`). **The "Who to follow" sidebar has `UserCell`
  too**: never read the DOM by that testid; read the `SearchTimeline` response.
- Typing in `SearchBox_Search_Input` and pressing Enter lands on Top (`product: "Top"`); a click on the
  tab People makes a second `SearchTimeline` with `product: "People"`. Opening `&f=user` directly makes
  only the People one, so the op goes by URL.
- A query that matches nobody ("zzqxv9k_nomatch_77"): the page shows `empty_state_body_text` ("Try
  searching for something else, or check your [search settings] to see if they're protecting yo…"); no
  `UserCell` rows.

## The call behind it

`GET /i/api/graphql/<queryId>/SearchTimeline?variables=…&features=…` (queryId `irezafrnzav4Ulf1vDkEBg`
today; it rotates; the same operation as Latest and Top). `variables`: `rawQuery`, `count: 20`,
`querySource: "typed_query"`, `product: "People"` (Top / Latest / Media for the other tabs),
`withGrokTranslatedBio: true`; scrolling adds `cursor`. It is at
`data.search_by_raw_query.search_timeline.timeline.instructions[]`: the first page has
`TimelineClearCache` and one `TimelineAddEntries` of 20 `user-<id>` items plus `cursor-top-…` and
`cursor-bottom-…`; later pages only `TimelineAddEntries`.

- **Same user shape as the follow lists**: `user_results.result` has `rest_id`, `core.{name,screen_name,
  created_at}`, `profile_bio.description`, `relationship_counts.{followers,following}`,
  `tweet_counts.{tweets,media_tweets}`, `action_counts.favorites_count`, `privacy.protected`,
  `is_blue_verified`, `location`, `avatar`, `banner`, and `relationship_perspectives` with `following`,
  `followed_by`, `blocking`, `blocked_by`, `muting` (plus `live_following`). Exact counts and
  relationship are therefore there, as on `Following`; nothing is missing.
- `usersPage` (map/graphql.ts) read the response as it came with no change: "machine learning" page 1 and
  page 2 gave 20 + 20 unique users, handle, name, bio, location, exact counts and `relationship` on all,
  `more: true`. Compared with the response by hand; nothing differed. @MLStreetTalk 39597 followers,
  786 following, 5575 posts, both in the response and in the mapped item.
- **Relationship** is the viewer's: searching "dhh" gave @dhh with `relationship.following: true` (the
  row's button said "Following" too), the other 19 `Follow` and `following: false`.
- **No match**: the response is `TimelineClearCache`, `TimelineTerminateTimeline` direction
  `TopAndBottom` and one `TimelineAddEntries` of only the two cursors. `usersPage` gives `items: []`,
  `more: false`. An empty page, not an error.
- **Operators are text on the People tab**: `from:NASA since:2025-01-01` returned 20 accounts whose
  handles or names contain "2025" or "2025…" (@2025000A, @20250107B, …), none of NASA. So `from:`,
  `since:` and the like do not filter accounts; they are matched as words. The spec should say so (a
  query is what a person types as a name; posts operators belong to `posts:search`).
- **Order** is X's relevance (a name match first, then bio and activity), not id order: no `until`.
  The first page ends with `more: true` until X sends a Terminate Bottom; not read to the end (the
  list is long for common words and X paces it).
- **Page size**: 20 users a call here (unlike `Following`, which sends 50 or more). Scrolling near the
  bottom makes the next call with a `cursor`; `app.users("SearchTimeline", …)` takes it like the follow lists.

## What `app` lacks

`app.users(operation, open, bound)` already reads any list call through `usersPage`. For this op it is
`app.users("SearchTimeline", () => app.search(query, "people"), { limit })`: `app.search` takes the tab
`people`. Nothing to add. One caution: opening `&f=user` makes only the People `SearchTimeline`, but a
page that clicked from Top has made a Top call first (`product: "Top"`, posts), which `usersPage`
would read as no users; going by URL avoids it.

## Direct way

None: x/authoring.md rules it out. Layers 1 and 2 done; the call is above. `page:fetch` not used.
