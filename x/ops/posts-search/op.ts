import { Entry, Page, PostId, pageText } from "../../model";
import { defineOp, InputError, Type } from "../../op";

export default defineOp({
  name: "posts:search",
  description: "Posts matching a search, newest first",
  input: Type.Object({
    query: Type.String({
      description: "what to search for; X's operators work (from:, since:, until:, filter:links, min_faves:)",
    }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "at most this many posts (20)" })),
    until: Type.Optional({
      ...PostId,
      description: "stop before this post, the newest an earlier read returned; X's own until:<date> in the query is a date, not a post",
    }),
  }),
  output: Page(Entry),
  async run({ app, step }, input) {
    const query = input.query.trim();
    if (!query) throw new InputError("query is empty: give X's search something, such as `from:NASA`");
    return step("read posts", () =>
      app.timeline("SearchTimeline", () => app.search(query, "latest"), {
        limit: input.limit ?? 20,
        until: input.until,
        newestFirst: true,
      }),
    );
  },
  format: pageText,
});
