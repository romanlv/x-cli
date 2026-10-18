// Named browser sessions for exploring: `page` commands attach to a session that stays open between
// calls. Each session is a small daemon holding one signed-in page, listening on a unix socket; the
// CLI sends it one command per call. Every command is logged, with the locator Playwright used, to
// the session's trace.jsonl, so writing an op starts from what worked.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator } from "playwright";
import { type OpenBrowser, openSignedIn } from "./browser";
import type { Context, Contexts } from "./contexts";
import type { Domain, PageCommand, PageCommandContext } from "./domain";
import { envName, envNumber, envOverride } from "./env";
import { InputError, OpError, outcomeOf } from "./errors";
import { formatCall, formatNetwork } from "./network";
import { EXIT, fail, type Outcome, plain, progress, progressInto } from "./output";
import { formatNode, formatSnapshot, refLocator, type Snapshot, type SnapshotNode, suggestLocator, takeSnapshot } from "./snapshot";
import { alive, appendJsonLine, readJson, timestamp, writeJson } from "./store";

const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const IDLE_MS = envNumber("SESSION_IDLE_MS", 30 * 60_000);
/** A kept browser for op calls (`keepBrowser`) closes sooner: nobody is exploring in it. */
const OPS_IDLE_MS = envNumber("SESSION_IDLE_MS", 10 * 60_000);
const OPS_PREFIX = "ops-";
/** How long a daemon may take to start: a browser, and the sign-in check. A start older than that died. */
const START_MS = 90_000;

interface SessionState {
  pid: number;
  socket: string;
  context: string;
  headed: boolean;
  startedAt: string;
  /** The code it runs (`codeStamp`): a daemon on code that has since changed is closed and started again. */
  stamp?: string;
  /** Why the daemon could not start, as the CLI that started it answers. */
  error?: Outcome;
  ready?: boolean;
}

const sessionDir = (home: string, name: string): string => join(home, "sessions", name);
const stateFile = (home: string, name: string): string => join(sessionDir(home, name), "state.json");
const traceFile = (home: string, name: string): string => join(sessionDir(home, name), "trace.jsonl");
// Unix socket paths are limited to about 100 bytes, which a deep home folder would pass.
const socketPath = (domain: Domain, name: string): string =>
  join(tmpdir(), `${domain.name.slice(0, 12)}-${createHash("sha1").update(`${domain.home}\0${name}`).digest("hex").slice(0, 16)}.sock`);

/** A URL on the session's site; any other origin is refused. */
const onSite = (url: string | undefined, contextUrl: string): URL => {
  const resolved = new URL(url ?? "", contextUrl);
  const origin = new URL(contextUrl).origin;
  if (resolved.origin !== origin) throw new InputError(`refusing ${resolved.origin}: this session is for ${origin}`);
  return resolved;
};

/** A command that acts on the control `args[0]` names, then prints the page with what changed. */
const onRef = (usage: string, act: (locator: Locator, args: string[]) => Promise<unknown>): PageCommand => ({
  usage,
  async run(s, args) {
    await act((await s.ref(args[0])).locator, args);
    s.trace();
    return s.snapshot();
  },
});

/** Every page command, core's and the domain's, by the name it is called as. */
export const pageCommandsOf = (domain: Domain): Record<string, PageCommand> => ({
  page: {
    usage: "URL, title and the page's controls, each with a ref such as e14",
    reads: true,
    // It also resets what the next action's diff compares against.
    run: (s) => s.snapshot({ whole: true }),
  },
  "page:goto": {
    usage: "<url>  open a URL on the context's site",
    async run(s, [url]) {
      const target = onSite(url, s.contextUrl);
      await s.page.goto(target.href, { waitUntil: "domcontentloaded" });
      s.trace(`page.goto(${JSON.stringify(target.href)})`);
      return s.snapshot();
    },
  },
  "page:click": onRef("<ref>  click, then the page with what changed marked +", (locator) => locator.click()),
  "page:fill": {
    usage: "<ref> <value>  type into a field; prints its new value",
    async run(s, [ref, value]) {
      const { locator, node } = await s.ref(ref);
      if (value === undefined) throw new InputError("give the value to fill");
      await locator.fill(value);
      s.trace();
      return `${node?.name || node?.label || ref} = ${JSON.stringify(await locator.inputValue().catch(() => value))}`;
    },
  },
  "page:select": onRef("<ref> <option>  choose an option of a native select", (locator, [, option]) => {
    if (option === undefined) throw new InputError("give the option to choose");
    return locator.selectOption({ label: option });
  }),
  "page:press": {
    usage: "<key> [ref]  press a key (Enter, Tab, Escape), in a field if a ref is given",
    async run(s, [key, ref]) {
      if (!key) throw new InputError("give a key, such as Enter");
      if (ref) {
        await (await s.ref(ref)).locator.press(key);
        s.trace();
      } else {
        await s.page.keyboard.press(key);
        s.trace(`page.keyboard.press(${JSON.stringify(key)})`);
      }
      return s.snapshot();
    },
  },
  "page:wait": {
    usage: "<ms|text>  wait for time to pass or text to appear",
    async run(s, [what]) {
      if (!what) throw new InputError("give milliseconds or text to wait for");
      if (/^\d+$/.test(what)) await s.page.waitForTimeout(Number(what));
      else await s.page.getByText(what).first().waitFor({ state: "visible" });
      s.trace();
      return s.snapshot();
    },
  },
  "page:shot": {
    usage: "save a screenshot; prints its path",
    reads: true,
    async run(s) {
      mkdirSync(join(s.dir, "shots"), { recursive: true });
      const path = join(s.dir, "shots", `${Date.now()}.png`);
      await s.page.screenshot({ path, fullPage: true });
      return path;
    },
  },
  "page:requests": {
    usage:
      "[all | n [body]]  the session's recent calls (the last 30, all for every kept one) under the command that made them, the newest JSON and event-stream ones numbered; n prints one with its headers and bodies, n body only its response",
    reads: true,
    async run(s, [which, body]) {
      if (which === undefined || which === "all") return formatNetwork(s.network, which ? Infinity : undefined);
      const call = /^\d+$/.test(which) ? formatCall(s.network, Number(which), body === "body", domain.directCalls !== false) : undefined;
      if (call === undefined) throw new InputError(`no call ${which} kept; \`${domain.name} page:requests\` lists the numbered ones`);
      return call;
    },
  },
  // A call from Playwright's own HTTP client is what a domain whose app tells its calls apart
  // (directCalls: false) must never make, so it has no page:fetch.
  ...(domain.directCalls === false
    ? {}
    : {
        "page:fetch": {
          usage:
            "<url> [Name: value ...] [body]  make one call on the session's sign-in, as an op's direct way would; a body makes it a POST (a=b&c=d is a form, {...} JSON)",
          reads: true,
          async run(s, [url, ...rest]) {
            const target = onSite(url, s.contextUrl);
            const headers: Record<string, string> = {};
            let data: string | undefined;
            for (const arg of rest) {
              const header = /^([\w-]+):\s*(.*)$/.exec(arg);
              if (header) headers[header[1]!] = header[2]!;
              else data = arg;
            }
            if (data !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type"))
              headers["Content-Type"] = data.trimStart().startsWith("{") ? "application/json" : "application/x-www-form-urlencoded";
            const res = await s.page.context().request.fetch(target.href, { method: data === undefined ? "GET" : "POST", headers, data });
            return `${res.status()} ${res.headers()["content-type"] ?? "no content type"}\n\n${await res.text()}`;
          },
        },
      }),
  "page:trace": {
    usage: "the commands this session has run, with the locator each used",
    reads: true,
    run: async (s) => join(s.dir, "trace.jsonl"),
  },
  "page:close": {
    usage: "close the session's browser",
    async run(s) {
      s.close();
      return `session ${s.session} closed`;
    },
  },
  ...Object.fromEntries(
    Object.entries(domain.pageCommands ?? {}).map(([name, command]): [string, PageCommand] => [
      `page:${name}`,
      {
        ...command,
        async run(s, args) {
          const text = await command.run(s, args);
          s.trace();
          // One that only reads changed nothing on the page: what it read is the whole answer.
          if (command.reads && text !== undefined) return text;
          const after = await s.snapshot();
          return text ? `${text}\n${after}` : after;
        },
      },
    ]),
  ),
});

interface Reply {
  ok: boolean;
  text: string;
  exitCode?: number;
  /** An op call's outcome, and the progress it printed on the way. */
  outcome?: Outcome;
  progress?: string[];
}

/** The code a daemon runs: core's and the domain's `.ts` files, by count and newest change. */
export const codeStamp = (domain: Domain): string => {
  let newest = 0;
  let count = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) {
        count++;
        newest = Math.max(newest, statSync(path).mtimeMs);
      }
    }
  };
  for (const dir of [import.meta.dir, domain.dir]) if (existsSync(dir)) walk(dir);
  return `${count}:${Math.floor(newest)}`;
};

/** The session that keeps a context's browser for op calls, one per checkout, so a worktree's code never serves main's calls. */
export const opsSession = (root: string, context: string): string =>
  `${OPS_PREFIX}${context}-${createHash("sha1").update(root).digest("hex").slice(0, 8)}`.slice(0, 64);

/** The context a running session was opened on. */
export const sessionContext = (home: string, session: string): string | undefined => {
  const state = readJson<SessionState | undefined>(stateFile(home, session), undefined);
  return state?.ready && alive(state.pid) ? state.context : undefined;
};

/** Send one page command to a session, starting the session first if it isn't running. */
export const pageCommand = async (
  domain: Domain,
  entry: string[],
  { session, context, headed, stamp }: { session: string; context: Context; headed: boolean; stamp?: string },
  cmd: string,
  args: string[],
): Promise<Outcome> => {
  if (!SESSION_NAME.test(session)) return fail(`session name "${session}" may use letters, digits, . _ -`, EXIT.USAGE);
  const home = domain.home;
  let state = readJson<SessionState | undefined>(stateFile(home, session), undefined);
  const running = state?.ready && alive(state.pid) && existsSync(state.socket);

  if (!running && cmd === "page:close") {
    // A daemon that died leaves its state and socket; closing clears them so the name starts clean.
    // Only a daemon that said it was serving and never said it closed can still be ours to stop.
    if (state?.ready && alive(state.pid)) process.kill(state.pid, "SIGTERM");
    if (state?.socket) rmSync(state.socket, { force: true });
    rmSync(stateFile(home, session), { force: true });
    return { ok: true, data: `session ${session} is not running` };
  }
  let live = running;
  if (live && stamp && state!.stamp !== stamp) {
    // Its code has changed since it started: the next call runs the new code, in a new daemon.
    await stopDaemon(home, session, state!);
    live = false;
  }
  if (!live) {
    const started = await startSession(domain, entry, session, context, headed);
    if (!started.ok) return started.outcome;
    state = started.state;
  } else if (cmd !== "page:close" && state!.context !== context.name) {
    return fail(`session ${session} is on context "${state!.context}", not "${context.name}"`, EXIT.USAGE, [
      { hint: "close it first", cmd: `${domain.name} page:close --session ${session}` },
    ]);
  }

  let reply: Reply;
  try {
    const response = await fetch("http://session/", {
      unix: state!.socket,
      method: "POST",
      body: JSON.stringify({ cmd, args }),
    } as RequestInit);
    reply = (await response.json()) as Reply;
  } catch (err) {
    if (cmd === "page:close") return { ok: true, data: `session ${session} closed` };
    return fail(`session ${session} did not answer: ${(err as Error).message}`, EXIT.ERROR, [
      { hint: "close it and start over", cmd: `${domain.name} page:close --session ${session}` },
    ]);
  }
  for (const line of reply.progress ?? []) progress(line);
  if (reply.outcome) return reply.outcome;
  return reply.ok ? { ok: true, data: reply.text } : fail(reply.text, reply.exitCode ?? EXIT.ERROR);
};

/** Stop a running daemon and wait until it is gone, so the next start doesn't find its socket. */
const stopDaemon = async (home: string, session: string, state: SessionState): Promise<void> => {
  process.kill(state.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (alive(state.pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(state.socket, { force: true });
  rmSync(stateFile(home, session), { force: true });
};

const startSession = async (
  domain: Domain,
  entry: string[],
  session: string,
  context: Context,
  headed: boolean,
): Promise<{ ok: true; state: SessionState } | { ok: false; outcome: Outcome }> => {
  const home = domain.home;
  const dir = sessionDir(home, session);
  mkdirSync(dir, { recursive: true });
  // Two first calls on one session at once: one starts the daemon, the other waits for it.
  const starting = join(dir, "starting");
  for (;;) {
    try {
      mkdirSync(starting);
      break;
    } catch {
      // Gone between the mkdir and the stat means the other start just finished: try again.
      const since = (() => {
        try {
          return Date.now() - statSync(starting).mtimeMs;
        } catch {
          return undefined;
        }
      })();
      if (since === undefined) continue;
      if (since < START_MS) return waitForStart(home, session, undefined);
      rmSync(starting, { recursive: true, force: true });
    }
  }
  try {
    rmSync(stateFile(home, session), { force: true });
    const log = Bun.file(join(dir, "daemon.log"));
    const child = Bun.spawn([...entry, "page:daemon", "--session", session, "--context", context.name, ...(headed ? ["--headed"] : [])], {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, [envName("HOME")]: home },
    });
    child.unref();
    return await waitForStart(home, session, child);
  } finally {
    rmSync(starting, { recursive: true, force: true });
  }
};

const waitForStart = async (
  home: string,
  session: string,
  child: Bun.Subprocess | undefined,
): Promise<{ ok: true; state: SessionState } | { ok: false; outcome: Outcome }> => {
  const deadline = Date.now() + START_MS;
  while (Date.now() < deadline) {
    const state = readJson<SessionState | undefined>(stateFile(home, session), undefined);
    if (state?.error) return { ok: false, outcome: state.error };
    // A ready state from a daemon that has since died is the last session's, not this one's.
    if (state?.ready && alive(state.pid)) return { ok: true, state };
    if (child && child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { ok: false, outcome: fail(`session ${session} did not start; see ${join(sessionDir(home, session), "daemon.log")}`, EXIT.ERROR) };
};

/** The daemon itself, run as `<cli> page:daemon --session <name> --context <name>`. */
export const runSessionDaemon = async (
  domain: Domain,
  contexts: Contexts,
  session: string,
  context: Context,
  headed: boolean,
  /** Runs an op call (`op:run`) in the session's browser. */
  runCall?: (open: OpenBrowser, args: string[]) => Promise<Outcome>,
): Promise<void> => {
  const home = domain.home;
  const socket = socketPath(domain, session);
  const base: SessionState = {
    pid: process.pid,
    socket,
    context: context.name,
    headed,
    startedAt: timestamp(),
    stamp: codeStamp(domain),
  };

  // The page command a call started under, for page:requests.
  let during: string | undefined;
  let open: OpenBrowser;
  try {
    open = await openSignedIn(domain, contexts, context, { headed, network: { bodies: true, during: () => during } });
  } catch (err) {
    const outcome = err instanceof OpError ? outcomeOf(err) : fail((err as Error).message);
    writeJson(stateFile(home, session), { ...base, error: outcome });
    // The CLI that started it has its answer; a daemon with no browser has nothing left to serve.
    process.exit(1);
  }

  const { page } = open;
  let lastActivity = Date.now();
  const active = () => (lastActivity = Date.now());
  open.context.on("request", active);
  open.context.on("requestfinished", active);
  open.context.on("requestfailed", active);
  let previous: Snapshot | undefined;
  let idleTimer: ReturnType<typeof setTimeout>;
  const pageEveryMs = envOverride("KEEP_ALIVE_PAGE_MS", domain.keepAlive?.pageEveryMs);
  if (pageEveryMs) {
    // An agent writing code leaves its page alone for longer than the app allows; a mouse move in the
    // page's corner counts as a person there, and changes nothing on it.
    setInterval(() => {
      if (page.isClosed()) return;
      void page.mouse
        .move(2, 2)
        .then(() => page.mouse.move(3, 3))
        .catch(() => {});
    }, pageEveryMs).unref();
  }

  const shutdown = async () => {
    server.stop(true);
    rmSync(socket, { force: true });
    // A closed session leaves no state, so nothing later takes its pid for a live daemon.
    rmSync(stateFile(home, session), { force: true });
    await open.close();
    process.exit(0);
  };
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void shutdown(), session.startsWith(OPS_PREFIX) ? OPS_IDLE_MS : IDLE_MS);
  };

  /** Wait for the page to go quiet: no network for half a second, at most five seconds. */
  const settle = async () => {
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    const until = Date.now() + 5000;
    while (Date.now() < until && Date.now() - lastActivity < 500) await page.waitForTimeout(100);
  };

  const commands = pageCommandsOf(domain);
  /** What one call's command acts through; `trace` logs the node its last `ref` found. */
  const contextFor = (cmd: string, args: string[]): PageCommandContext => {
    let node: SnapshotNode | undefined;
    return {
      page,
      session,
      contextUrl: context.appUrl,
      dir: sessionDir(home, session),
      network: open.network,
      async ref(ref) {
        if (!ref || !/^e\d+$/.test(ref)) throw new InputError("give a ref such as e14, from `page`");
        const locator = refLocator(page, ref);
        if ((await locator.count()) === 0)
          throw new InputError(`ref ${ref} is not on the page any more; run \`${domain.name} page\` for fresh refs`);
        node = previous?.nodes.find((n) => n.ref === ref);
        return { locator, node };
      },
      trace: (locator) =>
        appendJsonLine(traceFile(home, session), {
          at: timestamp(),
          session,
          cmd,
          args,
          url: page.url(),
          ...(node ? { element: formatNode({ ...node, depth: 0 }).slice(2), locator: suggestLocator(node) } : {}),
          ...(locator ? { locator } : {}),
        }),
      async snapshot({ whole = false } = {}) {
        await settle();
        const snapshot = await takeSnapshot(page, domain.testIdAttribute);
        const text = formatSnapshot(snapshot, whole ? undefined : previous);
        previous = snapshot;
        return text;
      },
      close: () => setTimeout(() => void shutdown(), 50),
    };
  };

  // One command at a time: two agents' calls on one page would interleave their clicks.
  let queue: Promise<unknown> = Promise.resolve();
  // Only this daemon owns the session now, so a socket left by one that died is stale.
  rmSync(socket, { force: true });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      unix: socket,
      fetch: async (request) => {
        touch();
        const { cmd, args } = (await request.json()) as { cmd: string; args: string[] };
        const result = queue.then(async (): Promise<Reply> => {
          try {
            if (cmd === "op:run" && runCall) {
              const lines: string[] = [];
              progressInto((line) => lines.push(line));
              try {
                const outcome = await runCall(open, args);
                return { ok: outcome.ok, text: "", outcome, progress: lines };
              } finally {
                progressInto(undefined);
              }
            }
            const command = commands[cmd];
            if (!command) throw new InputError(`unknown page command ${cmd}`);
            if (!command.reads) during = [cmd, ...args].join(" ");
            return { ok: true, text: (await command.run(contextFor(cmd, args), args)) ?? "" };
          } catch (err) {
            if (err instanceof OpError) return { ok: false, text: err.message, exitCode: err.exitCode };
            if (page.isClosed()) setTimeout(() => void shutdown(), 50);
            return {
              ok: false,
              text: plain((err as Error).message)
                .split("\n")
                .slice(0, 6)
                .join("\n"),
              exitCode: EXIT.ERROR,
            };
          }
        });
        queue = result;
        return Response.json(await result);
      },
    });
  } catch (err) {
    writeJson(stateFile(home, session), {
      ...base,
      error: fail(`session ${session} could not listen on ${socket}: ${(err as Error).message}`),
    });
    await open.close();
    process.exit(1);
  }

  writeJson(stateFile(home, session), { ...base, ready: true });
  touch();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void shutdown());
};
