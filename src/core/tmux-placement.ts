export type TmuxPlacementInput = Readonly<{
  readonly callerInTmux: boolean;
  readonly sameWorktree: boolean;
  readonly tmuxRuntimeSelected: boolean;
  readonly existingSession: boolean;
}>;

export type TmuxPlacement = Readonly<{ kind: "caller-window" | "existing-session" | "worktree-session" | "host" }>;

export function decideTmuxPlacement(input: TmuxPlacementInput): TmuxPlacement {
  if (input.callerInTmux && input.sameWorktree) return { kind: "caller-window" };
  if (!input.tmuxRuntimeSelected) return { kind: "host" };
  return input.existingSession ? { kind: "existing-session" } : { kind: "worktree-session" };
}
