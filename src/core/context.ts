export type Context = {
  readonly host: string;
  readonly workspaceId: string | null;
  readonly terminalId: string | null;
  readonly agentId: string | null;
};

export type ContextEnvironment = {
  readonly supersetTerminalId?: string;
  readonly orcaTerminalHandle?: string;
  readonly tmux?: string;
  readonly tmuxPane?: string;
  readonly workspaceId?: string;
  readonly agentId?: string;
};

export type ContextProbes = {
  readonly tmuxSessionName?: string;
  readonly orcaWorktree: boolean;
};

function present(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function contextForSession(
  environment: ContextEnvironment,
  host: string,
  terminalId: string,
): Context {
  return {
    host,
    workspaceId: present(environment.workspaceId) ? environment.workspaceId : null,
    terminalId,
    agentId: present(environment.agentId) ? environment.agentId : null,
  };
}

export function resolveContext(
  environment: ContextEnvironment,
  probes: ContextProbes,
): Context {
  if (present(environment.supersetTerminalId)) {
    return contextForSession(environment, "superset", environment.supersetTerminalId);
  }
  if (present(environment.orcaTerminalHandle)) {
    return contextForSession(environment, "orca", environment.orcaTerminalHandle);
  }
  if (present(environment.tmux) && present(environment.tmuxPane) && present(probes.tmuxSessionName)) {
    return contextForSession(environment, "tmux", `${probes.tmuxSessionName}:${environment.tmuxPane}`);
  }
  if (probes.orcaWorktree) {
    return { host: "orca", workspaceId: null, terminalId: null, agentId: null };
  }
  return {
    host: "unknown",
    workspaceId: present(environment.workspaceId) ? environment.workspaceId : null,
    terminalId: null,
    agentId: present(environment.agentId) ? environment.agentId : null,
  };
}
