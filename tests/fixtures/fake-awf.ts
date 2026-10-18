#!/usr/bin/env bun
// Stands in for awf under the worker: records how it was called, then ends the request the way
// FAKE_AWF says — "done", "crash" (dies without a word, as a killed run does), "slow" or "block"
// (asks a question and exits, as a run does once it has closed its agents).
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { envValue } from "../../core/env";
import { Requests } from "../../core/requests";

const args = process.argv.slice(2);
const home = envValue("HOME")!;
const id = args.includes("--continue") ? args[args.indexOf("--continue") + 1]! : args.at(-1)!;
appendFileSync(join(home, "awf-calls.jsonl"), `${JSON.stringify({ id, args, at: Date.now() })}\n`);
const mode = process.env.FAKE_AWF ?? "done";
if (mode === "slow") await Bun.sleep(400);
if (mode === "crash") process.exit(1);
if (mode === "block") new Requests(home).update(id, () => ({ state: "blocked", question: "which one?" }));
else new Requests(home).update(id, () => ({ state: "done", result: { summary: "built" } }));
