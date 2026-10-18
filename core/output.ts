import { envValue } from "./env";

/** Exit codes, as DESIGN.md's Interface table lists them. */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  /** No context, signed out, record not found. */
  PRECONDITION: 3,
  /** The app refused it: a validation message, a missing permission, a rate limit. */
  REFUSED: 4,
  /** A request was filed or is open: the op is missing, changing or being repaired. */
  PENDING: 5,
  /** `--wait` gave up before the request finished. */
  TIMEOUT: 6,
} as const;

export interface NextHint {
  hint: string;
  cmd: string;
}

export interface Outcome {
  ok: boolean;
  data?: unknown;
  /** What a person reads in place of `data`; --json prints `data`. */
  text?: string;
  error?: string;
  next?: NextHint[];
  exitCode?: number;
  /**
   * The request the outcome is about, never printed: a pending one's, for `--wait` to follow, or the
   * repair a done call filed for its direct way, for the worker to take up.
   */
  request?: string;
}

export const fail = (error: string, exitCode: number = EXIT.ERROR, next?: NextHint[]): Outcome => ({
  ok: false,
  error,
  exitCode,
  next,
});

export const ok = (data: unknown, next?: NextHint[], text?: string): Outcome => ({ ok: true, data, text, next });

type Writer = (text: string, cb: () => void) => unknown;

// Captured before `guardStdout` diverts the stream, so the result still reaches the real stdout.
const stdout: Writer = process.stdout.write.bind(process.stdout) as Writer;
const stderr: Writer = process.stderr.write.bind(process.stderr) as Writer;

/** Send everything but the result to stderr, so a library writing to stdout can't corrupt it. */
export const guardStdout = (): void => {
  process.stdout.write = ((chunk: string | Uint8Array, encoding?: unknown, cb?: unknown) =>
    (process.stderr.write as (...args: unknown[]) => boolean)(chunk, encoding, cb)) as typeof process.stdout.write;
};

let progressTo: ((line: string) => void) | undefined;

/** While set, progress goes to `to` instead of stderr: a daemon running a call sends it back to the caller. */
export const progressInto = (to: ((line: string) => void) | undefined): void => {
  progressTo = to;
};

/** Progress for a person watching; never part of the result. */
export const progress = (line: string): void => {
  if (envValue("QUIET")) return;
  if (progressTo) progressTo(line);
  else stderr(`${line}\n`, () => {});
};

const write = (writer: Writer, text: string): Promise<void> => new Promise((resolve) => void writer(text, resolve));

/** `key: value` lines for a flat record, which is what most op outputs are. */
const formatData = (data: unknown): string => {
  if (typeof data === "string") return data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.every(([, v]) => v === null || typeof v !== "object")) {
      return entries.map(([k, v]) => `${k}: ${v ?? ""}`).join("\n");
    }
  }
  return JSON.stringify(data, null, 2);
};

/** Print an outcome and exit: `{ ok, data, error, next }` with --json, text otherwise. */
export const finish = async (outcome: Outcome, { json }: { json: boolean }): Promise<never> => {
  const exitCode = outcome.exitCode ?? (outcome.ok ? EXIT.OK : EXIT.ERROR);

  if (json) {
    const envelope = { ok: outcome.ok, data: outcome.data, error: outcome.error, next: outcome.next ?? [] };
    await write(stdout, `${JSON.stringify(envelope)}\n`);
    process.exit(exitCode);
  }

  if (outcome.error) await write(stderr, `error: ${outcome.error}\n`);

  const lines: string[] = [];
  if (outcome.text !== undefined) lines.push(outcome.text);
  else if (outcome.data !== undefined) lines.push(formatData(outcome.data));
  for (const { hint, cmd } of outcome.next ?? []) lines.push(`Next: ${hint}\n  ${cmd}`);

  // A failure prints nothing to stdout, so `ID=$(x … )` captures nothing on failure. A filed
  // request is not a failure in that sense: its id is the result the caller needs.
  const toStdout = outcome.ok || exitCode === EXIT.PENDING;
  if (lines.length > 0) await write(toStdout ? stdout : stderr, `${lines.join("\n")}\n`);
  process.exit(exitCode);
};

/** Quote an argument for a command a person or agent will paste. */
export const shellQuote = (arg: string): string => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

/** A command as a person would type it: the CLI and its arguments, quoted where the shell needs it. */
export const commandLine = (cli: string, argv: string[]): string => [cli, ...argv.map(shellQuote)].join(" ");

/** Playwright colours its call logs; the ledger and bundles are read as plain text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is what an ANSI colour code starts with.
export const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

/** A message's first line, cut to `max` characters. */
export const firstLine = (text: string, max = Number.POSITIVE_INFINITY): string => {
  const line = text.split("\n")[0]!;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** "2h ago", "3d ago": for listings a person reads. */
export const ago = (iso: string, now = Date.now()): string => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
};

/** "45s", "16m", "1h05m". */
export const formatDuration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};
