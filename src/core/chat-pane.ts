import type { ProcessAdapter } from "../adapters/proc.js";
import { failed, ok, type Result } from "./result.js";

export type ChatPaneState = "running" | "waiting_for_reply" | "done" | "stalled" | string;

export function chatPaneState(state: ChatPaneState): "working" | "question" | "finished" | "stuck" | "idle" {
  if (state === "running" || state === "spawning") return "working";
  if (state === "waiting_for_reply") return "question";
  if (state === "done") return "finished";
  if (state === "stalled") return "stuck";
  return "idle";
}

export async function setTmuxChatPane(pane: string, agent: string, chatName: string, state: ChatPaneState, process: ProcessAdapter): Promise<Result<void>> {
  const title = `${agent} · ${chatName}`;
  const settings: readonly (readonly string[])[] = [
    ["select-pane", "-t", pane, "-T", title],
    ["set-option", "-p", "-t", pane, "@megabrain_agent", agent],
    ["set-option", "-p", "-t", pane, "@megabrain_name", chatName],
    ["set-option", "-p", "-t", pane, "@megabrain_state", chatPaneState(state)],
  ];
  for (const args of settings) {
    const result = await process.run("tmux", args);
    if (result.kind !== "ok") return failed(result.kind === "failed" ? result.error : result.reason);
  }
  return ok(undefined);
}
