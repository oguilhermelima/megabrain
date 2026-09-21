import { agy } from "./agy.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { unavailableKey, type Agent, type InterruptKey, type SubmitKey } from "./types.js";
import type { Result } from "../core/result.js";

const registry = new Map<string, Agent>([
  [claude.id, claude],
  [codex.id, codex],
  [agy.id, agy],
]);

export function registerAgent(agent: Agent): void {
  registry.set(agent.id, agent);
}

export function unregisterAgent(agentId: string): void {
  registry.delete(agentId);
}

export function getAgent(agentId: string): Agent | undefined {
  return registry.get(agentId);
}

export function submitKey(agentId: string): Result<SubmitKey> {
  const agent = getAgent(agentId);
  return agent?.submitKey?.() ?? unavailableKey(agentId, "submit");
}

export function interruptKey(agentId: string): Result<InterruptKey> {
  const agent = getAgent(agentId);
  return agent?.interruptKey?.() ?? unavailableKey(agentId, "interrupt");
}

export function resolveAgentDescriptor(descriptor: string): string | undefined {
  for (const agent of registry.values()) if (agent.matchesDescriptor(descriptor)) return agent.id;
  return undefined;
}

export type { Agent, InterruptKey, SubmitKey } from "./types.js";
