import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Type from "typebox";
import { awfArgs, describeRun, earlierSpans, formatCost, runUsage } from "../core/awf";
import { launch, openSignedIn, readSignIn, signedInContext } from "../core/browser";
import { callOf, parseArgs } from "../core/cli";
import { Contexts } from "../core/contexts";
import type { Domain } from "../core/domain";
import { envName, envOverride } from "../core/env";
import { InputError, OpError } from "../core/errors";
import { callArgv, loadOps, type OpEntry, opHelp, parseInput, runOp } from "../core/ops";
import { EXIT, formatDuration, progress, progressInto } from "../core/output";
import { browserBinary, startPlain } from "../core/plain-browser";
import { flakyReason, Requests } from "../core/requests";
import { codeStamp, opsSession, pageCommandsOf } from "../core/session";
import { formatSnapshot, type SnapshotNode, suggestLocator, takeSnapshot } from "../core/snapshot";
import { lineText, requestLines } from "../core/watch";
import { DEFAULTS, loadConfig } from "../core/workflows/config";
import { renderPrompts } from "../core/workflows/prompts-doc";
import { cli, tempHome } from "./helpers";

describe("envOverride", () => {
  const name = envName("KEEP_ALIVE_SIGN_IN_MS");
  afterEach(() => delete process.env[name]);
  test("changes a setting the domain makes, never turns on one it leaves unset, and 0 or not a number turns it off", () => {
    expect(envOverride("KEEP_ALIVE_SIGN_IN_MS", 60_000)).toBe(60_000);
    process.env[name] = "5000";
    expect(envOverride("KEEP_ALIVE_SIGN_IN_MS", 60_000)).toBe(5000);
    expect(envOverride("KEEP_ALIVE_SIGN_IN_MS", undefined)).toBeUndefined();
    process.env[name] = "0";
    expect(envOverride("KEEP_ALIVE_SIGN_IN_MS", 60_000)).toBeUndefined();
    process.env[name] = "soon";
    expect(envOverride("KEEP_ALIVE_SIGN_IN_MS", 60_000)).toBeUndefined();
  });
});

describe("parseArgs", () => {
  test("splits global flags from the op's, and booleans from values", () => {
    const parsed = parseArgs(
      ["--first", "Ada", "--json", "--context", "acme", "--tag", "a", "--tag", "b", "--primary", "--dry-run"],
      new Set(["primary"]),
    );
    expect(parsed.global).toEqual({ json: true, context: "acme", "dry-run": true });
    expect(parsed.flags).toEqual({ first: "Ada", tag: ["a", "b"], primary: true });
  });

  test("-h is --help", () => {
    expect(parseArgs(["request", "-h"])).toMatchObject({ positionals: ["request"], global: { help: true } });
  });

  test("--key=value, and a flag before another flag is true", () => {
    expect(parseArgs(["--a=1", "--b", "--c", "x", "pos"]).flags).toEqual({ a: "1", b: true, c: "x" });
    expect(parseArgs(["R-0001", "--wait"]).positionals).toEqual(["R-0001"]);
  });

  test("--timeout without a number is bad input, not one second", async () => {
    const t = tempHome();
    try {
      await cli(t.home, ["context:add", "acme", "--url", "https://example.com"]);
      const bare = await cli(t.home, ["request", "the replies under a post", "--wait", "--timeout"]);
      expect(bare.code).toBe(2);
      expect(bare.stderr).toContain("--timeout needs a number of seconds");
    } finally {
      t.cleanup();
    }
  });

  test("no whole number of runs at once is bad input to the call that would start the worker, before it acts, and to the worker", async () => {
    const t = tempHome();
    try {
      await cli(t.home, ["context:add", "acme", "--url", "https://example.com"]);
      for (const runs of ["0", "-1", "two", "1.5"]) {
        const filing = await cli(t.home, ["request", "the replies under a post"], { [envName("MAX_RUNNING")]: runs });
        expect(filing.code).toBe(2);
        expect(filing.stderr).toContain("must be a whole number, 1 or more");
      }
      // Refused before it acted: nothing was filed.
      expect((await cli(t.home, ["requests", "--json"])).json!.data).toEqual([]);
      const worker = await cli(t.home, ["request:worker"], { [envName("MAX_RUNNING")]: "0" });
      expect(worker.code).toBe(2);
      expect(worker.stderr).toContain("must be a whole number, 1 or more");
    } finally {
      t.cleanup();
    }
  });
});

const entry = (): OpEntry => ({
  name: "thing:find",
  dir: "/nowhere",
  definition: {
    name: "thing:find",
    description: "Find things of a kind",
    input: Type.Object({
      query: Type.String({ description: "what to look for" }),
      kind: Type.Union([Type.Literal("a"), Type.Literal("b")]),
      pageSize: Type.Optional(Type.Number()),
      exact: Type.Optional(Type.Boolean()),
    }),
    output: Type.Object({ id: Type.String() }),
    run: async () => ({ id: "x" }),
  },
});

describe("op input", () => {
  test("flags are converted by the schema", () => {
    expect(parseInput("x", entry(), { query: "Q-1", kind: "b", "page-size": "3", exact: true })).toEqual({
      query: "Q-1",
      kind: "b",
      pageSize: 3,
      exact: true,
    });
  });

  test("bad input lists the valid values and every missing flag", () => {
    const error = (() => {
      try {
        parseInput("x", entry(), { kind: "c" });
      } catch (err) {
        return err as InputError;
      }
    })();
    expect(error).toBeInstanceOf(InputError);
    expect(error!.message).toBe('--query is required; --kind "c" is not one of: a, b');
    expect(error!.exitCode).toBe(2);
  });

  test("an unknown flag names the ones there are", () => {
    expect(() => parseInput("x", entry(), { kin: "b" })).toThrow(
      "thing:find has no flag --kin (flags: --query, --kind, --page-size, --exact)",
    );
  });

  test("help comes from the spec", () => {
    const help = opHelp("x", entry());
    expect(help).toContain("--kind a|b");
    expect(help).toContain("--query <string>  what to look for");
    expect(help).toContain("--page-size <number> (optional)");
    expect(help).toContain("--dry-run");
    // A domain whose ops only read has no submit to stop before.
    expect(opHelp("x", entry(), { readOnly: true })).not.toContain("--dry-run");
  });

  test("a call round-trips to the argv that reruns it", () => {
    expect(callArgv("thing:find", { query: "A 1", exact: true, pageSize: 2, skip: false })).toEqual([
      "thing:find",
      "--query",
      "A 1",
      "--exact",
      "--page-size",
      "2",
    ]);
  });
});

describe("the call a request keeps", () => {
  test("steering flags go, task flags and --dry-run stay", () => {
    expect(
      callOf(
        "x:y",
        ["--a", "1", "--json", "--context", "acme", "--request", "do it", "--flag", "--dry-run", "--wait", "--timeout=5", "--", "--b"],
        new Set(["flag"]),
      ),
    ).toEqual(["x:y", "--a", "1", "--flag", "--dry-run", "--", "--b"]);
  });

  test("--state and --session are a command's own flags, so an op can take them too", () => {
    expect(parseArgs(["--state", "building", "--session", "s"]).flags).toEqual({ state: "building", session: "s" });
  });
});

describe("contexts", () => {
  let t: ReturnType<typeof tempHome>;
  beforeEach(() => (t = tempHome()));
  afterEach(() => t.cleanup());

  test("the first context added is current; names and URLs are checked", () => {
    const contexts = new Contexts(t.home, "x");
    contexts.add("acme", "https://x.com/acme/");
    contexts.add("beta", "https://x.com/beta");
    expect(contexts.resolve(undefined).name).toBe("acme");
    expect(contexts.resolve(undefined).url).toBe("https://x.com/acme");
    expect(contexts.use("beta").name).toBe("beta");
    expect(() => contexts.add("Bad Name", "https://x")).toThrow(OpError);
    expect(() => contexts.add("ok", "not a url")).toThrow(OpError);
    expect(() => contexts.resolve("nope")).toThrow('no context "nope" (contexts: acme, beta)');
  });

  test("no context at all is a precondition", () => {
    try {
      new Contexts(t.home, "x").resolve(undefined);
    } catch (err) {
      expect((err as OpError).exitCode).toBe(3);
      return;
    }
    throw new Error("expected a failure");
  });
});

describe("workflows.json", () => {
  let t: ReturnType<typeof tempHome>;
  beforeEach(() => (t = tempHome()));
  afterEach(() => t.cleanup());
  const write = (config: unknown) => writeFileSync(join(t.home, "workflows.json"), JSON.stringify(config));

  test("missing, it is the defaults: unsandboxed, the usual models", () => {
    expect(loadConfig(t.home)).toEqual(DEFAULTS);
  });

  test("the checkout's names only what differs from the defaults, so they are named in one place", () => {
    const raw = JSON.parse(readFileSync(join(import.meta.dir, "..", "workflows.json"), "utf8"));
    for (const [role, runtime] of Object.entries(raw.agents ?? {})) {
      expect(runtime).not.toEqual(DEFAULTS.agents[role as keyof typeof DEFAULTS.agents]);
    }
  });

  test("an agent it names replaces that default whole; the rest stay", () => {
    write({ sandbox: true, agents: { checker: "cheap", builder: { harness: "pi", model: "m" } } });
    expect(loadConfig(t.home)).toEqual({
      sandbox: {},
      agents: {
        planner: DEFAULTS.agents.planner,
        builder: { harness: "pi", model: "m" },
        checker: "cheap",
        troubleshooter: DEFAULTS.agents.troubleshooter,
      },
    });
  });

  test("sandbox can name more for the agents to reach", () => {
    write({ sandbox: { network: ["docs.playwright.dev"], read: ["../shared"] } });
    expect(loadConfig(t.home).sandbox).toEqual({ network: ["docs.playwright.dev"], read: ["../shared"] });
  });

  test.each([
    [{ sandbox: "yes" }, "sandbox must be true, false or"],
    [{ sandbox: { net: [] } }, 'unknown sandbox field "net"'],
    [{ sandbox: { network: "docs.playwright.dev" } }, "sandbox.network must be a list of strings"],
    [{ sandbox: { write: ["core"] } }, 'sandbox.write "core" reaches the checkout'],
    [{ sandbox: { write: [".."] } }, 'sandbox.write ".." reaches the checkout'],
    [{ sandbx: true }, 'unknown field "sandbx"'],
    [{ agents: { reviewer: { harness: "codex" } } }, 'unknown agent "reviewer"'],
    [{ agents: { builder: { model: "m" } } }, "agents.builder needs a harness or an alias"],
  ])("%j is refused, naming what's wrong", (config, error) => {
    write(config);
    expect(() => loadConfig(t.home)).toThrow(error);
  });
});

describe("request ledger", () => {
  let t: ReturnType<typeof tempHome>;
  let requests: Requests;
  const domain = () => ({ name: "x", root: "/r", dir: "/r/x", home: t.home });
  beforeEach(() => {
    t = tempHome();
    requests = new Requests(t.home);
  });
  afterEach(() => t.cleanup());

  test("ids count up, and every change is a ledger event", () => {
    const a = requests.file({ kind: "intake", text: "find things", context: "acme", domain: domain() });
    const b = requests.file({ kind: "new", op: "thing:find", text: "find things", context: "acme", domain: domain() });
    expect([a.id, b.id]).toEqual(["R-0001", "R-0002"]);
    requests.update(a.id, () => ({ state: "building", stage: "spec" }));
    expect(requests.ledger(a.id).map((e) => e.event)).toEqual(["received", "building"]);
    expect(requests.list().map((r) => r.id)).toEqual(["R-0002", "R-0001"]);
    expect(requests.list({ state: "building" }).map((r) => r.id)).toEqual(["R-0001"]);
  });

  test("only a blocked request takes an answer, and only failed, deferred or cancelled ones are retried", () => {
    const r = requests.file({ kind: "intake", text: "x", context: "acme", domain: domain() });
    expect(() => requests.answer(r.id, "yes")).toThrow("not blocked");
    requests.update(r.id, () => ({ state: "blocked", question: "which?" }));
    expect(requests.answer(r.id, "this one")).toMatchObject({
      state: "received",
      question: undefined,
      answers: [{ question: "which?", text: "this one" }],
    });
    expect(() => requests.retry(r.id)).toThrow("only failed, deferred and cancelled");
    requests.update(r.id, () => ({ state: "failed", reason: "boom" }));
    expect(requests.retry(r.id)).toMatchObject({ state: "received", reason: undefined });
  });

  test("signing in continues only the requests still blocked on signing in to that context", () => {
    const blocked = (context: string, question: string) => {
      const r = requests.file({ kind: "intake", text: "x", context, domain: domain() });
      requests.update(r.id, () => ({ state: "blocked", question }));
      return r.id;
    };
    const a = blocked("acme", "sign in again: x context:login acme");
    const other = blocked("other", "sign in again: x context:login other");
    const asked = blocked("acme", "which?");
    expect(requests.signedIn("acme")).toEqual([a]);
    // Signed in twice (a person and the worker at once): the second finds nothing left to continue.
    expect(requests.signedIn("acme")).toEqual([]);
    expect([requests.get(other)!.state, requests.get(asked)!.state]).toEqual(["blocked", "blocked"]);
  });

  test("a cancelled request keeps nothing its stopping run records, and a retry starts it over", () => {
    const r = requests.file({ kind: "new", op: "x:y", text: "x", context: "acme", domain: domain() });
    requests.update(r.id, () => ({ state: "building", stage: "explore" }));
    expect(requests.cancel(r.id, "not needed")).toMatchObject({ state: "cancelled", reason: "not needed" });
    requests.update(r.id, () => ({ state: "failed", reason: "aborted" }));
    expect(requests.get(r.id)).toMatchObject({ state: "cancelled", reason: "not needed" });
    expect(() => requests.cancel(r.id, "again")).toThrow("is cancelled already");
    expect(requests.retry(r.id)).toMatchObject({ state: "received", redo: true });
  });

  test("an op's lock is held by one open request", () => {
    const a = requests.file({ kind: "new", op: "x:y", text: "a", context: "acme", domain: domain() });
    const b = requests.file({ kind: "new", op: "x:y", text: "b", context: "acme", domain: domain() });
    expect(requests.lockOp("x:y", a.id)).toBeUndefined();
    expect(requests.lockOp("x:y", b.id)).toBe(a.id);
    // A lock whose holder ended is free, even if it was never released.
    requests.update(a.id, () => ({ state: "failed" }));
    expect(requests.lockOp("x:y", b.id)).toBeUndefined();
  });

  test("a repair is open per op and step; a failed one marks the op broken", () => {
    const failure = { step: "read rows", error: "Timeout", bundle: "/b" };
    const repair = (f: { step: string; error: string; bundle: string }) =>
      requests.fileOrJoinRepair({ kind: "repair", op: "x:y", text: "x:y failed", context: "acme", domain: domain(), failure: f });
    const r = repair(failure).record;
    expect(repair({ ...failure, bundle: "/b2" })).toMatchObject({ joined: true, record: { id: r.id, joined: [{ bundle: "/b2" }] } });
    expect(requests.brokenBy("x:y")).toBeUndefined();
    requests.update(r.id, () => ({ state: "failed", reason: "the builder's rounds ran out" }));
    expect(requests.brokenBy("x:y")?.id).toBe(r.id);
    requests.retry(r.id);
    expect(requests.brokenBy("x:y")).toBeUndefined();
    // One that couldn't reproduce the failure found the op working.
    requests.update(r.id, () => ({ state: "failed", reason: flakyReason("could not reproduce (works every time)") }));
    expect(requests.brokenBy("x:y")).toBeUndefined();
    // A change done on the op after its repair failed may have fixed it.
    requests.update(r.id, () => ({ state: "failed", reason: "the builder's rounds ran out" }));
    expect(requests.brokenBy("x:y")?.id).toBe(r.id);
    const change = requests.file({ kind: "change", op: "x:y", text: "fix it", context: "acme", domain: domain() });
    requests.update(change.id, () => ({ state: "done" }));
    expect(requests.brokenBy("x:y")).toBeUndefined();
    expect(repair({ ...failure, step: "open page" })).toMatchObject({ joined: false });
  });

  test("a repair of the direct way and one of the browser way at the same step are two requests", () => {
    const repair = (fellBack: boolean) =>
      requests.fileOrJoinRepair({
        kind: "repair",
        op: "x:y",
        text: "x:y failed",
        context: "acme",
        domain: domain(),
        failure: { step: "read rows", error: "Timeout", bundle: "/b", ...(fellBack && { fellBack }) },
      });
    const browser = repair(false).record;
    const direct = repair(true);
    expect(direct.joined).toBe(false);
    expect(direct.record.id).not.toBe(browser.id);
    expect(repair(true)).toMatchObject({ joined: true, record: { id: direct.record.id } });
    expect(repair(false)).toMatchObject({ joined: true, record: { id: browser.id } });
  });

  test("a request's time and cost add up its attempts, the running one by time only", () => {
    const r = requests.file({ kind: "intake", text: "x", context: "acme", domain: domain() });
    const attempts = join(t.home, "runs", "op-build", r.id, "attempts");
    mkdirSync(attempts, { recursive: true });
    writeFileSync(join(attempts, "1.json"), JSON.stringify({ accounting: { wallMs: 60_000, totals: { estimate: 1.25 } } }));
    writeFileSync(join(attempts, "2.json"), JSON.stringify({ started: new Date(Date.now() - 120_000).toISOString(), ended: null }));
    const usage = runUsage(t.home, r.id)!;
    expect(usage).toMatchObject({ usd: 1.25, partial: true });
    expect(Math.round(usage.ms / 60_000)).toBe(3);
    expect(formatCost(usage)).toBe("$1.25+");
    expect(formatDuration(usage.ms)).toBe("3m");
    expect(formatDuration(3_900_000)).toBe("1h05m");
  });

  test("a run is a row per stage, the running one with its open turns: label, agent, and the agent's last step", () => {
    const now = Date.parse("2026-10-17T20:15:00Z");
    const view = {
      stages: [
        { stage: "write", state: "succeeded", started: "2026-10-17T19:44:00Z", ended: "2026-10-17T20:01:00Z" },
        { stage: "check", state: "running", started: "2026-10-17T20:01:00Z" },
      ],
      agents: [
        { key: "checker", state: "answered" },
        {
          key: "builder",
          state: "working",
          live: {
            lastActivity: {
              activity: { type: "tool", tool: "Bash", input: "S=/tmp/x; cd /w && bun run ci:sandbox" },
              at: "2026-10-17T20:11:00Z",
            },
          },
        },
      ],
    };
    const turns = [
      { kind: "operation-started", of: "turn", operationId: "a", agent: "checker", label: "review 1" },
      { kind: "turn", operationId: "a", agent: "checker", label: "review 1" },
      {
        kind: "operation-started",
        of: "turn",
        operationId: "b",
        agent: "builder",
        label: "revise 1",
        execution: { model: "claude-sonnet-5-5" },
      },
    ];
    const builder = { label: "revise 1", agent: "builder", model: "claude-sonnet-5-5" };
    const stages = describeRun(view, turns, now);
    expect(stages).toEqual([
      { stage: "write", state: "succeeded", time: "17m", turns: [] },
      { stage: "check", state: "running", time: "14m", turns: [{ ...builder, step: "Bash: bun run ci:sandbox (4m)" }] },
    ]);
    // On a terminal and in a log alike, a line each; a log prints one again only when its key changes.
    const lines = requestLines(requests.file({ kind: "intake", text: "a\nthread", context: "acme", domain: domain() }), stages);
    expect(lines.map(lineText)).toEqual([
      "R-0001 · received · intake: a thread",
      "  ✓ write  17m",
      "  ▸ check  14m · revise 1 · builder (claude-sonnet-5-5) · Bash: bun run ci:sandbox (4m)",
    ]);
    expect(lines.map((l) => l.key)).toEqual(["R-0001 received", "write succeeded", "check running · revise 1 · builder"]);
    // awf cuts a long argument, so a command can be nothing but its first assignment.
    view.agents[1]!.live!.lastActivity.activity.input = "S=/Users/roman/.awf/sandboxes/op-build/R-0012/…";
    expect(describeRun(view, turns, now)[1]!.turns).toEqual([{ ...builder, step: "Bash (4m)" }]);
    // A turn an earlier attempt left open is not working now.
    const stale = turns.map((t) => ({ ...t, attempt: 1 }));
    expect(describeRun(view, [...stale, { kind: "attempt-started", attempt: 2 }], now)[1]!.turns).toEqual([]);
    // Between turns, as while the checks run, the stage alone.
    expect(describeRun(view, turns.slice(0, 2), now)[1]!.turns).toEqual([]);
  });

  test("a stage's time is its attempts' together, those the latest reused included", () => {
    const now = Date.parse("2026-10-18T14:00:00Z");
    const attempts = [
      { attempt: 3, stages: [] },
      { attempt: 1, stages: [{ stage: "intake", source: "ran", spanMs: 1_000 }] },
      {
        attempt: 2,
        stages: [
          { stage: "intake", source: "ran", spanMs: 154_000 },
          { stage: "write", source: "ran", spanMs: 85_000 },
          { stage: "check", source: "ran", spanMs: 541_000 },
        ],
      },
    ];
    const at = "2026-10-18T13:44:28Z";
    const view = {
      stages: [
        { stage: "intake", state: "reused", started: at, ended: at },
        { stage: "write", state: "reused", started: at, ended: at },
        { stage: "check", state: "running", started: "2026-10-18T13:52:00Z" },
        { stage: "merge", state: "pending" },
      ],
    };
    const rows = describeRun(view, [], now, earlierSpans(attempts));
    expect(rows.map((r) => [r.stage, r.state, r.time])).toEqual([
      ["intake", "succeeded", "3m (1s + 3m)"],
      ["write", "succeeded", "1m"],
      ["check", "running", "17m (9m + 8m)"],
      ["merge", "pending", ""],
    ]);
  });

  test("a retry of a run that stopped continues from the stage that stopped", () => {
    const r = requests.file({ kind: "new", op: "x:y", text: "x", context: "acme", domain: domain() });
    mkdirSync(join(t.home, "runs", "op-build", r.id), { recursive: true });
    writeFileSync(join(t.home, "runs", "op-build", r.id, "output.json"), JSON.stringify({ outcome: "stopped" }));
    requests.update(r.id, () => ({ state: "failed", reason: "the run was killed" }));
    expect(awfArgs(t.home, "/root", requests.retry(r.id), "3h").slice(-2)).toEqual(["--continue", r.id]);
  });

  test("a request to be redone is, from its workflow's first stage, whatever stopped the attempt before", () => {
    const r = requests.file({ kind: "repair", op: "x:y", text: "x", context: "acme", domain: domain() });
    mkdirSync(join(t.home, "runs", "op-repair", r.id), { recursive: true });
    // An attempt stopped on a lock before reaching diagnose: its outcome is no longer "completed".
    writeFileSync(join(t.home, "runs", "op-repair", r.id, "output.json"), JSON.stringify({ outcome: "stopped" }));
    expect(awfArgs(t.home, "/root", { ...r, redo: true }, "3h").slice(-4)).toEqual(["--continue", r.id, "--from-stage", "diagnose"]);
  });

  test("the worker continues a run that has a record, and starts one that doesn't", () => {
    const r = requests.file({ kind: "repair", op: "x:y", text: "x", context: "acme", domain: domain() });
    expect(awfArgs(t.home, "/root", r, "3h")).toEqual([
      "run",
      "/root/core/workflows/repair.ts",
      "--run-root",
      `${t.home}/runs`,
      "--timeout",
      "3h",
      "--no-watch",
      "--id",
      r.id,
      "--",
      r.id,
    ]);
  });
});

describe("snapshot", () => {
  test("controls get refs, labels and test ids; a diff marks what is new", async () => {
    const browser = await launch(false);
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <h1>Sign up</h1>
        <form><label for="f">Name</label><input id="f" data-testid="textInputBox" value="Ada">
        <label for="l">Email</label><input id="l" data-testid="textInputBox">
        <button type="button" data-testid="okButton" onclick="document.body.insertAdjacentHTML('beforeend','<div role=alert>Saved</div>')">OK</button>
        <span aria-hidden="true"><button>Hidden</button></span></form>
        <article role="article" tabindex="0" data-testid="tweet"><a href="/ada">Ada</a> posted</article>`);
      const before = await takeSnapshot(page);
      expect(formatSnapshot(before).split("\n").slice(2)).toEqual([
        '- heading "Sign up"',
        "- form",
        '  - textbox "Name" [e1] = "Ada" {textInputBox}',
        '  - textbox "Email" [e2] = "" {textInputBox}',
        '  - button "OK" [e3] {okButton}',
        // A control only by taking focus, it shows what is in it.
        '- article "Ada posted" [e4] {tweet}',
        '  - link "Ada" [e5]',
      ]);
      expect(suggestLocator(before.nodes[2]!)).toBe(`page.getByLabel("Name", { exact: true })`);
      expect(suggestLocator(before.nodes[4]!)).toBe(`page.getByTestId("okButton")`);
      await page.locator('[data-ref="e3"]').click();
      const after = await takeSnapshot(page);
      const diff = formatSnapshot(after, before);
      expect(diff).toContain("changed: 1 new, 0 gone");
      expect(diff).toContain('+ - alert "Saved"');
      // Refs stay put across snapshots of one page.
      expect(after.nodes.find((n) => n.name === "OK")?.ref).toBe("e3");
    } finally {
      await browser.close();
    }
  });

  test("the suggested locator finds its element alone: a post that shares its test id, an alert by its label, a name cut short", async () => {
    const browser = await launch(false);
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <article role="article" tabindex="0" data-testid="tweet"><div>Ada</div><div>posted</div></article>
        <article role="article" tabindex="0" data-testid="tweet"><div>Bob</div><div>replied</div></article>
        <div role="alert" aria-label="Timeline"><div>Bob</div></div>
        <button>${"a long name ".repeat(10)}</button>`);
      const { nodes } = await takeSnapshot(page);
      const find = (n: SnapshotNode) => new Function("page", `return ${suggestLocator(n)}.count()`)(page) as Promise<number>;
      const post = nodes.find((n) => n.role === "article" && n.name === "Ada posted")!;
      // An article isn't named by its text, so getByRole with it would match nothing; and Playwright
      // reads its text with the blocks joined, not spaced as the snapshot shows it.
      expect(suggestLocator(post)).toBe(`page.getByTestId("tweet").filter({ hasText: "Adaposted" })`);
      expect(await find(post)).toBe(1);
      const alert = nodes.find((n) => n.role === "alert")!;
      expect(suggestLocator(alert)).toBe(`page.getByLabel("Timeline", { exact: true })`);
      expect(await find(alert)).toBe(1);
      const button = nodes.find((n) => n.role === "button")!;
      expect(button.name.endsWith("…")).toBe(true);
      expect(suggestLocator(button)).not.toContain("exact");
      expect(await find(button)).toBe(1);
    } finally {
      await browser.close();
    }
  });

  test("a control or region without text, named by aria-labelledby or a title, is found without matching that name as text", async () => {
    const browser = await launch(false);
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <span id="h">Saved notice</span>
        <div role="alert" aria-labelledby="h" style="width:10px;height:10px"></div>
        <div tabindex="0" data-testid="avatar" title="Ada" style="width:10px;height:10px"></div>
        <div tabindex="0" data-testid="avatar" style="width:10px;height:10px">Bob</div>`);
      const { nodes } = await takeSnapshot(page);
      const find = (n: SnapshotNode) => new Function("page", `return ${suggestLocator(n)}.count()`)(page) as Promise<number>;
      const alert = nodes.find((n) => n.role === "alert")!;
      expect(alert.name).toBe("Saved notice");
      expect(suggestLocator(alert)).toBe(`page.getByLabel("Saved notice", { exact: true })`);
      expect(await find(alert)).toBe(1);
      // The test id is both avatars', and a filter by a title it doesn't show as text would match neither.
      const avatar = nodes.find((n) => n.name === "Ada")!;
      expect(suggestLocator(avatar)).toBe(`page.getByTestId("avatar")`);
      expect(await find(avatar)).toBe(2);
    } finally {
      await browser.close();
    }
  });
});

test("docs/prompts.md is what prompts.ts writes now: `bun run docs:prompts` updates it", async () => {
  const root = join(import.meta.dir, "..");
  // The CLI's name and domain folder, from the one place that names them: the docs:prompts script.
  const script: string = (await Bun.file(join(root, "package.json")).json()).scripts["docs:prompts"];
  const [cli, folder] = script.split(" ").slice(2);
  expect(await Bun.file(join(root, "docs/prompts.md")).text()).toBe(renderPrompts(cli!, folder!, loadConfig(root)));
});

test("a kept browser's daemon is one per checkout and context, and knows when its code changed", () => {
  const t = tempHome();
  try {
    const dir = join(t.home, "t");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "op.ts"), "");
    const domain = { name: "t", dir, root: t.home, home: t.home, helpers: () => ({}), signInState: async () => "signed-in" as const };
    const before = codeStamp(domain);
    writeFileSync(join(dir, "helper.ts"), "");
    expect(codeStamp(domain)).not.toBe(before);
    expect(opsSession("/a", "me")).not.toBe(opsSession("/b", "me"));
    expect(opsSession("/a", "me")).toMatch(/^ops-me-[0-9a-f]{8}$/);
  } finally {
    t.cleanup();
  }
});

test("progress goes back to the caller while a daemon runs its call", () => {
  const lines: string[] = [];
  progressInto((line) => lines.push(line));
  try {
    progress("› read posts");
  } finally {
    progressInto(undefined);
  }
  expect(lines).toEqual(["› read posts"]);
});

test("a domain whose ops make no calls of their own has no page:fetch to make one with", () => {
  const domain = { name: "t", dir: "/t/t", root: "/t", home: "/t", helpers: () => ({}), signInState: async () => "signed-in" as const };
  expect(Object.keys(pageCommandsOf(domain))).toContain("page:fetch");
  expect(Object.keys(pageCommandsOf({ ...domain, directCalls: false }))).not.toContain("page:fetch");
});

describe("running an op", () => {
  let t: ReturnType<typeof tempHome>;
  let server: ReturnType<typeof Bun.serve>;
  beforeEach(() => {
    t = tempHome();
    // A message that goes away: the bundle must show it as the op left the page.
    const html = `<h1>Home</h1><script>setTimeout(() => document.body.insertAdjacentHTML("beforeend", "<div role=alert>Something broke</div>"), 50); setTimeout(() => document.querySelector("[role=alert]")?.remove(), 1500)</script>`;
    server = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { "content-type": "text/html" } }) });
  });
  afterEach(() => {
    server.stop(true);
    t.cleanup();
  });

  const setUp = () => {
    const domain: Domain = {
      name: "t",
      dir: join(t.home, "t"),
      root: t.home,
      home: t.home,
      helpers: () => ({}),
      signInState: async (page) => ((await page.getByRole("heading").count()) ? "signed-in" : "unknown"),
    };
    const contexts = new Contexts(t.home, "t");
    const ctx = contexts.add("acme", server.url.href);
    mkdirSync(dirname(ctx.authFile), { recursive: true });
    writeFileSync(ctx.authFile, JSON.stringify({ cookies: [], origins: [] }));
    return { domain, contexts, requests: new Requests(t.home) };
  };

  const run = async (body: () => unknown, format?: (output: never) => string) => {
    const { domain, contexts, requests } = setUp();
    const op: OpEntry = {
      ...entry(),
      dir: join(t.home, "op"),
      definition: {
        ...entry().definition,
        run: async ({ page }) => {
          await page.getByRole("alert").waitFor();
          return body();
        },
        ...(format && { format }),
      },
    };
    const outcome = await runOp({ domain, contexts, requests, fileRepairs: true }, op, { query: "q", kind: "a" }, contexts.get("acme"));
    return { outcome, repairs: requests.list() };
  };

  test("an op's format is its text; its data stays the output", async () => {
    const { outcome } = await run(
      () => ({ id: "7" }),
      (o: { id: string }) => `thing ${o.id}`,
    );
    expect(outcome).toMatchObject({ ok: true, data: { id: "7" }, text: "thing 7" });
  });

  test("the op's fault files a repair whose bundle has the page as the op left it", async () => {
    const { outcome, repairs } = await run(() => {
      throw new Error("no results list");
    });
    expect(outcome.exitCode).toBe(EXIT.PENDING);
    const bundle = repairs[0]!.failure!.bundle;
    expect(existsSync(join(bundle, "screenshot.png"))).toBe(true);
    expect(readFileSync(join(bundle, "snapshot.txt"), "utf8")).toContain('alert "Something broke"');
  });

  test("a kept browser runs one call after another on its page, and stays open", async () => {
    const { domain, contexts, requests } = setUp();
    const open = await openSignedIn(domain, contexts, contexts.get("acme"));
    const op: OpEntry = {
      ...entry(),
      dir: join(t.home, "op"),
      definition: {
        ...entry().definition,
        run: async ({ page }) => ({
          id: String(
            await page.evaluate(() => ((window as unknown as { n: number }).n = ((window as unknown as { n?: number }).n ?? 0) + 1)),
          ),
        }),
      },
    };
    const call = () =>
      runOp({ domain, contexts, requests, fileRepairs: true }, op, { query: "q", kind: "a" }, contexts.get("acme"), { kept: open });
    expect((await call()).data).toEqual({ id: "1" });
    expect((await call()).data).toEqual({ id: "2" });
    expect(open.page.isClosed()).toBe(false);
    await open.close();
  });

  test("an error the op raises on purpose files nothing", async () => {
    const { outcome, repairs } = await run(() => {
      throw new OpError("no such account", EXIT.PRECONDITION);
    });
    expect(outcome).toMatchObject({ ok: false, exitCode: EXIT.PRECONDITION });
    expect(repairs).toEqual([]);
    expect(existsSync(join(t.home, "failures"))).toBe(false);
  });
});

describe("opening the app", () => {
  let t: ReturnType<typeof tempHome>;
  beforeEach(() => {
    t = tempHome();
    process.env[envName("SIGNIN_WAIT_MS")] = "300";
  });
  afterEach(() => {
    delete process.env[envName("SIGNIN_WAIT_MS")];
    t.cleanup();
  });

  /** An op's call on an app whose page never shows itself or a sign-in, and that names `refused` as why. */
  const open = async (refused?: string) => {
    const domain: Domain = {
      name: "t",
      dir: join(t.home, "t"),
      root: t.home,
      home: t.home,
      helpers: () => ({}),
      signInState: async () => "unknown",
      // A blank page at the app's URL, with no server behind it.
      prepareBrowser: async (context) => {
        await context.route("http://app.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<p></p>" }));
      },
      refusal: async () => refused,
    };
    const contexts = new Contexts(t.home, "t");
    const ctx = contexts.add("acme", "http://app.test/");
    mkdirSync(dirname(ctx.authFile), { recursive: true });
    writeFileSync(ctx.authFile, JSON.stringify({ cookies: [], origins: [] }));
    const requests = new Requests(t.home);
    const outcome = await runOp(
      { domain, contexts, requests, fileRepairs: true },
      entry(),
      { query: "q", kind: "a" },
      contexts.get("acme"),
    );
    return { outcome, repairs: requests.list() };
  };

  test("a page that never shows the app, where the app names a refusal (a rate limit), is refused, not a precondition", async () => {
    const { outcome, repairs } = await open("rate limited (Viewer, status 429)");
    expect(outcome).toMatchObject({ ok: false, exitCode: EXIT.REFUSED, error: "t refused it: rate limited (Viewer, status 429)" });
    expect(repairs).toEqual([]);
    // Naming none, it is a page that showed neither the app nor a sign-in.
    expect((await open()).outcome).toMatchObject({
      ok: false,
      exitCode: EXIT.PRECONDITION,
      error: expect.stringContaining("showed neither"),
    });
  });
});

describe("signing in by hand", () => {
  let t: ReturnType<typeof tempHome>;
  let server: ReturnType<typeof Bun.serve>;
  const page = (body: string, headers: Record<string, string> = {}) =>
    new Response(body, { headers: { "content-type": "text/html", ...headers } });
  beforeEach(() => {
    t = tempHome();
    // The person: the start page goes to the sign-in form, which signs in and lands on the home page.
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === "/login") return page(`<p>password</p><script>setTimeout(() => location.href = "/home", 4000)</script>`);
        if (pathname === "/home") return page("<h1>Home</h1>", { "set-cookie": "sid=signed-in; Path=/" });
        return page(`<p>welcome</p><script>setTimeout(() => location.href = "/login", 300)</script>`);
      },
    });
  });
  afterEach(() => {
    server.stop(true);
    t.cleanup();
  });

  test("reads the sign-in from the profile of a browser nothing drove, once it is closed", async () => {
    const domain: Domain = {
      name: "t",
      dir: join(t.home, "t"),
      root: t.home,
      home: t.home,
      helpers: () => ({}),
      signInState: async (p) => ((await p.getByRole("heading").count()) ? "signed-in" : "signed-out"),
      appUrl: (signedInUrl) => signedInUrl,
    };
    const contexts = new Contexts(t.home, "t");
    const ctx = contexts.add("acme", new URL("/home", server.url).href);
    const profileDir = join(t.home, "browser");
    const binary = browserBinary(undefined);
    const plain = startPlain(binary, {
      profileDir,
      url: server.url.href,
      size: { width: 800, height: 600 },
      headless: true,
    });
    // The person signs in, then is done.
    await Bun.sleep(7000);
    await plain.close();
    await readSignIn(domain, contexts, ctx, { profileDir, binary });
    expect(JSON.parse(readFileSync(ctx.authFile, "utf8")).cookies).toContainEqual(
      expect.objectContaining({ name: "sid", value: "signed-in" }),
    );
    expect(contexts.get("acme").signedInAt).toBeDefined();
  }, 45_000);

  test("a window closed before signing in says so", async () => {
    const domain: Domain = {
      name: "t",
      dir: join(t.home, "t"),
      root: t.home,
      home: t.home,
      helpers: () => ({}),
      signInState: async () => "signed-out",
    };
    const contexts = new Contexts(t.home, "t");
    const ctx = contexts.add("acme", server.url.href);
    await expect(
      readSignIn(domain, contexts, ctx, { profileDir: join(t.home, "browser"), binary: browserBinary(undefined) }),
    ).rejects.toThrow("closed before signing in");
  }, 45_000);
});

test("a domain that hides automation runs a browser that doesn't say it is automated or headless", async () => {
  const t = tempHome();
  const name = envName("HIDE_AUTOMATION");
  process.env[name] = "1";
  const browser = await launch(false);
  try {
    const contexts = new Contexts(t.home, "t");
    const ctx = contexts.add("acme", "https://example.com");
    mkdirSync(dirname(ctx.authFile), { recursive: true });
    writeFileSync(ctx.authFile, JSON.stringify({ cookies: [], origins: [] }));
    const domain: Domain = {
      name: "t",
      dir: "/t/t",
      root: "/t",
      home: t.home,
      helpers: () => ({}),
      signInState: async () => "signed-in",
      hideAutomation: true,
    };
    const p = await (await signedInContext(browser, domain, ctx)).newPage();
    expect(await p.evaluate(() => navigator.webdriver)).toBe(false);
    expect(await p.evaluate(() => navigator.userAgent)).not.toContain("Headless");
  } finally {
    delete process.env[name];
    await browser.close();
    t.cleanup();
  }
});

describe("loading ops", () => {
  test("an op that does not build says where", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "x-ops-")));
    try {
      mkdirSync(join(dir, "ops", "thing-find"), { recursive: true });
      writeFileSync(join(dir, "ops", "thing-find", "op.ts"), "export const a = 1;\nexport const a = 2;\n");
      const { broken } = await loadOps({ dir } as Domain);
      expect(broken[0]!.error).toBe(`"a" has already been declared at ${join(dir, "ops", "thing-find", "op.ts")}:2:14`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a domain without direct calls refuses an op that has a direct way", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "x-ops-")));
    try {
      mkdirSync(join(dir, "ops", "thing-find"), { recursive: true });
      writeFileSync(
        join(dir, "ops", "thing-find", "op.ts"),
        'export default { name: "thing:find", run: async () => ({}), direct: async () => ({}) };\n',
      );
      const { ops, broken } = await loadOps({ name: "x", dir, directCalls: false } as Domain);
      expect(ops.size).toBe(0);
      expect(broken[0]!.error).toBe("thing:find has a direct way, but x ops make no calls of their own (directCalls: false)");
      expect((await loadOps({ name: "x", dir } as Domain)).ops.size).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
