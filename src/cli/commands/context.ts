import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { resolveContext, type Context, type ContextEnvironment } from "../../core/context.js";
import { failed, ok, type Result } from "../../core/result.js";
import { getTmux } from "../../hosts/tmux.js";

export type Environment = Readonly<Record<string, string | undefined>>;

export async function tmuxSessionName(
  environment: Environment,
  processAdapter: ProcessAdapter,
): Promise<string | undefined> {
  if (environment.TMUX === undefined || environment.TMUX.length === 0 ||
      environment.TMUX_PANE === undefined || environment.TMUX_PANE.length === 0) {
    return undefined;
  }
  const result = await getTmux().sessionForPane(environment.TMUX_PANE, processAdapter);
  return result.kind === "ok" ? result.value : undefined;
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
    parent: {
      supersetAgentId: environment.SUPERSET_AGENT_ID,
      supersetModel: environment.SUPERSET_AGENT_MODEL,
      supersetEffort: environment.SUPERSET_AGENT_EFFORT,
      aiAgent: environment.AI_AGENT,
      aiModel: environment.AI_MODEL,
      aiEffort: environment.AI_EFFORT,
      codexSessionId: environment.CODEX_SESSION_ID,
    },
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
