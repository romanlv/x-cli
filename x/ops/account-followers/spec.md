# account:followers

The accounts that follow an account: the other direction from `account:following`, shaped the same
way. Without `--handle` it reads the signed-in account (taken from the session: the `me` context has
no handle written down), with it any account whose followers are visible. Each account comes with
its id, handle, name, bio, exact counts and the viewer's relationship to it. "Do I follow them" is
`relationship.following`. `relationship.followedBy` ("follows me") is true throughout without
`--handle`; with one, it says which of that account's followers also follow the viewer. The caller is an agent looking for accounts the person may
care about, so ids, exact counts and the follow flag matter as much as the text view.

## The way in X

**A profile's plain "Followers" tab**, `/<handle>/followers`. A person opens the profile, clicks
"N Followers", which lands on the *Verified Followers* tab (`/<handle>/verified_followers`), and then
clicks the tab named exactly "Followers" beside it. Opened with `app.follows(handle, "followers")`
(the profile, which refuses a missing or protected account, then the link, then that tab) and read
with `app.users("Followers", …)`: the `Followers` GraphQL call the tab makes on load and once more
each time it is scrolled near its bottom. X sends 20 or more accounts a call whatever its `count`,
so the read is cut to `limit`. No direct way (x/authoring.md): the op reads what the page's own
calls return.

Other ways, and why not:

- **Verified Followers** (`/<handle>/verified_followers`, call `BlueVerifiedFollowers`), where the
  profile's link lands: verified followers only, a subset (1 of 12 on the `me` account).
- **"Followers you know"** (a tab on other accounts' pages, not on one's own): only the followers the
  viewer also follows.
- **Affiliates** (a tab on organisations such as NASA): the organisation's accounts, not followers.
- **Search's People tab** (`/search?f=user`): matches names and bios; it can't list who follows an
  account.
- Hover cards and the "Who to follow" sidebar: a few suggestions, not the list.

notes.md has the survey.

## Inputs

| Flag | Type | Default | What |
| --- | --- | --- | --- |
| `--handle` | string, optional | the signed-in account | whose followers to read, with or without `@`; letters, digits and `_`, at most 15, else `InputError` |
| `--limit` | integer, 1 to 200 | 20 | at most this many accounts |

What differs between contexts is only the default handle, read from the session, never written in
`op.ts`. No `until`: the list is not in id order. A large account's list starts with about 20
well-known followers and then runs newest follow first; a small one is newest follow first
throughout. A caller who wants more raises `--limit`; 200 is the most, as in `account:following`.

## Output

`Page(User | UserUnavailable)` from `model.ts`, mapped by `usersPage`, which reads `Followers` as it
comes (`data.user.result.timeline.timeline`, `user-<id>` items plus cursors):

- `items`: accounts in the order X lists them, unique by id: id, handle, name, bio, location,
  counts (followers, following, posts, likes, media; exact), `protected`, `blue`, and
  `relationship` (`following`, `followedBy`, `followRequestSent`, `blocking`, `blockedBy`, `muting`).
  An account X doesn't show is a `user-unavailable` item.
- `more`: true when the read stopped at `limit` or after 10 scrolls with accounts left; false when X
  ended the list (Terminate Bottom).

The list can hold fewer than the profile's "Followers" count: on the `me` account the profile says
13 and X's list ends at 12. The op returns what the list holds, with `more: false`.

Without `--json` it prints with `usersText`: a block per account (name, `@handle`, tags
`following` / `follows you` / `protected`, two lines of bio, followers · following · posts, the
profile link) with a rule between blocks, and `<n> accounts · more: raise --limit` when `more`.

## Done in X

Open the profile (yours, or `/<handle>`), click "N Followers", then the "Followers" tab: the op's
items are the rows of that list from the top, the first `limit` of them, in the same order. With no
`--handle` and `--limit 200` on an account with fewer than 200 followers, every row is there and
`more` is false. Each row's button agrees with `relationship.following` ("Following" when true,
"Follow back" when false and the account follows the viewer, "Follow" otherwise). On the viewer's
own followers every row also says "Follows you" (`followedBy` true); on another account's followers
`followedBy` is true only for those who follow the viewer. Nothing is followed, unfollowed or
changed.

## Errors

- `InputError` (exit 2): a handle that is not an X handle, a limit out of range.
- `PreconditionError` (exit 3): no such account; a protected account the viewer can't see
  (`protected`, or its Followers link or tab isn't offered; not yet met on a real account); no
  signed-in handle to read.
- `RefusedError` (exit 4): X's rate limit or a locked account, or a budget at a tenth with nothing
  read. A start page left blank by a rate-limited call (`Viewer`) is one too. Never retried.
