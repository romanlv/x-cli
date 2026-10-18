// Small file-system pieces every part of the tool's state uses: atomic writes, JSON lines and a lock
// that several processes (the CLI, the worker, a workflow) can share.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
};

/** Write through a temp file and rename, so a reader never sees half a file. */
export const writeJson = (file: string, value: unknown): void => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
};

export const appendJsonLine = (file: string, value: unknown): void => {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(value)}\n`);
};

export const readJsonLines = <T>(file: string): T[] => {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
};

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** A lock held longer than this belonged to a process that died holding it. */
const LOCK_STALE_MS = 10_000;
/** How long to wait for a lock before giving up. */
const LOCK_WAIT_MS = 15_000;

/**
 * Run `fn` holding a lock directory. `mkdir` is atomic, so two processes never both hold it; a stale
 * lock is taken over.
 */
export const withLock = <T>(dir: string, fn: () => T): T => {
  mkdirSync(dirname(dir), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(dir).mtimeMs > LOCK_STALE_MS) rmSync(dir, { recursive: true, force: true });
      } catch {
        // Released between the mkdir and the stat: try again.
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`timed out waiting for lock ${dir}`);
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Is a process with this pid alive? */
export const alive = (pid: number | undefined): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const timestamp = (): string => new Date().toISOString();
