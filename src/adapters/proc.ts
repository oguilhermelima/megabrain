import { spawn } from "node:child_process";
import { scrubAgentEnvironment } from "../core/agent-env.js";
import { failed, ok, type Result } from "../core/result.js";

export type ProcessOutput = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export type ProcessAdapter = {
  run(command: string, args: readonly string[], options?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>>; readonly timeoutMs?: number; readonly maxOutputBytes?: number; readonly scrubAgentEnvironment?: boolean }): Promise<Result<ProcessOutput>>;
  startDetached(command: string, args: readonly string[], options?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> }): Promise<Result<{ readonly pid: number }>>;
  invocationCount(): number;
};

function missingExecutable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "ENOENT") return true;
  return "message" in error && typeof error.message === "string" &&
    /^Executable not found in \$PATH:/.test(error.message);
}

function childEnvironment(options: { readonly env?: Readonly<Record<string, string>>; readonly scrubAgentEnvironment?: boolean }): Record<string, string | undefined> {
  const merged = { ...process.env, ...options.env };
  return options.scrubAgentEnvironment === true ? scrubAgentEnvironment(merged) : merged;
}

export const DEFAULT_PROCESS_TIMEOUT_MS = 60_000;
export const DEFAULT_PROCESS_OUTPUT_BYTES = 1_000_000;

export function createProcessAdapter(defaultTimeoutMs = DEFAULT_PROCESS_TIMEOUT_MS): ProcessAdapter {
  let count = 0;

  async function run(command: string, args: readonly string[], options?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>>; readonly timeoutMs?: number; readonly maxOutputBytes?: number; readonly scrubAgentEnvironment?: boolean }): Promise<Result<ProcessOutput>> {
    count += 1;
    try {
      const child = spawn(command, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.env || options?.scrubAgentEnvironment ? { env: childEnvironment(options) } : {}),
      });
      const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_PROCESS_OUTPUT_BYTES;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        const bytes = Buffer.from(chunk);
        const accepted = bytes.subarray(0, Math.max(0, maxOutputBytes - stdoutBytes));
        if (accepted.length > 0) stdout.push(accepted);
        stdoutBytes += accepted.length;
      });
      child.stderr.on("data", (chunk: string) => {
        const bytes = Buffer.from(chunk);
        const accepted = bytes.subarray(0, Math.max(0, maxOutputBytes - stderrBytes));
        if (accepted.length > 0) stderr.push(accepted);
        stderrBytes += accepted.length;
      });
      let timedOut = false;
      let exited = false;
      const timeout = setTimeout(() => {
        if (exited || child.exitCode !== null || child.signalCode !== null) return;
        timedOut = true;
        child.kill("SIGKILL");
      }, options?.timeoutMs ?? defaultTimeoutMs);
      child.once("exit", () => {
        exited = true;
        clearTimeout(timeout);
      });
      let exitCode: number;
      try {
        exitCode = await new Promise<number>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) => resolve(code ?? 1));
        });
      } finally { clearTimeout(timeout); }
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (timedOut) return failed(`${command} timed out`);
      if (exitCode !== 0) {
        return failed(stderrText.trim() || `${command} exited with status ${exitCode}`, exitCode, stdoutText);
      }
      return ok({ stdout: stdoutText, stderr: stderrText, exitCode });
    } catch (error: unknown) {
      if (missingExecutable(error)) return failed(`${command}: executable not found`);
      const message = error instanceof Error ? error.message : "process could not be started";
      return failed(`${command}: ${message}`);
    }
  }

  async function startDetached(command: string, args: readonly string[], options?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> }): Promise<Result<{ readonly pid: number }>> {
    count += 1;
    try {
      const child = spawn(command, [...args], {
        stdio: "ignore",
        detached: true,
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      if (child.pid === undefined) return failed(`${command}: process could not be started`);
      child.unref();
      return ok({ pid: child.pid });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "process could not be started";
      return failed(`${command}: ${message}`);
    }
  }

  return {
    run,
    startDetached,
    invocationCount: () => count,
  };
}
