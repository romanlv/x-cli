// A browser no automation drives, for a person's sign-in: the installed browser started as itself,
// with no Playwright flags and no debugging port, so the sign-in page sees an ordinary browser.
// Nothing watches it; once the person is done, Playwright opens its profile to read the sign-in.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";
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

export interface PlainOptions {
  /** A profile of its own, which Playwright opens afterwards: never the person's everyday one. */
  profileDir: string;
  url: string;
  size: { width: number; height: number };
  /** For the tests: a person signs in in the window. */
  headless?: boolean;
}

export interface PlainBrowser {
  /** Settles when the browser has exited: the person quit it. */
  exited: Promise<void>;
  close(): Promise<void>;
}

/** Start the browser as itself on its profile, at `url`. */
export const startPlain = (binary: string, { profileDir, url, size, headless = false }: PlainOptions): PlainBrowser => {
  mkdirSync(profileDir, { recursive: true });
  const args = [
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Cookies kept the way Playwright keeps them, so it can read them back: with a key of the
    // profile's own, not the system keychain. Nothing a page can see.
    ...(process.platform === "darwin" ? ["--use-mock-keychain"] : process.platform === "linux" ? ["--password-store=basic"] : []),
    `--window-size=${size.width},${size.height}`,
    ...(headless ? ["--headless=new"] : []),
    url,
  ];
  const child = spawn(binary, args, { stdio: "ignore" });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  return {
    exited,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      // Interrupted, the browser saves its cookies on the way out; terminated, it doesn't.
      child.kill("SIGINT");
      await Promise.race([exited, Bun.sleep(5000)]);
    },
  };
};
