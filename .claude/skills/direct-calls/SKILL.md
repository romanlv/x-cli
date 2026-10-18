---
name: direct-calls
description: Find the app's own HTTP calls behind a task done in the browser, and give the op a direct way that makes them without starting a browser, keeping the browser way as the fallback. Use when exploring, writing or repairing an op, above all one that reads.
---

# Direct calls

Clicking through the app is slow: a browser starts, the app loads, every screen renders. What a
screen shows comes from a few calls the page makes. An op can make those calls itself over plain
HTTP, on the context's saved sign-in, and answer in seconds without starting a browser.

Read first: the app's knowledge file, its section on the app's calls (e.g. "Direct calls": what is
already known about the calls and tokens), and the helpers for direct calls next to the other
helpers. An op that already has a `direct` way is the example to copy. If there is no such section
yet, you are the first: start it.

Where the domain's authoring.md rules out a direct way, do layers 1 and 2 only: find the calls and
write them in notes.md, then stop. Don't use `page:fetch` there (it may not even be offered).

## How an op with a direct way runs

```ts
export default defineOp({
  name: "thing:find",
  // ...
  async direct({ http, step, context }, input) {
    // plain HTTP on the saved cookies: no browser, no page
  },
  async run({ app, page, step }, input) {
    // the browser way, as before
  },
});
```

- `direct` runs first. `http` is Playwright's `APIRequestContext` with the cookies the person's
  sign-in saved; cookies the app sets go back to the saved sign-in afterwards.
- When `direct` throws, a browser opens. Its sign-in check runs first, so a sign-in that ended says
  "sign in again", as any op would. Signed in, the op runs `run` and files a repair of `direct`.
  If that repair fails, `direct` is skipped until it is retried.
- `--browser` skips `direct`. In a worktree, or where repairs are off, a failure of `direct` fails
  the op. Verify runs every example both ways, so both must work.
- Throw `InputError`, `PreconditionError` or `RefusedError` from `direct` as from `run`; those
  don't fall back.
- Name its steps with `step`, as in `run`: the op's `history.jsonl` (in its folder) keeps each
  run's ms and each step's.

## Sessions and tokens

- The sign-in is the cookies; `direct` has what the browser has.
- A value the calls need beyond the cookies (a CSRF or session token, a short-lived JWT, a flow
  key) is fetched fresh inside `direct` on every run, from the response that hands it out. Never
  save one, and never copy one from exploring. One extra request is still far faster than a browser.
- To find where a value comes from, search the earlier responses for the value a later call sends.
- See what a signed-out call answers (a redirect, a sign-in page, HTML instead of JSON), and throw
  on it, so `direct` never returns an empty result for a session that ended.

## The layers

1. **The browser first.** Do the task with the page commands until it works and you know what it
   shows. This is `run`, the fallback.
2. **Find the calls.** `page:requests` lists the session's recent calls under the page command
   that made them, the newest JSON and event-stream ones numbered. `page:requests <n>` prints one
   with its request headers (cookies left out) and bodies; `page:requests <n> body` prints only its
   response, to pipe into `jq`. Find the call whose response holds what the screen showed, and each
   call before it that it needs a value from. The data usually comes from the action that asks for
   it (a search, an OK), not from drawing the screen after: look at the calls under that command. A
   call can start after its command returned and show under the next one. Only the newest bodies
   are kept, so read one soon after its command. If no listed call holds the data, the page may get
   it another way (a WebSocket, a call its script makes later): search the page's scripts for the
   url. An earlier note saying there is no call to use may come from a narrower look than this.
   Write each in the op's notes.md: method, URL, headers and body, which values come from an
   earlier response, and the response's shape.
   `page:fetch <url> [Name: value ...] [body]` makes a call on the session's sign-in, to try one
   with fewer headers or other values before writing it in the op.
3. **Write `direct`, doing less than the browser had to.**
   - Let the app filter. When the op finds records by a value, the calls to copy are those of the
     app's own search for it (the global search, a search field, a report's prompt), sent the
     value, not a call that lists everything for the op to match. If the browser way reads all,
     look for that search in the browser first. A search that stops at a fixed number of results
     is still the way: past it, the op refuses and asks for a narrower value, rather than read
     everything.
   - A list often already carries what the browser opened each record to read (an id, a URL).
   - Find ids by name through the app's own search where it answers over HTTP; where it doesn't,
     an id the app ships with every tenant (not one a tenant made) may stay a constant, as in `run`.
   - Ask for more rows per call than the UI does. Fetch pages in parallel only as far as the
     knowledge file allows: some apps limit calls per account per window, and count each one.
4. **Compare both ways** on the same inputs, at least two:
   `diff <(<cli> <op> <flags> --json | jq -S .data) <(<cli> <op> <flags> --browser --json | jq -S .data)`,
   which leaves no files behind for the commit. They must match exactly; verify checks it too. Time
   both with `time`, and write the times in notes.md.

## Where it applies

- Reads: a list, a search, a record's fields. Try it for every read the domain's authoring.md
  doesn't rule it out for.
- Writes stay in the browser.
- No call carries the data (it comes inside the page), or a call needs what only the page's own
  script computes: no `direct`, and write in notes.md what you looked at, so the next build doesn't
  look again.
- What holds for every call of the app (a header, where a token comes from, how URLs are built)
  goes in the knowledge file's section on the app's calls; a move two ops make becomes a helper, a
  plain function taking `http`.
