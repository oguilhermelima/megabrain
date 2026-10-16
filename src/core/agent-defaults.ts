import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

// Each agent's default model and effort, read from the agent's own config without changing it, and
// the shell a new terminal opens. A value the config does not set, or cannot be read, is null: the
// agent then picks its own default.

type Environment = Readonly<Record<string, string | undefined>>;

export type AgentDefault = { agent: "claude" | "codex" | "grok" | "agy"; model: string | null; effort: string | null };
export type AgentDefaults = { agents: AgentDefault[]; shell: string };

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const text = await readText(path);
  if (text === null) return {};
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/**
 * The string values of a TOML file by table ("" for the top level). Only `key = "text"` and
 * `key = 'text'` lines are read, which is all a default model or effort ever is.
 */
function tomlStrings(source: string): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>([["", new Map()]]);
  let table = "";
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^\[\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header !== null) {
      table = (header[1] ?? "").split(".").map((part) => part.trim().replace(/^"(.*)"$/, "$1")).join(".");
      if (!tables.has(table)) tables.set(table, new Map());
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (pair === null) continue;
    const value = pair[2] === undefined ? (pair[3] ?? "") : pair[2].replace(/\\(["\\])/g, "$1");
    tables.get(table)?.set(pair[1] ?? "", value);
  }
  return tables;
}

async function readToml(path: string): Promise<Map<string, Map<string, string>>> {
  return tomlStrings((await readText(path)) ?? "");
}

function home(environment: Environment): string {
  return environment.HOME ?? "";
}

async function claudeDefault(environment: Environment): Promise<AgentDefault> {
  const settings = await readJsonObject(join(environment.CLAUDE_CONFIG_DIR ?? join(home(environment), ".claude"), "settings.json"));
  return { agent: "claude", model: text(settings.model), effort: text(settings.effortLevel) };
}

async function codexDefault(environment: Environment): Promise<AgentDefault> {
  const config = await readToml(join(environment.CODEX_HOME ?? join(home(environment), ".codex"), "config.toml"));
  const top = config.get("") ?? new Map<string, string>();
  const profileName = text(top.get("profile"));
  const profile = profileName === null ? undefined : config.get(`profiles.${profileName}`);
  const value = (key: string) => text(profile?.get(key)) ?? text(top.get(key));
  return { agent: "codex", model: value("model"), effort: value("model_reasoning_effort") };
}

async function grokDefault(environment: Environment): Promise<AgentDefault> {
  const models = (await readToml(join(environment.GROK_HOME ?? join(home(environment), ".grok"), "config.toml"))).get("models");
  return { agent: "grok", model: text(models?.get("default")), effort: text(models?.get("default_reasoning_effort")) };
}

/** agy keeps one label, "Gemini 3.8 Flash (Medium)": the model, then its effort in parentheses. */
async function agyDefault(environment: Environment): Promise<AgentDefault> {
  const label = text((await readJsonObject(join(home(environment), ".gemini", "antigravity-cli", "settings.json"))).model);
  if (label === null) return { agent: "agy", model: null, effort: null };
  const split = /^(.*\S)\s*\(([^()]+)\)$/.exec(label);
  if (split === null) return { agent: "agy", model: label, effort: null };
  return { agent: "agy", model: split[1] ?? label, effort: (split[2] ?? "").trim().toLowerCase() };
}

/** The shell the app's terminal opens: SHELL, else sh. */
export function loginShellName(environment: Environment): string {
  const shell = text(environment.SHELL);
  return shell === null ? "sh" : basename(shell);
}

export async function readAgentDefaults(environment: Environment): Promise<AgentDefaults> {
  const agents = await Promise.all([claudeDefault(environment), codexDefault(environment), grokDefault(environment), agyDefault(environment)]);
  return { agents, shell: loginShellName(environment) };
}
