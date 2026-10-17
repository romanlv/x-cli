import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envName } from "../core/env";

export const ROOT = join(import.meta.dir, "..");
/** The real CLI over the test ops in tests/fixtures/x/ops. */
export const ENTRY = join(import.meta.dir, "fixtures", "x", "main.ts");

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The --json envelope, when the call asked for one. */
  json?: { ok: boolean; data?: unknown; error?: string; next: { hint: string; cmd: string }[] };
}

export const tempHome = (): { home: string; cleanup(): void } => {
  const home = mkdtempSync(join(tmpdir(), "x-test-"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
};

/** Run the CLI as a caller would, in its own process. */
export const cli = async (home: string, args: string[], env: Record<string, string> = {}): Promise<CliResult> => {
  const child = Bun.spawn(["bun", ENTRY, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      [envName("HOME")]: home,
      [envName("NO_WORKER")]: "1",
      [envName("HEADLESS_LOGIN")]: "1",
      [envName("SIGNIN_WAIT_MS")]: "2000",
      [envName("STEP_TIMEOUT_MS")]: "2000",
      [envName("POLL_MS")]: "100",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const result: CliResult = { code, stdout, stderr };
  if (args.includes("--json") && stdout.trim()) result.json = JSON.parse(stdout.trim());
  return result;
};
