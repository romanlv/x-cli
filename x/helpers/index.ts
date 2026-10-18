// Playwright moves every X page shares. Ops call these as `app`; an op that needs a move that isn't
// here yet adds it here once it holds for every page, not in its own op.ts.
//
// X marks its controls with data-testid, which these target first. The ids here are a seed from
// general knowledge of x.com, written before the reference op was built against a real account:
// see knowledge/x.md for which have been confirmed.
import type { Page, Response } from "playwright";
import { InputError, PreconditionError, RefusedError } from "../../core/errors";
import { type Article, entryFromArticle } from "../map/dom";
import { postsPage, threadOf, userFromResult } from "../map/graphql";
import { type Entry, postOf, type Thread, type User, type UserUnavailable, type Page as XPage } from "../model";

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
  /** One row of a virtualised timeline: a post, or what X shows in its place. */
  cell: '[data-testid="cellInnerDiv"]',
  /** The line above a post: "Ada reposted", "Pinned". */
  socialContext: '[data-testid="socialContext"]',
  showMore: '[data-testid="tweet-text-show-more-link"]',
  /** A post's buttons: their aria-labels hold its counts, and which of a pair shows is the account's own state. */
  buttons: ["reply", "retweet", "unretweet", "like", "unlike", "bookmark", "removeBookmark"]
    .map((id) => `[data-testid="${id}"]`)
    .join(", "),
  emptyState: '[data-testid="emptyState"]',
  toast: '[data-testid="toast"]',
  /** The message a timeline shows in place of posts when a call behind it failed. */
  errorDetail: '[data-testid="error-detail"]',
} as const;

/** Messages that mean X turned the account away, not that the op is broken. */
const REFUSALS = [/rate limit/i, /your account is (locked|suspended|temporarily limited)/i];

/** The cells of the timeline rendered now, read in the browser; `entryFromArticle` maps each. */
const readArticles = (page: Page): Promise<Article[]> =>
  page.locator(`${SEL.post}, ${SEL.cell}`).evaluateAll(
    (els, sel) =>
      els.flatMap((el): Article[] => {
        if (el.matches(sel.cell)) {
          // A cell with a post in it is read through its article; one without may be a tombstone.
          if (el.querySelector(sel.post)) return [];
          const text = (el as HTMLElement).innerText.trim();
          return /\bthis post\b/i.test(text) && text.length < 300 ? [{ labels: {}, tombstone: text }] : [];
        }
        const names = el.querySelectorAll(sel.userName);
        // An embedded quote has a User-Name of its own; the post's parts are the ones outside it.
        const quote = names[1]?.closest('[role="link"]') ?? undefined;
        const own = (s: string) => [...el.querySelectorAll<HTMLElement>(s)].find((x) => !quote?.contains(x));
        const inQuote = (s: string) => quote?.querySelector<HTMLElement>(s) ?? undefined;
        const text = own(sel.postText);
        const labels: Record<string, string> = {};
        for (const b of el.querySelectorAll(sel.buttons)) {
          const id = b.getAttribute("data-testid");
          if (id && !quote?.contains(b)) labels[id] = b.getAttribute("aria-label") ?? "";
        }
        const context = own(sel.socialContext);
        return [
          {
            href: own("a[href*='/status/'] time")?.closest("a")?.getAttribute("href") ?? undefined,
            time: own("time")?.getAttribute("datetime") ?? undefined,
            name: names[0]?.querySelector<HTMLElement>("a")?.innerText.trim(),
            text: text?.innerText,
            lang: text?.getAttribute("lang") ?? undefined,
            showMore: !!own(sel.showMore),
            labels,
            views: own("a[href$='/analytics']")?.getAttribute("aria-label") ?? undefined,
            context: context ? { text: context.innerText, href: context.closest("a")?.getAttribute("href") ?? undefined } : undefined,
            quote: quote
              ? {
                  href: inQuote("a[href*='/status/']")?.getAttribute("href") ?? undefined,
                  name: names[1]?.querySelector<HTMLElement>("span")?.innerText.trim(),
                  text: inQuote(sel.postText)?.innerText,
                  time: inQuote("time")?.getAttribute("datetime") ?? undefined,
                  lang: inQuote(sel.postText)?.getAttribute("lang") ?? undefined,
                }
              : undefined,
          },
        ];
      }),
    SEL,
  );

/**
 * The entries rendered on the page now, in order, as the DOM shows them (`source: "dom"`): posts,
 * reposts, and tombstones where X draws one. X virtualises timelines: only what is near the viewport
 * is in the DOM.
 */
export const readPosts = async (page: Page): Promise<Entry[]> => (await readArticles(page)).flatMap((a) => entryFromArticle(a) ?? []);

/** Where a read stops: at most `limit` entries, and before the post `until` (a post id; it is not included). */
export interface Bound {
  limit?: number;
  until?: string;
}

/**
 * Entries once each, in the order read, until `limit` or the `until` post. A tombstone the DOM shows
 * has no id, so it is known by the entry before it.
 */
const gather = ({ limit = 20, until }: Bound) => {
  const seen = new Map<string, Entry>();
  let reachedUntil = false;
  return {
    /** Adds one read's entries; true once the read has what it needs. */
    add(entries: Entry[]): boolean {
      let previous = "";
      for (const e of entries) {
        const id = e.kind === "repost" ? (e.id ?? postOf(e).id) : e.id;
        if (until && (id === until || postOf(e).id === until)) {
          reachedUntil = true;
          break;
        }
        previous = id ? `${e.kind}:${id}` : `${e.kind}@${previous}`;
        if (!seen.has(previous)) seen.set(previous, e);
      }
      return reachedUntil || seen.size >= limit;
    },
    get size() {
      return seen.size;
    },
    /**
     * What was read, cut to `limit`; `more` when there was more past it. No cursor: an op resumes
     * from an id, never from X's cursor, and a cursor past a cut page would skip what was cut.
     */
    page(moreAfter?: boolean): XPage<Entry> {
      const items = [...seen.values()].slice(0, limit);
      return seen.size > limit || (!reachedUntil && moreAfter) ? { items, more: true } : { items };
    },
  };
};

/** A pause a person might take, 2 to 6 s; X watches for machine-regular timing. */
const pause = (page: Page) => page.waitForTimeout(2_000 + Math.random() * 4_000);

/** A person's scroll down a timeline, then a pause to read. */
const scroll = async (page: Page) => {
  await page.mouse.wheel(0, 1800);
  await pause(page);
};

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

const callOf = (operation: string) => new RegExp(`/i/api/graphql/[^/]+/${operation}(\\?|$)`);

/** A GraphQL response's JSON; a rate limit or a locked account is `RefusedError`, never retried. */
const bodyOf = async (operation: string, response: Response): Promise<unknown> => {
  const headers = response.headers();
  if (response.status() === 429) throw new RefusedError(`X rate limited ${operation}${resetAt(headers)}`);
  const body = (await response.json().catch(() => undefined)) as { errors?: { code?: number; message?: string }[] } | undefined;
  const code = body?.errors?.map((e) => e.code).find((c) => c !== undefined && c in ACCOUNT_ERRORS);
  if (code !== undefined) throw new RefusedError(`X: ${ACCOUNT_ERRORS[code]} (${operation}, code ${code})${resetAt(headers)}`);
  if (!response.ok() || !body) throw new Error(`${operation} answered ${response.status()} ${body ? "" : "without JSON"}`.trim());
  return body;
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
     * The timeline on the page as the DOM shows it, scrolled and collected until `limit` entries or
     * the `until` post, or until scrolling brings nothing new a few times running. Paced like a person
     * reading, never faster. `app.timeline` reads the same from GraphQL, with more in each entry.
     */
    async posts(bound: Bound = {}): Promise<XPage<Entry>> {
      const read = gather(bound);
      await page
        .locator(`${SEL.post}, ${SEL.emptyState}`)
        .first()
        .waitFor({ state: "visible", timeout: 20_000 })
        .catch(() => {});
      for (let idle = 0; idle < 3; ) {
        const before = read.size;
        // Enough: another scroll would only fetch more of the timeline from X.
        if (read.add(await readPosts(page))) break;
        idle = read.size === before ? idle + 1 : 0;
        await scroll(page);
      }
      return read.page();
    },

    /**
     * The JSON of the GraphQL call (`SearchTimeline`, `UserTweets`, `TweetDetail`, ...) the page makes
     * while `act` runs: X's own app sends it, with its signature, current query id and Chrome's
     * fingerprint, so an op reads what the screen is drawn from without making calls of its own. A
     * rate limit or a locked account is `RefusedError`, never retried. `timeline`, `thread` and
     * `user` map it to the model; this is for a call they don't cover.
     */
    async graphql<T = unknown>(operation: string, act: () => Promise<unknown>, timeout = 30_000): Promise<T> {
      const match = callOf(operation);
      const [response] = await Promise.all([page.waitForResponse((r) => match.test(r.url()), { timeout }), act()]);
      return (await bodyOf(operation, response)) as T;
    },

    /**
     * The posts of a timeline call (`SearchTimeline`, `UserTweets`, `Bookmarks`, `Likes`, ...) that
     * `open` makes the page send, then of the calls scrolling sends, at a person's pace, until `limit`
     * entries or the `until` post, or until X has no more. Every response is kept as it comes, so a
     * page that lands between scrolls is not lost.
     */
    async timeline(operation: string, open: () => Promise<unknown>, bound: Bound = {}, timeout = 30_000): Promise<XPage<Entry>> {
      const match = callOf(operation);
      const responses: Response[] = [];
      const listen = (r: Response) => {
        if (match.test(r.url())) responses.push(r);
      };
      page.on("response", listen);
      try {
        const read = gather(bound);
        await open();
        if (!responses.length) await page.waitForResponse((r) => match.test(r.url()), { timeout });
        let more: boolean | undefined;
        let done = false;
        for (let used = 0, idle = 0; idle < 3; ) {
          const before = used;
          while (!done && used < responses.length) {
            const got = postsPage(await bodyOf(operation, responses[used++]!));
            more = got.more;
            done = read.add(got.items) || more === false;
          }
          if (done) break;
          idle = used === before ? idle + 1 : 0;
          await scroll(page);
        }
        return read.page(more);
      } finally {
        page.off("response", listen);
      }
    },

    /** A post with its ancestors and replies, from the TweetDetail call its page makes. */
    async thread(id: string): Promise<Thread> {
      if (!/^\d+$/.test(id)) throw new InputError(`"${id}" is not a post id (digits, as in a post's URL)`);
      return threadOf(await helpers.graphql("TweetDetail", () => helpers.open(`/i/status/${id}`)), id);
    },

    /** An account, from the UserByScreenName call its profile makes. A suspended account is `UserUnavailable`. */
    async user(handle: string): Promise<User | UserUnavailable> {
      const json = await helpers.graphql<{ data?: { user?: { result?: unknown } } }>("UserByScreenName", () => helpers.profile(handle));
      const user = userFromResult(json.data?.user?.result);
      if (!user) throw new PreconditionError(`no account @${handle.replace(/^@/, "")}`);
      return user;
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
