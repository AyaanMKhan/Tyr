// `tyr agents` — the agents' roles and the worktrees isolated runs leave
// behind (PLANNING.md 2.14).
//
//   tyr agents list                       roles, then agent worktrees
//   tyr agents clean [path] [--force] [--keep-branch]
//                                         remove agent worktrees (all, or one)
//
// Wiring only: the worktree helpers live in cli/agents/safety.ts and only
// ever touch worktrees under .tyr/worktrees/ on a tyr/ branch.

import * as path from "node:path";
import { Command } from "commander";
import { AGENT_ROLE_IDS } from "../agents/model.js";
import { ROLES } from "../agents/roles.js";
import { listAgentWorktrees, removeAgentWorktree, type AgentWorktreeEntry } from "../agents/safety.js";
import { findProjectRoot } from "../core/discovery.js";
import { EXIT_CODES, TyrError } from "../core/errors.js";
import { printJson, readGlobals, verbosityOf } from "../core/globals.js";
import { createReporter } from "../ui/reporter.js";

interface CleanOptions {
    force?: boolean;
    keepBranch?: boolean;
}

export function registerAgentsCommand(program: Command): void {
    const agents = program
        .command("agents")
        .description("List Tyr's agent roles and manage the worktrees of isolated agent runs")
        .addHelpText(
            "after",
            `
Agents run through "tyr run --agent <role>". An isolated run
(--apply --isolate) works on a new tyr/<role>-<time> branch checked out under
.tyr/worktrees/ and keeps it when the agent changed something, so you can
review it. These commands list and remove those worktrees.

Examples:
  $ tyr agents list
  $ tyr agents clean                     Remove every agent worktree and its branch
  $ tyr agents clean .tyr/worktrees/fixer-20261118-090807 --keep-branch`,
        );

    agents
        .command("list", { isDefault: true })
        .description("Show the agent roles and the agent worktrees of this repository")
        .action(async (_options: unknown, command: Command) => {
            const globals = readGlobals(command);
            const reporter = createReporter({ verbosity: verbosityOf(globals), stream: globals.json ? process.stderr : undefined });
            const root = await findProjectRoot();
            const listed = await listAgentWorktrees(root);
            const worktrees: AgentWorktreeEntry[] = "error" in listed ? [] : listed;
            if (globals.json) {
                printJson({
                    ok: !("error" in listed),
                    roles: AGENT_ROLE_IDS.map((id) => ({ id, permission: ROLES[id].permission, description: ROLES[id].description })),
                    worktrees,
                    ...("error" in listed ? { error: listed.error } : {}),
                });
                return;
            }
            reporter.info("Roles (tyr run --agent <role>):");
            for (const id of AGENT_ROLE_IDS) reporter.info(`  ${id.padEnd(12)} ${ROLES[id].permission.padEnd(8)} ${ROLES[id].description}`);
            reporter.blank();
            if ("error" in listed) {
                reporter.warn(listed.error);
            } else if (worktrees.length === 0) {
                reporter.muted("No agent worktrees.");
            } else {
                reporter.info(`Worktrees (${worktrees.length}):`);
                for (const w of worktrees) reporter.info(`  ${shown(w.path)}  ${w.branch}  ${w.head.slice(0, 8)}`);
            }
            reporter.stop();
        });

    agents
        .command("clean")
        .description("Remove agent worktrees (all of them, or the one at <path>)")
        .argument("[path]", "One worktree to remove (as shown by tyr agents list)")
        .option("--force", "Also remove worktrees with uncommitted changes (those changes are lost)")
        .option("--keep-branch", "Keep the tyr/ branches (default: delete them with the worktree)")
        .action(async (target: string | undefined, options: CleanOptions, command: Command) => {
            const globals = readGlobals(command);
            const reporter = createReporter({ verbosity: verbosityOf(globals), stream: globals.json ? process.stderr : undefined });
            const root = await findProjectRoot();
            const listed = await listAgentWorktrees(root);
            if ("error" in listed) throw new TyrError(listed.error, { exitCode: EXIT_CODES.FAILURE });
            const targets = target === undefined ? listed.map((w) => w.path) : [path.resolve(target)];

            const removed: Array<{ path: string; branch: string; branchDeleted: boolean }> = [];
            const failed: Array<{ path: string; error: string }> = [];
            for (const worktree of targets) {
                const result = await removeAgentWorktree(root, worktree, {
                    force: options.force === true,
                    keepBranch: options.keepBranch === true,
                });
                if ("error" in result) failed.push({ path: worktree, error: result.error });
                else removed.push({ path: result.path, branch: result.branch, branchDeleted: result.branchDeleted });
            }

            if (globals.json) {
                printJson({ ok: failed.length === 0, removed, failed });
            } else {
                if (targets.length === 0) reporter.muted("No agent worktrees to remove.");
                for (const r of removed) {
                    reporter.success(`Removed ${shown(r.path)}${r.branchDeleted ? ` and branch ${r.branch}` : ` (branch ${r.branch} kept)`}`);
                }
                for (const f of failed) reporter.error(`${shown(f.path)}: ${f.error}`);
                if (failed.some((f) => /uncommitted/.test(f.error))) reporter.muted("--force removes them anyway (their changes are lost).");
                reporter.stop();
            }
            if (failed.length > 0) process.exitCode = EXIT_CODES.FAILURE;
        });
}

function shown(file: string): string {
    return path.relative(process.cwd(), file) || file;
}
