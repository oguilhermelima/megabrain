import { getAgent, resolveAgentDescriptor } from "../agents/index.js";

export type Context = {
  readonly host: string;
  readonly workspaceId: string | null;
  readonly terminalId: string | null;
  readonly agentId: string | null;
};

export type ContextEnvironment = CallerEnvironment & {
  readonly workspaceId?: string;
  readonly agentId?: string;
  readonly parent?: ParentEnvironment;
};

// The environment variable names resolveCallerIdentity reads to identify a caller. A child
// launched by `orchestrate spawn` must never inherit these from its parent process — tmux copies
// the spawner's whole environment into a new pane, and a host terminal's shell can too — or the
// child would resolve as its parent's own identity and pass the parent's ownership checks. Spawn
// clears exactly this list (env -u) on both the tmux and the host launch line. Kept as one
// constant next to the resolver that reads these same names so the two cannot drift apart.
export const CALLER_IDENTITY_ENV_VARS = [
  "MEGABRAIN_SESSION_ID",
  "MEGABRAIN_SESSION_HOST",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "ORCA_STRUCTURED_SESSION",
  "ORCA_AGENT_SESSION_SPAWN_TOKEN",
  "ORCA_TERMINAL_HANDLE",
  "SUPERSET_TERMINAL_ID",
  // A parent agy or Grok's own identity, and the channels into it: a Grok child started without its
  // own leader would otherwise join the parent's, and the agy token would reach every child process.
  "ANTIGRAVITY_AGENT",
  "ANTIGRAVITY_LS_ADDRESS",
  "ANTIGRAVITY_CSRF_TOKEN",
  "ANTIGRAVITY_CONVERSATION_ID",
  "ANTIGRAVITY_LS_VERSION",
  "GROK_AGENT",
  "GROK_SESSION_ID",
  "GROK_LEADER_SOCKET",
] as const;

// The caller-identity environment: every field a "who is running this command" decision can draw
// on, across megabrain context, orchestrate spawn, and every parent/child verb. One shape, one
// set of field names, so every call site maps its own process.env the same way.
export type CallerEnvironment = {
  readonly megabrainSessionId?: string;
  readonly megabrainSessionHost?: string;
  readonly claudeCodeSessionId?: string;
  readonly codexThreadId?: string;
  readonly supersetTerminalId?: string;
  readonly orcaTerminalHandle?: string;
  readonly orcaStructuredSession?: string;
  readonly tmux?: string;
  readonly tmuxPane?: string;
};

// Probes a caller can supply when it already has the information: the tmux session name (a
// subprocess lookup). It is not fetched here — core stays free of process/adapter dependencies;
// a caller either has the probe already or leaves the field undefined and falls through. There is
// deliberately no probe for "the working directory is an Orca worktree": a folder Orca knows does
// not make the caller an Orca terminal.
export type CallerProbes = {
  readonly tmuxSessionName?: string;
  // The calling shell's identity ("shell:<tty>"), for a caller that carries neither an agent
  // session id nor a terminal handle.
  readonly shellIdentity?: string;
  // An agent session found from the process tree ("grok:<id>", "agy:<id>") for agents that export
  // no session id to the commands they run.
  readonly agentSessionId?: string;
};

// The resolved identity of whoever is running the current megabrain command: a stable id for
// ownership comparisons, the host it runs under, and the terminal handle when one exists
// (recorded separately so a caller whose agent session changed but whose terminal did not can
// still be recognised against a dispatch that predates the agent-session identity).
export type CallerIdentity = {
  readonly id: string;
  readonly host: string;
  readonly terminalId: string | null;
  readonly tmuxSession: string | null;
  readonly tmuxPane: string | null;
  /** Set by --operator: a person's own program (the desktop app) acting on any dispatch. */
  readonly operator?: true;
};

export type DispatchOwnerRecord = {
  readonly parentHost: string;
  readonly parentSessionId: string;
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
};

function present(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

export function resolveParentContext(environment: ParentEnvironment): ParentResolution {
  const model = present(environment.supersetModel) ? environment.supersetModel : environment.aiModel;
  const effort = present(environment.supersetEffort) ? environment.supersetEffort : environment.aiEffort;
  if (present(environment.supersetAgentId)) {
    return { kind: "resolved", agent: environment.supersetAgentId, model: model ?? null, effort: effort ?? null };
  }
  const descriptor = environment.aiAgent ?? "";
  const agent = resolveAgentDescriptor(descriptor) ?? (descriptor.length === 0 && present(environment.codexSessionId) ? getAgent("codex")?.id : undefined);
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

// The terminal-handle tier of caller identity: superset, then orca, then a probed tmux pane.
// Shared by resolveCallerIdentity's id and host chains, since a terminal handle answers both at
// once and the two must never disagree about which terminal they mean.
function callerTerminal(
  environment: CallerEnvironment,
  probes: CallerProbes,
): Readonly<{ host: string; terminalId: string; tmuxSession: string | null; tmuxPane: string | null }> | undefined {
  if (present(environment.supersetTerminalId)) {
    return { host: "superset", terminalId: environment.supersetTerminalId, tmuxSession: null, tmuxPane: null };
  }
  if (present(environment.orcaTerminalHandle)) {
    return { host: "orca", terminalId: environment.orcaTerminalHandle, tmuxSession: null, tmuxPane: null };
  }
  if (present(environment.tmux) && present(environment.tmuxPane) && present(probes.tmuxSessionName)) {
    return { host: "tmux", terminalId: `${probes.tmuxSessionName}:${environment.tmuxPane}`, tmuxSession: probes.tmuxSessionName, tmuxPane: environment.tmuxPane };
  }
  return undefined;
}

// The one caller-identity resolver: used by `megabrain context`, `orchestrate spawn`'s caller
// resolution, and every parent/child verb that has to know who is running it. Precedence:
// MEGABRAIN_SESSION_ID is an explicit override and always wins; then the agent's own session id
// (Claude, then Codex, then a Grok or Agy session found from the process tree); then a terminal handle (superset, then orca, then a probed tmux pane);
// then, host only, a structured Orca session (ORCA_STRUCTURED_SESSION=1) with no stable id. A caller under none of those hosts is "local": no terminal
// exists to type into, and its id is its agent session or, failing that, the shell probe. The terminal handle is
// returned separately from id so callers that need it (ownership, notification routing) do not
// have to re-derive it, and so a caller whose agent session changes while its terminal does not
// can still be recognised (see ownsDispatch).
export function resolveCallerIdentity(environment: CallerEnvironment, probes: CallerProbes = {}): CallerIdentity {
  const terminal = callerTerminal(environment, probes);
  const host = present(environment.megabrainSessionHost)
    ? environment.megabrainSessionHost
    : terminal !== undefined
      ? terminal.host
      : environment.orcaStructuredSession === "1"
        ? "orca"
        : "local";
  const id = present(environment.megabrainSessionId)
    ? environment.megabrainSessionId
    : present(environment.claudeCodeSessionId)
      ? `claude:${environment.claudeCodeSessionId}`
      : present(environment.codexThreadId)
        ? `codex:${environment.codexThreadId}`
        : present(probes.agentSessionId)
          ? probes.agentSessionId
          : terminal?.terminalId ?? (host === "local" ? probes.shellIdentity ?? "" : "");
  return {
    id,
    host,
    terminalId: terminal?.terminalId ?? null,
    tmuxSession: terminal?.tmuxSession ?? null,
    tmuxPane: terminal?.tmuxPane ?? null,
  };
}

// True once resolveCallerIdentity found anything at all to identify the caller by — a stable id
// or a terminal handle. A caller with neither is refused before any ownership comparison runs.
export function hasCallerIdentity(caller: CallerIdentity): boolean {
  return caller.id !== "" || caller.terminalId !== null;
}

export function isAgentSessionId(value: string): boolean {
  return /^(?:claude|codex|grok|agy):.+$/.test(value);
}

// A local owner that names a process rather than a session: a stable ancestor, or the older
// transient-shell pid. Its liveness can be checked, so a dead one can be adopted without --force.
export function isLocalProcessOwner(value: string): boolean {
  return /^(?:proc:\d+:.+|shell:pid\d+)$/.test(value);
}

// Ownership: the caller's stable id matches the recorded owner, or — for a record written before
// agent-session ids existed, whose owner is a terminal handle — the caller's current terminal
// handle matches. Host must agree either way.
export function ownsDispatch(caller: CallerIdentity, record: DispatchOwnerRecord): boolean {
  if (caller.operator === true) return true;
  if (caller.host !== record.parentHost) return false;
  if (caller.id !== "" && caller.id === record.parentSessionId) return true;
  if (caller.terminalId !== null && caller.terminalId === record.parentSessionId) return true;
  return false;
}

export const OPERATOR_ID = "operator";

// --operator exists for a person's own program, such as the desktop app, which is no agent session
// and so owns no dispatch. It guards against an agent stepping around ownership by mistake; it is
// not a security boundary, since everything runs as the same user.
export function operatorRefusal(dispatchId: string | undefined, caller: CallerIdentity): string | undefined {
  if (dispatchId !== undefined && dispatchId !== "") return `a child (dispatch ${dispatchId}) cannot act as the operator; --operator is for a person's own program, such as the desktop app`;
  if (isAgentSessionId(caller.id)) return `${caller.id} is an agent session and cannot act as the operator; --operator is for a person's own program, such as the desktop app`;
  return undefined;
}

// The caller acting as the operator keeps its terminal, so close still refuses its own pane, and is
// recorded as "operator" wherever a session id is written.
export function asOperator(caller: CallerIdentity): CallerIdentity {
  return { ...caller, id: OPERATOR_ID, operator: true };
}

export function resolveContext(
  environment: ContextEnvironment,
  probes: ContextProbes,
): Context {
  const caller = resolveCallerIdentity(environment, { tmuxSessionName: probes.tmuxSessionName });
  const parent = environment.parent === undefined ? undefined : resolveParentContext(environment.parent);
  return {
    host: caller.host,
    workspaceId: present(environment.workspaceId) ? environment.workspaceId : null,
    terminalId: caller.terminalId,
    agentId: parent?.kind === "resolved" ? parent.agent : present(environment.agentId) ? environment.agentId : null,
  };
}
