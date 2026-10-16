import type { ChatEvent } from "./store.js";

// What each agent says about the subagents it runs, read the same way from its live protocol and from
// its own session log. Claude runs one per Agent (formerly Task) tool call, identified by that call's
// id; Codex runs one per spawned thread, identified by the thread id, through collab tool call items
// (camelCase from the app-server, snake_case in a rollout).

export type Subagent = NonNullable<ChatEvent["subagent"]>;
export type SubagentStatus = NonNullable<Subagent["status"]>;
export type SubagentEnd = { id: string; status: SubagentStatus; text: string };

function object(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function flatten(value: unknown): string { return Array.isArray(value) ? value.map((part) => text(object(part).text)).join("") : text(value); }

export function isClaudeSubagentTool(name: string): boolean { return name === "Agent" || name === "Task"; }

/** The subagent an Agent call starts; Claude runs general-purpose when the call names no type. */
export function claudeSubagent(id: string, input: unknown): Subagent {
  const fields = object(input);
  return { id, type: text(fields.subagent_type) || "general-purpose", description: text(fields.description) };
}

/** How an Agent call's tool result ends its subagent; null when it only says a background run launched. */
export function claudeHandBack(id: string, block: Record<string, unknown>, toolUseResult: unknown): SubagentEnd | null {
  const result = object(toolUseResult);
  if (result.status === "async_launched") return null;
  // The block wraps the report in a hand-back note for the model; the structured result holds it bare.
  const report = Array.isArray(result.content) ? flatten(result.content) : flatten(block.content);
  const status: SubagentStatus = block.is_error === true || result.status === "failed" ? "failed" : result.status === "killed" || result.status === "stopped" ? "stopped" : "completed";
  return { id, status, text: report };
}

/** A background subagent's end, from Claude's task_notification. */
export function claudeNotified(notification: Record<string, unknown>): SubagentEnd {
  const status = text(notification.status);
  return { id: text(notification.tool_use_id), status: status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped", text: text(notification.summary) };
}

const isCollab = (item: Record<string, unknown>) => text(item.type).toLowerCase() === "collabagenttoolcall";

/** The threads a Codex spawn started, each named by its nickname when the record has one. */
export function codexSpawned(item: Record<string, unknown>): Subagent[] {
  const tool = text(item.tool);
  if (!isCollab(item) || (tool !== "spawnAgent" && tool !== "spawn_agent")) return [];
  const receivers = item.receiver_thread_ids ?? item.receiverThreadIds;
  const nicknames = new Map<string, string>();
  for (const agent of Array.isArray(item.receiver_agents ?? item.receiverAgents) ? (item.receiver_agents ?? item.receiverAgents) as unknown[] : []) {
    const fields = object(agent);
    const nickname = text(fields.agent_nickname ?? fields.agentNickname);
    if (nickname !== "") nicknames.set(text(fields.thread_id ?? fields.threadId), nickname);
  }
  return (Array.isArray(receivers) ? receivers : []).filter((id): id is string => typeof id === "string" && id !== "").map((id) => {
    const nickname = nicknames.get(id);
    return { id, ...(nickname === undefined ? {} : { type: nickname }), description: text(item.prompt) };
  });
}

const ended: Record<string, SubagentStatus> = { completed: "completed", errored: "failed", interrupted: "stopped", shutdown: "stopped", notfound: "stopped" };

/**
 * The threads a collab call reports as finished. The app-server gives each state as { status, message };
 * a rollout as a bare status ("running") or as { <status>: message }.
 */
export function codexEnded(item: Record<string, unknown>): SubagentEnd[] {
  if (!isCollab(item)) return [];
  const ends: SubagentEnd[] = [];
  for (const [id, state] of Object.entries(object(item.agents_states ?? item.agentsStates))) {
    const fields = object(state);
    const [status, message] = typeof state === "string" ? [state, ""] : "status" in fields ? [text(fields.status), text(fields.message)] : [Object.keys(fields)[0] ?? "", text(Object.values(fields)[0])];
    const outcome = ended[status.replace(/_/g, "").toLowerCase()];
    if (outcome !== undefined) ends.push({ id, status: outcome, text: message });
  }
  return ends;
}
