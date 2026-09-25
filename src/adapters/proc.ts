import { spawn } from "node:child_process";
import { failed, ok, type Result } from "../core/result.js";

export type ProcessOutput = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export type ProcessAdapter = {
  run(command: string, args: readonly string[], options?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> }): Promise<Result<ProcessOutput>>;
  startDetached(command: string, args: readonly string[]): Promise<Result<{ readonly pid: number }>>;
  invocationCount(): number;
};

export function createProcessAdapter(): ProcessAdapter {
  let count = 0;

  async function run(command: string, args: readonly string[], options?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> }): Promise<Result<ProcessOutput>> {
    count += 1;
    try {
      const child = spawn(command, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (exitCode !== 0) {
        return failed(stderr.trim() || `${command} exited with status ${exitCode}`, exitCode, stdout);
      }
      return ok({ stdout, stderr, exitCode });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "process could not be started";
      return failed(`${command}: ${message}`);
    }
  }

  async function startDetached(command: string, args: readonly string[]): Promise<Result<{ readonly pid: number }>> {
    count += 1;
    try {
      const child = spawn(command, [...args], { stdio: "ignore", detached: true });
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
