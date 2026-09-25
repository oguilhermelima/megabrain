import packageJson from "../../package.json" with { type: "json" };
import { type ProcessAdapter } from "../adapters/proc.js";
import { failed, ok, type Result } from "../core/result.js";
import { ROOT_USAGE } from "../core/usage.js";
import { executeContext, type Environment } from "./commands/context.js";
import { executeCheck } from "./commands/check.js";
import { executeModel } from "./commands/model.js";
import { executeWeb } from "./commands/web.js";
import { executeNative } from "./commands/native.js";
import { executeTv } from "./commands/tv.js";
import { executeQueueWrite } from "./commands/queue-write.js";
import { executeOrchestrateList } from "./commands/orchestrate-list.js";
import { executeWorktreeList } from "./commands/worktree-list.js";
import { executeWorktreeAdopt } from "./commands/worktree-adopt.js";
import { executeWorktreeCreate, executeWorktreeFinish, executeWorktreePr } from "./commands/worktree-write.js";
import { executeTerminalList } from "./commands/terminal-list.js";
import { executeTerminalLifecycle } from "./commands/terminal-lifecycle.js";
import { executeOrchestrateAck, executeOrchestrateWatch } from "./commands/orchestrate-parent.js";
import { executeOrchestrateLiveness, executeOrchestrateRead } from "./commands/orchestrate-read-liveness.js";
import { executeOrchestrateChange, executeOrchestrateReply } from "./commands/orchestrate-reply.js";
import { executeOrchestrateClose } from "./commands/orchestrate-close.js";
import { executeOrchestrateReconcile, executeOrchestrateStop } from "./commands/orchestrate-stop-reconcile.js";
import { executeChain } from "./commands/chain.js";
import { executeOrchestratePrune } from "./commands/orchestrate-prune.js";
import { executeSpawn } from "./commands/orchestrate-spawn.js";
import { executeDoctor, executeInstall } from "./commands/install-doctor.js";
import { executeTmux } from "./commands/tmux.js";
import { executeChildAck } from "./commands/child-ack.js";
import { executeHookTurnEnd, readStdinText } from "./commands/hook-turn-end.js";
import { usageTable, usageText } from "../core/usage.js";

export type RouterDependencies = {
  readonly environment: Environment;
  readonly processAdapter: ProcessAdapter;
  // Only the turn-end hook reads stdin, and only lazily (see executeHookTurnEnd) — a default
  // reader is supplied here rather than at every call site so tests can inject a fake one.
  readonly readStdin?: () => Promise<string>;
};

export function route(
  args: readonly string[],
  dependencies: RouterDependencies,
): Promise<Result<string>> {
  const [command, ...commandArgs] = args;
  if (command === "__usage-table") return Promise.resolve(ok(usageTable()));
  if (command === undefined || command === "help" || command === "-h" || command === "--help") {
    return Promise.resolve(ok(ROOT_USAGE));
  }
  if (command === "version" || command === "-V" || command === "--version") {
    return Promise.resolve(ok(`megabrain ${packageJson.version}\n`));
  }
  const helpIndex = commandArgs.findIndex((argument) => argument === "-h" || argument === "--help");
  if (helpIndex === 0 && command === "worktree") {
    return Promise.resolve(ok(usageText("worktree")));
  }
  if (command === "context") {
    return executeContext(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "doctor") {
    return executeDoctor(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "install") {
    return executeInstall(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "check") {
    return executeCheck(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "model") {
    return executeModel(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "chain") {
    return executeChain(commandArgs, dependencies.environment, dependencies.processAdapter);
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
  if (command === "tmux") {
    return executeTmux(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "orchestrate" && commandArgs[0] === "list") {
    return executeOrchestrateList(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "orchestrate" && commandArgs[0] === "spawn") {
    return executeSpawn(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
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
    return executeOrchestratePrune(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "orchestrate" && (commandArgs[0] === "ack" || commandArgs[0] === "acknowledge")) {
    return executeOrchestrateAck(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "ack" || command === "acknowledge") {
    return executeChildAck(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "worktree" && commandArgs[0] === "adopt") {
    return executeWorktreeAdopt(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "terminal" && commandArgs[0] === "list") {
    return executeTerminalList(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "terminal" && ["create", "restart", "close"].includes(commandArgs[0] ?? "")) {
    return executeTerminalLifecycle(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "worktree" && commandArgs[0] === "list") {
    return executeWorktreeList(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "worktree" && commandArgs[0] === "create") { if (commandArgs.includes("-h") || commandArgs.includes("--help")) return Promise.resolve(ok(usageText("worktree-create"))); return executeWorktreeCreate(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter); }
  if (command === "worktree" && commandArgs[0] === "finish") { if (commandArgs.includes("-h") || commandArgs.includes("--help")) return Promise.resolve(ok(usageText("worktree-finish"))); return executeWorktreeFinish(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter); }
  if (command === "worktree" && (commandArgs[0] === "pr" || commandArgs[0] === "open-pr")) { if (commandArgs.includes("-h") || commandArgs.includes("--help")) return Promise.resolve(ok(usageText("worktree-pr"))); return executeWorktreePr(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter); }
  if (command === "received" || command === "ask" || command === "done") {
    return executeQueueWrite(command, commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "hook" && commandArgs[0] === "turn-end") {
    return executeHookTurnEnd(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter, dependencies.readStdin ?? readStdinText);
  }
  return Promise.resolve(failed(`unknown command: ${command}`, 2));
}
