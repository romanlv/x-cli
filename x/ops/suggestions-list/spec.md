# suggestions:list

The accounts X suggests the signed-in account follow: its "Who to follow" list on the Connect page.
Read only: nothing is followed or dismissed. For an agent hunting for accounts, so each item is a
full `User` keyed by id.

## The way in X

**The Connect page**, `/i/connect_people`, tab "Who to follow" (the target of the sidebar's "Show
more"). Opened with `app.open` and read with `app.users("ConnectTabTimeline", …)`: the call the page
makes on load carries all 100 suggestions at once, with ids, exact counts and the viewer's
relationship. No direct way (x/authoring.md). The sidebar shows 3 and "Creators for you" is another
list of creators; neither is read. notes.md has the survey and the call.

## Inputs

| Flag | Type | Default | What |
| --- | --- | --- | --- |
| `--limit` | integer, 1 to 100 | 20 | at most this many accounts; above 100 is `InputError` (X offers 100) |

There is no `--handle`: X scopes these suggestions to the signed-in account only. No `until`.

## Output

`Page(User | UserUnavailable)` from `model.ts`, mapped by `usersPage`: `items` unique by id, in X's order:
id, handle, name, bio, location, exact counts, `protected`, `blue`, `relationship`
(`following`, `followedBy`, ...). `more` is true when the read stopped at `limit` with suggestions left,
false at X's 100 (it ended the list).

**Why X suggests it: X gives none.** No reason (no "Followed by", topic or area) is in any
response, so the output has no reason field; if X starts sending one it is added to `model.ts` then.

**The list changes between loads**: two loads 25 s apart shared 70 of 100 accounts, in another order.
Examples and checks therefore use only `--limit` and never name an account.

Text view: `usersFullText`, a block per account with the same data as `--json` and nothing shortened: name, handle, id, the whole bio, location, exact follower/following/post counts (418105, not 418.1K), every relationship flag set (`following`, `followedBy`, ...; `none` when none), the profile link.

## Done in X

Open `/i/connect_people`: the op's items are the rows from the top, the first `limit`, for that load
(the page lists about 28 rows in its DOM, scrolled; the call holds 100). Every item has an id, handle
and counts; nothing is followed.

## Errors

- `InputError` (exit 2): a limit out of 1 to 100.
- `RefusedError` (exit 4): X's rate limit or a locked account; a start page left blank by a rate-limited `Viewer`. Never retried.
