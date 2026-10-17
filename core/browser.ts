// Playwright behind the CLI: a browser per call, signed in as the context's saved session, and the
// headed sign-in a person does once per context.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Browser, type BrowserContext, chromium, type LaunchOptions, type Page, selectors } from "playwright";
import { type Context, type Contexts, loginHint } from "./contexts";
import { type Credentials, type SignInWait, savedCredentials, submitCredentials } from "./credentials";
import type { Domain } from "./domain";
import { envNumber, envValue } from "./env";
import { BrowserError, InputError, PreconditionError } from "./errors";
import { type NetworkEntry, recordNetwork } from "./network";
import { firstLine, progress } from "./output";

export interface OpenBrowser {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  network: NetworkEntry[];
  /** It signed in from `.env.<context>` to open: the session it found had ended. */
  signedInNow?: boolean;
  close(): Promise<void>;
}

class SignedOut extends PreconditionError {}

const VIEWPORT = { width: 1440, height: 900 };
/** How long one Playwright action, or one direct call, waits before the step fails. */
export const STEP_TIMEOUT_MS = envNumber("STEP_TIMEOUT_MS", 15_000);

/**
 * Save a signed-in browser's cookies as the context's sign-in. The app may keep its idle timer in
 * them, so a later browser starts from the last activity, not from the person's sign-in. Written
 * whole and renamed into place, since several processes save it.
 */
export const saveSession = async (context: Pick<BrowserContext, "storageState">, ctx: Context): Promise<void> => {
  mkdirSync(dirname(ctx.authFile), { recursive: true });
  const temp = `${ctx.authFile}.${process.pid}.tmp`;
  await context.storageState({ path: temp });
  chmodSync(temp, 0o600);
  renameSync(temp, ctx.authFile);
};

const userAgentFile = (ctx: Context): string => join(dirname(ctx.authFile), "user-agent");

/**
 * Keep the browser's user agent beside the sign-in, so the direct way's calls name the browser the
 * pages did instead of Playwright. Best effort: a sandboxed build can't write it, and needs it not.
 */
const saveUserAgent = async (page: Page, ctx: Context): Promise<void> => {
  const agent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);
  if (agent)
    try {
      writeFileSync(userAgentFile(ctx), agent);
    } catch {}
};

/** The user agent the context's last signed-in browser sent; undefined before one has. */
export const savedUserAgent = (ctx: Context): string | undefined => {
  try {
    return readFileSync(userAgentFile(ctx), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Start a browser, or a browser server, as XCLI_BROWSER_CHANNEL says: an installed browser such as
 * "chrome" instead of Playwright's Chromium (headless, in Chrome's own headless mode), and
 * Playwright's Chromium when that one isn't installed.
 */
export const launchWith = async <T>(headed: boolean, start: (options: LaunchOptions) => Promise<T>): Promise<T> => {
  const channel = envValue("BROWSER_CHANNEL");
  if (!channel) return start({ headless: !headed });
  return start({ headless: !headed, channel }).catch((err: Error) => {
    if (!/is not found|not installed/i.test(err.message)) throw err;
    progress(`› no ${channel} installed; using Playwright's Chromium`);
    return start({ headless: !headed });
  });
};

/** XCLI_BROWSER: a browser on the host, for a sandboxed build, where Chromium can't start. */
export const launch = async (headed: boolean): Promise<Browser> => {
  try {
    const endpoint = envValue("BROWSER");
    if (endpoint) return await chromium.connect(endpoint);
    return await launchWith(headed, (options) => chromium.launch(options));
  } catch (err) {
    throw new BrowserError(`the browser would not start: ${firstLine((err as Error).message)}`);
  }
};

/**
 * A browser on the context's saved sign-in, at its URL, checked to be signed in as that context and
 * no other. Signed out, it signs in from `.env.<context>` when the checkout has one; otherwise that
 * is a precondition, not something an agent can fix, so nothing is filed.
 */
export const openSignedIn = async (
  domain: Domain,
  contexts: Contexts,
  ctx: Context,
  options: { headed?: boolean; network?: Parameters<typeof recordNetwork>[1] } = {},
): Promise<OpenBrowser> => {
  try {
    return await openOnce(domain, contexts, ctx, options);
  } catch (err) {
    const credentials = err instanceof SignedOut && domain.submitSignIn ? savedCredentials(domain.root, ctx.name) : undefined;
    if (!credentials) throw err;
    await signIn(domain, contexts, ctx, { credentials });
    return { ...(await openOnce(domain, contexts, contexts.get(ctx.name), options)), signedInNow: true };
  }
};

const openOnce = async (
  domain: Domain,
  contexts: Contexts,
  ctx: Context,
  { headed = false, network: recording = {} }: { headed?: boolean; network?: Parameters<typeof recordNetwork>[1] },
): Promise<OpenBrowser> => {
  const login = [loginHint(domain.name, ctx.name)];
  if (!existsSync(ctx.authFile)) throw new SignedOut(`context "${ctx.name}" is signed out`, login);
  // `getByTestId` in ops and in the locators exploring suggests.
  if (domain.testIdAttribute) selectors.setTestIdAttribute(domain.testIdAttribute);

  const browser = await launch(headed);
  const close = () => browser.close().catch(() => {});
  try {
    const context = await browser.newContext({ storageState: ctx.authFile, viewport: VIEWPORT });
    await domain.prepareBrowser?.(context);
    const network = recordNetwork(context, recording);
    const page = await context.newPage();
    try {
      await page.goto(ctx.appUrl, { waitUntil: "domcontentloaded" });
    } catch (err) {
      throw new PreconditionError(`could not reach ${ctx.appUrl}: ${firstLine((err as Error).message)}`);
    }
    const state = await domain.signInState(page, ctx.appUrl);
    if (state === "signed-out") {
      contexts.markSignedOut(ctx.name);
      throw new SignedOut(`context "${ctx.name}" is signed out: its saved session has expired`, login);
    }
    if (state === "unknown") {
      throw new PreconditionError(
        `could not tell whether "${ctx.name}" is signed in: ${ctx.appUrl} showed neither ${domain.name}'s pages nor a sign-in`,
      );
    }
    if (state === "elsewhere") {
      throw new PreconditionError(
        `the saved session for "${ctx.name}" is signed in elsewhere than ${ctx.appUrl} (another account or tenant); refusing to run`,
        login,
      );
    }
    await saveSession(context, ctx).catch(() => {});
    await saveUserAgent(page, ctx);
    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    return { browser, context, page, network, close };
  } catch (err) {
    await close();
    throw err;
  }
};

/**
 * A person signs in, SSO and MFA included, in a headed browser; the session is saved for the context.
 * With `credentials`, the form is filled and submitted for them, headless (`credentials.ts`).
 */
export const signIn = async (
  domain: Domain,
  contexts: Contexts,
  ctx: Context,
  { timeoutMs, headless = false, credentials }: { timeoutMs?: number; headless?: boolean; credentials?: Credentials } = {},
): Promise<void> => {
  const submit = domain.submitSignIn;
  if (credentials && !submit) throw new InputError(`${domain.name} has no sign-in with a username and password`);
  const browser = await launch(!(headless || credentials));
  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    await page.goto(ctx.url, { waitUntil: "domcontentloaded" });
    const wait = credentials ? await submitCredentials(submit!, page, ctx.url, credentials, timeoutMs) : byHand(ctx.url, timeoutMs);
    await waitForSignIn(domain, page, ctx.url, wait);
    await saveSession(context, ctx);
    await saveUserAgent(page, ctx);
    contexts.markSignedIn(ctx.name, domain.appUrl?.(page.url(), ctx.url) ?? page.url());
  } finally {
    await browser.close().catch(() => {});
  }
};

const byHand = (url: string, timeoutMs = 10 * 60_000): SignInWait => {
  progress(`sign in to ${url} in the browser window; waiting up to ${Math.round(timeoutMs / 60_000)} minutes`);
  return { ms: timeoutMs, timedOut: "timed out waiting for the sign-in" };
};

const waitForSignIn = async (domain: Domain, page: Page, url: string, wait: SignInWait): Promise<void> => {
  const deadline = Date.now() + wait.ms;
  for (;;) {
    if (page.isClosed()) throw new PreconditionError("the sign-in window was closed before signing in");
    const state = await domain.signInState(page, url).catch(() => "unknown" as const);
    if (state === "signed-in") return;
    const turnedDown = state === "signed-out" ? await wait.turnedDown?.() : undefined;
    if (turnedDown) throw new PreconditionError(turnedDown);
    if (state === "elsewhere") throw new PreconditionError(`signed in elsewhere than ${url} (another account or tenant)`);
    if (Date.now() > deadline) throw new PreconditionError(wait.timedOut);
    await page.waitForTimeout(1500).catch(() => {});
  }
};

/**
 * Keep a context's sign-in from expiring while nobody uses it: open the app once, signed in, which
 * counts as activity, and save the cookies. Signed out, only a sign-in left in `.env.<context>` helps.
 */
export const keepSignedIn = async (domain: Domain, contexts: Contexts, ctx: Context): Promise<boolean> => {
  try {
    const open = await openSignedIn(domain, contexts, ctx);
    await open.close();
    return true;
  } catch {
    return false;
  }
};
