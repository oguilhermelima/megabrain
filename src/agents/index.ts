import { agy } from "./agy.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import type { Agent } from "./types.js";

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

export function resolveAgentDescriptor(descriptor: string): string | undefined {
  for (const agent of registry.values()) if (agent.matchesDescriptor(descriptor)) return agent.id;
  return undefined;
}

export type { Agent } from "./types.js";
