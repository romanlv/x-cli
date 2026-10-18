# account:following

The accounts an account follows. Without `--handle` it reads the signed-in account (taken from the
session: the `me` context has no handle written down), with it any account whose list is visible.
Each account comes with its handle, name, bio, counts and the viewer's relationship to it
(`following`, `followedBy`), so "do they follow me back" is read off the output. Mutuals are the
items with both `relationship.following` and `relationship.followedBy`; there is no op for them.

## The way in X

**A profile's "Following" link**, `/<handle>/following`: the page a person reaches by opening the
profile and clicking "N Following". Opened with `app.follows(handle, "following")` (the profile, which
refuses a missing or protected account, then that link) and read with `app.users("Following", …)`:
the `Following` GraphQL call the page makes on load and once more each time it is scrolled near its
bottom. X sends 50 or more accounts a call whatever its `count`, so the read is cut to `limit`.
No direct way (x/authoring.md): the op reads what the page's own calls return.

Other ways, and why not: search's People tab matches accounts by name, not by who follows them;
`filter:follows` finds posts, not accounts; the Followers tabs are the other direction
(`account:followers`, a follow-up). notes.md has the survey.

## Inputs

| Flag | Type | Default | What |
| --- | --- | --- | --- |
| `--handle` | string, optional | the signed-in account | whose follows to read, with or without `@`; letters, digits and `_`, at most 15, else `InputError` |
| `--limit` | integer, 1 to 200 | 20 | at most this many accounts |

No `until`: the list is not in id order. A caller who wants more raises `--limit`; more than a few
hundred accounts risks X's limits, which is why 200 is the most.

## Output

`UsersPage(User | UserUnavailable)` from `model.ts` (`items` and `more` only: no `pinned`, no `cursor`), mapped by `usersPage`:

- `items`: accounts in the order X lists them, unique by id: id, handle, name, bio, location,
  counts (followers, following, posts, likes, media; exact), `protected`, `blue`, and
  `relationship` (`following`, `followedBy`, `followRequestSent`, `blocking`, `blockedBy`, `muting`).
  An account X doesn't show is a `user-unavailable` item.
- `more`: true when the read stopped at `limit` or after 10 scrolls with accounts left; false when X
  ended the list.

An account that follows nobody is a page with no items and `more: false`.

Without `--json` it prints with `usersText`: a block per account (name, `@handle`, tags
`following` / `follows you` / `protected`, two lines of bio, followers · following · posts, the
profile link) with a rule between blocks, and `<n> accounts · more: raise --limit` when `more`.

## Done in X

Open the profile (yours, or `/<handle>`), click "N Following": the op's items are the rows of that
list from the top, the first `limit` of them, in the same order. With no `--handle` and `--limit
200` on an account of fewer than 200 follows, the item count equals the profile's "Following"
count and `more` is false. Each row's Following/Follow button agrees with `relationship.following`.
Nothing is followed, unfollowed or changed.

## Errors

- `InputError` (exit 2): a handle that is not an X handle, a limit out of range.
- `PreconditionError` (exit 3): no such account; a protected account the viewer can't see
  (`protected`, or its list isn't offered); no signed-in handle to read.
- `RefusedError` (exit 4): X's rate limit or a locked account, or a budget at a tenth with nothing
  read. A start page left blank by a rate-limited call (`Viewer`) is one too. Never retried.
