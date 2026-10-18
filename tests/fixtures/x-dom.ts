// A timeline's HTML in the shape x.com draws it, for tests/x-helpers.test.ts. MODELLED, UNCONFIRMED:
// written from knowledge/x.md's test ids (tweet, tweetText, User-Name, time, the buttons' aria-labels,
// cellInnerDiv, socialContext), not copied from a real page. Ids, names and text are made up.

interface Cell {
  id: string;
  handle: string;
  name: string;
  text?: string;
  /** aria-label by button testid; null draws the button with none. */
  labels?: Record<string, string | null>;
  /** The action bar's own aria-label (XClipper, huashu-chrome: "3 replies, 5 reposts, 152 likes, 175 bookmarks, 45025 views"). */
  group?: string;
  views?: string;
  /** The reposter's handle: "<handle> reposted" above the post. */
  context?: string;
  /** "Pinned" above the post, as on a profile. */
  pinned?: boolean;
  /** An ad: the article inside placementTracking (typefully/minimal-twitter). */
  ad?: boolean;
  showMore?: boolean;
  quote?: string;
}

const names = (handle: string, name: string, permalink?: string, time = "2026-07-08T21:59:10.000Z") => `
  <div data-testid="User-Name">
    <a href="/${handle}" role="link"><span>${name}</span></a>
    <a href="/${handle}" role="link" tabindex="-1"><span>@${handle}</span></a>
    <span>·</span>
    ${permalink ? `<a href="${permalink}" role="link"><time datetime="${time}">Jul 8</time></a>` : `<time datetime="${time}">Jul 8</time>`}
  </div>`;

const DEFAULT_LABELS = { reply: "3 Replies. Reply", retweet: "1,204 reposts. Repost", like: "12K Likes. Like", bookmark: "Bookmark" };

export const cell = (c: Cell) => `
<div data-testid="cellInnerDiv">${c.ad ? `<div data-testid="placementTracking">` : ""}
  <article data-testid="tweet" role="article" tabindex="0">
    ${c.context ? `<a href="/${c.context}" role="link"><span data-testid="socialContext">${c.context} reposted</span></a>` : ""}
    ${c.pinned ? `<div><span data-testid="socialContext">Pinned</span></div>` : ""}
    ${names(c.handle, c.name, `/${c.handle}/status/${c.id}`)}
    ${c.text === undefined ? "" : `<div data-testid="tweetText" lang="en" dir="auto"><span>${c.text}</span></div>`}
    ${c.showMore ? `<button data-testid="tweet-text-show-more-link" type="button">Show more</button>` : ""}
    ${c.quote ?? ""}
    <div role="group"${c.group ? ` aria-label="${c.group}"` : ""}>
      ${Object.entries(c.labels ?? DEFAULT_LABELS)
        .map(([id, label]) => `<button data-testid="${id}"${label === null ? "" : ` aria-label="${label}"`} type="button"></button>`)
        .join("")}
      ${c.views ? `<a href="/${c.handle}/status/${c.id}/analytics" aria-label="${c.views}"></a>` : ""}
    </div>
  </article>${c.ad ? "</div>" : ""}
</div>`;

/** X's embedded quote: a box that is a link as a whole, with its own User-Name and text; `id` when it carries a permalink. */
export const quoteBox = (handle: string, text: string, id?: string) => `
  <div role="link" tabindex="0">
    ${names(handle, `Name ${handle}`, undefined, "2026-07-01T10:00:00.000Z")}
    <div data-testid="tweetText" lang="fr"><span>${text}</span></div>
    ${id ? `<a href="/${handle}/status/${id}" aria-hidden="true"></a>` : ""}
  </div>`;

export const tombstone = (text: string) => `
<div data-testid="cellInnerDiv"><div><span>${text}</span> <a href="https://help.x.com/rules-and-policies/notices-on-x">Learn more</a></div></div>`;

/** A timeline: a post, a repost, a post with a quote, a deleted post, and two more posts. */
export const timelineHtml = `<main data-testid="primaryColumn"><section>${[
  cell({ id: "1001", handle: "ada", name: "Ada", text: "Hello world", views: "25900 views. View post analytics" }),
  cell({
    id: "1900",
    handle: "carol",
    name: "Carol",
    text: "original text",
    context: "ada",
    labels: { reply: "Reply", unretweet: "5 reposts. Reposted", unlike: "1 Like. Liked", removeBookmark: "2 Bookmarks. Bookmarked" },
  }),
  cell({ id: "1003", handle: "ada", name: "Ada", text: "look at this", showMore: true, quote: quoteBox("bob", "quoted text", "1800") }),
  tombstone("This Post was deleted by the Post author."),
  cell({ id: "1005", handle: "dan", name: "Dan", quote: quoteBox("bob", "a quote with no link") }),
  cell({ id: "1006", handle: "eve", name: "Eve", text: "last" }),
].join("")}</section></main>`;

/**
 * A profile, newest first: an old post pinned above it, a post, an ad, a post whose action bar names
 * its counts, and one whose buttons have no labels. 1008, between them, was deleted.
 */
export const profileHtml = `<main data-testid="primaryColumn"><section>${[
  cell({ id: "900", handle: "ada", name: "Ada", text: "pinned long ago", pinned: true }),
  cell({ id: "1010", handle: "ada", name: "Ada", text: "newest" }),
  cell({ id: "5000", handle: "brand", name: "Brand", text: "buy now", ad: true }),
  cell({
    id: "1009",
    handle: "ada",
    name: "Ada",
    text: "counted",
    group: "3 replies, 5 reposts, 152 likes, 175 bookmarks, 45025 views",
    labels: { reply: "3 Replies. Reply", retweet: "5 reposts. Repost", like: "152 Likes. Like", bookmark: "Bookmark" },
  }),
  cell({ id: "1007", handle: "ada", name: "Ada", text: "no labels", labels: { reply: null, retweet: null, like: null, bookmark: null } }),
].join("")}</section></main>`;

/**
 * A profile with a self-thread, drawn as X lays out a conversation, oldest first: 1/ (1005) above
 * 2/ (1012), then 1010, the until post 1008, and 1007. The DOM doesn't say where the thread ends.
 */
export const selfThreadHtml = `<main data-testid="primaryColumn"><section>${[
  cell({ id: "1005", handle: "ada", name: "Ada", text: "1/ a thread" }),
  cell({ id: "1012", handle: "ada", name: "Ada", text: "2/ more of it" }),
  cell({ id: "1010", handle: "ada", name: "Ada", text: "another" }),
  cell({ id: "1008", handle: "ada", name: "Ada", text: "read last time" }),
  cell({ id: "1007", handle: "ada", name: "Ada", text: "older" }),
].join("")}</section></main>`;
