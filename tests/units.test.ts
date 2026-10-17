import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Type from "typebox";
import { launch } from "../core/browser";
import { callOf, parseArgs } from "../core/cli";
import { Contexts } from "../core/contexts";
import type { Domain } from "../core/domain";
import { InputError, OpError } from "../core/errors";
import { callArgv, loadOps, type OpEntry, opHelp, parseInput } from "../core/ops";
import { Requests } from "../core/requests";
import { formatSnapshot, suggestLocator, takeSnapshot } from "../core/snapshot";
import { awfArgs, describeRun, formatCost, formatDuration, RUN_TIMEOUT, runUsage } from "../core/worker";
import { DEFAULTS, loadConfig } from "../core/workflows/config";
import { renderPrompts } from "../core/workflows/prompts-doc";
import { accountOf, xDomain } from "../x/domain";
import { tempHome } from "./helpers";

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
});

const entry = (): OpEntry => ({
  name: "application:move",
  dir: "/nowhere",
  definition: {
    name: "application:move",
    description: "Move an application to a stage",
    input: Type.Object({
      application: Type.String({ description: "application id" }),
      stage: Type.Union([Type.Literal("Screen"), Type.Literal("Offer")]),
      count: Type.Optional(Type.Number()),
      notify: Type.Optional(Type.Boolean()),
      tenantStage: Type.Optional(Type.String()),
    }),
    output: Type.Object({ id: Type.String() }),
    run: async () => ({ id: "x" }),
  },
});

describe("op input", () => {
  test("flags are converted by the schema", () => {
    expect(parseInput("x", entry(), { application: "A-1", stage: "Offer", count: "3", notify: true, "tenant-stage": "Phone" })).toEqual({
      application: "A-1",
      stage: "Offer",
      count: 3,
      notify: true,
      tenantStage: "Phone",
    });
  });

  test("bad input lists the valid values and every missing flag", () => {
    const error = (() => {
      try {
        parseInput("x", entry(), { stage: "Interview" });
      } catch (err) {
        return err as InputError;
      }
    })();
    expect(error).toBeInstanceOf(InputError);
    expect(error!.message).toBe('--application is required; --stage "Interview" is not one of: Screen, Offer');
    expect(error!.exitCode).toBe(2);
  });

  test("an unknown flag names the ones there are", () => {
    expect(() => parseInput("x", entry(), { stag: "Offer" })).toThrow(
      "application:move has no flag --stag (flags: --application, --stage, --count, --notify, --tenant-stage)",
    );
  });

  test("help comes from the spec", () => {
    const help = opHelp("x", entry());
    expect(help).toContain("--stage Screen|Offer");
    expect(help).toContain("--application <string>  application id");
    expect(help).toContain("--count <number> (optional)");
  });

  test("a call round-trips to the argv that reruns it", () => {
    expect(callArgv("application:move", { application: "A 1", notify: true, count: 2, skip: false })).toEqual([
      "application:move",
      "--application",
      "A 1",
      "--notify",
      "--count",
      "2",
    ]);
  });
});

describe("the call a request keeps", () => {
  test("steering flags go, task flags and --dry-run stay", () => {
    expect(
      callOf(
        "x:y",
        ["--a", "1", "--json", "--context", "acme", "--request", "do it", "--flag", "--dry-run", "--wait", "--timeout=5"],
        new Set(["flag"]),
      ),
    ).toEqual(["x:y", "--a", "1", "--flag", "--dry-run"]);
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

describe("x accounts", () => {
  test("a context's URL names its account, or none; X's own pages are not handles", () => {
    expect(accountOf("https://x.com/Jack")).toEqual({ onX: true, handle: "jack" });
    expect(accountOf("https://twitter.com/jack/status/20")).toEqual({ onX: true, handle: "jack" });
    expect(accountOf("https://x.com/home")).toEqual({ onX: true, handle: undefined });
    expect(accountOf("https://x.com/i/flow/login")).toEqual({ onX: true, handle: undefined });
    expect(accountOf("https://example.com/jack").onX).toBe(false);
  });

  test("a sign-in starts runs from the account's profile, or home when the context names none", () => {
    expect(xDomain().appUrl!("https://x.com/home", "https://x.com/Jack")).toBe("https://x.com/jack");
    expect(xDomain().appUrl!("https://x.com/home", "https://x.com")).toBe("https://x.com/home");
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
    const a = requests.file({ kind: "intake", text: "merge", context: "acme", domain: domain() });
    const b = requests.file({ kind: "new", op: "candidate:merge", text: "merge", context: "acme", domain: domain() });
    expect([a.id, b.id]).toEqual(["R-0001", "R-0002"]);
    requests.update(a.id, () => ({ state: "building", stage: "spec" }));
    expect(requests.ledger(a.id).map((e) => e.event)).toEqual(["received", "building"]);
    expect(requests.list().map((r) => r.id)).toEqual(["R-0002", "R-0001"]);
    expect(requests.list({ state: "building" }).map((r) => r.id)).toEqual(["R-0001"]);
  });

  test("only a blocked request takes an answer, and only failed or deferred ones are retried", () => {
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
    const failure = { step: "fill name", error: "Timeout", bundle: "/b" };
    const r = requests.file({ kind: "repair", op: "x:y", text: "x:y failed", context: "acme", domain: domain(), failure });
    expect(requests.openRepair("x:y", "fill name")?.id).toBe(r.id);
    expect(requests.openRepair("x:y", "submit")).toBeUndefined();
    expect(requests.brokenBy("x:y")).toBeUndefined();
    requests.update(r.id, () => ({ state: "failed", reason: "flaky" }));
    expect(requests.brokenBy("x:y")?.id).toBe(r.id);
    requests.retry(r.id);
    expect(requests.brokenBy("x:y")).toBeUndefined();
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
      { kind: "operation-started", of: "turn", operationId: "a", agent: "checker", label: "review 1", deliveredAt: "2026-10-17T20:04:00Z" },
      { kind: "turn", operationId: "a", agent: "checker", label: "review 1" },
      {
        kind: "operation-started",
        of: "turn",
        operationId: "b",
        agent: "builder",
        label: "revise 1",
        deliveredAt: "2026-10-17T20:06:00Z",
        execution: { model: "claude-sonnet-5-5" },
      },
    ];
    expect(describeRun(view, turns, now)).toEqual([
      { text: "✓ write  17m", key: "write succeeded" },
      {
        text: "▸ check  14m · revise 1 · builder (claude-sonnet-5-5) · Bash: bun run ci:sandbox (4m)",
        key: "check running · revise 1 · builder",
      },
    ]);
    // awf cuts a long argument, so a command can be nothing but its first assignment.
    view.agents[1]!.live!.lastActivity.activity.input = "S=/Users/roman/.awf/sandboxes/op-build/R-0012/…";
    expect(describeRun(view, turns, now)[1]!.text).toBe("▸ check  14m · revise 1 · builder (claude-sonnet-5-5) · Bash (4m)");
    // A turn an earlier attempt left open is not working now.
    const stale = turns.map((t) => ({ ...t, attempt: 1 }));
    expect(describeRun(view, [...stale, { kind: "attempt-started", attempt: 2 }], now)[1]!.text).toBe("▸ check  14m");
    // Between turns, as while the checks run, the stage alone.
    expect(describeRun(view, turns.slice(0, 2), now)[1]!.text).toBe("▸ check  14m");
  });

  test("a retry of a run that completed redoes it from its first agent stage", () => {
    const r = requests.file({ kind: "intake", text: "x", context: "acme", domain: domain() });
    mkdirSync(join(t.home, "runs", "op-build", r.id), { recursive: true });
    writeFileSync(join(t.home, "runs", "op-build", r.id, "output.json"), JSON.stringify({ outcome: "failed" }));
    expect(awfArgs(t.home, "/root", r).slice(-2)).toEqual(["--continue", r.id]);
    writeFileSync(join(t.home, "runs", "op-build", r.id, "output.json"), JSON.stringify({ outcome: "completed" }));
    expect(awfArgs(t.home, "/root", r).slice(-4)).toEqual(["--continue", r.id, "--from-stage", "intake"]);
  });

  test("a retry of a run that stopped continues from the stage that stopped", () => {
    const r = requests.file({ kind: "new", op: "x:y", text: "x", context: "acme", domain: domain() });
    mkdirSync(join(t.home, "runs", "op-build", r.id), { recursive: true });
    writeFileSync(join(t.home, "runs", "op-build", r.id, "output.json"), JSON.stringify({ outcome: "stopped" }));
    requests.update(r.id, () => ({ state: "failed", reason: "the run was killed" }));
    expect(awfArgs(t.home, "/root", requests.retry(r.id)).slice(-2)).toEqual(["--continue", r.id]);
  });

  test("a retried request is redone from its first stage until that stage starts, whatever stopped the attempt between", () => {
    const r = requests.file({ kind: "repair", op: "x:y", text: "x", context: "acme", domain: domain() });
    mkdirSync(join(t.home, "runs", "op-repair", r.id), { recursive: true });
    writeFileSync(join(t.home, "runs", "op-repair", r.id, "output.json"), JSON.stringify({ outcome: "completed" }));
    requests.update(r.id, () => ({ state: "failed" }));
    const retried = requests.retry(r.id, { redo: true });
    // An attempt stopped on a lock before reaching diagnose: its outcome is no longer "completed".
    writeFileSync(join(t.home, "runs", "op-repair", r.id, "output.json"), JSON.stringify({ outcome: "stopped" }));
    expect(awfArgs(t.home, "/root", retried).slice(-4)).toEqual(["--continue", r.id, "--from-stage", "diagnose"]);
  });

  test("the worker continues a run that has a record, and starts one that doesn't", () => {
    const r = requests.file({ kind: "repair", op: "x:y", text: "x", context: "acme", domain: domain() });
    expect(awfArgs(t.home, "/root", r)).toEqual([
      "run",
      "/root/core/workflows/repair.ts",
      "--run-root",
      `${t.home}/runs`,
      "--timeout",
      RUN_TIMEOUT,
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
        <h1>Create Prospect</h1>
        <form><label for="f">First Name</label><input id="f" data-testid="textInputBox" value="Ada">
        <label for="l">Last Name</label><input id="l" data-testid="textInputBox">
        <button type="button" data-testid="okButton" onclick="document.body.insertAdjacentHTML('beforeend','<div role=alert>Saved</div>')">OK</button>
        <span aria-hidden="true"><button>Hidden</button></span></form>
        <article role="article" tabindex="0" data-testid="tweet"><a href="/ada">Ada</a> posted</article>`);
      const before = await takeSnapshot(page);
      expect(formatSnapshot(before).split("\n").slice(2)).toEqual([
        '- heading "Create Prospect"',
        "- form",
        '  - textbox "First Name" [e1] = "Ada" {textInputBox}',
        '  - textbox "Last Name" [e2] = "" {textInputBox}',
        '  - button "OK" [e3] {okButton}',
        // A control only by taking focus, it shows what is in it.
        '- article "Ada posted" [e4] {tweet}',
        '  - link "Ada" [e5]',
      ]);
      expect(suggestLocator(before.nodes[2]!)).toBe(`page.getByLabel("First Name", { exact: true })`);
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
});

test("docs/prompts.md is what prompts.ts writes now: `bun run docs:prompts` updates it", async () => {
  const root = join(import.meta.dir, "..");
  expect(await Bun.file(join(root, "docs/prompts.md")).text()).toBe(renderPrompts("x", "x", loadConfig(root)));
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
