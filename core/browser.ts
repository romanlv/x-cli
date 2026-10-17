// Playwright behind the CLI: a browser per call, signed in as the context's saved session, and the
// headed sign-in a person does once per context.
import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { type APIRequestContext, type Browser, type BrowserContext, chromium, type Page, request } from "playwright";
import { type Context, type Contexts, loginHint, savedCredentials } from "./contexts";
import type { Domain } from "./domain";
import { BrowserError, InputError, PreconditionError } from "./errors";
import { type NetworkEntry, recordNetwork } from "./network";
import { progress } from "./output";

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

/**
 * Plain HTTP on the context's saved sign-in, for an op's direct way. With XCLI_BROWSER the calls go
 * out from the host's browser server, as the pages do: a sandbox reaches no network of its own.
 */
export const openHttp = async (ctx: Context, timeout: number): Promise<{ http: APIRequestContext; close(): Promise<void> }> => {
  if (!process.env.XCLI_BROWSER) {
    const http = await request.newContext({ storageState: ctx.authFile, timeout });
    return { http, close: () => http.dispose() };
  }
  const browser = await launch(false);
  const context = await browser.newContext({ storageState: ctx.authFile });
  context.setDefaultTimeout(timeout);
  return { http: context.request, close: () => browser.close() };
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

/**
 * XCLI_BROWSER_CHANNEL: an installed browser to run instead of Playwright's Chromium, such as
 * "chrome", for an app that tells the two apart. Headless, it runs Chrome's own headless mode.
 */
export const launchOptions = (headed: boolean): { headless: boolean; channel?: string } => {
  const channel = process.env.XCLI_BROWSER_CHANNEL;
  return { headless: !headed, ...(channel ? { channel } : {}) };
};

/** XCLI_BROWSER: a browser on the host, for a sandboxed build, where Chromium can't start. */
export const launch = async (headed: boolean): Promise<Browser> => {
  try {
    const endpoint = process.env.XCLI_BROWSER;
    if (endpoint) return await chromium.connect(endpoint);
    const options = launchOptions(headed);
    return await chromium.launch(options).catch(async (err: Error) => {
      if (!options.channel || !/is not found|not installed/i.test(err.message)) throw err;
      progress(`› no ${options.channel} installed; using Playwright's Chromium`);
      return chromium.launch({ headless: !headed });
    });
  } catch (err) {
    throw new BrowserError(`the browser would not start: ${(err as Error).message.split("\n")[0]}`);
  }
};

/**
 * A browser on the context's saved sign-in, at its URL, checked to be signed in to that tenant and
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
    if (!(err instanceof SignedOut) || !(await signInSaved(domain, contexts, ctx))) throw err;
    return { ...(await openOnce(domain, contexts, contexts.get(ctx.name), options)), signedInNow: true };
  }
};

/** Signed out, a context whose person left their sign-in in `.env.<context>` signs in again by itself. */
export const signInSaved = async (domain: Domain, contexts: Contexts, ctx: Context): Promise<boolean> => {
  const credentials = savedCredentials(domain.root, ctx.name);
  if (!credentials || !domain.submitSignIn) return false;
  await signIn(domain, contexts, ctx, { credentials });
  return true;
};

const openOnce = async (
  domain: Domain,
  contexts: Contexts,
  ctx: Context,
  { headed = false, network: recording = {} }: { headed?: boolean; network?: Parameters<typeof recordNetwork>[1] },
): Promise<OpenBrowser> => {
  const login = [loginHint(domain.name, ctx.name)];
  if (!existsSync(ctx.authFile)) throw new SignedOut(`context "${ctx.name}" is signed out`, login);

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
      throw new PreconditionError(`could not reach ${ctx.appUrl}: ${(err as Error).message.split("\n")[0]}`);
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
        `the saved session for "${ctx.name}" is signed in to another tenant than ${ctx.appUrl}; refusing to run`,
        login,
      );
    }
    await saveSession(context, ctx).catch(() => {});
    return { browser, context, page, network, close };
  } catch (err) {
    await close();
    throw err;
  }
};

/**
 * A person signs in, SSO and MFA included, in a headed browser; the session is saved for the context.
 * With `credentials`, the form is filled and submitted for them, headless, and they are never saved.
 */
export const signIn = async (
  domain: Domain,
  contexts: Contexts,
  ctx: Context,
  {
    timeoutMs,
    headless = false,
    credentials,
  }: { timeoutMs?: number; headless?: boolean; credentials?: { username: string; password: string } } = {},
): Promise<void> => {
  if (credentials && !domain.submitSignIn) throw new InputError(`${domain.name} has no sign-in with a username and password`);
  const wait = timeoutMs ?? (credentials ? 2 * 60_000 : 10 * 60_000);
  const browser = await launch(!(headless || credentials));
  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    await page.goto(ctx.url, { waitUntil: "domcontentloaded" });
    if (credentials) {
      progress(`signing in to ${ctx.url} as ${credentials.username}`);
      await domain.submitSignIn!(page, credentials);
    } else progress(`sign in to ${ctx.url} in the browser window; waiting up to ${Math.round(wait / 60_000)} minutes`);
    const deadline = Date.now() + wait;
    // A form still asking for the password well after it was sent turned it down.
    const refusedBy = Date.now() + Number(process.env.XCLI_SIGNIN_WAIT_MS ?? 20_000);
    const password = page.locator('input[type="password"]').first();
    for (;;) {
      if (page.isClosed()) throw new PreconditionError("the sign-in window was closed before signing in");
      const state = await domain.signInState(page, ctx.url).catch(() => "unknown" as const);
      if (state === "signed-in") break;
      if (credentials && state === "signed-out" && Date.now() > refusedBy && (await password.isVisible().catch(() => false)))
        throw new PreconditionError(`the sign-in as ${credentials.username} was turned down: check the username and password`);
      if (state === "elsewhere") throw new PreconditionError(`signed in to another tenant than ${ctx.url}`);
      if (Date.now() > deadline)
        throw new PreconditionError(
          credentials
            ? `the sign-in as ${credentials.username} didn't finish: a wrong password, or a second step (MFA, SSO) that needs the window`
            : "timed out waiting for the sign-in",
        );
      await page.waitForTimeout(1500).catch(() => {});
    }
    await saveSession(context, ctx);
    contexts.markSignedIn(ctx.name, domain.appUrl?.(page.url(), ctx.url) ?? page.url());
  } finally {
    await browser.close().catch(() => {});
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
