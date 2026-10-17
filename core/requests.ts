// The request ledger: every change the tool is asked to make to itself, whatever becomes of it.
// `ledger.jsonl` has one line per event, `R-0012.json` the request as it is now. The CLI, the worker
// and the workflows all read and write it, so every change happens under one lock.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { raise } from "./errors";
import { EXIT } from "./output";
import { appendJsonLine, readJson, readJsonLines, timestamp, withLock, writeJson } from "./store";

export type RequestKind = "intake" | "new" | "change" | "repair";
export type RequestState = "received" | "building" | "done" | "failed" | "blocked" | "deferred" | "declined" | "duplicate" | "cancelled";

export const TERMINAL: readonly RequestState[] = ["done", "failed", "deferred", "declined", "duplicate", "cancelled"];
export const isTerminal = (state: RequestState): boolean => TERMINAL.includes(state);

/** The question a run blocks on when its context is signed out; signing in answers it. */
export const signInQuestion = (cli: string, context: string): string => `sign in again: ${cli} context:login ${context}`;
export const isSignInQuestion = (question: string | undefined): boolean => !!question?.startsWith("sign in again: ");

/** Where the tool lives, so a workflow started for a request knows what to build and how to call it. */
export interface DomainRef {
  name: string;
  root: string;
  dir: string;
  home: string;
}

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
  /** The workflow stage it is in, while building. */
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
   * A retry of a run that completed (deferred, declined, flaky) asks for it to be redone from its
   * first agent stage, which awf must be told on every attempt until that stage starts again. Any
   * other retry continues from the stage that stopped.
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

const ID = /^R-\d{4,}$/;

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
   * File a repair, or join the open one for the same op and step, in one step under the lock, so two
   * calls failing the same way at once file one repair between them.
   */
  fileOrJoinRepair(input: FileInput & { op: string; failure: NonNullable<RequestRecord["failure"]> }): {
    record: RequestRecord;
    joined: boolean;
  } {
    return withLock(this.lockDir, () => {
      const open = this.openRepair(input.op, input.failure.step);
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
    if (!ID.test(id)) return undefined;
    return readJson<RequestRecord | undefined>(this.fileOf(id), undefined);
  }

  /** Newest first. */
  list(filter: { state?: RequestState; op?: string } = {}): RequestRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((name) => /^R-\d+\.json$/.test(name));
    } catch {
      return [];
    }
    return names
      .map((name) => readJson<RequestRecord>(join(this.dir, name), undefined as never))
      .filter((r) => r && (!filter.state || r.state === filter.state) && (!filter.op || r.op === filter.op))
      .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  }

  /** Apply a change under the lock and log it; `event` names it in the ledger. */
  update(id: string, change: (r: RequestRecord) => Partial<RequestRecord>, event?: string): RequestRecord {
    return withLock(this.lockDir, () => {
      const current = this.get(id);
      if (!current) throw new Error(`no request ${id}`);
      // A cancelled request's run may still be stopping: what it records on the way out is dropped.
      if (current.state === "cancelled" && event !== "retried" && event !== "cancelled") return current;
      const patch = change(current);
      const next: RequestRecord = { ...current, ...patch, updatedAt: timestamp() };
      writeJson(this.fileOf(id), next);
      const logged: Record<string, unknown> = {};
      for (const key of ["state", "stage", "op", "question", "reason", "result", "waitingFor"] as const) {
        if (key in patch) logged[key] = patch[key];
      }
      this.event(id, event ?? (patch.state && patch.state !== current.state ? patch.state : "updated"), logged);
      return next;
    });
  }

  ledger(id?: string): { at: string; id: string; event: string; [k: string]: unknown }[] {
    const events = readJsonLines<{ at: string; id: string; event: string }>(join(this.dir, "ledger.jsonl"));
    return id ? events.filter((e) => e.id === id) : events;
  }

  /** The open repair for this op and step, which a call failing the same way joins. */
  openRepair(op: string, step: string | undefined): RequestRecord | undefined {
    return this.list({ op }).find((r) => r.kind === "repair" && !isTerminal(r.state) && r.failure?.step === step);
  }

  /**
   * A repair that ended failed and hasn't been retried, which marks the op broken; with `direct`,
   * its direct way, which the op then skips.
   */
  brokenBy(op: string, direct = false): RequestRecord | undefined {
    const latest = this.list({ op }).find((r) => r.kind === "repair" && !r.failure?.fellBack === !direct);
    return latest?.state === "failed" ? latest : undefined;
  }

  /** Take the lock on an op for a request; returns the holder when another request has it. */
  lockOp(op: string, id: string): string | undefined {
    const file = join(this.home, "locks", `${op.replace(":", "-")}.json`);
    return withLock(join(this.home, "locks", ".lock"), () => {
      const holder = readJson<{ id?: string }>(file, {}).id;
      if (holder && holder !== id) {
        const held = this.get(holder);
        if (held && !isTerminal(held.state)) return holder;
      }
      writeJson(file, { id, at: timestamp() });
      return undefined;
    });
  }

  unlockOp(op: string, id: string): void {
    const file = join(this.home, "locks", `${op.replace(":", "-")}.json`);
    withLock(join(this.home, "locks", ".lock"), () => {
      if (readJson<{ id?: string }>(file, {}).id === id) writeJson(file, {});
    });
  }

  answer(id: string, text: string): RequestRecord {
    return this.update(
      id,
      (r) => {
        if (r.state !== "blocked") raise(`${id} is ${r.state}, not blocked: there is no question to answer`, EXIT.PRECONDITION);
        return {
          state: "received",
          answers: [...r.answers, { at: timestamp(), question: r.question, text }],
          question: undefined,
        };
      },
      "answered",
    );
  }

  /** Continue every request blocked on signing in to `context`; returns their ids. */
  signedIn(cli: string, context: string): string[] {
    const question = signInQuestion(cli, context);
    return this.list({ state: "blocked" })
      .filter((r) => r.context === context && r.question === question)
      .map((r) => this.answer(r.id, "signed in again").id);
  }

  cancel(id: string, reason: string): RequestRecord {
    return this.update(
      id,
      (r) => {
        if (isTerminal(r.state)) raise(`${id} is ${r.state} already`, EXIT.PRECONDITION);
        return { state: "cancelled", reason, waitingFor: undefined, question: undefined };
      },
      "cancelled",
    );
  }

  retry(id: string, { redo = false }: { redo?: boolean } = {}): RequestRecord {
    return this.update(
      id,
      (r) => {
        if (r.state !== "failed" && r.state !== "deferred" && r.state !== "cancelled")
          raise(`${id} is ${r.state}; only failed, deferred and cancelled requests are retried`, EXIT.PRECONDITION);
        // A cancelled request's worktree is gone, so it starts again from its first stage.
        return { state: "received", reason: undefined, waitingFor: undefined, redo: redo || r.state === "cancelled" || undefined };
      },
      "retried",
    );
  }
}
