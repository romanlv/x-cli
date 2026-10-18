// What a build or repair run does outside its agents: git, running the CLI to verify an op, the
// repository's checks, signing in and the sandbox. Injected, so a workflow test swaps them for fakes
// and no repository or browser is touched.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { SandboxSpec } from "agentswf/workflow";
import { $ } from "bun";
import { savedCredentials } from "../credentials";
import { ENV_PREFIX, envName } from "../env";
import { opFolder } from "../names";
import type { RequestRecord } from "../requests";
import { opsSession } from "../session";
import { type SandboxPaths, sandboxSpec, shellEnv } from "./sandbox";

export interface VerifyRun {
  input: Record<string, unknown>;
  /** Run with --browser, past the op's direct way. */
  browser?: boolean;
  exitCode: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface Verified {
  op: string;
  ok: boolean;
  runs: VerifyRun[];
  /** The context's session expired: no agent can fix that. */
  signedOut: boolean;
  /** examples.json has nothing for this context. */
  noExamples: boolean;
  /** Why verify ran nothing: an examples.json it can't read. */
  problem?: string;
}

export interface Git {
  /** The worktree for a request on its own branch from main, with the checkout's dependencies linked in. Safe to repeat. */
  ensureWorktree(root: string, worktree: string, branch: string): Promise<void>;
  /** Squash everything on the branch, uncommitted work included, into one commit on its base. Undefined when nothing changed. */
  squash(worktree: string, message: string): Promise<string | undefined>;
  /** The commit the branch is based on. */
  base(worktree: string): Promise<string>;
  /** Rebase on main; a conflict is aborted and named. */
  rebase(worktree: string): Promise<{ ok: true } | { ok: false; conflict: string }>;
  rebaseInProgress(worktree: string): Promise<boolean>;
  /** Files the worktree changes against main, uncommitted and untracked ones included. */
  changed(worktree: string): Promise<string[]>;
  /** Files main changed since `from`. */
  changedOnMain(worktree: string, from: string): Promise<string[]>;
  /** The commit on main with this exact message, if one landed. */
  landed(root: string, message: string): Promise<string | undefined>;
  /** Fast-forward main in the checkout to the branch; returns the new head. */
  fastForward(root: string, branch: string): Promise<string>;
  removeWorktree(root: string, worktree: string, branch: string): Promise<void>;
}

/** The fast checks run every round; the full ones (the slow e2e suite too) once before approval. */
export type CheckScope = "fast" | "full";
/** The repository's scripts the workflows run or point agents to: the checks, the sandbox's, the fixer. */
export const SCRIPTS = { fast: "ci:fast", full: "ci:check", sandbox: "ci:sandbox", fix: "lint:fix" } as const;

export interface Deps {
  git: Git;
  /** Run the op from the worktree on every example for the context, as a caller would. */
  verify(worktree: string, request: RequestRecord, op: string): Promise<Verified>;
  /** The repository's own checks (its `ci:fast` or `ci:check` script) in the worktree; ok when it has none. */
  checks(worktree: string, scope: CheckScope): Promise<{ ok: boolean; output: string }>;
  /** Close the browser sessions the run's agents explored in. */
  closeSessions(worktree: string, request: RequestRecord, sessions: string[], sandbox?: SandboxPaths): Promise<void>;
  /**
   * Sign the request's context in again from `.env.<context>` in the checkout, on the host, as
   * `context:login` does. False when there is no such file or signing in failed: a person must.
   */
  signIn(request: RequestRecord): Promise<boolean>;
  /** Ready the agents' sandbox: their home and socket directory, and the host's browser. Safe to repeat. */
  sandbox(request: RequestRecord, worktree: string, paths: SandboxPaths): Promise<SandboxSpec>;
}

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await $`git ${args}`.cwd(cwd).quiet().nothrow();
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
};
const lines = (out: string): string[] => (out ? out.split("\n") : []);

export const realGit: Git = {
  async ensureWorktree(root, worktree, branch) {
    if (!existsSync(worktree)) {
      await $`git worktree prune`.cwd(root).quiet().nothrow();
      const exists = (await $`git rev-parse --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow()).exitCode === 0;
      await git(root, "worktree", "add", "-q", ...(exists ? [worktree, branch] : ["-b", branch, worktree, "main"]));
    }
    // A worktree has no node_modules of its own; the checkout's serve it.
    const modules = join(worktree, "node_modules");
    if (!existsSync(modules)) symlinkSync(join(root, "node_modules"), modules);
  },
  async squash(worktree, message) {
    await git(worktree, "add", "-A");
    await git(worktree, "reset", "--soft", await git(worktree, "merge-base", "HEAD", "main"));
    const staged = await $`git diff --cached --quiet`.cwd(worktree).quiet().nothrow();
    if (staged.exitCode === 0) return undefined;
    await git(worktree, "commit", "-q", "--no-verify", "-m", message);
    return git(worktree, "rev-parse", "HEAD");
  },
  base: (worktree) => git(worktree, "merge-base", "HEAD", "main"),
  async rebase(worktree) {
    const result = await $`git rebase main`.cwd(worktree).quiet().nothrow();
    if (result.exitCode === 0) return { ok: true };
    const conflict = (await git(worktree, "diff", "--name-only", "--diff-filter=U")) || result.stderr.toString().trim();
    await $`git rebase --abort`.cwd(worktree).quiet().nothrow();
    return { ok: false, conflict };
  },
  async rebaseInProgress(worktree) {
    const dir = await git(worktree, "rev-parse", "--git-dir");
    const abs = dir.startsWith("/") ? dir : join(worktree, dir);
    return existsSync(join(abs, "rebase-merge")) || existsSync(join(abs, "rebase-apply"));
  },
  async changed(worktree) {
    // Against where the branch left main: what main gained since is not this change.
    const tracked = lines(await git(worktree, "diff", "--name-only", await git(worktree, "merge-base", "HEAD", "main")));
    const untracked = lines(await git(worktree, "ls-files", "--others", "--exclude-standard"));
    return [...new Set([...tracked, ...untracked])];
  },
  changedOnMain: async (worktree, from) => lines(await git(worktree, "diff", "--name-only", from, "main")),
  async landed(root, message) {
    const log = lines(await git(root, "log", "main", "-n", "200", "--format=%H%x09%s"));
    return log.map((line) => line.split("\t")).find(([, subject]) => subject === message)?.[0];
  },
  async fastForward(root, branch) {
    const current = await git(root, "symbolic-ref", "--short", "HEAD");
    if (current !== "main") throw new Error(`the checkout at ${root} is on ${current}, not main`);
    await git(root, "merge", "--ff-only", "-q", branch);
    return git(root, "rev-parse", "HEAD");
  },
  async removeWorktree(root, worktree, branch) {
    await $`git worktree remove --force ${worktree}`.cwd(root).quiet().nothrow();
    await $`git branch -D ${branch}`.cwd(root).quiet().nothrow();
  },
};

/** The domain folder inside a worktree, or inside the checkout itself: `<worktree>/x`. */
export const domainIn = (worktree: string, request: RequestRecord): string =>
  join(worktree, relative(request.domain.root, request.domain.dir));

/** The domain's entry point inside a worktree: `<worktree>/x/main.ts`. */
export const entryIn = (worktree: string, request: RequestRecord): string => join(domainIn(worktree, request), "main.ts");

export const opDirIn = (domainDir: string, op: string): string => join(domainDir, "ops", opFolder(op));

interface Example {
  context: string;
  input: Record<string, unknown>;
}

const isExample = (e: unknown): e is Example =>
  typeof e === "object" && e !== null && typeof (e as Example).context === "string" && typeof (e as Example).input === "object";

/** An op's examples.json; none when it has no such file yet. Throws, saying why, when it isn't a list of examples. */
export const examplesIn = (opDir: string): Example[] => {
  const file = join(opDir, "examples.json");
  if (!existsSync(file)) return [];
  let examples: unknown;
  try {
    examples = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`not JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(examples) || !examples.every(isExample)) throw new Error('not a list of { "context": "…", "input": { … } }');
  return examples;
};

/**
 * The environment the CLI runs in for a run and its agents: the request's home, and no requests
 * filed or worker started from a build.
 */
export const cliEnv = (request: RequestRecord, sandbox?: SandboxPaths): Record<string, string> => ({
  [envName("HOME")]: sandbox?.home ?? request.domain.home,
  [envName("NO_REPAIRS")]: "1",
  [envName("NO_WORKER")]: "1",
  ...(sandbox && { [envName("CONTEXTS_DIR")]: join(request.domain.home, "contexts"), ...shellEnv(sandbox) }),
});

const runCli = async (worktree: string, request: RequestRecord, args: string[], sandbox?: SandboxPaths) => {
  const child = Bun.spawn(["bun", entryIn(worktree, request), ...args], {
    cwd: worktree,
    env: { ...process.env, ...cliEnv(request, sandbox), [envName("QUIET")]: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { stdout, exitCode };
};

/** JSON with object keys sorted, so two outputs compare by content. */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  ) ?? "";

/** Between two of verify's calls on the app. */
const VERIFY_PAUSE_MS = 3_000;

const verify = async (worktree: string, request: RequestRecord, op: string): Promise<Verified> => {
  const dir = opDirIn(domainIn(worktree, request), op);
  let mine: Example[];
  try {
    mine = examplesIn(dir).filter((e) => e.context === request.context);
  } catch (err) {
    // An agent wrote the file, so an agent fixes it: a failed verify, not a run that dies.
    return { op, ok: false, runs: [], signedOut: false, noExamples: false, problem: `examples.json: ${(err as Error).message}` };
  }
  const runs: VerifyRun[] = [];
  let signedOut = false;
  // An op with a direct way runs each example both ways, so the browser way it falls back to works too.
  const opFile = join(dir, "op.ts");
  const direct = existsSync(opFile) && /^\s*(async\s+)?direct\s*[(:]/m.test(readFileSync(opFile, "utf8"));
  const ways = direct ? [false, true] : [false];
  for (const [example, browser] of mine.flatMap((e) => ways.map((b) => [e, b] as const))) {
    // At a person's pace: a merge verifies every op when shared code changed, and the app limits each account.
    if (runs.length) await Bun.sleep(VERIFY_PAUSE_MS);
    const { stdout, exitCode } = await runCli(worktree, request, [
      op,
      "--input-json",
      JSON.stringify(example.input),
      "--context",
      request.context,
      "--json",
      ...(browser ? ["--browser"] : []),
    ]);
    let envelope: { ok?: boolean; data?: unknown; error?: string } = {};
    try {
      envelope = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
    } catch {
      envelope = { ok: false, error: `no envelope: ${stdout.slice(0, 500)}` };
    }
    if (exitCode === 3 && /signed out/.test(envelope.error ?? "")) signedOut = true;
    const run: VerifyRun = {
      input: example.input,
      ...(browser ? { browser } : {}),
      exitCode,
      ok: exitCode === 0 && envelope.ok === true,
      data: envelope.data,
      error: envelope.error,
    };
    // Both ways must give the same answer, not only both succeed.
    const viaDirect = browser ? runs.at(-1) : undefined;
    if (run.ok && viaDirect?.ok && stable(run.data) !== stable(viaDirect.data)) {
      run.ok = false;
      run.error = `its output differs from the direct way's: --browser gave ${stable(run.data).slice(0, 400)}, direct gave ${stable(viaDirect.data).slice(0, 400)}`;
    }
    runs.push(run);
  }
  return { op, ok: mine.length > 0 && runs.every((r) => r.ok), runs, signedOut, noExamples: mine.length === 0 };
};

/** The lines of a failed check run worth reading: each failure and error with what follows it, then the end. */
const checkFailures = (output: string): string => {
  const all = output.split("\n");
  const keep = new Set<number>();
  all.forEach((line, i) => {
    if (/\(fail\)|^error|error:|^\s*\d+ fail|\[warn\]|TS\d{4}/i.test(line))
      for (let j = i; j < Math.min(i + 8, all.length); j++) keep.add(j);
  });
  for (let j = Math.max(0, all.length - 15); j < all.length; j++) keep.add(j);
  return [...keep]
    .sort((a, b) => a - b)
    .map((i) => all[i])
    .slice(-150)
    .join("\n");
};

/**
 * The repository's own checks, on a copy of the worktree without its git link: the tool behaves
 * differently inside a worktree, and its tests should see a plain checkout.
 */
const checks = async (worktree: string, scope: CheckScope): Promise<{ ok: boolean; output: string }> => {
  const pkg = join(worktree, "package.json");
  const scripts = existsSync(pkg) ? ((JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}) : {};
  // A repository without fast checks runs its full ones every round.
  const script = scripts[SCRIPTS[scope]] ? SCRIPTS[scope] : scripts[SCRIPTS.full] ? SCRIPTS.full : undefined;
  if (!script) return { ok: true, output: "" };
  const copy = mkdtempSync(join(tmpdir(), "checks-"));
  try {
    await $`rsync -a --exclude .git --exclude node_modules --exclude .state --exclude .awf ${`${worktree}/`} ${`${copy}/`}`.quiet();
    symlinkSync(join(worktree, "node_modules"), join(copy, "node_modules"));
    // The checks set up their own homes and switches; the run's must not leak into them.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith(ENV_PREFIX)));
    const result = await $`bun run ${script}`.cwd(copy).env(env).quiet().nothrow();
    const output = checkFailures(`${result.stdout.toString()}\n${result.stderr.toString()}`.trim()).replaceAll(copy, worktree);
    return { ok: result.exitCode === 0, output };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
};

/** The host's browser for this run's sandbox: started once, ending with this process. */
const ensureBrowser = async (socket: string): Promise<void> => {
  if (existsSync(socket)) {
    const answers = await fetch("http://browser/", { unix: socket } as RequestInit).then(
      () => true,
      () => false,
    );
    if (answers) return;
  }
  const child = Bun.spawn(["bun", join(import.meta.dir, "..", "browser-server.ts"), socket, String(process.pid)], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  if (!new TextDecoder().decode(value).includes("ready")) {
    throw new Error(`the host browser for the sandbox did not start (exit ${await child.exited})`);
  }
  // It watches this process and ends with it; holding it here would keep the run from exiting.
  child.unref();
};

export const realDeps: Deps = {
  git: realGit,
  verify,
  checks,
  async closeSessions(worktree, request, sessions, sandbox) {
    if (!existsSync(entryIn(worktree, request))) return;
    for (const session of sessions)
      await runCli(worktree, request, ["page:close", "--session", session, "--context", request.context], sandbox);
    // The browser the worktree's op calls kept (`keepBrowser`): the agents' in their home, verify's in the domain's.
    const kept = ["page:close", "--session", opsSession(worktree, request.context), "--context", request.context];
    await runCli(worktree, request, kept, sandbox);
    if (sandbox) await runCli(worktree, request, kept);
  },
  async signIn(request) {
    if (!savedCredentials(request.domain.root, request.context)) return false;
    // From the checkout, not a worktree: only there does the CLI take credentials.
    const child = Bun.spawn(["bun", entryIn(request.domain.root, request), "context:login", request.context], {
      cwd: request.domain.root,
      env: { ...process.env, ...cliEnv(request), [envName("QUIET")]: "1" },
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await child.exited) === 0;
  },
  sandbox: async (request, worktree, paths) => {
    mkdirSync(paths.home, { recursive: true });
    mkdirSync(paths.sockets, { recursive: true, mode: 0o700 });
    const modules = join(worktree, "node_modules");
    if (lstatSync(modules, { throwIfNoEntry: false })?.isSymbolicLink()) {
      rmSync(modules);
      const installed = await $`bun install --frozen-lockfile`.cwd(worktree).quiet().nothrow();
      if (installed.exitCode !== 0) throw new Error(`bun install in ${worktree} failed: ${installed.stderr.toString().slice(0, 400)}`);
    }
    await ensureBrowser(paths.browserSocket);
    return sandboxSpec(request, worktree, paths);
  },
};
