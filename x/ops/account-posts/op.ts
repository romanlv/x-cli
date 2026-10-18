import { HANDLE } from "../../helpers";
import { Entry, Page, PostId, pageText } from "../../model";
import { defineOp, InputError, Type } from "../../op";

const idOf = (e: Entry) => BigInt(e.id ?? 0);

export default defineOp({
  name: "account:posts",
  description:
    "An account's posts from its profile, newest first, its pinned post marked; with its reposts; --with-replies adds its replies",
  input: Type.Object({
    handle: Type.String({ description: "whose posts to read, with or without the @, such as NASA" }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "at most this many posts (20)" })),
    until: Type.Optional({
      ...PostId,
      description:
        "stop before this post, the newest an earlier read returned; it stops even if that post was deleted. The pinned post never stops a read",
    }),
    withReplies: Type.Optional(
      Type.Boolean({
        description:
          "add the account's replies (the profile's Replies tab) to its posts; the posts it replied to are left out, each reply names its parent",
      }),
    ),
  }),
  output: Page(Entry),
  async run({ app, step }, input) {
    const handle = input.handle.trim().replace(/^@/, "");
    if (!HANDLE.test(handle)) throw new InputError(`"${input.handle}" is not an X handle (letters, digits and _, at most 15)`);
    const limit = input.limit ?? 20;
    const bound = { limit, until: input.until, newestFirst: true };

    const posts = await step("read the Posts tab", () =>
      app.timeline("UserOriginalsTimeline", () => app.profileTimeline(handle, "posts"), bound),
    );
    // X's Replies tab holds the replies only, each under the post it answers (another account's, left out here).
    const replies = input.withReplies
      ? await step("read the Replies tab", () =>
          app.timeline("UserRepliesTimeline", () => app.profileTimeline(handle, "replies"), {
            ...bound,
            keep: (e) => e.kind === "post" && e.author.handle?.toLowerCase() === handle.toLowerCase(),
          }),
        )
      : undefined;
    // Reposts have a tab of their own; the Posts tab holds none.
    const reposts = await step("read the Reposts tab", () =>
      app.timeline("UserRepostsTimeline", () => app.profileTimeline(handle, "reposts"), bound),
    );

    // Newest first by id (a repost by its own id), the pinned post above them: X lays a self-thread out
    // oldest first, and the tabs overlap.
    return step("merge", async () => {
      const tabs = [posts, replies, reposts].filter((t) => t !== undefined);
      const pinned = new Set(tabs.flatMap((t) => t.pinned ?? []));
      const all = new Map<string, Entry>();
      for (const e of tabs.flatMap((t) => t.items)) if (e.id && !all.has(e.id)) all.set(e.id, e);
      const top = [...all.values()].filter((e) => e.id && pinned.has(e.id));
      const rest = [...all.values()]
        .filter((e) => !(e.id && pinned.has(e.id)))
        .sort((a, b) => (idOf(b) > idOf(a) ? 1 : idOf(b) < idOf(a) ? -1 : 0));
      const items = [...top, ...rest].slice(0, limit);
      // Known once each tab has said (a tab X didn't say about leaves it unknown), true if anything was cut.
      const said = tabs.map((t) => t.more);
      const more = all.size > limit || said.some(Boolean) ? true : said.every((m) => m === false) ? false : undefined;
      return {
        items,
        ...(more !== undefined ? { more } : {}),
        ...(top.length ? { pinned: top.map((e) => e.id!) } : {}),
      };
    });
  },
  format: pageText,
});
