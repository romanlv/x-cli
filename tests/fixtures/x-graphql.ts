// Small GraphQL responses in the shapes X's web app sends, for tests/x-model.test.ts. Ids, names and
// text are made up; the structure is copied from the open-source clients' public test data and parsers,
// cited on each fixture (twscrape tests/mocked-data at 568844d, 2026-10-05, captured from x.com in
// 2026; twikit; the-convocation/twitter-scraper; yt-dlp). Unconfirmed against this account until the
// first op is built.

/** A user in the 2026 shape: no `legacy`, fields in core/avatar/privacy/... (twscrape raw_user_by_login.json). */
const userResult = (id: string, handle: string, extra: Record<string, unknown> = {}) => ({
  __typename: "User",
  id: btoa(`User:${id}`),
  rest_id: id,
  avatar: { image_url: `https://pbs.twimg.com/profile_images/${id}/a_normal.jpg` },
  core: { created_at: "Sat Dec 14 04:35:55 +0000 2013", name: `Name ${handle}`, screen_name: handle },
  is_blue_verified: false,
  privacy: { protected: false },
  relationship_counts: { followers: 120, following: 30 },
  relationship_perspectives: { blocked_by: false, blocking: false, followed_by: false, following: true, muting: false },
  tweet_counts: { media_tweets: 4, tweets: 400 },
  verification: { verified: false },
  ...extra,
});

/** A Tweet with its fields in `legacy` (twscrape raw_search.json, July 2026). */
const tweet = (id: string, user: object, legacy: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  __typename: "Tweet",
  rest_id: id,
  core: { user_results: { result: user } },
  edit_control: { edit_tweet_ids: [id], editable_until_msecs: "1783551550000", edits_remaining: "5", is_edit_eligible: true },
  is_translatable: false,
  legacy: {
    bookmark_count: 0,
    bookmarked: false,
    conversation_id_str: id,
    created_at: "Wed Jul 08 21:59:10 +0000 2026",
    entities: { hashtags: [], symbols: [], urls: [], user_mentions: [] },
    favorite_count: 0,
    favorited: false,
    full_text: "",
    id_str: id,
    is_quote_status: false,
    lang: "en",
    quote_count: 0,
    reply_count: 0,
    retweet_count: 0,
    retweeted: false,
    user_id_str: (user as { rest_id?: string }).rest_id,
    ...legacy,
  },
  views: { count: "100", state: "EnabledWithCount" },
  ...extra,
});

const item = (entryId: string, result: object, tweetDisplayType = "Tweet") => ({
  entryId,
  sortIndex: "1",
  content: {
    entryType: "TimelineTimelineItem",
    __typename: "TimelineTimelineItem",
    itemContent: { itemType: "TimelineTweet", __typename: "TimelineTweet", tweet_results: { result }, tweetDisplayType },
  },
});

const cursor = (entryId: string, cursorType: string, value: string) => ({
  entryId,
  sortIndex: "0",
  content: { entryType: "TimelineTimelineCursor", __typename: "TimelineTimelineCursor", value, cursorType },
});

export const ada = userResult("11", "ada");
const bob = userResult("22", "bob");

/** SearchTimeline (twscrape raw_search.json): tweet-<id> items, then Top and Bottom cursors. */
export const searchTimeline = {
  data: {
    search_by_raw_query: {
      search_timeline: {
        timeline: {
          instructions: [
            {
              type: "TimelineAddEntries",
              entries: [
                item(
                  "tweet-1001",
                  tweet(
                    "1001",
                    ada,
                    {
                      full_text: "Hello @bob #cats $ACME https://t.co/abc https://t.co/pic",
                      favorite_count: 312,
                      reply_count: 11,
                      retweet_count: 21,
                      quote_count: 9,
                      bookmark_count: 7,
                      entities: {
                        hashtags: [{ indices: [11, 16], text: "cats" }],
                        symbols: [{ indices: [17, 22], text: "ACME" }],
                        user_mentions: [{ id_str: "22", indices: [6, 10], name: "Name bob", screen_name: "bob" }],
                        urls: [
                          { display_url: "example.com", expanded_url: "https://example.com/", indices: [23, 39], url: "https://t.co/abc" },
                        ],
                      },
                      // extended_entities.media as in raw_user_media.json / manual_tweet_with_video_1.json
                      extended_entities: {
                        media: [
                          {
                            type: "photo",
                            media_key: "3_5001",
                            media_url_https: "https://pbs.twimg.com/media/p.jpg",
                            ext_alt_text: "a cat on a mat",
                            original_info: { width: 800, height: 600 },
                            url: "https://t.co/pic",
                          },
                          {
                            type: "video",
                            media_key: "13_5002",
                            media_url_https: "https://pbs.twimg.com/amplify_video_thumb/5002/img/v.jpg",
                            original_info: { width: 720, height: 720 },
                            video_info: {
                              duration_millis: 10850,
                              variants: [
                                { content_type: "application/x-mpegURL", url: "https://video.twimg.com/v.m3u8" },
                                { bitrate: 256000, content_type: "video/mp4", url: "https://video.twimg.com/v-low.mp4" },
                                { bitrate: 832000, content_type: "video/mp4", url: "https://video.twimg.com/v.mp4" },
                                { bitrate: 432000, content_type: "video/mp4", url: "https://video.twimg.com/v-mid.mp4" },
                              ],
                            },
                            url: "https://t.co/pic",
                          },
                        ],
                      },
                    },
                    {
                      // note_tweet for a long post (raw_search.json; twikit full_text)
                      note_tweet: {
                        is_expandable: true,
                        note_tweet_results: {
                          result: {
                            text: "Hello @bob #cats $ACME https://t.co/abc and the rest of a long post",
                            entity_set: {
                              hashtags: [{ indices: [11, 16], text: "cats" }],
                              symbols: [{ indices: [17, 22], text: "ACME" }],
                              urls: [
                                {
                                  display_url: "example.com",
                                  expanded_url: "https://example.com/",
                                  indices: [23, 39],
                                  url: "https://t.co/abc",
                                },
                              ],
                              user_mentions: [{ id_str: "22", indices: [6, 10], name: "Name bob", screen_name: "bob" }],
                            },
                          },
                        },
                      },
                      views: { count: "25900", state: "EnabledWithCount" },
                      // edit_control with edit_control_initial, as the-convocation reads it for an edited post
                      edit_control: {
                        edit_control_initial: {
                          edit_tweet_ids: ["1000", "1001"],
                          editable_until_msecs: "1783551550000",
                          edits_remaining: "4",
                        },
                      },
                      has_birdwatch_notes: true,
                      // birdwatch_pivot as twikit tweet.py reads it (no fixture in the clients)
                      birdwatch_pivot: { note: { rest_id: "9001" }, subtitle: { text: "Readers added context" } },
                    },
                  ),
                ),
                // The 2026-05 shape twscrape's utils.py describes: legacy null, its fields at the top level.
                item("tweet-1002", {
                  __typename: "Tweet",
                  rest_id: "1002",
                  legacy: null,
                  core: { user_results: { result: bob } },
                  created_at: "Thu Jul 09 08:00:00 +0000 2026",
                  conversation_id_str: "1001",
                  full_text: "@ada agreed",
                  in_reply_to_status_id_str: "1001",
                  in_reply_to_user_id_str: "11",
                  in_reply_to_screen_name: "ada",
                  entities: { user_mentions: [{ id_str: "11", indices: [0, 4], name: "Name ada", screen_name: "ada" }] },
                  favorite_count: 0,
                  reply_count: 0,
                  retweet_count: 0,
                  quote_count: 0,
                  favorited: true,
                  lang: "en",
                  user_id_str: "22",
                }),
                {
                  entryId: "promoted-tweet-1003-abc",
                  sortIndex: "1",
                  content: {
                    __typename: "TimelineTimelineItem",
                    itemContent: {
                      itemType: "TimelineTweet",
                      tweet_results: { result: tweet("1003", bob, { full_text: "an ad" }) },
                      promotedMetadata: {},
                    },
                  },
                },
                cursor("cursor-top-1", "Top", "DAADDAAB-top"),
                cursor("cursor-bottom-0", "Bottom", "DAADDAAB-bottom"),
              ],
            },
          ],
        },
      },
    },
  },
};

/** UserTweets (twscrape raw_user_tweets.json, _issue_342_343.json, raw_list_timeline.json, card_poll.json). */
export const userTweets = {
  data: {
    user: {
      result: {
        __typename: "User",
        timeline: {
          timeline: {
            instructions: [
              { type: "TimelineClearCache" },
              { type: "TimelinePinEntry", entry: item("tweet-2001", tweet("2001", ada, { full_text: "pinned" })) },
              {
                type: "TimelineAddEntries",
                entries: [
                  // A repost whose original author came as UserUnavailable (_issue_342_343.json): the
                  // reposter's user_mentions still name them.
                  item(
                    "tweet-2002",
                    tweet("2002", ada, {
                      full_text: "RT @carol: original text…",
                      retweet_count: 31,
                      entities: { user_mentions: [{ id_str: "33", indices: [3, 9], name: "Carol", screen_name: "carol" }] },
                      retweeted_status_result: {
                        result: tweet(
                          "1900",
                          { __typename: "UserUnavailable", message: "User is not available", reason: "NoReason" },
                          { full_text: "original text in full", user_id_str: "33", retweet_count: 31 },
                        ),
                      },
                    }),
                  ),
                  // A quote of a post wrapped in TweetWithVisibilityResults (raw_list_timeline.json).
                  item(
                    "tweet-2003",
                    tweet(
                      "2003",
                      ada,
                      {
                        full_text: "look at this",
                        is_quote_status: true,
                        quoted_status_id_str: "1800",
                        quoted_status_permalink: { expanded: "https://twitter.com/bob/status/1800", url: "https://t.co/q" },
                      },
                      {
                        quoted_status_result: {
                          result: {
                            __typename: "TweetWithVisibilityResults",
                            limitedActionResults: {
                              limited_actions: [
                                { action: "Reply", prompt: { __typename: "CtaLimitedActionPrompt", cta_type: "SeeConversation" } },
                              ],
                            },
                            tweet: tweet("1800", bob, { full_text: "quoted text", quoted_status_id_str: "1700" }),
                          },
                        },
                      },
                    ),
                  ),
                  // A quote of a deleted post: TweetTombstone (twikit tweet.py, yt-dlp twitter.py).
                  item(
                    "tweet-2004",
                    tweet(
                      "2004",
                      ada,
                      { full_text: "this was wrong", is_quote_status: true, quoted_status_id_str: "1600" },
                      {
                        quoted_status_result: {
                          result: {
                            __typename: "TweetTombstone",
                            tombstone: { text: { text: "This Post was deleted by the Post author. Learn more" } },
                          },
                        },
                      },
                    ),
                  ),
                  // A poll card (card_poll.json binding_values).
                  item(
                    "tweet-2005",
                    tweet(
                      "2005",
                      ada,
                      { full_text: "Yes or no?" },
                      {
                        card: {
                          rest_id: "card://2005",
                          legacy: {
                            name: "poll2choice_text_only",
                            url: "card://2005",
                            binding_values: [
                              { key: "choice1_label", value: { string_value: "Yes", type: "STRING" } },
                              { key: "choice2_label", value: { string_value: "No", type: "STRING" } },
                              { key: "end_datetime_utc", value: { string_value: "2024-04-18T18:37:10Z", type: "STRING" } },
                              { key: "counts_are_final", value: { boolean_value: false, type: "BOOLEAN" } },
                              { key: "choice2_count", value: { string_value: "364", type: "STRING" } },
                              { key: "choice1_count", value: { string_value: "844", type: "STRING" } },
                              { key: "duration_minutes", value: { string_value: "1440", type: "STRING" } },
                            ],
                          },
                        },
                      },
                    ),
                  ),
                  // A repost whose original author came as a stub, its ids and nothing else
                  // (_issue_342_343.json, the third entry): the reposter's user_mentions name them.
                  item(
                    "tweet-2006",
                    tweet("2006", ada, {
                      full_text: "RT @XFreeze: https://t.co/x",
                      entities: { user_mentions: [{ id_str: "77", indices: [3, 11], name: "X Freeze", screen_name: "XFreeze" }] },
                      retweeted_status_result: {
                        result: tweet(
                          "1950",
                          { __typename: "User", id: btoa("User:77"), rest_id: "77", action_counts: { favorites_count: 41998 } },
                          { full_text: "https://t.co/x", user_id_str: "77" },
                        ),
                      },
                    }),
                  ),
                  {
                    entryId: "who-to-follow-1",
                    content: {
                      __typename: "TimelineTimelineModule",
                      items: [
                        {
                          entryId: "who-to-follow-1-user-22",
                          item: { itemContent: { itemType: "TimelineUser", user_results: { result: bob } } },
                        },
                      ],
                    },
                  },
                  cursor("cursor-bottom-2", "Bottom", "DAAHCgAB-bottom"),
                ],
              },
            ],
          },
        },
      },
    },
  },
};

const module = (entryId: string, items: object[]) => ({
  entryId,
  sortIndex: "1",
  content: { entryType: "TimelineTimelineModule", __typename: "TimelineTimelineModule", displayType: "VerticalConversation", items },
});
const moduleItem = (entryId: string, result: object, tweetDisplayType = "Tweet") => ({
  entryId,
  item: { itemContent: { itemType: "TimelineTweet", __typename: "TimelineTweet", tweet_results: { result }, tweetDisplayType } },
});

/**
 * TweetDetail for 3001 (twscrape raw_tweet_details.json, card_poll.json, article.json): the ancestor
 * before the focal tweet-<id>, then conversationthread-<id> modules; a module's ShowMore cursor is one
 * of its items, ShowMoreThreads an entry of its own.
 */
export const tweetDetail = {
  data: {
    threaded_conversation_with_injections_v2: {
      instructions: [
        { type: "TimelineClearCache" },
        {
          type: "TimelineAddEntries",
          entries: [
            item("tweet-3000", {
              __typename: "TweetTombstone",
              tombstone: { text: { text: "This Post is from a suspended account. Learn more" } },
            }),
            item(
              "tweet-3001",
              tweet("3001", ada, { full_text: "@x the focal post", conversation_id_str: "2999", in_reply_to_status_id_str: "3000" }),
              "Tweet",
            ),
            module("conversationthread-3002", [
              moduleItem(
                "conversationthread-3002-tweet-3002",
                tweet("3002", ada, {
                  full_text: "2/ more",
                  conversation_id_str: "2999",
                  in_reply_to_status_id_str: "3001",
                  in_reply_to_user_id_str: "11",
                }),
                "SelfThread",
              ),
              moduleItem(
                "conversationthread-3002-tweet-3003",
                tweet("3003", ada, { full_text: "3/ end", conversation_id_str: "2999", in_reply_to_status_id_str: "3002" }),
                "SelfThread",
              ),
            ]),
            module("conversationthread-3004", [
              moduleItem(
                "conversationthread-3004-tweet-3004",
                tweet("3004", bob, { full_text: "@ada nice", conversation_id_str: "2999", in_reply_to_status_id_str: "3001" }),
              ),
              {
                entryId: "conversationthread-3004-cursor-showmore-1",
                item: {
                  itemContent: {
                    itemType: "TimelineTimelineCursor",
                    __typename: "TimelineTimelineCursor",
                    value: "PAAA-showmore",
                    cursorType: "ShowMore",
                  },
                },
              },
            ]),
            module("conversationthread-3005-promoted-tweet-3005-abc", [
              moduleItem("conversationthread-3005-promoted-tweet-3005-abc", tweet("3005", bob, { full_text: "ad" })),
            ]),
            {
              entryId: "cursor-showmorethreads-1",
              sortIndex: "0",
              content: {
                entryType: "TimelineTimelineItem",
                __typename: "TimelineTimelineItem",
                itemContent: {
                  itemType: "TimelineTimelineCursor",
                  __typename: "TimelineTimelineCursor",
                  value: "JQAA-threads",
                  cursorType: "ShowMoreThreads",
                },
              },
            },
          ],
        },
        { type: "TimelineTerminateTimeline", direction: "Top" },
      ],
    },
  },
};

/**
 * The post 2111179364872466706 on @NASA (2026-10-18): `counts` replies counted, none in the page, a "Show probable spam"
 * fold (3001 with its ancestor and the ShowMoreThreads cursor of `tweetDetail`).
 */
export const foldedDetail = (counts: number) => {
  const t = JSON.parse(JSON.stringify(tweetDetail));
  const ins = t.data.threaded_conversation_with_injections_v2.instructions;
  const entries = ins[1].entries.filter((e: { entryId: string }) => e.entryId.startsWith("tweet-3001") || e.entryId.startsWith("cursor-"));
  entries[0].content.itemContent.tweet_results.result.legacy.reply_count = counts;
  entries[1].content.itemContent.displayTreatment = { actionText: "Show probable spam" };
  ins[1].entries = entries;
  return t;
};
/** What the fold's button fetches: a "Probable spam" heading, the reply, and the end of the replies. */
export const spamDetail = () => ({
  data: {
    threaded_conversation_with_injections_v2: {
      instructions: [
        {
          type: "TimelineAddEntries",
          entries: [
            {
              entryId: "label-0",
              content: {
                entryType: "TimelineTimelineItem",
                itemContent: { itemType: "TimelineLabel", __typename: "TimelineLabel", text: "Probable spam" },
              },
            },
            module("conversationthread-3100", [
              moduleItem(
                "conversationthread-3100-tweet-3100",
                tweet("3100", bob, { conversation_id_str: "2999", in_reply_to_status_id_str: "3001" }),
              ),
            ]),
          ],
        },
        { type: "TimelineTerminateTimeline", direction: "Bottom" },
      ],
    },
  },
});

const selfReply = (id: string, conversation: string, parent?: string) =>
  tweet(id, ada, { full_text: `post ${id}`, conversation_id_str: conversation, in_reply_to_status_id_str: parent });

/**
 * UserTweets with conversation modules (twscrape raw_user_tweets.json and
 * raw_user_tweets_and_replies.json have profile-conversation-<n> modules of two and three items,
 * item ids profile-conversation-<n>-tweet-<id>): each module is laid out oldest first and placed by
 * its newest post. Newest first by module: 3012, 3010, 3008, 3004.
 */
export const profileConversations = {
  data: {
    user: {
      result: {
        __typename: "User",
        timeline: {
          timeline: {
            instructions: [
              {
                type: "TimelineAddEntries",
                entries: [
                  module("profile-conversation-9001", [
                    moduleItem("profile-conversation-9001-tweet-3005", selfReply("3005", "3005"), "SelfThread"),
                    moduleItem("profile-conversation-9001-tweet-3012", selfReply("3012", "3005", "3005"), "SelfThread"),
                  ]),
                  item("tweet-3010", selfReply("3010", "3010")),
                  module("profile-conversation-9002", [
                    moduleItem("profile-conversation-9002-tweet-2990", selfReply("2990", "2990")),
                    moduleItem("profile-conversation-9002-tweet-3006", selfReply("3006", "2990", "2990")),
                    moduleItem("profile-conversation-9002-tweet-3008", selfReply("3008", "2990", "3006")),
                  ]),
                  item("tweet-3004", selfReply("3004", "3004")),
                  item("tweet-3003", selfReply("3003", "3003")),
                  cursor("cursor-bottom-4", "Bottom", "DAAHCgAB-bottom-4"),
                ],
              },
            ],
          },
        },
      },
    },
  },
};

/** UserByScreenName (twscrape raw_user_by_login.json). */
export const userByScreenName = {
  data: {
    user: {
      result: userResult("44", "dev", {
        action_counts: { favorites_count: 2642 },
        banner: { image_url: "https://pbs.twimg.com/profile_banners/44/1" },
        follow_request_sent: false,
        location: { location: "127.0.0.1" },
        pinned_items: { tweet_ids_str: ["4001"] },
        profile_bio: {
          description: "Building things.",
          entities: {
            url: {
              urls: [
                { display_url: "docs.example.com", expanded_url: "https://docs.example.com/", indices: [0, 23], url: "https://t.co/x" },
              ],
            },
          },
        },
        verification: { verified: false, verified_type: "Business" },
        is_blue_verified: true,
        website: { url: "https://t.co/x" },
      }),
    },
  },
};

/** A user in the older shape, everything in `legacy` (the-convocation profile.ts LegacyUserRaw). */
export const legacyUser = {
  __typename: "User",
  rest_id: "55",
  is_blue_verified: false,
  legacy: {
    screen_name: "old",
    name: "Old Shape",
    description: "",
    created_at: "Mon Feb 09 22:11:12 +0000 2009",
    followers_count: 5,
    friends_count: 6,
    statuses_count: 7,
    favourites_count: 8,
    listed_count: 1,
    media_count: 0,
    location: "",
    profile_image_url_https: "https://pbs.twimg.com/profile_images/55/o_normal.jpg",
    protected: true,
    following: false,
    followed_by: true,
    follow_request_sent: true,
  },
};

/** Followers (twscrape raw_followers.json, raw_retweeters.json for UserUnavailable): user-<id> items, cursors "n|n". */
export const followers = {
  data: {
    user: {
      result: {
        __typename: "User",
        timeline: {
          timeline: {
            instructions: [
              { type: "TimelineClearCache" },
              { type: "TimelineTerminateTimeline", direction: "Top" },
              {
                type: "TimelineAddEntries",
                entries: [
                  {
                    entryId: "user-11",
                    sortIndex: "2",
                    content: {
                      entryType: "TimelineTimelineItem",
                      itemContent: { itemType: "TimelineUser", user_results: { result: ada }, userDisplayType: "User" },
                    },
                  },
                  {
                    entryId: "user-66",
                    sortIndex: "1",
                    content: {
                      entryType: "TimelineTimelineItem",
                      itemContent: {
                        itemType: "TimelineUser",
                        user_results: { result: { __typename: "UserUnavailable", message: "User is not available", reason: "NoReason" } },
                      },
                    },
                  },
                  cursor("cursor-bottom-1", "Bottom", "1840000000000000000|1840000000000000001"),
                  cursor("cursor-top-1", "Top", "-1|1840000000000000002"),
                ],
              },
              { type: "TimelineTerminateTimeline", direction: "Bottom" },
            ],
          },
        },
      },
    },
  },
};

/** TweetResultByRestId for a protected post (yt-dlp twitter.py _graphql_to_legacy). */
export const unavailableTweet = { data: { tweetResult: { result: { __typename: "TweetUnavailable", reason: "Protected" } } } };

/** A list result, fields as twikit list.py reads them (no fixture in the clients). */
export const listResult = {
  id_str: "7001",
  name: "Reading",
  description: "people worth reading",
  mode: "Private",
  member_count: 12,
  subscriber_count: 3,
  created_at: 1700000000000,
  user_results: { result: ada },
};

const searchPage = (entries: object[]) => ({
  data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{ type: "TimelineAddEntries", entries }] } } } },
});

/** A page of a timeline that holds only an ad and its cursors: X has more past it. */
export const adsOnly = searchPage([
  {
    entryId: "promoted-tweet-1004-abc",
    sortIndex: "1",
    content: {
      __typename: "TimelineTimelineItem",
      itemContent: {
        itemType: "TimelineTweet",
        tweet_results: { result: tweet("1004", bob, { full_text: "an ad" }) },
        promotedMetadata: {},
      },
    },
  },
  cursor("cursor-top-2", "Top", "DAADDAAC-top"),
  cursor("cursor-bottom-2", "Bottom", "DAADDAAC-bottom"),
]);

/** The last page of a timeline: X sends its cursors and no entries (twscrape api.py). */
export const lastPage = searchPage([cursor("cursor-top-3", "Top", "DAADDAAD-top"), cursor("cursor-bottom-3", "Bottom", "DAADDAAD-bottom")]);
