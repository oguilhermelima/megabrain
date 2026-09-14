import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { resolveContext, type Context, type ContextEnvironment } from "../../core/context.js";
import { failed, ok, type Result } from "../../core/result.js";

export type Environment = Readonly<Record<string, string | undefined>>;

async function tmuxSessionName(
  environment: Environment,
  processAdapter: ProcessAdapter,
): Promise<string | undefined> {
  if (environment.TMUX === undefined || environment.TMUX.length === 0 ||
      environment.TMUX_PANE === undefined || environment.TMUX_PANE.length === 0) {
    return undefined;
  }
  const result = await processAdapter.run("tmux", [
    "display-message",
    "-p",
    "-t",
    environment.TMUX_PANE,
    "#{session_name}",
  ]);
  if (result.kind !== "ok") {
    return undefined;
  }
  const sessionName = result.value.stdout.trim();
  return sessionName.length > 0 ? sessionName : undefined;
}

function isOrcaWorktreeResponse(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const root = value as Record<string, unknown>;
  if (root.ok !== true || typeof root.result !== "object" || root.result === null) {
    return false;
  }
  const result = root.result as Record<string, unknown>;
  if (typeof result.worktree !== "object" || result.worktree === null) {
    return false;
  }
  const worktree = result.worktree as Record<string, unknown>;
  if (typeof worktree.path === "string" && worktree.path.length > 0) {
    return true;
  }
  if (typeof worktree.git !== "object" || worktree.git === null) {
    return false;
  }
  const git = worktree.git as Record<string, unknown>;
  return typeof git.path === "string" && git.path.length > 0;
}

async function detectContext(
  environment: Environment,
  processAdapter: ProcessAdapter,
): Promise<Result<Context>> {
  const tmuxName = await tmuxSessionName(environment, processAdapter);
  let orcaWorktree = false;
  const orcaResult = await processAdapter.run("orca", ["worktree", "current", "--json"]);
  if (orcaResult.kind === "ok") {
    try {
      orcaWorktree = isOrcaWorktreeResponse(JSON.parse(orcaResult.value.stdout));
    } catch {
      // A malformed probe response is indistinguishable from no host.
    }
  }
  const contextEnvironment: ContextEnvironment = {
    supersetTerminalId: environment.SUPERSET_TERMINAL_ID,
    orcaTerminalHandle: environment.ORCA_TERMINAL_HANDLE,
    tmux: environment.TMUX,
    tmuxPane: environment.TMUX_PANE,
    workspaceId: environment.SUPERSET_WORKSPACE_ID,
    agentId: environment.SUPERSET_AGENT_ID,
  };
  return ok(resolveContext(contextEnvironment, { tmuxSessionName: tmuxName, orcaWorktree }));
}

function formatJson(context: Context): string {
  return `${JSON.stringify(context, null, 2)}\n`;
}

export async function executeContext(
  args: readonly string[],
  environment: Environment,
  processAdapter: ProcessAdapter = createProcessAdapter(),
): Promise<Result<string>> {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "-h" || arg === "--help") {
      return ok("Usage: megabrain context [--json]\n");
    } else {
      return failed(`unknown context option: ${arg}`, 2);
    }
  }

  const result = await detectContext(environment, processAdapter);
  if (result.kind !== "ok") {
    return result;
  }
  return ok(json ? formatJson(result.value) : `${result.value.host}\n`);
}
