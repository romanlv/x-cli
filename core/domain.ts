import { dirname, join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { envValue } from "./env";

export type SignInState = "signed-in" | "signed-out" | "elsewhere" | "unknown";

/** What a page command gets: the session's page and the context it was opened for. */
export interface PageCommandContext {
  page: Page;
  contextUrl: string;
}

/**
 * Everything `core/` needs to know about the app it drives. `core/` never imports a domain; the
 * domain's entry point builds one of these and hands it to `main`.
 */
export interface Domain<Helpers = unknown> {
  /** The command's name, as people type it: `x`. */
  name: string;
  /** The domain folder: `authoring.md`, `knowledge/`, `ops/`, `helpers/`. */
  dir: string;
  /** The tool's checkout, the parent of `core/` and the domain folder; `defineDomain` defaults it. */
  root: string;
  /**
   * Whether `root` is a build's worktree, where the CLI files no requests and starts no repairs.
   * Unset, a `.git` file (not folder) at `root` says so; the tests' fixture sets false.
   */
  worktree?: boolean;
  /** Where contexts, sessions, requests and failures live: `<root>/.state` unless HOME is set. */
  home: string;
  /** The helper library ops get as `app`. */
  helpers(page: Page, options: { contextUrl: string; dryRun: boolean }): Helpers;
  /**
   * Is the page signed in as this context? Called on a page that has loaded the context's
   * URL. `elsewhere` means signed in, but as another account or tenant than the URL names; `unknown` that the
   * page showed neither a signed-in page nor a sign-in, such as one still loading.
   */
  signInState(page: Page, contextUrl: string): Promise<SignInState>;
  /**
   * Fill the sign-in form with a person's username and password and submit it, for
   * `context:login --username`. Without it, only signing in in the window is offered.
   */
  submitSignIn?(page: Page, credentials: { username: string; password: string }): Promise<void>;
  /**
   * Set up every signed-in browser before it loads the app, such as routes that block a page the
   * app would otherwise load to sign out the sign-in every browser of the context shares.
   */
  prepareBrowser?(context: BrowserContext): Promise<void>;
  /**
   * The URL a run starts from, given the URL a sign-in landed on and the context's own URL: the
   * app's home page. The sign-in check is made against it, so it keeps what the check needs.
   */
  appUrl?(signedInUrl: string, contextUrl: string): string;
  /**
   * Rules for a failed op: does the page show the app refusing the action (a validation message, a
   * missing permission)? Returns that message, or undefined when it shows nothing of the kind.
   */
  refusal?(page: Page): Promise<string | undefined>;
  /** An installed browser to run instead of Playwright's Chromium, such as "chrome", for an app that tells them apart. */
  browserChannel?: string;
  /** How many requests the worker builds at once (2); one for an app that limits each account. */
  maxRunning?: number;
  /**
   * For an app that signs out an idle session: open pages are nudged every `pageEveryMs`, and while
   * requests run the worker opens the app every `signInEveryMs` and saves the fresh cookies. Unset,
   * neither happens.
   */
  keepAlive?: { pageEveryMs: number; signInEveryMs: number };
  /** The attribute the app marks its controls with ("data-testid"): snapshots show it, and locators prefer it. */
  testIdAttribute?: string;
  /** False when ops may have no direct way, for an app that tells its own calls from anyone else's. */
  directCalls?: boolean;
  /** Extra `page:<name>` commands the domain offers agents, such as `page:search` for X. */
  pageCommands?: Record<string, { usage: string; run(ctx: PageCommandContext, args: string[]): Promise<string | undefined> }>;
}

/** A domain with what core can work out filled in: its checkout is the domain folder's parent. */
export const defineDomain = <Helpers>(
  domain: Omit<Domain<Helpers>, "root" | "home"> & Partial<Pick<Domain<Helpers>, "root" | "home">>,
): Domain<Helpers> => {
  const root = domain.root ?? dirname(domain.dir);
  return { ...domain, root, home: domain.home ?? envValue("HOME") ?? join(root, ".state") };
};
