// The data every X op returns and takes: posts, reposts, accounts, lists, notifications, and pages
// and threads of them. `knowledge/data-model.md` is the design and where each field comes from.
//
// Rules that hold for every type here:
// - Ids are X's numeric ids as strings (they pass 2^53). Ids are keys; handles change, so a handle
//   is a snapshot of how an account was named when it was read, never a key.
// - A field that is absent was not loaded (the source lacks it, or the op did not read it). A field
//   that is present is what X said: `[]` is "none", `0` is zero, `false` is no. Nothing is `null`.
// - Every value is plain JSON: no classes, no Dates (times are ISO 8601 strings in UTC).
// - `source` says where an object was read: the page's DOM, the web app's GraphQL, or X's API v2.
import Type, { type Static, type TSchema } from "typebox";

const Id = (description: string) => Type.String({ pattern: "^[0-9]+$", description });

export const PostId = Id("a post's id (X's tweet id), a decimal string");
export const UserId = Id("an account's id (X's user rest_id), a decimal string");
export const Source = Type.Union([Type.Literal("dom"), Type.Literal("graphql"), Type.Literal("api")], {
  description: "where the object was read: the page's DOM, the web app's GraphQL responses, or X's API v2",
});
const Time = Type.String({ format: "date-time", description: "ISO 8601, UTC" });
const Offset = Type.Integer({ minimum: 0 });

/**
 * A count as X shows it. The DOM writes "12K", which is `{ value: 12000, exact: false }`; GraphQL and
 * the API give the number, `exact: true` (exact when read: counts move).
 */
export const Count = Type.Object({ value: Type.Integer({ minimum: 0 }), exact: Type.Boolean() });

/** An account as another object names it: its author, who it replies to, who reposted it. */
export const UserRef = Type.Object(
  {
    id: Type.Optional(UserId),
    handle: Type.Optional(Type.String({ description: "the @handle when read, without @" })),
    name: Type.Optional(Type.String({ description: "display name" })),
  },
  { description: "at least one of id and handle; id from GraphQL and the API, the DOM has only the handle" },
);

/** Ranges are offsets into GraphQL's `text` in Unicode code points, as X gives them; `end` is exclusive. The DOM has none. */
export const Entities = Type.Object({
  mentions: Type.Array(Type.Object({ start: Offset, end: Offset, handle: Type.String(), id: Type.Optional(UserId) })),
  hashtags: Type.Array(Type.Object({ start: Offset, end: Offset, tag: Type.String() })),
  cashtags: Type.Array(Type.Object({ start: Offset, end: Offset, tag: Type.String() })),
  urls: Type.Array(
    Type.Object({
      start: Offset,
      end: Offset,
      url: Type.String({ description: "the t.co link in the text" }),
      expanded: Type.Optional(Type.String({ description: "where it leads" })),
      display: Type.Optional(Type.String()),
    }),
  ),
});

export const Media = Type.Object({
  key: Type.Optional(Type.String({ description: "X's media_key, e.g. 3_<id> for a photo" })),
  type: Type.Union([Type.Literal("photo"), Type.Literal("video"), Type.Literal("gif")]),
  url: Type.String({ description: "the image; for a video or gif, its preview image" }),
  alt: Type.Optional(Type.String({ description: "alt text, when the author wrote one" })),
  width: Type.Optional(Type.Integer()),
  height: Type.Optional(Type.Integer()),
  durationMs: Type.Optional(Type.Integer()),
  variants: Type.Optional(
    Type.Array(Type.Object({ url: Type.String(), contentType: Type.String(), bitrate: Type.Optional(Type.Integer()) })),
  ),
  views: Type.Optional(Count),
});

/** A link preview X attached to the post. `name` is X's card name (summary, summary_large_image, player, unified_card, ...). */
export const Card = Type.Object({
  name: Type.String(),
  url: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  domain: Type.Optional(Type.String({ description: "the site as the card shows it (vanity_url)" })),
  image: Type.Optional(Type.String()),
});

export const Poll = Type.Object({
  options: Type.Array(Type.Object({ label: Type.String(), votes: Type.Optional(Count) })),
  endsAt: Type.Optional(Time),
  durationMinutes: Type.Optional(Type.Integer()),
  closed: Type.Optional(Type.Boolean({ description: "voting is over and the counts are final" })),
});

export const CommunityNote = Type.Object({ id: Type.Optional(Type.String()), text: Type.String() });

export const Edits = Type.Object({
  versions: Type.Array(PostId, { description: "every version's id, oldest first; the last is the current text" }),
  editableUntil: Type.Optional(Time),
  remaining: Type.Optional(Type.Integer({ minimum: 0 })),
});

/** What the signed-in account has done to a post. What writes change, and what they check first. */
export const PostViewer = Type.Object({
  liked: Type.Optional(Type.Boolean()),
  reposted: Type.Optional(Type.Boolean()),
  bookmarked: Type.Optional(Type.Boolean()),
});

export const PostCounts = Type.Object({
  replies: Type.Optional(Count),
  reposts: Type.Optional(Count),
  quotes: Type.Optional(Count),
  likes: Type.Optional(Count),
  bookmarks: Type.Optional(Count),
  views: Type.Optional(Count),
});

/** Why a post can't be read. `message` is X's own text for it ("This Post was deleted by the Post author."). */
export const UnavailableReason = Type.Union([
  Type.Literal("deleted"),
  Type.Literal("suspended"),
  Type.Literal("protected"),
  Type.Literal("withheld"),
  Type.Literal("age-restricted"),
  Type.Literal("blocked"),
  Type.Literal("unknown"),
]);

/** A post X names but won't show: deleted, from a suspended or protected account, withheld. */
export const Unavailable = Type.Object({
  kind: Type.Literal("unavailable"),
  id: Type.Optional(PostId),
  reason: UnavailableReason,
  message: Type.Optional(Type.String()),
  source: Source,
});

// A post's own fields, without the quoted post: a quoted post's own quote is named by id only, as X does.
const postFields = {
  kind: Type.Literal("post"),
  id: PostId,
  source: Source,
  author: UserRef,
  createdAt: Type.Optional(Time),
  text: Type.String({
    description:
      "the full text, long posts included. GraphQL's has a reply's leading @handles and trailing t.co links for media and quotes; the DOM's has neither. Entity offsets are into GraphQL's",
  }),
  truncated: Type.Optional(Type.Literal(true, { description: "text is cut short where it was read (the DOM's Show more)" })),
  lang: Type.Optional(Type.String()),
  conversationId: Type.Optional(PostId),
  replyTo: Type.Optional(
    Type.Object({ post: Type.Optional(PostId), user: Type.Optional(UserRef) }, { description: "the post this one replies to" }),
  ),
  quotedId: Type.Optional(PostId),
  counts: Type.Optional(PostCounts),
  entities: Type.Optional(Entities),
  media: Type.Optional(Type.Array(Media)),
  card: Type.Optional(Card),
  poll: Type.Optional(Poll),
  hasNote: Type.Optional(Type.Boolean({ description: "X has a community note on it" })),
  note: Type.Optional(CommunityNote),
  edits: Type.Optional(Edits),
  sensitive: Type.Optional(Type.Boolean()),
  withheldIn: Type.Optional(Type.Array(Type.String(), { description: "country codes it is withheld in" })),
  limitedActions: Type.Optional(Type.Array(Type.String(), { description: "actions X limits on it, e.g. Reply" })),
  viewer: Type.Optional(PostViewer),
};

export const QuotedPost = Type.Object(postFields);
export const Post = Type.Object({
  ...postFields,
  quoted: Type.Optional(Type.Union([QuotedPost, Unavailable], { description: "the quoted post, as X embedded it" })),
});

/** A repost is not a post by the reposter: it is who reposted what, and when. Its `id` is the repost's own status id. */
export const Repost = Type.Object({
  kind: Type.Literal("repost"),
  id: Type.Optional(PostId),
  source: Source,
  by: UserRef,
  createdAt: Type.Optional(Time),
  post: Type.Union([Post, Unavailable]),
});

/** One thing in a timeline of posts: search, a profile, bookmarks, likes, a list. */
export const Entry = Type.Union([Post, Repost, Unavailable]);

/** The signed-in account's relation to another, both ways. */
export const Relationship = Type.Object({
  following: Type.Optional(Type.Boolean()),
  followedBy: Type.Optional(Type.Boolean()),
  followRequestSent: Type.Optional(Type.Boolean({ description: "asked to follow a protected account, not yet accepted" })),
  followRequestReceived: Type.Optional(Type.Boolean()),
  blocking: Type.Optional(Type.Boolean()),
  blockedBy: Type.Optional(Type.Boolean()),
  muting: Type.Optional(Type.Boolean()),
});

export const User = Type.Object({
  kind: Type.Literal("user"),
  id: UserId,
  source: Source,
  handle: Type.String(),
  name: Type.String(),
  bio: Type.Optional(Type.String()),
  location: Type.Optional(Type.String()),
  website: Type.Optional(Type.String()),
  createdAt: Type.Optional(Time),
  avatar: Type.Optional(Type.String()),
  banner: Type.Optional(Type.String()),
  protected: Type.Optional(Type.Boolean()),
  blue: Type.Optional(Type.Boolean({ description: "has the blue check (X Premium)" })),
  verifiedType: Type.Optional(Type.String({ description: "Business, Government, ... as X names it" })),
  counts: Type.Optional(
    Type.Object({
      followers: Type.Optional(Count),
      following: Type.Optional(Count),
      posts: Type.Optional(Count),
      likes: Type.Optional(Count),
      media: Type.Optional(Count),
      listed: Type.Optional(Count),
    }),
  ),
  pinned: Type.Optional(Type.Array(PostId)),
  relationship: Type.Optional(Relationship),
  withheldIn: Type.Optional(Type.Array(Type.String())),
});

export const UserUnavailable = Type.Object({
  kind: Type.Literal("user-unavailable"),
  id: Type.Optional(UserId),
  handle: Type.Optional(Type.String()),
  reason: Type.Union([Type.Literal("suspended"), Type.Literal("unknown")]),
  message: Type.Optional(Type.String()),
  source: Source,
});

export const XList = Type.Object({
  kind: Type.Literal("list"),
  id: Id("a list's id, a decimal string"),
  source: Source,
  name: Type.String(),
  description: Type.Optional(Type.String()),
  private: Type.Optional(Type.Boolean()),
  owner: Type.Optional(UserRef),
  createdAt: Type.Optional(Time),
  counts: Type.Optional(Type.Object({ members: Type.Optional(Count), followers: Type.Optional(Count) })),
});

export const NotificationType = Type.Union([Type.Literal("like"), Type.Literal("repost"), Type.Literal("follow"), Type.Literal("other")]);

/** One line of the notifications tab: who (actors) did what (type) to which posts (targets). Mentions and replies are posts. */
export const Notification = Type.Object({
  kind: Type.Literal("notification"),
  id: Type.String(),
  source: Source,
  type: NotificationType,
  createdAt: Type.Optional(Time),
  text: Type.Optional(Type.String({ description: 'X\'s sentence for it, e.g. "Ada and 3 others liked your post"' })),
  actors: Type.Array(UserRef),
  targets: Type.Array(PostId),
});

/**
 * A bounded read of a timeline. `more` says X had more past the last item. `cursor` is X's opaque
 * bottom cursor, set only by the one-response mappers (postsPage, usersPage) and for the API source:
 * ops never send their own calls, so a later read resumes from an id (`until`), and app.timeline and
 * app.posts leave it out, since a cursor past a page cut at `limit` would skip what was cut. `pinned` names the items X pinned above the timeline (a
 * profile's pinned post): they are out of its order, and `until` never stops at them.
 */
export const Page = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item),
    more: Type.Optional(Type.Boolean()),
    cursor: Type.Optional(Type.String()),
    pinned: Type.Optional(Type.Array(PostId, { description: "ids of the items X pinned to the top, out of the timeline's order" })),
  });

/** Replies shown together: X's conversation module, a reply to the focal post and the replies under it. */
export const ReplyGroup = Type.Object({
  posts: Type.Array(Type.Union([Post, Unavailable])),
  selfThread: Type.Optional(Type.Literal(true, { description: "the focal author continuing their own thread" })),
  more: Type.Optional(Type.Boolean({ description: "X folds more replies under this group" })),
});

/** A post with what it replies to and what replies to it, as TweetDetail (`/<handle>/status/<id>`) gives it. */
export const Thread = Type.Object({
  conversationId: Type.Optional(PostId),
  focal: Type.Union([Post, Unavailable]),
  ancestors: Type.Array(Type.Union([Post, Unavailable]), { description: "the chain above the focal post, oldest first" }),
  replies: Type.Array(ReplyGroup),
  more: Type.Optional(Type.Boolean({ description: "X has more reply groups past these" })),
});

// Writes, for later: what a write op takes. Each references what it acts on by id, and its output is
// the object read back after it (the Post created, the PostViewer or Relationship that changed).

export const Draft = Type.Object({
  text: Type.String({ minLength: 1 }),
  replyTo: Type.Optional(PostId),
  quote: Type.Optional(PostId),
  media: Type.Optional(
    Type.Array(Type.Object({ file: Type.String({ description: "a local path" }), alt: Type.Optional(Type.String()) }), { maxItems: 4 }),
  ),
  poll: Type.Optional(
    Type.Object({
      options: Type.Array(Type.String({ minLength: 1, maxLength: 25 }), { minItems: 2, maxItems: 4 }),
      durationMinutes: Type.Integer({ minimum: 5, maximum: 10080 }),
    }),
  ),
});

export const PostAction = Type.Object({
  action: Type.Union([
    Type.Literal("like"),
    Type.Literal("unlike"),
    Type.Literal("repost"),
    Type.Literal("unrepost"),
    Type.Literal("bookmark"),
    Type.Literal("unbookmark"),
    Type.Literal("delete"),
  ]),
  post: PostId,
});

export const UserAction = Type.Object({
  action: Type.Union([
    Type.Literal("follow"),
    Type.Literal("unfollow"),
    Type.Literal("mute"),
    Type.Literal("unmute"),
    Type.Literal("block"),
    Type.Literal("unblock"),
  ]),
  user: UserId,
});

export const MessageDraft = Type.Object({ to: Type.Array(UserId, { minItems: 1 }), text: Type.String({ minLength: 1 }) });

export type Count = Static<typeof Count>;
export type UserRef = Static<typeof UserRef>;
export type Entities = Static<typeof Entities>;
export type Media = Static<typeof Media>;
export type Card = Static<typeof Card>;
export type Poll = Static<typeof Poll>;
export type CommunityNote = Static<typeof CommunityNote>;
export type Edits = Static<typeof Edits>;
export type PostViewer = Static<typeof PostViewer>;
export type PostCounts = Static<typeof PostCounts>;
export type UnavailableReason = Static<typeof UnavailableReason>;
export type Unavailable = Static<typeof Unavailable>;
export type QuotedPost = Static<typeof QuotedPost>;
export type Post = Static<typeof Post>;
export type Repost = Static<typeof Repost>;
export type Entry = Static<typeof Entry>;
export type Relationship = Static<typeof Relationship>;
export type User = Static<typeof User>;
export type UserUnavailable = Static<typeof UserUnavailable>;
export type XList = Static<typeof XList>;
export type NotificationType = Static<typeof NotificationType>;
export type Notification = Static<typeof Notification>;
export type ReplyGroup = Static<typeof ReplyGroup>;
export type Thread = Static<typeof Thread>;
export type Draft = Static<typeof Draft>;
export type PostAction = Static<typeof PostAction>;
export type UserAction = Static<typeof UserAction>;
export type MessageDraft = Static<typeof MessageDraft>;
export type Page<T> = { items: T[]; more?: boolean; cursor?: string; pinned?: string[] };

/** A post's link that works whatever its author is called now. */
export const postUrl = (id: string): string => `https://x.com/i/status/${id}`;

/** The first ids are counters, not snowflakes: X switched on 2010-11-04, near this id. */
const FIRST_SNOWFLAKE = 29_700_000_000n;

/**
 * When a post was made, from its id alone: X's ids since 2010-11-04 are snowflakes, milliseconds
 * since then in the top bits. Undefined for an older id (jack/status/20), which holds no time.
 */
export const timeOfId = (id: string): string | undefined => {
  const n = BigInt(id);
  return n < FIRST_SNOWFLAKE ? undefined : new Date(Number((n >> 22n) + 1288834974657n)).toISOString();
};

/** The post an entry is about: a repost's original, or the post itself. */
export const postOf = (entry: Entry): Post | Unavailable => (entry.kind === "repost" ? entry.post : entry);

/** "@handle" or the id: how a person reads an account reference. */
export const who = (u: UserRef): string => (u.handle ? `@${u.handle}` : (u.id ?? "?"));

const n = (c?: Count) => (c ? `${c.exact ? "" : "~"}${c.value}` : "?");

/** One entry as a person reads it in the terminal: who, when, the text, and the counts. */
export const entryText = (entry: Entry): string => {
  if (entry.kind === "unavailable")
    return `[${entry.reason}] ${entry.message ?? "post unavailable"}${entry.id ? ` ${postUrl(entry.id)}` : ""}`;
  if (entry.kind === "repost") return `${who(entry.by)} reposted:\n${entryText(entry.post)}`;
  const c = entry.counts;
  const counts = c
    ? `  ${n(c.replies)} replies · ${n(c.reposts)} reposts · ${n(c.likes)} likes${c.views ? ` · ${n(c.views)} views` : ""}`
    : "";
  const quoted = entry.quoted ? `\n  > ${entryText(entry.quoted).replace(/\n/g, "\n  > ")}` : "";
  const time = entry.createdAt ?? timeOfId(entry.id);
  return `${who(entry.author)} · ${time ? `${time} · ` : ""}${postUrl(entry.id)}\n${entry.text}${quoted}${counts ? `\n${counts}` : ""}`;
};
