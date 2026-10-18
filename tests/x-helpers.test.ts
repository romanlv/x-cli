import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import Value from "typebox/value";
import { launch } from "../core/browser";
import { PreconditionError, RefusedError } from "../core/errors";
import { gather, readPosts, xHelpers } from "../x/helpers";
import { count } from "../x/map/dom";
import { Entry, entryText, type Post, type Repost, type Unavailable } from "../x/model";
import { profileHtml, selfThreadHtml, timelineHtml } from "./fixtures/x-dom";
import { adsOnly, profileConversations, searchTimeline, userTweets } from "./fixtures/x-graphql";

const post = (id: string): Post => ({ kind: "post", id, source: "dom", author: { handle: "ada" }, text: "" });
const gone: Unavailable = { kind: "unavailable", reason: "deleted", source: "dom" };
const cells = (...entries: Entry[]) => entries.map((entry) => ({ entry }));

describe("x helpers: gathering a timeline", () => {
  test("a tombstone with no id is counted once across overlapping reads, wherever it falls in each", () => {
    const read = gather({ limit: 50 });
    read.add(cells(post("1001"), gone, post("1003")));
    read.add(cells(gone, post("1003"), post("1004")));
    expect(read.page().items).toEqual([post("1001"), gone, post("1003"), post("1004")]);
    // One that ends a read and starts the next, before a post neither has seen.
    const split = gather({ limit: 50 });
    split.add(cells(post("1001"), gone));
    split.add(cells(gone, post("1003")));
    expect(split.page().items).toEqual([post("1001"), gone, post("1003")]);
  });

  test("a tombstone first in the first read is kept, and two in a row stay two", () => {
    const read = gather({ limit: 50 });
    read.add(cells(gone, gone, post("1003")));
    read.add(cells(gone, gone, post("1003"), post("1004")));
    read.add(cells(post("1004"), gone, post("1006")));
    expect(read.page().items).toEqual([gone, gone, post("1003"), post("1004"), gone, post("1006")]);
  });

  test("newest first: the first entry at or before until stops it; a repost by its own id, a DOM repost only by equality", () => {
    const repost = (id: string | undefined, of: string): Repost =>
      id
        ? { kind: "repost", id, source: "graphql", by: { handle: "ada" }, post: post(of) }
        : { kind: "repost", source: "dom", by: { handle: "ada" }, post: post(of) };
    const read = gather({ until: "1008", newestFirst: true });
    read.add([
      { entry: post("900"), pinned: true },
      ...cells(post("1010"), repost("1012", "500"), repost(undefined, "400"), post("1009"), post("1007"), post("1006")),
    ]);
    expect(read.page(true)).toEqual({
      items: [post("900"), post("1010"), repost("1012", "500"), repost(undefined, "400"), post("1009")],
      pinned: ["900"],
    });
    // Not newest first (bookmarks, likes, search's Top): only the until post stops it.
    const any = gather({ until: "1008" });
    any.add(cells(post("1010"), post("1007"), post("1008"), post("1006")));
    expect(any.page(true).items.map((e) => e.id)).toEqual(["1010", "1007"]);
    // A repost with an id of its own is placed by it, not by its original's.
    const original = gather({ until: "500" });
    original.add(cells(repost("1012", "500"), repost(undefined, "500"), post("1006")));
    expect(original.page(true).items).toEqual([repost("1012", "500")]);
  });

  test("newest first: a post above a newer one of its conversation module never stops it, and is left out as the until post", () => {
    const thread = (...entries: [string, boolean?][]) => entries.map(([id, earlier]) => ({ entry: post(id), earlier }));
    const read = gather({ until: "1005", newestFirst: true });
    read.add(thread(["1005", true], ["1012"], ["1010"], ["990", true], ["1003", true], ["1008"], ["1004"]));
    expect(read.page(true).items.map((e) => e.id)).toEqual(["1012", "1010", "990", "1003", "1008"]);
  });
});

describe("x helpers: DOM counts", () => {
  test("a plain number is exact, K and M are rounded, a label with no number is none", () => {
    expect(count("1,204 reposts. Repost")).toEqual({ value: 1204, exact: true });
    expect(count("12K Likes. Like")).toEqual({ value: 12000, exact: false });
    expect(count("1.2M")).toEqual({ value: 1_200_000, exact: false });
    expect(count("3 Mentions")).toEqual({ value: 3, exact: true });
    expect(count("Reply")).toBeUndefined();
  });
});

describe("x helpers: reading the page", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await launch(false);
    page = await browser.newPage();
  });
  afterAll(() => browser.close());
  /** An `open` for `posts`: the page shows `html`. */
  const show = (html: string) => () => page.setContent(html);

  test("readPosts: posts, a repost, a quote, a tombstone, each a valid DOM entry", async () => {
    await page.setContent(timelineHtml);
    const entries = await readPosts(page);
    for (const e of entries) expect(Value.Check(Entry, e)).toBe(true);
    expect(entries.map((e) => (e.kind === "repost" ? `repost:${e.post.id}` : `${e.kind}:${e.id ?? ""}`))).toEqual([
      "post:1001",
      "repost:1900",
      "post:1003",
      "unavailable:",
      "post:1005",
      "post:1006",
    ]);
    expect(entries[0]).toEqual({
      kind: "post",
      id: "1001",
      source: "dom",
      author: { handle: "ada", name: "Ada" },
      createdAt: "2026-07-08T21:59:10.000Z",
      text: "Hello world",
      lang: "en",
      counts: {
        replies: { value: 3, exact: true },
        reposts: { value: 1204, exact: true },
        likes: { value: 12000, exact: false },
        // "Bookmark" names no count, and the bookmark button's label never does: unknown, not 0.
        views: { value: 25900, exact: true },
      },
      viewer: { liked: false, reposted: false, bookmarked: false },
    });
    // A person sees which counts are rounded.
    expect(entryText(entries[0]!)).toContain("3 replies · 1204 reposts · ~12000 likes · 25900 views");
  });

  test("readPosts: a repost is by the reposter's handle, the account's own state read from the buttons", async () => {
    await page.setContent(timelineHtml);
    const r = (await readPosts(page))[1] as Repost;
    expect(r).toMatchObject({ kind: "repost", source: "dom", by: { handle: "ada" } });
    expect(r.id).toBeUndefined();
    expect(r.post).toMatchObject({
      id: "1900",
      author: { handle: "carol" },
      counts: {
        replies: { value: 0, exact: true },
        reposts: { value: 5, exact: true },
        likes: { value: 1, exact: true },
        bookmarks: { value: 2, exact: true },
      },
      viewer: { liked: true, reposted: true, bookmarked: true },
    });
  });

  test("readPosts on a profile: the ad left out, counts from the action bar's label, none from buttons without labels", async () => {
    await page.setContent(profileHtml);
    const entries = await readPosts(page);
    for (const e of entries) expect(Value.Check(Entry, e)).toBe(true);
    expect(entries.map((e) => e.kind === "post" && e.id)).toEqual(["900", "1010", "1009", "1007"]);
    expect((entries[2] as Post).counts).toEqual({
      replies: { value: 3, exact: true },
      reposts: { value: 5, exact: true },
      likes: { value: 152, exact: true },
      bookmarks: { value: 175, exact: true },
      views: { value: 45025, exact: true },
    });
    const unlabelled = entries[3] as Post;
    expect(unlabelled.counts).toBeUndefined();
    expect(unlabelled.viewer).toEqual({ liked: false, reposted: false, bookmarked: false });
  });

  test("posts: the pinned post is kept and marked and never stops until; newest first (search's Latest) stops past a deleted until", async () => {
    const app = xHelpers(page);
    // 900 is older than until but pinned; 1008 was deleted, so 1007 is the first at or before it.
    const read = await app.posts(show(profileHtml), { until: "1008", newestFirst: true });
    expect(read).toEqual({ items: read.items, pinned: ["900"] });
    expect(read.items.map((e) => e.kind === "post" && e.id)).toEqual(["900", "1010", "1009"]);
    // until the pinned post itself does not stop at it either.
    expect((await app.posts(show(profileHtml), { until: "900", scrolls: 0 })).items.length).toBe(4);
    // A read cut short by the scroll cap says there is more.
    expect(await app.posts(show(profileHtml), { scrolls: 0 })).toMatchObject({ more: true, pinned: ["900"] });
  });

  test("posts on a profile: a self-thread, oldest first, keeps its older 1/ and stops only at until, as the DOM isn't newest first there", async () => {
    const app = xHelpers(page);
    const read = await app.posts(show(selfThreadHtml), { until: "1008" });
    expect(read.items.map((e) => e.id)).toEqual(["1005", "1012", "1010"]);
    expect(read.more).toBeUndefined();
    // Read as newest first, 1/ would stop it before 2/: why ops on a profile's DOM don't pass newestFirst.
    expect((await app.posts(show(selfThreadHtml), { until: "1008", newestFirst: true })).items).toEqual([]);
  });

  test("readPosts: the quote's parts stay in the quote; one with no permalink is left out", async () => {
    await page.setContent(timelineHtml);
    const entries = await readPosts(page);
    const q = entries[2] as Post;
    expect(q).toMatchObject({ id: "1003", text: "look at this", truncated: true, quotedId: "1800" });
    expect(q.quoted).toEqual({
      kind: "post",
      id: "1800",
      source: "dom",
      author: { handle: "bob", name: "Name bob" },
      createdAt: "2026-07-01T10:00:00.000Z",
      text: "quoted text",
      lang: "fr",
    });
    expect(entries[3]).toEqual({
      kind: "unavailable",
      reason: "deleted",
      message: "This Post was deleted by the Post author. Learn more",
      source: "dom",
    });
    const noLink = entries[4] as Post;
    expect(noLink).toMatchObject({ id: "1005", text: "", author: { handle: "dan" } });
    expect(noLink.quoted).toBeUndefined();
  });

  test("posts: at most limit, stopping before the until post, never past limit", async () => {
    const app = xHelpers(page);
    expect(await app.posts(show(timelineHtml), { limit: 2 })).toMatchObject({ items: [{ id: "1001" }, { kind: "repost" }], more: true });
    const untilQuote = await app.posts(show(timelineHtml), { until: "1003" });
    expect(untilQuote.items.length).toBe(2);
    expect(untilQuote.more).toBeUndefined();
    // until the reposted post's id stops at the repost too
    expect((await app.posts(show(timelineHtml), { until: "1900" })).items.map((e) => e.kind)).toEqual(["post"]);
    expect((await app.posts(show(timelineHtml), { limit: 1, until: "1006" })).items.length).toBe(1);
  });

  test("timeline: the GraphQL the page fetched, mapped and bounded; a rate limit is refused", async () => {
    let status = 200;
    await page.route("https://x.com/i/api/graphql/**", (route) =>
      route.fulfill({
        status,
        json: searchTimeline,
        headers: { "access-control-allow-origin": "*", "x-rate-limit-reset": "1800000000" },
      }),
    );
    await page.setContent("<main></main>");
    const app = xHelpers(page);
    const fetchSearch = () =>
      page.evaluate(() => fetch("https://x.com/i/api/graphql/q1/SearchTimeline?variables=%7B%7D").then((r) => r.text()));

    expect(await app.timeline("SearchTimeline", fetchSearch, { limit: 1 })).toMatchObject({
      items: [{ kind: "post", id: "1001", source: "graphql" }],
      more: true,
    });
    const untilSecond = await app.timeline("SearchTimeline", fetchSearch, { until: "1002" });
    expect(untilSecond.items.map((e) => e.kind === "post" && e.id)).toEqual(["1001"]);
    expect(untilSecond.more).toBeUndefined();

    status = 429;
    await expect(app.timeline("SearchTimeline", fetchSearch)).rejects.toThrow(RefusedError);
    await page.unroute("https://x.com/i/api/graphql/**");
  });

  describe("X's GraphQL answers", () => {
    let json: unknown;
    let budget: Record<string, string> = {};
    let status = 200;
    beforeAll(() =>
      page.route("https://x.com/i/api/graphql/**", (route) =>
        route.fulfill({
          status,
          json,
          headers: { "access-control-allow-origin": "*", "x-rate-limit-reset": "1800000000", ...budget },
        }),
      ),
    );
    afterAll(() => page.unroute("https://x.com/i/api/graphql/**"));
    const serve = async (body: unknown, headers: Record<string, string> = {}, code = 200) => {
      json = body;
      budget = headers;
      status = code;
      await page.setContent("<main></main>");
    };
    const fetchTweets = () =>
      page.evaluate(() => fetch("https://x.com/i/api/graphql/q1/UserTweets?variables=%7B%7D").then((r) => r.text()));
    const low = { "x-rate-limit-limit": "500", "x-rate-limit-remaining": "40" };

    test("timeline: a pinned post is marked and never stops until", async () => {
      await serve(userTweets);
      // The pinned 2001 is the until post, but out of the timeline's order: the read goes on past it.
      const pinned = await xHelpers(page).timeline("UserTweets", fetchTweets, { until: "2001", scrolls: 0 });
      expect(pinned).toMatchObject({ more: true, pinned: ["2001"] });
      expect(pinned.items.map((e) => e.id)).toEqual(["2001", "2002", "2003", "2004", "2005", "2006"]);
    });

    test("timeline: newest first, a conversation module stops it only at its newest post; until inside one is left out", async () => {
      await serve(profileConversations);
      const app = xHelpers(page);
      // 3007 was deleted: the module 2990, 3006, 3008 is placed by 3008, so the read goes on to 3004.
      const deleted = await app.timeline("UserTweets", fetchTweets, { until: "3007", newestFirst: true });
      expect(deleted.items.map((e) => e.id)).toEqual(["3005", "3012", "3010", "2990", "3006", "3008"]);
      expect(deleted.more).toBeUndefined();
      // 3005 is 1/ of a self-thread whose 2/ is newer: left out, and the read goes on.
      const inThread = await app.timeline("UserTweets", fetchTweets, { until: "3005", newestFirst: true });
      expect(inThread.items.map((e) => e.id)).toEqual(["3012", "3010", "2990", "3006", "3008"]);
      // A module whose newest post stops the read goes with it: 2990 and 3006 are 3008's.
      for (const until of ["3008", "3009"]) {
        const atModule = await app.timeline("UserTweets", fetchTweets, { until, newestFirst: true });
        expect(atModule.items.map((e) => e.id)).toEqual(["3005", "3012", "3010"]);
      }
    });

    test("timeline: X's budget at a tenth stops the read with more, without another scroll", async () => {
      await serve(userTweets, low);
      expect(await xHelpers(page).timeline("UserTweets", fetchTweets)).toMatchObject({ items: { length: 6 }, more: true });
    });

    test("timeline: X's budget at a tenth with nothing read (a page of only an ad) is a refusal with when it resets", async () => {
      await serve(adsOnly, low);
      await expect(xHelpers(page).timeline("UserTweets", fetchTweets)).rejects.toThrow(/down to 40 of 500.*resets at 2027-01-15/);
    });

    test("timeline: a 429 with code 88 and budget left is the account, with none left a rate limit", async () => {
      const limited = { errors: [{ code: 88, message: "Rate limit exceeded" }] };
      await serve(limited, { "x-rate-limit-limit": "500", "x-rate-limit-remaining": "300" }, 429);
      await expect(xHelpers(page).timeline("UserTweets", fetchTweets)).rejects.toThrow(/account looks limited or locked/);
      await serve(limited, { "x-rate-limit-limit": "500", "x-rate-limit-remaining": "0" }, 429);
      await expect(xHelpers(page).timeline("UserTweets", fetchTweets)).rejects.toThrow(/rate limited \(UserTweets, code 88\); it resets/);
    });

    /** An `open` that shows `html` and makes the timeline call that loads its first page, as X's does. */
    const loading = (html: string) => async () => {
      await page.setContent(html);
      await fetchTweets();
    };

    test("posts: X's budget at a tenth on the call that loaded the page stops it with what it read, and more", async () => {
      await serve(userTweets, low);
      // Without the budget it would scroll on.
      expect(await xHelpers(page).posts(loading(profileHtml), { scrolls: 3 })).toMatchObject({ items: { length: 4 }, more: true });
    });

    test("posts: X's budget at a tenth with nothing read is a refusal", async () => {
      await serve(userTweets, low);
      const empty = `<main data-testid="primaryColumn"><div data-testid="emptyState">Nothing yet</div></main>`;
      await expect(xHelpers(page).posts(loading(empty))).rejects.toThrow(/down to 40 of 500/);
    });

    test("posts: code 88 on the call that loaded the page, with budget left, is the account", async () => {
      await serve(
        { errors: [{ code: 88, message: "Rate limit exceeded" }] },
        { "x-rate-limit-limit": "500", "x-rate-limit-remaining": "300" },
      );
      await expect(xHelpers(page).posts(loading(profileHtml))).rejects.toThrow(/account looks limited or locked/);
    });
  });

  describe("profile: waits for the profile or X's message that it doesn't exist, which X draws after the main column", () => {
    // A page of its own: one the tests before navigated is slow to go to another site.
    let profilePage: Page;
    const draw = (html: string) =>
      `<main data-testid="primaryColumn"><p>Loading</p></main><script>setTimeout(() => { document.querySelector("main").innerHTML = ${JSON.stringify(html)}; }, 500);</script>`;
    beforeAll(async () => {
      profilePage = await browser.newPage();
      await profilePage.route("https://x.com/*", (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: route.request().url().endsWith("/nobody")
            ? draw(`<div data-testid="emptyState"><span>This account doesn’t exist</span></div>`)
            : draw(`<div data-testid="UserName"><span>Ada</span></div>`),
        }),
      );
    });
    afterAll(() => profilePage.close());

    test("an account that isn't there is a precondition", async () => {
      await expect(xHelpers(profilePage).profile("nobody")).rejects.toThrow(PreconditionError);
    });

    test("one that is opens", async () => {
      await xHelpers(profilePage).profile("ada");
      expect(await profilePage.locator('[data-testid="UserName"]').isVisible()).toBe(true);
    });
  });
});
