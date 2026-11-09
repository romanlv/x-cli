// The tool's command line and its reading of a run's records, against the real awf: a new awf can
// change either with every type still passing, as agentswf 0.1 did. Not run in a sandbox, as awf isn't.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { awfArgs, awfCommand, awfEnv, runActivity, runEstimates, runOutput, runUsage } from "../core/awf";
import { ROOT, tempHome } from "./helpers";

let t: ReturnType<typeof tempHome>;
let root: string;
const request = { id: "R-0001", kind: "new" as const };

/** One attempt, as the worker starts it: awf's exit code. */
const attempt = async (stop: boolean, redo = false): Promise<number> => {
  const child = Bun.spawn([awfCommand(), ...awfArgs(t.home, root, { ...request, redo }, "3h")], {
    cwd: root,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...awfEnv(t.home, root), RECORDS_STOP: stop ? "1" : undefined },
  });
  return child.exited;
};

beforeEach(() => {
  t = tempHome();
  root = join(t.home, "checkout");
  mkdirSync(join(root, "core", "workflows"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module" }));
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
  copyFileSync(join(import.meta.dir, "fixtures", "records-workflow.ts"), join(root, "core", "workflows", "build.ts"));
});
afterEach(() => t.cleanup());

test("awf takes the tool's command lines: a new run, its continue, and its redo", async () => {
  const before = Date.now() - 1_000;
  expect(await attempt(true)).toBe(3);
  expect(runOutput(t.home, request.id, before)).toMatchObject({ outcome: "stopped", reason: "told to stop: R-0001" });
  expect(await attempt(false)).toBe(0);
  expect(runOutput(t.home, request.id)?.outcome).toBe("completed");
  // A completed run takes another attempt only from a stage, which is why the worker asks for a redo.
  expect(await attempt(false)).toBe(2);
  expect(await attempt(false, true)).toBe(0);
});

test("a run started without --keep-panes, as one migrated from before agentswf 0.1 was, takes the tool's continue", async () => {
  const [, ...args] = awfArgs(t.home, root, request, "3h");
  const flag = args.indexOf("--keep-panes");
  args.splice(flag, 2);
  const started = Bun.spawn([awfCommand(), "run", ...args], {
    cwd: root,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...awfEnv(t.home, root), RECORDS_STOP: "1" },
  });
  expect(await started.exited).toBe(3);
  expect(await attempt(false)).toBe(0);
});

test("an attempt that began before `since` isn't taken for the one asked about", async () => {
  expect(await attempt(true)).toBe(3);
  expect(runOutput(t.home, request.id, Date.now() + 60_000)).toBeUndefined();
});

test("status reads a real run: each stage, the reused one still shown as it ended", async () => {
  await attempt(true);
  expect((await runActivity(t.home, request.id))?.map((s) => [s.stage, s.state])).toEqual([
    ["intake", "succeeded"],
    ["write", "stopped"],
  ]);
  await attempt(false);
  expect((await runActivity(t.home, request.id))?.map((s) => [s.stage, s.state])).toEqual([
    ["intake", "succeeded"],
    ["write", "succeeded"],
  ]);
});

test("usage reads a real run's attempts, and awf's list reads with an older run beside it", async () => {
  await attempt(true);
  await attempt(false);
  const old = join(t.home, "runs", "op-build", "R-0000");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "run.json"), JSON.stringify({ id: "R-0000", workflow: "op-build" }));
  expect(runEstimates(t.home)).toEqual(new Map());
  const usage = runUsage(t.home, request.id)!;
  expect(usage.ms).toBeGreaterThan(0);
  // No agent ran, so awf has no price to give.
  expect(usage).toMatchObject({ usd: 0, partial: true });
  expect(await runActivity(t.home, "R-0000")).toBeUndefined();
});
