// The web app's GraphQL JSON (what `app.graphql(...)` returns) mapped to the model in ../model.ts.
// Pure functions: JSON in, plain objects out. Nothing here reads a page or makes a call.
//
// UNCONFIRMED: these shapes are written against what maintained open-source clients parse and their
// test data (twscrape models.py/utils.py and tests/mocked-data at 568844d, 2026-10-05; twikit
// tweet.py/user.py/list.py/client.py; the-convocation/twitter-scraper timeline-v2.ts at 0e528fa,
// 2026-03-31; yt-dlp's twitter extractor), not yet against this account's own responses. The first
// op that uses a mapper confirms its shape and says so in knowledge/x.md.
//
// X serves two shapes at once and moves fields between them: older `legacy` objects, and since
// 2025-2026 users with no `legacy` (core, avatar, privacy, relationship_counts, ...) and, since
// 2026-05 per twscrape, posts with `legacy` null and its fields at the top. Every read here looks in
// both places.
import type {
  Card,
  Count,
  Edits,
  Entities,
  Entry,
  Media,
  Page,
  Poll,
  Post,
  QuotedPost,
  Relationship,
  ReplyGroup,
  Repost,
  Thread,
  Unavailable,
  UnavailableReason,
  User,
  UserRef,
  UserUnavailable,
  XList,
} from "../model";

type Json = Record<string, unknown>;

const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const obj = (x: unknown): Json => (isObj(x) ? x : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);
const bool = (x: unknown): boolean | undefined => (typeof x === "boolean" ? x : undefined);
/** X writes some numbers as strings ("25900", "5"). */
const int = (x: unknown): number | undefined => {
  const n = typeof x === "number" ? x : typeof x === "string" && /^\d+$/.test(x) ? Number(x) : undefined;
  return n !== undefined && Number.isFinite(n) ? n : undefined;
};
const at = (x: unknown, ...path: string[]): unknown => path.reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), x);
const count = (x: unknown): Count | undefined => {
  const value = int(x);
  return value === undefined ? undefined : { value, exact: true };
};
/** Drops keys whose value is undefined, so an absent field stays absent in JSON and in Value.Check. */
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const nonEmpty = <T extends object>(o: T): T | undefined => {
  const c = clean(o);
  return Object.keys(c).length ? c : undefined;
};

const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";
/** X's "Wed Jul 08 21:59:10 +0000 2026" as ISO 8601. */
export const xTime = (s: unknown): string | undefined => {
  const m = str(s)?.match(/^\w{3} (\w{3}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{2})(\d{2}) (\d{4})$/);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1]!) / 3;
  if (month < 0) return undefined;
  const utc = Date.UTC(Number(m[8]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  const sign = m[6]!.startsWith("-") ? -1 : 1;
  const offset = sign * (Math.abs(Number(m[6])) * 60 + Number(m[7])) * 60_000;
  return new Date(utc - offset).toISOString();
};
const msTime = (x: unknown): string | undefined => {
  const n = int(x);
  return n === undefined ? undefined : new Date(n).toISOString();
};

/** A post's fields, wherever this response put them: `legacy` first, the top level over it. */
const fields = (t: Json): Json => ({
  ...obj(t.legacy),
  ...Object.fromEntries(Object.entries(t).filter(([k, v]) => k !== "legacy" && v != null)),
});

// ---- accounts ----

/** The fields of a user result, old shape (`legacy`) and new (core, avatar, privacy, ...) together. */
const userFields = (u: Json) => {
  const l = obj(u.legacy);
  const core = obj(u.core);
  return {
    id: str(u.rest_id) ?? str(l.id_str),
    handle: str(core.screen_name) ?? str(l.screen_name),
    name: str(core.name) ?? str(l.name),
    l,
    core,
  };
};

/** How a post names an account: its id, handle and name, from a user result. */
export const userRefFromResult = (result: unknown): UserRef | undefined => {
  const u = obj(result);
  if (u.__typename === "UserUnavailable") return undefined;
  const { id, handle, name } = userFields(u);
  return id || handle ? clean({ id, handle, name }) : undefined;
};

const userUnavailable = (u: Json, id?: string): UserUnavailable => {
  const reason = str(u.reason);
  return clean({
    kind: "user-unavailable" as const,
    id: str(u.rest_id) ?? id,
    reason: reason === "Suspended" ? ("suspended" as const) : reason === "Deactivated" ? ("deactivated" as const) : ("unknown" as const),
    message: str(u.message),
    source: "graphql" as const,
  });
};

/** A user result (UserByScreenName's `data.user.result`, a timeline's `user_results.result`). Undefined for a stub with no handle. */
export const userFromResult = (result: unknown): User | UserUnavailable | undefined => {
  const u = obj(result);
  if (u.__typename === "UserUnavailable") return userUnavailable(u);
  const { id, handle, name, l, core } = userFields(u);
  if (!id || !handle) return undefined;
  const bio = obj(u.profile_bio);
  const rp = obj(u.relationship_perspectives);
  const relationship: Relationship | undefined = nonEmpty({
    following: bool(rp.following) ?? bool(l.following),
    followedBy: bool(rp.followed_by) ?? bool(l.followed_by),
    followRequestSent: bool(u.follow_request_sent) ?? bool(l.follow_request_sent),
    blocking: bool(rp.blocking) ?? bool(l.blocking),
    blockedBy: bool(rp.blocked_by) ?? bool(l.blocked_by),
    muting: bool(rp.muting) ?? bool(l.muting),
  });
  const urls = arr(at(bio, "entities", "url", "urls") ?? at(l, "entities", "url", "urls"));
  const location = isObj(u.location) ? str(u.location.location) : (str(u.location) ?? str(l.location));
  return clean({
    kind: "user" as const,
    id,
    source: "graphql" as const,
    handle,
    name: name ?? "",
    bio: str(bio.description) ?? str(l.description),
    location,
    website: str(at(urls[0], "expanded_url")) ?? str(at(u, "website", "url")),
    createdAt: xTime(core.created_at ?? l.created_at),
    avatar: str(at(u, "avatar", "image_url")) || str(l.profile_image_url_https),
    banner: str(at(u, "banner", "image_url")) ?? str(l.profile_banner_url),
    protected: bool(at(u, "privacy", "protected")) ?? bool(l.protected),
    blue: bool(u.is_blue_verified),
    verifiedType: str(at(u, "verification", "verified_type")) ?? str(l.verified_type),
    counts: nonEmpty({
      followers: count(at(u, "relationship_counts", "followers") ?? l.followers_count),
      following: count(at(u, "relationship_counts", "following") ?? l.friends_count),
      posts: count(at(u, "tweet_counts", "tweets") ?? l.statuses_count),
      media: count(at(u, "tweet_counts", "media_tweets") ?? l.media_count),
      likes: count(at(u, "action_counts", "favorites_count") ?? l.favourites_count),
      listed: count(l.listed_count),
    }),
    pinned: (() => {
      const ids = at(u, "pinned_items", "tweet_ids_str") ?? l.pinned_tweet_ids_str;
      return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : undefined;
    })(),
    relationship,
    withheldIn: Array.isArray(l.withheld_in_countries) ? l.withheld_in_countries.map(String) : undefined,
  });
};

// ---- lists ----

/** A list result (`data.list`, a timeline's `list` item). Shape from twikit list.py: unconfirmed. */
export const listFromResult = (result: unknown): XList | undefined => {
  const r = obj(result);
  const id = str(r.id_str) ?? str(r.rest_id);
  const name = str(r.name);
  if (!id || !name) return undefined;
  return clean({
    kind: "list" as const,
    id,
    source: "graphql" as const,
    name,
    description: str(r.description),
    private: r.mode === "Private" ? true : r.mode === "Public" ? false : undefined,
    owner: userRefFromResult(at(r, "user_results", "result")),
    createdAt: msTime(r.created_at),
    counts: nonEmpty({ members: count(r.member_count), followers: count(r.subscriber_count) }),
  });
};

// ---- posts ----

const range = (x: unknown) => {
  const [start, end] = arr(at(x, "indices")).map(int);
  return start !== undefined && end !== undefined ? { start, end } : undefined;
};

const entitiesOf = (e: Json): Entities => {
  const ranged = <T>(list: unknown, f: (x: Json, r: { start: number; end: number }) => T | undefined): T[] =>
    arr(list).flatMap((x) => {
      const r = range(x);
      const v = r && f(obj(x), r);
      return v ? [v] : [];
    });
  return {
    mentions: ranged(e.user_mentions, (x, r) => {
      const handle = str(x.screen_name);
      return handle ? clean({ ...r, handle, id: str(x.id_str) }) : undefined;
    }),
    hashtags: ranged(e.hashtags, (x, r) => (str(x.text) ? { ...r, tag: str(x.text)! } : undefined)),
    cashtags: ranged(e.symbols, (x, r) => (str(x.text) ? { ...r, tag: str(x.text)! } : undefined)),
    urls: ranged(e.urls, (x, r) =>
      str(x.url) ? clean({ ...r, url: str(x.url)!, expanded: str(x.expanded_url), display: str(x.display_url) }) : undefined,
    ),
  };
};

const MEDIA_TYPE: Record<string, Media["type"]> = { photo: "photo", video: "video", animated_gif: "gif" };

const mediaOf = (list: unknown): Media[] =>
  arr(list).flatMap((x) => {
    const m = obj(x);
    const type = MEDIA_TYPE[str(m.type) ?? ""];
    const url = str(m.media_url_https);
    if (!type || !url) return [];
    const video = obj(m.video_info);
    const variants = arr(video.variants).flatMap((v) => {
      const o = obj(v);
      return str(o.url) && str(o.content_type)
        ? [clean({ url: str(o.url)!, contentType: str(o.content_type)!, bitrate: int(o.bitrate) })]
        : [];
    });
    return [
      clean({
        key: str(m.media_key),
        type,
        url,
        alt: str(m.ext_alt_text),
        width: int(at(m, "original_info", "width")),
        height: int(at(m, "original_info", "height")),
        durationMs: int(video.duration_millis),
        variants: variants.length ? variants : undefined,
        views: count(at(m, "mediaStats", "viewCount")),
      }),
    ];
  });

/** A card's binding_values, a list of { key, value: { type, string_value | boolean_value | image_value } }, as a map. */
const bindings = (card: Json): Map<string, Json> =>
  new Map(arr(at(card, "legacy", "binding_values")).map((b) => [str(at(b, "key")) ?? "", obj(at(b, "value"))]));

const POLL = /(?:^|:)poll\d*choice/;

const pollOf = (name: string, values: Map<string, Json>): Poll | undefined => {
  if (!POLL.test(name)) return undefined;
  const options: Poll["options"] = [];
  for (let i = 1; values.has(`choice${i}_label`); i++) {
    const label = str(values.get(`choice${i}_label`)?.string_value) ?? "";
    options.push(clean({ label, votes: count(values.get(`choice${i}_count`)?.string_value) }));
  }
  const end = str(values.get("end_datetime_utc")?.string_value);
  return clean({
    options,
    endsAt: end ? new Date(end).toISOString() : undefined,
    durationMinutes: int(values.get("duration_minutes")?.string_value),
    closed: bool(values.get("counts_are_final")?.boolean_value),
  });
};

const cardOf = (name: string, values: Map<string, Json>): Card => {
  const s = (k: string) => str(values.get(k)?.string_value);
  const image = ["thumbnail_image_original", "summary_photo_image_original", "photo_image_full_size_original", "player_image_original"]
    .map((k) => str(at(values.get(k), "image_value", "url")))
    .find(Boolean);
  return clean({ name, url: s("card_url"), title: s("title"), description: s("description"), domain: s("vanity_url"), image });
};

const editsOf = (t: Json): Edits | undefined => {
  const ec = obj(t.edit_control);
  const src = Array.isArray(ec.edit_tweet_ids) ? ec : obj(ec.edit_control_initial);
  const versions = arr(src.edit_tweet_ids).filter((x): x is string => typeof x === "string");
  if (!versions.length) return undefined;
  return clean({ versions, editableUntil: msTime(src.editable_until_msecs), remaining: int(src.edits_remaining) });
};

/** X's tombstone sentence → why the post is gone. The sentences are X's and may change: unknown is the fallback. */
const reasonOfText = (text = ""): UnavailableReason => {
  if (/deleted/i.test(text)) return "deleted";
  if (/suspended/i.test(text)) return "suspended";
  if (/limits who can view|protected/i.test(text)) return "protected";
  if (/withheld/i.test(text)) return "withheld";
  if (/age-restricted|adult content/i.test(text)) return "age-restricted";
  if (/blocked/i.test(text)) return "blocked";
  return "unknown";
};

const UNAVAILABLE_REASON: Record<string, UnavailableReason> = {
  Protected: "protected",
  Suspended: "suspended",
  NsfwLoggedOut: "age-restricted",
  NsfwViewerHasNoStatedAge: "age-restricted",
  NsfwViewerIsUnderage: "age-restricted",
  Withheld: "withheld",
};

const unavailable = (reason: UnavailableReason, id?: string, message?: string): Unavailable =>
  clean({ kind: "unavailable" as const, id, reason, message, source: "graphql" as const });

/** The account named `id` in a post's mentions or quote link: X sometimes sends an author with no profile (twscrape #342, #343). */
const authorHint = (outer: Json, inner: Json): UserRef | undefined => {
  const id = str(fields(inner).user_id_str);
  if (!id) return undefined;
  const mention = arr(at(fields(outer), "entities", "user_mentions"))
    .map(obj)
    .find((m) => m.id_str === id);
  if (mention) return clean({ id, handle: str(mention.screen_name), name: str(mention.name) });
  const link = str(at(fields(outer), "quoted_status_permalink", "expanded"))?.match(/\/\/(?:twitter|x)\.com\/(\w+)\/status\/(\d+)/);
  return link && link[2] === str(inner.rest_id) ? { id, handle: link[1]! } : { id };
};

export interface PostOptions {
  /** The timeline entry id (`tweet-<id>`), which names the post when X sends only a tombstone. */
  entryId?: string;
  /** Who wrote it, when the post's own author result is a stub. */
  author?: UserRef;
}

const idOfEntry = (entryId?: string) => entryId?.match(/(?:^|-)tweet-(\d+)$/)?.[1];

/**
 * A tweet result (`tweet_results.result`, `tweetResult.result`, `quoted_status_result.result`) as an
 * Entry: a Post, a Repost, or Unavailable for a tombstone, an unavailable post or an empty result.
 */
export const entryFromResult = (result: unknown, opts: PostOptions = {}): Entry => {
  let r = obj(result);
  let limited: string[] | undefined;
  if (r.__typename === "TweetWithVisibilityResults") {
    limited = arr(at(r, "limitedActionResults", "limited_actions"))
      .map((a) => str(at(a, "action")))
      .filter((a): a is string => !!a);
    r = obj(r.tweet);
  }
  const fallbackId = str(r.rest_id) ?? idOfEntry(opts.entryId);
  if (r.__typename === "TweetTombstone" || isObj(r.tombstone)) {
    const text = str(at(r, "tombstone", "text", "text"));
    return unavailable(reasonOfText(text), fallbackId, text);
  }
  if (r.__typename === "TweetUnavailable")
    return unavailable(UNAVAILABLE_REASON[str(r.reason) ?? ""] ?? "unknown", fallbackId, str(r.reason));
  const f = fields(r);
  const id = str(r.rest_id) ?? str(f.id_str);
  if (!id) return unavailable("unknown", fallbackId);

  const author = userRefFromResult(at(r, "core", "user_results", "result")) ?? opts.author ?? clean({ id: str(f.user_id_str) });
  const createdAt = xTime(f.created_at);

  const retweeted = at(f, "retweeted_status_result", "result");
  if (retweeted !== undefined || str(f.retweeted_status_id_str)) {
    const inner = isObj(retweeted)
      ? entryFromResult(retweeted, { author: authorHint(r, obj(isObj(retweeted.tweet) ? retweeted.tweet : retweeted)) })
      : unavailable("unknown", str(f.retweeted_status_id_str));
    const repost: Repost = clean({
      kind: "repost" as const,
      id,
      source: "graphql" as const,
      by: author,
      createdAt,
      post: inner.kind === "repost" ? inner.post : inner,
    });
    return repost;
  }
  return postFrom(r, f, id, author, createdAt, limited);
};

const postFrom = (r: Json, f: Json, id: string, author: UserRef, createdAt: string | undefined, limited?: string[]): Post => {
  const note = obj(at(r, "note_tweet", "note_tweet_results", "result"));
  const noteText = str(note.text);
  const text = noteText ?? str(f.full_text) ?? "";
  const entities = entitiesOf(noteText ? obj(note.entity_set) : obj(f.entities));
  const media = mediaOf(at(f, "extended_entities", "media") ?? at(f, "entities", "media"));
  const card = obj(r.card);
  const cardName = str(at(card, "legacy", "name"));
  const values = bindings(card);
  const poll = cardName ? pollOf(cardName, values) : undefined;

  const replyId = str(f.in_reply_to_status_id_str);
  const replyUser = nonEmpty({ id: str(f.in_reply_to_user_id_str), handle: str(f.in_reply_to_screen_name) });
  const quotedResult = at(r, "quoted_status_result", "result");
  const quotedId = str(f.quoted_status_id_str) ?? str(at(quotedResult, "rest_id")) ?? str(at(quotedResult, "tweet", "rest_id"));
  let quoted: QuotedPost | Unavailable | undefined;
  if (isObj(quotedResult)) {
    const q = entryFromResult(quotedResult, { author: authorHint(r, obj(isObj(quotedResult.tweet) ? quotedResult.tweet : quotedResult)) });
    if (q.kind === "post") {
      const { quoted: _nested, ...own } = q;
      quoted = own;
    } else if (q.kind === "unavailable") quoted = { ...q, id: q.id ?? quotedId };
  }

  const birdwatch = obj(r.birdwatch_pivot);
  const noteText2 = str(at(birdwatch, "subtitle", "text"));
  return clean({
    kind: "post" as const,
    id,
    source: "graphql" as const,
    author,
    createdAt,
    text,
    lang: str(f.lang),
    conversationId: str(f.conversation_id_str),
    replyTo: replyId || replyUser ? clean({ post: replyId, user: replyUser }) : undefined,
    quotedId,
    quoted,
    counts: nonEmpty({
      replies: count(f.reply_count),
      reposts: count(f.retweet_count),
      quotes: count(f.quote_count),
      likes: count(f.favorite_count),
      bookmarks: count(f.bookmark_count),
      views: count(at(r, "views", "count")),
    }),
    entities,
    media,
    card: cardName && !poll ? cardOf(cardName, values) : undefined,
    poll,
    hasNote: bool(r.has_birdwatch_notes),
    note: noteText2 ? clean({ id: str(at(birdwatch, "note", "rest_id")), text: noteText2 }) : undefined,
    edits: editsOf(r),
    sensitive: bool(f.possibly_sensitive),
    withheldIn: Array.isArray(f.withheld_in_countries) ? f.withheld_in_countries.map(String) : undefined,
    limitedActions: limited?.length ? limited : undefined,
    viewer: nonEmpty({ liked: bool(f.favorited), reposted: bool(f.retweeted), bookmarked: bool(f.bookmarked) }),
  });
};

// ---- timelines ----

/** One item of a timeline, in the order X sent it. */
export interface TimelineItem {
  entryId: string;
  /** The conversation module it is in (its entryId), if any. */
  module?: string;
  /** X's tweetDisplayType: Tweet, SelfThread, ... */
  display?: string;
  value: Entry | User | UserUnavailable;
}

export interface Timeline {
  items: TimelineItem[];
  /** Cursors by X's cursorType: Top, Bottom, ShowMoreThreads, ... Opaque strings. */
  cursors: Record<string, string>;
  /** Modules (by entryId) that X folds more replies into ("Show replies"), with their ShowMore cursor. */
  more: Record<string, string>;
  /** Entry ids X pinned to the top (a profile's pinned post). */
  pinned: string[];
}

/** Entries that are X's suggestions and ads, not the timeline asked for. */
const NOISE =
  /^(who-to-follow|promoted|messageprompt|tweetdetailrelatedtweets|YouMightAlsoLike|module-|trends|explore|superhero|toptabsrpusermodule)|promoted-tweet/;

const cursorOf = (c: Json): { type: string; value: string } | undefined => {
  const type = str(c.cursorType);
  const value = str(c.value);
  return type && value ? { type, value } : undefined;
};

const itemValue = (content: Json, entryId: string): TimelineItem["value"] | undefined => {
  if (isObj(content.promotedMetadata)) return undefined;
  switch (content.itemType ?? content.__typename) {
    case "TimelineTweet": {
      const result = at(content, "tweet_results", "result") ?? at(content, "tweetResult", "result");
      return entryFromResult(result, { entryId });
    }
    case "TimelineUser":
      return userFromResult(at(content, "user_results", "result"));
    case "TimelineTombstone": {
      // Older TweetDetail shape for a deleted ancestor (inferred; not in the clients' fixtures).
      const text = str(at(content, "tombstoneInfo", "richText", "text")) ?? str(at(content, "tombstoneInfo", "text"));
      return unavailable(reasonOfText(text), idOfEntry(entryId), text);
    }
    default:
      return undefined;
  }
};

/** Every `instructions` array in a GraphQL response, wherever the operation nests it. */
const instructionsIn = (json: unknown): Json[] => {
  const found: Json[] = [];
  const walk = (x: unknown, depth: number) => {
    if (depth > 8 || !isObj(x)) return;
    if (Array.isArray(x.instructions)) found.push(...x.instructions.map(obj));
    for (const v of Object.values(x)) walk(v, depth + 1);
  };
  walk(obj(json).data, 0);
  return found;
};

/**
 * A timeline response (SearchTimeline, UserTweets, TweetDetail, Bookmarks, Likes, Followers,
 * Following, ListLatestTweetsTimeline, ListMembers, ...) as items and cursors. X's suggestions and
 * ads are left out.
 */
export const readTimeline = (json: unknown): Timeline => {
  const t: Timeline = { items: [], cursors: {}, more: {}, pinned: [] };
  const add = (entryId: string, content: Json, module?: string) => {
    const cursor = cursorOf(content);
    if (cursor) {
      if (module && cursor.type === "ShowMore") t.more[module] = cursor.value;
      else t.cursors[cursor.type] = cursor.value;
      return;
    }
    if (NOISE.test(entryId)) return;
    const value = itemValue(content, entryId);
    if (value) t.items.push(clean({ entryId, module, display: str(content.tweetDisplayType), value }));
  };
  const entry = (e: Json, pinned = false) => {
    const entryId = str(e.entryId) ?? "";
    const content = obj(e.content);
    if (NOISE.test(entryId)) return;
    if (pinned) t.pinned.push(entryId);
    if (isObj(content.itemContent)) add(entryId, content.itemContent);
    else if (Array.isArray(content.items))
      for (const i of content.items.map(obj)) add(str(i.entryId) ?? "", obj(at(i, "item", "itemContent")), entryId);
    else add(entryId, content);
  };
  for (const ins of instructionsIn(json)) {
    for (const e of arr(ins.entries)) entry(obj(e));
    if (isObj(ins.entry)) entry(ins.entry, ins.type === "TimelinePinEntry");
    // TimelineAddToModule: more items for a module already shown (TweetDetail's "Show replies").
    const moduleId = str(ins.moduleEntryId);
    for (const i of arr(ins.moduleItems).map(obj)) add(str(i.entryId) ?? "", obj(at(i, "item", "itemContent")), moduleId);
  }
  return t;
};

const isEntry = (v: TimelineItem["value"]): v is Entry => v.kind === "post" || v.kind === "repost" || v.kind === "unavailable";
const isAccount = (v: TimelineItem["value"]): v is User | UserUnavailable => v.kind === "user" || v.kind === "user-unavailable";

const keyOf = (v: TimelineItem["value"], entryId: string) => `${v.kind}:${"id" in v && v.id ? v.id : entryId}`;

const page = <T extends TimelineItem["value"]>(t: Timeline, keep: (v: TimelineItem["value"]) => v is T): Page<T> => {
  const seen = new Set<string>();
  const items: T[] = [];
  for (const { entryId, value } of t.items) {
    const key = keyOf(value, entryId);
    if (!keep(value) || seen.has(key)) continue;
    seen.add(key);
    items.push(value);
  }
  const cursor = t.cursors.Bottom;
  // X sends a Bottom cursor on the last page too; a page with items and a cursor may have more.
  return clean({ items, more: cursor ? items.length > 0 : false, cursor });
};

/** A timeline of posts as a page: search, a profile, bookmarks, likes, a list. */
export const postsPage = (json: unknown): Page<Entry> => page(readTimeline(json), isEntry);

/** A timeline of accounts as a page: followers, following, list members, reposters. */
export const usersPage = (json: unknown): Page<User | UserUnavailable> => page(readTimeline(json), isAccount);

/**
 * TweetDetail as a Thread around `focalId`: the entries before the focal post are its ancestors, each
 * conversation module after it is a group of replies, the first of them the author's self-thread
 * when X marks it SelfThread.
 */
export const threadOf = (json: unknown, focalId: string): Thread => {
  const t = readTimeline(json);
  const asPost = (v: Entry): Post | Unavailable => (v.kind === "repost" ? v.post : v);
  let focal: Post | Unavailable | undefined;
  const ancestors: (Post | Unavailable)[] = [];
  const groups = new Map<string, ReplyGroup>();
  for (const { entryId, module, display, value } of t.items) {
    if (!isEntry(value)) continue;
    const post = asPost(value);
    if (!focal) {
      if (idOfEntry(entryId) === focalId || post.id === focalId) focal = post;
      else ancestors.push(post);
      continue;
    }
    const key = module ?? entryId;
    const group = groups.get(key) ?? { posts: [] };
    group.posts.push(post);
    if (display === "SelfThread") group.selfThread = true;
    if (module && t.more[module]) group.more = true;
    groups.set(key, group);
  }
  const f = focal ?? unavailable("unknown", focalId);
  return clean({
    conversationId: f.kind === "post" ? f.conversationId : undefined,
    focal: f,
    ancestors: focal ? ancestors : [],
    replies: [...groups.values()],
    more: !!(t.cursors.Bottom || t.cursors.ShowMoreThreads),
  });
};
