// What build.ts and repair.ts share: the request's run as stages that keep the ledger current, the
// team of agents, the verify → review → revise loop with its escalation, and the merge.
//
// awf reuses a stage that succeeded on a continue and runs the code between stages on every attempt.
// So what must hold on every attempt sits between stages: the worktree, the op's lock, recording how
// the request ended. And each prompt carries the whole brief, since agents start fresh each attempt;
// prompts.ts writes them.
import { existsSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { type AgentRef, isAnswered, type JsonValue, type RuntimeSelection, type SandboxRef, type WorkflowContext } from "agentswf/workflow";
import Type from "typebox";
import { opFromFolder } from "../names";
import { isSignInQuestion, isTerminal, type RequestRecord, signInQuestion } from "../requests";
import { loadConfig, type WorkflowConfig } from "./config";
import { type CheckScope, cliEnv, type Deps, entryIn, type Verified } from "./deps";
import * as prompts from "./prompts";
import { type SandboxPaths, sandboxPaths, shellEnv, widen } from "./sandbox";

/** Revise rounds at most, whoever has them, so a run that keeps finding something new still ends. */
export const MAX_ROUNDS = 8;

/** Where a round's check stopped: 0 verify, 1 fast checks, 2 review, 3 full checks; and how many problems there. */
interface Standing {
  at: number;
  count: number;
}
/**
 * Further along, or as far with fewer problems. After the full checks failed, a round is reviewed
 * afresh, so reaching the review again counts.
 */
const progressed = (now: Standing, before: Standing): boolean =>
  now.at > before.at || (now.at === before.at && now.count < before.count) || (before.at === 3 && now.at === 2);

const MINUTE = 60_000;

// ── Answers ───────────────────────────────────────────────────────────────────────────────────────
const strict = { additionalProperties: false } as const;
/** Any turn may end with the one question only a person can answer. */
export const QUESTION = Type.Object({ kind: Type.Literal("question"), question: Type.String() }, strict);

export const INTAKE = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("build"),
      op: Type.String({ description: "noun:verb, lowercase, no hyphen in the noun: candidate:merge" }),
      change: Type.Boolean({ description: "true when the op exists and this changes it" }),
      summary: Type.String({
        description:
          "the intent, in a few sentences: what the person wants and why, what they expect back, what is unclear; nothing about which screens, since nobody has opened the app",
      }),
    },
    strict,
  ),
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
  QUESTION,
]);
export const DONE = Type.Union([Type.Object({ kind: Type.Literal("done"), summary: Type.String() }, strict), QUESTION]);
const EXPLORE_DONE = Type.Object({ kind: Type.Literal("done"), summary: Type.String() }, strict);
const MISSING = Type.Object(
  { kind: Type.Literal("missing"), reason: Type.String({ description: "what was tried, and why none serves" }) },
  strict,
);
/** The explore stage's result: the way picked, or none serves. */
export const EXPLORE_RESULT = Type.Union([EXPLORE_DONE, MISSING]);
export const EXPLORED = Type.Union([EXPLORE_DONE, MISSING, QUESTION]);
export const DIAGNOSIS = Type.Union([
  Type.Object({ kind: Type.Literal("reproduced"), diagnosis: Type.String() }, strict),
  Type.Object({ kind: Type.Literal("flaky"), reason: Type.String() }, strict),
  QUESTION,
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
            description:
              "blocking: the op is wrong, unsafe, or breaks the spec, authoring.md or another op. minor: wording, a doc line, a name, style — fixable without another look",
          }),
        },
        strict,
      ),
    ),
  },
  strict,
);

export type Answer<S extends Type.TSchema> = Extract<Type.Static<S>, JsonValue>;

// Stage results: what a continue reuses.
export const INTAKE_RESULT = Type.Union([
  Type.Object({ kind: Type.Literal("build"), op: Type.String(), change: Type.Boolean(), summary: Type.String() }, strict),
  Type.Object(
    {
      kind: Type.Literal("ended"),
      state: Type.Union([Type.Literal("duplicate"), Type.Literal("deferred"), Type.Literal("declined")]),
      reason: Type.String(),
      command: Type.Optional(Type.String()),
      of: Type.Optional(Type.String()),
    },
    strict,
  ),
]);
export const SUMMARY = Type.Object({ summary: Type.String() }, strict);
/** `base` is the main commit the approval was given on: merge checks again when main has moved past it. */
export const CHECKED = Type.Object({ revisions: Type.Number(), by: Type.String(), base: Type.String() }, strict);
type Approval = Omit<Type.Static<typeof CHECKED>, "base">;
export const MERGED = Type.Object({ commit: Type.String() }, strict);
export const RESULT = Type.Object({ state: Type.String(), summary: Type.String() }, strict);
export type Result = Type.Static<typeof RESULT>;

// ── The run ───────────────────────────────────────────────────────────────────────────────────────
export type RunArgs = {
  id: string;
  home: string;
};

export const prepareArgs = ({ argv }: { argv: readonly string[] }): RunArgs => {
  const id = argv[0];
  if (!id || !/^R-\d+$/.test(id)) throw new Error("usage: awf run <workflow> -- R-0012");
  const home = process.env.XCLI_HOME;
  if (!home) throw new Error("XCLI_HOME is not set: the worker starts these runs");
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
  /** A command as an agent runs it: in a sandbox, with `awf` on PATH and the host's browser. */
  run(command: string): string;
}

const envLine = (env: Record<string, string>): string =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

export const pathsFor = (request: RequestRecord, config: WorkflowConfig): Paths => {
  const worktree = join(request.domain.home, "worktrees", request.id);
  const sandbox = config.sandbox ? sandboxPaths(request) : undefined;
  const env = envLine(cliEnv(request, sandbox));
  return {
    worktree,
    branch: `req/${request.id}`,
    domainDir: join(worktree, relative(request.domain.root, request.domain.dir)),
    cli: `env ${env} bun ${entryIn(worktree, request)}`,
    session: request.id,
    trace: join(sandbox?.home ?? request.domain.home, "sessions", request.id, "trace.jsonl"),
    ...(sandbox && { sandbox }),
    run: (command) => (sandbox ? `env ${envLine(shellEnv(sandbox))} ${command}` : command),
  };
};

export type Ledger = ReturnType<Deps["ledger"]>;

/** One request's run: its stages keep the ledger's stage current, and a block or an end records itself. */
export class RequestRun {
  constructor(
    readonly workflow: WorkflowContext,
    readonly deps: Deps,
    readonly ledger: Ledger,
    readonly id: string,
  ) {}

  get request(): RequestRecord {
    const request = this.ledger.get(this.id);
    if (!request) throw new Error(`no request ${this.id}`);
    return request;
  }

  #config?: WorkflowConfig;

  /** workflows.json, as it was when the run first asked: one run never changes models or sandbox midway. */
  get config(): WorkflowConfig {
    this.#config ??= loadConfig(this.request.domain.root);
    return this.#config;
  }

  get paths(): Paths {
    return pathsFor(this.request, this.config);
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

  /** Stop the run blocked on one question; `request:answer` continues it from this stage. */
  #signIns = 0;

  /** Sign the context in again from its .env file, twice a run at most, so a wrong password doesn't loop. */
  async signInAgain(): Promise<boolean> {
    if (this.#signIns >= 2) return false;
    this.#signIns++;
    return this.deps.signIn(this.request);
  }

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

  /** End the request without building: deferred, declined, duplicate, or failed. Safe to repeat. */
  async end(state: "deferred" | "declined" | "duplicate" | "failed", reason: string, result?: RequestRecord["result"]): Promise<Result> {
    const { op } = this.request;
    this.ledger.update(this.id, () => ({ state, reason, result, pid: undefined, stage: undefined }));
    if (op) this.ledger.unlockOp(op, this.id);
    await this.cleanUp();
    return { state, summary: reason };
  }

  async cleanUp(): Promise<void> {
    await cleanUpAfter(this.deps, this.request, this.config);
  }
}

/** Close a request's browser sessions and remove its worktree: as its run ends, or once it is cancelled. */
export const cleanUpAfter = async (deps: Deps, request: RequestRecord, config: WorkflowConfig): Promise<void> => {
  const paths = pathsFor(request, config);
  await deps.closeSessions(paths.worktree, request, [paths.session, `${paths.session}-check`], paths.sandbox);
  await deps.git.removeWorktree(request.domain.root, paths.worktree, paths.branch);
  if (paths.sandbox) rmSync(paths.sandbox.sockets, { recursive: true, force: true });
};

/**
 * Ask, and return the answer. A question blocks the request on it; so does a turn stuck on a
 * permission prompt or a missing login, which only a person can clear. Any other turn without an
 * answer stops the run, which the worker records failed and `request:retry` continues.
 */
export const ask = async <S extends Type.TSchema>(
  run: RequestRun,
  agent: AgentRef,
  schema: S,
  label: string,
  prompt: string,
  timeoutMs = 30 * MINUTE,
): Promise<Answer<S>> => {
  const { outcome } = await agent.run<Answer<S>>({ prompt, schema, label, timeoutMs });
  if (isAnswered(outcome)) {
    const value = outcome.value as { kind?: string; question?: string };
    // Signed out mid-turn: when the checkout has the context's sign-in, the run signs in and the agent goes on.
    if (value.kind === "question" && isSignInQuestion(value.question) && (await run.signInAgain()))
      return ask(run, agent, schema, label, prompts.signedInAgain(run.request), timeoutMs);
    if (value.kind === "question") run.block(value.question!);
    return outcome.value;
  }
  if (outcome.kind === "failed" && outcome.login)
    return run.block(`the ${label} agent has no login: ${outcome.login.run}, then answer this request to go on`);
  if (outcome.kind === "blocked") {
    return run.block(
      `the ${label} agent stopped at a prompt only a person can answer (${outcome.reason}); allow it in the agent's settings, then answer this request to go on`,
    );
  }
  return run.workflow.stop(`${label}: ${outcome.kind}: ${outcome.reason}`);
};

// ── The team ──────────────────────────────────────────────────────────────────────────────────────
export interface Team {
  planner(): Promise<AgentRef>;
  builder(): Promise<AgentRef>;
  checker(): Promise<AgentRef>;
  troubleshooter(): Promise<AgentRef>;
}

/** The team, each on the model workflows.json names; sandboxed, they share one sandbox, so the checker reads the builder's trace. */
export const openTeam = (run: RequestRun): Team => {
  const { workflow, request, paths, config } = run;
  const instructions = prompts.builderInstructions(run);
  let box: Promise<SandboxRef> | undefined;
  const sandbox = async () => {
    if (!paths.sandbox) return {};
    const sandboxPaths = paths.sandbox;
    box ??= run.deps
      .sandbox(request, paths.worktree, sandboxPaths)
      .then((spec) => widen(spec, config.sandbox || {}, request.domain.root))
      .then((spec) => workflow.sandboxes.open({ key: "agents", cwd: paths.worktree, ...spec }));
    return { sandbox: await box };
  };
  // A pane agent's pane stays open when it fails, for a look; a headless one has none, and awf
  // doesn't keep a sandboxed one's, whose pane is in the sandbox's own Herdr.
  const keep = (runtime: RuntimeSelection) =>
    paths.sandbox || (typeof runtime === "object" && runtime.placement === "headless") ? {} : { keepPane: "on-failure" as const };
  return {
    planner: async () =>
      workflow.agents.open({
        key: "planner",
        runtime: config.agents.planner,
        cwd: paths.worktree,
        instructions: prompts.plannerInstructions(run),
        ...keep(config.agents.planner),
        ...(await sandbox()),
      }),
    builder: async () =>
      workflow.agents.open({
        key: "builder",
        runtime: config.agents.builder,
        cwd: paths.worktree,
        instructions,
        ...keep(config.agents.builder),
        ...(await sandbox()),
      }),
    checker: async () =>
      workflow.agents.open({
        key: "checker",
        runtime: config.agents.checker,
        ...(await sandbox()),
        cwd: paths.worktree,
        instructions: prompts.checkerInstructions(run),
      }),
    troubleshooter: async () =>
      workflow.agents.open({
        key: "troubleshooter",
        runtime: config.agents.troubleshooter,
        cwd: paths.worktree,
        instructions,
        ...keep(config.agents.troubleshooter),
        ...(await sandbox()),
      }),
  };
};

// ── Verify, review, revise ────────────────────────────────────────────────────────────────────────
const helpersIn = (paths: Paths, files: string[]): boolean =>
  files.some((f) => f.startsWith(`${relative(paths.worktree, paths.domainDir)}/helpers/`));

/** Every op with an example for this context, as the worktree has them now. */
const opsWithExamples = async (paths: Paths, context: string): Promise<string[]> => {
  const ops: string[] = [];
  if (!existsSync(join(paths.domainDir, "ops"))) return ops;
  for await (const file of new Bun.Glob("ops/*/examples.json").scan({ cwd: paths.domainDir })) {
    const examples = (await Bun.file(join(paths.domainDir, file)).json()) as { context: string }[];
    if (examples.some((e) => e.context === context)) ops.push(opFromFolder(file.split("/")[1]!));
  }
  return ops;
};

/**
 * Verify the op on every example for the context, and every other op too when helpers changed (on
 * the branch, or on main since `mainSince`): a helper another op uses may have broken under it.
 */
export const verifyAll = async (
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
  if (helpersIn(paths, changed)) {
    for (const other of (await opsWithExamples(paths, request.context)).filter((o) => o !== op)) {
      const result = await deps.verify(paths.worktree, request, other);
      // Only a regression counts: an op that fails on main as well is not this change's to fix.
      if (!result.ok && !result.signedOut && !(await deps.verify(request.domain.root, request, other)).ok) continue;
      results.push(result);
    }
  }
  return { ok: results.every((v) => v.ok), signedOut: results.some((v) => v.signedOut), results };
};

/**
 * Verify the ops, then run the repository's checks: what went wrong, for the builder, or what verify
 * ran when both passed. A signed-out session is signed in again from the checkout's .env file, or
 * blocks the run: no round can fix it.
 */
const verifyProblem = async (
  run: RequestRun,
  op: string,
  mainSince: string | undefined,
  scope: CheckScope,
  { verify = true }: { verify?: boolean } = {},
): Promise<{ problem: string; standing: Standing } | { problem?: undefined; results: Verified[] }> => {
  const { request, paths } = run;
  let verified = verify ? await verifyAll(run, op, mainSince) : { ok: true, signedOut: false, results: [] };
  if (verified.signedOut && (await run.signInAgain())) verified = await verifyAll(run, op, mainSince);
  if (verified.signedOut) run.block(signInQuestion(request.domain.name, request.context));
  if (!verified.ok)
    return {
      problem: prompts.verifyFailed(request, verified.results),
      standing: { at: 0, count: Math.max(1, verified.results.flatMap((v) => v.runs).filter((r) => !r.ok).length) },
    };
  const checks = await run.deps.checks(paths.worktree, scope);
  if (!checks.ok)
    return {
      problem: prompts.checksFailed(run, scope, checks.output),
      standing: { at: scope === "full" ? 3 : 1, count: 1 },
    };
  return { results: verified.results };
};

/**
 * Verify, then the checker reviews. A failure or a finding goes back to the builder for as long as each
 * round gets further than the one before (a later check, or fewer problems); the first that doesn't hands
 * it to the troubleshooter with every round's problem, and the troubleshooter's first that doesn't, or
 * MAX_ROUNDS, to a person as one question. A `problem` already found starts it at the first revision.
 * `said` is the builder's last answer, which the checker reads with what it claims it ran.
 */
export const checkUntilApproved = async (
  run: RequestRun,
  team: Team,
  op: string,
  summary: string,
  { mainSince, problem, said }: { mainSince?: string; problem?: string; said?: string } = {},
): Promise<Approval> => {
  const problems: string[] = problem ? [problem] : [];
  let last = said;
  // Set once the troubleshooter takes over: how many rounds the builder had.
  let builderRounds: number | undefined;
  let before: Standing | undefined;
  for (let revisions = problem ? 1 : 0; ; revisions++) {
    if (revisions > 0) last = await revise(run, team, op, summary, revisions, problems, builderRounds);
    const by = builderRounds === undefined ? "builder" : "troubleshooter";

    // Rounds run the fast checks; the slow suite runs once, before approval.
    let now: Standing;
    const verified = await verifyProblem(run, op, mainSince, "fast");
    if (verified.problem !== undefined) {
      problems.push(verified.problem);
      now = verified.standing;
    } else {
      const review = await ask(
        run,
        await team.checker(),
        REVIEW,
        `review ${revisions + 1}`,
        prompts.review(run, op, summary, verified.results, last),
      );
      const blocking = review.findings.filter((f) => f.severity === "blocking");
      const minor = review.findings.filter((f) => f.severity === "minor");
      if (blocking.length === 0) {
        if (minor.length > 0) await polish(run, team, op, summary, revisions, minor, builderRounds !== undefined);
        // The slow suite runs here either way; verify again only if a polish changed the code.
        const final = await verifyProblem(run, op, mainSince, "full", { verify: minor.length > 0 });
        if (final.problem === undefined) return { revisions, by };
        problems.push(final.problem);
        now = final.standing;
      } else {
        problems.push(prompts.reviewFound([...blocking, ...minor]));
        now = { at: 2, count: blocking.length };
      }
    }

    const stalled = before !== undefined && !progressed(now, before);
    before = now;
    if (revisions >= MAX_ROUNDS || (stalled && builderRounds !== undefined)) {
      const asked = await ask(run, await team.troubleshooter(), QUESTION, "question", prompts.stuck(run, op, summary, problems));
      return run.block(asked.question);
    }
    if (stalled) builderRounds = revisions;
  }
};

/** Minor findings, fixed by whoever has the rounds now, with no review after. */
const polish = async (
  run: RequestRun,
  team: Team,
  op: string,
  summary: string,
  round: number,
  findings: { where: string; problem: string }[],
  troubleshooting: boolean,
): Promise<void> => {
  await ask(
    run,
    troubleshooting ? await team.troubleshooter() : await team.builder(),
    DONE,
    `polish ${round + 1}`,
    prompts.polish(run, op, summary, findings),
  );
};

/** One revise round: the builder's, or once it stalled the troubleshooter's, whose first carries the whole record. */
const revise = async (
  run: RequestRun,
  team: Team,
  op: string,
  summary: string,
  round: number,
  problems: string[],
  builderRounds: number | undefined,
): Promise<string> => {
  const troubleshooting = builderRounds !== undefined;
  if (troubleshooting) run.workflow.log(`revise ${round}: troubleshooter`);
  const answered = await ask(
    run,
    troubleshooting ? await team.troubleshooter() : await team.builder(),
    DONE,
    `revise ${round}`,
    prompts.revise(run, op, summary, problems, round === (builderRounds ?? -1) + 1 ? builderRounds : undefined),
  );
  return answered.kind === "done" ? answered.summary : "";
};

/** Check until approved, and note the main commit the approval holds for. */
export const approve = async (
  run: RequestRun,
  team: Team,
  op: string,
  summary: string,
  said: string,
): Promise<Type.Static<typeof CHECKED>> => {
  const approval = await checkUntilApproved(run, team, op, summary, { said });
  return { ...approval, base: await run.deps.git.base(run.paths.worktree) };
};

/**
 * Commit, rebase on main, and fast-forward main. When main has moved past what was approved, the op
 * (and every op, when helpers changed on either side) is checked again, and the loop goes round so
 * any fix that made is committed and rebased before it lands. A fast-forward that loses a race with
 * another merge goes round too.
 */
export const mergeToMain = async (
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
  for (let attempt = 1; attempt <= 4; attempt++) {
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
      const { problem } = await verifyProblem(run, op, approved, "full");
      if (problem !== undefined) await checkUntilApproved(run, team, op, summary, { mainSince: approved, problem });
      approved = base;
      continue;
    }
    try {
      return { commit: await git.fastForward(request.domain.root, paths.branch) };
    } catch (err) {
      run.workflow.log("fast-forward failed; going round again", { error: (err as Error).message });
    }
  }
  return run.workflow.stop("main kept moving: could not land the change after four tries");
};

/** The request is done: record it, free the op, and clean up. */
export const finish = async (run: RequestRun, op: string, merged: { commit: string }, summary: string): Promise<Result> => {
  const { request } = run;
  const command = request.call ? `${request.domain.name} ${request.call.argv.join(" ")}` : `${request.domain.name} ${op} --help`;
  run.ledger.update(run.id, () => ({
    state: "done",
    result: { summary, command, commit: merged.commit },
    pid: undefined,
    stage: undefined,
  }));
  run.ledger.unlockOp(op, run.id);
  await run.cleanUp();
  return { state: "done", summary };
};
