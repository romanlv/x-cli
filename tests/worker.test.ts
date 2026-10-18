import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  expect(requests.ledger(a.id).map((e) => e.event)).toEqual(["received", "started", "pid", "done"]);
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

test("a request blocked on signing in gets one sign-in try from the worker", async () => {
  const r = requests.file({ kind: "intake", text: "a", context: "acme", domain: domain() });
  requests.update(r.id, () => ({ state: "blocked", question: "sign in again: x context:login acme" }));
  const tried: string[] = [];
  await runWorker(t.home, ROOT, {
    pollMs: 20,
    awf: AWF,
    maxRunning: 2,
    keepSignedIn: async (c) => tried.push(c) > 0,
  });
  expect(tried).toEqual(["acme"]);
  expect(requests.get(r.id)).toMatchObject({ state: "done", answers: [{ text: "signed in again" }] });
});
