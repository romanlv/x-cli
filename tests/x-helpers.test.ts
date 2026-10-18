import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import Value from "typebox/value";
import { launch } from "../core/browser";
import { RefusedError } from "../core/errors";
import { readPosts, xHelpers } from "../x/helpers";
import { count } from "../x/map/dom";
import { Entry, entryText, type Post, type Repost } from "../x/model";
import { timelineHtml } from "./fixtures/x-dom";
import { searchTimeline } from "./fixtures/x-graphql";

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
        bookmarks: { value: 0, exact: true },
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
      counts: { replies: { value: 0, exact: true }, reposts: { value: 5, exact: true }, likes: { value: 1, exact: true } },
      viewer: { liked: true, reposted: true, bookmarked: true },
    });
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
    await page.setContent(timelineHtml);
    const app = xHelpers(page);
    expect(await app.posts({ limit: 2 })).toMatchObject({ items: [{ id: "1001" }, { kind: "repost" }], more: true });
    const untilQuote = await app.posts({ until: "1003" });
    expect(untilQuote.items.length).toBe(2);
    expect(untilQuote.more).toBeUndefined();
    // until the reposted post's id stops at the repost too
    expect((await app.posts({ until: "1900" })).items.map((e) => e.kind)).toEqual(["post"]);
    expect((await app.posts({ limit: 1, until: "1006" })).items.length).toBe(1);
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
  });
});
