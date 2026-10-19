import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { failed, ok, type Result } from "./result.js";

// The desktop app's agents, as `settings get|set agents` reads and replaces them in
// agent-settings.json: the one New chat starts with (null: the one used last), the ones turned off
// for the app, and the mode each agent's new chats open in. Only a mode the person chose is saved.
export const DESKTOP_AGENTS = ["claude", "codex", "grok", "agy"];
export type ChatMode = "chat" | "terminal";
export type AgentSettings = { version: 1; default: string | null; disabled: string[]; modes?: Record<string, ChatMode> };
export const emptyAgentSettings: AgentSettings = { version: 1, default: null, disabled: [] };
export const agentSettingsFile = "agent-settings.json";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

export function parseAgentSettings(raw: string): Result<AgentSettings> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return failed("agents: not valid JSON", 2); }
  if (!isRecord(value) || Object.keys(value).some((key) => !["version", "default", "disabled", "modes"].includes(key)) || value.version !== 1 || !("default" in value)) return failed("agents: expected { version: 1, default, disabled, modes? }", 2);
  if (!isStringList(value.disabled)) return failed("agents: disabled must be a list of agents", 2);
  const unknown = [value.default, ...value.disabled].find((agent) => agent !== null && !DESKTOP_AGENTS.includes(agent as string));
  if (unknown !== undefined) return failed(`agents: unknown agent ${String(unknown)} (expected ${DESKTOP_AGENTS.join(", ")})`, 2);
  if (typeof value.default === "string" && value.disabled.includes(value.default)) return failed(`agents: the default ${value.default} is turned off`, 2);
  if (value.modes !== undefined && !isRecord(value.modes)) return failed("agents: modes must map an agent to chat or terminal", 2);
  for (const [agent, mode] of Object.entries(value.modes ?? {})) {
    if (!DESKTOP_AGENTS.includes(agent)) return failed(`agents: unknown agent ${agent} in modes (expected ${DESKTOP_AGENTS.join(", ")})`, 2);
    if (mode !== "chat" && mode !== "terminal") return failed(`agents: mode for ${agent} must be chat or terminal`, 2);
  }
  return ok({ version: 1, default: value.default as string | null, disabled: [...new Set(value.disabled)], ...(value.modes === undefined ? {} : { modes: value.modes as Record<string, ChatMode> }) });
}

/** The mode a new chat of this agent opens in: the saved one, else chat; agy has only its terminal for now. */
export function startMode(settings: AgentSettings, agent: string): ChatMode {
  if (agent === "agy") return "terminal";
  return settings.modes?.[agent] ?? "chat";
}

/** The saved settings in a state directory; nothing saved, or a damaged file, reads as none. */
export async function readAgentSettings(stateDirectory: string): Promise<AgentSettings> {
  try {
    const parsed = parseAgentSettings(await readFile(join(stateDirectory, agentSettingsFile), "utf8"));
    return parsed.kind === "ok" ? parsed.value : emptyAgentSettings;
  } catch {
    return emptyAgentSettings;
  }
}
