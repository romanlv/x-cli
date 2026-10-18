import { join } from "node:path";
import type { Page } from "playwright";
import { type Domain, defineDomain, type SignInState } from "../core/domain";
import { InputError } from "../core/errors";
import {
  HANDLE,
  ORIGIN,
  readPosts,
  refusedLoad,
  SEARCH_TABS,
  SEL,
  type SearchTab,
  signedInHandle,
  watchLimits,
  type Xh,
  xHelpers,
} from "./helpers";

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
    const handle = first && !RESERVED.has(first.toLowerCase()) && HANDLE.test(first) ? first.toLowerCase() : undefined;
    return { onX: HOSTS.has(parsed.hostname), handle };
  } catch {
    return { onX: false };
  }
};

/** Is this X's login or sign-up flow? Its path, not the whole URL: an account may be called `logintest`. */
export const isSignInUrl = (url: string): boolean => {
  try {
    return /^\/(login|i\/flow\/(login|signup)|i\/jf\/onboarding)(\/|$)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

/**
 * Signed in shows the side nav's account switcher; signed out lands on the login flow or shows the
 * sign-in buttons. Anything else is unknown, which core asks again: a slow page is not a signed-out one.
 */
const signInState = async (page: Page, contextUrl: string): Promise<SignInState> => {
  const expected = accountOf(contextUrl).handle;
  if (await page.locator(SEL.accountSwitcher).first().isVisible()) {
    if (!accountOf(page.url()).onX) return "elsewhere";
    if (!expected) return "signed-in";
    // The switcher shows before its handle does.
    const actual = await signedInHandle(page);
    if (!actual) return "unknown";
    return actual === expected ? "signed-in" : "elsewhere";
  }
  if (isSignInUrl(page.url())) return "signed-out";
  const signInShown =
    (await page.locator(SEL.signInButtons).first().isVisible()) || (await page.locator('input[type="password"]').first().isVisible());
  return signInShown ? "signed-out" : "unknown";
};

export const xDomain = (overrides: Partial<Domain<Xh>> = {}): Domain<Xh> =>
  defineDomain({
    name: "x",
    dir: import.meta.dir,
    // Spelled out, not the parent of `dir`: the tests' fixture puts `dir` elsewhere and keeps this checkout.
    root: join(import.meta.dir, ".."),
    helpers: xHelpers,
    // X watches for automation and limits each account (knowledge/bot-detection.md): the installed
    // Chrome without the automation switch, one request at a time, no calls of the ops' own, and no
    // keep-alive nudges.
    browserChannel: "chrome",
    hideAutomation: true,
    readOnly: true,
    keepBrowser: true,
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
    // A page whose start-up call X rate limited shows nothing, so the calls say why (helpers, watchLimits).
    async prepareBrowser(context) {
      watchLimits(context);
    },
    async refusal(page) {
      const messages = await xHelpers(page).errors();
      return messages.length ? messages.join("; ") : refusedLoad(page);
    },
    pageCommands: {
      search: {
        usage: `"<query>" [${SEARCH_TABS.join("|")}]  open X search for a query (X's operators work: from:, since:, filter:)`,
        async run({ page }, args) {
          if (!args[0]) throw new InputError('give the query, such as "from:jack bitcoin"');
          const tab = (args[1] ?? "latest") as SearchTab;
          if (!SEARCH_TABS.includes(tab)) throw new InputError(`no tab "${tab}" (tabs: ${SEARCH_TABS.join(", ")})`);
          await xHelpers(page).search(args[0], tab);
          return undefined;
        },
      },
      posts: {
        usage: "[n]  the posts on the page as the helpers read them (the first n, 10 by default)",
        reads: true,
        async run({ page }, args) {
          const n = Number(args[0] ?? 10);
          if (!Number.isInteger(n) || n < 1) throw new InputError(`n is how many posts, a whole number from 1, got "${args[0]}"`);
          const posts = await readPosts(page);
          return JSON.stringify(posts.slice(0, n), null, 2);
        },
      },
    },
    ...overrides,
  });
