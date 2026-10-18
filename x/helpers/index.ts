// Playwright moves every X page shares. Ops call these as `app`; an op that needs a move that isn't
// here yet adds it here once it holds for every page, not in its own op.ts.
//
// X marks its controls with data-testid, which these target first. The ids here are a seed from
// general knowledge of x.com, written before the reference op was built against a real account:
// see knowledge/x.md for which have been confirmed.
import type { BrowserContext, Page, Response } from "playwright";
import { InputError, PreconditionError, RefusedError } from "../../core/errors";
import { type Article, entryFromArticle, isPinned } from "../map/dom";
import { clean, hasMore, isEntry, readTimeline, type TimelineItem, threadOf, userFromResult, usersPage } from "../map/graphql";
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
  /** A profile's name and handle above its timeline (inferred). */
  profileName: '[data-testid="UserName"]',
  /** One row of a virtualised timeline: a post, or what X shows in its place. */
  cell: '[data-testid="cellInnerDiv"]',
  /**
   * What X wraps an ad's article in (typefully/minimal-twitter hides `[data-testid="placementTracking"] article`,
   * 2026-08). A video inside a post has one too, so only an article inside it is an ad.
   */
  ad: '[data-testid="placementTracking"]',
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
        if (el.closest(sel.ad)) return [];
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
        const group = [...el.querySelectorAll(sel.buttons)].find((b) => !quote?.contains(b))?.closest('[role="group"]');
        return [
          {
            href: own("a[href*='/status/'] time")?.closest("a")?.getAttribute("href") ?? undefined,
            time: own("time")?.getAttribute("datetime") ?? undefined,
            name: names[0]?.querySelector<HTMLElement>("a")?.innerText.trim(),
            text: text?.innerText,
            lang: text?.getAttribute("lang") ?? undefined,
            showMore: !!own(sel.showMore),
            labels,
            group: group?.getAttribute("aria-label") ?? undefined,
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

/** One entry as a read found it, and where it sits when that is out of the timeline's order. */
export interface Cell {
  entry: Entry;
  /** X put it above the timeline (a profile's pinned post). It never stops a read. */
  pinned?: boolean;
  /**
   * It is above a newer post of its conversation module, which X lays out oldest first (a parent
   * above its reply, a self-thread's 1/ above 2/). Only a module's newest post is in the timeline's
   * order, so this one never stops a read, and is left out when it is the `until` post.
   */
  earlier?: boolean;
}

const readCells = async (page: Page): Promise<Cell[]> =>
  (await readArticles(page)).flatMap((a) => {
    const entry = entryFromArticle(a);
    return entry ? [clean({ entry, pinned: isPinned(a) || undefined })] : [];
  });

/**
 * The entries rendered on the page now, in order, as the DOM shows them (`source: "dom"`): posts,
 * reposts, and tombstones where X draws one; ads are left out. X virtualises timelines: only what is
 * near the viewport is in the DOM.
 */
export const readPosts = async (page: Page): Promise<Entry[]> => (await readCells(page)).map((c) => c.entry);

/** Scrolls one call makes at most (bot-detection.md, recommendation 5). */
const MAX_SCROLLS = 10;

/** Where a read stops: at most `limit` entries, before the post `until`, after at most `scrolls` scrolls. */
export interface Bound {
  limit?: number;
  /** A post id; it is not included. */
  until?: string;
  /**
   * The timeline is newest first by id, so a read stops at the first entry at or before `until`, even
   * when that post was deleted. Otherwise only `until` itself stops it. GraphQL marks the posts of
   * X's conversation modules that are out of order (`Cell.earlier`), so for `timeline` a profile,
   * its replies, a list and search's Latest are newest first. The DOM can't tell, so for `posts` only
   * search's Latest is: a profile shows a self-thread oldest first, on its Posts tab too.
   */
  newestFirst?: boolean;
  /** At most this many scrolls (MAX_SCROLLS); a read cut short by it says `more`. */
  scrolls?: number;
}

/** How `gather` knows an entry again: its kind and id; a DOM repost, which has no id, by its post's. */
const keyOf = (e: Entry) => {
  const id = e.kind === "repost" ? (e.id ?? postOf(e).id) : e.id;
  return id ? `${e.kind}:${id}` : undefined;
};

/**
 * Entries once each, in the order read, until `limit` or the `until` post. A pinned entry is kept and
 * marked, and never stops the read. A tombstone the DOM shows has no id, so it is known by the entry
 * before it. First in a read, it is skipped when the entry after it was seen already (it was read
 * then too); otherwise it follows on from the last entry with an id that the reads before had, so
 * one that ends a read and starts the next is counted once. In the first read, the entry after it names it.
 */
export const gather = ({ limit = 20, until, newestFirst }: Bound) => {
  const seen = new Map<string, Entry>();
  const pinned = new Set<string>();
  let reachedUntil = false;
  /** The key of the last entry with an id read so far. */
  let lastKeyed: string | undefined;
  /** "stop" the read here, "skip" the entry (the until post, out of order), or keep it. */
  const untilOf = ({ entry: e, pinned: pin, earlier }: Cell): "stop" | "skip" | undefined => {
    if (!until || pin) return undefined;
    // A repost is placed by its own id; a DOM repost has none, so by its post's.
    if ((e.id ?? postOf(e).id) === until) return earlier ? "skip" : "stop";
    return newestFirst && !earlier && e.id && BigInt(e.id) <= BigInt(until) ? "stop" : undefined;
  };
  return {
    /**
     * Adds one read's entries; true once the read has what it needs. A module's earlier posts are
     * held until its last: kept with it, or dropped with it when it stops the read.
     */
    add(cells: Cell[]): boolean {
      let previous: string | undefined;
      let skipping = false;
      /** Earlier posts added since the last entry in the timeline's order. */
      let held: string[] = [];
      for (const [i, cell] of cells.entries()) {
        const { entry: e, pinned: pin, earlier } = cell;
        const stop = untilOf(cell);
        if (stop === "stop") {
          reachedUntil = true;
          for (const key of held) seen.delete(key);
          break;
        }
        if (stop === "skip") continue;
        if (!earlier) held = [];
        let key = keyOf(e);
        if (key) skipping = false;
        else if (skipping) continue;
        else if (previous === undefined) {
          const next = cells
            .slice(i + 1)
            .map((c) => keyOf(c.entry))
            .find(Boolean);
          if (next && seen.has(next)) {
            skipping = true;
            continue;
          }
          key = lastKeyed ? `${e.kind}@${lastKeyed}` : `${e.kind}^${next ?? ""}`;
        } else key = `${e.kind}@${previous}`;
        previous = key;
        if (keyOf(e)) lastKeyed = key;
        if (seen.has(key)) continue;
        seen.set(key, e);
        if (earlier) held.push(key);
        if (pin) pinned.add(key);
      }
      return reachedUntil || seen.size >= limit;
    },
    get size() {
      return seen.size;
    },
    /**
     * What was read, cut to `limit`. `more` is true when there was more past it, false when the
     * read reached `until` or `moreAfter` is false (X ended the timeline), absent when unknown. No
     * cursor: an op resumes from an id, never from X's cursor, and a cursor past a cut page would
     * skip what was cut.
     */
    page(moreAfter?: boolean): XPage<Entry> {
      const kept = [...seen].slice(0, limit);
      const pins = kept.flatMap(([key, e]) => (pinned.has(key) && e.id ? [e.id] : []));
      return clean({
        items: kept.map(([, e]) => e),
        more: seen.size > limit ? true : reachedUntil ? false : moreAfter,
        pinned: pins.length ? pins : undefined,
      });
    },
  };
};

/** A pause a person might take, 2 to 6 s; X watches for machine-regular timing. */
const pause = (page: Page) => page.waitForTimeout(2_000 + Math.random() * 4_000);

/**
 * A person's scroll down a timeline, then a pause to read. True when the page ends below the
 * viewport now: X asks for the next page only near the bottom, so a scroll that is not there yet
 * has had no chance to bring one.
 */
const scroll = async (page: Page): Promise<boolean> => {
  // The wheel goes to what is under the pointer: over the timeline, not the page's corner.
  // boundingBox is relative to the viewport, and the column is taller than it: aim at the part in view.
  const column = await page.locator(SEL.primaryColumn).first().boundingBox();
  const view = await page.evaluate(() => innerHeight);
  if (column) {
    const top = Math.max(column.y, 0);
    const bottom = Math.min(column.y + column.height, view);
    if (bottom > top) await page.mouse.move(column.x + column.width / 2, (top + bottom) / 2);
  }
  await page.mouse.wheel(0, 1800);
  await pause(page);
  return page.evaluate(() => scrollY + innerHeight >= document.documentElement.scrollHeight - 200);
};

/** X's GraphQL error codes that mean the account, not the op: 88 rate limited, 326 locked (an Arkose challenge). */
const ACCOUNT_ERRORS: Record<number, string> = {
  88: "rate limited",
  326: "the account is locked: sign in by hand and clear X's challenge",
};

/** A timeline read stops once X's budget for the call is at or below this share of its limit. */
const LOW_BUDGET = 0.1;

/** X's budget for a call, from the response's x-rate-limit-limit and -remaining. */
const budgetOf = (headers: Record<string, string>) => {
  const limit = Number(headers["x-rate-limit-limit"]);
  const remaining = Number(headers["x-rate-limit-remaining"]);
  return limit > 0 && Number.isFinite(remaining) ? { limit, remaining } : undefined;
};

/** When a rate limit resets, from the response's x-rate-limit-reset (epoch seconds). */
const resetAt = (headers: Record<string, string>): string => {
  const reset = Number(headers["x-rate-limit-reset"]);
  return reset ? `; it resets at ${new Date(reset * 1000).toISOString()}` : "";
};

const GRAPHQL = /\/i\/api\/graphql\/[^/]+\/(\w+)(\?|$)/;
const callOf = (operation: string) => new RegExp(`/i/api/graphql/[^/]+/${operation}(\\?|$)`);

/**
 * X's limits on one GraphQL response, the same for every read: a rate limit or a locked account is
 * `RefusedError`, never retried. `low` is set once X's budget for the call is down to a tenth of its
 * limit: a read then stops with what it has and `more`, or refuses with `low` when it has nothing.
 */
const limitsOf = async (operation: string, response: Response): Promise<{ body: unknown; low?: string }> => {
  const headers = response.headers();
  // A 429 may be HTML (bot-detection.md, 1.2): no body then, but the status still says rate limited.
  const body = (await response.json().catch(() => undefined)) as { errors?: { code?: number; message?: string }[] } | undefined;
  const code = body?.errors?.map((e) => e.code).find((c) => c !== undefined && c in ACCOUNT_ERRORS);
  const budget = budgetOf(headers);
  const rated = code === 88 ? "code 88" : response.status() === 429 && code === undefined ? "status 429" : undefined;
  // Rate limited with budget left is X limiting the account, not the call (bot-detection.md, recommendation 5).
  if (rated && budget && budget.remaining > 0)
    throw new RefusedError(
      `X: the account looks limited or locked: ${operation} was refused as rate limited (${rated}) with ${budget.remaining} of ${budget.limit} calls left. Check the account by hand in the browser before running more`,
    );
  if (rated) throw new RefusedError(`X: rate limited (${operation}, ${rated})${resetAt(headers)}`);
  // Only 326 is left: a lock is the person's to clear, so no reset time.
  if (code !== undefined) throw new RefusedError(`X: ${ACCOUNT_ERRORS[code]} (${operation}, code ${code})`);
  const low =
    budget && budget.remaining <= budget.limit * LOW_BUDGET
      ? `X's budget for ${operation} is down to ${budget.remaining} of ${budget.limit}; stopping before it runs out${resetAt(headers)}`
      : undefined;
  return { body, low };
};

/** Each page's last X call refused as rate limited or locked, in `limitsOf`'s words, kept by `watchLimits`. */
const refusedCalls = new WeakMap<Page, string>();

/**
 * Keep, for each page of `context`, the last of X's calls that came back 429. A page whose start-up
 * call X refused shows nothing at all, neither the app nor a message (`Viewer`, 2026-10-18), so this
 * is the only way to say why: `refusedLoad`. Only 429s are read, not every body.
 */
export const watchLimits = (context: BrowserContext): void => {
  context.on("response", (response) => {
    const operation = response.url().match(GRAPHQL)?.[1];
    if (!operation || response.status() !== 429) return;
    limitsOf(operation, response).catch((err) => {
      try {
        if (err instanceof RefusedError) refusedCalls.set(response.frame().page(), err.message);
      } catch {}
    });
  });
};

/** Why a page never showed X's main column, when one of its calls was refused as rate limited; else undefined. */
export const refusedLoad = async (page: Page): Promise<string | undefined> => {
  const refused = refusedCalls.get(page);
  if (!refused) return undefined;
  const shown = await page
    .locator(SEL.primaryColumn)
    .first()
    .isVisible()
    .catch(() => false);
  return shown ? undefined : refused;
};

/** A GraphQL response's JSON, through `limitsOf`; a response that isn't one is an error. */
const bodyOf = async (operation: string, response: Response) => {
  const answer = await limitsOf(operation, response);
  if (!response.ok() || !answer.body)
    throw new Error(`${operation} answered ${response.status()} ${answer.body ? "" : "without JSON"}`.trim());
  return answer;
};

/** The handle of the account the page is signed in as, from the side nav's account switcher. */
export const signedInHandle = async (page: Page): Promise<string | undefined> => {
  const text = await page
    .locator(SEL.accountSwitcher)
    .first()
    .textContent()
    .catch(() => null);
  const handle = text?.match(/@(\w+)/)?.[1];
  return handle && HANDLE.test(handle) ? handle.toLowerCase() : undefined;
};

/** A handle as X writes it in a URL: without the "@" people type. */
const bare = (handle: string): string => handle.replace(/^@/, "");

export const xHelpers = (page: Page) => {
  const helpers = {
    /** The handle the page is signed in as. */
    me: () => signedInHandle(page),

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
      const name = bare(handle);
      if (!HANDLE.test(name)) throw new InputError(`"${handle}" is not an X handle (letters, digits and _, at most 15)`);
      await helpers.open(`/${name}`);
      // The main column comes before either: wait for the profile or X's message, then decide.
      const missing = page.getByText(/this account doesn.t exist/i);
      await page
        .locator(SEL.profileName)
        .or(missing)
        .first()
        .waitFor({ state: "visible", timeout: 20_000 })
        .catch(() => {});
      if (await missing.isVisible().catch(() => false)) throw new PreconditionError(`no account @${name}`);
    },

    /**
     * The timeline that `open` shows, as the DOM shows it, scrolled and collected until `limit`
     * entries or the `until` post, until scrolling brings nothing new a few times running, or after
     * `scrolls` scrolls. Paced like a person reading, never faster. Opening and scrolling make the page
     * fetch the timeline through GraphQL, so X's limits stop it as they stop `timeline`, from the
     * response that loaded the first page on: a rate limit or a locked account is `RefusedError`, and
     * a budget down to a tenth ends the read with `more`. `app.timeline` reads the same from GraphQL,
     * with more in each entry.
     */
    async posts(open: () => Promise<unknown>, bound: Bound = {}): Promise<XPage<Entry>> {
      const responses: Response[] = [];
      const listen = (r: Response) => {
        if (GRAPHQL.test(r.url())) responses.push(r);
      };
      page.on("response", listen);
      try {
        const read = gather(bound);
        await open();
        await page
          .locator(`${SEL.post}, ${SEL.emptyState}`)
          .first()
          .waitFor({ state: "visible", timeout: 20_000 })
          .catch(() => {});
        // Unknown unless set: the DOM doesn't say that X ended the timeline.
        let more: boolean | undefined;
        for (let used = 0, idle = 0, scrolls = 0; ; scrolls++) {
          const before = read.size;
          // Enough: another scroll would only fetch more of the timeline from X, which goes on past
          // `limit` (`page` drops this when the read reached `until`).
          if (read.add(await readCells(page))) {
            more = true;
            break;
          }
          let low: string | undefined;
          while (used < responses.length) {
            const response = responses[used++]!;
            low ??= (await limitsOf(response.url().match(GRAPHQL)![1]!, response)).low;
          }
          if (low) {
            if (!read.size) throw new RefusedError(low);
            more = true;
            break;
          }
          idle = read.size === before ? idle + 1 : 0;
          if (idle >= 3) {
            // A timeline that stopped growing may be X turning the account away.
            const refused = await helpers.errors();
            if (refused.length) throw new RefusedError(refused.join("; "));
            break;
          }
          if (scrolls >= (bound.scrolls ?? MAX_SCROLLS)) {
            more = true;
            break;
          }
          await scroll(page);
        }
        return read.page(more);
      } finally {
        page.off("response", listen);
      }
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
      return (await bodyOf(operation, response)).body as T;
    },

    /**
     * The posts of a timeline call (`SearchTimeline`, `UserTweets`, `Bookmarks`, `Likes`, ...) that
     * `open` makes the page send, then of the calls scrolling sends, at a person's pace, until `limit`
     * entries or the `until` post, until X has no more, or after `scrolls` scrolls. Every response is
     * kept as it comes, so a page that lands between scrolls is not lost. Once X's budget for the call
     * (x-rate-limit-remaining) is down to a tenth of its limit, it stops with what it has and `more`;
     * with nothing read yet, that is `RefusedError`.
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
        let atEnd = false;
        for (let used = 0, idle = 0, scrolls = 0; ; scrolls++) {
          const before = used;
          while (!done && used < responses.length) {
            const { body, low } = await bodyOf(operation, responses[used++]!);
            const t = readTimeline(body);
            more = hasMore(t);
            const items = t.items.filter((i): i is TimelineItem & { value: Entry } => isEntry(i.value));
            const cells = items.map(({ entryId, module, value }, n) =>
              clean({
                entry: value,
                pinned: t.pinned.includes(entryId) || undefined,
                earlier: (!!module && items[n + 1]?.module === module) || undefined,
              }),
            );
            done = read.add(cells) || more === false;
            if (!done && low) {
              if (!read.size) throw new RefusedError(low);
              done = true;
            }
          }
          if (done) break;
          // Only a scroll that reached the bottom without a new call counts as idle.
          idle = used !== before ? 0 : atEnd ? idle + 1 : idle;
          if (idle >= 3) break;
          if (scrolls >= (bound.scrolls ?? MAX_SCROLLS)) {
            more = true;
            break;
          }
          atEnd = await scroll(page);
        }
        return read.page(more);
      } finally {
        page.off("response", listen);
      }
    },

    /**
     * An account's list of accounts (`following`, or `followers`), opened as a person does: the profile,
     * then the link with the count under its name. A profile that isn't there, or a protected one the
     * signed-in account can't see, is a precondition. Read it with `users`, which hears the call this makes.
     */
    async follows(handle: string, list: "following" | "followers"): Promise<void> {
      const name = bare(handle);
      await helpers.profile(name);
      if (
        await page
          .getByText(/these posts are protected|this account.s posts are protected/i)
          .first()
          .isVisible()
          .catch(() => false)
      )
        throw new PreconditionError(`@${name} is protected: its ${list} are not visible to this account`);
      const link = page.locator(SEL.primaryColumn).locator(`a[href$="/${list}" i]`).first();
      await link.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
        throw new PreconditionError(`@${name}'s ${list} are not shown to this account`);
      });
      await link.click();
    },

    /**
     * The accounts of a list call (`Following`, `Followers`, ...) that `open` makes the page send, then of
     * the calls scrolling sends, at a person's pace, until `limit` accounts, until X has no more, or after
     * `scrolls` scrolls. X sends more accounts than asked for, so the read is cut to `limit`. Limits are
     * `timeline`'s: a rate limit or a lock is `RefusedError`, a budget down to a tenth ends the read with
     * `more`. No cursor, as with `timeline`; and no `until`, since these lists are not in id order.
     */
    async users(
      operation: string,
      open: () => Promise<unknown>,
      bound: Pick<Bound, "limit" | "scrolls"> = {},
      timeout = 30_000,
    ): Promise<XPage<User | UserUnavailable>> {
      const limit = bound.limit ?? 20;
      const match = callOf(operation);
      const responses: Response[] = [];
      const listen = (r: Response) => {
        if (match.test(r.url())) responses.push(r);
      };
      page.on("response", listen);
      try {
        const seen = new Map<string, User | UserUnavailable>();
        await open();
        if (!responses.length) await page.waitForResponse((r) => match.test(r.url()), { timeout });
        let more: boolean | undefined;
        let done = false;
        let atEnd = false;
        for (let used = 0, idle = 0, scrolls = 0; ; scrolls++) {
          const before = used;
          while (!done && used < responses.length) {
            const { body, low } = await bodyOf(operation, responses[used++]!);
            const read = usersPage(body);
            more = read.more;
            for (const u of read.items) seen.set(u.id ? `${u.kind}:${u.id}` : `${u.kind}#${seen.size}`, u);
            done = seen.size >= limit || more === false;
            if (!done && low) {
              if (!seen.size) throw new RefusedError(low);
              done = true;
            }
          }
          if (done) break;
          // Only a scroll that reached the bottom without a new call counts as idle.
          idle = used !== before ? 0 : atEnd ? idle + 1 : idle;
          if (idle >= 3) break;
          if (scrolls >= (bound.scrolls ?? MAX_SCROLLS)) {
            more = true;
            break;
          }
          atEnd = await scroll(page);
        }
        const items = [...seen.values()].slice(0, limit);
        return clean({ items, more: seen.size > limit ? true : more });
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
      if (!user) throw new PreconditionError(`no account @${bare(handle)}`);
      return user;
    },

    /** What X shows when it turns the account away: a rate limit, a locked account. Only its own messages, never a post's text. */
    async errors(): Promise<string[]> {
      const text = await page
        .locator(`${SEL.toast}, ${SEL.errorDetail}`)
        .allInnerTexts()
        .catch(() => [] as string[]);
      return text.filter((t) => REFUSALS.some((re) => re.test(t))).map((t) => t.trim());
    },
  };
  return helpers;
};

export type Xh = ReturnType<typeof xHelpers>;
