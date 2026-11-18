// cli/agents/model.ts — the shared contract for Tyr's agents (PLANNING 2.14).
//
// Pure types and constants. Every other module in cli/agents/ builds on this
// file, so it stays small and stable:
//
//   roles.ts       role definitions (reviewer, fixer, test-runner): prompts, tool sets, limits
//   context.ts     repo context for prompts (profile, CLAUDE.md/README, diff, failing output)
//   provider.ts    the LLM client: key resolution, the tool-use loop, injectable messages client
//   tools.ts       the tools agents can call (read/list/search files, run checks, edit files)
//   safety.ts      permission model, dry-run, worktree isolation, human approval
//   coordinate.ts  watching and correcting a live Claude Code session
//
// Layering: cli/agents/ may import cli/core/ and cli/engine/; neither imports
// cli/agents/. Modules never print and never throw for normal conditions;
// clocks, spawners, prompters and the messages client are injectable.

/** The roles Tyr can run. */
export type AgentRoleId = "reviewer" | "fixer" | "test-runner";

export const AGENT_ROLE_IDS: readonly AgentRoleId[] = ["reviewer", "fixer", "test-runner"];

/**
 * What a tool is allowed to do. Ordered from least to most dangerous; a role's
 * permission ceiling is the highest level it may use.
 *   read     read files, list, search, git status/diff/log
 *   execute  run the project's configured check commands (from tyr.json)
 *   write    edit or create files (only inside the agent's workspace)
 */
export type PermissionLevel = "read" | "execute" | "write";

export const PERMISSION_ORDER: readonly PermissionLevel[] = ["read", "execute", "write"];

/** Static description of a role. */
export interface AgentRole {
    id: AgentRoleId;
    /** One line for --help and tyr status. */
    description: string;
    /** The highest permission the role may use. */
    permission: PermissionLevel;
    /** Tool names (see tools.ts) the role is given. */
    tools: readonly string[];
    /** Hard cap on model turns in the tool-use loop. */
    maxTurns: number;
    /** System prompt text specific to the role (context.ts adds the repo context). */
    instructions: string;
}

/** Repo context assembled for a prompt (context.ts). Each part is bounded. */
export interface AgentContext {
    root: string;
    /** Compact JSON of the tyr.json profile (languages, frameworks, commands). */
    profile: string;
    /** CLAUDE.md / README excerpts, trimmed to budget. */
    conventions: string;
    /** Working-tree (or commit) diff, trimmed to budget. */
    diff: string;
    /** Failing check output and open findings, trimmed to budget. */
    failures: string;
    /** Files omitted from the diff for budget reasons. */
    omittedFiles: string[];
}

/** A tool an agent can call. Executed by tools.ts under safety.ts's policy. */
export interface AgentTool {
    name: string;
    description: string;
    /** JSON schema for the input, passed to the model as-is. */
    inputSchema: Record<string, unknown>;
    permission: PermissionLevel;
    /** Runs the tool. Returns text for the model; never throws (errors become text with isError). */
    run(input: unknown, env: ToolEnv): Promise<ToolResult>;
}

export interface ToolResult {
    content: string;
    isError?: boolean;
}

/** What a tool sees when it runs. */
export interface ToolEnv {
    /** Directory the agent works in: the repo root, or an isolated worktree. */
    workspace: string;
    /** When true, write tools describe the change instead of making it. */
    dryRun: boolean;
    /** Permission gate (safety.ts). Tools call it before acting. */
    gate: PermissionGate;
    signal?: AbortSignal;
}

/** A proposed change a write tool wants to make. */
export interface ProposedChange {
    tool: string;
    /** Path relative to the workspace. */
    path: string;
    /** Short human summary ("replace 3 lines in foo.ts"). */
    summary: string;
    /** Unified diff of the change, when available. */
    patch?: string;
}

export type GateDecision = { allowed: true } | { allowed: false; reason: string };

/** Decides whether an action may go ahead (safety.ts implements it). */
export interface PermissionGate {
    /** Checks a tool call against the role's ceiling and the path policy. */
    check(tool: string, permission: PermissionLevel, path?: string): GateDecision;
    /** Asks for human approval of a change (or auto-approves under policy). */
    approve(change: ProposedChange): Promise<GateDecision>;
}

/** Options the caller (tyr run, the daemon) chooses for one agent run. */
export interface AgentRunOptions {
    role: AgentRoleId;
    /** The task in plain words. */
    task: string;
    /** Describe changes, never write. Default true for anything below an explicit opt-in. */
    dryRun: boolean;
    /** Run in an isolated git worktree on a new branch instead of the working tree. */
    isolate: boolean;
    /** Approval mode for write tools. */
    approval: "ask" | "auto" | "deny";
}

export type AgentRunStatus = "completed" | "max-turns" | "denied" | "skipped" | "error" | "cancelled";

/** One tool call the agent made, for the run record. */
export interface AgentToolCall {
    tool: string;
    input: unknown;
    isError: boolean;
    /** First few hundred chars of the result. */
    preview: string;
}

/** The outcome of an agent run; recorded in state/reports by the caller. */
export interface AgentRunResult {
    role: AgentRoleId;
    status: AgentRunStatus;
    /** Final text from the agent (summary of what it found or did). */
    summary: string;
    /** Why it stopped, when not completed. */
    reason?: string;
    toolCalls: AgentToolCall[];
    /** Changes applied (or, in dry-run, proposed). */
    changes: ProposedChange[];
    /** When isolated: the worktree path and branch the changes are on. */
    worktree?: { path: string; branch: string };
    turns: number;
    usage?: { inputTokens: number; outputTokens: number };
}
