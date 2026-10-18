// workflows.json at the checkout's root: which harness and model each agent runs on, and whether
// agents run in a sandbox, where the checkout differs from the defaults below, the one place they
// are named. Read when a run starts; a missing file means the defaults.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RuntimeSelection } from "agentswf/workflow";

const CONFIG_FILE = "workflows.json";

const ROLES = ["planner", "builder", "checker", "troubleshooter"] as const;
export type Role = (typeof ROLES)[number];

/** What sandboxed agents reach beyond what the workflow gives them: paths from the checkout's root, and domains. */
export interface SandboxReach {
  read?: string[];
  write?: string[];
  network?: string[];
}

export interface WorkflowConfig {
  /**
   * Agents in srt: they write only the worktree and the request's own home, and reach no network but
   * their model's, plus what it names. `true` in the file is `{}`; `false`, no sandbox.
   */
  sandbox: false | SandboxReach;
  agents: Record<Role, RuntimeSelection>;
}

// The planner decides what to build and writes the spec, which the rest is judged against, so it is
// strong. The builder explores and writes with its session kept through every stage, the bulk of the
// work, on a cheaper model. The checker is another vendor's model, so it doesn't share the builder's
// assumptions, and the troubleshooter, opened fresh at high effort, is what's left when the builder is stuck.
export const DEFAULTS: WorkflowConfig = {
  sandbox: false,
  agents: {
    planner: { harness: "claude", model: "claude-opus-5-5" },
    builder: { harness: "claude", model: "claude-sonnet-5-5" },
    checker: { harness: "codex", model: "gpt-6.1-sol", placement: "headless" },
    troubleshooter: { harness: "claude", model: "claude-opus-5-5", effort: "high" },
  },
};

const REACH = ["read", "write", "network"];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** An agent named in the file replaces its default whole; awf checks the rest when it opens. */
export const loadConfig = (root: string): WorkflowConfig => {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) return DEFAULTS;
  const bad = (why: string): never => {
    throw new Error(`${file}: ${why}`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return bad(`not JSON: ${(err as Error).message}`);
  }
  if (!isObject(raw)) return bad("must be an object");
  for (const key of Object.keys(raw)) if (key !== "sandbox" && key !== "agents") bad(`unknown field "${key}"`);
  const sandbox = raw.sandbox === undefined ? DEFAULTS.sandbox : raw.sandbox === true ? {} : raw.sandbox;
  if (sandbox !== false && !isObject(sandbox)) bad('sandbox must be true, false or {"read", "write", "network"}');
  if (isObject(sandbox))
    for (const [key, value] of Object.entries(sandbox)) {
      if (!REACH.includes(key)) bad(`unknown sandbox field "${key}" (fields: ${REACH.join(", ")})`);
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) bad(`sandbox.${key} must be a list of strings`);
      // The host runs the checkout's code, so agents change it only through their worktree.
      if (key === "write")
        for (const path of value as string[]) {
          const at = resolve(root, path);
          if (at === root || at.startsWith(`${root}/`) || root.startsWith(`${at}/`))
            bad(`sandbox.write "${path}" reaches the checkout; agents write only their worktree there`);
        }
    }
  const agents = { ...DEFAULTS.agents };
  if (raw.agents !== undefined) {
    if (!isObject(raw.agents)) bad("agents must be an object");
    for (const [role, runtime] of Object.entries(raw.agents as Record<string, unknown>)) {
      if (!(ROLES as readonly string[]).includes(role)) bad(`unknown agent "${role}" (agents: ${ROLES.join(", ")})`);
      const named =
        typeof runtime === "string" || (isObject(runtime) && (typeof runtime.harness === "string" || typeof runtime.alias === "string"));
      if (!named) bad(`agents.${role} needs a harness or an alias, as {"harness": "claude", "model": "…"} or "<alias>"`);
      agents[role as Role] = runtime as RuntimeSelection;
    }
  }
  return { sandbox: sandbox as WorkflowConfig["sandbox"], agents };
};
