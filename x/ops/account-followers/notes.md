# account:followers: what X taught

## Survey of the ways (2026-10-18, context `me`)

- **Profile "N Followers" link** (`/<handle>/verified_followers`): lands on the *Verified Followers*
  tab, not the plain list: on @romitch 1 of 12 (@rekdaus), on NASA verified accounts only. Gives
  `BlueVerifiedFollowers`; lacks everyone unverified. The agent wants the plain list.
- **The "Followers" tab** next to it (`/<handle>/followers`, `tab "Followers"`): the plain list, call
  `Followers`. Chosen.
- **"Followers you know"** (tab on other accounts' pages, not on one's own): only followers the viewer
  also follows; lacks the rest.
- **"Affiliates"** tab (NASA): organisation accounts, not followers.
- **Search People** (`/search?f=user`): matches names/bios, can't list who follows an account.
- Profile hover cards, "Who to follow" sidebar: a few suggestions, not the list.

## The way, as done

`page:goto` profile (own: starts at `/romitch`), click link "13 Followers" (e25) → URL
`/romitch/verified_followers`, tabs Verified Followers / Followers / (Following), click tab
"Followers" (e25 there) → `/romitch/followers`, heading "Followers", rows `UserCell` (button), 12 rows.
On other accounts' pages the tabs are Verified Followers, Followers you know, Followers, Following,
Affiliates. The tab's name must be matched exactly ("Followers you know" also contains it).
Rows say "Follows you"; the button says "Follow back" or "Following".

## The calls behind it

- `GET /i/api/graphql/<id>/Followers?variables={"userId","count":20,"includePromotedContent":false,
  "withGrokTranslatedBio":true}&features=…` (query id `stpzFPAIZ2qv8s2lRzPOnQ` today); the verified
  tab makes `BlueVerifiedFollowers` (`1fjk4lmK45a-giaZTubqbg`) first, same shape.
- Response: `data.user.result.timeline.timeline.instructions`: `TimelineClearCache`, Terminate Top,
  Terminate Bottom (on a short last page), `TimelineAddEntries` of `user-<id>` items (as `Following`:
  `relationship_perspectives`, `relationship_counts`, exact counts) plus `cursor-top-…` /
  `cursor-bottom-…` (`0|…` on the last page).
- `usersPage` read it as it came, nothing to fix: @romitch 12 users, all `followedBy` true, `following`
  true for @rekdaus and @LeavingCda, `muting` true for @Careerleaf. NASA: 30 unique, exact counts
  (SpaceX 41919651), `more: true`.
- `callOf("Followers")` does not match `BlueVerifiedFollowers` (the path must be `/Followers?`).
- Also seen: `friends/following/list.json?...count=3` (a v1.1 call the page makes), ignored.

## Order and `until`

`sortIndex` descends but the user ids are not monotonic, so no `until`. On a large account the list
starts with ~20 well-known followers (NASA: @nbaschez, @SpaceX, @NatGeo, @NASAHubble, …) and then
runs newest follow first (a run of 2111…-ids brand-new accounts); on @romitch's small list it is
newest follow first. Rate: no limit hit; X sends ≥20 per page whatever `count`.

## Quirks

- **Count differs**: the profile says 13 followers, the list holds 12 (Terminate Bottom reached): X
  leaves out a follower it no longer shows (probably suspended or deactivated); the list is what
  the page shows, so the op returns 12 and `more: false`.
- Protected accounts: not reached; `app.follows` throws a precondition from the profile's "protected"
  text or a missing link (unconfirmed). The viewer's own long follower list: `--limit 200` on a
  list of 12 ends at the terminate; a long one is cut to `limit`.
- Viewer 429s: the first `page` of this build hit one ("rate limited (Viewer)"); waited for its reset,
  the op then ran. Space the runs out.

## Direct way

None: x/authoring.md rules it out. Layers 1 and 2 done; `page:fetch` not used.

## Built (op.ts) 2026-10-18

Helper change: `app.follows(handle, "followers")` now matches the `…/verified_followers` link too and
then clicks the "Followers" tab. As a caller on `me`: `--limit 200` 12 unique, `more: false`;
`--limit 2` text view; `--handle NASA --limit 30` 30 unique, `more: true`; `--limit 500` and
`--handle bad!handle` exit 2; `--handle zz9qxk_nope_77` "no account" (exit 3).
