// What the tool knows of awf: the command line and environment of a request's run, how to stop
// one, and what awf keeps of a run (its folder under `.state/runs/`), read back for status.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { envName, envValue } from "./env";
import { formatDuration } from "./output";
import type { RequestRecord } from "./requests";
import { alive, readJson, readJsonLines } from "./store";

// What the checkout installs (agentswf, and srt for its sandboxes), ahead of anything on PATH.
const BIN = join(import.meta.dir, "..", "node_modules", ".bin");

export const awfCommand = (): string => envValue("AWF") ?? (existsSync(join(BIN, "awf")) ? join(BIN, "awf") : "awf");

/**
 * The workflow each kind of request runs, and its first stage with an agent, which a redo starts
 * from. A build starts at intake, which takes one request at a time.
 */
export const WORKFLOWS = {
  build: { file: "build.ts", firstStage: "intake", intake: true },
  repair: { file: "repair.ts", firstStage: "diagnose", intake: false },
} as const;

export const workflowOf = (request: Pick<RequestRecord, "kind">): (typeof WORKFLOWS)[keyof typeof WORKFLOWS] =>
  WORKFLOWS[request.kind === "repair" ? "repair" : "build"];

export const runRoot = (home: string): string => join(home, "runs");

/** The folder awf keeps a run in, under whichever workflow's name it ran. */
const runDir = (home: string, id: string): string | undefined => {
  const root = runRoot(home);
  if (!existsSync(root)) return undefined;
  return readdirSync(root)
    .map((workflow) => join(root, workflow, id))
    .find((dir) => existsSync(dir));
};

/**
 * An attempt's file, `attempts/{n}.json`. `accounting` is only in a run from before agentswf 0.1,
 * which awf no longer reads: in the attempt file itself, or under `pre-format/` once awf's
 * migrate-runs script has moved the run on.
 */
interface AttemptFile {
  started?: string;
  ended?: string | null;
  outcome?: string;
  reason?: string;
  accounting?: { wallMs?: number; totals?: { estimate?: number } };
}

/** A run's attempt files, oldest first. */
const attemptFiles = (dir: string): AttemptFile[] => {
  const folder = join(dir, "attempts");
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    .map((f) => {
      const attempt = readJson<AttemptFile>(join(folder, f), {});
      const accounting = attempt.accounting ?? readJson<AttemptFile>(join(dir, "pre-format", "attempts", f), {}).accounting;
      return accounting ? { ...attempt, accounting } : attempt;
    });
};

/**
 * How a run's latest attempt ended, and why; neither while it runs or if it died without saying.
 * With `since`, an attempt's start: one that began before it is another attempt's, so none.
 */
export const runOutput = (home: string, id: string, since?: number): { outcome?: string; reason?: string } | undefined => {
  const dir = runDir(home, id);
  const latest = dir ? attemptFiles(dir).at(-1) : undefined;
  if (!latest) return undefined;
  if (since !== undefined && !(Date.parse(latest.started ?? "") >= since)) return undefined;
  return latest;
};

/**
 * The awf command line for a request's next attempt: a new run, or a continue of the one it has,
 * from the first stage when the request is to be redone. `timeout` is the attempt's whole budget.
 * A pane agent's pane stays open when it fails, for a look; headless and sandboxed ones keep none.
 */
export const awfArgs = (home: string, root: string, request: Pick<RequestRecord, "id" | "kind" | "redo">, timeout: string): string[] => {
  const workflow = workflowOf(request);
  const common = [
    join(root, "core", "workflows", workflow.file),
    "--run-root",
    runRoot(home),
    "--timeout",
    timeout,
    "--no-watch",
    "--id",
    request.id,
  ];
  // A continue keeps what the run started with, and awf refuses another value: a run older than this flag has its default.
  if (runDir(home, request.id) === undefined) return ["run", ...common, "--keep-panes", "on-failure", "--", request.id];
  return ["run", ...common, "--continue", ...(request.redo ? ["--from-stage", workflow.firstStage] : [])];
};

/**
 * The environment a run gets. Claude in a sandbox signs in with CLAUDE_CODE_OAUTH_TOKEN (`claude
 * setup-token`): from the environment, or the checkout's .env.
 */
export const awfEnv = (home: string, root: string): Record<string, string | undefined> => {
  const file = join(root, ".env");
  const token =
    process.env.CLAUDE_CODE_OAUTH_TOKEN ??
    (existsSync(file) ? /^CLAUDE_CODE_OAUTH_TOKEN=(.+)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim() : undefined);
  return {
    ...process.env,
    PATH: [BIN, process.env.PATH].filter(Boolean).join(":"),
    ...(token && { CLAUDE_CODE_OAUTH_TOKEN: token }),
    [envName("HOME")]: home,
  };
};

/**
 * Stop a cancelled request's run, if one is going, and clean up after it. awf stops a run on
 * SIGTERM and closes its agents; its worktree and sessions go once it has.
 */
export const stopRun = async (request: RequestRecord): Promise<void> => {
  if (alive(request.pid)) {
    process.kill(request.pid!, "SIGTERM");
    for (let i = 0; i < 120 && alive(request.pid); i++) await Bun.sleep(500);
  }
  if (request.attempts === 0) return;
  // Loaded only here: the workflows bring in awf's library, which no other command needs.
  const { cleanUpCancelled } = await import("./workflows/shared");
  await cleanUpCancelled(request);
};

export interface RunUsage {
  /** awf's list-price estimate, summed over the attempts that finished. */
  usd: number;
  /** Wall time over every attempt, the one still running up to now. */
  ms: number;
  /** An attempt is still running, so `usd` leaves it out. */
  partial: boolean;
}

/** What `awf runs --json` lists: a run's cost over its attempts, by run id. Empty when awf can't say. */
export const runEstimates = (home: string): Map<string, number> => {
  const estimates = new Map<string, number>();
  try {
    const child = Bun.spawnSync([awfCommand(), "runs", "--run-root", runRoot(home), "--limit", "100000", "--json"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (child.exitCode !== 0) return estimates;
    const { runs } = JSON.parse(child.stdout.toString()) as { runs?: { ref?: string; estimate?: number }[] };
    for (const { ref, estimate } of runs ?? [])
      if (ref && typeof estimate === "number") estimates.set(ref.slice(ref.indexOf("/") + 1), estimate);
  } catch {}
  return estimates;
};

/**
 * What a request's runs took so far: money and time, summed over its attempts. awf prices a run
 * when asked; a run from before agentswf 0.1 kept its price in its attempt files, and awf no longer
 * reads it. `estimates` is asked only for a run that needs it.
 */
export const runUsage = (
  home: string,
  id: string,
  estimates: () => Map<string, number> = () => runEstimates(home),
): RunUsage | undefined => {
  const dir = runDir(home, id);
  const attempts = dir ? attemptFiles(dir) : [];
  if (attempts.length === 0) return undefined;
  const usage: RunUsage = { usd: 0, ms: 0, partial: false };
  for (const attempt of attempts) {
    if (attempt.accounting) {
      const estimate = attempt.accounting.totals?.estimate;
      if (typeof estimate === "number") usage.usd += estimate;
      else usage.partial = true;
    } else if (!attempt.ended) usage.partial = true;
    const started = attempt.started ? Date.parse(attempt.started) : NaN;
    usage.ms +=
      attempt.accounting?.wallMs ??
      (attempt.ended ? Date.parse(attempt.ended) - started : Number.isNaN(started) ? 0 : Date.now() - started);
  }
  // Attempts since awf stopped keeping a price: a migrated run continued has both kinds.
  if (attempts.some((a) => !a.accounting)) {
    const estimate = estimates().get(id);
    if (estimate === undefined) usage.partial = true;
    else usage.usd += estimate;
  }
  return usage;
};

/** `runUsage` for many runs, asking awf for their prices at most once. */
export const runUsages = (home: string): ((id: string) => RunUsage | undefined) => {
  let estimates: Map<string, number> | undefined;
  return (id) => runUsage(home, id, () => (estimates ??= runEstimates(home)));
};

export const sumUsage = (usages: (RunUsage | undefined)[]): RunUsage =>
  usages.reduce<RunUsage>((sum, u) => ({ usd: sum.usd + (u?.usd ?? 0), ms: sum.ms + (u?.ms ?? 0), partial: sum.partial || !!u?.partial }), {
    usd: 0,
    ms: 0,
    partial: false,
  });

export const formatCost = (usage: Pick<RunUsage, "usd" | "partial">): string => `$${usage.usd.toFixed(2)}${usage.partial ? "+" : ""}`;

type Activity = { type: string; tool?: string; input?: string; from?: string };

/** The part of `awf runs <id> --json` that says what a running attempt is doing. */
interface RunView {
  stages?: { stage: string; state: string; started?: string; ended?: string }[];
  agents?: { key: string; state: string; live?: { lastActivity?: { activity: Activity; at: string } } }[];
}

/** A turn as the run's log (`log.jsonl`) has it: started, and once it settles, answered. */
interface TurnLine {
  kind: string;
  attempt?: number;
  of?: string;
  operationId?: string;
  agent?: string;
  label?: string;
  execution?: { model?: string };
}

/** A stage of a run: awf's state for it (succeeded, running, failed, or one not reached) and its time. */
export interface StageRow {
  stage: string;
  state: string;
  /** How long it ran, or has run so far; empty before it starts. */
  time: string;
  /** The running stage's open turns, with the last step of each one's agent and the time since. */
  turns: { label?: string; agent?: string; model?: string; step?: string }[];
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

/** A line of `run.jsonl`, what the run settled: an attempt claiming the run, or a stage that ran ending. */
interface RunLine {
  kind: string;
  attempt?: number;
  at?: string;
  name?: string;
  started?: string;
  provided?: boolean;
}

/**
 * How long each stage ran in the attempts before the latest, in order. A stage interrupted and run
 * again ran in several; the latest attempt reuses the ones that had succeeded, and shows them as
 * taking no time.
 */
export const earlierSpans = (lines: RunLine[]): Map<string, number[]> => {
  const latest = Math.max(0, ...lines.map((l) => l.attempt ?? 0));
  const spans = new Map<string, number[]>();
  for (const l of lines) {
    if (l.kind !== "stage" || l.provided || (l.attempt ?? 0) === latest || !l.name || !l.started || !l.at) continue;
    spans.set(l.name, [...(spans.get(l.name) ?? []), Date.parse(l.at) - Date.parse(l.started)]);
  }
  return spans;
};

/** The time a stage has run in all, and each attempt's part when it ran in more than one. */
const stageTime = (spans: number[]): string => {
  if (spans.length === 0) return "";
  const total = formatDuration(spans.reduce((sum, ms) => sum + ms, 0));
  return spans.length > 1 ? `${total} (${spans.map(formatDuration).join(" + ")})` : total;
};

/**
 * A run's stages, the running one with the turns open in the latest attempt. Their times are their
 * attempts' together, from `earlier` (`earlierSpans`) and the latest's; a stage the latest reused
 * shows as it ended.
 */
export const describeRun = (view: RunView, turns: TurnLine[], now = Date.now(), earlier: Map<string, number[]> = new Map()): StageRow[] => {
  // The latest attempt's turns: one an earlier attempt left open never settles.
  const attempt = Math.max(0, ...turns.map((t) => t.attempt ?? 0));
  const open = new Map<string, TurnLine>();
  for (const t of turns.filter((t) => (t.attempt ?? 0) === attempt)) {
    if (t.kind === "operation-started" && t.of === "turn" && t.operationId) open.set(t.operationId, t);
    else if (t.kind === "turn" && t.operationId) open.delete(t.operationId);
  }
  const live = new Map((view.agents ?? []).map((a) => [a.key, a.live?.lastActivity]));
  const carried = (state: string) => state === "reused" || state === "provided";
  return (view.stages ?? []).map((stage) => ({
    stage: stage.stage,
    state: carried(stage.state) ? "succeeded" : stage.state,
    time: stageTime([
      ...(earlier.get(stage.stage) ?? []),
      ...(stage.started && !carried(stage.state)
        ? [Math.max(0, (stage.ended ? Date.parse(stage.ended) : now) - Date.parse(stage.started))]
        : []),
    ]),
    turns:
      stage.state === "running"
        ? [...open.values()].map((t) => {
            const last = live.get(t.agent ?? "");
            return {
              label: t.label,
              agent: t.agent,
              model: t.execution?.model,
              step: last && `${doing(last.activity)} (${since(last.at, now)})`,
            };
          })
        : [],
  }));
};

/** `describeRun` of a request's run as awf sees it now; undefined when awf can't say. */
export const runActivity = async (home: string, id: string): Promise<StageRow[] | undefined> => {
  try {
    const dir = runDir(home, id);
    if (!dir) return undefined;
    const child = Bun.spawn([awfCommand(), "runs", id, "--run-root", runRoot(home), "--json"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) return undefined;
    return describeRun(
      JSON.parse(out) as RunView,
      readJsonLines<TurnLine>(join(dir, "log.jsonl")),
      Date.now(),
      earlierSpans(readJsonLines<RunLine>(join(dir, "run.jsonl"))),
    );
  } catch {
    return undefined;
  }
};
