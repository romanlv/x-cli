// awf run core/workflows/repair.ts --id R-0013 -- R-0013   (the worker starts it; XCLI_HOME set)
//
// A repair the runner filed when an op failed and triage blamed the op. There is no intake: the
// request came from the tool itself, with a failure bundle. A diagnosis goes in front of the build
// workflow's loop.
//
// diagnose ─┬─ flaky ─▶ failed
//           └─ reproduced ─▶ patch ─▶ check ⟲ ─▶ merge ─▶ done
// The worktree and the op's lock are taken between stages, so every attempt has them.

import { WORKFLOWS } from "../awf";
import * as prompts from "../instructions/prompts";
import { flakyReason } from "../requests";
import { realDeps } from "./deps";
import { ask, DIAGNOSIS, DONE, defineRequestWorkflow, LIMITS, land } from "./shared";

export const defineRepair = defineRequestWorkflow(
  { name: "op-repair", description: "Repair an op that failed, from its failure bundle.", version: "1.0.0" },
  async (run, team) => {
    const { op, failure } = run.request;
    if (!op || !failure) throw new Error(`${run.id} is not a repair with a failure bundle`);
    await run.lock(op);

    const diagnosed = await run.stage(
      WORKFLOWS.repair.firstStage,
      DIAGNOSIS,
      (d) => (d.kind === "reproduced" ? d.diagnosis : `flaky: ${d.reason}`),
      async () => ask(run, await team.builder(), DIAGNOSIS, "diagnose", prompts.diagnose(run, op, failure), LIMITS.longTurnMs),
    );
    // Recorded on every attempt, so a continue over a reused diagnosis still ends the request.
    if (diagnosed.kind === "flaky")
      return run.end("failed", flakyReason(`could not reproduce (${diagnosed.reason}); bundle ${failure.bundle}`));

    const patched = await run.stage(
      "patch",
      DONE,
      (d) => d.summary,
      async () => ask(run, await team.builder(), DONE, "patch", prompts.patch(run, op, failure, diagnosed.diagnosis)),
    );

    const summary = `${prompts.repairSummary(op, failure)}. Diagnosis: ${diagnosed.diagnosis}`;
    return land(run, team, op, "repair", { summary, said: patched.summary, what: diagnosed.diagnosis });
  },
);

export default defineRepair(realDeps);
