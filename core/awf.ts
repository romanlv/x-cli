// What the tool knows of awf: the command line and environment of a request's run, how to stop
// one, and what awf keeps of a run (its folder under `.state/runs/`), read back for status.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { envName, envValue } from "./env";
import { formatDuration } from "./output";
import type { RequestRecord } from "./requests";
import { alive, readJson, readJsonLines } from "./store";

export const awfCommand = (): string => envValue("AWF") ?? "awf";

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

/** awf's record of a run's last attempt: how it ended and why. */
export const runOutput = (home: string, id: string): { outcome?: string; reason?: string } | undefined => {
  const dir = runDir(home, id);
  return dir ? readJson(join(dir, "output.json"), undefined) : undefined;
};

/**
 * The awf command line for a request's next attempt: a new run, or a continue of the one it has,
 * from the first stage when the request is to be redone. `timeout` is the attempt's whole budget.
 */
export const awfArgs = (home: string, root: string, request: Pick<RequestRecord, "id" | "kind" | "redo">, timeout: string): string[] => {
  const workflow = workflowOf(request);
  const common = [join(root, "core", "workflows", workflow.file), "--run-root", runRoot(home), "--timeout", timeout, "--no-watch"];
  if (runDir(home, request.id) === undefined) return ["run", ...common, "--id", request.id, "--", request.id];
  return ["run", ...common, "--continue", request.id, ...(request.redo ? ["--from-stage", workflow.firstStage] : [])];
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
  return { ...process.env, ...(token && { CLAUDE_CODE_OAUTH_TOKEN: token }), [envName("HOME")]: home };
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

/** A turn as the run's log (`turns.jsonl`) has it: started, and once it settles, answered. */
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

/** A run's stages, the running one with the turns open in the latest attempt. */
export const describeRun = (view: RunView, turns: TurnLine[], now = Date.now()): StageRow[] => {
  // The latest attempt's turns: one an earlier attempt left open never settles.
  const attempt = Math.max(0, ...turns.map((t) => t.attempt ?? 0));
  const open = new Map<string, TurnLine>();
  for (const t of turns.filter((t) => (t.attempt ?? 0) === attempt)) {
    if (t.kind === "operation-started" && t.of === "turn" && t.operationId) open.set(t.operationId, t);
    else if (t.kind === "turn" && t.operationId) open.delete(t.operationId);
  }
  const live = new Map((view.agents ?? []).map((a) => [a.key, a.live?.lastActivity]));
  return (view.stages ?? []).map((stage) => ({
    stage: stage.stage,
    state: stage.state,
    time: stage.started ? formatDuration(Math.max(0, (stage.ended ? Date.parse(stage.ended) : now) - Date.parse(stage.started))) : "",
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
    return describeRun(JSON.parse(out) as RunView, readJsonLines<TurnLine>(join(dir, "turns.jsonl")));
  } catch {
    return undefined;
  }
};
