# accounts:suggested

The accounts X suggests the signed-in account follow: its "Who to follow" list on the Connect page.
It sits beside `accounts:search` and was called `suggestions:list` until R-0012; no alias is kept. It is
for an agent reading the person's X to find relevant accounts, so each item is a full `User`, keyed by
its id. It prints like the other account lists (`account:following`, `account:followers`,
`accounts:search`). Read only: nothing is followed or dismissed.

## The way in X

**The Connect page**, `/i/connect_people`, on the tab "Who to follow". The sidebar's "Show more" leads
there, and the page loads with that tab already selected, so the op clicks nothing. The op opens it with
`app.open` and reads it with `app.users("ConnectTabTimeline", …)`. The call the page makes on load
(`count: 20`, `context: "{}"`) carries all 100 suggestions at once, with ids, exact counts and the
viewer's relationship. It has no cursor and ends the timeline, so scrolling adds nothing. There is no
direct way (x/authoring.md). The op takes no value, so no search applies. notes.md has the call's
shape.

Other ways, and why not:

- **The "Who to follow" sidebar** (`SidebarUserRecommendations`): only 3 accounts.
- **The "Creators for you" tab** (the same call with `context: {"isCreatorOnlyConnectTab":true}`): a
  different list of 20 accounts picked as creators. The op never clicks it.
- **The home For you timeline's "Who to follow" modules**: a few accounts at an unpredictable place.
- **Search's People tab**: accounts that match a word (`accounts:search`), not X's suggestions.
- **A profile's Following / Followers tabs**: who follows whom (`account:following`,
  `account:followers`).

## Inputs

| Flag | Type | Default | What |
| --- | --- | --- | --- |
| `--limit` | integer, 1 to 100 | 20 | at most this many accounts; a value outside 1 to 100 is an `InputError` (X offers 100) |

There is no `--handle`: X makes these suggestions for the signed-in account only. There is no `until`
either: the list is in X's order, not by id. Nothing in the input differs between contexts. The output
does: the suggestions and the relationship are the signed-in account's own.

## Output

An account page from `model.ts`, `items` (`User | UserUnavailable`) and `more`, mapped by `usersPage`.
It has no `pinned` and no `cursor`. Those belong to post timelines and mean nothing for accounts, so
R-0012 leaves them out of every account list (`accounts:search`, `accounts:suggested`,
`account:following`, `account:followers`).

- `items`: accounts in X's order, unique by id. Each has id, handle, name, bio, location, exact counts
  (followers, following, posts, likes, media), `protected`, `blue`, `verifiedType`, and
  `relationship` (`following`, `followedBy`, ...), which is the signed-in account's own.
- `more`: true when the read stopped at `limit` with suggestions left, and false at 100 (X ended the
  list).

**Reason.** `reason` (optional, on `User`, in `model.ts` and data-model.md) is X's own words for why it
suggests the account ("Followed by …", a topic), read from a `socialContext` on the `TimelineUser` item
and printed on the line under the name. It is left out when X sends none, and never made up. Today X sends
none: no `socialContext` in the Connect call, the sidebar's call, `ExploreSidebar` or the DOM rows (notes.md),
so no item has one yet. "Followers you know" on a suggestion's profile is a separate call per account
(up to 100 page loads) and is not X's reason, so it is not read. `relationship.followedBy` prints as
"follows you".

**The list changes between loads.** Two loads 25 s apart shared 70 of 100 accounts, in another order.
Examples and checks therefore use only `--limit` and never name an account.

Without `--json` it prints with `usersText`, like the other account lists. That is a block per account:
name, `@handle`, the tags `following` / `follows you` / `protected`, two lines of wrapped bio,
followers · following · posts (rounded from 10,000 up), and the profile link. A rule separates the
blocks, and `<n> accounts · more: raise --limit` is added when `more` is true. It no longer prints the
`id` line, the whole unwrapped bio, raw counts or a `relationship:` line: those are in `--json`.

## Done in X

Open `/i/connect_people`. The tab "Who to follow" is selected under "Suggested for you". For that same
load, the op's items are the rows from the top, the first `limit` of them, in the same order (the page
keeps about 28 rows in its DOM and shows the rest as it scrolls; the call holds 100). Because the list
changes between loads, a check compares counts and shape, not names. `--limit 100` returns 100 items
with `more: false`. Each item has an id, handle and counts, and a row whose button says "Follow" is an
item with `relationship.following: false`. Nothing is followed or dismissed.

## Errors

- `InputError` (exit 2): a limit outside 1 to 100.
- `RefusedError` (exit 4): X's rate limit, a locked account, or a start page left blank by a
  rate-limited `Viewer`. Never retried.
- A challenge or the login page mid-run stops the op for the person to clear by hand.
