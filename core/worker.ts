// The worker: a loop that takes the oldest received request and starts an awf run for it, at most
// two at a time. Filing a request starts it if none is running; it exits once nothing is running.
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { envName, envNumber, envValue } from "./env";
import { isSignInQuestion, isTerminal, type RequestRecord, Requests } from "./requests";
import { alive, readJson, withLock, writeJson } from "./store";

// An attempt's whole budget. Each turn has its own timeout and revise rounds are capped, so this only
// stops a run that hangs; a build that explores, writes and revises runs past an hour.
export const RUN_TIMEOUT = envValue("RUN_TIMEOUT") ?? "3h";

export const workflowFile = (root: string, request: Pick<RequestRecord, "kind">): string =>
  join(root, "core", "workflows", request.kind === "repair" ? "repair.ts" : "build.ts");

export const runRoot = (home: string): string => join(home, "runs");

/** The folder awf keeps a run in, under whichever workflow's name it ran. */
export const runDir = (home: string, id: string): string | undefined => {
  const root = runRoot(home);
  if (!existsSync(root)) return undefined;
  return readdirSync(root)
    .map((workflow) => join(root, workflow, id))
    .find((dir) => existsSync(dir));
};

/** awf's record of a run's last attempt: how it ended and why. */
export const runOutput = (home: string, id: string): { outcome?: string; reason?: string; [k: string]: unknown } | undefined => {
  const dir = runDir(home, id);
  return dir ? readJson(join(dir, "output.json"), undefined) : undefined;
};

/**
 * The first stage with an agent in each workflow. A run that completed (deferred, declined, flaky)
 * takes another attempt only from a stage awf is told to redo, so a retry redoes from here.
 */
export const FIRST_STAGE = { build: "intake", repair: "diagnose" } as const;

export interface RunUsage {
  /** awf's list-price estimate, summed over the attempts that finished. */
  usd: number;
  /** Wall time over every attempt, the one still running up to now. */
  ms: number;
  /** An attempt is still running, so `usd` leaves it out. */
  partial: boolean;
}

/** What a request's runs took so far: money and time, summed over its attempts. */
export const runUsage = (home: string, id: string): RunUsage | undefined => {
  const dir = runDir(home, id);
  const attempts = dir && existsSync(join(dir, "attempts")) ? readdirSync(join(dir, "attempts")).filter((f) => f.endsWith(".json")) : [];
  if (attempts.length === 0) return undefined;
  const usage: RunUsage = { usd: 0, ms: 0, partial: false };
  for (const file of attempts) {
    const attempt = readJson<{ started?: string; ended?: string | null; accounting?: { wallMs?: number; totals?: { estimate?: number } } }>(
      join(dir!, "attempts", file),
      {},
    );
    const estimate = attempt.accounting?.totals?.estimate;
    if (typeof estimate === "number") usage.usd += estimate;
    else usage.partial = true;
    const started = attempt.started ? Date.parse(attempt.started) : NaN;
    usage.ms +=
      attempt.accounting?.wallMs ??
      (attempt.ended ? Date.parse(attempt.ended) - started : Number.isNaN(started) ? 0 : Date.now() - started);
  }
  return usage;
};

export const formatCost = (usage: Pick<RunUsage, "usd" | "partial"> | undefined): string =>
  usage ? `$${usage.usd.toFixed(2)}${usage.partial ? "+" : ""}` : "";

export const formatDuration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};

type Activity = { type: string; tool?: string; input?: string; from?: string };

/** The part of `awf runs <id> --json` that says what a running attempt is doing. */
export interface RunView {
  stages?: { stage: string; state: string; started?: string; ended?: string }[];
  agents?: { key: string; state: string; live?: { lastActivity?: { activity: Activity; at: string } } }[];
}

/** A turn as the run's log (`turns.jsonl`) has it: started, and once it settles, answered. */
export interface TurnLine {
  kind: string;
  attempt?: number;
  of?: string;
  operationId?: string;
  agent?: string;
  label?: string;
  deliveredAt?: string;
  execution?: { model?: string };
}

// A shell command's leading `NAME=value;` and `cd dir &&` say nothing of what it runs; awf cuts a
// long one, so an assignment can be all there is.
const command = (input: string): string =>
  input
    .replace(/^(\s*(\w+=("[^"]*"|'[^']*'|[^\s;]*)\s*(;|$)|cd\s+\S+\s*&&)\s*)+/, "")
    .replace(/\s+/g, " ")
    .trim();

const doing = (activity: Activity): string => {
  if (activity.type === "tool") {
    const what = activity.input ? command(activity.input) : "";
    return `${activity.tool}${what ? `: ${what.length > 50 ? `${what.slice(0, 49)}…` : what}` : ""}`;
  }
  if (activity.type === "message") return activity.from === "agent" ? "writing" : "reading its prompt";
  if (activity.type === "tool-result") return "reading a result";
  return "working";
};

const since = (iso: string, now: number) => formatDuration(Math.max(0, now - Date.parse(iso)));

const MARK: Record<string, string> = { succeeded: "✓", running: "▸", failed: "✗" };

/**
 * A run's stages, one row each: `✓ write    16m`, and the running one with each open turn as
 * `revise 1 · builder (model) · Bash: … (4m)`: its label, agent, and the agent's last step with the
 * time since. A row's `key` leaves the times and steps out, for a log that prints a row only when it changes.
 */
export const describeRun = (view: RunView, turns: TurnLine[], now = Date.now()): { text: string; key: string }[] => {
  const stages = view.stages ?? [];
  // The latest attempt's turns: one an earlier attempt left open never settles.
  const attempt = Math.max(0, ...turns.map((t) => t.attempt ?? 0));
  const open = new Map<string, TurnLine>();
  for (const t of turns.filter((t) => (t.attempt ?? 0) === attempt)) {
    if (t.kind === "operation-started" && t.of === "turn" && t.operationId) open.set(t.operationId, t);
    else if (t.kind === "turn" && t.operationId) open.delete(t.operationId);
  }
  const live = new Map((view.agents ?? []).map((a) => [a.key, a.live?.lastActivity]));
  const width = Math.max(0, ...stages.map((s) => s.stage.length));
  return stages.map((stage) => {
    const time = stage.started
      ? formatDuration(Math.max(0, (stage.ended ? Date.parse(stage.ended) : now) - Date.parse(stage.started)))
      : "";
    const head = `${MARK[stage.state] ?? "·"} ${stage.stage.padEnd(width)}  ${time}`;
    if (stage.state !== "running") return { text: head, key: `${stage.stage} ${stage.state}` };
    const working = [...open.values()].map((t) => {
      const last = live.get(t.agent ?? "");
      const step = last ? ` · ${doing(last.activity)} (${since(last.at, now)})` : "";
      return {
        text: `${t.label} · ${t.agent}${t.execution?.model ? ` (${t.execution.model})` : ""}${step}`,
        key: `${t.label} · ${t.agent}`,
      };
    });
    return {
      text: [head, ...working.map((w) => w.text)].join(" · "),
      key: [`${stage.stage} running`, ...working.map((w) => w.key)].join(" · "),
    };
  });
};

/** `describeRun` of a request's run as awf sees it now; undefined when awf can't say. */
export const runActivity = async (
  home: string,
  id: string,
  awf = envValue("AWF") ?? "awf",
): Promise<{ text: string; key: string }[] | undefined> => {
  try {
    const dir = runDir(home, id);
    if (!dir) return undefined;
    const child = Bun.spawn([awf, "runs", id, "--run-root", runRoot(home), "--json"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) return undefined;
    const log = join(dir, "turns.jsonl");
    const turns = existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as TurnLine)
      : [];
    return describeRun(JSON.parse(out) as RunView, turns);
  } catch {
    return undefined;
  }
};

/** A run that completed takes another attempt only to redo a stage; a retry redoes from the first. */
const redoes = (home: string, request: RequestRecord): boolean => !!request.redo || runOutput(home, request.id)?.outcome === "completed";

/** The awf command line for a request's next attempt: a new run, a continue, or a redo from the first stage. */
export const awfArgs = (home: string, root: string, request: RequestRecord): string[] => {
  const common = [workflowFile(root, request), "--run-root", runRoot(home), "--timeout", RUN_TIMEOUT, "--no-watch"];
  if (runDir(home, request.id) === undefined) return ["run", ...common, "--id", request.id, "--", request.id];
  const first = FIRST_STAGE[request.kind === "repair" ? "repair" : "build"];
  return ["run", ...common, "--continue", request.id, ...(redoes(home, request) ? ["--from-stage", first] : [])];
};

// One intake at a time, so each sees what the one before it decided and can find it is the same.
const inIntake = (r: RequestRecord): boolean => r.kind !== "repair" && (r.stage === undefined || r.stage === FIRST_STAGE.build);
const startsAtIntake = (home: string, r: RequestRecord): boolean =>
  r.kind !== "repair" && (r.stage === undefined || r.stage === FIRST_STAGE.build || redoes(home, r));

/** Claude in a sandbox signs in with CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`): from the environment, or the checkout's .env. */
const claudeToken = (root: string): Record<string, string> => {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return {};
  const file = join(root, ".env");
  const token = existsSync(file) ? /^CLAUDE_CODE_OAUTH_TOKEN=(.+)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim() : undefined;
  return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
};

/** Start a worker in the background unless one is running. `entry` re-invokes this CLI. */
export const ensureWorker = (home: string, entry: string[]): void => {
  if (envValue("NO_WORKER")) return;
  mkdirSync(home, { recursive: true });
  const pidFile = join(home, "worker.json");
  withLock(join(home, "worker.lock"), () => {
    if (alive(readJson<{ pid?: number }>(pidFile, {}).pid)) return;
    // Appended, so a worker started later keeps the log of the ones before it.
    const log = openSync(join(home, "worker.log"), "a");
    const child = Bun.spawn([...entry, "request:worker"], {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, [envName("HOME")]: home },
    });
    child.unref();
    writeJson(pidFile, { pid: child.pid, startedAt: new Date().toISOString() });
  });
};

const settle = (requests: Requests, home: string, id: string, exitCode: number | null): void => {
  const request = requests.get(id);
  // The workflow records how its run ended; only a run that died without saying so is settled here.
  if (request?.state !== "building") return;
  const output = runOutput(home, id);
  const why = (output?.reason as string | undefined) ?? (exitCode === null ? "the run was killed" : `awf exited ${exitCode}`);
  requests.update(id, () => ({ state: "failed", reason: `the run ended without a result: ${why}`, pid: undefined }));
};

/** A request is ready unless it waits on another that still holds its op. */
const ready = (requests: Requests, request: RequestRecord): boolean => {
  if (!request.waitingFor) return true;
  const holder = requests.get(request.waitingFor);
  return !holder || isTerminal(holder.state);
};

/** How often the worker keeps the sign-in of a context with a running request alive. */
export const KEEP_SIGNED_IN_MS = envNumber("KEEP_SIGNED_IN_MS", 5 * 60_000);

export const runWorker = async (
  home: string,
  root: string,
  {
    pollMs = 2000,
    awf = envValue("AWF") ?? "awf",
    keepSignedIn,
    keepSignedInMs = KEEP_SIGNED_IN_MS,
    maxRunning = 2,
  }: {
    pollMs?: number;
    /** Runs at once: the domain's `maxRunning`, or MAX_RUNNING from the environment. */
    maxRunning?: number;
    awf?: string;
    /** Touch a context's session so an app's idle timeout doesn't sign it out mid-run. */
    keepSignedIn?: (context: string) => Promise<unknown>;
    keepSignedInMs?: number;
  } = {},
): Promise<void> => {
  const requests = new Requests(home);
  const pidFile = join(home, "worker.json");
  const lock = join(home, "worker.lock");
  const claimed = withLock(lock, () => {
    const pid = readJson<{ pid?: number }>(pidFile, {}).pid;
    // ensureWorker writes the pid of the worker it starts, so that one finds itself here.
    if (pid !== process.pid && alive(pid)) return false;
    writeJson(pidFile, { pid: process.pid, startedAt: new Date().toISOString() });
    return true;
  });
  if (!claimed) return;

  const running = new Map<string, Bun.Subprocess>();
  const start = (request: RequestRecord): void => {
    const args = awfArgs(home, root, request);
    let child: Bun.Subprocess;
    try {
      child = Bun.spawn([awf, ...args], {
        cwd: root,
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, ...claudeToken(root), [envName("HOME")]: home },
        onExit: (_, code) => {
          running.delete(request.id);
          settle(requests, home, request.id, code);
        },
      });
    } catch (err) {
      requests.update(request.id, () => ({ state: "failed", reason: `could not start awf: ${(err as Error).message}` }));
      return;
    }
    running.set(request.id, child);
    // A redo starts at intake: its stage is cleared so the worker counts it as in intake until then.
    const stage = startsAtIntake(home, request) ? { stage: undefined } : {};
    requests.update(
      request.id,
      (r) => ({ state: "building", attempts: r.attempts + 1, pid: child.pid, waitingFor: undefined, ...stage }),
      "started",
    );
    console.error(`${new Date().toISOString()} ${request.id}: awf ${args.join(" ")}`);
  };

  const queue = () =>
    requests
      .list({ state: "received" })
      .reverse()
      // A request that blocked or waits on a lock keeps the pid of the awf that is still closing its agents.
      .filter((r) => !running.has(r.id) && !alive(r.pid) && ready(requests, r));

  // Agents can go longer than an app's idle timeout without touching it (writing code, reviewing),
  // so the worker keeps each running request's context signed in. One touch at a time.
  let touching = false;
  let touchedAt = Date.now();
  const touch = (): void => {
    if (!keepSignedIn || touching || Date.now() - touchedAt < keepSignedInMs) return;
    const contexts = [...new Set(requests.list({ state: "building" }).map((r) => r.context))];
    if (contexts.length === 0) return;
    touching = true;
    touchedAt = Date.now();
    void (async () => {
      for (const context of contexts) await keepSignedIn(context).catch(() => {});
    })().finally(() => (touching = false));
  };

  // A run that blocked on signing in gets one try at it per attempt, before the worker would exit.
  const triedSignIn = new Set<string>();
  const signInAgain = async (): Promise<void> => {
    if (!keepSignedIn) return;
    for (const r of requests.list({ state: "blocked" }).filter((b) => isSignInQuestion(b.question))) {
      if (triedSignIn.has(`${r.id}/${r.attempts}`)) continue;
      triedSignIn.add(`${r.id}/${r.attempts}`);
      await keepSignedIn(r.context).catch(() => {});
    }
  };

  for (;;) {
    touch();
    await signInAgain();
    // A run started by an earlier worker that died: settled once it ends, and counted until then.
    const orphans = requests.list({ state: "building" }).filter((r) => !running.has(r.id));
    for (const request of orphans) if (!alive(request.pid)) settle(requests, home, request.id, null);
    const busy = running.size + orphans.filter((r) => alive(r.pid)).length;
    let started = busy;
    let intaking = requests.list({ state: "building" }).some(inIntake);
    for (const request of queue()) {
      if (started >= maxRunning) break;
      const intake = startsAtIntake(home, request);
      if (intake && intaking) continue;
      start(request);
      started++;
      intaking ||= intake;
    }
    if (running.size === 0 && busy === 0) {
      // Exit only under the lock, after a last look: a request filed meanwhile found this worker
      // alive and started none, so it must not be left behind.
      const done = withLock(lock, () => {
        if (queue().length > 0) return false;
        writeJson(pidFile, {});
        return true;
      });
      if (done) return;
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
};
