import { describe, expect, test } from "bun:test";
import Type, { type TSchema } from "typebox";
import Value from "typebox/value";
import { entryFromResult, listFromResult, postsPage, readTimeline, threadOf, userFromResult, usersPage, xTime } from "../x/map/graphql";
import { Draft, Entry, entryText, Page, type Post, postUrl, type Repost, Thread, timeOfId, User, UserUnavailable, XList } from "../x/model";
import {
  adsOnly,
  followers,
  lastPage,
  legacyUser,
  listResult,
  searchTimeline,
  tweetDetail,
  unavailableTweet,
  userByScreenName,
  userTweets,
} from "./fixtures/x-graphql";

/** Every mapped value must pass the schema an op would declare as its output. */
const valid = (schema: TSchema, value: unknown) => {
  const errors = [...Value.Errors(schema, value)].map((e) => `${e.instancePath} ${e.message}`);
  expect(errors).toEqual([]);
};

describe("x model: GraphQL posts", () => {
  const page = postsPage(searchTimeline);

  test("a search page: posts in order, the ad left out, the bottom cursor kept", () => {
    valid(Page(Entry), page);
    expect(page.items.map((e) => e.kind === "post" && e.id)).toEqual(["1001", "1002"]);
    expect(page).toMatchObject({ more: true, cursor: "DAADDAAB-bottom" });
  });

  test("a long post's text and entities come from note_tweet, counts are exact, views a number", () => {
    const p = page.items[0] as Post;
    expect(p.text).toBe("Hello @bob #cats $ACME https://t.co/abc and the rest of a long post");
    expect(p.author).toEqual({ id: "11", handle: "ada", name: "Name ada" });
    expect(p.createdAt).toBe("2026-07-08T21:59:10.000Z");
    expect(p.counts).toEqual({
      replies: { value: 11, exact: true },
      reposts: { value: 21, exact: true },
      quotes: { value: 9, exact: true },
      likes: { value: 312, exact: true },
      bookmarks: { value: 7, exact: true },
      views: { value: 25900, exact: true },
    });
    expect(p.entities).toEqual({
      mentions: [{ start: 6, end: 10, handle: "bob", id: "22" }],
      hashtags: [{ start: 11, end: 16, tag: "cats" }],
      cashtags: [{ start: 17, end: 22, tag: "ACME" }],
      urls: [{ start: 23, end: 39, url: "https://t.co/abc", expanded: "https://example.com/", display: "example.com" }],
    });
    expect(p.text.slice(p.entities!.hashtags[0]!.start, p.entities!.hashtags[0]!.end)).toBe("#cats");
  });

  test("media keeps alt text and video variants; edits, notes and viewer state are read", () => {
    const p = page.items[0] as Post;
    expect(p.media?.[0]).toEqual({
      key: "3_5001",
      type: "photo",
      url: "https://pbs.twimg.com/media/p.jpg",
      alt: "a cat on a mat",
      width: 800,
      height: 600,
    });
    expect(p.media?.[1]).toMatchObject({
      type: "video",
      durationMs: 10850,
      variants: [{ contentType: "application/x-mpegURL" }, { bitrate: 832000 }],
    });
    expect(p.edits).toEqual({ versions: ["1000", "1001"], editableUntil: "2026-07-08T22:59:10.000Z", remaining: 4 });
    expect(p).toMatchObject({
      hasNote: true,
      note: { id: "9001", text: "Readers added context" },
      viewer: { liked: false, reposted: false, bookmarked: false },
    });
  });

  test("the 2026 shape with legacy null reads the same, a reply names what it replies to", () => {
    const p = page.items[1] as Post;
    expect(p).toMatchObject({
      id: "1002",
      text: "@ada agreed",
      conversationId: "1001",
      replyTo: { post: "1001", user: { id: "11", handle: "ada" } },
      viewer: { liked: true },
    });
    expect(p.counts?.bookmarks).toBeUndefined(); // not sent: unknown, not zero
    expect(p.counts?.views).toBeUndefined();
  });

  test("a repost is the reposter, when, and the original post, whose stub author is named from the mentions", () => {
    const { items } = postsPage(userTweets);
    const r = items.find((e) => e.kind === "repost") as Repost;
    expect(r).toMatchObject({ kind: "repost", id: "2002", by: { id: "11", handle: "ada" } });
    expect(r.post).toMatchObject({
      kind: "post",
      id: "1900",
      text: "original text in full",
      author: { id: "33", handle: "carol", name: "Carol" },
    });
  });

  test("an original author that is a stub with only its id keeps the handle and name from the mentions", () => {
    const r = postsPage(userTweets).items.find((e) => e.kind === "repost" && e.id === "2006") as Repost;
    expect(r.post).toMatchObject({ id: "1950", author: { id: "77", handle: "XFreeze", name: "X Freeze" } });
  });

  test("a quote embeds the quoted post one level deep, with what X limits on it", () => {
    const { items } = postsPage(userTweets);
    const q = items.find((e) => e.kind === "post" && e.id === "2003") as Post;
    expect(q.quotedId).toBe("1800");
    expect(q.quoted).toMatchObject({ kind: "post", id: "1800", text: "quoted text", quotedId: "1700", limitedActions: ["Reply"] });
    expect(q.quoted && "quoted" in q.quoted).toBe(false);
    // The quoted post is not a timeline item of its own.
    expect(items.some((e) => e.kind === "post" && e.id === "1800")).toBe(false);
  });

  test("a deleted quoted post is Unavailable with X's reason and the id from the quoting post", () => {
    const q = postsPage(userTweets).items.find((e) => e.kind === "post" && e.id === "2004") as Post;
    expect(q.quoted).toEqual({
      kind: "unavailable",
      id: "1600",
      reason: "deleted",
      message: "This Post was deleted by the Post author. Learn more",
      source: "graphql",
    });
  });

  test("a poll card is a Poll, not a Card", () => {
    const p = postsPage(userTweets).items.find((e) => e.kind === "post" && e.id === "2005") as Post;
    expect(p.poll).toEqual({
      options: [
        { label: "Yes", votes: { value: 844, exact: true } },
        { label: "No", votes: { value: 364, exact: true } },
      ],
      endsAt: "2024-04-18T18:37:10.000Z",
      durationMinutes: 1440,
      closed: false,
    });
    expect(p.card).toBeUndefined();
  });

  test("a profile's pinned post is marked, suggestions are left out", () => {
    const t = readTimeline(userTweets);
    expect(t.pinned).toEqual(["tweet-2001"]);
    expect(t.items.some((i) => i.entryId.startsWith("who-to-follow"))).toBe(false);
    const p = postsPage(userTweets);
    valid(Page(Entry), p);
    expect(p.pinned).toEqual(["2001"]);
    expect(postsPage(searchTimeline).pinned).toBeUndefined();
  });

  test("more follows X's cursor and end: a page of only ads has more, the last page and a terminated one none", () => {
    expect(postsPage(adsOnly)).toEqual({ items: [], more: true, cursor: "DAADDAAC-bottom" });
    expect(postsPage(lastPage)).toMatchObject({ items: [], more: false });
    expect(usersPage(followers).more).toBe(false); // TimelineTerminateTimeline at the bottom
  });

  test("an unavailable post (TweetUnavailable) and an empty result", () => {
    expect(entryFromResult(unavailableTweet.data.tweetResult.result, { entryId: "tweet-77" })).toEqual({
      kind: "unavailable",
      id: "77",
      reason: "protected",
      message: "Protected",
      source: "graphql",
    });
    expect(entryFromResult(undefined, { entryId: "tweet-78" })).toEqual({
      kind: "unavailable",
      id: "78",
      reason: "unknown",
      source: "graphql",
    });
  });
});

describe("x model: GraphQL threads", () => {
  const thread = threadOf(tweetDetail, "3001");

  test("ancestors, the focal post, and reply groups; the self-thread marked, folded replies flagged, ads out", () => {
    valid(Thread, thread);
    expect(thread.conversationId).toBe("2999");
    expect(thread.ancestors).toEqual([
      {
        kind: "unavailable",
        id: "3000",
        reason: "suspended",
        message: "This Post is from a suspended account. Learn more",
        source: "graphql",
      },
    ]);
    expect(thread.focal).toMatchObject({ kind: "post", id: "3001", replyTo: { post: "3000" } });
    expect(thread.replies.map((g) => ({ ids: g.posts.map((p) => p.id), selfThread: g.selfThread, more: g.more }))).toEqual([
      { ids: ["3002", "3003"], selfThread: true, more: undefined },
      { ids: ["3004"], selfThread: undefined, more: true },
    ]);
    expect(thread.more).toBe(true);
  });

  test("cursors by type, and a module's ShowMore apart", () => {
    const t = readTimeline(tweetDetail);
    expect(t.cursors).toEqual({ ShowMoreThreads: "JQAA-threads" });
    expect(t.more).toEqual({ "conversationthread-3004": "PAAA-showmore" });
  });

  test("a focal post the response lacks is Unavailable, not an error", () => {
    expect(threadOf(tweetDetail, "999").focal).toEqual({ kind: "unavailable", id: "999", reason: "unknown", source: "graphql" });
  });
});

describe("x model: GraphQL accounts and lists", () => {
  test("a user in the 2026 shape: ids, counts, relationship, pinned, website expanded", () => {
    const u = userFromResult(userByScreenName.data.user.result);
    valid(User, u);
    expect(u).toMatchObject({
      kind: "user",
      id: "44",
      handle: "dev",
      bio: "Building things.",
      location: "127.0.0.1",
      website: "https://docs.example.com/",
      createdAt: "2013-12-14T04:35:55.000Z",
      protected: false,
      blue: true,
      verifiedType: "Business",
      pinned: ["4001"],
      relationship: { following: true, followedBy: false, followRequestSent: false, blocking: false, blockedBy: false, muting: false },
    });
    expect(u?.kind === "user" && u.counts).toEqual({
      followers: { value: 120, exact: true },
      following: { value: 30, exact: true },
      posts: { value: 400, exact: true },
      media: { value: 4, exact: true },
      likes: { value: 2642, exact: true },
    });
  });

  test("a user in the older legacy shape: a pending follow request to a protected account", () => {
    const u = userFromResult(legacyUser);
    valid(User, u);
    expect(u).toMatchObject({
      id: "55",
      handle: "old",
      protected: true,
      bio: "",
      relationship: { following: false, followedBy: true, followRequestSent: true },
      counts: { listed: { value: 1, exact: true } },
    });
  });

  test("followers: users and unavailable accounts, with the bottom cursor", () => {
    const p = usersPage(followers);
    valid(Page(Type.Union([User, UserUnavailable])), p);
    expect(p.items.map((u) => u.kind)).toEqual(["user", "user-unavailable"]);
    expect(p.cursor).toBe("1840000000000000000|1840000000000000001");
  });

  test("a list", () => {
    const l = listFromResult(listResult);
    valid(XList, l);
    expect(l).toMatchObject({
      id: "7001",
      private: true,
      owner: { id: "11", handle: "ada" },
      counts: { members: { value: 12, exact: true } },
    });
  });
});

describe("x model: helpers and writes", () => {
  test("X's time format, an id's time, a handle-free link", () => {
    expect(xTime("Wed Jul 08 21:59:10 +0000 2026")).toBe("2026-07-08T21:59:10.000Z");
    expect(xTime("Wed Jul 08 21:59:10 -0130 2026")).toBe("2026-07-08T23:29:10.000Z");
    expect(xTime("yesterday")).toBeUndefined();
    expect(timeOfId("2074976613713031490")?.slice(0, 4)).toBe("2026");
    // Ids before 2010-11-04 are counters: jack/status/20 holds no time.
    expect(timeOfId("20")).toBeUndefined();
    expect(timeOfId("29000000000")).toBeUndefined();
    expect(postUrl("1")).toBe("https://x.com/i/status/1");
  });

  test("text for a person leaves out a time it does not have", () => {
    const old: Post = { kind: "post", id: "20", source: "dom", author: { handle: "jack" }, text: "just setting up my twttr" };
    expect(entryText(old)).toBe("@jack · https://x.com/i/status/20\njust setting up my twttr");
  });

  test("text for a person: a repost and a quote", () => {
    const { items } = postsPage(userTweets);
    const text = items.map(entryText).join("\n\n");
    expect(text).toContain("@ada reposted:\n@carol · ");
    expect(text).toContain("  > @bob · ");
    expect(text).toContain("[deleted] This Post was deleted");
  });

  test("a draft references what it replies to and quotes by id", () => {
    expect(Value.Check(Draft, { text: "hi", replyTo: "1001", quote: "1800" })).toBe(true);
    expect(Value.Check(Draft, { text: "hi", replyTo: "@ada" })).toBe(false);
  });
});
