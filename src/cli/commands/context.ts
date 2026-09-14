import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";

export type Environment = Readonly<Record<string, string | undefined>>;

export type Context = {
  readonly host: string;
  readonly workspaceId: string | null;
  readonly terminalId: string | null;
  readonly agentId: string | null;
};

type Session = {
  readonly host: string;
  readonly terminalId: string;
};

function present(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function sessionFromEnvironment(environment: Environment): Session | undefined {
  if (present(environment.SUPERSET_TERMINAL_ID)) {
    return { host: "superset", terminalId: environment.SUPERSET_TERMINAL_ID };
  }
  if (present(environment.ORCA_TERMINAL_HANDLE)) {
    return { host: "orca", terminalId: environment.ORCA_TERMINAL_HANDLE };
  }
  return undefined;
}

async function sessionFromTmux(
  environment: Environment,
  processAdapter: ProcessAdapter,
): Promise<Session | undefined> {
  if (!present(environment.TMUX) || !present(environment.TMUX_PANE)) {
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
  return sessionName.length > 0
    ? { host: "tmux", terminalId: `${sessionName}:${environment.TMUX_PANE}` }
    : undefined;
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
  const environmentSession = sessionFromEnvironment(environment);
  const session = environmentSession ?? await sessionFromTmux(environment, processAdapter);
  if (session !== undefined) {
    return ok({
      host: session.host,
      workspaceId: present(environment.SUPERSET_WORKSPACE_ID) ? environment.SUPERSET_WORKSPACE_ID : null,
      terminalId: session.terminalId,
      agentId: present(environment.SUPERSET_AGENT_ID) ? environment.SUPERSET_AGENT_ID : null,
    });
  }

  const orcaResult = await processAdapter.run("orca", ["worktree", "current", "--json"]);
  if (orcaResult.kind === "ok") {
    try {
      if (isOrcaWorktreeResponse(JSON.parse(orcaResult.value.stdout))) {
        return ok({
          host: "orca",
          workspaceId: null,
          terminalId: null,
          agentId: null,
        });
      }
    } catch {
      // A malformed probe response is indistinguishable from no host.
    }
  }
  return ok({
    host: "unknown",
    workspaceId: present(environment.SUPERSET_WORKSPACE_ID) ? environment.SUPERSET_WORKSPACE_ID : null,
    terminalId: null,
    agentId: present(environment.SUPERSET_AGENT_ID) ? environment.SUPERSET_AGENT_ID : null,
  });
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
