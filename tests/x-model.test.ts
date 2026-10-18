import { describe, expect, test } from "bun:test";
import Type, { type TSchema } from "typebox";
import Value from "typebox/value";
import { settle } from "../x/helpers";
import {
  entryFromResult,
  iso,
  listFromResult,
  moreRepliesOf,
  postsPage,
  readTimeline,
  threadOf,
  userFromResult,
  usersPage,
  xTime,
} from "../x/map/graphql";
import {
  Draft,
  Entry,
  entryText,
  Page,
  type Post,
  pageText,
  postUrl,
  type Repost,
  rankedPageText,
  Thread,
  textWithLinks,
  threadText,
  timeOfId,
  User,
  UserUnavailable,
  XList,
} from "../x/model";
import {
  adsOnly,
  foldedDetail,
  followers,
  lastPage,
  legacyUser,
  listResult,
  profileConversations,
  searchTimeline,
  spamDetail,
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

  test("a profile's conversation modules: items keep their module, oldest first; the page flattens them", () => {
    const t = readTimeline(profileConversations);
    expect(t.items.map((i) => [i.module ?? "", (i.value as Post).id])).toEqual([
      ["profile-conversation-9001", "3005"],
      ["profile-conversation-9001", "3012"],
      ["", "3010"],
      ["profile-conversation-9002", "2990"],
      ["profile-conversation-9002", "3006"],
      ["profile-conversation-9002", "3008"],
      ["", "3004"],
      ["", "3003"],
    ]);
    const p = postsPage(profileConversations);
    valid(Page(Entry), p);
    expect(p.items.map((e) => e.id)).toEqual(["3005", "3012", "3010", "2990", "3006", "3008", "3004", "3003"]);
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
      // X's reason code is no sentence of its own: message stays unset.
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

  test("a Bottom cursor on a timeline X ended is not more; a scrolled call's groups are all replies", () => {
    // X sends a Bottom cursor with a TimelineTerminateTimeline Bottom on a page with no more replies (2026-10-18).
    const ended = JSON.parse(JSON.stringify(tweetDetail));
    const ins = ended.data.threaded_conversation_with_injections_v2.instructions;
    ins.push({ type: "TimelineTerminateTimeline", direction: "Bottom" });
    expect(threadOf(ended, "3001").more).toBe(false);
    const next = moreRepliesOf({ data: { threaded_conversation_with_injections_v2: { instructions: [ins[1]] } } });
    // Every entry is a reply here: the lone ones too, as a continuation call has no focal post.
    expect(next.replies.length).toBe(4);
    expect(next.replies.flatMap((g) => g.posts.map((p) => p.id))).toContain("3004");
    expect(next.more).toBe(true);
  });

  test("replies X counts but folds under a button: the button is `folded`, the fold's heading the `section`", () => {
    const t = threadOf(foldedDetail(1), "3001");
    expect(t.replies).toEqual([]);
    expect(t.more).toBe(true);
    expect(t.folded).toBe("Show probable spam");
    const opened = moreRepliesOf(spamDetail());
    expect(opened.more).toBe(false);
    expect(opened.folded).toBeUndefined();
    expect(opened.replies.map((g) => ({ ids: g.posts.map((p) => p.id), section: g.section }))).toEqual([
      { ids: ["3100"], section: "Probable spam" },
    ]);
    // With a Bottom cursor left, scrolling is what comes first: no fold yet.
    const scrolling = JSON.parse(JSON.stringify(foldedDetail(1)));
    scrolling.data.threaded_conversation_with_injections_v2.instructions[1].entries.push({
      entryId: "cursor-bottom-1",
      content: { entryType: "TimelineTimelineCursor", __typename: "TimelineTimelineCursor", value: "B", cursorType: "Bottom" },
    });
    expect(threadOf(scrolling, "3001").folded).toBeUndefined();
  });

  test("a thread prints what X counts and doesn't show: never `no replies` with `raise --limit`", () => {
    const t = threadOf(foldedDetail(1), "3001");
    const closed = threadText(t);
    expect(closed).toContain('more replies than these, folded under "Show probable spam"');
    expect(closed).not.toContain("no replies");
    const read = threadText({ ...t, replies: moreRepliesOf(spamDetail()).replies, more: false, folded: undefined });
    expect(read).toContain(`under X's "Probable spam" fold`);
    expect(read).not.toContain("raise --limit");
    const none = { ...t, replies: [], more: false, folded: undefined, unshown: { count: 1 } };
    valid(Thread, none);
    const text = threadText(none);
    expect(text).toContain("X counts 1 reply on this post and shows none of them; X gives no reason");
    expect(text).not.toContain("no replies");
    expect(text).not.toContain("raise --limit");
    expect(
      threadText({ ...none, unshown: { count: 1, reason: 'X folds them under "Show probable spam", which could not be opened' } }),
    ).toContain("shows none of them: X folds them under");
    // A post with none counted still says so.
    expect(threadText({ ...threadOf(foldedDetail(0), "3001"), more: false, folded: undefined })).toContain("no replies");
  });

  test("a fold that could not be pressed is `unshown`, never `more`, named or not", () => {
    const named = threadOf(foldedDetail(1), "3001");
    expect(settle(named, "3001", [], { cut: false, more: true, fold: "Show probable spam", stuck: "Show probable spam" })).toMatchObject({
      more: false,
      unshown: { count: 1, reason: 'X folds them under "Show probable spam", which could not be opened' },
    });
    // X gave the fold no text: stuck is "", which still counts as stuck.
    const bare = settle(named, "3001", [], { cut: false, more: true, fold: "", stuck: "" });
    expect(bare.more).toBe(false);
    expect(bare.folded).toBeUndefined();
    expect(bare.unshown).toEqual({ count: 1, reason: 'X folds them under "a button", which could not be opened' });
    expect(threadText(bare)).not.toContain("raise --limit");
    // Not stuck: the limit was reached first, so a larger one opens the fold.
    expect(settle(named, "3001", [], { cut: false, more: true, fold: "", stuck: undefined })).toMatchObject({ more: true, folded: "" });
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
    expect(iso("2024-04-18T18:37:10Z")).toBe("2024-04-18T18:37:10.000Z");
    expect(iso("soon")).toBeUndefined();
    expect(timeOfId("2074976613713031490")?.slice(0, 4)).toBe("2026");
    // Ids before 2010-11-04 are counters: jack/status/20 holds no time.
    expect(timeOfId("20")).toBeUndefined();
    expect(timeOfId("29000000000")).toBeUndefined();
    expect(postUrl("1")).toBe("https://x.com/i/status/1");
  });

  test("text for a person leaves out a time it does not have", () => {
    const old: Post = { kind: "post", id: "20", source: "dom", author: { handle: "jack" }, text: "just setting up my twttr" };
    expect(entryText(old)).toBe("@jack\njust setting up my twttr\n  https://x.com/i/status/20");
  });

  test("text for a person: a repost and a quote", () => {
    const { items } = postsPage(userTweets);
    const text = pageText({ items, more: true });
    expect(text).toContain("↻ Name ada @ada reposted · 2026-07-08 21:59\n");
    expect(text).toContain("  ┃ ");
    expect(text).toContain("\n────");
    expect(text).toMatch(/\d+ posts · more: raise --limit for older posts; next time --until \d+ gets only posts newer than this$/);
    expect(text).toContain("[deleted] This Post was deleted");
  });

  test("text marks the pinned post, and reads on from the newest post, not the pinned one or the first", () => {
    const post = (id: string): Post => ({ kind: "post", id, source: "graphql", author: { handle: "ada" }, text: `post ${id}` });
    // Pinned first, then a self-thread's 1/ above its newer 2/.
    const items = [post("1000"), post("3001"), post("3002")];
    const text = pageText({ items, more: true, pinned: ["1000"] });
    expect(text.startsWith("📌 pinned\n")).toBe(true);
    expect(text.match(/📌/g)).toHaveLength(1);
    expect(text).toMatch(/3 posts · more: raise --limit for older posts; next time --until 3002 gets only posts newer than this$/);
  });

  test("text for a ranked timeline says there is more, and names only --limit", () => {
    const { items } = postsPage(userTweets);
    const text = rankedPageText({ items, more: true });
    expect(text).toMatch(/\d+ posts · more: raise --limit for older posts$/);
    expect(text).not.toContain("--until");
    expect(rankedPageText({ items, more: false })).not.toContain("more:");
  });

  test("counts read in the singular at 1, and a repost shows when it was reposted", () => {
    const one = { value: 1, exact: true };
    const post: Post = {
      kind: "post",
      id: "2074976613713031490",
      source: "graphql",
      author: { handle: "ada" },
      text: "hi",
      counts: { replies: one, reposts: one, likes: one, views: one },
    };
    expect(entryText(post)).toContain("  1 reply · 1 repost · 1 like · 1 view\n");
    expect(entryText({ ...post, counts: { repostsAndQuotes: one } })).toContain("1 repost and quote");
    const repost: Repost = {
      kind: "repost",
      id: "2074976613713031491",
      source: "graphql",
      by: { handle: "grace" },
      createdAt: "2026-10-18T13:40:00.000Z",
      post,
    };
    expect(entryText(repost).split("\n")[0]).toBe("↻ @grace reposted · 2026-10-18 13:40");
    expect(pageText({ items: [post], more: true })).toContain("1 post · more:");
  });

  test("links print expanded; a trailing t.co for the post's own media or the quoted post is dropped", () => {
    const url = (start: number, u: string, expanded: string, display: string) => ({
      start,
      end: start + u.length,
      url: u,
      expanded,
      display,
    });
    const text = "See https://t.co/abc now https://t.co/qq https://t.co/pic";
    const entities = {
      mentions: [],
      hashtags: [],
      cashtags: [],
      urls: [
        url(4, "https://t.co/abc", "https://www.nasa.gov/maxpower/", "nasa.gov/maxpower/"),
        url(25, "https://t.co/qq", "https://x.com/bob/status/1800", "x.com/bob/status/1800"),
      ],
    };
    const post: Post = {
      kind: "post",
      id: "1",
      source: "graphql",
      author: { handle: "ada" },
      text,
      entities,
      quotedId: "1800",
      media: [{ type: "photo", url: "p" }],
    };
    expect(textWithLinks(post)).toBe("See nasa.gov/maxpower/ now");
    // Not trailing, a link to the quoted post stays readable; the DOM's text has no t.co and comes back as it is.
    expect(
      textWithLinks({
        ...post,
        text: "a https://t.co/qq b",
        entities: { ...entities, urls: [url(2, "https://t.co/qq", "https://x.com/bob/status/1800", "x.com/bob/status/1800")] },
        media: undefined,
      }),
    ).toBe("a x.com/bob/status/1800 b");
    // Another post's photo link is kept; this post's own media link is dropped.
    const photo = (id: string) => ({
      ...entities,
      urls: [url(4, "https://t.co/abc", `https://x.com/o/status/${id}/photo/1`, "pic.x.com/z")],
    });
    expect(textWithLinks({ id: "1", text: "See https://t.co/abc", entities: photo("123") })).toBe("See pic.x.com/z");
    expect(textWithLinks({ id: "1", text: "See https://t.co/abc", entities: photo("1"), media: [{}] })).toBe("See");
    expect(textWithLinks({ text: "see https://nasa.gov/x", media: [{}] })).toBe("see https://nasa.gov/x");
  });

  test("a thread's focal post prints as a list post, with quotes and bookmarks on the counts line", () => {
    const thread = threadOf(tweetDetail, "3001");
    const text = threadText(thread);
    const focal = text.split(/\n─+\n/).find((b) => b.startsWith("▶ the post")) ?? "";
    expect(focal).not.toMatch(/author \d|\d,\d{3} /);
    expect(focal).toMatch(/\n {2}\d+ repl(y|ies) · .* · .*bookmarks?( · [~\d.KM]+ views?)?\n {2}https:\/\/x\.com\/i\/status\/\d+$/);
  });

  test("a draft references what it replies to and quotes by id", () => {
    expect(Value.Check(Draft, { text: "hi", replyTo: "1001", quote: "1800" })).toBe(true);
    expect(Value.Check(Draft, { text: "hi", replyTo: "@ada" })).toBe(false);
  });
});
