// Failures that are not the op's fault. Triage files a repair for anything else an op throws, so
// helpers throw these when they know better: a value the app doesn't offer is bad input, not a bug.
import { EXIT, type NextHint } from "./output";

export class OpError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly next?: NextHint[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The caller asked for something that can't be: a value the app doesn't offer. Exit 2. */
export class InputError extends OpError {
  constructor(message: string, next?: NextHint[]) {
    super(message, EXIT.USAGE, next);
  }
}

/** Something the call needs isn't there: a record, a sign-in. Exit 3. */
export class PreconditionError extends OpError {
  constructor(message: string, next?: NextHint[]) {
    super(message, EXIT.PRECONDITION, next);
  }
}

/** The app said no: a validation message, a missing permission. Exit 4. */
export class RefusedError extends OpError {
  constructor(message: string, next?: NextHint[]) {
    super(message, EXIT.REFUSED, next);
  }
}

/** The browser itself failed: it would not start, or it crashed. Exit 1, and no repair. */
export class BrowserError extends OpError {
  constructor(message: string) {
    super(message, EXIT.ERROR);
  }
}

/** Thrown by a helper at the last submit of a `--dry-run`; the runner turns it into a result. */
export class DryRunReached extends Error {
  constructor(readonly action: string) {
    super(`dry run: stopped before ${action}`);
    this.name = "DryRunReached";
  }
}

const BROWSER_GONE = /Target (page, context or browser )?(has been )?closed|Browser has been closed|browserType\.launch|crashed/i;

/** Did the browser die under the op, rather than the op do something wrong? */
export const isBrowserFailure = (err: unknown): boolean =>
  err instanceof BrowserError || (err instanceof Error && BROWSER_GONE.test(err.message));
