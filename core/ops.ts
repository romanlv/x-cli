// Operations: one task as a folder of plain files, run as code. Nothing here calls a model; a failure
// the op is to blame for becomes a repair request, and anything else an error that says what to do.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext, Page } from "playwright";
import type { Static, TObject, TSchema } from "typebox";
import Value from "typebox/value";
import { type OpenBrowser, openHttp, openSignedIn, saveSession, signInSaved } from "./browser";
import { type Context, type Contexts, loginHint } from "./contexts";
import type { Domain } from "./domain";

export { OP_NAME, opFolder } from "./names";

import { DryRunReached, InputError, isBrowserFailure, OpError } from "./errors";
import { OP_NAME, opFolder } from "./names";
import { formatNetwork, type NetworkEntry } from "./network";
import { EXIT, fail, type Outcome, progress, shellQuote } from "./output";
import type { DomainRef, Requests } from "./requests";
import { formatSnapshot, takeSnapshot } from "./snapshot";
import { appendJsonLine, readJson, readJsonLines, timestamp, writeJson } from "./store";

export interface OpContext<Helpers> {
  /** The domain's helper library. */
  wd: Helpers;
  page: Page;
  /** A named step: progress while it runs, and a failure names it. */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  context: { name: string; url: string };
  dryRun: boolean;
}

export interface DirectContext {
  /** HTTP on the context's saved cookies; no browser is started. */
  http: APIRequestContext;
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  context: { name: string; url: string };
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

/** A domain binds its helper type once: `export const defineOp = defineOpFor<Wd>()`. */
export const defineOpFor =
  <Helpers>() =>
  <I extends TObject, O extends TSchema>(definition: OpDefinition<I, O, Helpers>): OpDefinition<I, O, Helpers> =>
    definition;

/** The CLI's own commands use these nouns, so no op can. */
export const RESERVED_NOUNS = ["context", "request", "page", "op"];

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
      if (RESERVED_NOUNS.includes(definition.name.split(":")[0]!)) throw new Error(`the noun of ${definition.name} is the CLI's own`);
      ops.set(definition.name, { name: definition.name, dir: join(opsDir, folder), definition });
    } catch (err) {
      broken.push({ dir: folder, error: loadError(err) });
    }
  }
  return { ops, broken };
};

const kebab = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const allowedValues = (schema: TSchema): string[] | undefined => {
  const s = schema as { enum?: unknown[]; anyOf?: { const?: unknown }[]; const?: unknown };
  if (s.enum) return s.enum.map(String);
  if (s.anyOf?.every((branch) => branch.const !== undefined)) return s.anyOf.map((b) => String(b.const));
  return undefined;
};

/** Text for `<op> --help`, from the op's own schema, so a new op documents itself. */
export const opHelp = (cli: string, entry: OpEntry): string => {
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
    "  --dry-run          stop before the last submit, with a screenshot of the filled form",
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

export const commandLine = (cli: string, argv: string[]): string => [cli, ...argv.map(shellQuote)].join(" ");

/** How long one Playwright action waits before the step fails. */
const STEP_TIMEOUT_MS = Number(process.env.XCLI_STEP_TIMEOUT_MS ?? 15_000);

/** Playwright colours its call logs; the ledger and bundles are read as plain text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is what an ANSI colour code starts with.
export const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

export interface HistoryLine {
  at: string;
  context: string;
  ok: boolean;
  step?: string;
  error?: string;
  /** A failure triage put on the input, the tenant or the session: 2, 3 or 4. Unset is the op's fault. */
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

/** Run an op against a context: sign-in check, the op's steps, then triage when it fails. */
export const runOp = async (
  env: RunEnv,
  entry: OpEntry,
  input: Record<string, unknown>,
  ctx: Context,
  {
    headed = false,
    dryRun = false,
    browser = false,
    call = [...callArgv(entry.name, input), ...(dryRun ? ["--dry-run"] : [])],
  }: {
    headed?: boolean;
    dryRun?: boolean;
    /** Skip the direct way. */
    browser?: boolean;
    /** The call as the caller made it, to run again once a repair is done. */ call?: string[];
  } = {},
): Promise<Outcome> => {
  const { domain, requests } = env;
  const cli = domain.name;
  const started = Date.now();
  let steps: Record<string, number> = {};
  const history = (line: Omit<HistoryLine, "at" | "context" | "ms">) =>
    appendJsonLine(join(entry.dir, "history.jsonl"), {
      at: timestamp(),
      context: ctx.name,
      ms: Date.now() - started,
      ...line,
      ...(Object.keys(steps).length ? { steps } : {}),
      ...(dryRun ? { dryRun } : {}),
    });

  // Builds verify an op whose repair failed, which is how a change can fix it.
  const broken = env.fileRepairs ? requests.brokenBy(entry.name) : undefined;
  if (broken) {
    return {
      ...fail(`${entry.name} is broken: its repair ${broken.id} failed (${broken.reason ?? "no reason given"})`, EXIT.PENDING, [
        { hint: "see why", cmd: `${cli} request:status ${broken.id}` },
        { hint: "try the repair again", cmd: `${cli} request:retry ${broken.id}` },
      ]),
      request: broken.id,
    };
  }

  let current: string | undefined;
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    current = name;
    progress(`› ${name}`);
    const at = Date.now();
    try {
      return await fn();
    } finally {
      steps[name] = (steps[name] ?? 0) + Date.now() - at;
    }
  };
  const checked = (output: unknown) => {
    if (!Value.Check(entry.definition.output, output)) {
      const problem = [...Value.Errors(entry.definition.output, output)][0];
      throw new Error(`output does not match the op's output schema: ${problem?.instancePath || "/"} ${problem?.message}`);
    }
    return { ok: true, data: entry.definition.format ? entry.definition.format(output as never) : output };
  };
  const context = { name: ctx.name, url: ctx.appUrl };

  let fellBack: { step: string; error: Error } | undefined;
  const directBroken = env.fileRepairs ? requests.brokenBy(entry.name, true) : undefined;
  if (directBroken) progress(`› the direct way's repair ${directBroken.id} failed; in the browser`);
  // Known to be signed out, the direct way's calls would only meet the sign-in page.
  if (
    entry.definition.direct &&
    !browser &&
    !env.contexts.isSignedIn(ctx) &&
    (await signInSaved(domain, env.contexts, ctx).catch(() => false))
  )
    ctx = env.contexts.get(ctx.name);
  if (entry.definition.direct && !browser && !directBroken && existsSync(ctx.authFile)) {
    const { http, close } = await openHttp(ctx, STEP_TIMEOUT_MS);
    try {
      const outcome = checked(await entry.definition.direct({ http, step, context, dryRun }, input));
      // The app may keep its idle timer in the cookies, as a browser's would.
      await saveSession(http, ctx).catch(() => {});
      history({ ok: true, direct: true });
      return outcome;
    } catch (err) {
      if (err instanceof OpError) {
        history({ ok: false, step: current, error: err.message.split("\n")[0], exit: err.exitCode, direct: true });
        return fail(err.message, err.exitCode, err.next);
      }
      const message = plain(err instanceof Error ? err.message : String(err));
      fellBack = { step: current ?? "direct", error: new Error(`the direct way failed${current ? ` at "${current}"` : ""}: ${message}`) };
    } finally {
      await close();
    }
    current = undefined;
    steps = {};
  }

  // A direct way that failed may only have met a sign-in that ended, which this finds.
  let open: OpenBrowser;
  try {
    open = await openSignedIn(domain, env.contexts, ctx, { headed });
  } catch (err) {
    // No op code has run yet: a sign-in or a browser that won't start is never the op's fault.
    if (err instanceof OpError) return fail(err.message, err.exitCode, err.next);
    throw err;
  }
  // The direct way met a session that had ended, not a changed call: it runs again, signed in.
  if (fellBack && open.signedInNow) {
    await open.close();
    return runOp(env, entry, input, env.contexts.get(ctx.name), { headed, dryRun, browser, call });
  }
  if (fellBack && !env.fileRepairs) {
    await open.close();
    history({ ok: false, step: fellBack.step, error: fellBack.error.message.split("\n")[0], direct: true });
    return fail(`${entry.name}: ${fellBack.error.message}`, EXIT.ERROR);
  }
  if (fellBack) progress(`› ${fellBack.error.message.split("\n")[0]}; in the browser`);

  open.page.setDefaultTimeout(STEP_TIMEOUT_MS);
  const wd = domain.helpers(open.page, { contextUrl: ctx.appUrl, dryRun });

  try {
    const outcome = checked(await entry.definition.run({ wd, page: open.page, step, context, dryRun }, input));
    history({ ok: true, ...(fellBack ? { fellBack: fellBack.step } : {}) });
    if (fellBack) {
      const { step: at, error } = fellBack;
      const bundle = saveFailureBundle(domain, entry, input, ctx, { network: [] }, at, error);
      const { record } = requests.fileOrJoinRepair({
        kind: "repair",
        text: `${entry.name} at "${at}": ${error.message.split("\n")[0]}`,
        op: entry.name,
        context: ctx.name,
        domain: domainRef(domain),
        failure: { step: at, error: error.message, bundle, fellBack: true },
      });
      progress(`${entry.name} ran in the browser; ${record.id} repairs the direct way`);
    }
    return outcome;
  } catch (err) {
    if (err instanceof DryRunReached) {
      const shot = join(domain.home, "dry-runs", `${opFolder(entry.name)}-${Date.now()}.png`);
      mkdirSync(join(domain.home, "dry-runs"), { recursive: true });
      await open.page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      history({ ok: true, step: current });
      return { ok: true, data: { dryRun: `stopped before ${err.action}`, screenshot: shot } };
    }
    // What the page showed when the op failed, taken before triage loads anything else.
    const captured = await captureFailure(open);
    const triaged = await triage(env, ctx, open, err);
    history({ ok: false, step: current, error: (err as Error).message.split("\n")[0], ...(triaged ? { exit: triaged.exitCode } : {}) });
    if (triaged) return triaged;
    const error = err instanceof Error ? err : new Error(String(err));
    error.message = plain(error.message);
    return await fileRepair(env, entry, input, ctx, captured, current, error, call);
  } finally {
    await open.close();
  }
};

/** Rules only: is this failure someone else's, and which exit says so? Undefined means the op's fault. */
export const triage = async (env: RunEnv, ctx: Context, open: OpenBrowser, err: unknown): Promise<Outcome | undefined> => {
  const { domain } = env;
  const { page } = open;
  if (err instanceof OpError) return fail(err.message, err.exitCode, err.next);
  if (isBrowserFailure(err)) return fail(`the browser failed: ${(err as Error).message.split("\n")[0]}`, EXIT.ERROR);
  const refused = domain.refusal && !page.isClosed() ? await domain.refusal(page).catch(() => undefined) : undefined;
  if (refused) return fail(`${domain.name} refused it: ${refused}`, EXIT.REFUSED);
  // Did the session end under the op? Asked of a fresh page at the tenant's home, in a context of its
  // own, since the failed page may be anything: an error screen, a dialog, a page without the header.
  const fresh = await open.browser.newContext({ storageState: ctx.authFile }).catch(() => undefined);
  if (fresh) {
    const state = await fresh
      .newPage()
      .then(async (p) => {
        await p.goto(ctx.appUrl, { waitUntil: "domcontentloaded" });
        return domain.signInState(p, ctx.appUrl);
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

export interface CapturedFailure {
  url?: string;
  screenshot?: Buffer;
  snapshot?: string;
  network: NetworkEntry[];
}

/** The page as the op left it: URL, screenshot, the controls on it, and the calls that led there. */
export const captureFailure = async (open: OpenBrowser): Promise<CapturedFailure> => {
  const { page } = open;
  const network = [...open.network];
  if (page.isClosed()) return { network };
  const screenshot = await page.screenshot({ fullPage: true }).catch(() => undefined);
  const snapshot = await takeSnapshot(page).catch(() => undefined);
  return { url: page.url(), screenshot, snapshot: snapshot && formatSnapshot(snapshot), network };
};

/** Everything a repair needs to see what happened, saved where the repair can read it. */
export const saveFailureBundle = (
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
  const message = `${entry.name} ${where}: ${err.message.split("\n")[0]}`;

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

/** Inputs that worked, each tagged with the context it worked in; verify runs the run's context's. */
export interface Example {
  context: string;
  input: Record<string, unknown>;
}

export const readExamples = (entry: { dir: string }): Example[] => readJson<Example[]>(join(entry.dir, "examples.json"), []);

export const lastRun = (entry: { dir: string }): HistoryLine | undefined =>
  readJsonLines<HistoryLine>(join(entry.dir, "history.jsonl")).at(-1);
