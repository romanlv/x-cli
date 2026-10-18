# accounts:search

The accounts an X search finds: the search's People tab for a query. An agent reading the person's X
for accounts they might be interested in passes a query ("machine learning", "dhh") and gets each
account X matched, keyed by its id, with its handle, name, bio, exact counts and the viewer's
relationship to it, so "do I already follow it" is `relationship.following`. `--json` carries all of
it for the agent; without it the result prints as the same account blocks as the follow lists.

## The way in X

**Search's People tab**, `/search?q=<query>&src=typed_query&f=user`, opened with
`app.search(query, "people")` and read with `app.users("SearchTimeline", …, { limit })`. It is the
page a person reaches by typing the query in the search box on /explore, pressing Enter and picking
the People tab. X does the matching (by name, handle and bio); the op matches nothing itself. The
page makes one `SearchTimeline` call (`product: "People"`, `count: 20`) on load and one more, with a
`cursor`, each time it is scrolled near its bottom; X sends 20 accounts a call. Its rows show no
counts, so the op reads the call, which has exact counts, the account id and the viewer's
relationship, the same user shape as `Following`. No direct way (x/authoring.md): the op reads what
the page's own calls return.

The op opens the URL rather than clicking: Enter lands on Top, whose `SearchTimeline` call
(`product: "Top"`) returns posts, and a click on People after it makes a second call; by URL the
People call is the only one.

Other ways, and why not:

- **Search's Top tab**: posts with a few accounts among them, not a list of accounts.
- **Latest, Media and Lists tabs**: posts and lists, not accounts.
- **The search box's typeahead**: the few accounts X suggests while typing, unpaged, with no counts.
- **Search filters and Advanced search**: they narrow or build a post query; nothing the query
  itself can't say, and Advanced search makes post queries.
- **Who to follow** (sidebar, `/i/connect_people`): X's suggestions, not matched to a query (R-0009).
- **A profile's Following and Followers**: one account's follows, not a search by value
  (`account:following`, `account:followers`).

## Inputs

| Flag | Type | Default | What |
| --- | --- | --- | --- |
| `--query` | string, required | | what a person types in X's search to find an account: a name, a handle, words from a bio. Blank (after trimming) is an `InputError`. Post operators (`from:`, `since:`, `filter:`) don't filter accounts here: X matches them as words (`from:NASA since:2025-01-01` finds accounts named like "2025…", not NASA). For posts with operators use `posts:search` |
| `--limit` | integer, 1 to 200 | 20 | at most this many accounts |

No `until`: the list is in X's order of relevance, not by id. A caller who wants more raises
`--limit`; at 20 accounts a call, 200 is ten scrolls, the most a read makes.

Nothing differs between contexts: the same query finds the same public accounts on any signed-in
account. What differs is the relationship, which is the signed-in account's own, and which accounts
it sees (those it blocks or that block it).

## Output

`Page(User | UserUnavailable)` from `model.ts`, mapped from the `SearchTimeline` responses by
`usersPage`, as for `account:following`:

- `items`: accounts in the order X lists them, unique by id: id, handle, name, bio, location,
  counts (followers, following, posts, likes, media; exact), `protected`, `blue`, and
  `relationship` (`following`, `followedBy`, `followRequestSent`, `blocking`, `blockedBy`, `muting`),
  the signed-in account's to that one. An account X doesn't show is a `user-unavailable` item.
- `more`: true when the read stopped at `limit` or after 10 scrolls with accounts left; false when X
  ended the list.

A query that matches nobody is a page with no items and `more: false`, not an error (X answers with
only its cursors and a Terminate TopAndBottom, and the page says "Try searching for something
else").

Without `--json` it prints with `usersText`: a block per account (name, `@handle`, tags
`following` / `follows you` / `protected`, two lines of bio, followers · following · posts, rounded
from 10,000 up, the profile link) with a rule between blocks, `<n> accounts · more: raise --limit`
when `more`, and `no accounts` for an empty page.

## Done in X

Open `https://x.com/search?q=<query>&src=typed_query&f=user` (or type the query on /explore, press
Enter, pick People). The op's items are the rows of that list from the top, the first `limit` of
them, in the same order: each item's name and `@handle` are those of the row in the same place. A
row whose button says "Following" is an item with `relationship.following: true` (on this account,
@dhh in a search for `dhh`), and "Follow" one with false. Each item's counts equal its profile's
followers and following. A query that matches nothing shows "Try searching for something else" and
the op returns no items. Nothing is followed, unfollowed or changed.

## Errors

- `InputError` (exit 2): a blank query, a limit out of range.
- `RefusedError` (exit 4): X's rate limit (429 or code 88) or a locked account, or a budget at a
  tenth with nothing read. A start page left blank by a rate-limited call (`Viewer`) is one too.
  Never retried.
- A challenge or the login page mid-run stops the op for the person to clear by hand.
