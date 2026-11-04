import packageJson from "../../package.json" with { type: "json" };
import { type ProcessAdapter } from "../adapters/proc.js";
import { failed, ok, type Result } from "../core/result.js";
import { ROOT_USAGE } from "../core/usage.js";
import { executeContext, type Environment } from "./commands/context.js";
import { executeAgent } from "./commands/agent.js";
import { executeCheck } from "./commands/check.js";
import { executeModel } from "./commands/model.js";
import { executeWeb } from "./commands/web.js";
import { executeNative } from "./commands/native.js";
import { executeTv } from "./commands/tv.js";
import { executeQueueWrite, resolveSessionCaller } from "./commands/queue-write.js";
import { sendOperatorRefusal } from "../core/context.js";
import { executeOrchestrateList } from "./commands/orchestrate-list.js";
import { executeOrchestrateAdopt } from "./commands/orchestrate-adopt.js";
import { executeWorktreeList } from "./commands/worktree-list.js";
import { executeWorktreePrune } from "./commands/worktree-prune.js";
import { executeWorktreeAdopt } from "./commands/worktree-adopt.js";
import { executeWorktreeArchive, executeWorktreeArchived, executeWorktreeUnarchive } from "./commands/worktree-archive.js";
import { executeWorktreeCreate, executeWorktreeFinish, executeWorktreePr } from "./commands/worktree-write.js";
import { executeTerminalList } from "./commands/terminal-list.js";
import { executeTerminalDefault, executeTerminalOpen } from "./commands/terminal-open.js";
import { executeTerminalLifecycle } from "./commands/terminal-lifecycle.js";
import { executeOrchestrateAck, executeOrchestrateWatch } from "./commands/orchestrate-parent.js";
import { executeOrchestrateQueue } from "./commands/orchestrate-queue.js";
import { executeOrchestrateLiveness, executeOrchestrateRead } from "./commands/orchestrate-read-liveness.js";
import { executeOrchestrateTranscript } from "./commands/orchestrate-transcript.js";
import { executeOrchestrateGraph } from "./commands/orchestrate-graph.js";
import { executeOrchestrateChange, executeOrchestrateReply } from "./commands/orchestrate-reply.js";
import { executeOrchestrateClose } from "./commands/orchestrate-close.js";
import { executeOrchestrateKeepOpen } from "./commands/orchestrate-keep-open.js";
import { executeOrchestrateReconcile, executeOrchestrateStop } from "./commands/orchestrate-stop-reconcile.js";
import { executeChain } from "./commands/chain.js";
import { executeOrchestratePrune } from "./commands/orchestrate-prune.js";
import { executeSpawn } from "./commands/orchestrate-spawn.js";
import { executeOrchestratePolicy } from "./commands/orchestrate-policy.js";
import { executeDoctor, executeInstall } from "./commands/install-doctor.js";
import { executeDatabase } from "./commands/db.js";
import { executeTmux } from "./commands/tmux.js";
import { executeChildAck } from "./commands/child-ack.js";
import { executeHookTurnEnd, readStdinText } from "./commands/hook-turn-end.js";
import { executeHookPreTool } from "./commands/hook-pre-tool.js";
import { usageTable, usageText } from "../core/usage.js";
import { ensureAutomaticCutover } from "../db/cutover.js";
import { executeStack } from "./commands/stack.js";
import { executeSupervise, executeSupervisorWorker } from "./commands/supervise.js";
import { executeStatus } from "./commands/status.js";
import { executeResources } from "./commands/resources.js";
import { executeSettings } from "./commands/settings.js";
import { executeProc } from "../core/proc-runner.js";
import { executeRepository } from "./commands/repository.js";
import { executeSessions } from "./commands/sessions.js";
import { executeUsage } from "./commands/usage.js";
import { executeProjects } from "./commands/projects.js";
import { executeGithub } from "./commands/github.js";
import { executeCode } from "./commands/code.js";
import { executeApp } from "./commands/app.js";
import { executePort } from "./commands/port.js";
import { executeMaestro } from "./commands/maestro.js";
import { runCodeServerProxy } from "../core/code-server-proxy.js";
import { runCodeExtensionsSync } from "../core/code-extensions.js";
import { executeWorktreeHide } from "./commands/worktree-hide.js";
import { executeCommands } from "./commands/commands.js";
import { executeSession } from "./commands/session.js";
import { executeSend } from "./commands/send.js";
import { executeChat } from "./commands/chat.js";
import { executeKnowledge } from "./commands/knowledge.js";
import { executeSummaries } from "./commands/summaries.js";
import { executeArtifact } from "./commands/artifact.js";
import { executeHookSessionStart } from "./commands/hook-session-start.js";
import { runChatd } from "../chat/daemon.js";
import { inspectStateOwner, startStateOwner, stopStateOwner } from "../db/state-owner.js";
import { callStateOwner } from "../db/state-owner.js";
import { resolveStateDirectory } from "../core/state.js";

export type RouterDependencies = {
  readonly environment: Environment;
  readonly processAdapter: ProcessAdapter;
  // Only the hooks read stdin (turn-end lazily, see executeHookTurnEnd; pre-tool always) — a default
  // reader is supplied here rather than at every call site so tests can inject a fake one.
  readonly readStdin?: () => Promise<string>;
};

// The orchestrate verbs that historically accepted --operator.
const operatorVerbs = new Set(["reply", "change", "stop", "close", "ack", "read", "transcript", "liveness", "policy", "reconcile", "queue"]);

// --operator remains accepted on its existing orchestrate verbs for compatibility, but it no
// longer changes caller identity or grants access. `send` keeps its distinct sender/channel mode.
export async function route(
  args: readonly string[],
  dependencies: RouterDependencies,
): Promise<Result<string>> {
  const { MEGABRAIN_OPERATOR: _inherited, ...environment } = dependencies.environment;
  if (!args.includes("--operator")) return safeRouteCommand(args, { ...dependencies, environment });
  const [command, verb] = args;
  if (command === "send") {
    const refusal = sendOperatorRefusal(environment.MEGABRAIN_DISPATCH_ID, await resolveSessionCaller(environment, dependencies.processAdapter));
    if (refusal !== undefined) return failed(refusal, 2);
    return safeRouteCommand(args.filter((arg) => arg !== "--operator"), { ...dependencies, environment: { ...environment, MEGABRAIN_OPERATOR: "1" } });
  }
  if (command !== "orchestrate" || verb === undefined || !operatorVerbs.has(verb)) {
    return failed(`--operator is not accepted by megabrain ${[command, verb].filter((part) => part !== undefined && !part.startsWith("-")).join(" ")}; it applies to send and orchestrate ${[...operatorVerbs].join(", ")}`, 2);
  }
  return safeRouteCommand(args.filter((arg) => arg !== "--operator"), { ...dependencies, environment });
}

function oneLine(message: string): string {
  return message.split(/\r?\n/, 1)[0] || "command failed";
}

async function safeRouteCommand(args: readonly string[], dependencies: RouterDependencies): Promise<Result<string>> {
  try {
    const result = await routeCommand(args, dependencies);
    if (result.kind === "failed" && isSettingsWrite(args)) return { ...result, error: oneLine(result.error) };
    return result;
  } catch (cause: unknown) {
    return failed(oneLine(cause instanceof Error ? cause.message : String(cause)));
  }
}

function isSettingsWrite(args: readonly string[]): boolean {
  const [command, verb, ...rest] = args;
  if (command === "resources") return verb === "enable" || verb === "disable" || verb === "policy" && rest[0] !== "show";
  if (command === "supervise") return args.length === 0 || args.length === 1 && args[0] === "--stop";
  if (command === "chain") return verb === "save" || verb === "delete" || verb === "limits" && rest.some((arg) => ["--enable", "--disable", "--notice-on", "--notice-off", "--notice-interval"].includes(arg));
  if (command === "model") return verb === "refresh";
  if (command === "settings") return verb === "set";
  if (command === "terminal") return verb === "default" && rest.length > 0;
  return false;
}

async function routeCommand(
  args: readonly string[],
  dependencies: RouterDependencies,
): Promise<Result<string>> {
  const [command, ...commandArgs] = args;
  if (command === "__chatd") {
    const stateDir = dependencies.environment.MEGABRAIN_CHATD_STATE_DIR;
    if (!stateDir) return failed("chatd requires MEGABRAIN_CHATD_STATE_DIR", 2);
    await runChatd(stateDir);
    return ok("");
  }
  if (command === "__state-owner") {
    const stateDir = dependencies.environment.MEGABRAIN_STATE_OWNER_DIR;
    if (!stateDir) return failed("state owner requires MEGABRAIN_STATE_OWNER_DIR", 2);
    let owner;
    try { owner = await startStateOwner(stateDir); }
    catch (cause: unknown) {
      if (/state owner is already running/.test(cause instanceof Error ? cause.message : String(cause)) && (await inspectStateOwner(stateDir)).running) return ok("");
      throw cause;
    }
    let stopping = false;
    let exitBackstop: ReturnType<typeof setTimeout> | undefined;
    const armExitBackstop = () => {
      if (exitBackstop !== undefined) return;
      exitBackstop = setTimeout(() => process.exit(0), 1_500);
      exitBackstop.unref?.();
    };
    owner.onStopped = armExitBackstop;
    if (owner.stopped) armExitBackstop();
    const stop = () => {
      if (stopping) return;
      stopping = true;
      armExitBackstop();
      void stopStateOwner(owner).catch((cause: unknown) => {
        process.stderr.write(`state owner shutdown failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exit(1);
      });
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    return new Promise<Result<string>>(() => undefined);
  }
  if (command === "__code-server-proxy") return runCodeServerProxy(commandArgs, dependencies.environment);
  if (command === "__code-extensions") return runCodeExtensionsSync(commandArgs, dependencies.environment, dependencies.processAdapter);
  if (command === "__delivery-worker") {
    const id = commandArgs[0];
    if (!id) return failed("delivery worker requires an outbox id", 2);
    try { await callStateOwner(resolveStateDirectory(dependencies.environment), { operation: "resume-outbox", id }); return ok("delivery scheduled by state owner\n"); }
    catch (cause: unknown) { return failed(`state owner could not schedule delivery: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  if (command === "__delivery-verify" || command === "__peer-verify") {
    const id = commandArgs[0];
    if (!id) return failed("delivery verification worker requires an outbox id", 2);
    try { await callStateOwner(resolveStateDirectory(dependencies.environment), { operation: "resume-verification", id }); return ok("peer verification scheduled by state owner\n"); }
    catch (cause: unknown) { return failed(`state owner could not schedule peer verification: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  if (command === "__supervise-worker") return executeSupervisorWorker(commandArgs, dependencies.environment, dependencies.processAdapter);
  if (command === "__usage-table") return Promise.resolve(ok(usageTable()));
  if (command === undefined || command === "help" || command === "-h" || command === "--help") {
    return Promise.resolve(ok(ROOT_USAGE));
  }
  if (command === "version" || command === "-V" || command === "--version") {
    return ok(`megabrain ${packageJson.version}\n`);
  }
  const knownCommands = new Set(["context", "doctor", "db", "install", "check", "model", "chain", "web", "native", "tv", "tmux", "orchestrate", "ack", "acknowledge", "worktree", "stack", "terminal", "received", "ask", "done", "hook", "supervise", "resources", "proc", "status", "repo", "projects", "github", "settings", "code", "app", "send", "session", "commands", "chat", "agent", "sessions", "port", "usage", "maestro", "summaries", "knowledge", "artifact"]);
  if (!knownCommands.has(command)) return failed(`unknown command: ${command}`, 2);
  const statelessCommand = command === "context" || command === "port" || command === "agent" || command === "web" || command === "tv" || command === "tmux" || command === "chat" || command === "summaries" || command === "knowledge" || command === "artifact" || command === "sessions" || command === "settings" && (commandArgs[0] === "get" || commandArgs[0] === "set" && commandArgs[1] === "terminal-engine");
  if (!statelessCommand && command !== "db" && !commandArgs.includes("-h") && !commandArgs.includes("--help")) {
    const cutover = await ensureAutomaticCutover(dependencies.environment);
    if (cutover.kind !== "ok") return failed(cutover.error, cutover.exitCode);
    if (cutover.value?.snapshot !== undefined && cutover.value.snapshot !== null) {
      process.stderr.write(`migrated legacy JSON state to SQLite; snapshot: ${cutover.value.snapshot}\n`);
    }
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
  if (command === "db") {
    return Promise.resolve(executeDatabase(commandArgs, dependencies.environment));
  }
  if (command === "install") {
    return executeInstall(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "check") {
    return executeCheck(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "supervise") return executeSupervise(commandArgs, dependencies.environment, dependencies.processAdapter);
  if (command === "status") return executeStatus(commandArgs, dependencies.environment, dependencies.processAdapter);
  if (command === "resources") return executeResources(commandArgs, dependencies.environment, dependencies.processAdapter);
  if (command === "settings") return executeSettings(commandArgs, dependencies.environment, dependencies.processAdapter);
  if (command === "summaries") return executeSummaries(commandArgs, dependencies.environment);
  if (command === "knowledge") return executeKnowledge(commandArgs, dependencies.environment);
  if (command === "artifact") return executeArtifact(commandArgs, dependencies.environment);
  if (command === "chat") return executeChat(commandArgs, dependencies.environment, dependencies.processAdapter);
  if (command === "session") return executeSession(commandArgs, dependencies.environment, dependencies.processAdapter);
  if (command === "send") return executeSend(commandArgs, dependencies.environment, dependencies.processAdapter);
  if (command === "proc") return executeProc(commandArgs, dependencies.environment, dependencies.processAdapter);
  if (command === "repo") return executeRepository(commandArgs, dependencies.environment, dependencies.processAdapter);
  if (command === "projects") return executeProjects(commandArgs, dependencies.environment, dependencies.processAdapter);
  if (command === "github") return executeGithub(commandArgs, dependencies.environment, dependencies.processAdapter);
  if (command === "maestro") return executeMaestro(commandArgs, dependencies.environment, dependencies.processAdapter, (text) => { process.stdout.write(text); });
  if (command === "port") return executePort(commandArgs, dependencies.environment, dependencies.processAdapter);
  if (command === "code") return executeCode(commandArgs, dependencies.environment, dependencies.processAdapter);
  if (command === "app") return executeApp(commandArgs, dependencies.environment, dependencies.processAdapter);
  if (command === "sessions") return executeSessions(commandArgs, dependencies.environment);
  if (command === "usage") return executeUsage(commandArgs, dependencies.environment);
  if (command === "agent") return executeAgent(commandArgs, dependencies.environment, dependencies.processAdapter);
  if (command === "commands") return executeCommands(commandArgs, dependencies.environment);
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
  if (command === "orchestrate" && commandArgs[0] === "graph") {
    return executeOrchestrateGraph(commandArgs.slice(1), dependencies.environment);
  }
  if (command === "orchestrate" && commandArgs[0] === "adopt") {
    return executeOrchestrateAdopt(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "orchestrate" && commandArgs[0] === "spawn") {
    return executeSpawn(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "orchestrate" && commandArgs[0] === "policy") {
    return executeOrchestratePolicy(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "orchestrate" && commandArgs[0] === "watch") {
    return executeOrchestrateWatch(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "orchestrate" && commandArgs[0] === "queue") {
    return executeOrchestrateQueue(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "orchestrate" && commandArgs[0] === "read") {
    return executeOrchestrateRead(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "orchestrate" && commandArgs[0] === "transcript") {
    return executeOrchestrateTranscript(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
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
  if (command === "orchestrate" && commandArgs[0] === "keep-open") {
    return executeOrchestrateKeepOpen(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
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
  if (command === "worktree" && commandArgs[0] === "prune") {
    return executeWorktreePrune(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "terminal" && commandArgs[0] === "list") {
    return executeTerminalList(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "terminal" && commandArgs[0] === "open") {
    return executeTerminalOpen(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "terminal" && commandArgs[0] === "default") {
    return executeTerminalDefault(commandArgs.slice(1), dependencies.environment);
  }
  if (command === "terminal" && ["create", "restart", "close"].includes(commandArgs[0] ?? "")) {
    return executeTerminalLifecycle(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "worktree" && (commandArgs[0] === "archive" || commandArgs[0] === "archived" || commandArgs[0] === "unarchive")) {
    if (commandArgs.includes("-h") || commandArgs.includes("--help")) return Promise.resolve(ok(usageText(`worktree-${commandArgs[0]}`)));
    const execute = commandArgs[0] === "archive" ? executeWorktreeArchive : commandArgs[0] === "archived" ? executeWorktreeArchived : executeWorktreeUnarchive;
    return execute(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "worktree" && commandArgs[0] === "list") {
    return executeWorktreeList(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter);
  }
  if (command === "worktree" && (commandArgs[0] === "hide" || commandArgs[0] === "unhide")) return executeWorktreeHide(commandArgs.slice(1), dependencies.environment, commandArgs[0] === "hide");
  if (command === "worktree" && commandArgs[0] === "create") { if (commandArgs.includes("-h") || commandArgs.includes("--help")) return Promise.resolve(ok(usageText("worktree-create"))); return executeWorktreeCreate(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter); }
  if (command === "worktree" && commandArgs[0] === "finish") { if (commandArgs.includes("-h") || commandArgs.includes("--help")) return Promise.resolve(ok(usageText("worktree-finish"))); return executeWorktreeFinish(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter); }
  if (command === "worktree" && (commandArgs[0] === "pr" || commandArgs[0] === "open-pr")) { if (commandArgs.includes("-h") || commandArgs.includes("--help")) return Promise.resolve(ok(usageText("worktree-pr"))); return executeWorktreePr(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter); }
  if (command === "stack") {
    if (commandArgs.includes("-h") || commandArgs.includes("--help")) return Promise.resolve(ok(usageText("stack")));
    return executeStack(commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "received" || command === "ask" || command === "done") {
    return executeQueueWrite(command, commandArgs, dependencies.environment, dependencies.processAdapter);
  }
  if (command === "hook" && commandArgs[0] === "pre-tool") {
    return executeHookPreTool(commandArgs.slice(1), dependencies.environment, dependencies.readStdin ?? readStdinText);
  }
  if (command === "hook" && commandArgs[0] === "session-start") {
    return executeHookSessionStart(commandArgs.slice(1), dependencies.environment, dependencies.readStdin ?? readStdinText);
  }
  if (command === "hook" && commandArgs[0] === "turn-end") {
    return executeHookTurnEnd(commandArgs.slice(1), dependencies.environment, dependencies.processAdapter, dependencies.readStdin ?? readStdinText);
  }
  return Promise.resolve(failed(`unknown command: ${command}`, 2));
}
