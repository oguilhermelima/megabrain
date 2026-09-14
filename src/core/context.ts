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
  readonly parent?: ParentEnvironment;
};

export type ParentEnvironment = {
  readonly supersetAgentId?: string;
  readonly supersetModel?: string;
  readonly supersetEffort?: string;
  readonly aiAgent?: string;
  readonly aiModel?: string;
  readonly aiEffort?: string;
  readonly codexSessionId?: string;
};

export type ParentResolution =
  | { readonly kind: "resolved"; readonly agent: string; readonly model: string | null; readonly effort: string | null }
  | { readonly kind: "unknown"; readonly reason: "unrecognised AI_AGENT descriptor" | "no host identity was provided"; readonly model: string | null; readonly effort: string | null };

export type ContextProbes = {
  readonly tmuxSessionName?: string;
  readonly orcaWorktree: boolean;
};

function present(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function descriptorAgent(descriptor: string): "claude" | "codex" | "agy" | undefined {
  if (descriptor === "claude" || descriptor === "codex" || descriptor === "agy") {
    return descriptor;
  }
  const match = /^(claude-code|codex|agy)_[0-9]+-[0-9]+-[0-9]+_agent$/.exec(descriptor);
  if (match === null) {
    return undefined;
  }
  return match[1] === "claude-code" ? "claude" : match[1] as "codex" | "agy";
}

export function resolveParentContext(environment: ParentEnvironment): ParentResolution {
  const model = present(environment.supersetModel) ? environment.supersetModel : environment.aiModel;
  const effort = present(environment.supersetEffort) ? environment.supersetEffort : environment.aiEffort;
  if (present(environment.supersetAgentId)) {
    return { kind: "resolved", agent: environment.supersetAgentId, model: model ?? null, effort: effort ?? null };
  }
  const descriptor = environment.aiAgent ?? "";
  const agent = descriptorAgent(descriptor) ?? (descriptor.length === 0 && present(environment.codexSessionId) ? "codex" : undefined);
  if (agent !== undefined) {
    return { kind: "resolved", agent, model: model ?? null, effort: effort ?? null };
  }
  return {
    kind: "unknown",
    reason: descriptor.length > 0 ? "unrecognised AI_AGENT descriptor" : "no host identity was provided",
    model: model ?? null,
    effort: effort ?? null,
  };
}

function contextForSession(
  environment: ContextEnvironment,
  host: string,
  terminalId: string,
): Context {
  const parent = environment.parent === undefined ? undefined : resolveParentContext(environment.parent);
  return {
    host,
    workspaceId: present(environment.workspaceId) ? environment.workspaceId : null,
    terminalId,
    agentId: parent?.kind === "resolved" ? parent.agent : present(environment.agentId) ? environment.agentId : null,
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
    const parent = environment.parent === undefined ? undefined : resolveParentContext(environment.parent);
    return { host: "orca", workspaceId: null, terminalId: null, agentId: parent?.kind === "resolved" ? parent.agent : null };
  }
  const parent = environment.parent === undefined ? undefined : resolveParentContext(environment.parent);
  return {
    host: "unknown",
    workspaceId: present(environment.workspaceId) ? environment.workspaceId : null,
    terminalId: null,
    agentId: parent?.kind === "resolved" ? parent.agent : present(environment.agentId) ? environment.agentId : null,
  };
}
