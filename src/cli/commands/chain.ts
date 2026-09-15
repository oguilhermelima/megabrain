import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";

export type ChainEnvironment = Readonly<Record<string, string | undefined>>;

export async function executeChain(
  args: readonly string[],
  environment: ChainEnvironment,
  processAdapter: ProcessAdapter = createProcessAdapter(),
): Promise<Result<string>> {
  const root = environment.MEGABRAIN_ROOT ?? process.cwd();
  const result = await processAdapter.run("env", ["MEGABRAIN_CHAIN_IMPLEMENTATION=shell", `${root}/megabrain`, "chain", ...args]);
  if (result.kind !== "ok") return failed(result.error, result.exitCode);
  if (result.value.stderr.length > 0) process.stderr.write(result.value.stderr);
  return ok(result.value.stdout);
}
