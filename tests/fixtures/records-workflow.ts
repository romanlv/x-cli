// A workflow with no agents, for tests/e2e-awf-records.test.ts: run by the real awf, under the name
// the tool looks for, as the worker runs build.ts. RECORDS_STOP stops it in its second stage.
import { defineWorkflow } from "agentswf/workflow";
import Type from "typebox";

const DONE = Type.Object({ ok: Type.Boolean() });

export default defineWorkflow<{ id: string }, { state: string; summary: string }>({
  meta: { name: "op-build", description: "Stands in for build.ts.", version: "1.0.0" },
  prepare: ({ argv }) => ({ id: argv[0] ?? "" }),
  present: (result) => `${result.state}: ${result.summary}`,
  run: async (workflow, { id }) => {
    await workflow.stage("intake", { result: DONE, summary: () => "intake done" }, async () => ({ ok: true }));
    await workflow.stage("write", { result: DONE, summary: () => "write done" }, async () => {
      if (process.env.RECORDS_STOP) return workflow.stop(`told to stop: ${id}`);
      return { ok: true };
    });
    return { state: "done", summary: id };
  },
});
