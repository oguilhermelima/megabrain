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

type Subprocess = {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
};

declare const Bun: {
  spawn(command: readonly string[], options: {
    readonly stdout: "pipe";
    readonly stderr: "pipe";
  }): Subprocess;
  spawn(command: readonly string[], options: {
    readonly stdout: "ignore";
    readonly stderr: "ignore";
    readonly detached: true;
  }): Subprocess & { readonly pid: number; readonly unref: () => void };
};

export function createProcessAdapter(): ProcessAdapter {
  let count = 0;

  async function run(command: string, args: readonly string[], options?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> }): Promise<Result<ProcessOutput>> {
    count += 1;
    try {
      const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe", ...(options?.cwd ? { cwd: options.cwd } : {}), ...(options?.env ? { env: { ...process.env, ...options.env } } : {}) } as never);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
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
      const child = Bun.spawn([command, ...args], { stdout: "ignore", stderr: "ignore", detached: true });
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
