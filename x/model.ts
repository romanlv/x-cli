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
    blue: Type.Optional(Type.Boolean({ description: "has the blue check (X Premium); only where a post's GraphQL author says" })),
    verifiedType: Type.Optional(Type.String({ description: "Business, Government, ... as X names it; only when verified that way" })),
    followers: Type.Optional(Count),
  },
  {
    description:
      "at least one of id and handle; id from GraphQL and the API, the DOM has only the handle. blue, verifiedType and followers are from a post's GraphQL author, to judge the account; never avatar or banner, which only a User has",
  },
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
  type: Type.Union([Type.Literal("photo"), Type.Literal("video"), Type.Literal("gif")]),
  url: Type.String({ description: "the image; for a video or gif, its preview image" }),
  alt: Type.Optional(Type.String({ description: "alt text, when the author wrote one" })),
  durationMs: Type.Optional(Type.Integer()),
  video: Type.Optional(
    Type.String({ description: "a video's or gif's best mp4 (highest bitrate); X also serves lower bitrates, left out" }),
  ),
  stream: Type.Optional(Type.String({ description: "a video's HLS playlist (m3u8)" })),
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
  /** The number beside the repost button, which counts quotes too: the DOM's only one, where GraphQL splits them. */
  repostsAndQuotes: Type.Optional(Count),
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
  reason: Type.Optional(
    Type.String({
      description:
        'why X shows this account in a list of suggestions, in X\'s words ("Followed by Ada", a topic); left out when X gives none',
    }),
  ),
  withheldIn: Type.Optional(Type.Array(Type.String())),
});

export const UserUnavailable = Type.Object({
  kind: Type.Literal("user-unavailable"),
  id: Type.Optional(UserId),
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
 * bottom cursor, set only by the one-response mappers (postsPage, usersPage) and for the API
 * source: ops never send their own calls, so a later read resumes from an id (`until`), and
 * app.timeline and app.posts leave it out, since a cursor past a page cut at `limit` would skip
 * what was cut. `pinned` names the items X pinned above the timeline (a profile's pinned post):
 * they are out of its order, and `until` never stops at them.
 */
export const Page = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item),
    more: Type.Optional(Type.Boolean()),
    cursor: Type.Optional(Type.String()),
    pinned: Type.Optional(Type.Array(PostId, { description: "ids of the items X pinned to the top, out of the timeline's order" })),
  });

/**
 * A bounded read of accounts: followers, following, search's People, X's suggestions. Only `items` and
 * `more`: no `pinned` (accounts pin nothing) and no `cursor` (ops never resume one of X's).
 */
export const UsersPage = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item),
    more: Type.Optional(Type.Boolean()),
  });

/** Replies shown together: X's conversation module, a reply to the focal post and the replies under it. */
export const ReplyGroup = Type.Object({
  posts: Type.Array(Type.Union([Post, Unavailable])),
  selfThread: Type.Optional(Type.Literal(true, { description: "the focal author continuing their own thread" })),
  more: Type.Optional(Type.Boolean({ description: "X folds more replies under this group" })),
  section: Type.Optional(
    Type.String({ description: 'the heading X put over these replies, which it folds away until a person opens them ("Probable spam")' }),
  ),
});

/** A post with what it replies to and what replies to it, as TweetDetail (`/<handle>/status/<id>`) gives it. */
export const Thread = Type.Object({
  conversationId: Type.Optional(PostId),
  focal: Type.Union([Post, Unavailable]),
  ancestors: Type.Array(Type.Union([Post, Unavailable]), { description: "the chain above the focal post, oldest first" }),
  replies: Type.Array(ReplyGroup),
  more: Type.Optional(Type.Boolean({ description: "X has more reply groups past these: raising the limit, or scrolling, reads them" })),
  folded: Type.Optional(
    Type.String({
      description:
        'the button X leaves closed under the replies ("Show probable spam", "Show additional replies"); empty when X gives no text. Set while `more` is true because of it',
    }),
  ),
  unshown: Type.Optional(
    Type.Object(
      {
        count: Type.Integer({ minimum: 1, description: "replies X counts on the post that this read has none of" }),
        reason: Type.Optional(Type.String({ description: "what X says about them, when it says anything" })),
      },
      {
        description: "X counts replies on the post that it does not show, folds included; only when X ended the replies (`more` is false)",
      },
    ),
  ),
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
export type UsersPage<T> = { items: T[]; more?: boolean };

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

const RULE = "─".repeat(60);
const WIDTH = 80;
const TEXT_LINES = 4;
const TEXT_CHARS = 280;
const QUOTE_LINES = 2;
const QUOTE_CHARS = 140;

/** A count as a person reads it: 10,000 and over rounded ("12K", "1.5M"), "~" when X rounded it already. */
const n = (c?: Count) => {
  if (!c) return "?";
  const v = c.value;
  const short = (d: number, unit: string) => `${(v / d).toFixed(1).replace(/\.0$/, "")}${unit}`;
  const shown = v >= 1_000_000 ? short(1_000_000, "M") : v >= 10_000 ? short(1000, "K") : String(v);
  return `${c.exact ? "" : "~"}${shown}`;
};

/** "1 reply", "2 replies": a count with its noun in the number it has. */
const counted = (c: Count | undefined, one: string, many: string) => `${n(c)} ${c?.value === 1 ? one : many}`;

/** A number of things that is always exact (a page's length): "1 post", "3 posts". */
const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** Where a link points when it is the post's own media or the quoted post, which are shown anyway. */
const isShownAnyway = (
  expanded: string | undefined,
  post: { id?: string; media?: unknown[]; quotedId?: string; quoted?: { id?: string } },
) => {
  if (!expanded) return false;
  // Only this post's own media link: a link to another post's photo is a link worth keeping.
  const own = /^https?:\/\/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)\/(?:photo|video)\/\d+/.exec(expanded)?.[1];
  if (own && post.id === own && post.media?.length) return true;
  const quoted = post.quoted?.id ?? post.quotedId;
  return !!quoted && new RegExp(`^https?://(?:x|twitter)\\.com/[^/]+/status/${quoted}(?:[/?#]|$)`).test(expanded);
};

/**
 * A post's text with its links as X shows them (`nasa.gov/maxpower/`, from the entities' display or
 * expanded link) instead of t.co, and without a trailing t.co that only points at the post's own media
 * or at the quoted post, both shown with the post. The DOM's text has no t.co links and no entities,
 * so it comes back as it is. Entity offsets are code points into GraphQL's text.
 */
export const textWithLinks = (post: {
  id?: string;
  text: string;
  quotedId?: string;
  quoted?: { id?: string } | { kind: "unavailable"; id?: string };
  media?: unknown[];
  entities?: Entities;
}): string => {
  const entityUrls = post.entities?.urls ?? [];
  let text = post.text;
  // The media's own t.co is in the media entities, not the urls: a trailing one that no url names points at the post's own media.
  const tail = /\s*(https:\/\/t\.co\/\w+)\s*$/.exec(text);
  if (tail && (post.media?.length || post.quoted || post.quotedId) && !entityUrls.some((u) => u.url === tail[1])) {
    text = text.slice(0, tail.index);
  }
  const chars = Array.from(text);
  for (const u of [...entityUrls].sort((a, b) => b.start - a.start)) {
    if (chars.slice(u.start, u.end).join("") !== u.url) continue;
    const last = chars.slice(u.end).join("").trim() === "";
    const gone = last && isShownAnyway(u.expanded, post);
    // X cuts a long display_url with "…": the expanded link is whole.
    const display = u.display?.endsWith("…") && u.expanded ? undefined : u.display;
    const shown = gone ? "" : (display ?? u.expanded?.replace(/^https?:\/\//, "") ?? u.url);
    chars.splice(u.start, u.end - u.start, ...Array.from(shown));
  }
  return chars.join("").trimEnd();
};

/**
 * A post's text for a terminal: newlines folded into spaces (a URL the text splits across lines is
 * rejoined), wrapped at `width`, and cut at a word after `maxLines` lines or `maxChars` characters,
 * with an ellipsis. `cut` marks text already cut where it was read.
 */
const clip = (text: string, width: number, maxLines: number, maxChars: number, cut = false): string[] => {
  let folded = text
    .replace(/(https?:\/\/)\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  let truncated = cut;
  if (folded.length > maxChars) {
    const head = folded.slice(0, maxChars);
    const space = head.lastIndexOf(" ");
    folded = (space > 0 ? head.slice(0, space) : head).trimEnd();
    truncated = true;
  }
  const lines: string[] = [];
  for (const word of folded.split(" ").filter(Boolean)) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last]!.length + 1 + word.length <= width) lines[last] += ` ${word}`;
    else lines.push(word);
  }
  if (lines.length > maxLines) {
    lines.length = maxLines;
    truncated = true;
  }
  if (truncated) {
    if (lines.length === 0) lines.push("");
    lines[lines.length - 1] += "…";
  }
  return lines;
};

const unavailableText = (u: Unavailable) => `[${u.reason}] ${u.message ?? "post unavailable"}${u.id ? ` ${postUrl(u.id)}` : ""}`;

/** "Ada Lovelace @ada · 2026-10-18 14:05": who, and when in UTC, from the post or else from its id. */
const header = (post: { id: string; author: UserRef; createdAt?: string }): string => {
  const time = (post.createdAt ?? timeOfId(post.id))?.slice(0, 16).replace("T", " ");
  const name = post.author.name && post.author.handle ? `${post.author.name} ` : "";
  return `${name}${who(post.author)}${time ? ` · ${time}` : ""}`;
};

/** The counts line of a post: replies, reposts, likes, views, and the extra counts (quotes, bookmarks) when asked for. */
const countsLine = (c: PostCounts, extra = false): string => {
  const reposts =
    c.reposts || !c.repostsAndQuotes
      ? counted(c.reposts, "repost", "reposts")
      : counted(c.repostsAndQuotes, "repost and quote", "reposts and quotes");
  const parts = [counted(c.replies, "reply", "replies"), reposts];
  if (extra && (c.reposts || !c.repostsAndQuotes)) parts.push(counted(c.quotes, "quote", "quotes"));
  parts.push(counted(c.likes, "like", "likes"));
  if (extra) parts.push(counted(c.bookmarks, "bookmark", "bookmarks"));
  if (c.views) parts.push(counted(c.views, "view", "views"));
  return parts.join(" · ");
};

/**
 * One entry as a person reads it in the terminal: a block of a header (who, when), the text cut to a
 * few lines, a quoted post indented under it, one line of counts, and the link. Plain text, so it
 * can be kept and shown later; `--json` has everything.
 */
export const entryText = (entry: Entry): string => {
  if (entry.kind === "unavailable") return unavailableText(entry);
  if (entry.kind === "repost") {
    const name = entry.by.name && entry.by.handle ? `${entry.by.name} ` : "";
    const time = (entry.createdAt ?? (entry.id ? timeOfId(entry.id) : undefined))?.slice(0, 16).replace("T", " ");
    return `↻ ${name}${who(entry.by)} reposted${time ? ` · ${time}` : ""}\n${entryText(entry.post)}`;
  }
  const lines = [header(entry)];
  lines.push(...clip(textWithLinks(entry), WIDTH, TEXT_LINES, TEXT_CHARS, entry.truncated).filter(Boolean));
  const q = entry.quoted;
  if (q?.kind === "unavailable") lines.push(`  ┃ ${unavailableText(q)}`);
  else if (q) {
    lines.push(`  ┃ ${header(q)}`);
    for (const l of clip(textWithLinks(q), WIDTH - 4, QUOTE_LINES, QUOTE_CHARS, q.truncated)) if (l) lines.push(`  ┃ ${l}`);
  }
  if (entry.counts) lines.push(`  ${countsLine(entry.counts)}`);
  lines.push(`  ${postUrl(entry.id)}`);
  return lines.join("\n");
};

/**
 * A page of entries: blocks with a rule between them, and when there is more, how to read on: older
 * posts need a higher `--limit` (`--until` reads only newer posts on a later poll, so it is named as
 * that, with the newest id), and a timeline that is not in id order names only `--limit`.
 * A pinned entry (`pinned`) is marked, and is not the newest: it sits out of the timeline's order.
 */
export const pageText = (page: { items: Entry[]; more?: boolean; pinned?: string[] }, byId = true): string => {
  if (page.items.length === 0) return "no posts";
  const pins = new Set(page.pinned);
  const blocks = page.items.map((e) => (e.id && pins.has(e.id) ? `📌 pinned\n${entryText(e)}` : entryText(e)));
  const ids = page.items.flatMap((e) => (e.id && !pins.has(e.id) ? [BigInt(e.id)] : []));
  // The newest by id, not the first: a self-thread's 1/ sits above its newer 2/.
  const newest = ids.length ? ids.reduce((a, b) => (b > a ? b : a)) : undefined;
  if (page.more && newest) {
    const hint = byId
      ? `raise --limit for older posts; next time --until ${newest} gets only posts newer than this`
      : "raise --limit for older posts";
    blocks.push(`${plural(page.items.length, "post", "posts")} · more: ${hint}`);
  }
  return blocks.join(`\n${RULE}\n`);
};

/** `pageText` for a timeline X ranks (home), which has no `--until` to read on from. */
export const rankedPageText = (page: { items: Entry[]; more?: boolean }): string => pageText(page, false);

/**
 * The post a thread is about, laid out as a list post (header, text, quote, counts, link) with its
 * extra counts on the counts line. Its text is not cut: it is the post being read. Its media, links,
 * card and poll are lines of their own.
 */
const focalText = (post: Post | Unavailable): string => {
  if (post.kind === "unavailable") return unavailableText(post);
  const lines = [header(post), ...clip(textWithLinks(post), WIDTH, Infinity, Infinity).filter(Boolean)];
  for (const m of post.media ?? []) lines.push(`  [${m.type}] ${m.url}${m.alt ? ` — ${m.alt}` : ""}`);
  if (post.card?.title) lines.push(`  card: ${post.card.title}${post.card.domain ? ` (${post.card.domain})` : ""}`);
  if (post.poll) lines.push(...post.poll.options.map((o) => `  poll: ${o.label}${o.votes ? ` · ${n(o.votes)}` : ""}`));
  const q = post.quoted;
  if (q?.kind === "unavailable") lines.push(`  ┃ ${unavailableText(q)}`);
  else if (q) {
    lines.push(`  ┃ ${header(q)}`);
    for (const l of clip(textWithLinks(q), WIDTH - 4, QUOTE_LINES, QUOTE_CHARS, q.truncated)) if (l) lines.push(`  ┃ ${l}`);
  }
  if (post.counts) lines.push(`  ${countsLine(post.counts, true)}`);
  lines.push(`  ${postUrl(post.id)}`);
  return lines.join("\n");
};

/**
 * A post's page as text: the posts above it oldest first, the post in full under a marker, then its
 * replies in X's order (a self-thread's continuation marked), each as `entryText` cuts it, and what
 * was left out. `--json` has everything.
 */
export const threadText = (thread: Thread): string => {
  const blocks: string[] = [];
  if (thread.ancestors.length) blocks.push(`↑ ${thread.ancestors.length} above, oldest first`, ...thread.ancestors.map(entryText));
  blocks.push(`▶ the post\n${focalText(thread.focal)}`);
  const posts = thread.replies.reduce((sum, g) => sum + g.posts.length, 0);
  if (thread.replies.length) {
    blocks.push(`↓ ${posts} ${posts === 1 ? "reply" : "replies"}, in X's order`);
    let section: string | undefined;
    for (const g of thread.replies) {
      if (g.section !== section && g.section) blocks.push(`under X's "${g.section}" fold`);
      section = g.section;
      blocks.push(...g.posts.map((p, i) => (g.selfThread && i === 0 ? `the author continues\n${entryText(p)}` : entryText(p))));
    }
  } else if (thread.focal.kind === "post" && !thread.unshown && !thread.more) blocks.push("no replies");
  const u = thread.unshown;
  if (u) {
    const of = thread.focal.kind === "post" ? thread.focal.counts?.replies?.value : undefined;
    const why = u.reason ? `: ${u.reason}` : "; X gives no reason";
    blocks.push(
      `X counts ${of ?? u.count} ${of === 1 ? "reply" : "replies"} on this post and ${posts ? `shows ${posts}` : "shows none of them"}${why}`,
    );
  }
  if (thread.more) {
    const fold = thread.folded;
    blocks.push(
      fold
        ? `more replies than these, folded under "${fold}": raise --limit to open it, or see the post on x.com`
        : "more replies than these: raise --limit, or see the post on x.com",
    );
  }
  return blocks.join(`\n${RULE}\n`);
};

/** One account as a person reads it in the terminal: who, how it relates to the viewer, its bio and counts. */
export const userText = (user: User | UserUnavailable): string => {
  if (user.kind === "user-unavailable") return `[${user.reason}] ${user.message ?? "account unavailable"}${user.id ? ` ${user.id}` : ""}`;
  const r = user.relationship;
  const tags = [r?.following && "following", r?.followedBy && "follows you", user.protected && "protected"].filter(Boolean);
  const lines = [`${user.name ? `${user.name} ` : ""}@${user.handle}${tags.length ? ` · ${tags.join(" · ")}` : ""}`];
  if (user.reason) lines.push(`  ${user.reason}`);
  lines.push(
    ...clip(user.bio ?? "", WIDTH - 2, 2, 160)
      .filter(Boolean)
      .map((l) => `  ${l}`),
  );
  const c = user.counts;
  if (c)
    lines.push(`  ${counted(c.followers, "follower", "followers")} · ${n(c.following)} following · ${counted(c.posts, "post", "posts")}`);
  lines.push(`  https://x.com/${user.handle}`);
  return lines.join("\n");
};

/** A page of accounts: blocks with a rule between them, and when there is more, how to read on. */
export const usersText = (page: { items: (User | UserUnavailable)[]; more?: boolean }): string => {
  if (page.items.length === 0) return "no accounts";
  const blocks = page.items.map(userText);
  if (page.more) blocks.push(`${plural(page.items.length, "account", "accounts")} · more: raise --limit`);
  return blocks.join(`\n${RULE}\n`);
};
