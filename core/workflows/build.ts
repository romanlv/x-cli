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
import * as prompts from "../instructions/prompts";
import { OP_NAME } from "../names";
import { FIRST_STAGE } from "../worker";
import { opDirIn, realDeps } from "./deps";
import { ask, DONE, defineRequestWorkflow, EXPLORED, INTAKE, LIMITS, land } from "./shared";

export const defineBuild = defineRequestWorkflow(
  { name: "op-build", description: "Build a new op, or change one, for a request in the ledger.", version: "1.0.0" },
  async (run, team) => {
    const { request } = run;

    // Intake decides whether there is anything to build; a duplicate costs one short turn.
    const plan = await run.stage(
      FIRST_STAGE.build,
      INTAKE,
      (p) => (p.kind === "build" ? `${p.change ? "change" : "new"} ${p.op}` : `${p.kind}: ${p.reason}`),
      async () => {
        const others = run.others();
        const exists = !!request.op && existsSync(opDirIn(request.domain.dir, request.op));
        const decided = await ask(run, await team.planner(), INTAKE, "intake", prompts.intake(run, others, exists), LIMITS.shortTurnMs);
        if (decided.kind === "same" && !others.some((r) => r.id === decided.request))
          return run.workflow.stop(`intake named ${decided.request}, which is not one of the open requests it was shown`);
        if (decided.kind !== "build") return decided;
        if (!OP_NAME.test(decided.op)) return run.workflow.stop(`intake named "${decided.op}", which is not a noun:verb op name`);
        // Whether it changes an op is whether that op is there, whatever intake thought.
        const change = existsSync(opDirIn(request.domain.dir, decided.op));
        run.ledger.update(run.id, () => ({ op: decided.op, kind: change ? "change" : "new" }), "intake");
        return { ...decided, change };
      },
    );
    // Recorded on every attempt, so a continue over a reused intake still ends the request.
    if (plan.kind === "duplicate") return run.end("duplicate", plan.reason, { summary: plan.reason, command: plan.command });
    if (plan.kind === "same") return run.end("duplicate", plan.reason, { summary: plan.reason, of: plan.request });
    if (plan.kind !== "build") return run.end(plan.kind, plan.reason);

    const { op, change, summary } = plan;
    await run.lock(op);

    const explored = await run.stage(
      "explore",
      EXPLORED,
      (e) => (e.kind === "done" ? e.summary : `missing: ${e.reason}`),
      async () => ask(run, await team.builder(), EXPLORED, "explore", prompts.explore(run, op, summary, change), LIMITS.longTurnMs),
    );
    if (explored.kind === "missing") return run.end("deferred", `${request.domain.name} has no way to do it: ${explored.reason}`);

    await run.stage(
      "spec",
      DONE,
      (d) => d.summary,
      async () => ask(run, await team.planner(), DONE, "spec", prompts.spec(run, op, summary, change, explored.summary)),
    );

    const written = await run.stage(
      "write",
      DONE,
      (d) => d.summary,
      async () => ask(run, await team.builder(), DONE, "write", prompts.write(run, op, summary), LIMITS.longTurnMs),
    );

    return land(run, team, op, change ? "change" : "build", { summary, said: written.summary, what: summary });
  },
);

export default defineBuild(realDeps);
