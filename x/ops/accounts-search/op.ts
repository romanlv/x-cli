import { Page, User, UserUnavailable, usersText } from "../../model";
import { defineOp, InputError, Type } from "../../op";

export default defineOp({
  name: "accounts:search",
  description: "Accounts matching a search (X search's People tab), in X's order, with whether you follow each",
  input: Type.Object({
    query: Type.String({
      description:
        "what to search for, as a person types it to find an account: a name, handle or words from a bio; post operators (from:, since:) are matched as words here, use posts:search for those",
    }),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 200,
        description: "at most this many accounts (20); X's order is relevance, so there is no until",
      }),
    ),
  }),
  output: Page(Type.Union([User, UserUnavailable])),
  async run({ app, step }, input) {
    const query = input.query.trim();
    if (!query) throw new InputError("query is empty: give X's search a name or words, such as `machine learning`");
    return step("read the accounts found", () =>
      app.users("SearchTimeline", () => app.search(query, "people"), { limit: input.limit ?? 20 }),
    );
  },
  format: usersText,
});
