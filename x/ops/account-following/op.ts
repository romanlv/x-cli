import { HANDLE } from "../../helpers";
import { Page, User, UserUnavailable, usersText } from "../../model";
import { defineOp, InputError, PreconditionError, Type } from "../../op";

export default defineOp({
  name: "account:following",
  description: "The accounts an account follows (yours without --handle), with whether each follows back",
  input: Type.Object({
    handle: Type.Optional(
      Type.String({ description: "whose follows to read, with or without the @; the signed-in account when left out" }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 200,
        description: "at most this many accounts (20); the list is not in id order, so there is no until",
      }),
    ),
  }),
  output: Page(Type.Union([User, UserUnavailable])),
  async run({ app, step }, input) {
    // Only an omitted handle means the signed-in account: a supplied one is checked as given.
    let handle: string | undefined;
    if (input.handle !== undefined) {
      handle = input.handle.trim().replace(/^@/, "");
      if (!HANDLE.test(handle)) throw new InputError(`"${input.handle}" is not an X handle (letters, digits and _, at most 15)`);
    } else {
      handle = await step("find the signed-in handle", () => app.me());
      if (!handle) throw new PreconditionError("could not tell which account is signed in: pass --handle");
    }
    const account = handle;
    return step("read the accounts followed", () =>
      app.users("Following", () => app.follows(account, "following"), { limit: input.limit ?? 20 }),
    );
  },
  format: usersText,
});
