import { HOME, HOME_TABS, type HomeTab } from "../../helpers";
import { Entry, Page, rankedPageText } from "../../model";
import { defineOp, Type } from "../../op";

/**
 * Scrolls a read of `limit` entries gets. A ranked feed has no cursor and every fresh /home re-ranks, so
 * one read has to scroll on in its page: a page of about 30 entries took 10 scrolls (notes.md), 3 to 4
 * entries a scroll, so half the limit is the room to need, never fewer than `timeline`'s 10. The pace
 * is still `timeline`'s (a scroll, then 2 to 6 s); X's end, a rate limit and a tenth of the budget end it sooner.
 */
const scrollsFor = (limit: number) => Math.max(10, Math.ceil(limit / 2));

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
        description:
          "at most this many posts (20; 200 takes about 4 minutes, scrolling at a person's pace); neither tab is in id order, so there is no until",
      }),
    ),
  }),
  output: Page(Entry),
  async run({ app, step }, input) {
    const tab: HomeTab = input.tab ?? "for-you";
    const limit = input.limit ?? 20;
    return step("read posts", () => app.timeline(HOME[tab].operation, () => app.home(tab), { limit, scrolls: scrollsFor(limit) }));
  },
  format: rankedPageText,
});
