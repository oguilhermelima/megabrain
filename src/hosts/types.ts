import type { ProcessAdapter } from "../adapters/proc.js";
import { unknown, type Result } from "../core/result.js";

export type HostCommand = Readonly<{
  readonly command: string;
  readonly args: readonly string[];
}>;

export type TerminalTarget = Readonly<{
  readonly workspaceId: string | null;
  readonly terminalId: string;
}>;

export type CreateTerminal = Readonly<{
  readonly workspaceId: string | null;
  readonly worktreePath: string;
  readonly title: string | null;
  readonly command?: string;
}>;

export type SendText = Readonly<{
  readonly workspaceId: string | null;
  readonly terminalId: string;
  readonly text?: string;
  readonly interrupt?: boolean;
}>;

export type HostProvider = Readonly<{
  readonly id: string;
  readonly create: (input: CreateTerminal) => Result<HostCommand>;
  readonly terminalIdentity: (value: unknown) => string | undefined;
  readonly terminalIdentityVariable?: string;
  readonly readiness: (input: TerminalTarget, process: ProcessAdapter, timeoutMs: number) => Promise<Result<void>>;
  readonly list: (input: Pick<TerminalTarget, "workspaceId">) => Result<HostCommand>;
  readonly read: (input: TerminalTarget) => Result<HostCommand>;
  readonly close: (input: TerminalTarget) => Result<HostCommand>;
  readonly send: (input: SendText) => Result<HostCommand>;
  readonly workspaces: () => Result<HostCommand>;
}>;

export const unavailable = (host: string, capability: string): Result<HostCommand> =>
  unknown(`capability-unavailable: ${host} cannot ${capability}`);
