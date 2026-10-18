// Operations: one task as a folder of plain files, run as code. Nothing here calls a model; a failure
// the op is to blame for becomes a repair request, and anything else an error that says what to do.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { Static, TObject, TSchema } from "typebox";
import Value from "typebox/value";
import { type OpenBrowser, openSignedIn, signedInContext, signInStateOf } from "./browser";
import { type Context, type ContextRef, type Contexts, loginHint } from "./contexts";
import { type DirectContext, type FellBack, tryDirect } from "./direct";
import type { Domain } from "./domain";
import { DryRunReached, InputError, isBrowserFailure, OpError, outcomeOf } from "./errors";
import { isCliNoun, kebab, OP_NAME, opFolder } from "./names";
import { formatNetwork, type NetworkEntry } from "./network";
import { EXIT, fail, firstLine, type Outcome, plain, progress } from "./output";
import type { DomainRef, Requests } from "./requests";
import { formatSnapshot, takeSnapshot } from "./snapshot";
import { appendJsonLine, readJsonLines, timestamp, writeJson } from "./store";

export interface OpContext<Helpers> {
  /** The domain's helper library. */
  app: Helpers;
  page: Page;
  /** A named step: progress while it runs, and a failure names it. */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  context: ContextRef;
  dryRun: boolean;
}

export interface OpDefinition<I extends TObject = TObject, O extends TSchema = TSchema, Helpers = unknown> {
  name: string;
  /** One line for `help`. */
  description: string;
  input: I;
  output: O;
  run(ctx: OpContext<Helpers>, input: Static<I>): Promise<Static<O>>;
  /**
   * The op without a browser, through the app's own calls. Tried first; when it throws, the op runs
   * in the browser and, run by a person, files a repair of this. In a worktree its failure stands.
   */
  direct?(ctx: DirectContext, input: Static<I>): Promise<Static<O>>;
  /** Text for a person; `key: value` lines by default. */
  format?(output: Static<O>): string;
}

/** A domain binds its helper type once: `export const defineOp = defineOpFor<AppHelpers>()`. */
export const defineOpFor =
  <Helpers>() =>
  <I extends TObject, O extends TSchema>(definition: OpDefinition<I, O, Helpers>): OpDefinition<I, O, Helpers> =>
    definition;

export interface OpEntry {
  name: string;
  dir: string;
  definition: OpDefinition<TObject, TSchema, unknown>;
}

type BuildError = { message: string; errors?: BuildError[]; position?: { file: string; line: number; column: number } };

/** Bun's build errors keep the line in `position`, and several of them in `errors`; the message alone has neither. */
const loadError = (err: unknown): string => {
  const e = err as BuildError;
  const first = e.errors?.[0] ?? e;
  const at = first.position ? ` at ${first.position.file}:${first.position.line}:${first.position.column}` : "";
  return first === e ? `${e.message}${at}` : `${e.message}; the first: ${first.message}${at}`;
};

/** Every op under `<domain>/ops/`, by name. A folder that fails to load is reported, not skipped silently. */
export const loadOps = async (domain: Domain): Promise<{ ops: Map<string, OpEntry>; broken: { dir: string; error: string }[] }> => {
  const opsDir = join(domain.dir, "ops");
  const ops = new Map<string, OpEntry>();
  const broken: { dir: string; error: string }[] = [];
  if (!existsSync(opsDir)) return { ops, broken };
  for (const folder of readdirSync(opsDir).sort()) {
    const file = join(opsDir, folder, "op.ts");
    if (!existsSync(file)) continue;
    try {
      const definition = (await import(file)).default as OpDefinition<TObject, TSchema, unknown>;
      if (!definition?.name || !OP_NAME.test(definition.name) || opFolder(definition.name) !== folder) {
        throw new Error(`op.ts must export defineOp({ name: "<noun>:<verb>" }) matching its folder ${folder}`);
      }
      if (isCliNoun(definition.name)) throw new Error(`the noun of ${definition.name} is the CLI's own`);
      if (definition.direct && domain.directCalls === false) {
        throw new Error(`${definition.name} has a direct way, but ${domain.name} ops make no calls of their own (directCalls: false)`);
      }
      ops.set(definition.name, { name: definition.name, dir: join(opsDir, folder), definition });
    } catch (err) {
      broken.push({ dir: folder, error: loadError(err) });
    }
  }
  return { ops, broken };
};

const allowedValues = (schema: TSchema): string[] | undefined => {
  const s = schema as { enum?: unknown[]; anyOf?: { const?: unknown }[]; const?: unknown };
  if (s.enum) return s.enum.map(String);
  if (s.anyOf?.every((branch) => branch.const !== undefined)) return s.anyOf.map((b) => String(b.const));
  return undefined;
};

/** Text for `<op> --help`, from the op's own schema, so a new op documents itself. */
export const opHelp = (cli: string, entry: OpEntry, { readOnly = false } = {}): string => {
  const { input, output, description } = entry.definition;
  const required = new Set(input.required ?? []);
  const flags = Object.entries(input.properties).map(([key, schema]) => {
    const s = schema as TSchema & { description?: string; type?: string };
    const values = allowedValues(s);
    const type = values ? values.join("|") : s.type === "boolean" ? "" : `<${s.type ?? "value"}>`;
    return `  --${kebab(key)}${type ? ` ${type}` : ""}${required.has(key) ? "" : " (optional)"}${s.description ? `  ${s.description}` : ""}`;
  });
  const outputs = Object.keys((output as { properties?: object }).properties ?? {});
  return [
    `Usage: ${cli} ${entry.name} [flags]`,
    "",
    description,
    "",
    "Flags:",
    ...flags,
    "",
    "Every op also takes:",
    "  --context <name>   run against this context instead of the current one",
    ...(readOnly ? [] : ["  --dry-run          stop before the last submit, with a screenshot of the filled form"]),
    "  --headed           show the browser",
    ...(entry.definition.direct ? ["  --browser          skip the direct way, which runs without a browser, and run it in one"] : []),
    `  --request "<text>" file a change to this op; the rest of the call is its example`,
    "  --wait             with --request, or when a request is filed: wait for it, then run the call",
    "  --json             print the { ok, data, error, next } envelope",
    outputs.length ? `\nOutput: ${outputs.join(", ")}` : "",
  ].join("\n");
};

/** Flags (`--first Ada --dry-run`) to the op's input, converted by its schema and checked. */
export const parseInput = (cli: string, entry: OpEntry, flags: Record<string, string | boolean | string[]>): Record<string, unknown> => {
  const { input } = entry.definition;
  const byFlag = new Map(Object.keys(input.properties).map((key) => [kebab(key), key]));
  const raw: Record<string, unknown> = {};
  for (const [flag, value] of Object.entries(flags)) {
    const key = byFlag.get(flag) ?? (flag in input.properties ? flag : undefined);
    if (!key) {
      throw new InputError(`${entry.name} has no flag --${flag} (flags: ${[...byFlag.keys()].map((f) => `--${f}`).join(", ") || "none"})`, [
        { hint: "see its flags", cmd: `${cli} ${entry.name} --help` },
      ]);
    }
    const schema = input.properties[key] as { type?: string };
    raw[key] = schema.type === "array" ? ([] as unknown[]).concat(value) : Array.isArray(value) ? value.at(-1) : value;
  }
  const converted = Value.Convert(input, raw) as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of input.required ?? []) {
    if (converted[key] === undefined) problems.push(`--${kebab(key)} is required`);
  }
  for (const error of Value.Errors(input, converted)) {
    const key = error.instancePath.split("/")[1];
    if (!key || problems.some((p) => p.startsWith(`--${kebab(key)} `))) continue;
    const schema = input.properties[key] as TSchema;
    const values = allowedValues(schema);
    problems.push(
      values
        ? `--${kebab(key)} "${converted[key]}" is not one of: ${values.join(", ")}`
        : `--${kebab(key)} ${error.message}${converted[key] !== undefined ? `, got ${JSON.stringify(converted[key])}` : ""}`,
    );
  }
  if (problems.length) throw new InputError(problems.join("; "), [{ hint: "see its flags", cmd: `${cli} ${entry.name} --help` }]);
  return converted;
};

/** The call as a command line, for hints and for re-running it once a request is done. */
export const callArgv = (op: string, input: Record<string, unknown>): string[] => [
  op,
  ...Object.entries(input).flatMap(([key, value]) =>
    ([] as unknown[]).concat(value).flatMap((v) => (v === true ? [`--${kebab(key)}`] : v === false ? [] : [`--${kebab(key)}`, String(v)])),
  ),
];

export interface HistoryLine {
  at: string;
  context: string;
  ok: boolean;
  step?: string;
  error?: string;
  /** A failure triage put on something other than the op: 1 (the browser), 2, 3 or 4. Unset is the op's fault. */
  exit?: number;
  /** Done without a browser. */
  direct?: boolean;
  /** Each step's ms, in the order they ran; a step that ran twice adds up. */
  steps?: Record<string, number>;
  /** The direct way failed at this step, so the op ran in the browser. */
  fellBack?: string;
  ms: number;
  dryRun?: boolean;
}

export interface RunEnv {
  domain: Domain;
  contexts: Contexts;
  requests: Requests;
  /** Whether a failure the op is to blame for files a repair. Off in worktrees, where agents build. */
  fileRepairs: boolean;
}

export const domainRef = (domain: Domain): DomainRef => ({ name: domain.name, root: domain.root, dir: domain.dir, home: domain.home });

/** One way of running an op, direct or in the browser: its named steps, timed, and its history line. */
export interface Attempt {
  /** A named step: progress while it runs, and a failure names it. */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** The step running, or the last that ran. */
  readonly at: string | undefined;
  history(line: Omit<HistoryLine, "at" | "context" | "ms" | "steps" | "dryRun">): void;
}

const attempt = (entry: OpEntry, ctx: Context, started: number, dryRun: boolean): Attempt => {
  let at: string | undefined;
  const steps: Record<string, number> = {};
  return {
    get at() {
      return at;
    },
    async step(name, fn) {
      at = name;
      progress(`› ${name}`);
      const from = Date.now();
      try {
        return await fn();
      } finally {
        steps[name] = (steps[name] ?? 0) + Date.now() - from;
      }
    },
    history: (line) =>
      appendJsonLine(join(entry.dir, "history.jsonl"), {
        at: timestamp(),
        context: ctx.name,
        ms: Date.now() - started,
        ...line,
        ...(Object.keys(steps).length ? { steps } : {}),
        ...(dryRun ? { dryRun } : {}),
      }),
  };
};

/** Run an op against a context: the direct way if it has one, else or failing that its steps in a browser, and triage when it fails. */
export const runOp = async (
  env: RunEnv,
  entry: OpEntry,
  input: Record<string, unknown>,
  ctx: Context,
  options: {
    headed?: boolean;
    dryRun?: boolean;
    /** Skip the direct way. */
    browser?: boolean;
    /** The call as the caller made it, to run again once a repair is done. */
    call?: string[];
    /** A signed-in browser kept between calls, which the op runs in and leaves open. */
    kept?: OpenBrowser;
  } = {},
): Promise<Outcome> => {
  const { domain, requests } = env;
  const { headed = false, dryRun = false, browser = false } = options;
  const call = options.call ?? [...callArgv(entry.name, input), ...(dryRun ? ["--dry-run"] : [])];
  const started = Date.now();

  // Builds verify an op whose repair failed, which is how a change can fix it.
  const broken = env.fileRepairs ? requests.brokenBy(entry.name) : undefined;
  if (broken) {
    return {
      ...fail(`${entry.name} is broken: its repair ${broken.id} failed (${broken.reason ?? "no reason given"})`, EXIT.PENDING, [
        { hint: "see why", cmd: `${domain.name} request:status ${broken.id}` },
        { hint: "try the repair again", cmd: `${domain.name} request:retry ${broken.id}` },
      ]),
      request: broken.id,
    };
  }

  const check = (output: unknown): Outcome => {
    if (!Value.Check(entry.definition.output, output)) {
      const problem = [...Value.Errors(entry.definition.output, output)][0];
      throw new Error(`output does not match the op's output schema: ${problem?.instancePath || "/"} ${problem?.message}`);
    }
    return { ok: true, data: output, ...(entry.definition.format && { text: entry.definition.format(output as never) }) };
  };

  const directRun = attempt(entry, ctx, started, dryRun);
  const direct = browser ? {} : await tryDirect(env, entry, input, ctx, directRun, check);
  if ("outcome" in direct) return direct.outcome;
  const { fellBack } = direct;

  // A direct way that failed may only have met a sign-in that ended, which this finds.
  let open: OpenBrowser;
  try {
    open = options.kept ?? (await openSignedIn(domain, env.contexts, ctx, { headed }));
  } catch (err) {
    // No op code has run yet: a sign-in or a browser that won't start is never the op's fault.
    if (err instanceof OpError) return outcomeOf(err);
    throw err;
  }
  const release = () => (options.kept ? Promise.resolve() : open.close());
  const run = attempt(entry, ctx, started, dryRun);
  if (fellBack) {
    // The direct way met a session that had ended, not a changed call: it runs again, signed in.
    if (open.signedInNow) {
      await release();
      return runOp(env, entry, input, env.contexts.get(ctx.name), { headed, dryRun, call });
    }
    if (!env.fileRepairs) {
      await release();
      // Through the direct attempt, so the line has its steps' times.
      directRun.history({ ok: false, step: fellBack.step, error: firstLine(fellBack.error.message), direct: true });
      return fail(`${entry.name}: ${fellBack.error.message}`, EXIT.ERROR);
    }
    progress(`› ${firstLine(fellBack.error.message)}; in the browser`);
  }

  const app = domain.helpers(open.page, { contextUrl: ctx.appUrl, dryRun });
  const context: ContextRef = { name: ctx.name, url: ctx.appUrl };
  try {
    const outcome = check(await entry.definition.run({ app, page: open.page, step: run.step, context, dryRun }, input));
    run.history({ ok: true, ...(fellBack ? { fellBack: fellBack.step } : {}) });
    return fellBack ? { ...outcome, request: fileDirectRepair(env, entry, input, ctx, fellBack) } : outcome;
  } catch (err) {
    if (err instanceof DryRunReached) {
      const shot = join(domain.home, "dry-runs", `${opFolder(entry.name)}-${Date.now()}.png`);
      mkdirSync(join(domain.home, "dry-runs"), { recursive: true });
      await open.page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      run.history({ ok: true, step: run.at });
      return { ok: true, data: { dryRun: `stopped before ${err.action}`, screenshot: shot } };
    }
    const failed = (triaged?: Outcome) =>
      run.history({ ok: false, step: run.at, error: firstLine((err as Error).message), ...(triaged ? { exit: triaged.exitCode } : {}) });
    // An error the op raised on purpose, or a browser that failed, is someone else's without a look at the page.
    const known = knownFailure(err);
    if (known) {
      failed(known);
      return known;
    }
    // What the page showed when the op failed, taken before triage waits on a fresh page, while this one may change.
    const captured = await captureFailure(domain, open);
    const triaged = await triage(env, ctx, open);
    failed(triaged);
    if (triaged) return triaged;
    const error = err instanceof Error ? err : new Error(String(err));
    error.message = plain(error.message);
    return await fileRepair(env, entry, input, ctx, captured, run.at, error, call);
  } finally {
    await release();
  }
};

/** The browser way did what the direct way could not: the caller has its output, and the direct way a repair, whose id this is. */
const fileDirectRepair = (env: RunEnv, entry: OpEntry, input: Record<string, unknown>, ctx: Context, { step, error }: FellBack): string => {
  const bundle = saveFailureBundle(env.domain, entry, input, ctx, { network: [] }, step, error);
  const { record } = env.requests.fileOrJoinRepair({
    kind: "repair",
    text: `${entry.name} at "${step}": ${firstLine(error.message)}`,
    op: entry.name,
    context: ctx.name,
    domain: domainRef(env.domain),
    failure: { step, error: error.message, bundle, fellBack: true },
  });
  progress(`${entry.name} ran in the browser; ${record.id} repairs the direct way`);
  return record.id;
};

/** Triage, by rules only: is this failure someone else's, and which exit says so? First from the error alone. */
const knownFailure = (err: unknown): Outcome | undefined => {
  if (err instanceof OpError) return outcomeOf(err);
  if (isBrowserFailure(err)) return fail(`the browser failed: ${firstLine((err as Error).message)}`, EXIT.ERROR);
  return undefined;
};

/** Then from the app: a refusal on the page, or a session that ended under the op. Undefined means the op's fault. */
const triage = async (env: RunEnv, ctx: Context, open: OpenBrowser): Promise<Outcome | undefined> => {
  const { domain } = env;
  const { page } = open;
  const refused = domain.refusal && !page.isClosed() ? await domain.refusal(page).catch(() => undefined) : undefined;
  if (refused) return fail(`${domain.name} refused it: ${refused}`, EXIT.REFUSED);
  // Did the session end under the op? Asked of a fresh page at the app's home, in a context of its
  // own, since the failed page may be anything: an error screen, a dialog, a page without the header.
  const fresh = await signedInContext(open.browser, domain, ctx).catch(() => undefined);
  if (fresh) {
    const state = await fresh
      .newPage()
      .then(async (p) => {
        await p.goto(ctx.appUrl, { waitUntil: "domcontentloaded" });
        return signInStateOf(domain, p, ctx.appUrl);
      })
      .catch(() => "unknown" as const);
    await fresh.close().catch(() => {});
    if (state === "signed-out") {
      env.contexts.markSignedOut(ctx.name);
      return fail(`context "${ctx.name}" signed out during the call`, EXIT.PRECONDITION, [loginHint(domain.name, ctx.name)]);
    }
  }
  return undefined;
};

interface CapturedFailure {
  url?: string;
  screenshot?: Buffer;
  snapshot?: string;
  network: NetworkEntry[];
}

/** The page as the op left it: URL, screenshot, the controls on it, and the calls that led there. */
const captureFailure = async (domain: Domain, open: OpenBrowser): Promise<CapturedFailure> => {
  const { page } = open;
  const network = [...open.network];
  if (page.isClosed()) return { network };
  const screenshot = await page.screenshot({ fullPage: true }).catch(() => undefined);
  const snapshot = await takeSnapshot(page, domain.testIdAttribute).catch(() => undefined);
  return { url: page.url(), screenshot, snapshot: snapshot && formatSnapshot(snapshot), network };
};

/** Everything a repair needs to see what happened, saved where the repair can read it. */
const saveFailureBundle = (
  domain: Domain,
  entry: OpEntry,
  input: Record<string, unknown>,
  ctx: Context,
  captured: CapturedFailure,
  step: string | undefined,
  err: Error,
): string => {
  const dir = join(domain.home, "failures", opFolder(entry.name), timestamp().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "error.json"), {
    op: entry.name,
    step,
    error: err.message,
    stack: err.stack?.split("\n").slice(0, 12).join("\n"),
    input,
    context: ctx.name,
    contextUrl: ctx.appUrl,
    url: captured.url,
    at: timestamp(),
  });
  if (captured.screenshot) writeFileSync(join(dir, "screenshot.png"), captured.screenshot);
  if (captured.snapshot) writeFileSync(join(dir, "snapshot.txt"), `${captured.snapshot}\n`);
  writeJson(join(dir, "network.json"), captured.network);
  writeFileSync(join(dir, "network.txt"), `${formatNetwork(captured.network, 100)}\n`);
  const history = readJsonLines<HistoryLine>(join(entry.dir, "history.jsonl")).slice(-10);
  writeFileSync(join(dir, "history.jsonl"), history.map((h) => JSON.stringify(h)).join("\n") + (history.length ? "\n" : ""));
  return dir;
};

const fileRepair = async (
  env: RunEnv,
  entry: OpEntry,
  input: Record<string, unknown>,
  ctx: Context,
  captured: CapturedFailure,
  step: string | undefined,
  err: Error,
  call: string[],
): Promise<Outcome> => {
  const { domain, requests } = env;
  const cli = domain.name;
  const bundle = saveFailureBundle(domain, entry, input, ctx, captured, step, err);
  const where = step ? `failed at "${step}"` : "failed";
  const message = `${entry.name} ${where}: ${firstLine(err.message)}`;

  if (!env.fileRepairs) {
    return fail(`${message}\nfailure bundle: ${bundle}`, EXIT.ERROR);
  }

  const { record, joined } = requests.fileOrJoinRepair({
    kind: "repair",
    text: message,
    op: entry.name,
    context: ctx.name,
    domain: domainRef(domain),
    call: { op: entry.name, argv: call },
    failure: { step, error: err.message, bundle },
  });
  return {
    ok: false,
    error: message,
    data: joined ? `${entry.name} is being repaired: joined request ${record.id}` : `request ${record.id} filed: repair ${entry.name}`,
    exitCode: EXIT.PENDING,
    request: record.id,
    next: [{ hint: "check on it", cmd: `${cli} request:status ${record.id} --wait` }],
  };
};

export const lastRun = (entry: { dir: string }): HistoryLine | undefined =>
  readJsonLines<HistoryLine>(join(entry.dir, "history.jsonl")).at(-1);
