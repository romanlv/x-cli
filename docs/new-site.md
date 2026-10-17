# Starting a CLI for another site

This checkout is two parts: `core/`, the machinery and the instructions every site shares, and a
domain folder (`x/` here) that is all a new site needs to write. Copy the checkout, replace the
domain folder, and leave `core/` as it is.

## Where things go

| What | Where | Who writes it |
| --- | --- | --- |
| The machinery: CLI, contexts, op runner, requests, worker, browser, page sessions | `core/*.ts` | nobody per site |
| The workflows that build and repair ops | `core/workflows/` | nobody per site |
| What the workflows tell agents: every prompt, and how any op is written | `core/instructions/` (`prompts.ts`, `authoring.md`) | nobody per site |
| Skills the agents' harness finds by itself | `.claude/skills/` (`direct-calls`) | nobody per site |
| The entry point: it calls `main(domain)` | `<site>/main.ts` | you (four lines) |
| The domain's settings: how the app signs in, where runs start, what a refusal looks like, extra page commands | `<site>/domain.ts` | you |
| The moves every screen of the app shares (`app`) | `<site>/helpers/` | you, then the agents |
| `defineOp` bound to those helpers | `<site>/op.ts` | you (four lines) |
| What is particular to writing ops for this app: scope, ids it marks controls with, limits, test data, the reference op | `<site>/authoring.md` | you, then the agents |
| What the app is like: pages, controls, the calls behind them | `<site>/knowledge/<name>.md` | you, then the agents |
| What one context (account, tenant) is like | `<site>/knowledge/contexts/<context>.md` | the agents |
| The ops | `<site>/ops/<noun>-<verb>/` | the agents, through requests |

Code is in `.ts` files and instructions in `.md` files, except `core/instructions/prompts.ts`: the
prompts are text, but filled in per request, so they are functions. The workflows decide when a
prompt is sent; `prompts.ts` decides what it says; `docs/prompts.md` shows every one filled in.

## Steps

1. Copy the checkout without `.state/`, `.env*`, `node_modules/`, `.git/` or the domain's `ops/`.
2. Rename `x/` to your site's folder and `bin/x` to its command; point `bin/<cli>` at it, rename
   `tests/fixtures/x/` after it and point its `main.ts` at it, set `include` in `tsconfig.json`, and
   replace the `x x` arguments of `docs:prompts` in `package.json` (the domain folder and the
   command). Rename `ENV_PREFIX` in `core/env.ts` if the `XCLI_` variables should be the CLI's own.
3. Write `<site>/domain.ts`: `name`, `signInState` (signed in, signed out, signed in elsewhere,
   unknown) and `helpers` are required; the rest are optional hooks, each described in
   `core/domain.ts`.
4. Write a few helpers the first op will need (open a page, search, read a list), and say in
   `knowledge/<name>.md` which of their selectors are confirmed.
5. Write `<site>/authoring.md`: what the CLI is for and what it must never do in the app, how test
   data is marked (or that there is none), the app's limits, and where the reference op will be.
6. `bun install && bun run docs:prompts && bun run ci:check`, `git init`, commit.
7. `bin/<cli> context:add <name> --url <url>`, `context:login <name>`, then file the first request.
   Review the op it builds line by line and name it in `authoring.md` as the reference.

## Keeping generation quality

Agents read the core rules first and the domain's after, and the domain's win where they differ.
Put a rule in `core/instructions/` only when it holds for every site; a rule that holds for one
site goes in its `authoring.md`. After changing either prompts or `workflows.json`, run
`bun run docs:prompts` and read the diff of `docs/prompts.md`: it is exactly what agents will see.
