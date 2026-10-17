// awf run core/workflows/build.ts --id R-0012 -- R-0012     (the worker starts it; XCLI_HOME set)
//
// A new op, or a change to one, from a request in the ledger. The run's id is the request's, so
// `awf runs R-0012` is its record and `--continue R-0012` picks up at the stage that stopped.
//
// intake ─┬─ duplicate, deferred, declined ─▶ ended
//         ├─ same as an open request ─▶ ended, a duplicate of that one
//         └─ build ─▶ explore ─┬─ missing ─▶ ended, deferred
//                              └─ spec ─▶ write ─▶ check ⟲ ─▶ merge ─▶ done
//                                                  verify, review, revise
// The planner does intake (the intent) and, once the builder has surveyed the app, the spec.
// The worktree and the op's lock are taken between stages, so every attempt has them.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineExecutableWorkflow, type WorkflowContext } from "agentswf/workflow";
import * as prompts from "../instructions/prompts";
import { OP_NAME, opFolder } from "../names";
import { FIRST_STAGE } from "../worker";
import { type Deps, realDeps } from "./deps";
import {
  approve,
  ask,
  CHECKED,
  DONE,
  EXPLORE_RESULT,
  EXPLORED,
  finish,
  INTAKE,
  INTAKE_RESULT,
  MERGED,
  mergeToMain,
  openTeam,
  prepareArgs,
  RequestRun,
  type Result,
  type RunArgs,
  SUMMARY,
} from "./shared";

const BUILD_FIRST_STAGE = FIRST_STAGE.build;

async function build(workflow: WorkflowContext, deps: Deps, { id, home }: RunArgs): Promise<Result> {
  const ledger = deps.ledger(home);
  const run = new RequestRun(workflow, deps, ledger, id);
  const request = run.request;
  const paths = run.paths;

  await deps.git.ensureWorktree(request.domain.root, paths.worktree, paths.branch);
  const team = openTeam(run);

  // Intake decides whether there is anything to build; a duplicate costs one short turn.
  const plan = await run.stage(
    BUILD_FIRST_STAGE,
    INTAKE_RESULT,
    (p) => (p.kind === "build" ? `${p.change ? "change" : "new"} ${p.op}` : `${p.state}: ${p.reason}`),
    async () => {
      const others = run.others();
      const exists = !!request.op && existsSync(join(request.domain.dir, "ops", opFolder(request.op)));
      const decided = await ask(run, await team.planner(), INTAKE, "intake", prompts.intake(run, others, exists), 10 * 60_000);
      if (decided.kind === "same" && !others.some((r) => r.id === decided.request))
        return workflow.stop(`intake named ${decided.request}, which is not one of the open requests it was shown`);
      if (decided.kind === "build") {
        if (!OP_NAME.test(decided.op)) return workflow.stop(`intake named "${decided.op}", which is not a noun:verb op name`);
        // Whether it changes an op is whether that op is there, whatever intake thought.
        const change = existsSync(join(request.domain.dir, "ops", opFolder(decided.op)));
        ledger.update(id, () => ({ op: decided.op, kind: change ? "change" : "new" }), "intake");
        return { kind: "build" as const, op: decided.op, change, summary: decided.summary };
      }
      if (decided.kind === "question") throw new Error("unreachable: ask blocks on a question");
      return {
        kind: "ended" as const,
        state: decided.kind === "same" ? "duplicate" : decided.kind,
        reason: decided.reason,
        ...(decided.kind === "duplicate" && { command: decided.command }),
        ...(decided.kind === "same" && { of: decided.request }),
      };
    },
  );
  // Recorded on every attempt, so a continue over a reused intake still ends the request.
  if (plan.kind === "ended") {
    const { state, reason, command, of } = plan;
    return run.end(state, reason, command || of ? { summary: reason, command, of } : undefined);
  }

  const { op, summary } = plan;
  await run.lock(op);

  const explored = await run.stage(
    "explore",
    EXPLORE_RESULT,
    (e) => (e.kind === "done" ? e.summary : `missing: ${e.reason}`),
    async () => {
      const answered = await ask(
        run,
        await team.builder(),
        EXPLORED,
        "explore",
        prompts.explore(run, op, summary, plan.change),
        40 * 60_000,
      );
      if (answered.kind === "question") throw new Error("unreachable: ask blocks on a question");
      return answered;
    },
  );
  if (explored.kind === "missing") return run.end("deferred", `${request.domain.name} has no way to do it: ${explored.reason}`);

  await run.stage(
    "spec",
    SUMMARY,
    (s) => s.summary,
    async () => {
      const answered = await ask(run, await team.planner(), DONE, "spec", prompts.spec(run, op, summary, plan.change, explored.summary));
      return { summary: answered.kind === "done" ? answered.summary : "" };
    },
  );

  const written = await run.stage(
    "write",
    SUMMARY,
    (s) => s.summary,
    async () => {
      const answered = await ask(run, await team.builder(), DONE, "write", prompts.write(run, op, summary), 40 * 60_000);
      return { summary: answered.kind === "done" ? answered.summary : "" };
    },
  );

  const checked = await run.stage(
    "check",
    CHECKED,
    (c) => `approved after ${c.revisions} revision(s), ${c.by}`,
    () => approve(run, team, op, summary, written.summary),
  );

  const merged = await run.stage(
    "merge",
    MERGED,
    (m) => m.commit.slice(0, 10),
    () => mergeToMain(run, team, op, summary, `${id} ${plan.change ? "change" : "build"} ${op}`, checked.base),
  );

  return finish(run, op, merged, `${plan.change ? "changed" : "built"} ${op} (${checked.revisions} revision(s)): ${summary}`);
}

export const defineBuild = (deps: Deps) =>
  defineExecutableWorkflow<RunArgs, Result>({
    definition: {
      meta: { name: "op-build", description: "Build a new op, or change one, for a request in the ledger.", version: "1.0.0" },
      run: (workflow, args) => build(workflow, deps, args),
    },
    prepare: prepareArgs,
    present: (result) => `${result.state}: ${result.summary}`,
  });

export default defineBuild(realDeps);
