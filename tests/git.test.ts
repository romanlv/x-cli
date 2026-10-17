import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { realGit } from "../core/workflows/deps";
import { tempHome } from "./helpers";

let t: ReturnType<typeof tempHome>;
let root: string;

beforeEach(async () => {
  t = tempHome();
  root = join(t.home, "repo");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  writeFileSync(join(root, "a.txt"), "a\n");
  await $`git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init`.cwd(root).quiet();
});
afterEach(() => t.cleanup());

test("a request's branch is built in a worktree, squashed to one commit and fast-forwarded onto main", async () => {
  const wt = join(t.home, "worktrees", "R-0001");
  await realGit.ensureWorktree(root, wt, "req/R-0001");
  expect(existsSync(join(wt, "node_modules"))).toBe(true);
  await realGit.ensureWorktree(root, wt, "req/R-0001"); // a continue finds it there

  writeFileSync(join(wt, "b.txt"), "b\n");
  await $`git add -A && git -c user.email=t@t -c user.name=t commit -qm wip`.cwd(wt).quiet();
  writeFileSync(join(wt, "c.txt"), "c\n");
  // main moves on meanwhile.
  writeFileSync(join(root, "d.txt"), "d\n");
  await $`git add -A && git -c user.email=t@t -c user.name=t commit -qm other`.cwd(root).quiet();

  const env = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  Object.assign(process.env, env);
  expect(await realGit.squash(wt, "R-0001 build x:y")).toMatch(/^[0-9a-f]{40}$/);
  expect(await realGit.rebase(wt)).toEqual({ ok: true });
  expect((await realGit.changed(wt)).sort()).toEqual(["b.txt", "c.txt"]);
  const head = await realGit.fastForward(root, "req/R-0001");
  expect((await $`git log --format=%s`.cwd(root).text()).trim().split("\n")).toEqual(["R-0001 build x:y", "other", "init"]);
  expect(head).toBe((await $`git rev-parse HEAD`.cwd(root).text()).trim());
  await realGit.removeWorktree(root, wt, "req/R-0001");
  expect(existsSync(wt)).toBe(false);
});

test("a conflicting rebase is aborted and named", async () => {
  const wt = join(t.home, "worktrees", "R-0002");
  await realGit.ensureWorktree(root, wt, "req/R-0002");
  Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
  writeFileSync(join(wt, "a.txt"), "mine\n");
  await realGit.squash(wt, "R-0002 change");
  writeFileSync(join(root, "a.txt"), "theirs\n");
  await $`git commit -qam theirs`.cwd(root).quiet();
  expect(await realGit.rebase(wt)).toEqual({ ok: false, conflict: "a.txt" });
  expect((await $`git status --porcelain`.cwd(wt).text()).trim()).toBe("");
});
