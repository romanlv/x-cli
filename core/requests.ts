// The request ledger: every change the tool is asked to make to itself, whatever becomes of it.
// `ledger.jsonl` has one line per event, `R-0012.json` the request as it is now. The CLI, the worker
// and the workflows all read and write it, so every change happens under one lock.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Domain } from "./domain";
import { PreconditionError } from "./errors";
import { opFolder } from "./names";
import { appendJsonLine, readJson, readJsonLines, timestamp, withLock, writeJson } from "./store";

export type RequestKind = "intake" | "new" | "change" | "repair";
export type RequestState = "received" | "building" | "done" | "failed" | "blocked" | "deferred" | "declined" | "duplicate" | "cancelled";

const TERMINAL: readonly RequestState[] = ["done", "failed", "deferred", "declined", "duplicate", "cancelled"];
export const isTerminal = (state: RequestState): boolean => TERMINAL.includes(state);
/** The states `request:retry` puts back in the queue. */
export const RETRYABLE: readonly RequestState[] = ["failed", "deferred", "cancelled"];

/** The question a run blocks on when its context is signed out; signing in answers it. */
export const signInQuestion = (cli: string, context: string): string => `sign in again: ${cli} context:login ${context}`;
export const isSignInQuestion = (question: string | undefined): boolean => !!question?.startsWith("sign in again: ");

/** How a repair that couldn't reproduce its failure ends; such a repair found the op working. */
export const flakyReason = (why: string): string => `flaky: ${why}`;
const isFlaky = (r: RequestRecord): boolean => !!r.reason?.startsWith("flaky: ");

/** Where the tool lives, so a workflow started for a request knows what to build and how to call it. */
export type DomainRef = Pick<Domain, "name" | "root" | "dir" | "home">;

export interface RequestRecord {
  id: string;
  kind: RequestKind;
  /** What was asked, in the asker's words; for a repair, what failed. */
  text: string;
  /** The op it is about, once known: from the call, or as intake names it. */
  op?: string;
  context: string;
  domain: DomainRef;
  /** The call that filed it, re-run once the request is done when the caller waits. */
  call?: { op: string; argv: string[] };
  state: RequestState;
  /** The workflow stage it is in, or the one it stopped at; the workflow clears it when it ends the request. */
  stage?: string;
  createdAt: string;
  updatedAt: string;
  /** The one question a blocked request waits on. */
  question?: string;
  answers: { at: string; question?: string; text: string }[];
  /** Why it ended other than done: failed, deferred, declined. */
  reason?: string;
  /** `of` is the open request a duplicate is the same as. */
  result?: { summary: string; command?: string; commit?: string; of?: string };
  /** For a repair: the failure that filed it. */
  failure?: { step?: string; error: string; bundle: string; fellBack?: boolean };
  /** Later calls that failed the same way while this repair was open. */
  joined?: { at: string; bundle: string }[];
  /** Another request holds the lock on this op; this one waits for it. */
  waitingFor?: string;
  /**
   * The next attempt starts again from the first agent stage instead of continuing from the one
   * that stopped, and awf must be told so on every attempt until that stage starts again. Set by
   * the worker for a run that completed (deferred, a flaky repair), and wherever the worktree
   * went: a cancel, a lock wait with nothing built.
   */
  redo?: boolean;
  /** How many times the worker has started a run for it. */
  attempts: number;
  /** The awf process of the current attempt. */
  pid?: number;
}

export interface FileInput {
  kind: RequestKind;
  text: string;
  op?: string;
  context: string;
  domain: DomainRef;
  call?: RequestRecord["call"];
  failure?: RequestRecord["failure"];
}

export const REQUEST_ID = /^R-\d{4,}$/;

/** A blocked request's question answered: it goes back in the queue. */
const answered = (r: RequestRecord, text: string): Partial<RequestRecord> => ({
  state: "received",
  answers: [...r.answers, { at: timestamp(), question: r.question, text }],
  question: undefined,
});

export class Requests {
  constructor(readonly home: string) {}

  get dir(): string {
    return join(this.home, "requests");
  }

  private get lockDir(): string {
    return join(this.dir, ".lock");
  }

  private fileOf(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private event(id: string, event: string, fields: Record<string, unknown> = {}): void {
    appendJsonLine(join(this.dir, "ledger.jsonl"), { at: timestamp(), id, event, ...fields });
  }

  file(input: FileInput): RequestRecord {
    return withLock(this.lockDir, () => this.fileLocked(input));
  }

  private fileLocked(input: FileInput): RequestRecord {
    const counter = readJson<{ next: number }>(join(this.dir, "counter.json"), { next: 1 });
    const id = `R-${String(counter.next).padStart(4, "0")}`;
    writeJson(join(this.dir, "counter.json"), { next: counter.next + 1 });
    const now = timestamp();
    const record: RequestRecord = { id, ...input, state: "received", createdAt: now, updatedAt: now, answers: [], attempts: 0 };
    writeJson(this.fileOf(id), record);
    this.event(id, "received", { kind: input.kind, op: input.op, context: input.context, text: input.text });
    return record;
  }

  /**
   * File a repair, or join the open one for the same op and step and way (direct or browser), in one
   * step under the lock, so two calls failing the same way at once file one repair between them.
   */
  fileOrJoinRepair(input: FileInput & { op: string; failure: NonNullable<RequestRecord["failure"]> }): {
    record: RequestRecord;
    joined: boolean;
  } {
    return withLock(this.lockDir, () => {
      const open = this.openRepair(input.op, input.failure.step, input.failure.fellBack === true);
      if (!open) return { record: this.fileLocked(input), joined: false };
      const record: RequestRecord = {
        ...open,
        joined: [...(open.joined ?? []), { at: timestamp(), bundle: input.failure.bundle }],
        updatedAt: timestamp(),
      };
      writeJson(this.fileOf(open.id), record);
      this.event(open.id, "joined", { bundle: input.failure.bundle });
      return { record, joined: true };
    });
  }

  get(id: string): RequestRecord | undefined {
    if (!REQUEST_ID.test(id)) return undefined;
    return readJson<RequestRecord | undefined>(this.fileOf(id), undefined);
  }

  /** Newest first. */
  list(filter: { state?: RequestState; op?: string } = {}): RequestRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .flatMap((name) => (name.endsWith(".json") ? (this.get(name.slice(0, -".json".length)) ?? []) : []))
      .filter((r) => (!filter.state || r.state === filter.state) && (!filter.op || r.op === filter.op))
      .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  }

  /**
   * Apply a change under the lock and log it; `event` names it in the ledger. A cancelled request's
   * run may still be stopping, so what it records on the way out is dropped: only a change made
   * `evenIfCancelled` (a cancel, a retry) applies to one.
   */
  update(
    id: string,
    change: (r: RequestRecord) => Partial<RequestRecord>,
    event?: string,
    { evenIfCancelled = false }: { evenIfCancelled?: boolean } = {},
  ): RequestRecord {
    return withLock(this.lockDir, () => this.updateLocked(id, change, event, evenIfCancelled));
  }

  private updateLocked(
    id: string,
    change: (r: RequestRecord) => Partial<RequestRecord>,
    event?: string,
    evenIfCancelled = false,
  ): RequestRecord {
    const current = this.get(id);
    if (!current) throw new Error(`no request ${id}`);
    if (current.state === "cancelled" && !evenIfCancelled) return current;
    const patch = change(current);
    const next: RequestRecord = { ...current, ...patch, updatedAt: timestamp() };
    writeJson(this.fileOf(id), next);
    const logged: Record<string, unknown> = {};
    for (const key of ["state", "stage", "op", "question", "reason", "result", "waitingFor"] as const) {
      if (key in patch) logged[key] = patch[key];
    }
    this.event(id, event ?? (patch.state && patch.state !== current.state ? patch.state : "updated"), logged);
    return next;
  }

  ledger(id?: string): { at: string; id: string; event: string; [k: string]: unknown }[] {
    const events = readJsonLines<{ at: string; id: string; event: string }>(join(this.dir, "ledger.jsonl"));
    return id ? events.filter((e) => e.id === id) : events;
  }

  /** The open repair for this op, step and way, which a call failing the same way joins. */
  private openRepair(op: string, step: string | undefined, fellBack: boolean): RequestRecord | undefined {
    return this.list({ op }).find(
      (r) => r.kind === "repair" && !isTerminal(r.state) && r.failure?.step === step && (r.failure?.fellBack === true) === fellBack,
    );
  }

  /**
   * A repair that ended failed, which marks the op broken until it is retried or a later request on
   * the op is done; with `direct`, one of its direct way (filed when the op fell back to the browser),
   * which the op then skips. A flaky repair never marks it.
   */
  brokenBy(op: string, direct = false): RequestRecord | undefined {
    const all = this.list({ op });
    const latest = all.find((r) => r.kind === "repair" && (r.failure?.fellBack === true) === direct);
    // A build, change or repair done on the op since may have fixed it: verify ran it before it merged.
    if (latest?.state !== "failed" || isFlaky(latest)) return undefined;
    return all.some((r) => r.state === "done" && r.updatedAt >= latest.updatedAt) ? undefined : latest;
  }

  /** Take the lock on an op for a request; returns the holder when another request has it. */
  lockOp(op: string, id: string): string | undefined {
    return withLock(this.opLocks, () => {
      const holder = readJson<{ id?: string }>(this.opLock(op), {}).id;
      if (holder && holder !== id) {
        const held = this.get(holder);
        if (held && !isTerminal(held.state)) return holder;
      }
      writeJson(this.opLock(op), { id, at: timestamp() });
      return undefined;
    });
  }

  unlockOp(op: string, id: string): void {
    withLock(this.opLocks, () => {
      if (readJson<{ id?: string }>(this.opLock(op), {}).id === id) writeJson(this.opLock(op), {});
    });
  }

  private get opLocks(): string {
    return join(this.home, "locks", ".lock");
  }

  private opLock(op: string): string {
    return join(this.home, "locks", `${opFolder(op)}.json`);
  }

  answer(id: string, text: string): RequestRecord {
    return this.update(
      id,
      (r) => {
        if (r.state !== "blocked") throw new PreconditionError(`${id} is ${r.state}, not blocked: there is no question to answer`);
        return answered(r, text);
      },
      "answered",
    );
  }

  /**
   * Continue every request blocked on signing in to `context`; returns their ids. Read and answered
   * under one lock, so one that a person, a cancel or another sign-in moved on meanwhile is left as it is.
   */
  signedIn(context: string): string[] {
    return withLock(this.lockDir, () =>
      this.list({ state: "blocked" })
        .filter((r) => r.context === context && isSignInQuestion(r.question))
        .map((r) => this.updateLocked(r.id, (current) => answered(current, "signed in again"), "answered").id),
    );
  }

  cancel(id: string, reason: string): RequestRecord {
    return this.update(
      id,
      (r) => {
        if (isTerminal(r.state)) throw new PreconditionError(`${id} is ${r.state} already`);
        // Its worktree goes with it, so a retry starts it again from its first stage.
        return { state: "cancelled", reason, waitingFor: undefined, question: undefined, redo: true };
      },
      "cancelled",
      { evenIfCancelled: true },
    );
  }

  retry(id: string): RequestRecord {
    return this.update(
      id,
      (r) => {
        if (!RETRYABLE.includes(r.state))
          throw new PreconditionError(`${id} is ${r.state}; only failed, deferred and cancelled requests are retried`);
        return { state: "received", reason: undefined, waitingFor: undefined };
      },
      "retried",
      { evenIfCancelled: true },
    );
  }
}
