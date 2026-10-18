import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answer, reply, testWorkflow } from "agentswf/testing";
import { ENV_PREFIX as P } from "../env";
import { type RequestRecord, Requests } from "../requests";
import { defineBuild } from "./build";
import { type Deps, type Git, realDeps, type Verified } from "./deps";
import { defineRepair } from "./repair";
import { sandboxPaths, sandboxSpec } from "./sandbox";
import {
  cleanUpCancelled,
  INTAKE as DECIDED,
  DIAGNOSIS as DIAGNOSED,
  DONE as FINISHED,
  orQuestion,
  QUESTION,
  REVIEW,
  EXPLORED as SURVEYED,
} from "./shared";

// What the agents are asked for: each answer, or the question.
const INTAKE = orQuestion(DECIDED);
const EXPLORED = orQuestion(SURVEYED);
const DONE = orQuestion(FINISHED);
const DIAGNOSIS = orQuestion(DIAGNOSED);

let home: string;
let requests: Requests;
let git: FakeGit;
let verifies: Verified[];
let verified: string[];
let closed: string[][];
let checks: { ok: boolean; output: string }[];
let checked: string[];
let sandboxed: string[];
/** Whether the checkout has the context's sign-in; each sign-in is recorded. */
let credentials: boolean;
let signIns: string[];

type FakeGit = Git & {
  calls: string[];
  changedFiles: string[];
  mainFiles: string[];
  /** The main commits each rebase lands the branch on, in order; it stays on base0 otherwise. */
  bases: string[];
  current: string;
  conflicts: number;
  ffFailures: number;
  rebasing: boolean;
  /** The branch has nothing left to squash, as after a merge that landed. */
  empty: boolean;
  landedAs?: string;
};

const fakeGit = (): FakeGit => {
  const g: FakeGit = {
    calls: [],
    changedFiles: ["x/ops/thing-find/op.ts"],
    mainFiles: [],
    bases: [],
    current: "base0",
    conflicts: 0,
    ffFailures: 0,
    rebasing: false,
    empty: false,
    ensureWorktree: async (_r, wt) => void g.calls.push(`worktree ${wt}`),
    squash: async (_wt, message) => {
      g.calls.push(`squash ${message}`);
      return g.empty ? undefined : "abc1234567";
    },
    landed: async () => g.landedAs,
    base: async () => g.current,
    rebase: async () => {
      g.calls.push("rebase");
      g.current = g.bases.shift() ?? g.current;
      return g.conflicts-- > 0 ? { ok: false, conflict: "x/helpers/index.ts" } : { ok: true };
    },
    rebaseInProgress: async () => g.rebasing,
    changed: async () => g.changedFiles,
    changedOnMain: async () => g.mainFiles,
    fastForward: async (_r, branch) => {
      g.calls.push(`ff ${branch}`);
      if (g.ffFailures-- > 0) throw new Error("not a fast-forward");
      return "abc1234567";
    },
    removeWorktree: async (_r, wt) => void g.calls.push(`remove ${wt}`),
  };
  return g;
};

const passed = (op = "thing:find"): Verified => ({
  op,
  ok: true,
  runs: [{ input: { query: "lamp" }, exitCode: 0, ok: true }],
  signedOut: false,
  noExamples: false,
});
const failed = (error: string, op = "thing:find"): Verified => ({
  op,
  ok: false,
  runs: [{ input: { query: "lamp" }, exitCode: 1, ok: false, error }],
  signedOut: false,
  noExamples: false,
});

const deps = (): Deps => ({
  git,
  verify: async (_wt, _r, op) => {
    verified.push(op);
    return verifies.shift() ?? passed(op);
  },
  checks: async (_wt, scope) => {
    checked.push(scope);
    return checks.shift() ?? { ok: true, output: "" };
  },
  closeSessions: async (_wt, _r, sessions) => void closed.push(sessions),
  signIn: async (r) => {
    signIns.push(r.context);
    return credentials;
  },
  sandbox: async (_r, worktree, paths) => {
    sandboxed.push(worktree);
    for (const dir of [worktree, paths.home]) mkdirSync(dir, { recursive: true });
    return { write: [worktree, paths.home], srt: {} };
  },
});

const domain = () => ({ name: "x", root: "/repo", dir: "/repo/x", home });

const file = (over: Partial<RequestRecord> = {}): RequestRecord =>
  requests.file({
    kind: "new",
    op: "thing:find",
    text: "the things that match a word",
    context: "acme",
    domain: domain(),
    call: { op: "thing:find", argv: ["thing:find", "--query", "lamp"] },
    ...over,
  });

const planned = { kind: "build", op: "thing:find", summary: "find things by a word" } as const;
const done = (summary: string) => answer(DONE, { kind: "done", summary });
const planning = () => [answer(INTAKE, planned), done("spec written")];
const explored = answer(EXPLORED, { kind: "done", summary: "explored" });
const building = () => [explored, done("written")];
const approve = answer(REVIEW, { findings: [] });
/** Stages a continue reuses, as an earlier attempt recorded them up to `upTo`. */
const recordedUpTo = (upTo: "intake" | "explore" | "spec" | "write" | "check") => {
  const all = {
    intake: { ...planned, change: false },
    explore: { kind: "done", summary: "explored" },
    spec: { kind: "done", summary: "spec written" },
    write: { kind: "done", summary: "written" },
    check: { revisions: 0, by: "builder", base: "base0" },
  };
  const order = Object.keys(all);
  return Object.fromEntries(Object.entries(all).filter(([k]) => order.indexOf(k) <= order.indexOf(upTo)));
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "wf-"));
  requests = new Requests(home);
  git = fakeGit();
  verifies = [];
  checks = [];
  checked = [];
  sandboxed = [];
  credentials = false;
  signIns = [];
  verified = [];
  closed = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

// ── build ─────────────────────────────────────────────────────────────────────────────────────────

test("a new op goes through every stage, is merged, and the request ends done", async () => {
  const r = file();
  requests.update(r.id, () => ({ state: "building" }));
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    { agents: { planner: planning(), builder: building(), checker: approve } },
  );
  expect(run.value).toEqual({ state: "done", summary: "built thing:find (0 revision(s)): find things by a word" });
  expect(requests.get(r.id)).toMatchObject({
    state: "done",
    result: { commit: "abc1234567", command: "x thing:find --query lamp" },
  });
  expect(git.calls).toEqual([
    `worktree ${home}/worktrees/${r.id}`,
    `squash ${r.id} build thing:find`,
    "rebase",
    `ff req/${r.id}`,
    `remove ${home}/worktrees/${r.id}`,
  ]);
  expect(closed).toEqual([[r.id, `${r.id}-check`]]);
  expect(requests.lockOp("thing:find", "R-9999")).toBeUndefined();
  // Every stage after intake carries the whole brief, since a builder may start fresh at any of them.
  for (const turn of run.turnsOf("builder").slice(1)) {
    expect(turn.prompt).toContain("the things that match a word");
    expect(turn.prompt).toContain(`${home}/sessions/${r.id}/trace.jsonl`);
  }
  // Agents call the worktree's CLI in the request's home, filing nothing.
  expect(run.agentOf("builder").instructions).toContain(
    `env ${P}HOME=${home} ${P}NO_REPAIRS=1 ${P}NO_WORKER=1 bun ${home}/worktrees/${r.id}/x/main.ts`,
  );
  // The planner drives no browser, and writes the spec from what explore found.
  expect(run.agentOf("planner").instructions).not.toContain("--session");
  expect(run.turnsOf("planner")[1]!.prompt).toContain("<explored>\nexplored\n</explored>");
  expect(run.agentOf("checker").execution).toMatchObject({ harness: "codex" });
  expect(run.agentOf("checker").instructions).toContain(`--session ${r.id}-check`);
  // The checker tries an input of its own, and reads what the builder says it ran.
  expect(run.turnsOf("checker")[0]!.prompt).toContain("an input of your own");
  expect(run.turnsOf("checker")[0]!.prompt).toContain("<builder>\nwritten\n</builder>");
});

test.each([
  ["duplicate", answer(INTAKE, { kind: "duplicate", command: "x thing:list --help", reason: "thing:list does it" })],
  ["deferred", answer(INTAKE, { kind: "deferred", reason: "needs a page this context can't see" })],
  ["declined", answer(INTAKE, { kind: "declined", reason: "too vague" })],
] as const)("intake ends a %s request without a build, and cleans up", async (state, intake) => {
  const r = file({ kind: "intake", op: undefined, call: undefined });
  const run = await testWorkflow(defineBuild(deps()), { id: r.id, home }, { agents: { planner: intake } });
  expect(run.value.state).toBe(state);
  expect(requests.get(r.id)!.state).toBe(state);
  expect(run.turnsOf("planner")).toHaveLength(1);
  expect(git.calls.at(-1)).toStartWith("remove");
});

test("a retry over a recorded ending records it again instead of leaving the request building", async () => {
  const r = file({ kind: "intake", op: undefined });
  requests.update(r.id, () => ({ state: "building" }));
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    {
      recorded: { intake: { kind: "deferred", reason: "later" } },
      agents: {},
    },
  );
  expect(run.value).toEqual({ state: "deferred", summary: "later" });
  expect(requests.get(r.id)!.state).toBe("deferred");
});

test("an op intake names that is there already is changed, whatever the request was filed as", async () => {
  const root = join(home, "checkout");
  mkdirSync(join(root, "x", "ops", "thing-find"), { recursive: true });
  const r = file({ kind: "intake", domain: { ...domain(), root, dir: join(root, "x") } });
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    { agents: { planner: planning(), builder: building(), checker: approve } },
  );
  expect(requests.get(r.id)!.kind).toBe("change");
  expect(git.calls).toContain(`squash ${r.id} change thing:find`);
  expect(run.value.summary).toStartWith("changed thing:find");
});

test("an op name that isn't noun:verb stops intake", async () => {
  const r = file();
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    {
      agents: { planner: answer(INTAKE, { ...planned, op: "thing-list:find" }) },
    },
  );
  expect(run.stopped).toMatchObject({ stage: "intake" });
});

test("agents run unsandboxed on the default models when there is no workflows.json", async () => {
  const r = file();
  requests.update(r.id, () => ({ state: "building" }));
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    { agents: { planner: planning(), builder: building(), checker: approve } },
  );
  expect(run.agentOf("builder").sandbox).toBeUndefined();
  expect(run.agentOf("planner").execution).toMatchObject({ harness: "claude", model: "claude-opus-5-5" });
  expect(run.agentOf("builder").execution).toMatchObject({ harness: "claude", model: "claude-sonnet-5-5" });
  expect(run.agentOf("checker").execution).toMatchObject({ harness: "codex", model: "gpt-6.1-sol" });
  expect(sandboxed).toEqual([]);
});

test("workflows.json puts the team in one sandbox, on the models it names", async () => {
  const root = join(home, "checkout");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(home, "shared"));
  writeFileSync(
    join(root, "workflows.json"),
    JSON.stringify({
      sandbox: { network: ["docs.playwright.dev"], read: ["../shared"] },
      agents: { builder: { harness: "codex", model: "gpt-cheap", placement: "headless" } },
    }),
  );
  const r = file({ domain: { ...domain(), root, dir: join(root, "x") } });
  requests.update(r.id, () => ({ state: "building" }));
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    { agents: { planner: planning(), builder: building(), checker: approve } },
  );
  expect(run.value).toMatchObject({ state: "done" });
  expect(run.agentOf("builder").execution).toMatchObject({ harness: "codex", model: "gpt-cheap" });
  expect(run.agentOf("checker").execution).toMatchObject({ harness: "codex", model: "gpt-6.1-sol" });
  expect(run.agentOf("planner").execution).toMatchObject({ harness: "claude", model: "claude-opus-5-5" });
  expect(run.agentOf("planner").sandbox).toEqual(run.agentOf("builder").sandbox);
  const box = run.agentOf("builder").sandbox!;
  expect(box).toMatchObject({ key: "agents", provider: "srt" });
  expect(run.agentOf("checker").sandbox).toEqual(box);
  // What workflows.json adds, its paths from the checkout's root.
  expect(box.spec.network).toContain("docs.playwright.dev");
  expect(box.spec.read).toContain(realpathSync(join(home, "shared")));
  expect(sandboxed).toEqual([`${home}/worktrees/${r.id}`]);
  // Their CLI keeps its state in the request's own home and reaches the host's browser by socket.
  const { sockets } = sandboxPaths(r);
  expect(sockets).toStartWith(join(realpathSync("/tmp"), `x-${r.id}-`));
  expect(run.agentOf("builder").instructions).toContain(
    `env ${P}HOME=${home}/sandboxes/${r.id} ${P}NO_REPAIRS=1 ${P}NO_WORKER=1 ${P}CONTEXTS_DIR=${home}/contexts ${P}BROWSER=ws+unix://${sockets}/browser.sock:/browser TMPDIR=${sockets} bun`,
  );
  expect(run.turnsOf("builder")[0]!.prompt).toContain(`${home}/sandboxes/${r.id}/sessions/${r.id}/trace.jsonl`);
});

test("a question stops the run blocked on it, at the stage that asked", async () => {
  const r = file();
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    {
      agents: {
        planner: [answer(INTAKE, planned)],
        builder: [answer(EXPLORED, { kind: "question", question: "Which word should the examples search for?" })],
      },
    },
  );
  expect(run.stopped?.stage).toBe("explore");
  expect(requests.get(r.id)).toMatchObject({ state: "blocked", question: "Which word should the examples search for?", stage: "explore" });
  // A blocked request keeps its op and its worktree for the answer.
  expect(requests.lockOp("thing:find", "R-9999")).toBe(r.id);
  expect(git.calls.some((c) => c.startsWith("remove"))).toBe(false);
});

test("an answered question reaches the stage that asked, the checker and the polish, on the continue", async () => {
  const r = file();
  requests.update(r.id, () => ({ state: "blocked", question: "Which word?" }));
  requests.answer(r.id, "lamp");
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    {
      recorded: recordedUpTo("intake"),
      agents: {
        planner: done("spec written"),
        builder: [...building(), done("fixed the typo")],
        checker: answer(REVIEW, { findings: [{ where: "notes.md:4", problem: "a typo", severity: "minor" }] }),
      },
    },
  );
  const polish = run.turnsOf("builder").at(-1)!.prompt;
  expect(polish).toContain("notes.md:4: a typo");
  for (const prompt of [run.turnsOf("builder")[0]!.prompt, run.turnsOf("checker")[0]!.prompt, polish]) expect(prompt).toContain("A: lamp");
  // The checker changes no files, and the polish only what the findings ask for: neither is told to write the answer down.
  expect(run.turnsOf("builder")[0]!.prompt).toContain("write each into the level of knowledge");
  expect(run.turnsOf("checker")[0]!.prompt).not.toContain("write each into the level of knowledge");
  expect(polish).not.toContain("write each into the level of knowledge");
  expect(run.value.state).toBe("done");
});

test("a failed verify goes back to the builder, and so does a finding", async () => {
  verifies = [failed("timeout at fill name"), passed()];
  const r = file();
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    {
      agents: {
        planner: planning(),
        builder: [...building(), done("fixed the wait"), done("made the order an input")],
        checker: [answer(REVIEW, { findings: [{ where: "op.ts:12", problem: "'newest' is a constant", severity: "blocking" }] }), approve],
      },
    },
  );
  const revisions = run.turnsOf("builder").slice(2);
  expect(revisions[0]!.prompt).toContain("timeout at fill name");
  expect(revisions[1]!.prompt).toContain("op.ts:12: 'newest' is a constant");
  // Each review reads the builder's latest answer.
  expect(run.turnsOf("checker")[0]!.prompt).toContain("<builder>\nfixed the wait\n</builder>");
  expect(run.turnsOf("checker")[1]!.prompt).toContain("<builder>\nmade the order an input\n</builder>");
  expect(run.value.summary).toContain("(2 revision(s))");
});

test("failing repository checks go back to the builder before the checker sees it", async () => {
  checks = [{ ok: false, output: "x/helpers/index.ts: Code style issues found" }];
  const r = file();
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    { agents: { planner: planning(), builder: [...building(), done("formatted it")], checker: approve } },
  );
  expect(run.turnsOf("builder")[2]!.prompt).toContain("bun run ci:fast");
  expect(run.turnsOf("builder")[2]!.prompt).toContain("Code style issues found");
  expect(run.turnsOf("checker")).toHaveLength(1);
  expect(run.value.summary).toContain("(1 revision(s))");
});

test("minor findings are fixed without another review, and the full checks run once before approval", async () => {
  const r = file();
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    {
      agents: {
        planner: planning(),
        builder: [...building(), done("reworded the spec")],
        checker: answer(REVIEW, { findings: [{ where: "spec.md:3", problem: "names the wrong task path", severity: "minor" }] }),
      },
    },
  );
  expect(run.turnsOf("checker")).toHaveLength(1);
  expect(run.turnsOf("builder")[2]!.prompt).toContain("spec.md:3: names the wrong task path");
  expect(checked).toEqual(["fast", "full"]);
  // The polish changed code, so verify ran again before approval.
  expect(verified).toEqual(["thing:find", "thing:find"]);
  expect(run.value.summary).toContain("(0 revision(s))");
});

test("the full checks failing at approval go back to the builder as a round", async () => {
  checks = [
    { ok: true, output: "" },
    { ok: false, output: "(fail) e2e > a call prints what it read back" },
  ];
  const r = file();
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    { agents: { planner: planning(), builder: [...building(), done("fixed the e2e")], checker: [approve, approve] } },
  );
  expect(run.turnsOf("builder")[2]!.prompt).toContain("bun run ci:check");
  expect(run.turnsOf("builder")[2]!.prompt).toContain("a call prints what it read back");
  expect(checked).toEqual(["fast", "full", "fast", "full"]);
  expect(run.value.summary).toContain("(1 revision(s))");
});

test("the builder keeps its rounds while each gets further", async () => {
  verifies = [failed("first"), passed(), passed(), passed()];
  const blocking = (n: number) =>
    answer(REVIEW, {
      findings: Array.from({ length: n }, (_, i) => ({ where: `op.ts:${i}`, problem: "wrong", severity: "blocking" as const })),
    });
  const r = file();
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    {
      agents: {
        planner: planning(),
        builder: [...building(), done("1"), done("2"), done("3")],
        checker: [blocking(2), blocking(1), approve],
      },
    },
  );
  expect(run.turnsOf("troubleshooter")).toHaveLength(0);
  expect(run.value.summary).toContain("(3 revision(s))");
});

test("a review after the full checks failed is a fresh look, not a round that got no further", async () => {
  checks = [
    { ok: true, output: "" },
    { ok: false, output: "(fail) e2e > a call prints what it read back" },
  ];
  const r = file();
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    {
      agents: {
        planner: planning(),
        builder: [...building(), done("fixed the e2e"), done("named the step")],
        checker: [approve, answer(REVIEW, { findings: [{ where: "op.ts:3", problem: "unnamed step", severity: "blocking" }] }), approve],
      },
    },
  );
  expect(run.turnsOf("troubleshooter")).toHaveLength(0);
  expect(run.value.summary).toContain("(2 revision(s))");
});

test("a builder round that gets no further hands it to the troubleshooter with every round's problem", async () => {
  verifies = [failed("first"), failed("second"), passed()];
  const r = file();
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    {
      agents: {
        planner: planning(),
        builder: [...building(), done("1")],
        troubleshooter: done("2"),
        checker: approve,
      },
    },
  );
  const prompt = run.turnsOf("troubleshooter")[0]!.prompt;
  expect(prompt).toContain("You are taking over");
  for (const problem of ["first", "second"]) expect(prompt).toContain(problem);
  expect(run.value.summary).toContain("(2 revision(s))");
});

test("a troubleshooter round that gets no further asks a person one question", async () => {
  verifies = Array.from({ length: 3 }, (_, i) => failed(`attempt ${i}`));
  const r = file();
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    {
      agents: {
        planner: planning(),
        builder: [...building(), done("1")],
        troubleshooter: [done("2"), answer(QUESTION, { kind: "question", question: "Can this context see the search page?" })],
      },
    },
  );
  expect(run.stopped?.stage).toBe("check");
  expect(requests.get(r.id)).toMatchObject({ state: "blocked", question: "Can this context see the search page?" });
});

test("explore finding no way in the app ends the request deferred, with no spec written", async () => {
  const r = file();
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    {
      agents: {
        planner: [answer(INTAKE, planned)],
        builder: answer(EXPLORED, { kind: "missing", reason: "no search, no list of them, tried both" }),
      },
    },
  );
  expect(run.value.state).toBe("deferred");
  expect(requests.get(r.id)).toMatchObject({ state: "deferred" });
  expect(run.turnsOf("planner")).toHaveLength(1);
});

test("a signed-out session blocks on signing in, without spending a round", async () => {
  verifies = [{ ...failed("signed out"), signedOut: true }];
  const r = file();
  const run = await testWorkflow(defineBuild(deps()), { id: r.id, home }, { agents: { planner: planning(), builder: building() } });
  expect(run.stopped?.stage).toBe("check");
  expect(signIns).toEqual(["acme"]);
  expect(requests.get(r.id)).toMatchObject({ state: "blocked", question: "sign in again: x context:login acme" });
});

test("with the context's sign-in in the checkout, verify signs in again and goes on", async () => {
  credentials = true;
  verifies = [{ ...failed("signed out"), signedOut: true }];
  const r = file();
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    { agents: { planner: planning(), builder: building(), checker: approve } },
  );
  expect(run.value.state).toBe("done");
  expect(signIns).toEqual(["acme"]);
  expect(verified.slice(0, 2)).toEqual(["thing:find", "thing:find"]);
});

test("an agent that finds the session signed out goes on in the same turn once the run signs in again", async () => {
  credentials = true;
  const r = file();
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    {
      agents: {
        planner: planning(),
        builder: [answer(EXPLORED, { kind: "question", question: "sign in again: x context:login acme" }), ...building()],
        checker: approve,
      },
    },
  );
  expect(run.value.state).toBe("done");
  expect(signIns).toEqual(["acme"]);
  expect(run.turnsOf("builder")[1]!.prompt).toContain('Context "acme" is signed in again');
});

test("signing in that keeps failing to hold blocks after two tries", async () => {
  credentials = true;
  const signedOut = answer(EXPLORED, { kind: "question", question: "sign in again: x context:login acme" });
  const r = file();
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    { agents: { planner: [answer(INTAKE, planned)], builder: [signedOut, signedOut, signedOut] } },
  );
  expect(run.stopped?.stage).toBe("explore");
  expect(signIns).toEqual(["acme", "acme"]);
  expect(requests.get(r.id)).toMatchObject({ state: "blocked", question: "sign in again: x context:login acme" });
});

test("a helper change re-verifies every other op with examples for the context", async () => {
  git.changedFiles = ["x/helpers/index.ts"];
  const opsDir = join(home, "worktrees", "R-0001", "x", "ops");
  for (const [folder, context] of [
    ["thing-list", "acme"],
    ["item-list", "other"],
  ] as const) {
    mkdirSync(join(opsDir, folder), { recursive: true });
    writeFileSync(join(opsDir, folder, "examples.json"), JSON.stringify([{ context, input: {} }]));
  }
  verifies = [passed(), failed("Name not found", "thing:list")];
  const r = file();
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    { agents: { planner: planning(), builder: [...building(), done("kept the helper compatible")], checker: approve } },
  );
  expect(verified.slice(0, 2)).toEqual(["thing:find", "thing:list"]);
  expect(run.turnsOf("builder")[2]!.prompt).toContain("thing:list");
  expect(run.value.state).toBe("done");
});

test("a mapper change re-verifies the other ops too, and a change to the op and to tests alone doesn't", async () => {
  for (const id of ["R-0001", "R-0002"]) {
    const other = join(home, "worktrees", id, "x", "ops", "thing-list");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "examples.json"), JSON.stringify([{ context: "acme", input: {} }]));
  }
  git.changedFiles = ["x/ops/thing-find/op.ts", "x/helpers/index.test.ts", "core/workflows/workflows.test.ts"];
  const alone = file();
  await testWorkflow(
    defineBuild(deps()),
    { id: alone.id, home },
    { agents: { planner: planning(), builder: building(), checker: approve } },
  );
  expect(verified).toEqual(["thing:find"]);
  verified.length = 0;
  git.changedFiles = ["x/ops/thing-find/op.ts", "x/map/graphql.ts"];
  const shared = file();
  await testWorkflow(
    defineBuild(deps()),
    { id: shared.id, home },
    { agents: { planner: planning(), builder: building(), checker: approve } },
  );
  expect(verified.slice(0, 2)).toEqual(["thing:find", "thing:list"]);
});

test("an examples.json that isn't JSON fails verify and goes back to the builder, instead of ending the run", async () => {
  const r = file();
  const worktree = join(home, "worktrees", r.id);
  mkdirSync(join(worktree, "x", "ops", "thing-find"), { recursive: true });
  writeFileSync(join(worktree, "x", "ops", "thing-find", "examples.json"), '[{ "context": ');
  const unreadable = await realDeps.verify(worktree, r, "thing:find");
  expect(unreadable).toMatchObject({ ok: false, runs: [], noExamples: false });
  expect(unreadable.problem).toStartWith("examples.json: not JSON");
  verifies = [unreadable];
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    { agents: { planner: planning(), builder: [...building(), done("fixed the JSON")], checker: approve } },
  );
  expect(run.turnsOf("builder")[2]!.prompt).toContain("- thing:find: examples.json: not JSON");
  expect(run.value.state).toBe("done");
});

test("after a helper change, another op whose examples.json can't be read is verified too, so verify says so", async () => {
  git.changedFiles = ["x/helpers/index.ts"];
  const other = join(home, "worktrees", "R-0001", "x", "ops", "thing-list");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "examples.json"), JSON.stringify({ context: "acme" }));
  const r = file();
  await testWorkflow(defineBuild(deps()), { id: r.id, home }, { agents: { planner: planning(), builder: building(), checker: approve } });
  expect(verified.slice(0, 2)).toEqual(["thing:find", "thing:list"]);
});

test("a turn stuck on a permission prompt blocks the request instead of failing it", async () => {
  const r = file();
  await testWorkflow(defineBuild(deps()), { id: r.id, home }, { agents: { planner: reply.blocked() } });
  expect(requests.get(r.id)!.state).toBe("blocked");
  expect(requests.get(r.id)!.question).toStartWith("the planner agent (intake) stopped at a prompt only a person can answer");
});

test("a turn that times out stops the run and leaves the request for the worker to settle", async () => {
  const r = file();
  requests.update(r.id, () => ({ state: "building" }));
  const run = await testWorkflow(defineBuild(deps()), { id: r.id, home }, { agents: { planner: reply.timedOut() } });
  expect(run.stopped?.stage).toBe("intake");
  expect(requests.get(r.id)!.state).toBe("building");
});

// ── locks ─────────────────────────────────────────────────────────────────────────────────────────

test("a second request for an op waits for the one holding it", async () => {
  const first = file();
  requests.update(first.id, () => ({ state: "building" }));
  requests.lockOp("thing:find", first.id);
  const second = file();
  await testWorkflow(defineBuild(deps()), { id: second.id, home }, { agents: { planner: [answer(INTAKE, planned)] } });
  expect(requests.get(second.id)).toMatchObject({ state: "received", waitingFor: first.id });
});

test("a continue takes the lock again, so a retry can't build beside a newer request", async () => {
  const older = file();
  const newer = file();
  requests.update(newer.id, () => ({ state: "building" }));
  requests.lockOp("thing:find", newer.id);
  const run = await testWorkflow(defineBuild(deps()), { id: older.id, home }, { recorded: recordedUpTo("explore"), agents: {} });
  expect(run.turns).toHaveLength(0);
  expect(requests.get(older.id)).toMatchObject({ state: "received", waitingFor: newer.id });
});

test("a request that waits before building anything drops its worktree and starts again at intake", async () => {
  git.changedFiles = [];
  const first = file();
  requests.update(first.id, () => ({ state: "building" }));
  requests.lockOp("thing:find", first.id);
  const second = file();
  await testWorkflow(defineBuild(deps()), { id: second.id, home }, { agents: { planner: [answer(INTAKE, planned)] } });
  expect(requests.get(second.id)).toMatchObject({ state: "received", waitingFor: first.id, redo: true });
  expect(git.calls.at(-1)).toBe(`remove ${home}/worktrees/${second.id}`);
});

test("intake sees the open requests, and one it finds the same ends as its duplicate", async () => {
  const first = file({ op: "thing:find" });
  requests.update(first.id, () => ({ state: "building" }));
  const second = file({ op: undefined, call: undefined, text: "look things up by a word" });
  const same = answer(INTAKE, { kind: "same", request: first.id, reason: "it finds things by a word too" });
  const run = await testWorkflow(defineBuild(deps()), { id: second.id, home }, { agents: { planner: [same] } });
  expect(run.turnsOf("planner")[0]!.prompt).toContain(`- ${first.id} (building, thing:find): the things that match a word`);
  expect(requests.get(second.id)).toMatchObject({
    state: "duplicate",
    reason: "it finds things by a word too",
    result: { of: first.id },
  });
  expect(git.calls.at(-1)).toBe(`remove ${home}/worktrees/${second.id}`);
});

test("intake can't name a request it wasn't shown", async () => {
  const r = file();
  requests.update(r.id, () => ({ state: "building" }));
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    { agents: { planner: [answer(INTAKE, { kind: "same", request: "R-9999", reason: "the same" })] } },
  );
  expect(run.stopped).toMatchObject({ stage: "intake" });
  expect(requests.get(r.id)!.state).toBe("building");
});

test("a cancelled request's sessions are closed wherever its run kept them, whatever workflows.json says now", async () => {
  const r = file();
  const homes: (string | undefined)[] = [];
  const cleaning = {
    ...deps(),
    closeSessions: async (_wt: string, _r: RequestRecord, _s: string[], box?: { home: string }) => void homes.push(box?.home),
  };
  await cleanUpCancelled(r, cleaning);
  expect(homes).toEqual([undefined]);
  mkdirSync(join(home, "sandboxes", r.id), { recursive: true });
  await cleanUpCancelled(r, cleaning);
  expect(homes).toEqual([undefined, join(home, "sandboxes", r.id), undefined]);
  expect(git.calls.filter((c) => c.startsWith("remove"))).toHaveLength(2);
});

// ── merge ─────────────────────────────────────────────────────────────────────────────────────────

test("when main moved, the op is checked again before it lands", async () => {
  git.bases = ["moved"];
  git.mainFiles = ["x/helpers/index.ts"];
  const r = file();
  const run = await testWorkflow(defineBuild(deps()), { id: r.id, home }, { recorded: recordedUpTo("check") });
  // Verify and the repository's checks pass on the new main, so no agent is asked again.
  expect(verified).toEqual(["thing:find"]);
  expect(run.turnsOf("checker")).toHaveLength(0);
  expect(run.value.state).toBe("done");
});

test("a fix made while re-checking after a rebase is committed before it lands", async () => {
  git.bases = ["moved"];
  verifies = [failed("broke on the new main"), passed()];
  const r = file();
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    {
      recorded: recordedUpTo("check"),
      agents: { builder: done("fixed for the new main"), checker: approve },
    },
  );
  // squash, rebase, re-check with a fix, then squash and rebase again before the fast-forward.
  expect(git.calls.filter((c) => c.startsWith("squash"))).toHaveLength(2);
  expect(git.calls.indexOf(`ff req/${r.id}`)).toBeGreaterThan(git.calls.lastIndexOf(`squash ${r.id} build thing:find`));
  expect(run.value.state).toBe("done");
});

test("a merge redone after a block checks again against what was approved", async () => {
  const r = file();
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    {
      recorded: { ...recordedUpTo("check"), check: { revisions: 0, by: "builder", base: "approved-on-old-main" } },
    },
  );
  expect(verified).toEqual(["thing:find"]);
  expect(run.value.state).toBe("done");
});

test("a merge that landed before the run died is found on main", async () => {
  git.empty = true;
  git.landedAs = "f00d";
  const r = file();
  const run = await testWorkflow(defineBuild(deps()), { id: r.id, home }, { recorded: recordedUpTo("check"), agents: {} });
  expect(run.value.state).toBe("done");
  expect(requests.get(r.id)!.result!.commit).toBe("f00d");
});

test("another op that fails on main too is not this change's to fix", async () => {
  git.changedFiles = ["x/helpers/index.ts"];
  const opsDir = join(home, "worktrees", "R-0001", "x", "ops", "thing-list");
  mkdirSync(opsDir, { recursive: true });
  writeFileSync(join(opsDir, "examples.json"), JSON.stringify([{ context: "acme", input: {} }]));
  verifies = [passed(), failed("already broken", "thing:list"), failed("already broken", "thing:list")];
  const r = file();
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    { agents: { planner: planning(), builder: building(), checker: approve } },
  );
  expect(verified).toEqual(["thing:find", "thing:list", "thing:list"]);
  expect(run.value.state).toBe("done");
});

test("a retry's redo flag is cleared once a stage starts again", async () => {
  const r = file();
  requests.update(r.id, () => ({ state: "building", redo: true }));
  await testWorkflow(defineBuild(deps()), { id: r.id, home }, { agents: { planner: planning(), builder: building(), checker: approve } });
  expect(requests.get(r.id)!.redo).toBeUndefined();
});

test("a conflicting rebase goes to the builder", async () => {
  git.conflicts = 1;
  const r = file();
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    { recorded: recordedUpTo("check"), agents: { builder: done("resolved") } },
  );
  expect(run.turnsOf("builder")[0]!.prompt).toContain("x/helpers/index.ts");
  expect(run.value.state).toBe("done");
});

test("a rebase the builder left unfinished stops the merge", async () => {
  git.conflicts = 1;
  git.rebasing = true;
  const r = file();
  const run = await testWorkflow(
    defineBuild(deps()),
    { id: r.id, home },
    { recorded: recordedUpTo("check"), agents: { builder: done("resolved") } },
  );
  expect(run.stopped).toMatchObject({ stage: "merge", reason: "the rebase on main was left unfinished" });
});

test("a fast-forward that loses a race rebases once more", async () => {
  git.ffFailures = 1;
  const r = file();
  const run = await testWorkflow(defineBuild(deps()), { id: r.id, home }, { recorded: recordedUpTo("check"), agents: {} });
  expect(git.calls.filter((c) => c === "rebase")).toHaveLength(2);
  expect(run.value.state).toBe("done");
});

// ── repair ────────────────────────────────────────────────────────────────────────────────────────

const repairOf = () => file({ kind: "repair", op: "thing:list", failure: { step: "fill name", error: "Timeout", bundle: "/b/1" } });

test("a repair that reproduces is patched, checked and merged", async () => {
  const r = repairOf();
  const run = await testWorkflow(
    defineRepair(deps()),
    { id: r.id, home },
    {
      agents: {
        builder: [answer(DIAGNOSIS, { kind: "reproduced", diagnosis: "the Name label is now Title" }), done("relabelled")],
        checker: approve,
      },
    },
  );
  const [diagnose, patch] = run.turnsOf("builder");
  expect(diagnose!.prompt).toContain("/b/1");
  expect(diagnose!.prompt).toContain("on the failed input where that changes nothing in the app (a read)");
  expect(patch!.prompt).toContain("goes through the step that failed");
  expect(run.value).toEqual({ state: "done", summary: "repaired thing:list (0 revision(s)): the Name label is now Title" });
  expect(git.calls).toContain(`squash ${r.id} repair thing:list`);
});

test("a request's socket directory is its CLI home's: a test's R-0001 never removes a real one's", () => {
  const r = file();
  const elsewhere = { ...r, domain: { ...r.domain, home: join(home, "other") } };
  expect(sandboxPaths(elsewhere).sockets).not.toBe(sandboxPaths(r).sockets);
});

test("a sandboxed repair's agents read the op's failure bundles, those that join later included", () => {
  const r = repairOf();
  const paths = sandboxPaths(r);
  expect(sandboxSpec(r, "/wt", paths).read).toContain(join(home, "failures", "thing-list"));
  expect(sandboxSpec(file(), "/wt", paths).read!.filter((path) => path.startsWith(join(home, "failures")))).toEqual([]);
});

test("a repair of a direct way is diagnosed from its calls, not a screenshot", async () => {
  const r = file({
    kind: "repair",
    op: "thing:list",
    failure: { step: "search", error: "the direct way failed", bundle: "/b/2", fellBack: true },
  });
  const run = await testWorkflow(
    defineRepair(deps()),
    { id: r.id, home },
    { agents: { builder: answer(DIAGNOSIS, { kind: "flaky", reason: "worked 5 of 5" }) } },
  );
  expect(run.turnsOf("builder")[0]!.prompt).toContain("without `--browser`");
});

test("a repair that can't be reproduced ends failed as flaky, freeing the op", async () => {
  const r = repairOf();
  const run = await testWorkflow(
    defineRepair(deps()),
    { id: r.id, home },
    { agents: { builder: answer(DIAGNOSIS, { kind: "flaky", reason: "worked 5 of 5" }) } },
  );
  expect(run.value.state).toBe("failed");
  expect(requests.get(r.id)!.reason).toContain("flaky");
  expect(requests.brokenBy("thing:list")).toBeUndefined();
  expect(requests.lockOp("thing:list", "R-9999")).toBeUndefined();
  expect(git.calls.at(-1)).toStartWith("remove");
});

test("a repair waits for another request holding its op", async () => {
  const holder = file({ op: "thing:list" });
  requests.update(holder.id, () => ({ state: "building" }));
  requests.lockOp("thing:list", holder.id);
  const r = repairOf();
  const run = await testWorkflow(defineRepair(deps()), { id: r.id, home }, { agents: {} });
  expect(run.turns).toHaveLength(0);
  expect(requests.get(r.id)).toMatchObject({ state: "received", waitingFor: holder.id });
});
