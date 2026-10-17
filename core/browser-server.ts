// bun core/browser-server.ts <socket> <parent pid>
//
// A browser on the host for a sandboxed build, which reaches it as XCLI_BROWSER through one unix
// socket: Chromium doesn't start under srt, and a sandbox opens no localhost port. Playwright's
// server listens on loopback only; this relays the socket to it. It ends with the run that started it.
import { existsSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { chromium } from "playwright";
import { launchWith } from "./browser";

export const BROWSER_PATH = "/browser";

/** What XCLI_BROWSER is for a server on `socket`. */
export const browserEndpoint = (socket: string): string => `ws+unix://${socket}:${BROWSER_PATH}`;

if (import.meta.main) {
  const [socket, parent] = process.argv.slice(2);
  if (!socket || !parent) throw new Error("usage: browser-server.ts <socket> <parent pid>");
  const serve = { host: "127.0.0.1", port: 0, wsPath: BROWSER_PATH };
  const server = await launchWith(false, (options) => chromium.launchServer({ ...options, ...serve }));
  const { port } = new URL(server.wsEndpoint());

  rmSync(socket, { force: true });
  const listener = createServer((client) => {
    const upstream = connect(Number(port), "127.0.0.1");
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close).on("close", close);
    upstream.on("error", close).on("close", close);
  }).listen(socket, () => console.log("ready"));

  const stop = async () => {
    listener.close();
    rmSync(socket, { force: true });
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  setInterval(() => {
    let alive = true;
    try {
      process.kill(Number(parent), 0);
    } catch {
      alive = false;
    }
    if (!alive || !existsSync(socket)) void stop();
  }, 2000);
}
