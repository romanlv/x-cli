// Named contexts, as `kubectl config use-context` names clusters: a nickname, a URL (the app, as one
// account or tenant of it) and a saved sign-in.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EXIT, raise } from "./output";
import { readJson, withLock, writeJson } from "./store";

export interface ContextEntry {
  /** What the person gave: the app's URL for this context, or its sign-in page. */
  url: string;
  /** Where the signed-in app lives, recorded at sign-in; runs and sessions start here. */
  appUrl?: string;
  addedAt: string;
  /** When a person last signed in through `context:login`. */
  signedInAt?: string;
  /** Set when a sign-in check found the saved session expired; cleared by the next login. */
  signedOutAt?: string;
}

interface Config {
  current?: string;
  contexts: Record<string, ContextEntry>;
}

export interface Context extends ContextEntry {
  name: string;
  appUrl: string;
  /** Playwright storage state: cookies and local storage of the signed-in session. */
  authFile: string;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * A person's username and password for a context, from `.env.<context>` in the checkout (or
 * XCLI_CREDENTIALS_DIR): XCLI_USERNAME and XCLI_PASSWORD. The file is gitignored, so a
 * build's worktree never has one, and agents never sign in.
 */
export const savedCredentials = (root: string, context: string): { username: string; password: string } | undefined => {
  const file = join(process.env.XCLI_CREDENTIALS_DIR ?? root, `.env.${context}`);
  if (!existsSync(file)) return undefined;
  const vars: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) vars[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  const { XCLI_USERNAME: username, XCLI_PASSWORD: password } = vars;
  return username && password ? { username, password } : undefined;
};

export class Contexts {
  constructor(
    private readonly home: string,
    private readonly cli: string,
  ) {}

  /** XCLI_CONTEXTS_DIR: a sandboxed build reads its context's sign-in where it is, read-only. */
  private get dir(): string {
    return process.env.XCLI_CONTEXTS_DIR ?? join(this.home, "contexts");
  }

  private get file(): string {
    return join(this.dir, "config.json");
  }

  private read(): Config {
    return readJson<Config>(this.file, { contexts: {} });
  }

  authFile(name: string): string {
    return join(this.dir, name, "auth.json");
  }

  list(): { current?: string; contexts: Context[] } {
    const config = this.read();
    const contexts = Object.entries(config.contexts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, entry]) => this.context(name, entry));
    return { current: config.current, contexts };
  }

  add(name: string, url: string): Context {
    if (!NAME.test(name)) raise(`context name "${name}" must be lowercase letters, digits, - and _`, EXIT.USAGE);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return raise(`--url "${url}" is not a URL`, EXIT.USAGE);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") raise(`--url must be http(s), got "${url}"`, EXIT.USAGE);

    this.change((config) => {
      if (config.contexts[name] && config.contexts[name].url !== normalizeUrl(url)) {
        raise(`context "${name}" already names ${config.contexts[name].url}; remove it first`, EXIT.USAGE, [
          { hint: "remove it", cmd: `${this.cli} context:remove ${name}` },
        ]);
      }
      config.contexts[name] = config.contexts[name] ?? { url: normalizeUrl(url), addedAt: new Date().toISOString() };
      // The first context added is the one used until another is chosen.
      config.current = config.current ?? name;
    });
    return this.get(name);
  }

  remove(name: string): void {
    this.change((config) => {
      if (!config.contexts[name]) this.missing(name);
      delete config.contexts[name];
      if (config.current === name) config.current = undefined;
    });
    rmSync(join(this.dir, name), { recursive: true, force: true });
  }

  use(name: string): Context {
    this.change((config) => {
      if (!config.contexts[name]) this.missing(name);
      config.current = name;
    });
    return this.get(name);
  }

  get(name: string): Context {
    const entry = this.read().contexts[name];
    if (!entry) return this.missing(name);
    return this.context(name, entry);
  }

  private context(name: string, entry: ContextEntry): Context {
    return { name, ...entry, appUrl: entry.appUrl ?? entry.url, authFile: this.authFile(name) };
  }

  /** The context a call runs against: `--context`, or the current one. */
  resolve(name: string | undefined): Context {
    if (name) return this.get(name);
    const { current } = this.read();
    if (!current) {
      return raise("no context: add one and sign in first", EXIT.PRECONDITION, [
        { hint: "add one", cmd: `${this.cli} context:add <name> --url <url>` },
      ]);
    }
    return this.get(current);
  }

  isSignedIn(context: Context): boolean {
    return existsSync(context.authFile) && !context.signedOutAt;
  }

  markSignedIn(name: string, appUrl: string): void {
    this.update(name, (entry) => ({ ...entry, appUrl, signedInAt: new Date().toISOString(), signedOutAt: undefined }));
  }

  /** Best effort: a sandboxed build can't write the contexts, and the worker finds the sign-out itself. */
  markSignedOut(name: string): void {
    try {
      this.update(name, (entry) => ({ ...entry, signedOutAt: new Date().toISOString() }));
    } catch {}
  }

  private update(name: string, change: (entry: ContextEntry) => ContextEntry): void {
    this.change((config) => {
      if (!config.contexts[name]) this.missing(name);
      config.contexts[name] = change(config.contexts[name]!);
    });
  }

  /** Read, change and write the config under a lock, so two processes' changes never cross. */
  private change(fn: (config: Config) => void): void {
    withLock(join(this.dir, ".lock"), () => {
      const config = this.read();
      fn(config);
      writeJson(this.file, config);
    });
  }

  private missing(name: string): never {
    const names = Object.keys(this.read().contexts);
    return raise(`no context "${name}"${names.length ? ` (contexts: ${names.join(", ")})` : ""}`, EXIT.PRECONDITION, [
      { hint: "add it", cmd: `${this.cli} context:add ${name} --url <url>` },
    ]);
  }
}

const normalizeUrl = (url: string): string => url.replace(/\/+$/, "");

/** The sign-in hint every signed-out error ends with. */
export const loginHint = (cli: string, context: string) => ({
  hint: "sign in again",
  cmd: `${cli} context:login ${context}`,
});
