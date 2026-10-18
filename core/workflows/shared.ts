// What build.ts and repair.ts share: the request's run as stages that keep the ledger current, the
// team of agents, the verify → review → revise loop with its escalation, and the merge.
//
// awf reuses a stage that succeeded on a continue and runs the code between stages on every attempt.
// So what must hold on every attempt sits between stages: the worktree, the op's lock, recording how
// the request ended. And each prompt carries the whole brief, since agents start fresh each attempt;
// prompts.ts writes them.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import {
  type AgentRef,
  defineExecutableWorkflow,
  isAnswered,
  type JsonValue,
  type SandboxRef,
  type WorkflowContext,
  type WorkflowMeta,
} from "agentswf/workflow";
import Type from "typebox";
import { envName, envValue } from "../env";
import * as prompts from "../instructions/prompts";
import { opFromFolder } from "../names";
import { commandLine } from "../output";
import { isSignInQuestion, isTerminal, REQUEST_ID, type RequestKind, type RequestRecord, Requests, signInQuestion } from "../requests";
import { loadConfig, type Role, type WorkflowConfig } from "./config";
import { type CheckScope, cliEnv, type Deps, domainIn, entryIn, examplesIn, realDeps, type Verified } from "./deps";
import { type SandboxPaths, sandboxPaths, shellEnv, widen } from "./sandbox";

const MINUTE = 60_000;

/** What bounds a run, so one that keeps finding something new, or failing the same way, still ends. */
export const LIMITS = {
  /** Revise rounds at most, whoever has them. */
  rounds: 8,
  /** Sign-ins from the checkout's .env file, so a wrong password doesn't loop. */
  signIns: 2,
  /** Merge attempts while main keeps moving under the rebase or the fast-forward. */
  merges: 4,
  /** A turn: intake, which only reads; most turns; and those that drive the app at length (explore, write, diagnose). */
  shortTurnMs: 10 * MINUTE,
  turnMs: 30 * MINUTE,
  longTurnMs: 40 * MINUTE,
};

/** How far a round's check got, in the order it runs them; fast and full are the checks' scopes. */
const AT = { verify: 0, fast: 1, review: 2, full: 3 } as const;

/** Where a round's check stopped, and how many problems there. */
interface Standing {
  at: (typeof AT)[keyof typeof AT];
  count: number;
}
/**
 * Further along, or as far with fewer problems. After the full checks failed, a round is reviewed
 * afresh, so reaching the review again counts.
 */
const progressed = (now: Standing, before: Standing): boolean =>
  now.at > before.at || (now.at === before.at && now.count < before.count) || (before.at === AT.full && now.at === AT.review);

// ── Answers, which are also the stages' results ───────────────────────────────────────────────────
const strict = { additionalProperties: false } as const;
/** The one question only a person can answer, which `ask` lets any turn end with. */
export const QUESTION = Type.Object({ kind: Type.Literal("question"), question: Type.String() }, strict);

const BUILD = {
  kind: Type.Literal("build"),
  op: Type.String({ description: "noun:verb, lowercase, no hyphen in the noun" }),
  summary: Type.String({ description: "the intent, in a few sentences" }),
};
const NOT_BUILT = [
  Type.Object({ kind: Type.Literal("duplicate"), command: Type.String(), reason: Type.String() }, strict),
  Type.Object(
    {
      kind: Type.Literal("same"),
      request: Type.String({ description: "the open request it is the same as: R-0003" }),
      reason: Type.String(),
    },
    strict,
  ),
  Type.Object({ kind: Type.Literal("deferred"), reason: Type.String() }, strict),
  Type.Object({ kind: Type.Literal("declined"), reason: Type.String() }, strict),
] as const;
export const INTAKE = Type.Union([Type.Object(BUILD, strict), ...NOT_BUILT]);
/** Intake's stage result: its answer, and with build whether the op is there to change, which the run decides. */
export const PLAN = Type.Union([Type.Object({ ...BUILD, change: Type.Boolean() }, strict), ...NOT_BUILT]);
export const DONE = Type.Object({ kind: Type.Literal("done"), summary: Type.String() }, strict);
/** The way explore picked, or that none serves. */
export const EXPLORED = Type.Union([
  DONE,
  Type.Object({ kind: Type.Literal("missing"), reason: Type.String({ description: "what was tried, and why none serves" }) }, strict),
]);
export const DIAGNOSIS = Type.Union([
  Type.Object({ kind: Type.Literal("reproduced"), diagnosis: Type.String() }, strict),
  Type.Object({ kind: Type.Literal("flaky"), reason: Type.String() }, strict),
]);
/** A review: no blocking finding approves; minor ones are fixed without another review. */
export const REVIEW = Type.Object(
  {
    findings: Type.Array(
      Type.Object(
        {
          where: Type.String(),
          problem: Type.String(),
          severity: Type.Union([Type.Literal("blocking"), Type.Literal("minor")], {
            description: `blocking: ${prompts.SEVERITY.blocking}. minor: ${prompts.SEVERITY.minor}`,
          }),
        },
        strict,
      ),
    ),
  },
  strict,
);
export type Finding = Type.Static<typeof REVIEW>["findings"][number];

/** The schema `ask` sends: its answers, and the question beside them. */
export const orQuestion = <S extends Type.TSchema>(schema: S): Type.TUnion<[S, typeof QUESTION]> =>
  Type.Union([...(Type.IsUnion(schema) ? schema.anyOf : [schema]), QUESTION]) as unknown as Type.TUnion<[S, typeof QUESTION]>;

type Answer<S extends Type.TSchema> = Extract<Type.Static<S>, JsonValue>;

/** `base` is the main commit the approval was given on: merge checks again when main has moved past it. */
const CHECKED = Type.Object({ revisions: Type.Number(), by: Type.String(), base: Type.String() }, strict);
type Approval = Omit<Type.Static<typeof CHECKED>, "base">;
const MERGED = Type.Object({ commit: Type.String() }, strict);
export type Result = { state: string; summary: string };

// ── The run ───────────────────────────────────────────────────────────────────────────────────────
type RunArgs = {
  id: string;
  home: string;
};

const prepareArgs = ({ argv }: { argv: readonly string[] }): RunArgs => {
  const id = argv[0];
  if (!id || !REQUEST_ID.test(id)) throw new Error("usage: awf run <workflow> -- R-0012");
  const home = envValue("HOME");
  if (!home) throw new Error(`${envName("HOME")} is not set: the worker starts these runs`);
  return { id, home };
};

export interface Paths {
  worktree: string;
  branch: string;
  /** The domain folder inside the worktree. */
  domainDir: string;
  /**
   * How agents call the CLI: the worktree's own, so the op they write is the one that runs, in the
   * request's home, never filing requests or starting the worker.
   */
  cli: string;
  /** The session the builder explores in; the checker's is `<session>-check`. */
  session: string;
  trace: string;
  /** Where sandboxed agents keep their CLI state and sockets; absent when agents run unsandboxed. */
  sandbox?: SandboxPaths;
  /** A command as an agent runs it: in a sandbox, with the host's browser and a temp directory it can write. */
  run(command: string): string;
}

const envLine = (env: Record<string, string>): string =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

const worktreeOf = (request: RequestRecord): string => join(request.domain.home, "worktrees", request.id);
const branchOf = (request: RequestRecord): string => `req/${request.id}`;

export const pathsFor = (
  request: RequestRecord,
  config: WorkflowConfig,
  sandbox = config.sandbox ? sandboxPaths(request) : undefined,
): Paths => {
  const worktree = worktreeOf(request);
  return {
    worktree,
    branch: branchOf(request),
    domainDir: domainIn(worktree, request),
    cli: `env ${envLine(cliEnv(request, sandbox))} bun ${entryIn(worktree, request)}`,
    session: request.id,
    trace: join(sandbox?.home ?? request.domain.home, "sessions", request.id, "trace.jsonl"),
    ...(sandbox && { sandbox }),
    run: (command) => (sandbox ? `env ${envLine(shellEnv(sandbox))} ${command}` : command),
  };
};

/** One request's run: its stages keep the ledger's stage current, and a block or an end records itself. */
export class RequestRun {
  readonly ledger: Requests;
  #config?: WorkflowConfig;
  #paths?: Paths;
  #signIns = 0;

  constructor(
    readonly workflow: WorkflowContext,
    readonly deps: Deps,
    readonly id: string,
    home: string,
  ) {
    this.ledger = new Requests(home);
  }

  get request(): RequestRecord {
    const request = this.ledger.get(this.id);
    if (!request) throw new Error(`no request ${this.id}`);
    return request;
  }

  /** workflows.json, as it was when the run first asked: one run never changes models or sandbox midway. */
  get config(): WorkflowConfig {
    this.#config ??= loadConfig(this.request.domain.root);
    return this.#config;
  }

  /** From the request's id, domain and context, which a run never changes. */
  get paths(): Paths {
    this.#paths ??= pathsFor(this.request, this.config);
    return this.#paths;
  }

  stage<S extends Type.TSchema>(
    name: string,
    result: S,
    summary: (value: Type.Static<S>) => string,
    work: () => Promise<Type.Static<S>>,
  ): Promise<Type.Static<S>> {
    return this.workflow.stage(name, { result, summary }, async () => {
      this.ledger.update(this.id, () => ({ stage: name, redo: undefined }), "stage");
      return work();
    }) as Promise<Type.Static<S>>;
  }

  /** Sign the context in again from its .env file, a few times a run at most. */
  async signInAgain(): Promise<boolean> {
    if (this.#signIns >= LIMITS.signIns) return false;
    this.#signIns++;
    return this.deps.signIn(this.request);
  }

  /** Stop the run blocked on one question; `request:answer` continues it from this stage. */
  block(question: string): never {
    this.ledger.update(this.id, () => ({ state: "blocked", question }));
    return this.workflow.stop(`blocked: ${question}`);
  }

  /** Take the op's lock, on every attempt; when another open request holds it, wait for that one. */
  async lock(op: string): Promise<void> {
    const holder = this.ledger.lockOp(op, this.id);
    if (holder) await this.waitFor(holder, `${holder}, which holds ${op}`);
  }

  /**
   * Stop until another request ends. With nothing built yet, the worktree is dropped and the next
   * attempt starts again from the first stage, so it reads the request against main as that one left
   * it; otherwise it continues where it stopped.
   */
  async waitFor(holder: string, why: string): Promise<never> {
    const untouched = (await this.deps.git.changed(this.paths.worktree)).length === 0;
    if (untouched) await this.cleanUp();
    this.ledger.update(this.id, () => ({ state: "received", waitingFor: holder, ...(untouched && { redo: true }) }), "waiting");
    return this.workflow.stop(`waiting for ${why}`);
  }

  /** The other open requests, oldest first: intake may find this one is the same as one of them. */
  others(): RequestRecord[] {
    return this.ledger
      .list()
      .reverse()
      .filter((r) => r.id !== this.id && !isTerminal(r.state));
  }

  /** End the request, built or not: record how, free its op, and clean up. Safe to repeat. */
  async end(
    state: "done" | "deferred" | "declined" | "duplicate" | "failed",
    summary: string,
    result?: RequestRecord["result"],
  ): Promise<Result> {
    const { op } = this.request;
    this.ledger.update(this.id, () => ({ state, reason: summary, result, pid: undefined, stage: undefined }));
    if (op) this.ledger.unlockOp(op, this.id);
    await this.cleanUp();
    return { state, summary };
  }

  async cleanUp(): Promise<void> {
    await cleanUpAfter(this.deps, this.request, this.paths.sandbox);
  }
}

const sessionsOf = (request: RequestRecord): string[] => [request.id, `${request.id}-check`];

/** Close a request's browser sessions, in the CLI home its agents used, and remove its worktree. */
const cleanUpAfter = async (deps: Deps, request: RequestRecord, sandbox?: SandboxPaths): Promise<void> => {
  const worktree = worktreeOf(request);
  await deps.closeSessions(worktree, request, sessionsOf(request), sandbox);
  await deps.git.removeWorktree(request.domain.root, worktree, branchOf(request));
  if (sandbox) rmSync(sandbox.sockets, { recursive: true, force: true });
};

/**
 * Clean up after a cancelled request, once its run has stopped. workflows.json may have changed
 * since the run read it, so its sessions are closed in the request's sandbox home as well when it
 * has one: closing a session that isn't running does nothing.
 */
export const cleanUpCancelled = async (request: RequestRecord, deps: Deps = realDeps): Promise<void> => {
  const sandbox = sandboxPaths(request);
  if (existsSync(sandbox.home)) await deps.closeSessions(worktreeOf(request), request, sessionsOf(request), sandbox);
  await cleanUpAfter(deps, request);
  rmSync(sandbox.sockets, { recursive: true, force: true });
};

/**
 * A workflow over one request, as the worker starts it: `awf run <file> --id R-0012 -- R-0012`, the
 * run's id the request's. The worktree is there on every attempt before `body` runs.
 */
export const defineRequestWorkflow = (meta: WorkflowMeta, body: (run: RequestRun, team: Team) => Promise<Result>) => (deps: Deps) =>
  defineExecutableWorkflow<RunArgs, Result>({
    definition: {
      meta,
      run: async (workflow, { id, home }) => {
        const run = new RequestRun(workflow, deps, id, home);
        await deps.git.ensureWorktree(run.request.domain.root, run.paths.worktree, run.paths.branch);
        return body(run, openTeam(run));
      },
    },
    prepare: prepareArgs,
    present: (result) => `${result.state}: ${result.summary}`,
  });

/**
 * One turn's answer. A turn stuck on a permission prompt or a missing login blocks the request, since
 * only a person can clear it; any other turn without an answer stops the run, which the worker
 * records failed and `request:retry` continues.
 */
const turn = async <S extends Type.TSchema>(
  run: RequestRun,
  agent: AgentRef,
  schema: S,
  label: string,
  prompt: string,
  timeoutMs: number,
): Promise<Answer<S>> => {
  const { outcome } = await agent.run<Answer<S>>({ prompt, schema, label, timeoutMs });
  if (isAnswered(outcome)) return outcome.value;
  // The question names the agent, whose login or settings a person fixes, and the turn it was on.
  const who = `the ${agent.key} agent (${label})`;
  if (outcome.kind === "failed" && outcome.login)
    return run.block(`${who} has no login: ${outcome.login.run}, then answer this request to go on`);
  if (outcome.kind === "blocked") {
    return run.block(
      `${who} stopped at a prompt only a person can answer (${outcome.reason}); allow it in the agent's settings, then answer this request to go on`,
    );
  }
  return run.workflow.stop(`${label}: ${outcome.kind}: ${outcome.reason}`);
};

/**
 * Ask, and return the answer. The agent may answer with a question instead, which blocks the request
 * on it; asked to sign in again, the run does so from the checkout when it can, and the agent goes on.
 */
export const ask = async <S extends Type.TSchema>(
  run: RequestRun,
  agent: AgentRef,
  schema: S,
  label: string,
  prompt: string,
  timeoutMs = LIMITS.turnMs,
): Promise<Answer<S>> => {
  const value = await turn(run, agent, orQuestion(schema), label, prompt, timeoutMs);
  const asked = value as { kind?: unknown; question: string };
  if (asked.kind !== "question") return value as Answer<S>;
  if (isSignInQuestion(asked.question) && (await run.signInAgain()))
    return ask(run, agent, schema, label, prompts.signedInAgain(run.request), timeoutMs);
  return run.block(asked.question);
};

// ── The team ──────────────────────────────────────────────────────────────────────────────────────
export type Team = Record<Role, () => Promise<AgentRef>>;

/** The team, each on the model workflows.json names; sandboxed, they share one sandbox, so the checker reads the builder's trace. */
const openTeam = (run: RequestRun): Team => {
  const { workflow, request, paths, config } = run;
  let box: Promise<SandboxRef> | undefined;
  const sandbox = async () => {
    if (!paths.sandbox) return {};
    box ??= run.deps
      .sandbox(request, paths.worktree, paths.sandbox)
      .then((spec) => widen(spec, config.sandbox || {}, request.domain.root))
      .then((spec) => workflow.sandboxes.open({ key: "agents", cwd: paths.worktree, ...spec }));
    return { sandbox: await box };
  };
  const open = (role: Role, instructions: string) => async () => {
    const runtime = config.agents[role];
    // A pane agent's pane stays open when it fails, for a look; a headless one has none, and awf
    // doesn't keep a sandboxed one's, whose pane is in the sandbox's own Herdr.
    const keep =
      paths.sandbox || (typeof runtime === "object" && runtime.placement === "headless") ? {} : { keepPane: "on-failure" as const };
    return workflow.agents.open({ key: role, runtime, cwd: paths.worktree, instructions, ...keep, ...(await sandbox()) });
  };
  const builder = prompts.builderInstructions(run);
  return {
    planner: open("planner", prompts.plannerInstructions(run)),
    builder: open("builder", builder),
    checker: open("checker", prompts.checkerInstructions(run)),
    troubleshooter: open("troubleshooter", builder),
  };
};

// ── Verify, review, revise ────────────────────────────────────────────────────────────────────────
/** Code every op may run: core and the domain's `.ts` outside its ops (helpers, model, mappers, domain.ts), but not their tests. */
const sharedCodeIn = (paths: Paths, files: string[]): boolean => {
  const domain = relative(paths.worktree, paths.domainDir);
  return files.some(
    (f) =>
      f.endsWith(".ts") &&
      !f.endsWith(".test.ts") &&
      (f.startsWith("core/") || f.startsWith(`${domain}/`)) &&
      !f.startsWith(`${domain}/ops/`),
  );
};

/** Every op with an example for this context, as the worktree has them now, and every op whose examples.json can't be read, so verify says so. */
const opsWithExamples = (paths: Paths, context: string): string[] => {
  const ops = join(paths.domainDir, "ops");
  if (!existsSync(ops)) return [];
  const verifiable = (folder: string): boolean => {
    try {
      return examplesIn(join(ops, folder)).some((e) => e.context === context);
    } catch {
      return true;
    }
  };
  return readdirSync(ops).filter(verifiable).map(opFromFolder);
};

/**
 * Verify the op on every example for the context, and every other op too when shared code changed
 * (on the branch, or on main since `mainSince`): code another op runs may have broken it.
 */
const verifyAll = async (
  run: RequestRun,
  op: string,
  mainSince?: string,
): Promise<{ ok: boolean; signedOut: boolean; results: Verified[] }> => {
  const { request, paths, deps } = run;
  const results = [await deps.verify(paths.worktree, request, op)];
  const changed = [
    ...(await deps.git.changed(paths.worktree)),
    ...(mainSince ? await deps.git.changedOnMain(paths.worktree, mainSince) : []),
  ];
  if (sharedCodeIn(paths, changed)) {
    for (const other of opsWithExamples(paths, request.context).filter((o) => o !== op)) {
      const result = await deps.verify(paths.worktree, request, other);
      // Only a regression counts: an op that fails on main as well is not this change's to fix.
      if (!result.ok && !result.signedOut && !(await deps.verify(request.domain.root, request, other)).ok) continue;
      results.push(result);
    }
  }
  return { ok: results.every((v) => v.ok), signedOut: results.some((v) => v.signedOut), results };
};

/** What a round's check found, for the next revise, and where it stopped. */
interface Found {
  problem: string;
  standing: Standing;
}

const checksFound = async (run: RequestRun, scope: CheckScope): Promise<Found | undefined> => {
  const checks = await run.deps.checks(run.paths.worktree, scope);
  return checks.ok ? undefined : { problem: prompts.checksFailed(run, scope, checks.output), standing: { at: AT[scope], count: 1 } };
};

/**
 * Verify the ops, then run the repository's checks: what verify ran, and what went wrong first, if
 * anything. A signed-out session is signed in again from the checkout's .env file, or blocks the
 * run: no round can fix it.
 */
const verifyAndCheck = async (
  run: RequestRun,
  op: string,
  mainSince: string | undefined,
  scope: CheckScope,
): Promise<{ results: Verified[]; found?: Found }> => {
  const { request } = run;
  let verified = await verifyAll(run, op, mainSince);
  if (verified.signedOut && (await run.signInAgain())) verified = await verifyAll(run, op, mainSince);
  if (verified.signedOut) run.block(signInQuestion(request.domain.name, request.context));
  const { results } = verified;
  if (!verified.ok) {
    const failed = Math.max(1, results.flatMap((v) => v.runs).filter((r) => !r.ok).length);
    return { results, found: { problem: prompts.verifyFailed(request, results), standing: { at: AT.verify, count: failed } } };
  }
  return { results, found: await checksFound(run, scope) };
};

/**
 * Verify, then the checker reviews. A failure or a finding goes back to the builder for as long as each
 * round gets further than the one before (a later check, or fewer problems); the first that doesn't hands
 * it to the troubleshooter with every round's problem, and the troubleshooter's first that doesn't, or
 * the last round, to a person as one question. A `problem` already found starts it at the first revision.
 * `said` is the builder's last answer, which the checker reads with what it claims it ran.
 */
const checkUntilApproved = async (
  run: RequestRun,
  team: Team,
  op: string,
  summary: string,
  { mainSince, problem, said }: { mainSince?: string; problem?: string; said?: string },
): Promise<Approval> => {
  const problems: string[] = problem ? [problem] : [];
  let last = said;
  // Who has the rounds; once the troubleshooter does, the round it took over after.
  let by: "builder" | "troubleshooter" = "builder";
  let handedOverAt = 0;
  let before: Standing | undefined;
  for (let revisions = problem ? 1 : 0; ; revisions++) {
    if (revisions > 0) {
      if (by === "troubleshooter") run.workflow.log(`revise ${revisions}: troubleshooter`);
      // The troubleshooter's first round carries the whole record.
      const takingOverAfter = by === "troubleshooter" && revisions === handedOverAt + 1 ? handedOverAt : undefined;
      const prompt = prompts.revise(run, op, summary, problems, takingOverAfter);
      last = (await ask(run, await team[by](), DONE, `revise ${revisions}`, prompt)).summary;
    }

    // Rounds run the fast checks; the slow suite runs once, before approval.
    let now: Standing;
    const { results, found } = await verifyAndCheck(run, op, mainSince, "fast");
    if (found) {
      problems.push(found.problem);
      now = found.standing;
    } else {
      const review = await turn(
        run,
        await team.checker(),
        REVIEW,
        `review ${revisions + 1}`,
        prompts.review(run, op, summary, results, last),
        LIMITS.turnMs,
      );
      const blocking = review.findings.filter((f) => f.severity === "blocking");
      const minor = review.findings.filter((f) => f.severity === "minor");
      if (blocking.length === 0) {
        // Minor findings are fixed with no review after.
        if (minor.length > 0) await ask(run, await team[by](), DONE, `polish ${revisions + 1}`, prompts.polish(run, op, summary, minor));
        // The slow suite runs here either way; verify again only if a polish changed the code.
        const final = minor.length > 0 ? (await verifyAndCheck(run, op, mainSince, "full")).found : await checksFound(run, "full");
        if (!final) return { revisions, by };
        problems.push(final.problem);
        now = final.standing;
      } else {
        problems.push(prompts.reviewFound([...blocking, ...minor]));
        now = { at: AT.review, count: blocking.length };
      }
    }

    const stalled = before !== undefined && !progressed(now, before);
    before = now;
    if (revisions >= LIMITS.rounds || (stalled && by === "troubleshooter")) {
      const prompt = prompts.stuck(run, op, summary, problems);
      const { question } = await turn(run, await team.troubleshooter(), QUESTION, "question", prompt, LIMITS.turnMs);
      return run.block(question);
    }
    if (stalled) {
      by = "troubleshooter";
      handedOverAt = revisions;
    }
  }
};

/**
 * Commit, rebase on main, and fast-forward main. When main has moved past what was approved, the op
 * (and every op, when shared code changed on either side) is checked again, and the loop goes round so
 * any fix that made is committed and rebased before it lands. A fast-forward that loses a race with
 * another merge goes round too.
 */
const mergeToMain = async (
  run: RequestRun,
  team: Team,
  op: string,
  summary: string,
  message: string,
  approvedOn: string,
): Promise<Type.Static<typeof MERGED>> => {
  const { git } = run.deps;
  const { request, paths } = run;
  let approved = approvedOn;
  for (let attempt = 1; attempt <= LIMITS.merges; attempt++) {
    if (!(await git.squash(paths.worktree, message))) {
      // A merge that landed before the run died leaves nothing to squash: main already has it.
      const landed = await git.landed(request.domain.root, message);
      if (landed) return { commit: landed };
      return run.workflow.stop("nothing to merge: the branch has no changes");
    }
    const rebased = await git.rebase(paths.worktree);
    if (!rebased.ok) {
      await ask(run, await team.builder(), DONE, "rebase", prompts.rebase(run, op, summary, rebased.conflict));
      if (await git.rebaseInProgress(paths.worktree)) return run.workflow.stop("the rebase on main was left unfinished");
    }
    const base = await git.base(paths.worktree);
    if (base !== approved) {
      // What main brought is checked again; only a change that broke something goes back to review.
      const { found } = await verifyAndCheck(run, op, approved, "full");
      if (found) await checkUntilApproved(run, team, op, summary, { mainSince: approved, problem: found.problem });
      approved = base;
      continue;
    }
    try {
      return { commit: await git.fastForward(request.domain.root, paths.branch) };
    } catch (err) {
      run.workflow.log("fast-forward failed; going round again", { error: (err as Error).message });
    }
  }
  return run.workflow.stop(`main kept moving: could not land the change after ${LIMITS.merges} tries`);
};

/** What the commit says a kind of request did (`R-0012 build post:thread`), and what its result says. */
const DID = {
  new: { commit: "build", past: "built" },
  change: { commit: "change", past: "changed" },
  repair: { commit: "repair", past: "repaired" },
} as const satisfies Record<Exclude<RequestKind, "intake">, { commit: string; past: string }>;

/**
 * Check the op until approved, merge it, and end the request done. `summary` is the brief's, `said`
 * the builder's last answer, and `what` what the request's result says was done.
 */
export const land = async (
  run: RequestRun,
  team: Team,
  op: string,
  kind: keyof typeof DID,
  { summary, said, what }: { summary: string; said: string; what: string },
): Promise<Result> => {
  const checked = await run.stage(
    "check",
    CHECKED,
    (c) => `approved after ${c.revisions} revision(s), ${c.by}`,
    async () => ({ ...(await checkUntilApproved(run, team, op, summary, { said })), base: await run.deps.git.base(run.paths.worktree) }),
  );
  const merged = await run.stage(
    "merge",
    MERGED,
    (m) => m.commit.slice(0, 10),
    () => mergeToMain(run, team, op, summary, `${run.id} ${DID[kind].commit} ${op}`, checked.base),
  );
  const { request } = run;
  const command = request.call ? commandLine(request.domain.name, request.call.argv) : `${request.domain.name} ${op} --help`;
  const done = `${DID[kind].past} ${op} (${checked.revisions} revision(s)): ${what}`;
  return run.end("done", done, { summary: done, command, commit: merged.commit });
};
