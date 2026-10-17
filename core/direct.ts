// An op's direct way: the app's own calls, made over plain HTTP on the context's saved sign-in, with
// no browser. It is tried before the browser way, which stays the fallback.
import { existsSync } from "node:fs";
import { type APIRequestContext, request } from "playwright";
import { launch, STEP_TIMEOUT_MS, saveSession } from "./browser";
import type { Context } from "./contexts";
import { envValue } from "./env";
import { OpError, outcomeOf } from "./errors";
import type { Attempt, OpEntry, RunEnv } from "./ops";
import { firstLine, type Outcome, plain, progress } from "./output";

export interface DirectContext {
  /** HTTP on the context's saved cookies; no browser is started. */
  http: APIRequestContext;
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  context: { name: string; url: string };
}

/** Why the direct way failed, so the op ran in the browser. */
export interface FellBack {
  step: string;
  error: Error;
}

/**
 * With XCLI_BROWSER the calls go out from the host's browser server, as the pages do: a sandbox
 * reaches no network of its own.
 */
const openHttp = async (ctx: Context): Promise<{ http: APIRequestContext; close(): Promise<void> }> => {
  if (!envValue("BROWSER")) {
    const http = await request.newContext({ storageState: ctx.authFile, timeout: STEP_TIMEOUT_MS });
    return { http, close: () => http.dispose() };
  }
  const browser = await launch(false);
  const context = await browser.newContext({ storageState: ctx.authFile });
  context.setDefaultTimeout(STEP_TIMEOUT_MS);
  return { http: context.request, close: () => browser.close().catch(() => {}) };
};

/**
 * Try the op's direct way. An outcome when it settled the call: done, or an OpError (bad input, a
 * refusal) that the browser way would meet too. Otherwise the op runs in the browser, after the
 * failure in `fellBack` if the direct way was tried. It isn't when the op has none, when its repair
 * failed (until that is retried), or with no saved sign-in to call on.
 */
export const tryDirect = async (
  env: RunEnv,
  entry: OpEntry,
  input: Record<string, unknown>,
  ctx: Context,
  attempt: Attempt,
  check: (output: unknown) => Outcome,
): Promise<{ outcome: Outcome } | { fellBack?: FellBack }> => {
  const { direct } = entry.definition;
  if (!direct || !existsSync(ctx.authFile)) return {};
  const broken = env.fileRepairs ? env.requests.brokenBy(entry.name, true) : undefined;
  if (broken) {
    progress(`› the direct way's repair ${broken.id} failed; in the browser`);
    return {};
  }
  const { http, close } = await openHttp(ctx);
  try {
    const outcome = check(await direct({ http, step: attempt.step, context: { name: ctx.name, url: ctx.appUrl } }, input));
    // As a browser run does: the app may keep its idle timer, or a refreshed session, in the cookies.
    await saveSession(http, ctx).catch(() => {});
    attempt.history({ ok: true, direct: true });
    return { outcome };
  } catch (err) {
    if (err instanceof OpError) {
      attempt.history({ ok: false, step: attempt.at, error: firstLine(err.message), exit: err.exitCode, direct: true });
      return { outcome: outcomeOf(err) };
    }
    const message = plain(err instanceof Error ? err.message : String(err));
    const at = attempt.at ? ` at "${attempt.at}"` : "";
    return { fellBack: { step: attempt.at ?? "direct", error: new Error(`the direct way failed${at}: ${message}`) } };
  } finally {
    await close();
  }
};
