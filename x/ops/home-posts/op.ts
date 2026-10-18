import { HOME, HOME_TABS, type HomeTab } from "../../helpers";
import { Entry, Page, rankedPageText } from "../../model";
import { defineOp, Type } from "../../op";

export default defineOp({
  name: "home:posts",
  description: "The posts X shows the signed-in account on its home page: For you (default) or Following, ranked, no ads",
  input: Type.Object({
    tab: Type.Optional(
      Type.Union(
        HOME_TABS.map((t) => Type.Literal(t)),
        { description: "for-you: X's ranked picks and suggestions (default); following: posts of accounts followed, also ranked by X" },
      ),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 200,
        description: "at most this many posts (20); neither tab is in id order, so there is no until",
      }),
    ),
  }),
  output: Page(Entry),
  async run({ app, step }, input) {
    const tab: HomeTab = input.tab ?? "for-you";
    return step("read posts", () => app.timeline(HOME[tab].operation, () => app.home(tab), { limit: input.limit ?? 20 }));
  },
  format: rankedPageText,
});
