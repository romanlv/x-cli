// Playwright behind the CLI: a browser per call, signed in as the context's saved session, and the
// headed sign-in a person does once per context.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Browser, type BrowserContext, chromium, type LaunchOptions, type Page, selectors } from "playwright";
import { type Context, type Contexts, loginHint } from "./contexts";
import { type Credentials, type SignInWait, savedCredentials, submitCredentials } from "./credentials";
import type { Domain, SignInState } from "./domain";
import { envNumber, envValue } from "./env";
import { BrowserError, InputError, PreconditionError } from "./errors";
import { type NetworkEntry, recordNetwork } from "./network";
import { firstLine, progress } from "./output";
import { browserBinary, type PlainBrowser, startPlain, type Tab } from "./plain-browser";

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
/** How long a loaded page may take to show the app signed in or a sign-in. */
const SIGNIN_WAIT_MS = envNumber("SIGNIN_WAIT_MS", 15_000);

/**
 * A browser context on the context's saved sign-in, set up as the domain sets up every one that is
 * signed in, so no page of it signs out the sign-in the others share.
 */
export const signedInContext = async (browser: Browser, domain: Domain, ctx: Context): Promise<BrowserContext> => {
  const userAgent = domain.hideAutomation ? await headedUserAgent(browser) : undefined;
  const context = await browser.newContext({ storageState: ctx.authFile, viewport: VIEWPORT, userAgent });
  await domain.prepareBrowser?.(context);
  return context;
};

/** The browser's user agent without the `HeadlessChrome` a headless one names itself by. */
const headedUserAgent = async (browser: Browser): Promise<string | undefined> => {
  const cdp = await browser.newBrowserCDPSession().catch(() => undefined);
  const version = await cdp?.send("Browser.getVersion").catch(() => undefined);
  await cdp?.detach().catch(() => {});
  return version?.userAgent.replace("HeadlessChrome/", "Chrome/");
};

/**
 * Whether the page is signed in, asked of the domain again while it can't tell, up to
 * SIGNIN_WAIT_MS: a slow page is not a signed-out one.
 */
export const signInStateOf = async (domain: Domain, page: Page, contextUrl: string): Promise<SignInState> => {
  const deadline = Date.now() + SIGNIN_WAIT_MS;
  for (;;) {
    const state = await domain.signInState(page, contextUrl).catch(() => "unknown" as const);
    if (state !== "unknown" || page.isClosed() || Date.now() > deadline) return state;
    await page.waitForTimeout(250).catch(() => {});
  }
};

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
 * Playwright's Chromium when that one isn't installed. With XCLI_HIDE_AUTOMATION, without the
 * automation switch, so pages see `navigator.webdriver` false.
 */
export const launchWith = async <T>(headed: boolean, start: (options: LaunchOptions) => Promise<T>): Promise<T> => {
  const options: LaunchOptions = envValue("HIDE_AUTOMATION")
    ? { headless: !headed, ignoreDefaultArgs: ["--enable-automation"], args: ["--disable-blink-features=AutomationControlled"] }
    : { headless: !headed };
  const channel = envValue("BROWSER_CHANNEL");
  if (!channel) return start(options);
  return start({ ...options, channel }).catch((err: Error) => {
    if (!/is not found|not installed/i.test(err.message)) throw err;
    progress(`› no ${channel} installed; using Playwright's Chromium`);
    return start(options);
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
    const context = await signedInContext(browser, domain, ctx);
    const network = recordNetwork(context, recording);
    const page = await context.newPage();
    try {
      await page.goto(ctx.appUrl, { waitUntil: "domcontentloaded" });
    } catch (err) {
      throw new PreconditionError(`could not reach ${ctx.appUrl}: ${firstLine((err as Error).message)}`);
    }
    const state = await signInStateOf(domain, page, ctx.appUrl);
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
 * A person signs in, SSO and MFA included, in the window; the session is saved for the context.
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
  if (!credentials) return signInByHand(domain, contexts, ctx, { timeoutMs, headless });
  const browser = await launch(false);
  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    await page.goto(ctx.url, { waitUntil: "domcontentloaded" });
    await waitForSignIn(domain, page, ctx.url, await submitCredentials(submit!, page, ctx.url, credentials, timeoutMs));
    await signedIn(domain, contexts, ctx, context, page);
  } finally {
    await browser.close().catch(() => {});
  }
};

const signedIn = async (domain: Domain, contexts: Contexts, ctx: Context, context: BrowserContext, page: Page): Promise<void> => {
  await saveSession(context, ctx);
  await saveUserAgent(page, ctx);
  contexts.markSignedIn(ctx.name, domain.appUrl?.(page.url(), ctx.url) ?? page.url());
};

/** When a tab that stays on one page is looked at again while a person signs in, by what the last look found. */
const LOOK_AGAIN_MS = { unknown: 3000, other: 30_000 };

/**
 * Signing in by hand happens in the installed browser started as itself (`plain-browser.ts`), in a
 * profile kept for the context, so the app sees the same ordinary browser each time. Nothing drives
 * it: core lists its tabs, and attaches for one look at whether one is signed in only once the tab
 * has held still on a page that isn't one of the app's sign-in pages (`signInPage`).
 */
const signInByHand = async (
  domain: Domain,
  contexts: Contexts,
  ctx: Context,
  { timeoutMs = 10 * 60_000, headless }: { timeoutMs?: number; headless: boolean },
): Promise<void> => {
  const plain = await startPlain(browserBinary(envValue("BROWSER_CHANNEL")), {
    profileDir: join(dirname(ctx.authFile), "browser"),
    url: ctx.url,
    headless,
    size: VIEWPORT,
  });
  try {
    progress(`sign in to ${ctx.url} in the browser window; waiting up to ${Math.round(timeoutMs / 60_000)} minutes`);
    const deadline = Date.now() + timeoutMs;
    const nextLook = new Map<string, number>();
    let last = "";
    for (;;) {
      if (plain.closed()) throw new PreconditionError("the sign-in window was closed before signing in");
      if (Date.now() > deadline) throw new PreconditionError("timed out waiting for the sign-in");
      const tabs = await plain.tabs().catch(() => []);
      const urls = tabs.map((t) => t.url).join("\n");
      const still = urls === last;
      last = urls;
      const ready = still ? tabs.filter((t) => !domain.signInPage?.(t.url) && Date.now() >= (nextLook.get(t.url) ?? 0)) : [];
      if (ready.length && (await lookForSignIn(domain, contexts, ctx, plain, ready, nextLook))) return;
      await Bun.sleep(1000);
    }
  } finally {
    await plain.close();
  }
};

/**
 * Attach, look once at whether each tab is signed in, save the sign-in when one is, and detach.
 * One look, not a wait: a page still loading is looked at again soon, by then perhaps a sign-in page.
 */
const lookForSignIn = async (
  domain: Domain,
  contexts: Contexts,
  ctx: Context,
  plain: PlainBrowser,
  tabs: Tab[],
  nextLook: Map<string, number>,
): Promise<boolean> => {
  const browser = await plain.attach().catch(() => undefined);
  if (!browser) return false;
  try {
    const context = browser.contexts()[0];
    const urls = new Set(tabs.map((t) => t.url));
    for (const page of context?.pages() ?? []) {
      const url = page.url();
      if (!urls.has(url)) continue;
      const state = await domain.signInState(page, ctx.url).catch(() => "unknown" as const);
      if (state === "elsewhere") throw new PreconditionError(`signed in elsewhere than ${ctx.url} (another account or tenant)`);
      if (state === "signed-in") {
        await signedIn(domain, contexts, ctx, context!, page);
        return true;
      }
      nextLook.set(url, Date.now() + (state === "unknown" ? LOOK_AGAIN_MS.unknown : LOOK_AGAIN_MS.other));
    }
    return false;
  } finally {
    // Detaches; the browser stays open.
    await browser.close().catch(() => {});
  }
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
