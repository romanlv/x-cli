// The whole interface: commands in, text or the --json envelope out. A domain's entry point calls
// `main(domain)`; nothing here knows which app the domain drives.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { keepSignedIn, signIn } from "./browser";
import { Contexts, savedCredentials } from "./contexts";
import type { Domain } from "./domain";
import { OpError } from "./errors";
import {
  commandLine,
  domainRef,
  type HistoryLine,
  lastRun,
  loadOps,
  OP_NAME,
  type OpEntry,
  opFolder,
  opHelp,
  parseInput,
  RESERVED_NOUNS,
  type RunEnv,
  runOp,
} from "./ops";
import { EXIT, fail, finish, guardStdout, type NextHint, type Outcome, OutcomeError, ok } from "./output";
import { isTerminal, type RequestRecord, type RequestState, Requests } from "./requests";
import { CORE_PAGE_COMMANDS, pageCommand, runSessionDaemon, sessionContext } from "./session";
import { ago, alive } from "./store";
import { ensureWorker, formatCost, formatDuration, runActivity, runOutput, runRoot, runUsage, runWorker } from "./worker";

/** Flags every command understands. The rest belong to the op being called. */
const GLOBAL_BOOLEANS = new Set(["json", "headed", "dry-run", "wait", "help", "browser"]);
const GLOBAL_VALUES = new Set(["context", "request", "timeout", "session", "input-json", "state"]);

export interface ParsedArgs {
  positionals: string[];
  global: Record<string, string | boolean>;
  flags: Record<string, string | boolean | string[]>;
}

/** `--key value`, `--key=value`, and `--key` alone as true; a repeated key collects its values. */
export const parseArgs = (argv: string[], booleans: Set<string> = new Set()): ParsedArgs => {
  const out: ParsedArgs = { positionals: [], global: {}, flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      out.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h") {
      out.global.help = true;
      continue;
    }
    if (!arg.startsWith("--") || arg === "--") {
      out.positionals.push(arg);
      continue;
    }
    let key = arg.slice(2);
    let value: string | boolean;
    const eq = key.indexOf("=");
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else if (GLOBAL_BOOLEANS.has(key) || booleans.has(key) || i + 1 >= argv.length || argv[i + 1]!.startsWith("--")) {
      value = true;
    } else {
      value = argv[++i]!;
    }
    if (GLOBAL_BOOLEANS.has(key) || GLOBAL_VALUES.has(key)) {
      out.global[key] = value;
    } else {
      const prior = out.flags[key];
      out.flags[key] = prior === undefined ? value : ([] as (string | boolean)[]).concat(prior, value).map(String);
    }
  }
  return out;
};

const isWorktree = (domain: Domain): boolean =>
  domain.worktree ?? (existsSync(join(domain.root, ".git")) && statSync(join(domain.root, ".git")).isFile());

interface Env extends RunEnv {
  cli: string;
  /** How to run this CLI again: for the worker, a session daemon, or a call after --wait. */
  entry: string[];
}

const usage = (env: Env, ops: Map<string, OpEntry>): string => {
  const cli = env.cli;
  const byNoun = new Map<string, OpEntry[]>();
  for (const entry of ops.values()) {
    const noun = entry.name.split(":")[0]!;
    byNoun.set(noun, [...(byNoun.get(noun) ?? []), entry]);
  }
  const opLines = [...byNoun.entries()].flatMap(([noun, entries]) => [
    `  ${noun}`,
    ...entries.map((e) => `    ${e.name.padEnd(28)} ${e.definition.description}`),
  ]);
  const pageLines = [
    ...Object.entries(CORE_PAGE_COMMANDS),
    ...Object.entries(env.domain.pageCommands ?? {}).map(([name, c]) => [`page:${name}`, c.usage] as const),
  ].map(([name, text]) => `  ${name.padEnd(30)} ${text}`);
  return [
    `Usage: ${cli} <command> [flags]`,
    "",
    "Ops:",
    ...(opLines.length ? opLines : ["  none yet: ask for one with a request"]),
    "",
    "Ops are noun:verb. To ask for one that doesn't exist yet, call it with the flags it should take and --request.",
    `  ${cli} <op> --help              its flags, from its spec`,
    `  ${cli} ops                      what exists, each op's last result and any open request`,
    "",
    "Requests: every change to the tool goes through one, worked by an agent workflow.",
    `  ${cli} request "<what you need>"   ask for a new op or a change`,
    `  ${cli} <op> ... --request ["…"]   a new op, or a change to one; the call is the example`,
    `  ${cli} requests [--state building]`,
    `  ${cli} request:status <id> [--wait]`,
    `  ${cli} request:answer <id> "<answer>"`,
    `  ${cli} request:retry <id>`,
    `  ${cli} request:cancel <id> ["<why>"]   stop it, and its run if one is going`,
    "",
    "Contexts: one per call (an account or tenant, and its sign-in), the current one unless --context names another.",
    `  ${cli} contexts`,
    `  ${cli} context:add <name> --url <url>`,
    `  ${cli} context:login <name>        a person signs in, in a browser window`,
    `  ${cli} context:login <name> --username <u> --password <p>   or headless; .env.<name> can hold both`,
    `  ${cli} context:use <name>`,
    `  ${cli} context:remove <name>`,
    "",
    "Exploring: a named session (--session or XCLI_SESSION) stays open between calls.",
    ...pageLines,
    "",
    "--json prints { ok, data, error, next }. Exit: 0 done, 1 error, 2 bad input, 3 precondition,",
    "4 refused, 5 request pending, 6 --wait gave up.",
  ].join("\n");
};

export const main = async (domain: Domain, argv = process.argv.slice(2)): Promise<never> => {
  guardStdout();
  const json = argv.includes("--json");
  const env: Env = {
    domain,
    cli: domain.name,
    contexts: new Contexts(domain.home, domain.name),
    requests: new Requests(domain.home),
    fileRepairs: !isWorktree(domain) && !process.env.XCLI_NO_REPAIRS,
    entry: [process.execPath, process.argv[1]!],
  };
  try {
    return await finish(await dispatch(env, argv), { json });
  } catch (err) {
    if (err instanceof OutcomeError) return finish(err.outcome, { json });
    if (err instanceof OpError) return finish(fail(err.message, err.exitCode, err.next), { json });
    const error = err instanceof Error ? err : new Error(String(err));
    return finish(fail(`${error.message}\n${(error.stack ?? "").split("\n").slice(1, 6).join("\n")}`), { json });
  }
};

const dispatch = async (env: Env, argv: string[]): Promise<Outcome> => {
  const command = argv[0] !== undefined && !argv[0].startsWith("-") ? argv[0] : undefined;
  const rest = command === undefined ? argv : argv.slice(1);
  const { cli, contexts, requests } = env;

  if (command === undefined || command === "help") {
    const { ops } = await loadOps(env.domain);
    const text = usage(env, ops);
    return command === "help" || rest.includes("--help") || rest.includes("-h")
      ? ok(text)
      : fail(`no command given\n\n${text}`, EXIT.USAGE);
  }

  // Ops parse their own flags by their schema, so booleans are known before the rest is read.
  if (OP_NAME.test(command) && !RESERVED_NOUNS.includes(command.split(":")[0]!)) return callOp(env, command, rest);

  const args = parseArgs(rest);
  const [first, second] = args.positionals;
  const wantsHelp = args.global.help === true;
  const need = (value: string | undefined, what: string): string => value ?? raiseUsage(`give ${what}`);

  switch (command) {
    case "ops":
      return listOps(env);
    case "contexts": {
      const { current, contexts: all } = contexts.list();
      if (all.length === 0) return ok("no contexts yet", [{ hint: "add one", cmd: `${cli} context:add <name> --url <url>` }]);
      const width = Math.max(...all.map((c) => c.name.length));
      const rows = all.map((c) => {
        const state = !contexts.isSignedIn(c) ? "signed out" : `signed in, ${ago(c.signedInAt ?? c.addedAt)}`;
        return `${c.name === current ? "*" : " "} ${c.name.padEnd(width)}   ${c.url}   ${state}`;
      });
      if (!args.global.json) return ok(rows.join("\n"));
      return ok({ current, contexts: all.map(({ authFile, ...c }) => ({ ...c, signedIn: contexts.isSignedIn({ ...c, authFile }) })) });
    }
    case "context:add": {
      const name = need(first, "a context name");
      const url = typeof args.flags.url === "string" ? args.flags.url : raiseUsage("give --url <url>");
      const added = contexts.add(name, url);
      return ok(`context ${added.name}: ${added.url}`, [{ hint: "sign in", cmd: `${cli} context:login ${added.name}` }]);
    }
    case "context:use":
      return ok(`using ${contexts.use(need(first, "a context name")).name}`);
    case "context:remove":
      contexts.remove(need(first, "a context name"));
      return ok(`removed ${first}`);
    case "context:login": {
      const ctx = contexts.resolve(first ?? (args.global.context as string | undefined));
      const timeoutMs = args.global.timeout === undefined ? undefined : seconds(args.global.timeout) * 1000;
      const saved = savedCredentials(env.domain.root, ctx.name);
      const username = (args.flags.username as string | undefined) ?? saved?.username;
      const password = (args.flags.password as string | undefined) ?? saved?.password;
      if (password !== undefined && username === undefined) raiseUsage("give --username with the password");
      if (username !== undefined && !password) raiseUsage(`give the password: --password, or XCLI_PASSWORD in .env.${ctx.name}`);
      // Agents work in worktrees and never sign in; a person's credentials stay with the person.
      if (username !== undefined) refuseInWorktree(env, "a person signs in with a password");
      const credentials = username !== undefined ? { username, password: password! } : undefined;
      await signIn(env.domain, contexts, ctx, { timeoutMs, headless: !!process.env.XCLI_HEADLESS_LOGIN, credentials });
      const continued = requests.signedIn(cli, ctx.name);
      if (continued.length === 0) return ok(`signed in to ${ctx.name}`);
      startWorker(env);
      return ok(
        `signed in to ${ctx.name}; continued ${continued.join(", ")}`,
        continued.map((id) => ({ hint: "check on it", cmd: `${cli} request:status ${id} --wait` })),
      );
    }
    case "request": {
      if (wantsHelp) return ok(`Usage: ${cli} request "<what you need>" [--context <name>] [--wait]`);
      const text = need(first, `what you need, in quotes: ${cli} request "the replies under a post"`);
      if (text.startsWith("-")) raiseUsage(`"${text}" looks like a flag, not a request; say what you need in quotes`);
      const ctx = contexts.resolve(args.global.context as string | undefined);
      const wait = waitSeconds(args.global);
      refuseInWorktree(env);
      const filed = requests.file({ kind: "intake", text, context: ctx.name, domain: domainRef(env.domain) });
      return filedOutcome(env, filed, wait);
    }
    case "requests": {
      const state = args.global.state as RequestState | undefined;
      const list = requests.list({ state });
      const usage = new Map(list.map((r) => [r.id, runUsage(env.domain.home, r.id)]));
      if (args.global.json) return ok(list.map((r) => ({ ...r, usage: usage.get(r.id) })));
      if (list.length === 0) return ok(state ? `no ${state} requests` : "no requests yet");
      const total = [...usage.values()].reduce((sum, u) => ({ usd: sum.usd + (u?.usd ?? 0), ms: sum.ms + (u?.ms ?? 0) }), {
        usd: 0,
        ms: 0,
      });
      const rows = list.map((r) => {
        const u = usage.get(r.id);
        const took = u ? `${formatCost(u).padStart(7)} ${formatDuration(u.ms).padStart(6)}` : " ".repeat(14);
        return `${r.id}  ${r.state.padEnd(9)} ${(r.op ?? r.kind).padEnd(22)} ${took}  ${ago(r.updatedAt).padEnd(8)} ${firstLine(r.text)}`;
      });
      return ok(
        [...rows, `total ${formatCost({ usd: total.usd, partial: false })} at list prices, ${formatDuration(total.ms)} of runs`].join("\n"),
      );
    }
    case "request:status": {
      const record = getRequest(env, first);
      // Waiting here follows the request; only the call that filed it runs again once it is done.
      if (args.global.wait) return waitFor(env, record.id, waitSeconds(args.global)!);
      return statusOutcome(env, record);
    }
    case "request:answer": {
      const record = getRequest(env, first);
      refuseInWorktree(env);
      const answered = requests.answer(record.id, need(second, "the answer, in quotes"));
      startWorker(env);
      return ok(`${answered.id} answered; its run continues`, [
        { hint: "check on it", cmd: `${cli} request:status ${answered.id} --wait` },
      ]);
    }
    case "request:retry": {
      const record = getRequest(env, first);
      refuseInWorktree(env);
      // A run that ended early (deferred, declined, flaky) is redone; any other continues where it stopped.
      const retried = requests.retry(record.id, { redo: runOutput(env.domain.home, record.id)?.outcome === "completed" });
      startWorker(env);
      return ok(`${retried.id} is back in the queue`, [{ hint: "check on it", cmd: `${cli} request:status ${retried.id} --wait` }]);
    }
    case "request:cancel": {
      const record = getRequest(env, first);
      refuseInWorktree(env);
      const cancelled = requests.cancel(record.id, second ?? "cancelled");
      // awf stops a run on SIGTERM and closes its agents; its worktree goes once it has.
      if (alive(cancelled.pid)) {
        process.kill(cancelled.pid!, "SIGTERM");
        for (let i = 0; i < 120 && alive(cancelled.pid); i++) await Bun.sleep(500);
      }
      if (cancelled.attempts > 0) {
        const [{ cleanUpAfter }, { realDeps }, { loadConfig }] = await Promise.all([
          import("./workflows/shared"),
          import("./workflows/deps"),
          import("./workflows/config"),
        ]);
        await cleanUpAfter(realDeps, cancelled, loadConfig(env.domain.root));
      }
      return ok(`${cancelled.id} cancelled`, [{ hint: "take it up again", cmd: `${cli} request:retry ${cancelled.id}` }]);
    }
    case "request:worker":
      await runWorker(env.domain.home, env.domain.root, {
        keepSignedIn: async (name) => {
          const ctx = contexts.list().contexts.find((c) => c.name === name);
          if (!ctx) return;
          // Signed out, a person who left their sign-in in .env.<context> needn't come back for it.
          if (await keepSignedIn(env.domain, contexts, ctx)) requests.signedIn(cli, name);
        },
      });
      return ok("worker done");
    case "page:daemon": {
      const ctx = contexts.resolve(args.global.context as string | undefined);
      await runSessionDaemon(env.domain, contexts, String(args.global.session), ctx, args.global.headed === true);
      // The daemon serves until it is closed or idle; it exits itself.
      return new Promise<never>(() => {});
    }
  }

  if (command === "page" || command.startsWith("page:")) {
    const known = command in CORE_PAGE_COMMANDS || env.domain.pageCommands?.[command.slice(5)] !== undefined;
    if (!known) return fail(`unknown page command ${command}; see ${cli} help`, EXIT.USAGE);
    const session = (args.global.session as string | undefined) ?? process.env.XCLI_SESSION ?? "default";
    // A running session keeps its context; only an explicit --context can disagree with it.
    const ctx = contexts.resolve((args.global.context as string | undefined) ?? sessionContext(env.domain.home, session));
    return pageCommand(env.domain, env.entry, { session, context: ctx, headed: args.global.headed === true }, command, args.positionals);
  }

  return fail(`unknown command "${command}"; ops are noun:verb, such as posts:search. See ${cli} help`, EXIT.USAGE);
};

const raiseUsage = (message: string): never => {
  throw new OutcomeError(fail(message, EXIT.USAGE));
};

const firstLine = (text: string, max = 70): string => {
  const line = text.split("\n")[0]!;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const getRequest = (env: Env, id: string | undefined): RequestRecord => {
  if (!id) raiseUsage("give a request id, such as R-0012");
  const record = env.requests.get(id!);
  if (!record) throw new OutcomeError(fail(`no request ${id}`, EXIT.PRECONDITION, [{ hint: "list them", cmd: `${env.cli} requests` }]));
  return record;
};

/** Flags that steer this call rather than describe the task: left out of the call a request keeps. */
const CONTROL_FLAGS = new Set(["json", "wait", "request", "timeout", "context", "headed", "browser"]);

/** The caller's own call, minus the flags that steer it; `--dry-run` stays, so a re-run stays one. */
export const callOf = (name: string, rest: string[], booleans: Set<string>): string[] => {
  const kept: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const key = arg.startsWith("--") ? arg.slice(2).split("=")[0]! : undefined;
    const valueFollows =
      key !== undefined &&
      !arg.includes("=") &&
      !GLOBAL_BOOLEANS.has(key) &&
      !booleans.has(key) &&
      i + 1 < rest.length &&
      !rest[i + 1]!.startsWith("--");
    if (key && CONTROL_FLAGS.has(key)) {
      if (valueFollows) i++;
      continue;
    }
    kept.push(arg);
    if (valueFollows) kept.push(rest[++i]!);
  }
  return [name, ...kept];
};

/** Up to three names a typo of `name` could have meant: the same noun, or two edits away. */
export const similarNames = (name: string, names: string[]): string[] => {
  const distance = (a: string, b: string): number => {
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      row = next;
    }
    return row[b.length]!;
  };
  const noun = name.split(":")[0];
  return names
    .map((n) => ({ n, d: distance(name, n) }))
    .filter(({ n, d }) => d <= 2 || n.split(":")[0] === noun)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map(({ n }) => n);
};

const callOp = async (env: Env, name: string, rest: string[]): Promise<Outcome> => {
  const { cli, contexts, requests } = env;
  const { ops, broken } = await loadOps(env.domain);
  const entry = ops.get(name);
  const booleans = new Set(
    Object.entries(entry?.definition.input.properties ?? {})
      .filter(([, s]) => (s as { type?: string }).type === "boolean")
      .map(([key]) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)),
  );
  const args = parseArgs(rest, booleans);
  const wait = waitSeconds(args.global);
  const call = callOf(name, rest, booleans);
  // With --wait, once the request is done this same call runs again, steering flags and all.
  const again = [
    name,
    ...rest.filter(
      (a, i) => a !== "--wait" && a !== "--request" && !a.startsWith("--request=") && !(rest[i - 1] === "--request" && !a.startsWith("--")),
    ),
  ];
  // `--request` alone asks for the build or the change; `--request "…"` adds comments to it.
  const asked = args.global.request !== undefined;
  const comments = typeof args.global.request === "string" ? args.global.request : undefined;

  if (!entry) {
    const failedLoad = broken.find((b) => b.dir === opFolder(name));
    if (failedLoad) return fail(`${name} does not load: ${failedLoad.error}`, EXIT.ERROR);
    // A mistyped name must not start a build: only --request asks for a new op.
    if (args.global.help || !asked) {
      const similar = similarNames(name, [...ops.keys()]).map((op) => ({ hint: "did you mean", cmd: `${cli} ${op} --help` }));
      return fail(`there is no op ${name}; add --request to have it built`, EXIT.USAGE, [
        ...similar,
        { hint: "what exists", cmd: `${cli} ops` },
        { hint: "to have it built, with anything the call doesn't say", cmd: `${commandLine(cli, call)} --request "…"` },
      ]);
    }
    const ctx = contexts.resolve(args.global.context as string | undefined);
    refuseInWorktree(env);
    const filed = requests.file({
      kind: "new",
      op: name,
      text: comments ?? `new op ${name}, first called as: ${commandLine(cli, call)}`,
      context: ctx.name,
      domain: domainRef(env.domain),
      call: { op: name, argv: call },
    });
    return filedOutcome(env, filed, wait, `no op ${name} yet`, again);
  }

  if (args.global.help) return ok(opHelp(cli, entry));
  const ctx = contexts.resolve(args.global.context as string | undefined);

  // A change may add flags the op doesn't take yet, so its example is filed as given, unchecked.
  if (asked) {
    refuseInWorktree(env);
    const filed = requests.file({
      kind: "change",
      op: name,
      text: comments ?? `change ${name}, called as: ${commandLine(cli, call)}`,
      context: ctx.name,
      domain: domainRef(env.domain),
      call: { op: name, argv: call },
    });
    return filedOutcome(env, filed, wait, `change to ${name}`, again);
  }

  // --input-json is how code (verify, a rerun) passes an example as it was recorded.
  const flags = args.global["input-json"] ? jsonFlags(String(args.global["input-json"])) : args.flags;
  const input = parseInput(cli, entry, flags);

  const outcome = await runOp(env, entry, input, ctx, {
    headed: args.global.headed === true,
    dryRun: args.global["dry-run"] === true,
    browser: args.global.browser === true,
    call,
  });
  if (outcome.exitCode === EXIT.PENDING && outcome.request && env.fileRepairs) {
    startWorker(env);
    if (wait !== undefined) return waitFor(env, outcome.request, wait, again);
  }
  return outcome;
};

/** A build worktree shares the ledger: an agent there must not file requests or start a worker on its branch. */
const refuseInWorktree = (env: Env, what = "requests are filed"): void => {
  if (isWorktree(env.domain)) raiseUsage(`${what} from the main checkout, not from the worktree ${env.domain.root}`);
};

const startWorker = (env: Env): void => {
  if (!isWorktree(env.domain)) ensureWorker(env.domain.home, env.entry);
};

/** `--wait [--timeout <seconds>]`, checked before anything is filed; undefined without --wait. */
const waitSeconds = (global: Record<string, string | boolean>): number | undefined => {
  const limit = global.timeout === undefined ? 60 * 60 : seconds(global.timeout);
  return global.wait ? limit : undefined;
};

const seconds = (raw: string | boolean): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : raiseUsage(`--timeout must be a positive number of seconds, got "${raw}"`);
};

const filedOutcome = async (env: Env, filed: RequestRecord, wait: number | undefined, why?: string, again?: string[]): Promise<Outcome> => {
  startWorker(env);
  if (wait !== undefined) return waitFor(env, filed.id, wait, again);
  return {
    ok: false,
    data: `request ${filed.id} filed${why ? `: ${why}` : ""}`,
    exitCode: EXIT.PENDING,
    request: filed.id,
    next: [{ hint: "check on it", cmd: `${env.cli} request:status ${filed.id} --wait` }],
  };
};

const statusOutcome = (env: Env, r: RequestRecord): Outcome => {
  const cli = env.cli;
  const lines = [
    `${r.id}: ${r.state}${r.stage && r.state === "building" ? ` (stage: ${r.stage})` : ""}`,
    `kind: ${r.kind}${r.op ? `, op: ${r.op}` : ""}, context: ${r.context}`,
    `asked: ${r.text}`,
  ];
  if (r.waitingFor) lines.push(`waiting for ${r.waitingFor}, which holds ${r.op}`);
  if (r.question) lines.push(`question: ${r.question}`);
  if (r.reason && r.reason !== r.result?.summary) lines.push(`reason: ${r.reason}`);
  if (r.result)
    lines.push(
      `result: ${r.result.summary}${r.result.command ? `\n  ${r.result.command}` : ""}${r.result.commit ? `\ncommit: ${r.result.commit}` : ""}`,
    );
  const usage = runUsage(env.domain.home, r.id);
  if (usage)
    lines.push(
      `took: ${formatDuration(usage.ms)}, ${formatCost(usage)} at list prices${usage.partial ? " (the running attempt's cost not counted yet)" : ""}`,
    );
  if (r.attempts > 0) lines.push(`run: awf runs ${r.id} --run-root ${runRoot(env.domain.home)}`);

  const next: NextHint[] = [];
  if (r.state === "blocked") next.push({ hint: "answer it", cmd: `${cli} request:answer ${r.id} "<answer>"` });
  if (r.state === "failed" || r.state === "deferred") next.push({ hint: "try again", cmd: `${cli} request:retry ${r.id}` });
  if (!isTerminal(r.state) && r.state !== "blocked") next.push({ hint: "wait for it", cmd: `${cli} request:status ${r.id} --wait` });
  if (r.state === "done" && r.call) next.push({ hint: "run the call", cmd: commandLine(cli, [...r.call.argv, "--context", r.context]) });
  if (r.state === "duplicate" && r.result?.command) next.push({ hint: "use the op that does it", cmd: r.result.command });
  if (r.state === "duplicate" && r.result?.of)
    next.push({ hint: "follow the request that builds it", cmd: `${cli} request:status ${r.result.of} --wait` });

  // A request still open is pending; one that ended is a plain result, failed or not.
  const pending = !isTerminal(r.state);
  const data = process.argv.includes("--json") ? r : lines.join("\n");
  return {
    ok: !pending && r.state !== "failed",
    data,
    exitCode: pending ? EXIT.PENDING : r.state === "failed" ? EXIT.ERROR : EXIT.OK,
    next,
  };
};

const jsonFlags = (text: string): Record<string, string | boolean | string[]> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return raiseUsage("--input-json is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raiseUsage("--input-json must be a JSON object");
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(String) : typeof value === "boolean" ? value : String(value),
    ]),
  );
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Block until the request finishes. With `again`, the call that filed it, that call runs once the
 * request is done; any other ending means it never ran, which is not a success.
 */
const waitFor = async (env: Env, id: string, seconds: number, again?: string[]): Promise<Outcome> => {
  const deadline = Date.now() + seconds * 1000;
  // The request, then a row per stage of its run, the running one with what its agents are doing.
  // On a terminal the block is redrawn in place each poll; in a log, a line is printed once, when it
  // first appears or what it says changes.
  const live = process.stderr.isTTY;
  const color = live && !process.env.NO_COLOR;
  const paint = (code: string, text: string) => (color && text ? `\x1b[${code}m${text}\x1b[0m` : text);
  let drawn = 0;
  let frame = 0;
  let last: { text: string; key: string }[] = [];
  const printed = new Set<string>();
  const draw = () => {
    const width = (process.stderr.columns || 120) - 1;
    const lines = last.map(({ text }, i) => {
      const line = text.length > width ? `${text.slice(0, width - 1)}…` : text;
      // The request: its id, state, op (magenta) and what was asked (grey).
      if (i === 0) {
        const [, id = "", state = "", op = "", asked = ""] = /^(\S+) · (.*?) · (\S+:)(.*)$/.exec(line) ?? [];
        return id ? `${paint("1", id)} · ${state} · ${paint("35", op)}${paint("90", asked)}` : paint("1", line);
      }
      // A stage row: its mark, name and time, then what its agents are doing.
      const [, mark = "", rest = "", doing = ""] = /^ {2}(\S) (.*?)((?: · .*)?)$/.exec(line) ?? [];
      const sign =
        mark === "▸"
          ? paint("36", SPINNER[frame % SPINNER.length]!)
          : mark === "✓"
            ? paint("32", mark)
            : mark === "✗"
              ? paint("31", mark)
              : mark;
      return `  ${sign} ${mark === "▸" ? paint("1", rest) : rest}${paint("2", doing)}`;
    });
    process.stderr.write(`${drawn ? `\x1b[${drawn}F\x1b[J` : ""}${lines.map((l) => `${l}\n`).join("")}`);
    drawn = lines.length;
  };
  const show = (rows: { text: string; key: string }[]) => {
    last = rows;
    if (live) return draw();
    for (const r of rows.filter((r) => !printed.has(r.key))) {
      printed.add(r.key);
      process.stderr.write(`${r.text}\n`);
    }
  };
  // The spinner turns between polls.
  const ticker = live
    ? setInterval(() => {
        frame++;
        if (last.length) draw();
      }, 100)
    : undefined;
  try {
    for (;;) {
      const r = env.requests.get(id)!;
      const state = `${r.state}${r.stage && r.state !== "building" ? ` (${r.stage})` : ""}`;
      const rows = r.attempts > 0 || r.state === "building" ? ((await runActivity(env.domain.home, id)) ?? []) : [];
      const what = `${r.op ?? r.kind}: ${r.text.replace(/\s+/g, " ")}`;
      show([
        { text: `${id} · ${state} · ${what}`, key: `${id} ${state}` },
        ...rows.map((row) => ({ text: `  ${row.text}`, key: row.key })),
      ]);
      if (r.state === "done" && again) return rerun(env, r, again);
      if (isTerminal(r.state) || r.state === "blocked") {
        const status = statusOutcome(env, r);
        if (!again || r.state === "blocked") return status;
        return {
          ...status,
          ok: false,
          error: `${id} ended ${r.state}${r.reason ? `: ${r.reason}` : ""}; the call did not run`,
          exitCode: EXIT.ERROR,
        };
      }
      if (Date.now() > deadline) {
        return fail(`gave up waiting for ${id} after ${seconds}s; it is ${state}`, EXIT.TIMEOUT, [
          { hint: "keep waiting", cmd: `${env.cli} request:status ${id} --wait` },
        ]);
      }
      // A worker that died is started again by whoever is waiting on it.
      startWorker(env);
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.XCLI_POLL_MS ?? 2000)));
    }
  } finally {
    clearInterval(ticker);
  }
};

/** Run the call again in a fresh process, which loads the op as merged. */
const rerun = async (env: Env, r: RequestRecord, again: string[]): Promise<never> => {
  process.stderr.write(`${r.id} done; running ${commandLine(env.cli, again)}\n`);
  const child = Bun.spawn([...env.entry, ...again], { stdio: ["inherit", "inherit", "inherit"] });
  process.exit(await child.exited);
};

/** An op's last run, as `x ops` shows it: only a failure that wasn't the input's, the app's or the session's is "failed". */
const lastResult = (last: HistoryLine): string => {
  if (last.ok) return "ok";
  const at = last.step ? ` at "${last.step}"` : "";
  if (last.exit === EXIT.REFUSED) return `refused by the app${at}`;
  if (last.exit === EXIT.USAGE) return `bad input${at}`;
  if (last.exit === EXIT.PRECONDITION) return `not run: ${last.error ?? "a precondition"}`;
  return `failed${at}`;
};

const listOps = async (env: Env): Promise<Outcome> => {
  const { ops, broken } = await loadOps(env.domain);
  const open = env.requests.list().filter((r) => r.op && !isTerminal(r.state));
  const rows = [...ops.values()].map((entry) => {
    const last = lastRun(entry);
    const repair = env.requests.brokenBy(entry.name);
    const pending = open.filter((r) => r.op === entry.name).map((r) => `${r.id} ${r.kind} ${r.state}`);
    return {
      op: entry.name,
      description: entry.definition.description,
      last: last ? `${lastResult(last)} ${ago(last.at)} on ${last.context}` : "never run",
      status: repair ? `broken (${repair.id})` : pending.join(", ") || "",
    };
  });
  const missing = open
    .filter((r) => r.op && !ops.has(r.op))
    .map((r) => ({ op: r.op!, description: "(not built yet)", last: "", status: `${r.id} ${r.kind} ${r.state}` }));
  const all = [...rows, ...missing];
  if (process.argv.includes("--json")) return ok({ ops: all, broken });
  if (all.length === 0 && broken.length === 0) return ok("no ops yet");
  const width = Math.max(...all.map((r) => r.op.length), 4);
  const lines = all.map((r) => `${r.op.padEnd(width)}  ${r.last.padEnd(34)} ${r.status}`.trimEnd());
  for (const b of broken) lines.push(`${b.dir}: does not load: ${b.error}`);
  return ok(lines.join("\n"));
};
