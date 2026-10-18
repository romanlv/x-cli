// Everything the workflows tell an agent: each agent's instructions, each stage's prompt, and the
// problems a round hands back. The workflows decide when; this decides what. docs/prompts.md shows
// them all filled in (`bun run docs:prompts`).
//
// Text a prompt didn't write itself (the person's words, a plan, an error, an output) goes in an
// XML-style tag, so an agent can tell it from the instructions; short facts are labelled lines.
//
// What holds for every op is authoring.md beside this file; what holds for one domain is that domain's
// authoring.md, and what its app and each context are like is its knowledge/. The instructions send
// agents to read them.
import { join } from "node:path";
import { commandLine } from "../output";
import { type RequestRecord, signInQuestion } from "../requests";
import { type CheckScope, opDirIn, SCRIPTS, type Verified } from "../workflows/deps";
import type { Finding, Paths } from "../workflows/shared";

/** What a prompt reads: the request, and where its run works. A RequestRun is one. */
interface PromptRun {
  readonly request: RequestRecord;
  readonly paths: Paths;
}

/** A prompt written inline: the template's own indentation is removed, interpolations kept. */
function md(strings: TemplateStringsArray, ...values: unknown[]): string {
  const indents = strings
    .join("")
    .split("\n")
    .slice(1)
    .filter((line) => line.trim() !== "")
    .map((line) => line.length - line.trimStart().length);
  const indent = new RegExp(`\n[ \\t]{0,${Math.min(...indents, Number.POSITIVE_INFINITY)}}`, "g");
  return strings
    .map((part, i) => part.replace(indent, "\n") + (i < values.length ? String(values[i]) : ""))
    .join("")
    .trim();
}

const opDir = ({ paths }: PromptRun, op: string): string => opDirIn(paths.domainDir, op);

/** The rules for writing any op, beside this file in the worktree's core. */
const coreAuthoring = (paths: Paths): string => join(paths.worktree, "core", "instructions", "authoring.md");

// ── Pieces ────────────────────────────────────────────────────────────────────────────────────────
/** Text the prompt didn't write (a person's words, a plan, an error, an output), set apart from the instructions. */
const tag = (name: string, body: string, attrs: Record<string, string> = {}): string => {
  const attributes = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("");
  return `<${name}${attributes}>\n${body}\n</${name}>`;
};

/**
 * What the person answered so far, for a prompt that may be reading it for the first time. `readOnly`
 * for a turn that shouldn't write them down, which follows the answers only: review's and the final
 * question's, which change no files, and polish's and rebase's, which change only what they ask for.
 */
const answers = (request: RequestRecord, readOnly = false): string => {
  if (!request.answers.length) return "";
  return [
    "",
    "",
    readOnly
      ? "A person answered questions this request asked earlier. Follow the answers."
      : "A person answered questions this request asked earlier. Follow the answers, and write each into the level of knowledge it belongs to (the op's notes.md, knowledge/*.md, or the context's file) so it is not asked again.",
    tag("answers", request.answers.map((a) => `- Q: ${a.question ?? "(none)"}\n  A: ${a.text}`).join("\n")),
  ].join("\n");
};

/** The request as asked, and the call that filed it. */
const asked = (request: RequestRecord, attrs: Record<string, string>): string =>
  [tag("request", request.text, attrs), ...(request.call ? [tag("call", commandLine(request.domain.name, request.call.argv))] : [])].join(
    "\n",
  );

/** Everything an agent needs about the request, whether or not it saw an earlier stage. */
const brief = (run: PromptRun, op: string, summary: string): string => {
  const { request, paths } = run;
  return [
    asked(request, { id: request.id, kind: request.kind, context: request.context }),
    tag("intent", summary),
    `The op: ${op}, in ${opDir(run, op)} (spec.md, notes.md, op.ts, examples.json).`,
    `The builder's exploring trace: ${paths.trace}`,
  ].join("\n");
};

/** How a builder finishes writing or patching an op: try it as a caller would, then the fast checks. */
const runAndCheck = ({ request, paths }: PromptRun, op: string): string => md`
  Then try it as a caller would, \`${paths.cli} ${op} ... --context ${request.context}\`, and fix what doesn't hold, until all of it does:
  - Each example: its output is what spec.md says, read from ${request.domain.name}: check it in the app, as spec.md says done looks like.
  - An op that saves: \`--dry-run\` first, then for real.
  - An op with a direct way: each example with \`--browser\` too, and the two outputs match.
  - A bad input, such as a value the app doesn't offer in this context: exit 2, with a message that says what is valid.
  - Run \`${paths.run(`bun run ${paths.sandbox ? SCRIPTS.sandbox : SCRIPTS.fast}`)}\`; \`${paths.run(`bun run ${SCRIPTS.fix}`)}\` formats and fixes what it safely can, and the full \`${SCRIPTS.full}\` runs before approval. A helper you change must keep the repository's tests passing.
  - Answer done with what you ran and what it printed.
`;

/** What agents that drive the app may change in it, as the domain says. */
const testData = ({ paths }: PromptRun): string =>
  `Change in the app only what ${paths.domainDir}/authoring.md, under "Test data", allows. Page commands have no dry run: stop before a step that would change anything else. An op's saving step can be tried with --dry-run.`;

// ── Instructions ──────────────────────────────────────────────────────────────────────────────────
/** Where the planner and the builders work, and what they read first. */
const workspace = ({ request, paths }: PromptRun, role: string): string => md`
  You ${role} ops for \`${request.domain.name}\`, a CLI that runs ${request.domain.name} tasks by driving a real browser. Each op is a folder of plain files under ${paths.domainDir}/ops/ that people read and the CLI runs as code, with no model in the loop.

  You work on request ${request.id}, on branch ${paths.branch}, in the git worktree ${paths.worktree}.
  - Change files only there; never touch ${request.domain.root}.
  - Leave your changes uncommitted: the workflow commits them once they are verified and reviewed.
  - When only a person can settle something, answer with one specific question rather than guessing.

  Before anything else, read:
  - ${coreAuthoring(paths)}: how any op is written
  - ${paths.domainDir}/authoring.md: what is particular to ${request.domain.name}, which wins where the two differ, and which op is the reference
  - ${paths.domainDir}/knowledge/${request.domain.name}.md
  - ${paths.domainDir}/knowledge/contexts/${request.context}.md, what is particular to this context (the account or tenant it signs in as), if it exists
`;

export const plannerInstructions = (run: PromptRun): string => md`
  ${workspace(run, "plan")}

  Rules:
  - You decide what gets built and say what the person wants; the builder then surveys the app for it, and you write the spec from what it found. Don't open a browser or run the CLI.
  - Don't read other requests' records in ${join(run.request.domain.home, "requests")}: each prompt says what you need about them. The files a prompt names, such as the builder's trace, are yours to read.
`;

/** The builder's and the troubleshooter's. */
export const builderInstructions = (run: PromptRun): string => {
  const { request, paths } = run;
  return md`
    ${workspace(run, "build and repair")}

    Rules:
    - Drive the app only through the CLI, as \`${paths.cli} <command>\`, adding \`--session ${paths.session} --context ${request.context}\` to every page command. \`${paths.cli} help\` lists them. Close nothing you didn't open.
    - Never sign in and never type credentials. If the session is signed out, answer with the question "${signInQuestion(request.domain.name, request.context)}".
    - ${testData(run)}
    - What one screen taught you goes in the op's notes.md; what holds for every op goes in knowledge/${request.domain.name}.md too; a move two ops need becomes a helper.
    - The direct-calls skill is ${join(paths.worktree, ".claude", "skills", "direct-calls", "SKILL.md")}; read it when a prompt names it.
  `;
};

export const checkerInstructions = (run: PromptRun): string => {
  const { request, paths } = run;
  return md`
    You check a change to \`${request.domain.name}\`, a CLI that runs ${request.domain.name} tasks in a browser, made for request ${request.id} in ${paths.worktree}. You report; you don't fix, and you change no files.

    Rules:
    - Use the CLI as \`${paths.cli}\`, with \`--session ${paths.session}-check --context ${request.context}\` on every page command: your own browser session, not the builder's.
    - Never sign in.
    - ${testData(run)}
  `;
};

/** Sent in the same turn after an agent asked to be signed in and the run did it. */
export const signedInAgain = (request: RequestRecord): string => md`
  Context "${request.context}" is signed in again. Close each page session you had open with \`page:close\`, so the next page command opens with the new sign-in, then go on where you stopped and answer as asked before.
`;

// ── Build: the planner, then the builder ──────────────────────────────────────────────────────────
/**
 * `others` are the open requests this one may turn out to be the same as; `exists` is whether the
 * op the request names is on main now, which a request that waited may find another one built.
 */
export const intake = ({ request, paths }: PromptRun, others: RequestRecord[], exists: boolean): string => {
  const facts = [
    ...(request.call ? ["The call shows the inputs the asker expects."] : []),
    ...(request.op
      ? [
          `It names the op ${request.op}, which ${!exists ? "does not exist yet" : request.kind === "change" ? "exists: this is a change to it" : "exists now: another request may have built it since this one was filed"}.`,
        ]
      : []),
  ];
  const open = others.length
    ? `\n\nOther requests are open, and one may already be building this:\n${tag("open-requests", others.map((r) => `- ${r.id} (${r.state}${r.op ? `, ${r.op}` : ""}): ${r.text}`).join("\n"))}`
    : "";
  const same = others.length
    ? "\n- same: one of the open requests above already asks for this; name it, and this one ends as its duplicate."
    : "";
  return md`
    ${[asked(request, { id: request.id, context: request.context }), ...facts].join("\n")}${open}

    Read it against the ops in ${paths.domainDir}/ops/ and the knowledge, then decide, without opening a browser:
    - build: name the op (noun:verb), an existing one to change or a new one, and give the intent: what the person wants and why, what they expect back, and what is unclear. Nobody has opened the app yet, so say nothing of its screens or what it can't do: the builder surveys it next.
    - duplicate: an op already does it; give the command that does.${same}
    - deferred: it needs something the tool can't get yet; say what.
    - declined: out of scope, unsafe, or too vague to act on; say why.${answers(request)}
  `;
};

export const explore = (run: PromptRun, op: string, summary: string, change: boolean): string => md`
  ${brief(run, op, summary)}

  Find how ${run.request.domain.name} serves the intent${change ? `, for the part that changes; ${opDir(run, op)}/spec.md says what the op does now` : ""}. Start where a page session opens (the context's start page), as the op will.
  - Survey the ways a person could do it in the app: its search, its pages and menus, filters; knowledge/ names this app's. For each, write in ${opDir(run, op)}/notes.md (append; never remove what an earlier build wrote) what it gives and what it lacks for the intent.
  - Pick the way that serves it best, and do the task once that way through the page commands, on test data. Write down every screen, label, prompt and wait that mattered. The trace records the locator each command used.
  - When the op finds records by a value the person gives, the way is the app's own search or filter for it, letting the app match. Reading every record to match in the op is a last resort, and notes.md says why each search doesn't serve.
  - If the op reads, find the calls behind it as the direct-calls skill says, and the tokens they need for a direct way, unless authoring.md rules out a direct way: then the skill's layers 1 and 2 only.
  - If no way serves the intent, answer missing with what you tried. If the ways differ in what the person would get back (how a name matches, which records are left out), and the intent doesn't settle it, ask.
  - Otherwise answer done with the way you picked and why.${answers(run.request)}
`;

// After explore: the planner writes the contract from the intent and what the builder found.
export const spec = (run: PromptRun, op: string, summary: string, change: boolean, explored: string): string => md`
  ${brief(run, op, summary)}

  The builder surveyed ${run.request.domain.name} for it and answered:
  ${tag("explored", explored)}
  Its notes are in ${opDir(run, op)}/notes.md.

  ${change ? `Update ${opDir(run, op)}/spec.md for the change.` : `Write ${opDir(run, op)}/spec.md for the new op.`} It says:
  - what the person wants, as the intent says
  - which way in the app the op uses, and the others the builder found, each with why not
  - its inputs, each a flag, typed, with which values differ between contexts
  - its outputs, as the app gives them back
  - what done looks like in ${run.request.domain.name}, so someone can check it there
  Follow the shape of the spec.md of the reference op authoring.md names, once it names one. Say only what the notes show of the app. If another way the builder found serves the intent better, choose it in the spec and say why: the op is written to the spec.${answers(run.request)}
`;

export const write = (run: PromptRun, op: string, summary: string): string => {
  const { request, paths } = run;
  return md`
    ${brief(run, op, summary)}

    Write ${opDir(run, op)}/op.ts from the trace and ${opDir(run, op)}/notes.md, with both authoring.md files open, and the reference op authoring.md names, once it names one. If spec.md chose a way you didn't do the task through while exploring, do it that way once first, and write it in notes.md.
    - Use the helpers; add one to ${paths.domainDir}/helpers/ when a move holds for every screen and isn't there yet.
    - Name every step.
    - Write it to spec.md: its inputs, outputs and errors, and the way in the app it names.
    - Read the output back from ${request.domain.name}, never from the input.
    - If the op reads and notes.md has the calls behind it, give it a direct way beside \`run\`, as the direct-calls skill says, unless authoring.md rules it out.
    - Put inputs that work in context "${request.context}" in ${opDir(run, op)}/examples.json, as [{ "context": "${request.context}", "input": { ... } }], with test data as authoring.md says: one for each case spec.md tells apart, at least one. Verify runs them all.

    ${runAndCheck(run, op)}${answers(request)}
  `;
};

// ── Repair: the builder ───────────────────────────────────────────────────────────────────────────
type Failure = NonNullable<RequestRecord["failure"]>;

/** A repair's summary, standing in for intake's plan; the error itself is the request's text. */
export const repairSummary = (op: string, failure: Failure): string =>
  `a repair of ${op}, which failed${failure.step ? ` at the step "${failure.step}"` : ""}`;

export const diagnose = (run: PromptRun, op: string, failure: Failure): string => {
  const { request } = run;
  const onTestData =
    "on the failed input where that changes nothing in the app (a read); where a step would change one of its records, on test data shaped like it, as authoring.md says";
  const how = failure.fellBack
    ? `Its direct way failed and the browser way worked, so the bundle has no screenshot. Run the op without \`--browser\`, ${onTestData}, to see it fail; then do the task in the browser and compare the calls it makes now with those in notes.md, as the direct-calls skill says: a URL, a header, a token, a response's shape.`
    : `Reproduce the failure in your own browser session with the page commands, ${onTestData}, and find what changed: a label, a screen, a wait, an endpoint.`;
  const joined = request.joined?.length
    ? `\n${request.joined.length} later call(s) failed the same way; their bundles:\n${request.joined.map((j) => `- ${j.bundle}`).join("\n")}`
    : "";
  return md`
    ${brief(run, op, repairSummary(op, failure))}
    ${tag("failure", failure.error)}
    The failure bundle is ${failure.bundle}: error.json (the inputs and the page URL), screenshot.png and snapshot.txt at the moment it failed, network.txt, and history.jsonl, the op's last runs, which show whether it ever worked.${joined}

    - Read ${opDir(run, op)}/op.ts, spec.md and notes.md.
    - ${how} Even on test data, stop before a step that would save.
    - Write what changed in ${opDir(run, op)}/notes.md (append).
    - Answer reproduced with the diagnosis, or flaky if it works every time you try, with what you tried.${answers(request)}
  `;
};

export const patch = (run: PromptRun, op: string, failure: Failure, diagnosis: string): string => md`
  ${brief(run, op, repairSummary(op, failure))}
  ${tag("diagnosis", diagnosis)}

  - Make the smallest change that fixes it, to ${opDir(run, op)}/op.ts, or to a helper when the change holds for every screen.
  - Add an example to ${opDir(run, op)}/examples.json for context "${run.request.context}", with test data as authoring.md says, that goes through the step that failed, so verify covers the fix.

  ${runAndCheck(run, op)}${answers(run.request)}
`;

// ── Check: verify, review, revise ─────────────────────────────────────────────────────────────────
const describeVerify = (results: Verified[], context: string): string =>
  tag(
    "verify",
    results
      .map((v) =>
        v.problem
          ? `- ${v.op}: ${v.problem}`
          : v.noExamples
            ? `- ${v.op}: examples.json has no example for context "${context}"`
            : v.runs
                .map(
                  (r) =>
                    `- ${v.op} ${JSON.stringify(r.input)}${r.browser ? " --browser" : ""} → ${r.ok ? "ok" : `exit ${r.exitCode}: ${r.error ?? "no error"}`}`,
                )
                .join("\n"),
      )
      .join("\n"),
  );

/** What makes a review finding blocking or minor: the review prompt says it, and so does the answer's schema. */
export const SEVERITY = {
  blocking: "the op is wrong, unsafe, or breaks the spec, the authoring rules or another op; it needs another look",
  minor: "wording, a doc line, a name, style; the builder fixes it and nobody looks again",
} as const;

/** The checker's turn, once verify and the checks passed. */
export const review = (run: PromptRun, op: string, summary: string, verified: Verified[], said?: string): string => {
  const { request, paths } = run;
  const builder = said
    ? `\nThe builder's last answer, with what it says it ran; check it, don't take it on trust:\n${tag("builder", said)}`
    : "";
  return md`
    ${brief(run, op, summary)}

    The change is uncommitted in ${paths.worktree}: \`git diff $(git merge-base HEAD main)\` shows it against where the branch left main (not main, which may have moved on), and new files are untracked, so read each one \`git status --short\` lists as \`??\` whole.
    Verify ran it on every example for context "${request.context}" and it passed:
    ${describeVerify(verified, request.context)}${builder}

    1. Run it yourself on an input of your own, not one from examples.json, and find the result in ${request.domain.name} through the CLI's page commands: the record it made or changed, or what it read, shown in the app. Check it is what spec.md says done looks like.
    2. Read the change against the intent, spec.md, ${coreAuthoring(paths)}, ${paths.domainDir}/authoring.md and the reference op authoring.md names, once it names one. Look for:
       - an op that does what spec.md says but not what the intent asks
       - values copied from exploring that should be inputs or come from the context's knowledge file
       - logic that belongs in a helper, or the same move written out in two ops
       - steps without names
       - output echoed from input instead of read back
       - an example in examples.json that isn't test data as authoring.md defines it
       - an op that reads every record and matches them itself: look in the app yourself for a search or filter that would do it, even when spec.md or notes.md says there is none; blocking unless notes.md shows each way tried

    Each finding says where and what is wrong, and how severe it is:
    - blocking: ${SEVERITY.blocking}.
    - minor: ${SEVERITY.minor}.
    No findings approves it.${answers(request, true)}
  `;
};

// The problems a round hands to the next revise.
export const verifyFailed = (request: RequestRecord, results: Verified[]): string =>
  `Verify ran the ops on every example for context "${request.context}" and it failed:\n${describeVerify(results, request.context)}`;

/** In a sandbox the workflow and e2e tests can't run, so the agent reruns the rest and reads theirs from the output. */
export const checksFailed = ({ paths }: PromptRun, scope: CheckScope, output: string): string => {
  const rerun = paths.sandbox
    ? `; rerun them with \`${paths.run(`bun run ${SCRIPTS.sandbox}`)}\`, which leaves out the workflow and e2e tests: those can't run in your sandbox, so read their failures here`
    : "";
  return `The repository's checks (\`bun run ${SCRIPTS[scope]}\` in ${paths.worktree}) failed${rerun}:\n${tag("output", output)}`;
};

const listFindings = (findings: Finding[]): string =>
  tag("findings", findings.map((f) => `- ${f.severity === "minor" ? "(minor) " : ""}${f.where}: ${f.problem}`).join("\n"));

export const reviewFound = (findings: Finding[]): string => `The checker's review found:\n${listFindings(findings)}`;

/** Each round's problem, oldest first. */
const rounds = (problems: string[]): string => problems.map((p, i) => tag("round", p, { n: String(i + 1) })).join("\n");

/** Minor findings, fixed with no review after. */
export const polish = (run: PromptRun, op: string, summary: string, findings: Finding[]): string => md`
  ${brief(run, op, summary)}

  The checker approved it, with minor findings to fix in ${opDir(run, op)} (or a helper):
  ${listFindings(findings)}

  Nobody reviews it again, so change only what these ask for; verify and the repository's checks run after. Answer done with what you changed.${answers(run.request, true)}
`;

/** A revise round; the troubleshooter's first carries every earlier round's problem. */
export const revise = (run: PromptRun, op: string, summary: string, problems: string[], takingOverAfter?: number): string => {
  const taking = takingOverAfter
    ? `\nYou are taking over ${op}: the builder's ${takingOverAfter === 1 ? "round" : `${takingOverAfter} rounds`} stopped getting further. You may change anything the builder could, the spec and the helpers included. What each earlier round found, oldest first:\n${rounds(problems.slice(0, -1))}\n`
    : "";
  return md`
    ${brief(run, op, summary)}
    ${taking}
    It is not right yet:
    ${tag("problem", problems.at(-1) ?? "")}

    Fix it in ${opDir(run, op)} (or a helper), and say in your answer what you changed.

    ${runAndCheck(run, op)}${answers(run.request)}
  `;
};

/** The rounds ran out or stalled: the troubleshooter writes the question for a person. */
export const stuck = (run: PromptRun, op: string, summary: string, problems: string[]): string => md`
  ${brief(run, op, summary)}

  The rounds for ${op} ran out, or stopped getting further, and it is still not right. What each round found, oldest first:
  ${rounds(problems)}

  Write the one specific question a person must answer for this to go on, with what you would recommend.${answers(run.request, true)}
`;

// ── Merge: the builder ────────────────────────────────────────────────────────────────────────────
export const rebase = (run: PromptRun, op: string, summary: string, conflict: string): string => {
  const { request, paths } = run;
  return md`
    ${brief(run, op, summary)}

    main moved while ${request.id} was built, and rebasing ${paths.branch} on it conflicts in:
    ${tag("conflicts", conflict)}

    Run \`git rebase main\` in ${paths.worktree} and resolve the conflicts, keeping both changes' intent; committing is how a rebase finishes. Answer done once the rebase is finished.${answers(request, true)}
  `;
};
