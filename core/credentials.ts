// A person's username and password for a context, for a domain with `submitSignIn`: left in
// `.env.<context>` by the person, or given to `context:login`, and submitted for them. They are never
// saved; the session the sign-in leaves is.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { Domain } from "./domain";
import { envValue } from "./env";
import { progress } from "./output";

export interface Credentials {
  username: string;
  password: string;
}

/**
 * The credentials in `.env.<context>` in the checkout (or the CREDENTIALS_DIR setting): USERNAME and
 * PASSWORD. The file is gitignored, so a build's worktree never has one, and agents never sign in.
 */
export const savedCredentials = (root: string, context: string): Credentials | undefined => {
  const file = join(envValue("CREDENTIALS_DIR") ?? root, `.env.${context}`);
  if (!existsSync(file)) return undefined;
  const vars: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) vars[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  const { USERNAME: username, PASSWORD: password } = vars;
  return username && password ? { username, password } : undefined;
};

/** How long after the password is sent a form still asking for it has turned it down. */
const TURNED_DOWN_MS = 20_000;

/** How a sign-in in progress is waited for, by hand or with credentials. */
export interface SignInWait {
  ms: number;
  /** Why the sign-in failed, once the signed-out page makes that plain. */
  turnedDown?(): Promise<string | undefined>;
  timedOut: string;
}

/** Fill the sign-in form and submit it, headless. */
export const submitCredentials = async (
  submit: NonNullable<Domain["submitSignIn"]>,
  page: Page,
  url: string,
  credentials: Credentials,
  timeoutMs = 2 * 60_000,
): Promise<SignInWait> => {
  const as = `the sign-in as ${credentials.username}`;
  progress(`signing in to ${url} as ${credentials.username}`);
  await submit(page, credentials);
  // A form still asking for the password this long after it was sent turned it down: a fixed wait,
  // not SIGNIN_WAIT_MS, which is how long a loaded page may take to say whether it is signed in.
  const refusedBy = Date.now() + TURNED_DOWN_MS;
  const password = page.locator('input[type="password"]').first();
  return {
    ms: timeoutMs,
    turnedDown: async () =>
      Date.now() > refusedBy && (await password.isVisible().catch(() => false))
        ? `${as} was turned down: check the username and password`
        : undefined,
    timedOut: `${as} didn't finish: a wrong password, or a second step (MFA, SSO) that needs the window`,
  };
};
