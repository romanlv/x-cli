// A browser no automation drives, for a person's sign-in: the installed browser started as itself,
// without Playwright's flags, so the sign-in page sees an ordinary browser. Core lists its tabs over
// its debugging port, which the pages can't see, and attaches only to read a tab that may be signed in.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { BrowserError } from "./errors";

/** Where each channel's browser is installed, by platform. */
const INSTALLED: Record<string, Partial<Record<NodeJS.Platform, string[]>>> = {
  chrome: {
    darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    linux: ["/opt/google/chrome/chrome"],
    win32: [
      `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
  },
  msedge: {
    darwin: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    linux: ["/opt/microsoft/msedge/msedge"],
    win32: [`${process.env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`],
  },
};

/** The channel's installed browser, or Playwright's Chromium when there is none. */
export const browserBinary = (channel: string | undefined, platform = process.platform): string => {
  const installed = channel ? INSTALLED[channel]?.[platform]?.find((path) => existsSync(path)) : undefined;
  const binary = installed ?? chromium.executablePath();
  if (!existsSync(binary)) throw new BrowserError(`no browser to sign in with: ${channel ?? "chromium"} is not installed`);
  return binary;
};

export interface Tab {
  id: string;
  url: string;
}

export interface PlainBrowser {
  /** The page tabs open now, as the browser lists them; nothing attaches to them. */
  tabs(): Promise<Tab[]>;
  /** Attach to read the pages; `close()` on what it returns detaches and leaves the browser open. */
  attach(): Promise<Browser>;
  /** The person closed the browser. */
  closed(): boolean;
  close(): Promise<void>;
}

export interface PlainOptions {
  /** A profile of its own: a browser opens no debugging port on the person's own. */
  profileDir: string;
  url: string;
  size: { width: number; height: number };
  /** For the tests: a person signs in in the window. */
  headless?: boolean;
}

/** Start the browser as itself on its profile, at `url`. */
export const startPlain = async (binary: string, { profileDir, url, size, headless = false }: PlainOptions): Promise<PlainBrowser> => {
  mkdirSync(profileDir, { recursive: true });
  // The browser writes its port here once it listens; one left from an earlier start is stale.
  const portFile = join(profileDir, "DevToolsActivePort");
  rmSync(portFile, { force: true });
  const args = [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    // The profile's cookies are kept with a key of its own, not in the system keychain, which asks
    // the person first (and a headless browser can't): `auth.json` beside it holds them in the clear anyway.
    ...(process.platform === "darwin" ? ["--use-mock-keychain"] : process.platform === "linux" ? ["--password-store=basic"] : []),
    `--window-size=${size.width},${size.height}`,
    ...(headless ? ["--headless=new"] : []),
    url,
  ];
  const child: ChildProcess = spawn(binary, args, { stdio: "ignore" });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  child.on("error", () => {
    exited = true;
  });

  const deadline = Date.now() + 30_000;
  let port: string | undefined;
  while (!port) {
    if (exited) throw new BrowserError(`the browser would not start: ${binary}`);
    if (Date.now() > deadline) {
      child.kill();
      throw new BrowserError("the browser opened no debugging port");
    }
    port = existsSync(portFile) ? readFileSync(portFile, "utf8").split("\n")[0]?.trim() || undefined : undefined;
    if (!port) await Bun.sleep(100);
  }
  const endpoint = `http://127.0.0.1:${port}`;

  return {
    async tabs() {
      const list = (await (await fetch(`${endpoint}/json/list`)).json()) as { id: string; type: string; url: string }[];
      return list.filter((t) => t.type === "page").map(({ id, url }) => ({ id, url }));
    },
    attach: () => chromium.connectOverCDP(endpoint),
    closed: () => exited,
    async close() {
      if (exited) return;
      const gone = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await Promise.race([gone, Bun.sleep(5000)]);
    },
  };
};
