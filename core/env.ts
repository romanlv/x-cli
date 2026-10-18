// Every environment variable the CLI reads or hands its children, under one prefix. A CLI for
// another site may rename the prefix here; code builds every name from it.
export const ENV_PREFIX = "XCLI_";

export type EnvName =
  | "HOME"
  | "SESSION"
  | "QUIET"
  | "AWF"
  | "BROWSER"
  | "BROWSER_CHANNEL"
  | "CONTEXTS_DIR"
  | "CREDENTIALS_DIR"
  | "HEADLESS_LOGIN"
  | "HIDE_AUTOMATION"
  | "KEEP_ALIVE_PAGE_MS"
  | "KEEP_BROWSER"
  | "KEEP_ALIVE_SIGN_IN_MS"
  | "MAX_RUNNING"
  | "NO_REPAIRS"
  | "NO_WORKER"
  | "POLL_MS"
  | "RUN_TIMEOUT"
  | "SESSION_IDLE_MS"
  | "SIGNIN_WAIT_MS"
  | "STEP_TIMEOUT_MS";

export const envName = (name: EnvName): string => ENV_PREFIX + name;

export const envValue = (name: EnvName): string | undefined => process.env[envName(name)];

/** A number from the environment, or the fallback when it isn't set. */
export const envNumber = (name: EnvName, fallback: number): number => Number(envValue(name) ?? fallback);

/**
 * A setting the domain makes, changed by the environment; one the domain leaves unset stays unset,
 * and zero (or what isn't a number) unsets it.
 */
export const envOverride = (name: EnvName, value: number | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const n = envNumber(name, value);
  return n > 0 ? n : undefined;
};
