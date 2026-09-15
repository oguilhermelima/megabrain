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
import { executeWorktreeAdopt } from "./commands/worktree-adopt.js";
import { executeTerminalList } from "./commands/terminal-list.js";
import { executeOrchestrateAck, executeOrchestrateWatch } from "./commands/orchestrate-parent.js";
import { executeOrchestrateLiveness, executeOrchestrateRead } from "./commands/orchestrate-read-liveness.js";
import { executeOrchestrateChange, executeOrchestrateReply } from "./commands/orchestrate-reply.js";
import { executeOrchestrateClose } from "./commands/orchestrate-close.js";
import { executeOrchestrateReconcile, executeOrchestrateStop } from "./commands/orchestrate-stop-reconcile.js";
import { executeOrchestratePrune } from "./commands/orchestrate-prune.js";

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
  if (command === "orchestrate" && commandArgs[0] === "watch") {
    return executeOrchestrateWatch(commandArgs.slice(1), dependencies.environment);
  }
  if (command === "orchestrate" && commandArgs[0] === "read") {
    return executeOrchestrateRead(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "orchestrate" && commandArgs[0] === "liveness") {
    return executeOrchestrateLiveness(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "orchestrate" && commandArgs[0] === "reply") {
    return executeOrchestrateReply(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "orchestrate" && commandArgs[0] === "change") {
    return executeOrchestrateChange(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "orchestrate" && commandArgs[0] === "close") {
    return executeOrchestrateClose(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "orchestrate" && commandArgs[0] === "stop") {
    return executeOrchestrateStop(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "orchestrate" && commandArgs[0] === "reconcile") {
    return executeOrchestrateReconcile(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "orchestrate" && commandArgs[0] === "prune") {
    return executeOrchestratePrune(commandArgs.slice(1), dependencies.environment);
  }
  if (command === "orchestrate" && (commandArgs[0] === "ack" || commandArgs[0] === "acknowledge")) {
    return executeOrchestrateAck(commandArgs.slice(1), dependencies.environment);
  }
  if (command === "fact") {
    return executeFact(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "worktree" && commandArgs[0] === "adopt") {
    return executeWorktreeAdopt(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "terminal" && commandArgs[0] === "list") {
    return executeTerminalList(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "worktree" && commandArgs[0] === "list") {
    return executeWorktreeList(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "received" || command === "ask" || command === "done") {
    return executeQueueWrite(command, commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  return Promise.resolve(failed(`unknown command: ${command ?? ""}`, 2));
}
