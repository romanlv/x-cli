// awf run core/workflows/repair.ts --id R-0013 -- R-0013   (the worker starts it; XCLI_HOME set)
//
// A repair the runner filed when an op failed and triage blamed the op. There is no intake: the
// request came from the tool itself, with a failure bundle. A diagnosis goes in front of the build
// workflow's loop.
//
// diagnose ─┬─ flaky ─▶ failed
//           └─ reproduced ─▶ patch ─▶ check ⟲ ─▶ merge ─▶ done
// The worktree and the op's lock are taken between stages, so every attempt has them.
import { defineExecutableWorkflow, type WorkflowContext } from "agentswf/workflow";
import Type from "typebox";
import { FIRST_STAGE } from "../worker";
import { type Deps, realDeps } from "./deps";
import * as prompts from "./prompts";
import {
  approve,
  ask,
  CHECKED,
  DIAGNOSIS,
  DONE,
  finish,
  MERGED,
  mergeToMain,
  openTeam,
  prepareArgs,
  RequestRun,
  type Result,
  type RunArgs,
  SUMMARY,
} from "./shared";

const REPAIR_FIRST_STAGE = FIRST_STAGE.repair;

const DIAGNOSED = Type.Union([
  Type.Object({ kind: Type.Literal("reproduced"), diagnosis: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("flaky"), reason: Type.String() }, { additionalProperties: false }),
]);

async function repair(workflow: WorkflowContext, deps: Deps, { id, home }: RunArgs): Promise<Result> {
  const ledger = deps.ledger(home);
  const run = new RequestRun(workflow, deps, ledger, id);
  const request = run.request;
  const { op, failure } = request;
  if (request.kind !== "repair" || !op || !failure) throw new Error(`${id} is not a repair with a failure bundle`);
  const paths = run.paths;

  await deps.git.ensureWorktree(request.domain.root, paths.worktree, paths.branch);
  await run.lock(op);
  const team = openTeam(run);
  const what = prompts.repairSummary(op, failure);

  const diagnosed = await run.stage(
    REPAIR_FIRST_STAGE,
    DIAGNOSED,
    (d) => (d.kind === "reproduced" ? d.diagnosis : `flaky: ${d.reason}`),
    async () => {
      const answered = await ask(run, await team.builder(), DIAGNOSIS, "diagnose", prompts.diagnose(run, op, failure), 40 * 60_000);
      if (answered.kind === "question") throw new Error("unreachable: ask blocks on a question");
      return answered;
    },
  );
  // Recorded on every attempt, so a continue over a reused diagnosis still ends the request.
  if (diagnosed.kind === "flaky") return run.end("failed", `flaky: could not reproduce (${diagnosed.reason}); bundle ${failure.bundle}`);

  const patched = await run.stage(
    "patch",
    SUMMARY,
    (s) => s.summary,
    async () => {
      const answered = await ask(run, await team.builder(), DONE, "patch", prompts.patch(run, op, failure, diagnosed.diagnosis));
      return { summary: answered.kind === "done" ? answered.summary : "" };
    },
  );

  const summary = `${what}. Diagnosis: ${diagnosed.diagnosis}`;
  const checked = await run.stage(
    "check",
    CHECKED,
    (c) => `approved after ${c.revisions} revision(s), ${c.by}`,
    () => approve(run, team, op, summary, patched.summary),
  );

  const merged = await run.stage(
    "merge",
    MERGED,
    (m) => m.commit.slice(0, 10),
    () => mergeToMain(run, team, op, summary, `${id} repair ${op}`, checked.base),
  );

  return finish(run, op, merged, `repaired ${op} (${checked.revisions} revision(s)): ${diagnosed.diagnosis}`);
}

export const defineRepair = (deps: Deps) =>
  defineExecutableWorkflow<RunArgs, Result>({
    definition: {
      meta: { name: "op-repair", description: "Repair an op that failed, from its failure bundle.", version: "1.0.0" },
      run: (workflow, args) => repair(workflow, deps, args),
    },
    prepare: prepareArgs,
    present: (result) => `${result.state}: ${result.summary}`,
  });

export default defineRepair(realDeps);
