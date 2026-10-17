# X (x.com) bot detection, rate limits and ToS risk: notes for x-cli

Researched 2026-10-17. X changes things often. Every dated item below should be re-checked if it is more than a few months old.
Tags: **[confirmed]** means a primary or high-trust source says so (link given). **[inferred]** means our own reasoning from those sources.

---

## Recommendations for x-cli (ranked)

1. **Let X's own web app make the requests, and capture the responses (default read path).** Drive the real page (navigate to `/search?q=…`, `/<user>`, `/i/bookmarks`, `/<user>/status/<id>`) and read the GraphQL JSON with `page.on('response')` / `page.waitForResponse(/\/i\/api\/graphql\/[^/]+\/SearchTimeline/)`. You get valid `x-client-transaction-id`, current queryIds and `features`, real TLS/HTTP2 and the real cookie jar for free. Nothing has to be reverse-engineered. Scroll to paginate. **[inferred]** This is the lowest-risk and lowest-maintenance option. Every library that calls the API directly needed a fix for xclid or queryIds at least five times between May and Aug 2026 (see §1.3, §1.5).
2. **Use the person's sign-in, made by hand in a headed window. Never automate the login.** X's login is the most heavily defended surface: Castle.io device tokens, error 399 "Could not log you in now", 366, Arkose on locked accounts. The-convocation and twikit both recommend reusing cookies over scripted login **[confirmed]**. After sign-in, keep a **dedicated persistent profile** (`launchPersistentContext(userDataDir)` in an x-cli-owned dir, not the person's real Chrome "User Data" dir; Playwright says automating the default Chrome profile "is not supported") **[confirmed]**. Do not re-login on each run. If the session is invalid (401/`(32) Could not authenticate you`/redirect to `/i/flow/login` or `/i/jf/onboarding`), stop and ask the person to sign in again.
3. **Run real Chrome (`channel: 'chrome'`), headed by default.** Allow `--headless` only with `channel: 'chrome'` or `'chromium'` (new headless, the "real Chrome browser"), never the default `chromium-headless-shell` **[confirmed Playwright docs]**. Don't override the user agent. Let branded Chrome send its own UA and client hints. If a UA is ever set, it must match the real Chrome major version, or the UA, client hints and TLS stop agreeing **[inferred from convocation `chrome-fingerprint.ts`]**.
4. **One session, one browser, one tab doing X work at a time per account.** Don't run parallel contexts on the same `auth_token`. Serialize agent exploration through a single lock (file lock on the profile dir; Chromium already refuses two instances on one `userDataDir`) **[confirmed Playwright]**. Spreading load across multiple accounts is what twscrape does, and it is the behaviour X's ToS targets (multiple-account rule) **[confirmed twscrape README warning]**.
5. **Use a budget and backoff that a human could match.** Read `x-rate-limit-limit/-remaining/-reset` from every captured GraphQL response. Stop when `remaining` is at or below about 10% of the limit, sleep until `reset` (epoch seconds) plus jitter, and never retry a 429 in a tight loop. Pace page actions at roughly 2–8 s with random jitter. Cap pages per command (for example 10 scrolls) and set a daily soft cap well under the old 1,000–10,000 "posts viewed per day" levels. Treat `(88) Rate limit exceeded` while `remaining > 0`, or `(326) … access control`, as a **lock or ban signal**: halt everything and tell the user, don't rotate or retry **[confirmed twscrape/twikit handling]**.
6. **Fast path (optional): send direct GraphQL calls from inside the page, never from a separate HTTP client.** If clicking is too slow, call `fetch()` via `page.evaluate`. The request then goes out on Chrome's TLS stack, with Chrome cookies and Cloudflare clearance. You still have to add `authorization: Bearer <web bearer>`, `x-csrf-token: <ct0>`, `x-twitter-auth-type: OAuth2Session`, `x-twitter-active-user: yes` and **`x-client-transaction-id`**. Missing or invalid xclid gives 404 (see §1.3). Take queryId, features and fieldToggles from requests the app has already made in this session (capture them in a `page.on('request')` cache), not from a hard-coded table. If you must generate xclid yourself, port twscrape's `xclid.py` (MIT), but expect it to break on bundle changes. **[inferred]** A Node/Python HTTP client outside the browser is the riskiest option. twscrape's default `httpx` backend gets Cloudflare 403s that `curl-cffi` Chrome impersonation avoids (#337, Sep 2026) **[confirmed]**.
7. **Skip stealth plugins.** With real headed Chrome, a hand-made session and human pacing, `playwright-stealth`/`puppeteer-extra-stealth` add little. puppeteer-extra-stealth has had no substantive push since about Jul 2024, and the Python playwright-stealth port is maintained only sporadically **[secondary sources, medium trust]**. If detection ever shows up, look first at the `navigator.webdriver`/CDP `Runtime.enable` leak (patchright/rebrowser-patches), and only after checking that pacing isn't the cause **[inferred]**.
8. **Stay read-only. If writes are ever added, keep them human-paced and confirmed.** X's posting and automation defences (error 226 "This request looks like it might be automated", 50 posts/200 replies per day for unverified accounts since May 2026) target writes much harder than reads **[confirmed via press]**.
9. **Detect challenges and hand back to the person.** If the page lands on `/account/access`, an Arkose/"unusual activity" interstitial, a Cloudflare challenge, or a login/onboarding URL, pause automation, bring the headed window forward, and wait for the person to clear it. Never solve captchas automatically. twikit's Capsolver integration exists, but automated captcha solving clearly violates X's rules **[inferred]**.
10. **Tell the person about the ToS position and the official-API alternative** (see §3): scripting x.com is prohibited by the ToS and the automation rules. The realistic enforcement risk for a low-volume, single-user, read-only tool is an account lock or suspension, not liquidated damages, which start at more than 1M posts in 24h **[inferred]**.

---

## 1. What X does today

### 1.1 Request anatomy of the web app (logged in) [confirmed: twscrape `account.py`, `login.py`, `queue_client.py`, Oct 2026 HEAD]
- Endpoint: `https://x.com/i/api/graphql/<queryId>/<OperationName>?variables=…&features=…&fieldToggles=…` (GET for reads).
- `authorization: Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA`. This is the public web-app bearer, the same for all users and hard-coded in twscrape. It identifies the client app, not the user.
- Cookies: `auth_token` (session) and `ct0` (CSRF). twscrape treats a session as usable only if both are present.
- `x-csrf-token` must equal the `ct0` cookie (double-submit CSRF).
- `x-twitter-auth-type: OAuth2Session`, `x-twitter-active-user: yes`, `x-twitter-client-language: en`.
- `x-client-transaction-id`: per-request signature (§1.3).
- Optional and seen in other projects: `x-xp-forwarded-for` (AES-GCM-encrypted client info derived from `guest_id`, in the-convocation `xpff.ts`), `x-request-client-id` (handled in twscrape around 2025-04/05).
- Error codes in the JSON `errors[]`: `(88) Rate limit exceeded`, `(326) Authorization: Denied by access control` (twikit: "account is locked (very likely is Arkose challenge)"), `(32) Could not authenticate you`, `(336) The following features cannot be null` (stale `features`), `(-1) LoadShed` (X overloaded; retry later and don't count it against the account).

### 1.2 Rate limits and headers
- **[confirmed]** GraphQL responses carry `x-rate-limit-limit`, `x-rate-limit-remaining`, and `x-rate-limit-reset` (UNIX epoch seconds). twscrape treats `remaining == 0 && reset > 0` as rate-limited and locks that account/queue until `reset`. the-convocation waits for reset by default and warns this "has been known to take … up to 13 minutes". https://github.com/vladkens/twscrape/blob/main/twscrape/queue_client.py , https://github.com/the-convocation/twitter-scraper#rate-limiting
- **[confirmed]** Windows are per endpoint and per account, and reset every 15 min (twikit `ratelimits.md`; X's official API uses the same 15-min model: https://docs.x.com/x-api/fundamentals/rate-limits).
- Per-15-min limits for the web GraphQL endpoints, from twikit's table (repo HEAD 2026-03; X does not publish these and calls them "dynamic"): `SearchTimeline` **50**, `UserTweets` **50**, `TweetDetail` **150**, `UserByScreenName` **95**, `Bookmarks` 500, `ListLatestTweetsTimeline` 500, `HomeTimeline`/`HomeLatestTimeline` 500, `Followers` 50, `Following` 500, `notifications/all.json` 180. https://github.com/d60/twikit/blob/main/ratelimits.md . **Read the headers. Don't trust this table.**
- 429 behaviour **[confirmed]**: status 429 plus code 88. A 429 can come back with `Content-Type: text/html` (twscrape #351, 2026-10-05, open), so detect it on status, not only on the JSON body. **`(88)` while `x-rate-limit-remaining > 0` is twscrape's heuristic for "account is banned/limited", not a normal rate limit.**
- yt-dlp falls back to the syndication endpoint on 429 for single tweets: https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/twitter.py
- **Daily read caps [confirmed historical, current values unknown]**: on 2023-07-01 Musk announced 6,000/600/300 posts viewed per day (verified/unverified/new unverified), then raised them to 10,000/1,000/500. X never documented the current values or what counts as a "view". https://blog.hootsuite.com/social-media-updates/twitter/twitter-limits-the-number-of-tweets-you-can-read-per-day/ , https://www.techradar.com/computing/twitter/twitter-crisis-explained-what-are-rate-limits-and-when-will-they-end . In the UI this shows as "Sorry, you are rate limited" or an empty timeline.
- **Write caps [confirmed via press, May 2026]**: X's limits help page now says 50 original posts and 200 replies per day for unverified accounts, split into semi-hourly sub-limits. https://www.engadget.com/2175771/x-accounts-are-limited-to-50-posts-and-200-replies-a-day/ , https://heise.de/-11298442 (help.x.com returned 403 to our fetcher; the official page is https://help.x.com/en/rules-and-policies/x-limits).

### 1.3 `x-client-transaction-id` (xclid)
- **[confirmed]** Required on authenticated GraphQL calls. A missing or stale value gives HTTP **404**, and twscrape retries up to 3 times, regenerating the key each time (#248). When generation broke in Jun 2026 (#312), "all API requests [were] blocked by X". https://github.com/vladkens/twscrape/issues/312
- **How it's computed [confirmed: twscrape `xclid.py`]**:
  1. Fetch an authenticated x.com HTML page (twscrape uses `https://x.com/tesla` and follows the twitter.com→x.com `/x/migrate` form). Logged-out sessions get a different build that doesn't reliably include the indices.
  2. `vk_bytes` = base64-decoded `<meta name="twitter-site-verification" content=…>`.
  3. Find the signing-indices script (legacy `ondemand.s.*.js`; current Vite build: `sign.o-*.js`, dynamically imported from `abs.twimg.com/x-web/…` chunks) and regex out the key-byte indices.
  4. Choose one of the `svg[id^='loading-x-anim']` path frames using `vk_bytes`, run a cubic-bezier/rotation interpolation to get an `anim_key` hex string.
  5. Per request: `ts = floor(now_s − 1682924400)`; `sha256("{METHOD}!{path}!{ts}obfiowerehiring{anim_key}")`; payload = `vk_bytes + ts(4 LE bytes) + hash[:16] + [3]`; XOR every byte with a random byte `r`, prefix `r`, base64 without `=`.
- **Breakage history (twscrape changelog)** **[confirmed]**: 2025-04-29 (v0.17), 2026-05-22 (v0.18, "X platform changes in May 2026"), 2026-06-16 (v0.19, new `/x-web/` asset path), 2026-07-21 (v0.19.2), 2026-08-25 (v0.20.1, chunk hashes went from 7 to 16 hex). That's about one break a month in mid-2026. https://github.com/vladkens/twscrape/blob/main/changelog.md
- Other implementations: Python `XClientTransaction` (iSarabjitDhiman, used by twikit's `x_client_transaction`), TS `x-client-transaction-id` (Lqm1, JSR), Rust `xitter-txid` (Jan 2026), and the-convocation `xctxid.ts`.
- **In a real page the app computes it itself**, so passive capture (Rec. 1) needs none of this **[inferred]**.

### 1.4 Guest tokens vs logged in
- **[confirmed]** Guest flow: `POST https://api.x.com/1.1/guest/activate.json` with the bearer gives `guest_token`, sent as `x-guest-token`. yt-dlp still uses it for single-tweet `TweetResultByRestId`. Nitter used guest-token pools until 2023–24. Since 2024 "you need to sign up" to use Twitter (nitter README), and search, timelines beyond a few posts, bookmarks, lists and notifications all need a logged-in session. x-cli should only use the person's logged-in session.

### 1.5 queryId and `features` rotation
- **[confirmed]** queryIds change with web deploys. twscrape shipped "Updated GraphQL operation IDs" in v0.19.0, v0.19.1, v0.19.2, v0.20.0 and v0.20.1 (2026-06-16 to 2026-08-25). Old IDs give 404 or errors. Stale `features` give `(336) The following features cannot be null: …`. twscrape now auto-adds the named flags (set to `true`) and retries once.
- **How projects get them [confirmed: twscrape `scripts/update-gql-ops.py`]**: fetch `x.com/home` and a profile page, collect `abs.twimg.com/x-web/…/*.js` (and legacy `responsive-web/client-web/main.*.js`) script URLs, follow `import()` references recursively, and regex `{queryId:"…",operationName:"…",operationType:"…",metadata:{featureSwitches:[…],fieldToggles:[…]}}` objects out of the bundles. Feature values come from the page's inline `window.__INITIAL_STATE__` / feature-switch config.
- **For x-cli [inferred]**: the cheapest, always-current source is the live request URLs the app sends (`page.on('request')`). Cache `{operationName → queryId, features, fieldToggles}` per session and fall back to bundle parsing only for operations not yet seen.

### 1.6 Cloudflare, TLS and HTTP/2 fingerprinting
- **[confirmed]** x.com responses carry `cf-ray`, and the authenticated HTML includes the Cloudflare `/cdn-cgi/challenge-platform/scripts/jsd/api.js` (JS-detection) script (twscrape #330, 2026-08-25; at the time it wasn't blocking).
- **[confirmed]** twscrape #337 (2026-09-12/14): `UserByRestId` returned "Blocked by Cloudflare: 403" with the default `httpx` backend but worked with `curl-cffi` Chrome impersonation for the maintainer. The maintainer calls httpx "too easily detectable". twscrape added an optional `curl-cffi` backend (v0.19.0, 2026-06-16).
- **[confirmed]** the-convocation ships a CycleTLS fetch with Chrome 144 JA3/JA4R, HTTP/2 SETTINGS and header-order constants, and warns that UA, client hints and TLS "must be consistent … and match a real Chrome release". https://github.com/the-convocation/twitter-scraper/blob/main/src/chrome-fingerprint.ts
- **Takeaway [inferred]**: X/Cloudflare fingerprint the transport. A real Chrome doing the request is the only zero-maintenance answer.

### 1.7 Login-flow defences, locks, challenges
- **[confirmed]** Scripted login hits error **399** ("Incorrect. Please try again" / suspicious activity) without a valid Castle.io device token. the-convocation ported a Castle v11 token generator for this and recommends exporting cookies instead ("Avoids Twitter's anti-bot protection that blocks automated logins"). https://github.com/the-convocation/twitter-scraper#cookie-based-authentication
- **[secondary, unverified date]** The emusks project's docs say `x.com/i/flow/login` now redirects to `x.com/i/jf/onboarding/web?mode=login` ("Jetfuel" server-driven UI), and that the classic LoginFlow returns 366/399. (code.lgbt/buraksocial/emusks, behind Cloudflare Access, so we could not read it directly.)
- **[confirmed]** Locked accounts give `(326)`, which twikit maps to `AccountLocked` ("very likely is Arkose challenge"). The unlock happens at `x.com/account/access` (FunCaptcha). twikit's advice: stop and intervene by hand, and on `AccountSuspended` stop. https://github.com/d60/twikit/blob/main/twikit/errors.py
- **[confirmed]** twikit "protect your account": don't hit rate limits, reuse cookies instead of calling `login()` repeatedly ("logins … are closely monitored"), go easy on DMs and sensitive content. https://github.com/d60/twikit/blob/main/ToProtectYourAccount.md . Its docs add 5–10 s between requests, exponential backoff, about 15 min wait after `TooManyRequests`, and "never send more requests than a human reasonably could". https://mintlify.wiki/d60/twikit/advanced/account-protection
- Headless-specific login blocking: no primary source found that X blocks headless browsers outright. **[inferred]** The old `chromium-headless-shell` is easy to detect (no GPU, different UA token `HeadlessChrome`), which is another reason to sign in headed.

### 1.8 Enforcement climate (2026)
- **[confirmed]** On 2026-08-24 X Corp sent cease-and-desist letters demanding a permanent takedown of Nitter instances and the repo. The maintainer was seeking legal help as of 2026-10-10. https://github.com/zedeus/nitter
- **[confirmed]** ToS liquidated damages for bulk access (§3).

---

## 2. Playwright facts relevant to the design [confirmed: playwright.dev, via Context7 2026-10-17]
- Default headless Chromium is `chromium-headless-shell`. `channel: 'chromium'` opts into **new headless**, which Chrome describes as "the real Chrome browser, and is thus more authentic". Branded `channel: 'chrome' | 'msedge' | 'chrome-beta' …` uses the installed browser (Playwright doesn't install it). https://playwright.dev/docs/browsers
- `browserType.launchPersistentContext(userDataDir)` persists cookies, localStorage, IndexedDB and cache. "Browsers do not allow launching multiple instances with the same User Data Directory." "Due to recent Chrome policy changes, automating the default Chrome user profile is not supported." https://playwright.dev/docs/api/class-browsertype
- Chrome 136+ ignores `--remote-debugging-port/-pipe` on the default data dir and needs a non-default `--user-data-dir` **[confirmed]** https://developer.chrome.com/blog/remote-debugging-port . So "attach to the person's everyday Chrome" isn't viable. Use an x-cli profile dir the person signs into once.
- `context.storageState({path, indexedDB})` exports cookies, localStorage and IndexedDB. It's useful as a portable backup or for an HTTP client, but a persistent profile is closer to a real browser (cache, service worker, history). The storageState file holds `auth_token`, which is equivalent to the password: store it `0600` and never log it **[inferred]**.

---

## 3. Terms of service and the official API

### 3.1 ToS and rules
- **[confirmed, ToS dated 2026-10-09 per ConductAtlas capture 2026-10-10]**: "…crawling or scraping the Services in any form, for any purpose without our prior written consent is expressly prohibited." The surrounding clause (from earlier ToS versions, unchanged in substance) bars accessing or searching the Services "by any means (automated or otherwise) other than through our currently available, published interfaces". https://conductatlas.com/platform/x/x-terms-of-service/acceptable-use-and-scraping-prohibition/ (x.com/en/tos returned HTTP 402 to our fetcher; read the original at https://x.com/en/tos).
- **[confirmed]** Liquidated damages (since 2024-11-15, still present in the 2026-10-09 version): violating the Terms while "requesting, viewing, or accessing more than 1,000,000 posts … in any 24-hour period" → "$15,000 USD per 1,000,000 posts", jointly and severally, including for those who "induce or knowingly facilitate" violations. https://conductatlas.com/platform/x/x-terms-of-service/liquidated-damages-for-excessive-post-access-us/ , https://knightcolumbia.org/content/knight-institute-says-xs-new-terms-of-service-will-stifle-independent-research
- **[confirmed, translated pages; English page 403 to fetcher]** The X Automation Rules prohibit "non-API-based forms of automation, such as scripting the X website", and attempts to get around rate limits. Violations "may result in permanent suspension". https://help.x.com/en/rules-and-policies/x-automation (de/es/fr/it versions seen).
- **Net [inferred]**: x-cli as designed, whether it scripts x.com or calls internal GraphQL, is outside the ToS even for personal, low-volume use of your own account. Practical exposure is account-level enforcement (rate limit, lock with Arkose, suspension), which grows with volume, parallelism, write actions and bot-like fingerprints. The damages clause is aimed at bulk scraping (more than 1M posts/day) and is not a realistic threat at our volume. There's no "personal use" carve-out.

### 3.2 Official X API (as of 2026-10-17) [confirmed: https://docs.x.com/x-api/getting-started/pricing]
- **Pay-per-use only for new developers**: prepaid credits, no subscription, capped at 3M post reads per billing cycle. Enterprise is above that.
- Reads: posts, lists etc. **$0.005** per resource; users and followers $0.010. **"Owned reads" $0.001** per resource for your own data (your posts, mentions, bookmarks, followers, lists) when the user owns the app. Same-resource repeats within a 24h UTC window are generally not re-billed.
- Writes: post create $0.015 ($0.20 with URL).
- Legacy Basic ($200/mo) and Pro ($5,000/mo) are closed to new signups. Secondary sources say pay-per-use became the default around 2026-02-06 and legacy plans are being migrated during 2026 **[secondary]**. https://www.socialcrawl.dev/blog/x-twitter-api-2026 , https://www.postproxy.dev/blog/x-api-pricing-2026/
- **Contrast**: a user reading 500 posts/day through the API pays about $2.50/day (about $75/mo) at $0.005, or about $0.50/day for owned-data endpoints such as bookmarks. That's ToS-clean but needs a developer app and OAuth, and some web-only surfaces (full notifications tab, some search operators) may not map 1:1 **[inferred]**. Worth offering as an `--official-api` backend for bookmarks, own timeline and lists.

---

## 4. Open questions / not verified
- Current per-endpoint limits for 2026: twikit's table is undated within the repo. Measure from headers in our own sessions and record them here.
- Whether X issues the Cloudflare JS challenge to real logged-in Chrome sessions under heavy page-navigation load (no source found).
- The current English text of help.x.com automation and limits pages (blocked to our fetcher). Re-read them in a browser.
- Whether X correlates `page.evaluate` fetches (no app-side telemetry calls around them) with bot behaviour (no source; theoretical).

## Sources (accessed 2026-10-17)
- twscrape (repo HEAD 2026-10-05, changelog, issues #312 #330 #337 #351): https://github.com/vladkens/twscrape
- twikit (HEAD 2026-03-10): https://github.com/d60/twikit (`ratelimits.md`, `ToProtectYourAccount.md`, `errors.py`)
- the-convocation/twitter-scraper (v0.22.3, 2026-03-31): https://github.com/the-convocation/twitter-scraper
- yt-dlp twitter extractor: https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/twitter.py
- XClientTransaction: https://github.com/iSarabjitDhiman/XClientTransaction
- Nitter README (C&D notice): https://github.com/zedeus/nitter
- Playwright: https://playwright.dev/docs/browsers , https://playwright.dev/docs/api/class-browsertype
- Chrome remote-debugging change: https://developer.chrome.com/blog/remote-debugging-port
- X API pricing: https://docs.x.com/x-api/getting-started/pricing ; rate limits: https://docs.x.com/x-api/fundamentals/rate-limits
- X ToS: https://x.com/en/tos (via https://conductatlas.com/platform/x/x-terms-of-service/)
- Stealth plugin status (secondary): https://apiserpent.com/blog/puppeteer-stealth-still-works-2026 , https://raw.githubusercontent.com/feder-cr/invisible_playwright/master/docs/puppeteer-extra-stealth-unmaintained.md
