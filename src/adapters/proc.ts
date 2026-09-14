import { failed, ok, type Result } from "../core/result.js";

export type ProcessOutput = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export type ProcessAdapter = {
  run(command: string, args: readonly string[]): Promise<Result<ProcessOutput>>;
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
};

export function createProcessAdapter(): ProcessAdapter {
  let count = 0;

  async function run(command: string, args: readonly string[]): Promise<Result<ProcessOutput>> {
    count += 1;
    try {
      const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) {
        return failed(stderr.trim() || `${command} exited with status ${exitCode}`, exitCode);
      }
      return ok({ stdout, stderr, exitCode });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "process could not be started";
      return failed(`${command}: ${message}`);
    }
  }

  return {
    run,
    invocationCount: () => count,
  };
}
