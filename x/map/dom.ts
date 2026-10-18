// What the page shows of a timeline (helpers' `readPosts` reads it in the browser) mapped to the
// model in ../model.ts, as `source: "dom"` entries. Pure functions, like ./graphql.ts.
//
// UNCONFIRMED: the DOM shapes are from knowledge/x.md's seed and data-model.md's "How the DOM fills
// it", not yet checked against this account. The DOM has no user ids, no repost ids and rounded
// counts; an op that needs those reads GraphQL.
import type { Count, Entry, Post, PostCounts, PostViewer, QuotedPost } from "../model";
import { clean, nonEmpty, reasonOfText } from "./graphql";

/** One timeline cell as the browser read it: a post's parts, or the text of a tombstone in its place. */
export interface Article {
  /** The permalink around the post's `time`: `/<handle>/status/<id>`. */
  href?: string;
  time?: string;
  /** The author's display name, User-Name's first link. */
  name?: string;
  text?: string;
  lang?: string;
  /** The text ends in "Show more": it is cut short. */
  showMore?: boolean;
  /** The aria-label of each of the post's buttons, by data-testid (reply, like or unlike, ...). */
  labels: Record<string, string>;
  /** The analytics link's aria-label. */
  views?: string;
  /** The line above the post ("Ada reposted", "Pinned") and where it links. */
  context?: { text: string; href?: string };
  /** The embedded quote; `href` only when X put a permalink in it. */
  quote?: { href?: string; name?: string; text?: string; time?: string; lang?: string };
  /** X's sentence in a cell that has no post ("This Post was deleted by the Post author. Learn more"). */
  tombstone?: string;
}

const permalink = (href?: string) => {
  const m = href?.match(/^(?:https:\/\/(?:x|twitter)\.com)?\/(\w{1,15})\/status\/(\d+)/);
  return m ? { handle: m[1]!, id: m[2]! } : undefined;
};
const iso = (t?: string) => (t && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString() : undefined);

/**
 * A count as X writes it, "1,204 Likes. Like" or "12K". K and M are rounded, so `exact: false`. A
 * plain number is taken as exact: X rounds only with a suffix (unconfirmed: data-model.md, open question 1).
 */
export const count = (label?: string): Count | undefined => {
  const m = label?.match(/(\d[\d.,]*)(?:\s?([KM])(?![a-z]))?/i);
  if (!m) return undefined;
  if (!m[2]) return { value: Number(m[1]!.replace(/[.,]/g, "")), exact: true };
  const value = Number(m[1]!.replace(",", ".")) * (/k/i.test(m[2]) ? 1_000 : 1_000_000);
  return { value: Math.round(value), exact: false };
};

/** A button with no number in its label shows none of it: X leaves 0 out (inferred). */
const button = (label?: string): Count | undefined => (label === undefined ? undefined : (count(label) ?? { value: 0, exact: true }));

/** The button X shows says which way it would go: `unlike` means the account liked it (inferred). */
const toggled = (labels: Record<string, string>, on: string, off: string) => (on in labels ? true : off in labels ? false : undefined);

/** One cell as an Entry; undefined for a cell that is neither a post nor a tombstone. */
export const entryFromArticle = (a: Article): Entry | undefined => {
  if (a.tombstone) return { kind: "unavailable", reason: reasonOfText(a.tombstone), message: a.tombstone, source: "dom" };
  const link = permalink(a.href);
  if (!link) return undefined;
  const l = a.labels;
  const q = a.quote && permalink(a.quote.href);
  const quoted: QuotedPost | undefined = q
    ? clean({
        kind: "post" as const,
        id: q.id,
        source: "dom" as const,
        author: clean({ handle: q.handle, name: a.quote?.name }),
        createdAt: iso(a.quote?.time),
        text: a.quote?.text ?? "",
        lang: a.quote?.lang,
      })
    : undefined;
  const counts: PostCounts | undefined = nonEmpty({
    replies: button(l.reply),
    reposts: button(l.retweet ?? l.unretweet),
    likes: button(l.like ?? l.unlike),
    bookmarks: button(l.bookmark ?? l.removeBookmark),
    views: count(a.views),
  });
  const viewer: PostViewer | undefined = nonEmpty({
    liked: toggled(l, "unlike", "like"),
    reposted: toggled(l, "unretweet", "retweet"),
    bookmarked: toggled(l, "removeBookmark", "bookmark"),
  });
  const post: Post = clean({
    kind: "post" as const,
    id: link.id,
    source: "dom" as const,
    author: clean({ handle: link.handle, name: a.name }),
    createdAt: iso(a.time),
    text: a.text ?? "",
    truncated: a.showMore ? (true as const) : undefined,
    lang: a.lang,
    quotedId: quoted?.id,
    quoted,
    counts,
    viewer,
  });
  // A repost is the original post under "<name> reposted", which links to the reposter.
  const by = a.context && /reposted/i.test(a.context.text) ? a.context.href?.match(/^\/(\w{1,15})$/)?.[1] : undefined;
  return by ? { kind: "repost", source: "dom", by: { handle: by }, post } : post;
};
