// Playwright moves every X page shares. Ops call these as `app`; an op that needs a move that isn't
// here yet adds it here once it holds for every page, not in its own op.ts.
//
// X marks its controls with data-testid, which these target first. The ids here are a seed from
// general knowledge of x.com, written before the reference op was built against a real account:
// see knowledge/x.md for which have been confirmed.
import type { Page } from "playwright";
import { InputError, PreconditionError, RefusedError } from "../../core/errors";

export const ORIGIN = "https://x.com";

/** An X handle: letters, digits and _, at most 15. */
export const HANDLE = /^\w{1,15}$/;

/** X search's tabs, each a filter of its results. */
export const SEARCH_TABS = ["top", "latest", "people", "media"] as const;
export type SearchTab = (typeof SEARCH_TABS)[number];

export const SEL = {
  accountSwitcher: '[data-testid="SideNav_AccountSwitcher_Button"]',
  signInButtons: '[data-testid="loginButton"], [data-testid="login"]',
  primaryColumn: '[data-testid="primaryColumn"]',
  post: 'article[data-testid="tweet"]',
  postText: '[data-testid="tweetText"]',
  userName: '[data-testid="User-Name"]',
  emptyState: '[data-testid="emptyState"]',
  toast: '[data-testid="toast"]',
  /** The message a timeline shows in place of posts when a call behind it failed. */
  errorDetail: '[data-testid="error-detail"]',
} as const;

/** Messages that mean X turned the account away, not that the op is broken. */
const REFUSALS = [/rate limit/i, /your account is (locked|suspended|temporarily limited)/i];

export interface Post {
  url: string;
  id: string;
  author: string;
  handle: string;
  time?: string;
  text: string;
  replies?: number;
  reposts?: number;
  likes?: number;
  views?: number;
}

/** "1,204 Likes. Like" or "12K" → a number; X writes counts in its buttons' aria-labels. */
const count = (label: string | null | undefined): number | undefined => {
  const m = label?.match(/([\d.,]+)\s*([KkMm])?/);
  if (!m) return undefined;
  const n = Number(m[1]!.replace(/,/g, ""));
  return m[2] ? Math.round(n * (/k/i.test(m[2]) ? 1_000 : 1_000_000)) : n;
};

/** The posts rendered on the page now, in order. X virtualises timelines: only what is near the viewport is in the DOM. */
export const readPosts = async (page: Page): Promise<Post[]> => {
  const raw = await page.locator(SEL.post).evaluateAll(
    (articles, sel) =>
      articles.map((a) => {
        const link = a.querySelector('a[href*="/status/"] time')?.closest("a") as HTMLAnchorElement | null;
        const names = (a.querySelector(sel.userName)?.textContent ?? "").split("@");
        const label = (testid: string) => a.querySelector(`[data-testid="${testid}"]`)?.getAttribute("aria-label");
        return {
          href: link?.getAttribute("href") ?? "",
          time: a.querySelector("time")?.getAttribute("datetime") ?? undefined,
          author: names[0]?.trim() ?? "",
          handle: (names[1] ?? "").split(/[·\s]/)[0] ?? "",
          text: (a.querySelector(sel.postText) as HTMLElement | null)?.innerText ?? "",
          replies: label("reply"),
          reposts: label("retweet") ?? label("unretweet"),
          likes: label("like") ?? label("unlike"),
          views: a.querySelector('a[href$="/analytics"]')?.getAttribute("aria-label"),
        };
      }),
    { userName: SEL.userName, postText: SEL.postText },
  );
  return raw
    .filter((r) => r.href)
    .map((r) => ({
      url: new URL(r.href, ORIGIN).toString(),
      id: r.href.match(/status\/(\d+)/)?.[1] ?? "",
      author: r.author,
      handle: r.handle,
      time: r.time,
      text: r.text,
      replies: count(r.replies),
      reposts: count(r.reposts),
      likes: count(r.likes),
      views: count(r.views),
    }));
};

/** A pause a person might take, 2 to 6 s; X watches for machine-regular timing. */
const pause = (page: Page) => page.waitForTimeout(2_000 + Math.random() * 4_000);

/** X's GraphQL error codes that mean the account, not the op: 88 rate limited, 326 locked (an Arkose challenge). */
const ACCOUNT_ERRORS: Record<number, string> = {
  88: "rate limited",
  326: "the account is locked: sign in by hand and clear X's challenge",
};

/** When a rate limit resets, from the response's x-rate-limit-reset (epoch seconds). */
const resetAt = (headers: Record<string, string>): string => {
  const reset = Number(headers["x-rate-limit-reset"]);
  return reset ? `; it resets at ${new Date(reset * 1000).toISOString()}` : "";
};

export const xHelpers = (page: Page) => {
  const helpers = {
    page,

    /** Open a path on x.com and wait for its main column. */
    async open(path: string): Promise<void> {
      await page.goto(new URL(path, ORIGIN).toString(), { waitUntil: "domcontentloaded" });
      await page.locator(SEL.primaryColumn).first().waitFor({ state: "visible", timeout: 30_000 });
      const refused = await helpers.errors();
      if (refused.length) throw new RefusedError(refused.join("; "));
    },

    /** X search for a query, on a tab. Its operators (from:, to:, since:, until:, filter:, min_faves:) go in the query. */
    async search(query: string, tab: SearchTab = "latest"): Promise<void> {
      const f = { top: "", latest: "&f=live", people: "&f=user", media: "&f=media" }[tab];
      await helpers.open(`/search?q=${encodeURIComponent(query)}&src=typed_query${f}`);
    },

    /** A profile, by handle; a handle that isn't there is a precondition, not the op's fault. */
    async profile(handle: string): Promise<void> {
      const clean = handle.replace(/^@/, "");
      if (!HANDLE.test(clean)) throw new InputError(`"${handle}" is not an X handle (letters, digits and _, at most 15)`);
      await helpers.open(`/${clean}`);
      if (
        await page
          .getByText(/this account doesn.t exist/i)
          .isVisible()
          .catch(() => false)
      )
        throw new PreconditionError(`no account @${clean}`);
    },

    /**
     * Scroll the timeline on the page, collecting posts until there are `limit`, or until scrolling
     * brings nothing new a few times running. Paced like a person reading, never faster.
     */
    async posts({ limit = 20, until }: { limit?: number; until?: (post: Post) => boolean } = {}): Promise<Post[]> {
      const seen = new Map<string, Post>();
      await page
        .locator(`${SEL.post}, ${SEL.emptyState}`)
        .first()
        .waitFor({ state: "visible", timeout: 20_000 })
        .catch(() => {});
      for (let idle = 0; idle < 3 && seen.size < limit; ) {
        const before = seen.size;
        for (const post of await readPosts(page)) {
          if (seen.has(post.url)) continue;
          if (until?.(post)) return [...seen.values()];
          seen.set(post.url, post);
        }
        // Enough: another scroll would only fetch more of the timeline from X.
        if (seen.size >= limit) break;
        idle = seen.size === before ? idle + 1 : 0;
        await page.mouse.wheel(0, 1800);
        await pause(page);
      }
      return [...seen.values()].slice(0, limit);
    },

    /**
     * The JSON of the GraphQL call (`SearchTimeline`, `UserTweets`, `TweetDetail`, ...) the page makes
     * while `act` runs: X's own app sends it, with its signature, current query id and Chrome's
     * fingerprint, so an op reads what the screen is drawn from without making calls of its own. A
     * rate limit or a locked account is `RefusedError`, never retried.
     */
    async graphql<T = unknown>(operation: string, act: () => Promise<unknown>, timeout = 30_000): Promise<T> {
      const match = new RegExp(`/i/api/graphql/[^/]+/${operation}(\\?|$)`);
      const [response] = await Promise.all([page.waitForResponse((r) => match.test(r.url()), { timeout }), act()]);
      const headers = response.headers();
      if (response.status() === 429) throw new RefusedError(`X rate limited ${operation}${resetAt(headers)}`);
      const body = (await response.json().catch(() => undefined)) as { errors?: { code?: number; message?: string }[] } | undefined;
      const code = body?.errors?.map((e) => e.code).find((c) => c !== undefined && c in ACCOUNT_ERRORS);
      if (code !== undefined) throw new RefusedError(`X: ${ACCOUNT_ERRORS[code]} (${operation}, code ${code})${resetAt(headers)}`);
      if (!response.ok() || !body) throw new Error(`${operation} answered ${response.status()} ${body ? "" : "without JSON"}`.trim());
      return body as T;
    },

    /** What X shows when it turns the account away: a rate limit, a locked account. Only its own messages, never a post's text. */
    async errors(): Promise<string[]> {
      const text = await page
        .locator(`${SEL.toast}, ${SEL.errorDetail}`)
        .allInnerTexts()
        .catch(() => [] as string[]);
      return text.flatMap((t) => REFUSALS.filter((re) => re.test(t)).map((re) => t.match(re)![0]));
    },
  };
  return helpers;
};

export type Xh = ReturnType<typeof xHelpers>;
