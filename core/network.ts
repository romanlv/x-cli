import type { BrowserContext, Request } from "playwright";
import { timestamp } from "./store";

export interface NetworkEntry {
  /** Counts up from 1 for the life of the context, so a number names the same call between commands. */
  n: number;
  at: string;
  method: string;
  url: string;
  status?: number;
  type: string;
  contentType?: string;
  /** The request body, for the JSON calls an op might make directly; capped. */
  postData?: string;
  /** What the exploring session was doing when the call started: the last page command. */
  during?: string;
  /** Why the call ended without its body, like net::ERR_ABORTED: a stream the page closed once it had what it needed. */
  failed?: string;
  /** Request headers, cookies left out; kept with the body. */
  headers?: Record<string, string>;
  /** A JSON or event-stream response, kept only when asked for, and only for the newest calls, up to a budget. */
  body?: string;
}

const SKIP = new Set(["image", "font", "stylesheet", "script", "media", "manifest"]);
/** Assets a service worker fetches, which Playwright types as `other`: X loads a hundred scripts so. */
const ASSET = /\.(m?js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|mp4|m3u8|ts)(\?|$)/i;
const BODY_MAX = 5_000_000;
/** Characters of bodies kept at once, newest first: older calls keep their line, not their body. */
const BODIES_BUDGET = 30_000_000;
const SECRET_HEADERS = new Set(["cookie", "authorization"]);

/**
 * Keep the last `max` calls a browser context makes, skipping assets. With `bodies`, the newest JSON
 * responses too, with their request headers; `during` labels each call with what was going on.
 */
export const recordNetwork = (
  context: BrowserContext,
  { max = 100, bodies = false, during }: { max?: number; bodies?: boolean; during?: () => string | undefined } = {},
): NetworkEntry[] => {
  const entries: NetworkEntry[] = [];
  const started = new WeakMap<Request, string | undefined>();
  let n = 0;
  if (during) context.on("request", (request) => started.set(request, during()));
  const record = async (request: Request, failed?: string): Promise<void> => {
    if (SKIP.has(request.resourceType()) || ASSET.test(new URL(request.url()).pathname)) return;
    const entry: NetworkEntry = {
      n: ++n,
      at: timestamp(),
      method: request.method(),
      url: request.url(),
      type: request.resourceType(),
    };
    const label = started.get(request);
    if (label) entry.during = label;
    const postData = request.postData();
    if (postData) entry.postData = postData.slice(0, 2000);
    if (failed) entry.failed = failed;
    entries.push(entry);
    if (entries.length > max) entries.splice(0, entries.length - max);
    const response = await request.response().catch(() => null);
    entry.status = response?.status();
    entry.contentType = response?.headers()["content-type"];
    if (!bodies || !response || !/json|event-stream/.test(entry.contentType ?? "")) return;
    const [text, headers] = await Promise.all([
      failed ? undefined : response.text().catch(() => undefined),
      request.allHeaders().catch(() => ({})),
    ]);
    entry.headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !SECRET_HEADERS.has(k.toLowerCase())));
    if (text === undefined) return;
    entry.body = text.length > BODY_MAX ? `${text.slice(0, BODY_MAX)}\n… cut at ${BODY_MAX} of ${text.length} characters` : text;
    let size = 0;
    for (const e of [...entries].reverse()) {
      if (e.body === undefined) continue;
      size += e.body.length;
      if (size <= BODIES_BUDGET) continue;
      e.body = undefined;
      e.headers = undefined;
    }
  };
  context.on("requestfinished", (request) => void record(request));
  context.on("requestfailed", (request) => void record(request, request.failure()?.errorText ?? "failed"));
  return entries;
};

export const formatNetwork = (entries: NetworkEntry[], limit = 30): string => {
  const lines: string[] = entries.length > limit ? [`… ${entries.length - limit} earlier calls not shown (page:requests all)`] : [];
  let during: string | undefined;
  for (const e of entries.slice(-limit)) {
    if (e.during && e.during !== during) lines.push(`after ${e.during}:`);
    during = e.during;
    lines.push(
      `${e.headers ? `[${e.n}] ` : ""}${e.method} ${e.status ?? "---"} ${e.url}${e.contentType ? `  (${e.contentType.split(";")[0]})` : ""}${e.failed ? `  ${e.failed}` : ""}`,
    );
  }
  return lines.join("\n") || "no calls yet";
};

/**
 * `page:requests <n>`: one call whole, with its headers and bodies; `body` alone, the response as it
 * came. `refetch` when `page:fetch` is there to make a call again.
 */
export const formatCall = (entries: NetworkEntry[], n: number, bodyOnly = false, refetch = true): string | undefined => {
  const e = entries.find((x) => x.n === n);
  if (!e) return undefined;
  if (bodyOnly) return e.body;
  return [
    `${e.method} ${e.status ?? "---"} ${e.url}`,
    ...(e.during ? [`after ${e.during}`] : []),
    ...(e.headers ? ["", "request headers (cookies left out):", ...Object.entries(e.headers).map(([k, v]) => `${k}: ${v}`)] : []),
    ...(e.postData ? ["", "request body:", e.postData] : []),
    ...(e.body !== undefined ? ["", "response body:", e.body] : []),
    ...(e.failed
      ? ["", `${e.failed}: the page ended it before its body was read${refetch ? "; page:fetch the url with these headers for it" : ""}`]
      : []),
  ].join("\n");
};
