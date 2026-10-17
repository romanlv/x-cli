// The CLI as an agent runs it inside a build worktree: it never files requests or starts a worker.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envName } from "../core/env";
import { Requests } from "../core/requests";
import { ROOT, tempHome } from "./helpers";

let t: ReturnType<typeof tempHome>;
let entry: string;

beforeEach(() => {
  t = tempHome();
  const worktree = join(t.home, "wt");
  mkdirSync(worktree, { recursive: true });
  // A worktree's .git is a file pointing at the main repository.
  writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
  entry = join(worktree, "main.ts");
  writeFileSync(
    entry,
    `import { main } from "${ROOT}/core/cli";\nimport { xDomain } from "${ROOT}/x/domain";\nawait main(xDomain({ root: ${JSON.stringify(worktree)}, dir: "${ROOT}/tests/fixtures/x" }));\n`,
  );
});
afterEach(() => t.cleanup());

const run = async (args: string[]) => {
  const child = Bun.spawn(["bun", entry, ...args], { env: { ...process.env, [envName("HOME")]: t.home }, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { code, stderr };
};

test("a call to a missing op, a --request and a request are refused, and nothing is filed", async () => {
  expect((await run(["context:add", "acme", "--url", "http://localhost:1/acme"])).code).toBe(0);
  for (const args of [
    ["posts:search", "--from", "jack", "--request"],
    ["request", "merge them"],
  ]) {
    const r = await run(args);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("requests are filed from the main checkout");
  }
  expect(new Requests(t.home).list()).toEqual([]);
});
