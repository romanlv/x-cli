// Where sandboxed agents live: srt, writing only the worktree, a CLI home of the request's own and a
// short socket directory. They read awf's source, which the type-check resolves, and their context's
// saved sign-in where it is. Their checks are ci:sandbox: `awf test` can't run under srt, nor the e2e
// tests, whose mock app can't take a port, so those run on the host only. The worktree gets
// node_modules of its own, since bun resolving through a link to the checkout's would need the
// checkout readable. The browser stays on the host, reached through one socket in that directory,
// since Chromium doesn't start under srt; so do an op's direct calls.
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { InlineSandboxSpec } from "agentswf/workflow";
import { browserEndpoint } from "../browser-server";
import { envName } from "../env";
import type { RequestRecord } from "../requests";
import type { SandboxReach } from "./config";

export interface SandboxPaths {
  /** The CLI's XCLI_HOME for the agents: their sessions, dry runs and failures. */
  home: string;
  /** Short, as unix socket paths are limited to about 100 bytes: the browser's, and the sessions'. */
  sockets: string;
  browserSocket: string;
}

/** What the checks an agent runs need: the host's browser for the tests, and a temp directory it can write. */
export const shellEnv = (paths: SandboxPaths): Record<string, string> => ({
  [envName("BROWSER")]: browserEndpoint(paths.browserSocket),
  TMPDIR: paths.sockets,
});

/** `tmp` is /tmp by its real path; docs/prompts.md gives it as is, to read the same on every machine. */
export const sandboxPaths = (request: RequestRecord, tmp = realpathSync("/tmp")): SandboxPaths => {
  // Named for the CLI, cut short: a session's socket path goes under it.
  const sockets = join(tmp, `${request.domain.name.slice(0, 8)}-${request.id}`);
  return { home: join(request.domain.home, "sandboxes", request.id), sockets, browserSocket: join(sockets, "browser.sock") };
};

/** awf's checkout, which the type-check reads: the `awf` on PATH, by its real path. */
const awfRoot = (): string | undefined => {
  const bin = Bun.which("awf");
  if (!bin) return undefined;
  let dir = dirname(realpathSync(bin));
  while (dir !== "/" && !existsSync(join(dir, "packages", "contract"))) dir = dirname(dir);
  return dir === "/" ? undefined : dir;
};

export const sandboxSpec = (request: RequestRecord, worktree: string, paths: SandboxPaths): InlineSandboxSpec => {
  const contexts = join(request.domain.home, "contexts");
  const awf = awfRoot();
  return {
    write: [worktree, paths.home, paths.sockets],
    read: [join(contexts, "config.json"), join(contexts, request.context), ...(awf ? [awf] : [])],
    sockets: [paths.sockets],
    srt: {},
  };
};

/** The spec with what workflows.json adds: its paths from the checkout's root. */
export const widen = (spec: InlineSandboxSpec, reach: SandboxReach, root: string): InlineSandboxSpec => {
  const paths = (list: readonly string[] = []) => list.map((path) => resolve(root, path));
  return {
    ...spec,
    read: [...(spec.read ?? []), ...paths(reach.read)],
    write: [...(spec.write ?? []), ...paths(reach.write)],
    network: [...(spec.network ?? []), ...(reach.network ?? [])],
  };
};
