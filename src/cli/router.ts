import { type ProcessAdapter } from "../adapters/proc.js";
import { failed, type Result } from "../core/result.js";
import { executeContext, type Environment } from "./commands/context.js";
import { executeCheck } from "./commands/check.js";
import { executeModel } from "./commands/model.js";
import { executeWeb } from "./commands/web.js";
import { executeNative } from "./commands/native.js";
import { executeTv } from "./commands/tv.js";
import { executeQueueWrite } from "./commands/queue-write.js";
import { executeOrchestrateList } from "./commands/orchestrate-list.js";
import { executeFact } from "./commands/fact.js";
import { executeWorktreeList } from "./commands/worktree-list.js";

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
  if (command === "check") {
    return executeCheck(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "model") {
    return executeModel(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "web") {
    return executeWeb(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "native") {
    return executeNative(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "tv") {
    return executeTv(commandArgs, dependencies.processAdapter);
  }
  if (command === "orchestrate" && commandArgs[0] === "list") {
    return executeOrchestrateList(commandArgs.slice(1), dependencies.environment);
  }
  if (command === "fact") {
    return executeFact(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "worktree" && commandArgs[0] === "list") {
    return executeWorktreeList(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "received" || command === "ask" || command === "done") {
    return executeQueueWrite(command, commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  return Promise.resolve(failed(`unknown command: ${command ?? ""}`, 2));
}
