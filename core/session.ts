// Named browser sessions for exploring: `page` commands attach to a session that stays open between
// calls. Each session is a small daemon holding one signed-in page, listening on a unix socket; the
// CLI sends it one command per call. Every command is logged, with the locator Playwright used, to
// the session's trace.jsonl, so writing an op starts from what worked.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OpenBrowser, openSignedIn } from "./browser";
import type { Context, Contexts } from "./contexts";
import type { Domain } from "./domain";
import { OpError } from "./errors";
import { formatCall, formatNetwork } from "./network";
import { plain } from "./ops";
import { EXIT, fail, type Outcome } from "./output";
import { formatNode, formatSnapshot, refLocator, type Snapshot, type SnapshotNode, suggestLocator, takeSnapshot } from "./snapshot";
import { alive, appendJsonLine, readJson, timestamp, writeJson } from "./store";

export const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const IDLE_MS = Number(process.env.XCLI_SESSION_IDLE_MS ?? 30 * 60_000);
/** How often an open session nudges its page, so the app's own idle timer never fires. */
const STAY_ACTIVE_MS = Number(process.env.XCLI_STAY_ACTIVE_MS ?? 4 * 60_000);

export interface SessionState {
  pid: number;
  socket: string;
  context: string;
  headed: boolean;
  startedAt: string;
  error?: string;
  ready?: boolean;
}

export const sessionDir = (home: string, name: string): string => join(home, "sessions", name);
const stateFile = (home: string, name: string): string => join(sessionDir(home, name), "state.json");
export const traceFile = (home: string, name: string): string => join(sessionDir(home, name), "trace.jsonl");
// Unix socket paths are limited to about 100 bytes, which a deep home folder would pass.
const socketPath = (home: string, name: string): string =>
  join(tmpdir(), `wd-${createHash("sha1").update(`${home}\0${name}`).digest("hex").slice(0, 16)}.sock`);

/** Commands that only read what the session has; calls after them belong to the command before. */
const READS = new Set(["page", "page:requests", "page:fetch", "page:trace", "page:shot"]);

export const CORE_PAGE_COMMANDS: Record<string, string> = {
  page: "URL, title and the page's controls, each with a ref such as e14",
  "page:goto": "<url>  open a URL in the context's tenant",
  "page:click": "<ref>  click, then the page with what changed marked +",
  "page:fill": "<ref> <value>  type into a field; prints its new value",
  "page:select": "<ref> <option>  choose an option of a native select",
  "page:press": "<key> [ref]  press a key (Enter, Tab, Escape), in a field if a ref is given",
  "page:wait": "<ms|text>  wait for time to pass or text to appear",
  "page:shot": "save a screenshot; prints its path",
  "page:requests":
    "[all | n [body]]  the session's recent calls (the last 30, all for every kept one) under the command that made them, the newest JSON and event-stream ones numbered; n prints one with its headers and bodies, n body only its response",
  "page:fetch":
    "<url> [Name: value ...] [body]  make one call on the session's sign-in, as an op's direct way would; a body makes it a POST (a=b&c=d is a form, {...} JSON)",
  "page:trace": "the commands this session has run, with the locator each used",
  "page:close": "close the session's browser",
};

interface Reply {
  ok: boolean;
  text: string;
  exitCode?: number;
}

/** Send one page command to a session, starting the session first if it isn't running. */
/** The context a running session was opened on. */
export const sessionContext = (home: string, session: string): string | undefined => {
  const state = readJson<SessionState | undefined>(stateFile(home, session), undefined);
  return state?.ready && alive(state.pid) ? state.context : undefined;
};

export const pageCommand = async (
  domain: Domain,
  entry: string[],
  { session, context, headed }: { session: string; context: Context; headed: boolean },
  cmd: string,
  args: string[],
): Promise<Outcome> => {
  if (!SESSION_NAME.test(session)) return fail(`session name "${session}" may use letters, digits, . _ -`, EXIT.USAGE);
  const home = domain.home;
  let state = readJson<SessionState | undefined>(stateFile(home, session), undefined);
  const running = state?.ready && alive(state.pid) && existsSync(state.socket);

  if (cmd === "page:close" && !running) {
    // A daemon that died leaves its state and socket; closing clears them so the name starts clean.
    // Only a daemon that said it was serving and never said it closed can still be ours to stop.
    if (state?.ready && state.pid && alive(state.pid)) process.kill(state.pid, "SIGTERM");
    if (state?.socket) rmSync(state.socket, { force: true });
    rmSync(stateFile(home, session), { force: true });
    return { ok: true, data: `session ${session} is not running` };
  }
  if (cmd === "page:close") {
    // Running: the daemon closes itself below.
  } else if (running && state!.context !== context.name) {
    return fail(`session ${session} is on context "${state!.context}", not "${context.name}"`, EXIT.USAGE, [
      { hint: "close it first", cmd: `${domain.name} page:close --session ${session}` },
    ]);
  } else if (!running) {
    const started = await startSession(domain, entry, session, context, headed);
    if (!started.ok) return started.outcome;
    state = started.state;
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
  return reply.ok ? { ok: true, data: reply.text } : fail(reply.text, reply.exitCode ?? EXIT.ERROR);
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
      if (since < 90_000) return waitForStart(home, session, undefined);
      rmSync(starting, { recursive: true, force: true });
    }
  }
  try {
    rmSync(stateFile(home, session), { force: true });
    const log = Bun.file(join(dir, "daemon.log"));
    const child = Bun.spawn([...entry, "page:daemon", "--session", session, "--context", context.name, ...(headed ? ["--headed"] : [])], {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, XCLI_HOME: home },
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
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const state = readJson<SessionState | undefined>(stateFile(home, session), undefined);
    if (state?.error) return { ok: false, outcome: JSON.parse(state.error) as Outcome };
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
): Promise<void> => {
  const home = domain.home;
  const socket = socketPath(home, session);
  const base: SessionState = { pid: process.pid, socket, context: context.name, headed, startedAt: timestamp() };

  // The page command a call started under, for page:requests.
  let during: string | undefined;
  let open: OpenBrowser;
  try {
    open = await openSignedIn(domain, contexts, context, { headed, network: { bodies: true, during: () => during } });
  } catch (err) {
    const outcome = err instanceof OpError ? fail(err.message, err.exitCode, err.next) : fail((err as Error).message);
    writeJson(stateFile(home, session), { ...base, error: JSON.stringify(outcome) });
    // The CLI that started it has its answer; a daemon with no browser has nothing left to serve.
    process.exit(1);
  }

  const { page } = open;
  page.setDefaultTimeout(15_000);
  let lastActivity = Date.now();
  const active = () => (lastActivity = Date.now());
  open.context.on("request", active);
  open.context.on("requestfinished", active);
  open.context.on("requestfailed", active);
  let previous: Snapshot | undefined;
  let idleTimer: ReturnType<typeof setTimeout>;
  // An agent writing code leaves its page alone for longer than an app allows; a mouse move in the
  // page's corner counts as a person there, and changes nothing on it.
  setInterval(() => {
    if (page.isClosed()) return;
    void page.mouse
      .move(2, 2)
      .then(() => page.mouse.move(3, 3))
      .catch(() => {});
  }, STAY_ACTIVE_MS).unref();

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
    idleTimer = setTimeout(() => void shutdown(), IDLE_MS);
  };

  /** Wait for the page to go quiet: no network for half a second, at most five seconds. */
  const settle = async () => {
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    const until = Date.now() + 5000;
    while (Date.now() < until && Date.now() - lastActivity < 500) await page.waitForTimeout(100);
  };

  const snapshotDiff = async (): Promise<string> => {
    await settle();
    const snapshot = await takeSnapshot(page);
    const text = formatSnapshot(snapshot, previous);
    previous = snapshot;
    return text;
  };

  const nodeOf = (ref: string): SnapshotNode | undefined => previous?.nodes.find((n) => n.ref === ref);
  const requireRef = async (ref: string | undefined) => {
    if (!ref || !/^e\d+$/.test(ref)) throw new UsageError("give a ref such as e14, from `page`");
    const locator = refLocator(page, ref);
    if ((await locator.count()) === 0)
      throw new UsageError(`ref ${ref} is not on the page any more; run \`${domain.name} page\` for fresh refs`);
    return { locator, node: nodeOf(ref) };
  };
  const trace = (cmd: string, args: string[], node: SnapshotNode | undefined, extra: Record<string, unknown> = {}) =>
    appendJsonLine(traceFile(home, session), {
      at: timestamp(),
      session,
      cmd,
      args,
      url: page.url(),
      ...(node ? { element: formatNode({ ...node, depth: 0 }).slice(2), locator: suggestLocator(node) } : {}),
      ...extra,
    });

  const handle = async (cmd: string, args: string[]): Promise<string> => {
    switch (cmd) {
      case "page":
        return snapshotDiffFresh();
      case "page:goto": {
        const url = new URL(args[0] ?? "", context.appUrl);
        if (url.origin !== new URL(context.appUrl).origin)
          throw new UsageError(`refusing ${url.origin}: this session is for ${new URL(context.appUrl).origin}`);
        await page.goto(url.href, { waitUntil: "domcontentloaded" });
        trace(cmd, args, undefined, { locator: `page.goto(${JSON.stringify(url.href)})` });
        return snapshotDiff();
      }
      case "page:click": {
        const { locator, node } = await requireRef(args[0]);
        await locator.click();
        trace(cmd, args, node);
        return snapshotDiff();
      }
      case "page:fill": {
        const { locator, node } = await requireRef(args[0]);
        if (args[1] === undefined) throw new UsageError("give the value to fill");
        await locator.fill(args[1]);
        trace(cmd, args, node);
        const value = await locator.inputValue().catch(() => args[1]);
        return `${node?.name || node?.label || args[0]} = ${JSON.stringify(value)}`;
      }
      case "page:select": {
        const { locator, node } = await requireRef(args[0]);
        if (args[1] === undefined) throw new UsageError("give the option to choose");
        await locator.selectOption({ label: args[1] });
        trace(cmd, args, node);
        return snapshotDiff();
      }
      case "page:press": {
        if (!args[0]) throw new UsageError("give a key, such as Enter");
        if (args[1]) {
          const { locator, node } = await requireRef(args[1]);
          await locator.press(args[0]);
          trace(cmd, args, node);
        } else {
          await page.keyboard.press(args[0]);
          trace(cmd, args, undefined, { locator: `page.keyboard.press(${JSON.stringify(args[0])})` });
        }
        return snapshotDiff();
      }
      case "page:wait": {
        const what = args[0];
        if (!what) throw new UsageError("give milliseconds or text to wait for");
        if (/^\d+$/.test(what)) await page.waitForTimeout(Number(what));
        else await page.getByText(what).first().waitFor({ state: "visible" });
        trace(cmd, args, undefined);
        return snapshotDiff();
      }
      case "page:shot": {
        const path = join(sessionDir(home, session), "shots", `${Date.now()}.png`);
        mkdirSync(join(sessionDir(home, session), "shots"), { recursive: true });
        await page.screenshot({ path, fullPage: true });
        return path;
      }
      case "page:requests": {
        if (args[0] === undefined || args[0] === "all") return formatNetwork(open.network, args[0] ? Infinity : undefined);
        const call = /^\d+$/.test(args[0]) ? formatCall(open.network, Number(args[0]), args[1] === "body") : undefined;
        if (call === undefined) throw new UsageError(`no call ${args[0]} kept; \`${domain.name} page:requests\` lists the numbered ones`);
        return call;
      }
      case "page:fetch": {
        const url = new URL(args[0] ?? "", context.appUrl);
        if (url.origin !== new URL(context.appUrl).origin)
          throw new UsageError(`refusing ${url.origin}: this session is for ${new URL(context.appUrl).origin}`);
        const headers: Record<string, string> = {};
        let data: string | undefined;
        for (const arg of args.slice(1)) {
          const header = /^([\w-]+):\s*(.*)$/.exec(arg);
          if (header) headers[header[1]!] = header[2]!;
          else data = arg;
        }
        if (data !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type"))
          headers["Content-Type"] = data.trimStart().startsWith("{") ? "application/json" : "application/x-www-form-urlencoded";
        const res = await page.context().request.fetch(url.href, { method: data === undefined ? "GET" : "POST", headers, data });
        return `${res.status()} ${res.headers()["content-type"] ?? "no content type"}\n\n${await res.text()}`;
      }
      case "page:trace":
        return traceFile(home, session);
      case "page:close":
        setTimeout(() => void shutdown(), 50);
        return `session ${session} closed`;
    }
    const extra = domain.pageCommands?.[cmd.slice("page:".length)];
    if (cmd.startsWith("page:") && extra) {
      const text = await extra.run({ page, contextUrl: context.appUrl }, args);
      trace(cmd, args, undefined);
      const after = await snapshotDiff();
      return text ? `${text}\n${after}` : after;
    }
    throw new UsageError(`unknown page command ${cmd}`);
  };

  // `page` prints the whole page; it also resets what the next action's diff compares against.
  const snapshotDiffFresh = async () => {
    await settle();
    previous = await takeSnapshot(page);
    return formatSnapshot(previous);
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
            if (!READS.has(cmd)) during = [cmd, ...args].join(" ");
            return { ok: true, text: await handle(cmd, args) };
          } catch (err) {
            if (err instanceof UsageError) return { ok: false, text: err.message, exitCode: EXIT.USAGE };
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
      error: JSON.stringify(fail(`session ${session} could not listen on ${socket}: ${(err as Error).message}`)),
    });
    await open.close();
    process.exit(1);
  }

  writeJson(stateFile(home, session), { ...base, ready: true });
  touch();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void shutdown());
};

class UsageError extends Error {}
