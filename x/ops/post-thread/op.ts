import { Thread, threadText } from "../../model";
import { defineOp, InputError, PreconditionError, Type } from "../../op";

/** A post's id from what a person gives: the id, or a link to the post (the handle in it is only a snapshot). */
const idOf = (post: string): string => {
  const text = post.trim();
  if (/^\d{1,20}$/.test(text)) return text;
  const url = text.match(
    /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:i\/(?:web\/)?|\w{1,15}\/)status(?:es)?\/(\d{1,20})(?:[/?#]|$)/i,
  );
  if (!url) throw new InputError(`"${post}" is not a post: give its id, or a link such as https://x.com/<handle>/status/<id>`);
  return url[1]!;
};

export default defineOp({
  name: "post:thread",
  description: "A post in full with the posts it replies to above it and the replies under it, by post id or URL",
  input: Type.Object({
    post: Type.String({ description: "the post: its id, or a link to it (x.com/<handle>/status/<id> or x.com/i/status/<id>)" }),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 200,
        description:
          "at most this many replies, counting every post under the post (sub-replies and the author's own continuation too), in X's order (20); more is set when there were more",
      }),
    ),
  }),
  output: Thread,
  async run({ app, step }, input) {
    const id = idOf(input.post);
    const thread = await step("read the post's page", () => app.thread(id, { limit: input.limit ?? 20 }));
    if (thread.focal.kind === "unavailable") {
      const f = thread.focal;
      throw new PreconditionError(
        f.reason === "unknown" ? `no post ${id}` : `post ${id} can't be read (${f.reason})${f.message ? `: ${f.message}` : ""}`,
      );
    }
    return thread;
  },
  format: threadText,
});
