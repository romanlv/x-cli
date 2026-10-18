# x-cli

`x` reads X (Twitter) for the person whose account it is signed in as, by driving a real browser,
and builds its own ops through awf workflows. `DESIGN.md` is how it works; `bin/x help` is the
command reference. The machinery comes from `../workday-cli`; only `x/` is X's.

- `core/` is the reusable machinery and never imports from `x/`, the domain. The workflows in
  `core/workflows/` take what they need from the request record, never naming X.
- **Read only.** No op, and nothing an agent does while exploring, posts, likes, reposts, follows,
  bookmarks, sends a message or changes a setting (`x/authoring.md`).
- X watches for automation and limits each account: one page at a time, a person's pace, a rate
  limit is exit 4 and never a retry loop. `x/knowledge/bot-detection.md` has the research.
- Run it as `bin/x` (bun). State lives in `.state/` in this folder (gitignored), or `XCLI_HOME`.
- Ops in `x/ops/` are written by the build and repair workflows, in worktrees, and merged by
  fast-forward. Don't edit them in the main checkout by hand: work in a worktree.
- Code and instructions are apart: `core/instructions/` is what core tells agents (`prompts.ts`, every
  prompt; `authoring.md`, how any op is written), and `x/authoring.md` and `x/knowledge/` are X's.
  `docs/new-site.md` says where each thing goes when starting a CLI for another site.
- `docs/prompts.md` shows every prompt filled in. After changing a prompt or `workflows.json`, run
  `bun run docs:prompts` and read its diff: it is what agents will see.
- `workflows.json` turns the agents' sandbox on, and names an agent's model where it differs from the
  defaults in `core/workflows/config.ts` (DESIGN.md, "Models and the sandbox").
- `bun run ci:fast` is everything but browser e2e tests (seconds), `ci:sandbox` that without the
  workflow tests (what sandboxed agents run); `bun run ci:check` runs Biome, tsc, the bun tests and
  the workflow tests (`awf test core/workflows`). There are no e2e tests yet: they need a mock X.
- Test env: `XCLI_NO_WORKER=1` files requests without starting the worker; `XCLI_STEP_TIMEOUT_MS` (one
  action or call) and `XCLI_SIGNIN_WAIT_MS` (a loaded page showing whether it is signed in) shorten waits.
