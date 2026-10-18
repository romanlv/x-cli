// The worker: a loop that takes the oldest received request and starts an awf run for it, as many at
// once as the domain allows. Filing a request starts it if none is running; it exits once nothing is running.
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { awfArgs, awfCommand, awfEnv, runOutput, workflowOf } from "./awf";
import { envName, envValue } from "./env";
import { isSignInQuestion, isTerminal, type RequestRecord, Requests } from "./requests";
import { alive, readJson, timestamp, withLock, writeJson } from "./store";

/**
 * Record the worker's pid under the lock, unless another worker alive has it: `start` returns the
 * pid to record. A worker `ensureWorker` started finds its own pid there.
 */
const claimWorker = (home: string, start: () => number): boolean =>
  withLock(join(home, "worker.lock"), () => {
    const pid = readJson<{ pid?: number }>(join(home, "worker.json"), {}).pid;
    if (pid !== process.pid && alive(pid)) return false;
    writeJson(join(home, "worker.json"), { pid: start(), startedAt: timestamp() });
    return true;
  });

/** Start a worker in the background unless one is running. `entry` re-invokes this CLI. */
export const ensureWorker = (home: string, entry: string[]): void => {
  if (envValue("NO_WORKER")) return;
  mkdirSync(home, { recursive: true });
  claimWorker(home, () => {
    // Appended, so a worker started later keeps the log of the ones before it.
    const log = openSync(join(home, "worker.log"), "a");
    const child = Bun.spawn([...entry, "request:worker"], {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, [envName("HOME")]: home },
    });
    child.unref();
    return child.pid;
  });
};

/** Does the request's next attempt start at intake? Intake takes one request at a time, so each sees what the one before it decided. */
const atIntake = (r: RequestRecord): boolean => {
  const workflow = workflowOf(r);
  return workflow.intake && (r.stage === undefined || r.stage === workflow.firstStage || !!r.redo);
};

/** The received requests to start now, oldest first: as many as there are free slots, and one at intake only while none is. */
const pick = (queue: RequestRecord[], slots: number, intaking: boolean): RequestRecord[] => {
  const picked: RequestRecord[] = [];
  for (const request of queue) {
    if (picked.length >= slots) break;
    if (atIntake(request) && intaking) continue;
    picked.push(request);
    intaking ||= atIntake(request);
  }
  return picked;
};

/** `startedAt` is the attempt's start, in ms; for a run an earlier worker started, the ledger's. */
const settle = (requests: Requests, home: string, id: string, exitCode: number | null, startedAt?: number): void => {
  const request = requests.get(id);
  // The workflow records how its run ended; only a run that died without saying so is settled here.
  if (request?.state !== "building") return;
  const since = startedAt ?? Date.parse(requests.ledger(id).findLast((e) => e.event === "started")?.at ?? "");
  // A run killed before its attempt ended has the attempt before's output still, not its own.
  const why = runOutput(home, id, since || 0)?.reason ?? (exitCode === null ? "the run was killed" : `awf exited ${exitCode}`);
  requests.update(id, () => ({ state: "failed", reason: `the run ended without a result: ${why}`, pid: undefined }));
};

export const runWorker = async (
  home: string,
  root: string,
  {
    pollMs = 2000,
    awf = awfCommand(),
    maxRunning,
    runTimeout = "3h",
    keepSignedIn,
    signInEveryMs,
    signInAgain,
  }: {
    pollMs?: number;
    awf?: string;
    /** Runs at once: the domain's, which the CLI decides. */
    maxRunning: number;
    /**
     * An attempt's whole budget, as awf takes it. Each turn has its own timeout and revise rounds
     * are capped, so this only stops a run that hangs; a build that explores, writes and revises runs past an hour.
     */
    runTimeout?: string;
    /** Open the app signed in as a context, every `signInEveryMs`, for an app that signs out an idle session; true when it is signed in. */
    keepSignedIn?: (context: string) => Promise<boolean>;
    /** How often the contexts of running requests are kept signed in; unset, they aren't. */
    signInEveryMs?: number;
    /** Sign in again as a context, for an app that can be signed in to without a person; true when it is signed in. */
    signInAgain?: (context: string) => Promise<boolean>;
  },
): Promise<void> => {
  const requests = new Requests(home);
  if (!claimWorker(home, () => process.pid)) return;

  const running = new Map<string, Bun.Subprocess>();
  const start = (request: RequestRecord): void => {
    const args = awfArgs(home, root, request, runTimeout);
    // Recorded before awf starts, so nothing the run records itself (its stage, its end) is
    // overwritten. A redo keeps saying so until its first stage starts; its old stage goes meanwhile.
    const startedAt = Date.now();
    const started = requests.update(
      request.id,
      (r) => ({
        state: "building",
        attempts: r.attempts + 1,
        waitingFor: undefined,
        ...(request.redo && { redo: true, stage: undefined }),
      }),
      "started",
    );
    // Cancelled since the queue was read: its update was dropped, and there is nothing to run.
    if (started.state !== "building") return;
    let child: Bun.Subprocess;
    try {
      child = Bun.spawn([awf, ...args], {
        cwd: root,
        stdio: ["ignore", "inherit", "inherit"],
        env: awfEnv(home, root),
        onExit: (_, code) => {
          running.delete(request.id);
          settle(requests, home, request.id, code, startedAt);
          // A run that blocked or waits on a lock ends with its pid still on the request, where a
          // process that reuses it later would pass for this run, to the queue and to a cancel.
          if (requests.get(request.id)?.pid === child.pid) {
            requests.update(request.id, (r) => (r.pid === child.pid ? { pid: undefined } : {}), "exited", { evenIfCancelled: true });
          }
        },
      });
    } catch (err) {
      requests.update(request.id, () => ({ state: "failed", reason: `could not start awf: ${(err as Error).message}` }));
      return;
    }
    running.set(request.id, child);
    // Only the pid, and only while this attempt hasn't ended: a fast run may have recorded its end already.
    requests.update(request.id, (r) => (r.attempts === started.attempts && !isTerminal(r.state) ? { pid: child.pid } : {}), "pid");
    console.error(`${new Date().toISOString()} ${request.id}: awf ${args.join(" ")}`);
  };

  const queue = (all: RequestRecord[]): RequestRecord[] =>
    all
      .filter((r) => r.state === "received")
      .reverse()
      // A request that blocked or waits on a lock keeps the pid of its awf until that has closed its agents and exited.
      .filter((r) => !running.has(r.id) && !alive(r.pid) && ready(all, r))
      // A run that completed (deferred, flaky) takes another attempt only to redo a stage: from the first.
      .map((r) => (!r.redo && runOutput(home, r.id)?.outcome === "completed" ? { ...r, redo: true } : r));

  // Agents can go longer than an app's idle timeout without touching it (writing code, reviewing),
  // so the worker keeps each running request's context signed in; and a request blocked on signing
  // in gets one try at it per attempt. One at a time, in the background.
  let signingIn: Promise<void> | undefined;
  let touchedAt = Date.now();
  const tried = new Set<string>();
  const signIn = (all: RequestRecord[]): void => {
    if (signingIn) return;
    const touch = new Set<string>();
    const again = new Set<string>();
    const building = all.filter((r) => r.state === "building");
    if (keepSignedIn && signInEveryMs && building.length > 0 && Date.now() - touchedAt >= signInEveryMs) {
      touchedAt = Date.now();
      for (const r of building) touch.add(r.context);
    }
    if (signInAgain) {
      for (const r of all.filter((b) => b.state === "blocked" && isSignInQuestion(b.question) && !tried.has(`${b.id}/${b.attempts}`))) {
        tried.add(`${r.id}/${r.attempts}`);
        again.add(r.context);
      }
    }
    if (touch.size === 0 && again.size === 0) return;
    signingIn = (async () => {
      for (const context of touch) if (await keepSignedIn!(context).catch(() => false)) requests.signedIn(context);
      for (const context of again) if (!touch.has(context) && (await signInAgain!(context).catch(() => false))) requests.signedIn(context);
    })()
      // A lock that stays taken must not end the worker, which nothing awaits this for.
      .catch((err) => console.error(`${new Date().toISOString()} signing in: ${(err as Error).message}`))
      .finally(() => (signingIn = undefined));
  };

  for (;;) {
    const all = requests.list();
    signIn(all);
    const building = all.filter((r) => r.state === "building");
    // A run started by an earlier worker that died: settled once it ends, and counted until then.
    for (const r of building) if (!running.has(r.id) && !alive(r.pid)) settle(requests, home, r.id, null);
    const going = building.filter((r) => running.has(r.id) || alive(r.pid));
    const orphans = going.filter((r) => !running.has(r.id)).length;
    for (const request of pick(queue(all), maxRunning - running.size - orphans, going.some(atIntake))) start(request);
    if (running.size === 0 && orphans === 0 && !signingIn) {
      // Exit only under the lock, after a last look: a request filed meanwhile found this worker
      // alive and started none, so it must not be left behind.
      const done = withLock(join(home, "worker.lock"), () => {
        if (queue(requests.list()).length > 0) return false;
        writeJson(join(home, "worker.json"), {});
        return true;
      });
      if (done) return;
    }
    // Even after a last look that found work: what can't start (no slot, a lock) must not be looked at in a spin.
    await Bun.sleep(pollMs);
  }
};

/** A request is ready unless it waits on another that still holds its op. */
const ready = (all: RequestRecord[], request: RequestRecord): boolean => {
  const holder = request.waitingFor && all.find((r) => r.id === request.waitingFor);
  return !holder || isTerminal(holder.state);
};
