import { guardedOpenDatabase } from "./state-db-guard.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { appendMessage, listMessages } from "../../src/adapters/state-db.js";
import { executeSpawn, type SpawnDependencies, type SpawnWorktree } from "../../src/cli/commands/orchestrate-spawn.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import { getTmux, registerTmux } from "../../src/hosts/tmux.js";
import { readDispatchFixture } from "./state-fixture.js";
import { composerPane, type ComposerPane, type ComposerPaneOptions } from "./composer-tmux.js";

export type Call = Readonly<{ command: string; args: readonly string[] }>;

export const existingWorktree: SpawnWorktree = { path: "/work/tree", branch: "feat/example", ownership: "existing", workspaceId: "workspace-1" };

export type DetachedBehavior = (command: string, args: readonly string[]) => Result<{ readonly pid: number }>;

export function processFor(behavior?: (command: string, args: readonly string[]) => Result<ProcessOutput> | Promise<Result<ProcessOutput>>, detached?: DetachedBehavior): ProcessAdapter & { readonly calls: Call[] } {
  const calls: Call[] = [];
  const fallback = (command: string, args: readonly string[]): Result<ProcessOutput> => {
    if (command === "tmux" && args[0] === "list-panes") return ok({ stdout: "%9\n", stderr: "", exitCode: 0 });
    return ok({ stdout: "", stderr: "", exitCode: 0 });
  };
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      const result = (await behavior?.(command, args)) ?? fallback(command, args);
      // A host terminal read that says nothing is answered with an idle composer, as in spawn.test.ts.
      if (command === "orca" && args[0] === "terminal" && args[1] === "read" && result.kind === "ok" && result.value.stdout === "") {
        return ok({ stdout: JSON.stringify({ result: { terminal: { tail: ["› Ask Codex to do anything", "❯"] } } }), stderr: "", exitCode: 0 });
      }
      return result;
    },
    async startDetached(command, args) { return detached === undefined ? failed("not used") : detached(command, args); },
    invocationCount() { return calls.length; },
  };
}

export function spawnEnvironment(root: string, dispatchId: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    MEGABRAIN_STATE_DIR: root,
    MEGABRAIN_SESSION_ID: "parent-terminal",
    MEGABRAIN_SESSION_HOST: "tmux",
    MEGABRAIN_SPAWN_DISPATCH_ID: dispatchId,
    MEGABRAIN_PROMPT_VERIFY_TIMEOUT_MS: "300",
    MEGABRAIN_PROMPT_SUBMIT_TIMEOUT_MS: "300",
    // No fake here starts an agent, so the brief can only arrive through the paste fallback.
    MEGABRAIN_PROMPT_ARGV_GRACE_MS: "0",
    ...extra,
  };
}

export function appendReceived(root: string, dispatchId: string): void {
  const opened = guardedOpenDatabase({ MEGABRAIN_STATE_DIR: root });
  if (opened.kind !== "ok") throw new Error(opened.error);
  try {
    const result = appendMessage(opened.value, dispatchId, { from: "child", type: "received", text: "prompt received", sessionId: "child-terminal" });
    if (result.kind !== "ok") throw new Error(result.error);
  } finally {
    opened.value.close();
  }
}

export function dispatchMessages(root: string, dispatchId: string): readonly { readonly from: string; readonly type: string; readonly text: string }[] {
  const opened = guardedOpenDatabase({ MEGABRAIN_STATE_DIR: root });
  if (opened.kind !== "ok") throw new Error(opened.error);
  try {
    const listed = listMessages(opened.value, dispatchId);
    if (listed.kind !== "ok") throw new Error(listed.error);
    return listed.value.map((message) => ({ from: String(message.from), type: String(message.type), text: String(message.text ?? "") }));
  } finally {
    opened.value.close();
  }
}

export function readMeta(root: string, dispatchId: string): Record<string, unknown> {
  return readDispatchFixture(root, dispatchId).meta as Record<string, unknown>;
}

export type SpawnRun = Readonly<{
  result: Result<string>;
  pane: ComposerPane;
  events: string[];
  root: string;
  dispatchId: string;
  process: ReturnType<typeof processFor>;
}>;

// Runs one tmux spawn of a stand-in agent whose composer is the stateful pane above.
export async function runComposerSpawn(
  dispatchId: string,
  pane: Omit<ComposerPaneOptions, "events" | "onSubmit"> & { readonly onSubmit?: (prompt: string, root: string) => void },
  environmentExtra: Record<string, string> = {},
  extraArgs: readonly string[] = [],
  behavior?: (command: string, args: readonly string[]) => Result<ProcessOutput> | Promise<Result<ProcessOutput>>,
  dependencies: Partial<SpawnDependencies> = {},
  detached?: DetachedBehavior,
): Promise<SpawnRun> {
  const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-composer-`);
  const events: string[] = [];
  const composer = composerPane({ ...pane, events, onSubmit: (prompt) => pane.onSubmit?.(prompt, root) });
  const original = getTmux();
  const process = processFor(behavior, detached);
  registerTmux({
    ...original,
    id: "tmux",
    paneExists: async () => ok(true),
    sessionExists: async () => ok(true),
    panesForSession: async () => ok(["%9"]),
    capturePane: composer.provider.capturePane,
    sendText: composer.provider.sendText,
    pasteText: composer.provider.pasteText,
    sendKey: composer.provider.sendKey,
  } as typeof original);
  try {
    const result = await executeSpawn(
      ["--worktree", "/work/tree", "--agent", pane.agent, "--prompt", "do the task\nsecond line", "--tmux", "true", ...extraArgs],
      spawnEnvironment(root, dispatchId, environmentExtra),
      process,
      { resolveWorktree: async () => ok(existingWorktree), ...dependencies },
    );
    return { result, pane: composer, events, root, dispatchId, process };
  } finally {
    registerTmux(original);
  }
}

export async function cleanupRun(run: SpawnRun): Promise<void> {
  await rm(run.root, { recursive: true, force: true });
}
