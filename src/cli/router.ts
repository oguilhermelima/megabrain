import { type ProcessAdapter } from "../adapters/proc.js";
import { failed, type Result } from "../core/result.js";
import { executeContext, type Environment } from "./commands/context.js";
import { executeWeb } from "./commands/web.js";

export type RouterDependencies = {
  readonly environment: Environment;
  readonly processAdapter: ProcessAdapter;
};

export function route(
  args: readonly string[],
  dependencies: RouterDependencies,
): Promise<Result<string>> {
  const [command, ...commandArgs] = args;
  if (command === "context") {
    return executeContext(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "web") {
    return executeWeb(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  return Promise.resolve(failed(`unknown command: ${command ?? ""}`, 2));
}
