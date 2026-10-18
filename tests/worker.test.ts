import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Contexts } from "../core/contexts";
import { envName } from "../core/env";
import { Requests } from "../core/requests";
import { runWorker } from "../core/worker";
import { ROOT, tempHome } from "./helpers";

const AWF = join(import.meta.dir, "fixtures", "fake-awf.ts");
let t: ReturnType<typeof tempHome>;
let requests: Requests;
const domain = () => ({ name: "x", root: ROOT, dir: join(ROOT, "x"), home: t.home });
const calls = () =>
  readFileSync(join(t.home, "awf-calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { id: string; args: string[]; at: number });

beforeEach(() => {
  t = tempHome();
  requests = new Requests(t.home);
  process.env[envName("HOME")] = t.home;
});
afterEach(() => {
  delete process.env.FAKE_AWF;
  t.cleanup();
});

test("the worker runs every received request, oldest first, and exits when idle", async () => {
  const a = requests.file({ kind: "intake", text: "a", context: "acme", domain: domain() });
  const b = requests.file({ kind: "repair", op: "x:y", text: "b", context: "acme", domain: domain() });
  await runWorker(t.home, ROOT, { pollMs: 20, awf: AWF, maxRunning: 2 });
  // Both start at once, so the order is the ledger's, not which process got going first.
  expect(
    requests
      .ledger()
      .filter((e) => e.event === "started")
      .map((e) => e.id),
  ).toEqual([a.id, b.id]);
  expect(calls().find((c) => c.id === b.id)!.args[1]).toBe(join(ROOT, "core/workflows/repair.ts"));
  expect(requests.get(a.id)).toMatchObject({ state: "done", attempts: 1 });
  expect(requests.ledger(a.id).map((e) => e.event)).toEqual(["received", "started", "pid", "done", "exited"]);
  expect(requests.get(a.id)!.pid).toBeUndefined();
});

test("a run that blocks and exits leaves no pid on its request, for another process to pass as it", async () => {
  process.env.FAKE_AWF = "block";
  const r = requests.file({ kind: "intake", text: "a", context: "acme", domain: domain() });
  await runWorker(t.home, ROOT, { pollMs: 20, awf: AWF, maxRunning: 2 });
  expect(requests.get(r.id)).toMatchObject({ state: "blocked", question: "which one?" });
  expect(requests.get(r.id)!.pid).toBeUndefined();
});

test("at most maxRunning runs at a time", async () => {
  process.env.FAKE_AWF = "slow";
  for (const text of ["a", "b", "c"]) requests.file({ kind: "repair", op: "x:y", text, context: "acme", domain: domain() });
  await runWorker(t.home, ROOT, { pollMs: 20, awf: AWF, maxRunning: 2 });
  const [first, second, third] = calls();
  expect(third!.at - first!.at).toBeGreaterThan(300);
  expect(second!.at - first!.at).toBeLessThan(300);
});

test("a retry of a run that completed redoes it from its first stage, and says so until that stage starts", async () => {
  const r = requests.file({ kind: "intake", text: "a", context: "acme", domain: domain() });
  mkdirSync(join(t.home, "runs", "op-build", r.id), { recursive: true });
  writeFileSync(join(t.home, "runs", "op-build", r.id, "output.json"), JSON.stringify({ outcome: "completed" }));
  requests.update(r.id, () => ({ state: "deferred" }));
  requests.retry(r.id);
  await runWorker(t.home, ROOT, { pollMs: 20, awf: AWF, maxRunning: 2 });
  expect(calls()[0]!.args.slice(-4)).toEqual(["--continue", r.id, "--from-stage", "intake"]);
  // The fake run never starts a stage, so the next attempt would redo it too.
  expect(requests.get(r.id)!.redo).toBe(true);
});

test("one intake at a time, while a repair runs beside it", async () => {
  process.env.FAKE_AWF = "slow";
  const a = requests.file({ kind: "intake", text: "a", context: "acme", domain: domain() });
  const b = requests.file({ kind: "new", op: "x:y", text: "b", context: "acme", domain: domain() });
  const c = requests.file({ kind: "repair", op: "x:z", text: "c", context: "acme", domain: domain() });
  await runWorker(t.home, ROOT, { pollMs: 20, awf: AWF, maxRunning: 2 });
  const at = Object.fromEntries(calls().map((call) => [call.id, call.at]));
  expect(at[c.id]! - at[a.id]!).toBeLessThan(300);
  expect(at[b.id]! - at[a.id]!).toBeGreaterThan(300);
});

test("a run that dies without recording an end leaves its request failed", async () => {
  process.env.FAKE_AWF = "crash";
  const r = requests.file({ kind: "intake", text: "a", context: "acme", domain: domain() });
  await runWorker(t.home, ROOT, { pollMs: 20, awf: AWF, maxRunning: 2 });
  expect(requests.get(r.id)).toMatchObject({ state: "failed", reason: "the run ended without a result: awf exited 1" });
});

test("a run that dies is not given the reason the attempt before it ended with", async () => {
  process.env.FAKE_AWF = "crash";
  const r = requests.file({ kind: "intake", text: "a", context: "acme", domain: domain() });
  mkdirSync(join(t.home, "runs", "op-build", r.id), { recursive: true });
  writeFileSync(join(t.home, "runs", "op-build", r.id, "output.json"), JSON.stringify({ outcome: "failed", reason: "the attempt before" }));
  await Bun.sleep(5);
  await runWorker(t.home, ROOT, { pollMs: 20, awf: AWF, maxRunning: 2 });
  expect(requests.get(r.id)).toMatchObject({ state: "failed", reason: "the run ended without a result: awf exited 1" });
});

test("a request waiting on another's op lock is left until the holder ends", async () => {
  const holder = requests.file({ kind: "new", op: "x:y", text: "a", context: "acme", domain: domain() });
  requests.update(holder.id, () => ({ state: "blocked", question: "?" }));
  const waiting = requests.file({ kind: "new", op: "x:y", text: "b", context: "acme", domain: domain() });
  requests.update(waiting.id, () => ({ waitingFor: holder.id }));
  await runWorker(t.home, ROOT, { pollMs: 20, awf: AWF, maxRunning: 2 });
  expect(requests.get(waiting.id)!.state).toBe("received");
  requests.update(holder.id, () => ({ state: "done" }));
  await runWorker(t.home, ROOT, { pollMs: 20, awf: AWF, maxRunning: 2 });
  expect(requests.get(waiting.id)!.state).toBe("done");
});

test("while a request runs, the worker keeps its context signed in", async () => {
  process.env.FAKE_AWF = "slow";
  requests.file({ kind: "intake", text: "a", context: "acme", domain: domain() });
  const touched: string[] = [];
  const keepSignedIn = async (c: string) => touched.push(c) > 0;
  await runWorker(t.home, ROOT, { pollMs: 20, awf: AWF, maxRunning: 2, signInEveryMs: 100, keepSignedIn });
  expect(touched.length).toBeGreaterThan(0);
  expect(new Set(touched)).toEqual(new Set(["acme"]));
  // An app that doesn't sign out an idle session sets no interval: nothing is touched.
  touched.length = 0;
  requests.file({ kind: "intake", text: "b", context: "acme", domain: domain() });
  await runWorker(t.home, ROOT, { pollMs: 20, awf: AWF, maxRunning: 2, keepSignedIn });
  expect(touched).toEqual([]);
});

test("a request blocked on signing in gets one sign-in try from the worker, where it can sign in", async () => {
  const r = requests.file({ kind: "intake", text: "a", context: "acme", domain: domain() });
  requests.update(r.id, () => ({ state: "blocked", question: "sign in again: x context:login acme" }));
  const tried: string[] = [];
  // Keeping a sign-in alive is no sign-in: an app only a person signs in to gets no try.
  await runWorker(t.home, ROOT, { pollMs: 20, awf: AWF, maxRunning: 2, signInEveryMs: 100, keepSignedIn: async (c) => tried.push(c) > 0 });
  expect(tried).toEqual([]);
  expect(requests.get(r.id)!.state).toBe("blocked");
  await runWorker(t.home, ROOT, {
    pollMs: 20,
    awf: AWF,
    maxRunning: 2,
    signInAgain: async (c) => tried.push(c) > 0,
  });
  expect(tried).toEqual(["acme"]);
  expect(requests.get(r.id)).toMatchObject({ state: "done", answers: [{ text: "signed in again" }] });
});

test("a call whose direct way failed and whose browser way did it starts the worker for the direct way's repair", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("<h1>Home</h1>", { headers: { "content-type": "text/html" } }) });
  try {
    // A CLI of its own, as the fixture's is X's, which makes no direct calls.
    const dir = join(t.home, "t");
    mkdirSync(join(dir, "ops", "thing-find"), { recursive: true });
    writeFileSync(
      join(dir, "ops", "thing-find", "op.ts"),
      `const out = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
export default {
  name: "thing:find",
  description: "Find a thing",
  input: { type: "object", properties: {}, required: [] },
  output: out,
  run: async () => ({ id: "from the page" }),
  direct: async ({ step }) => step("call the app", async () => { throw new Error("the call moved"); }),
};
`,
    );
    const entry = join(t.home, "main.ts");
    writeFileSync(
      entry,
      `import { main } from ${JSON.stringify(join(ROOT, "core", "cli"))};
await main({
  name: "t", dir: ${JSON.stringify(dir)}, root: ${JSON.stringify(t.home)}, home: ${JSON.stringify(t.home)}, worktree: false,
  helpers: () => ({}),
  signInState: async (page) => ((await page.getByRole("heading").count()) ? "signed-in" : "unknown"),
});
`,
    );
    const ctx = new Contexts(t.home, "t").add("acme", server.url.href);
    mkdirSync(join(ctx.authFile, ".."), { recursive: true });
    writeFileSync(ctx.authFile, JSON.stringify({ cookies: [], origins: [] }));
    const child = Bun.spawn(["bun", entry, "thing:find", "--json"], {
      cwd: ROOT,
      env: { ...process.env, [envName("HOME")]: t.home, [envName("AWF")]: AWF, [envName("STEP_TIMEOUT_MS")]: "2000" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).data).toEqual({ id: "from the page" });
    const [repair] = requests.list();
    expect(repair).toMatchObject({ kind: "repair", op: "thing:find", failure: { fellBack: true } });
    // The worker it started hands the repair to awf, here the fake, which ends it done.
    const until = Date.now() + 10_000;
    while (requests.get(repair!.id)!.state !== "done" && Date.now() < until) await Bun.sleep(50);
    expect(existsSync(join(t.home, "awf-calls.jsonl")) && calls().map((c) => c.id)).toEqual([repair!.id]);
  } finally {
    server.stop(true);
  }
});
