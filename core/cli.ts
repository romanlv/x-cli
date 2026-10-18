// The whole interface: commands in, text or the --json envelope out. A domain's entry point calls
// `main(domain)`; nothing here knows which app the domain drives.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatCost, runActivity, runRoot, runUsage, stopRun, sumUsage } from "./awf";
import { keepSignedIn, signIn } from "./browser";
import { Contexts } from "./contexts";
import { savedCredentials } from "./credentials";
import type { Domain } from "./domain";
import { envName, envNumber, envOverride, envValue } from "./env";
import { InputError, OpError, outcomeOf, PreconditionError, raise } from "./errors";
import { isCliNoun, kebab, OP_NAME, opFolder } from "./names";
import { commandLine, domainRef, type HistoryLine, lastRun, loadOps, type OpEntry, opHelp, parseInput, type RunEnv, runOp } from "./ops";
import { ago, EXIT, fail, finish, firstLine, formatDuration, guardStdout, type NextHint, type Outcome, ok } from "./output";
import { isTerminal, RETRYABLE, type RequestRecord, type RequestState, Requests } from "./requests";
import { pageCommand, pageCommandsOf, runSessionDaemon, sessionContext } from "./session";
import { requestLines, stateOf, statusBoard } from "./watch";
import { ensureWorker, runWorker } from "./worker";

/**
 * Flags every command understands; the rest belong to the op being called, or to the command
 * (`requests --state`, `page --session`). An op can't take one of these: `callOp` refuses it.
 */
const GLOBAL_BOOLEANS = new Set(["json", "headed", "dry-run", "wait", "help", "browser"]);
const GLOBAL_VALUES = new Set(["context", "request", "timeout", "input-json"]);

interface ParsedArgs {
  positionals: string[];
  global: Record<string, string | boolean>;
  flags: Record<string, string | boolean | string[]>;
}

const flagKey = (arg: string): string => arg.slice(2).split("=")[0]!;

/** Does the flag at `argv[i]` take the next argument as its value? Not a boolean, nor one followed by a flag. */
const takesValue = (argv: string[], i: number, booleans: Set<string>): boolean => {
  const key = flagKey(argv[i]!);
  return (
    !argv[i]!.includes("=") && !GLOBAL_BOOLEANS.has(key) && !booleans.has(key) && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")
  );
};

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
    if (!arg.startsWith("--")) {
      out.positionals.push(arg);
      continue;
    }
    const key = flagKey(arg);
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : takesValue(argv, i, booleans) ? argv[++i]! : true;
    if (GLOBAL_BOOLEANS.has(key) || GLOBAL_VALUES.has(key)) {
      out.global[key] = value;
    } else {
      const prior = out.flags[key];
      out.flags[key] = prior === undefined ? value : ([] as (string | boolean)[]).concat(prior, value).map(String);
    }
  }
  return out;
};

/** `argv` without the flags `drop` names, and their values. */
const stripFlags = (argv: string[], drop: Set<string>, booleans: Set<string>): string[] => {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      kept.push(...argv.slice(i));
      break;
    }
    if (!arg.startsWith("--")) {
      kept.push(arg);
      continue;
    }
    const end = takesValue(argv, i, booleans) ? i + 1 : i;
    if (!drop.has(flagKey(arg))) kept.push(...argv.slice(i, end + 1));
    i = end;
  }
  return kept;
};

/** Flags that steer this call rather than describe the task: left out of the call a request keeps. */
const CONTROL_FLAGS = new Set(["json", "wait", "request", "timeout", "context", "headed", "browser", "help"]);

/** The caller's own call, minus the flags that steer it; `--dry-run` stays, so a re-run stays one. */
export const callOf = (name: string, rest: string[], booleans: Set<string>): string[] => [
  name,
  ...stripFlags(rest, CONTROL_FLAGS, booleans),
];

interface Env extends RunEnv {
  /** How to run this CLI again: for the worker, a session daemon, or a call after --wait. */
  entry: string[];
  /** A build's worktree shares the ledger: an agent there must not file requests or start a worker on its branch. */
  worktree: boolean;
}

export const main = async (domain: Domain, argv = process.argv.slice(2)): Promise<never> => {
  guardStdout();
  // The worker, its runs and their browser server are other processes: they read the browser from here.
  if (domain.browserChannel) process.env[envName("BROWSER_CHANNEL")] ??= domain.browserChannel;
  const json = argv.includes("--json");
  const git = join(domain.root, ".git");
  const worktree = domain.worktree ?? (existsSync(git) && statSync(git).isFile());
  const env: Env = {
    domain,
    contexts: new Contexts(domain.home, domain.name),
    requests: new Requests(domain.home),
    fileRepairs: !worktree && !envValue("NO_REPAIRS"),
    entry: [process.execPath, process.argv[1]!],
    worktree,
  };
  try {
    return await finish(await dispatch(env, argv), { json });
  } catch (err) {
    if (err instanceof OpError) return finish(outcomeOf(err), { json });
    const error = err instanceof Error ? err : new Error(String(err));
    return finish(fail(`${error.message}\n${(error.stack ?? "").split("\n").slice(1, 6).join("\n")}`), { json });
  }
};

const dispatch = async (env: Env, argv: string[]): Promise<Outcome> => {
  const command = argv[0] !== undefined && !argv[0].startsWith("-") ? argv[0] : undefined;
  const rest = command === undefined ? argv : argv.slice(1);
  const cli = env.domain.name;

  if (command === undefined || command === "help") {
    const { ops } = await loadOps(env.domain);
    const text = usage(env, ops);
    return command === "help" || rest.includes("--help") || rest.includes("-h")
      ? ok(text)
      : fail(`no command given\n\n${text}`, EXIT.USAGE);
  }

  // Ops parse their own flags by their schema, so booleans are known before the rest is read.
  if (OP_NAME.test(command) && !isCliNoun(command)) return callOp(env, command, rest);

  const args = parseArgs(rest);
  const found = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (found?.help && args.global.help) return ok(["Usage:", ...helpLines(found, env.domain).map((line) => `  ${cli} ${line}`)].join("\n"));
  if (found) return found.run(env, args);

  if (command === "page" || command.startsWith("page:")) {
    if (!(command in pageCommandsOf(env.domain))) return fail(`unknown page command ${command}; see ${cli} help`, EXIT.USAGE);
    const session = flag(args, "session") ?? envValue("SESSION") ?? "default";
    // A running session keeps its context; only an explicit --context can disagree with it.
    const ctx = env.contexts.resolve(contextFlag(args) ?? sessionContext(env.domain.home, session));
    return pageCommand(env.domain, env.entry, { session, context: ctx, headed: args.global.headed === true }, command, args.positionals);
  }

  return fail(`unknown command "${command}"; ops are noun:verb, such as posts:search. See ${cli} help`, EXIT.USAGE);
};

interface Command {
  /** Where `help` lists it, and its lines there after the CLI's name; unset for one the CLI runs itself. */
  help?: { section: keyof typeof SECTIONS; lines: string[] | ((domain: Domain) => string[]) };
  run(env: Env, args: ParsedArgs): Promise<Outcome> | Outcome;
}

/** `help`'s sections, in order: a heading, and lines that aren't a command's. */
const SECTIONS = {
  ops: {
    heading: "Ops are noun:verb. To ask for one that doesn't exist yet, call it with the flags it should take and --request.",
    lines: ["<op> --help              its flags, from its spec"],
  },
  requests: { heading: "Requests: every change to the tool goes through one, worked by an agent workflow.", lines: [] },
  contexts: {
    heading: "Contexts: one per call (an account or tenant, and its sign-in), the current one unless --context names another.",
    lines: [],
  },
};

/** A command's lines in `help`; some depend on what the domain offers. */
const helpLines = (command: Command, domain: Domain): string[] =>
  typeof command.help?.lines === "function" ? command.help.lines(domain) : (command.help?.lines ?? []);

const usage = (env: Env, ops: Map<string, OpEntry>): string => {
  const cli = env.domain.name;
  const byNoun = new Map<string, OpEntry[]>();
  for (const entry of ops.values()) {
    const noun = entry.name.split(":")[0]!;
    byNoun.set(noun, [...(byNoun.get(noun) ?? []), entry]);
  }
  const opLines = [...byNoun.entries()].flatMap(([noun, entries]) => [
    `  ${noun}`,
    ...entries.map((e) => `    ${e.name.padEnd(28)} ${e.definition.description}`),
  ]);
  const sections = Object.entries(SECTIONS).flatMap(([section, { heading, lines }]) => [
    heading,
    ...[...lines, ...Object.values(COMMANDS).flatMap((c) => (c.help?.section === section ? helpLines(c, env.domain) : []))].map(
      (l) => `  ${cli} ${l}`,
    ),
    "",
  ]);
  const pageLines = Object.entries(pageCommandsOf(env.domain)).map(([name, c]) => `  ${name.padEnd(30)} ${c.usage}`);
  return [
    `Usage: ${cli} <command> [flags]`,
    "",
    "Ops:",
    ...(opLines.length ? opLines : ["  none yet: ask for one with a request"]),
    "",
    ...sections,
    `Exploring: a named session (--session or ${envName("SESSION")}) stays open between calls.`,
    ...pageLines,
    "",
    "--json prints { ok, data, error, next }. Exit: 0 done, 1 error, 2 bad input, 3 precondition,",
    "4 refused, 5 request pending, 6 --wait gave up.",
  ].join("\n");
};

const need = (value: string | undefined, what: string): string => value ?? raise(new InputError(`give ${what}`));
const flag = (args: ParsedArgs, name: string): string | undefined => (typeof args.flags[name] === "string" ? args.flags[name] : undefined);
const contextFlag = (args: ParsedArgs): string | undefined => args.global.context as string | undefined;

// ── Contexts ──────────────────────────────────────────────────────────────────────────────────────

const listContexts = (env: Env): Outcome => {
  const { contexts } = env;
  const { current, contexts: all } = contexts.list();
  if (all.length === 0) return ok("no contexts yet", [{ hint: "add one", cmd: `${env.domain.name} context:add <name> --url <url>` }]);
  const width = Math.max(...all.map((c) => c.name.length));
  const rows = all.map((c) => {
    const state = !contexts.isSignedIn(c) ? "signed out" : `signed in, ${ago(c.signedInAt ?? c.addedAt)}`;
    return `${c.name === current ? "*" : " "} ${c.name.padEnd(width)}   ${c.url}   ${state}`;
  });
  const data = { current, contexts: all.map(({ authFile, ...c }) => ({ ...c, signedIn: contexts.isSignedIn({ ...c, authFile }) })) };
  return ok(data, undefined, rows.join("\n"));
};

const addContext = (env: Env, args: ParsedArgs): Outcome => {
  const name = need(args.positionals[0], "a context name");
  const added = env.contexts.add(name, flag(args, "url") ?? raise(new InputError("give --url <url>")));
  return ok(`context ${added.name}: ${added.url}`, [{ hint: "sign in", cmd: `${env.domain.name} context:login ${added.name}` }]);
};

const login = async (env: Env, args: ParsedArgs): Promise<Outcome> => {
  const cli = env.domain.name;
  const ctx = env.contexts.resolve(args.positionals[0] ?? contextFlag(args));
  const timeoutMs = args.global.timeout === undefined ? undefined : seconds(args.global.timeout) * 1000;
  // Only a domain that can submit its sign-in form takes a username and password.
  const saved = env.domain.submitSignIn ? savedCredentials(env.domain.root, ctx.name) : undefined;
  const username = flag(args, "username") ?? saved?.username;
  const password = flag(args, "password") ?? saved?.password;
  if (password !== undefined && username === undefined) throw new InputError("give --username with the password");
  if (username !== undefined && !password) throw new InputError(`give the password: --password, or PASSWORD in .env.${ctx.name}`);
  // Agents work in worktrees and never sign in; a person's credentials stay with the person.
  if (username !== undefined) refuseInWorktree(env, "a person signs in with a password");
  const credentials = username !== undefined ? { username, password: password! } : undefined;
  await signIn(env.domain, env.contexts, ctx, { timeoutMs, headless: !!envValue("HEADLESS_LOGIN"), credentials });
  const continued = env.requests.signedIn(ctx.name);
  if (continued.length === 0) return ok(`signed in to ${ctx.name}`);
  startWorker(env);
  return ok(
    `signed in to ${ctx.name}; continued ${continued.join(", ")}`,
    continued.map((id) => ({ hint: "check on it", cmd: `${cli} request:status ${id} --wait` })),
  );
};

// ── Requests ──────────────────────────────────────────────────────────────────────────────────────

const fileRequest = (env: Env, args: ParsedArgs): Promise<Outcome> => {
  const text = need(args.positionals[0], `what you need, in quotes: ${env.domain.name} request "the replies under a post"`);
  if (text.startsWith("-")) throw new InputError(`"${text}" looks like a flag, not a request; say what you need in quotes`);
  const ctx = env.contexts.resolve(contextFlag(args));
  const wait = waitSeconds(args.global);
  refuseInWorktree(env);
  const filed = env.requests.file({ kind: "intake", text, context: ctx.name, domain: domainRef(env.domain) });
  return filedOutcome(env, filed, wait);
};

const listRequests = (env: Env, args: ParsedArgs): Outcome => {
  const state = flag(args, "state") as RequestState | undefined;
  const list = env.requests.list({ state });
  const usage = new Map(list.map((r) => [r.id, runUsage(env.domain.home, r.id)]));
  const data = list.map((r) => ({ ...r, usage: usage.get(r.id) }));
  if (list.length === 0) return ok(data, undefined, state ? `no ${state} requests` : "no requests yet");
  const rows = list.map((r) => {
    const u = usage.get(r.id);
    const took = u ? `${formatCost(u).padStart(7)} ${formatDuration(u.ms).padStart(6)}` : " ".repeat(14);
    return `${r.id}  ${r.state.padEnd(9)} ${(r.op ?? r.kind).padEnd(22)} ${took}  ${ago(r.updatedAt).padEnd(8)} ${firstLine(r.text, 70)}`;
  });
  const total = sumUsage([...usage.values()]);
  return ok(data, undefined, [...rows, `total ${formatCost(total)} at list prices, ${formatDuration(total.ms)} of runs`].join("\n"));
};

const requestStatus = (env: Env, args: ParsedArgs): Promise<Outcome> | Outcome => {
  const record = getRequest(env, args.positionals[0]);
  // Waiting here follows the request; only the call that filed it runs again once it is done.
  if (args.global.wait) return waitFor(env, record.id, waitSeconds(args.global)!);
  return statusOutcome(env, record);
};

const answerRequest = (env: Env, args: ParsedArgs): Outcome => {
  const record = getRequest(env, args.positionals[0]);
  refuseInWorktree(env);
  const answered = env.requests.answer(record.id, need(args.positionals[1], "the answer, in quotes"));
  startWorker(env);
  return ok(`${answered.id} answered; its run continues`, [checkOnIt(env, answered.id)]);
};

const retryRequest = (env: Env, args: ParsedArgs): Outcome => {
  const record = getRequest(env, args.positionals[0]);
  refuseInWorktree(env);
  const retried = env.requests.retry(record.id);
  startWorker(env);
  return ok(`${retried.id} is back in the queue`, [checkOnIt(env, retried.id)]);
};

const cancelRequest = async (env: Env, args: ParsedArgs): Promise<Outcome> => {
  const record = getRequest(env, args.positionals[0]);
  refuseInWorktree(env);
  const cancelled = env.requests.cancel(record.id, args.positionals[1] ?? "cancelled");
  await stopRun(cancelled);
  return ok(`${cancelled.id} cancelled`, [{ hint: "take it up again", cmd: `${env.domain.name} request:retry ${cancelled.id}` }]);
};

const work = async (env: Env): Promise<Outcome> => {
  const { domain, contexts } = env;
  await runWorker(domain.home, domain.root, {
    maxRunning: envNumber("MAX_RUNNING", domain.maxRunning ?? 2),
    runTimeout: envValue("RUN_TIMEOUT"),
    signInEveryMs: envOverride("KEEP_ALIVE_SIGN_IN_MS", domain.keepAlive?.signInEveryMs),
    // Signed out, a person who left their sign-in in .env.<context> needn't come back for it.
    keepSignedIn: async (name) => {
      const ctx = contexts.list().contexts.find((c) => c.name === name);
      return !!ctx && (await keepSignedIn(domain, contexts, ctx));
    },
  });
  return ok("worker done");
};

const COMMANDS: Record<string, Command> = {
  ops: {
    help: { section: "ops", lines: ["ops                      what exists, each op's last result and any open request"] },
    run: (env) => listOps(env),
  },
  request: {
    help: {
      section: "requests",
      lines: [
        `request "<what you need>"   ask for a new op or a change`,
        `<op> ... --request ["…"]   a new op, or a change to one; the call is the example`,
      ],
    },
    run: fileRequest,
  },
  requests: { help: { section: "requests", lines: ["requests [--state building]"] }, run: listRequests },
  "request:status": { help: { section: "requests", lines: ["request:status <id> [--wait]"] }, run: requestStatus },
  "request:answer": { help: { section: "requests", lines: [`request:answer <id> "<answer>"`] }, run: answerRequest },
  "request:retry": {
    help: { section: "requests", lines: ["request:retry <id>   a failed, deferred or cancelled one, back in the queue"] },
    run: retryRequest,
  },
  "request:cancel": {
    help: { section: "requests", lines: [`request:cancel <id> ["<why>"]   stop it, and its run if one is going`] },
    run: cancelRequest,
  },
  "request:worker": { run: work },
  contexts: { help: { section: "contexts", lines: ["contexts"] }, run: listContexts },
  "context:add": { help: { section: "contexts", lines: ["context:add <name> --url <url>"] }, run: addContext },
  "context:login": {
    help: {
      section: "contexts",
      lines: (domain) => [
        "context:login <name>        a person signs in, in a browser window",
        ...(domain.submitSignIn ? ["context:login <name> --username <u> --password <p>   or headless; .env.<name> can hold both"] : []),
      ],
    },
    run: login,
  },
  "context:use": {
    help: { section: "contexts", lines: ["context:use <name>"] },
    run: (env, args) => ok(`using ${env.contexts.use(need(args.positionals[0], "a context name")).name}`),
  },
  "context:remove": {
    help: { section: "contexts", lines: ["context:remove <name>"] },
    run: (env, args) => {
      const name = need(args.positionals[0], "a context name");
      env.contexts.remove(name);
      return ok(`removed ${name}`);
    },
  },
  "page:daemon": {
    run: async (env, args) => {
      const ctx = env.contexts.resolve(contextFlag(args));
      await runSessionDaemon(env.domain, env.contexts, String(flag(args, "session")), ctx, args.global.headed === true);
      // The daemon serves until it is closed or idle; it exits itself.
      return new Promise<never>(() => {});
    },
  },
};

const getRequest = (env: Env, id: string | undefined): RequestRecord => {
  const record = env.requests.get(need(id, "a request id, such as R-0012"));
  return record ?? raise(new PreconditionError(`no request ${id}`, [{ hint: "list them", cmd: `${env.domain.name} requests` }]));
};

const checkOnIt = (env: Env, id: string): NextHint => ({ hint: "check on it", cmd: `${env.domain.name} request:status ${id} --wait` });

/** Up to three names a typo of `name` could have meant: the same noun, or two edits away. */
const similarNames = (name: string, names: string[]): string[] => {
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
  const { contexts, requests } = env;
  const cli = env.domain.name;
  const { ops, broken } = await loadOps(env.domain);
  const entry = ops.get(name);
  const inputs = Object.entries(entry?.definition.input.properties ?? {});
  // A global flag would never reach the op, so an op that takes one is refused rather than run without it.
  const taken = inputs.map(([key]) => kebab(key)).filter((f) => GLOBAL_BOOLEANS.has(f) || GLOBAL_VALUES.has(f));
  if (taken.length > 0)
    return fail(`${name} takes ${taken.map((f) => `--${f}`).join(", ")}, which every command takes for itself; rename it in its op.ts`);
  const booleans = new Set(inputs.filter(([, s]) => (s as { type?: string }).type === "boolean").map(([key]) => kebab(key)));
  const args = parseArgs(rest, booleans);
  const wait = waitSeconds(args.global);
  const call = callOf(name, rest, booleans);
  // With --wait, once the request is done this same call runs again, steering flags and all.
  const again = [name, ...stripFlags(rest, new Set(["wait", "request"]), booleans)];
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
    const ctx = contexts.resolve(contextFlag(args));
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
  const ctx = contexts.resolve(contextFlag(args));

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

const refuseInWorktree = (env: Env, what = "requests are filed"): void => {
  if (env.worktree) throw new InputError(`${what} from the main checkout, not from the worktree ${env.domain.root}`);
};

const startWorker = (env: Env): void => {
  if (!env.worktree) ensureWorker(env.domain.home, env.entry);
};

/** `--wait [--timeout <seconds>]`, checked before anything is filed; undefined without --wait. */
const waitSeconds = (global: Record<string, string | boolean>): number | undefined => {
  const limit = global.timeout === undefined ? 60 * 60 : seconds(global.timeout);
  return global.wait ? limit : undefined;
};

const seconds = (raw: string | boolean): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0
    ? value
    : raise(new InputError(`--timeout must be a positive number of seconds, got "${raw}"`));
};

const filedOutcome = async (env: Env, filed: RequestRecord, wait: number | undefined, why?: string, again?: string[]): Promise<Outcome> => {
  startWorker(env);
  if (wait !== undefined) return waitFor(env, filed.id, wait, again);
  return {
    ok: false,
    data: `request ${filed.id} filed${why ? `: ${why}` : ""}`,
    exitCode: EXIT.PENDING,
    request: filed.id,
    next: [checkOnIt(env, filed.id)],
  };
};

const statusOutcome = (env: Env, r: RequestRecord): Outcome => {
  const cli = env.domain.name;
  const lines = [`${r.id}: ${stateOf(r)}`, `kind: ${r.kind}${r.op ? `, op: ${r.op}` : ""}, context: ${r.context}`, `asked: ${r.text}`];
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
  if (RETRYABLE.includes(r.state)) next.push({ hint: "try again", cmd: `${cli} request:retry ${r.id}` });
  if (!isTerminal(r.state) && r.state !== "blocked") next.push({ hint: "wait for it", cmd: `${cli} request:status ${r.id} --wait` });
  if (r.state === "done" && r.call) next.push({ hint: "run the call", cmd: commandLine(cli, [...r.call.argv, "--context", r.context]) });
  if (r.state === "duplicate" && r.result?.command) next.push({ hint: "use the op that does it", cmd: r.result.command });
  if (r.state === "duplicate" && r.result?.of)
    next.push({ hint: "follow the request that builds it", cmd: `${cli} request:status ${r.result.of} --wait` });

  // A request still open is pending; one that ended is a plain result, failed or not.
  const pending = !isTerminal(r.state);
  return {
    ok: !pending && r.state !== "failed",
    data: r,
    text: lines.join("\n"),
    exitCode: pending ? EXIT.PENDING : r.state === "failed" ? EXIT.ERROR : EXIT.OK,
    next,
  };
};

const jsonFlags = (text: string): Record<string, string | boolean | string[]> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InputError("--input-json is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InputError("--input-json must be a JSON object");
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(String) : typeof value === "boolean" ? value : String(value),
    ]),
  );
};

/**
 * Block until the request finishes, showing its run as it goes. With `again`, the call that filed
 * it, that call runs once the request is done; any other ending means it never ran, which is not a success.
 */
const waitFor = async (env: Env, id: string, seconds: number, again?: string[]): Promise<Outcome> => {
  const deadline = Date.now() + seconds * 1000;
  const board = statusBoard();
  try {
    for (;;) {
      const r = env.requests.get(id)!;
      const stages = r.attempts > 0 || r.state === "building" ? ((await runActivity(env.domain.home, id)) ?? []) : [];
      board.show(requestLines(r, stages));
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
        return fail(`gave up waiting for ${id} after ${seconds}s; it is ${stateOf(r)}`, EXIT.TIMEOUT, [
          { hint: "keep waiting", cmd: `${env.domain.name} request:status ${id} --wait` },
        ]);
      }
      // A worker that died is started again by whoever is waiting on it.
      startWorker(env);
      await Bun.sleep(envNumber("POLL_MS", 2000));
    }
  } finally {
    board.stop();
  }
};

/** Run the call again in a fresh process, which loads the op as merged. */
const rerun = async (env: Env, r: RequestRecord, again: string[]): Promise<never> => {
  process.stderr.write(`${r.id} done; running ${commandLine(env.domain.name, again)}\n`);
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
  if (all.length === 0 && broken.length === 0) return ok({ ops: all, broken }, undefined, "no ops yet");
  const width = Math.max(...all.map((r) => r.op.length), 4);
  const lines = all.map((r) => `${r.op.padEnd(width)}  ${r.last.padEnd(34)} ${r.status}`.trimEnd());
  for (const b of broken) lines.push(`${b.dir}: does not load: ${b.error}`);
  return ok({ ops: all, broken }, undefined, lines.join("\n"));
};
