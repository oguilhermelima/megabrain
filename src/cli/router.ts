import { type ProcessAdapter } from "../adapters/proc.js";
import { failed, type Result } from "../core/result.js";
import { executeContext, type Environment } from "./commands/context.js";
import { executeModel } from "./commands/model.js";

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
  if (command === "model") {
    return executeModel(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  return Promise.resolve(failed(`unknown command: ${command ?? ""}`, 2));
}
