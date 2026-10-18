import { Page, User, UserUnavailable, usersFullText } from "../../model";
import { defineOp, Type } from "../../op";

export default defineOp({
  name: "suggestions:list",
  description: "The accounts X suggests the signed-in account follow (Who to follow / Connect), in X's order, with bio and counts",
  input: Type.Object({
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        description: "at most this many accounts (20); X offers 100 at most, and its list changes between loads, so there is no until",
      }),
    ),
  }),
  output: Page(Type.Union([User, UserUnavailable])),
  async run({ app, step }, input) {
    // The page's own call holds all 100 suggestions, so a read never scrolls; nothing here follows or dismisses one.
    return step("read the suggested accounts", () =>
      app.users("ConnectTabTimeline", () => app.open("/i/connect_people"), { limit: input.limit ?? 20 }),
    );
  },
  format: usersFullText,
});
