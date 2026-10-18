import { dirname, join } from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import type { Credentials } from "./credentials";
import { envValue } from "./env";
import type { NetworkEntry } from "./network";
import type { SnapshotNode } from "./snapshot";

export type SignInState = "signed-in" | "signed-out" | "elsewhere" | "unknown";

/** What a page command gets: the session's page, and the moves core's own commands are made of. */
export interface PageCommandContext {
  page: Page;
  /** The session's name. */
  session: string;
  /** The URL the session's context starts from. */
  contextUrl: string;
  /** The session's folder, for what a command saves. */
  dir: string;
  /** The calls the page has made, as `page:requests` lists them. */
  network: NetworkEntry[];
  /** The control a ref from the last snapshot names; bad input when it is not on the page any more. */
  ref(ref: string | undefined): Promise<{ locator: Locator; node?: SnapshotNode }>;
  /** Log the command to the session's trace, with `locator`, or the one an op would use for the ref it acted on. */
  trace(locator?: string): void;
  /** The page as text once it has gone quiet, what changed since the last snapshot marked; `whole`, unmarked. */
  snapshot(options?: { whole?: boolean }): Promise<string>;
  /** End the session once this command has answered. */
  close(): void;
}

/** A `page:<name>` command an agent explores with. */
export interface PageCommand {
  /** Its arguments and what it does, for `help`. */
  usage: string;
  /** It only reads what the session has, so the calls made meanwhile belong to the command before. */
  reads?: boolean;
  /** What it prints. A domain's commands print the page after it, with what changed marked, unless they only read. */
  run(ctx: PageCommandContext, args: string[]): Promise<string | undefined>;
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
   * Is the page signed in as this context? One look at a page that has loaded the context's URL;
   * core waits, asking again while the answer is `unknown`, up to XCLI_SIGNIN_WAIT_MS. `elsewhere`
   * means signed in, but as another account or tenant than the URL names; `unknown` that the page
   * shows neither a signed-in page nor a sign-in yet, such as one still loading.
   */
  signInState(page: Page, contextUrl: string): Promise<SignInState>;
  /**
   * Fill the sign-in form with a person's username and password and submit it, for
   * `context:login --username`, and for the worker to sign a request blocked on signing in in
   * again from `.env.<context>`. Without it, only signing in in the window is offered.
   */
  submitSignIn?(page: Page, credentials: Credentials): Promise<void>;
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
  /**
   * For an app that watches for automation: browsers start without Playwright's automation switch
   * (`navigator.webdriver` is false) and a headless one sends a headed one's user agent. Playwright
   * still drives the pages over DevTools, which a page can notice.
   */
  hideAutomation?: boolean;
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
  /** Extra `page:<name>` commands the domain offers agents, by name without `page:`: `search` for X. */
  pageCommands?: Record<string, PageCommand>;
}

/** A domain with what core can work out filled in: its checkout is the domain folder's parent. */
export const defineDomain = <Helpers>(
  domain: Omit<Domain<Helpers>, "root" | "home"> & Partial<Pick<Domain<Helpers>, "root" | "home">>,
): Domain<Helpers> => {
  const root = domain.root ?? dirname(domain.dir);
  return { ...domain, root, home: domain.home ?? envValue("HOME") ?? join(root, ".state") };
};
