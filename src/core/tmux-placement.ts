import { createHash } from "node:crypto";
import { basename } from "node:path";

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

export function tmuxWorktreeSessionName(worktreePath: string): string {
  const slug = basename(worktreePath).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "worktree";
  const hash = createHash("sha256").update(worktreePath).digest("hex").slice(0, 12);
  return `megabrain-wt-${slug}-${hash}`;
}
