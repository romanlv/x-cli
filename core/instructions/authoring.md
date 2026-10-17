# Writing an op

Every build and repair reads this first, then the domain's own `authoring.md`, which says what is
particular to its app and names the reference op. Where the two differ, the domain's wins.

## An op's folder

`<domain>/ops/<noun>-<verb>/`, for the op `<noun>:<verb>`:

| File            | Holds                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `op.ts`         | the Playwright code, as named steps, and the direct way when there is one                      |
| `spec.md`       | what the op does, its inputs and outputs, what done looks like in the app                      |
| `notes.md`      | what the app taught: paths, labels, ids, quirks, waits that mattered, the calls behind a screen. Append only |
| `examples.json` | inputs that worked, each tagged with its context: `[{ "context": "<context>", "input": {…} }]` |
| `history.jsonl` | written by the runner, one line per call; not committed                                        |

## op.ts

```ts
import { defineOp, Type } from "../../op";

export default defineOp({
  name: "thing:find",
  description: "Things whose name matches a query", // one line, for `<cli> help`
  input: Type.Object({
    query: Type.String({ description: "what to search for" }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "at most this many (20)" })),
  }),
  output: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), url: Type.String() })),
  async run({ app, step }, input) {
    await step("search", () => app.search(input.query));
    return step("read results", () => app.results({ limit: input.limit ?? 20 }));
  },
});
```

`app` is the domain's helper library; the reference op shows the real calls.

- **Name every step.** A failure says `failed at "read results"`, and its bundle holds a screenshot
  and the page's controls at that moment.
- **Read the output back from the app**, from the record the op made or changed, or from what it
  read. Never return the input: an op that returns has done the thing.
- **Inputs are flags.** Each property of `input` is a `--flag` (camelCase becomes kebab-case), and
  its `description` is the help text. Values that differ between contexts are inputs or come from
  `knowledge/contexts/<context>.md`, never constants in `op.ts`.
  An input can't take a name every command already takes for itself (`context`, `request`,
  `timeout`, `json`, `help`, `wait`, `headed`, `dry-run`, `browser`, `input-json`): the CLI refuses
  such an op.
- **Use the helpers** in `helpers/` (`app`). When a move holds for every screen of the app and isn't
  there, add it there, not in the op. A move written out in two ops is a helper.
- **Target what the app keeps stable**: its test ids or automation ids first, then a field's label,
  then role and name. Never generated class names. The exploring trace (`page:trace`) has the
  locator each command used.
- **Errors that aren't the op's fault are thrown as such**, so triage files no repair:
  `InputError` (exit 2: a value the app doesn't offer; list the ones it does),
  `PreconditionError` (exit 3: a record that isn't there), `RefusedError` (exit 4: the app said no).
- **`--dry-run`** (`dryRun` in the op's context) stops before the last save, and throws
  `DryRunReached` there. An op with several saves stops before the last one only, so a dry run fills
  everything and saves nothing it shouldn't. An op that only reads ignores it.
- **Find with the app's own search**: an op that finds records by a value uses the way a person
  would search for it (the app's search, a search field, a filter), and lets the app match. Reading
  every record to match in the op is a last resort, and notes.md says what was tried.
- **Reads have a direct way**, unless the domain's authoring.md says otherwise:
  `direct({ http, step, context }, input)` beside `run`, making the app's own calls over HTTP on
  the saved sign-in, with no browser. `run` stays as the fallback. The `direct-calls` skill says how
  to find the calls and the tokens they need.

## Examples

`examples.json` has an input for each case `spec.md` tells apart, at least one, each tagged with the
context it works in. Verify runs every example for the run's context, so each must keep working:
use test data as the domain's authoring.md defines it, never a record that may change or go away.

## Test data

What an agent may create or change in the app, and how test data is marked, is the domain's to
say, in its authoring.md under "Test data". Nothing else in the app is touched.
