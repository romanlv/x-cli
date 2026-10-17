import { join } from "node:path";
import type { Page } from "playwright";
import { type Domain, defineDomain, type SignInState } from "../core/domain";
import { envNumber } from "../core/env";
import { readPosts, SEL, type Xh, xHelpers } from "./helpers";

const ORIGIN = "https://x.com";
const HOSTS = new Set(["x.com", "twitter.com", "mobile.x.com", "mobile.twitter.com"]);
/** First path segments that are X's own pages, not an account's handle. */
const RESERVED = new Set([
  "home",
  "i",
  "login",
  "logout",
  "signup",
  "explore",
  "search",
  "notifications",
  "messages",
  "settings",
  "compose",
  "tos",
  "privacy",
  "account",
]);

/**
 * A context is an X account: `https://x.com/<handle>` names the one its sign-in must be, and plain
 * `https://x.com` takes whichever account signs in. Handles compare case-insensitively.
 */
export const accountOf = (url: string): { onX: boolean; handle?: string } => {
  try {
    const parsed = new URL(url);
    const first = parsed.pathname.split("/").filter(Boolean)[0];
    const handle = first && !RESERVED.has(first.toLowerCase()) && /^\w{1,15}$/.test(first) ? first.toLowerCase() : undefined;
    return { onX: HOSTS.has(parsed.hostname), handle };
  } catch {
    return { onX: false };
  }
};

/** The handle of the account the page is signed in as, from the side nav's account switcher. */
const signedInHandle = async (page: Page): Promise<string | undefined> => {
  const text = await page
    .locator(SEL.accountSwitcher)
    .first()
    .textContent()
    .catch(() => null);
  return text?.match(/@(\w{1,15})/)?.[1]?.toLowerCase();
};

/**
 * Signed in shows the side nav's account switcher; signed out lands on the login flow or shows the
 * sign-in buttons. Anything else, after the wait, is unknown: a slow page is not a signed-out one.
 */
const signInState = async (page: Page, contextUrl: string): Promise<SignInState> => {
  const expected = accountOf(contextUrl).handle;
  const switcher = page.locator(SEL.accountSwitcher).first();
  const signInButtons = page.locator(SEL.signInButtons).first();
  const password = page.locator('input[type="password"]').first();
  const deadline = Date.now() + envNumber("SIGNIN_WAIT_MS", 15_000);
  for (;;) {
    const at = accountOf(page.url());
    if (await switcher.isVisible().catch(() => false)) {
      if (!at.onX) return "elsewhere";
      if (!expected) return "signed-in";
      const actual = await signedInHandle(page);
      if (!actual) return "unknown";
      return actual === expected ? "signed-in" : "elsewhere";
    }
    if (/\/(login|i\/flow\/(login|signup))/.test(page.url())) return "signed-out";
    if ((await signInButtons.isVisible().catch(() => false)) || (await password.isVisible().catch(() => false))) return "signed-out";
    if (Date.now() > deadline) return "unknown";
    await page.waitForTimeout(250).catch(() => {});
  }
};

const TABS = ["top", "latest", "people", "media"] as const;

export const xDomain = (overrides: Partial<Domain<Xh>> = {}): Domain<Xh> =>
  defineDomain({
    name: "x",
    dir: import.meta.dir,
    root: join(import.meta.dir, ".."),
    helpers: (page) => xHelpers(page),
    // X watches for automation and limits each account (knowledge/bot-detection.md): the installed
    // Chrome, one request at a time, no calls of the ops' own, and no keep-alive nudges.
    browserChannel: "chrome",
    maxRunning: 1,
    directCalls: false,
    testIdAttribute: "data-testid",
    signInState,
    // No submitSignIn: X challenges automated logins, so a person always signs in in the window.
    appUrl(_signedInUrl, contextUrl) {
      const { handle } = accountOf(contextUrl);
      // The profile keeps the handle the sign-in check compares against.
      return handle ? `${ORIGIN}/${handle}` : `${ORIGIN}/home`;
    },
    async refusal(page) {
      const messages = await xHelpers(page).errors();
      return messages.length ? messages.join("; ") : undefined;
    },
    pageCommands: {
      search: {
        usage: '"<query>" [top|latest|people|media]  open X search for a query (X\'s operators work: from:, since:, filter:)',
        async run({ page }, args) {
          if (!args[0]) throw new Error('give the query, such as "from:jack bitcoin"');
          const tab = (args[1] ?? "latest") as (typeof TABS)[number];
          if (!TABS.includes(tab)) throw new Error(`no tab "${tab}" (tabs: ${TABS.join(", ")})`);
          await xHelpers(page).search(args[0], tab);
          return undefined;
        },
      },
      posts: {
        usage: "[n]  the posts on the page as the helpers read them (the first n, 10 by default)",
        async run({ page }, args) {
          const posts = await readPosts(page);
          return JSON.stringify(posts.slice(0, Number(args[0] ?? 10)), null, 2);
        },
      },
    },
    ...overrides,
  });
