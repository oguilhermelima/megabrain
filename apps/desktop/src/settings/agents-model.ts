// The Agents page: which agent CLIs this machine has, the command each one starts with, which are
// turned on for the app, the one New chat starts with, and whether each one's new chats open as a
// chat or in its terminal. The choice is stored by the CLI (`settings get|set agents`) as
// { version: 1, default, disabled, modes }; default null is Auto, the agent used last, and modes
// holds only the modes the person chose.

export const AGENT_IDS = ['claude', 'codex', 'grok', 'agy'] as const

export interface AgentSettings {
  version: 1
  default: string | null
  disabled: string[]
  modes: Partial<Record<string, ChatMode>>
}

export type ChatMode = 'chat' | 'terminal'

export const defaultAgentSettings: AgentSettings = { version: 1, default: null, disabled: [], modes: {} }

const known = (value: unknown): value is string => typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value)

/** Reads what `settings get agents` printed; anything unusable falls back field by field. */
export function parseAgentSettings(value: unknown): AgentSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return defaultAgentSettings
  const record = value as Record<string, unknown>
  const disabled = Array.isArray(record.disabled) ? [...new Set(record.disabled.filter(known))] : []
  const chosen = known(record.default) && !disabled.includes(record.default) ? record.default : null
  const saved = typeof record.modes === 'object' && record.modes !== null && !Array.isArray(record.modes) ? Object.entries(record.modes as Record<string, unknown>) : []
  const modes: Partial<Record<string, ChatMode>> = {}
  for (const [agent, mode] of saved) if (known(agent) && (mode === 'chat' || mode === 'terminal')) modes[agent] = mode
  return { version: 1, default: chosen, disabled, modes }
}

export function serialiseAgentSettings(settings: AgentSettings): string {
  return JSON.stringify({ version: 1, default: settings.default, disabled: settings.disabled, modes: settings.modes })
}

/** The mode a new chat of this agent opens in: the one chosen, else chat. */
export function agentMode(settings: AgentSettings, agent: string): ChatMode {
  return settings.modes[agent] ?? 'chat'
}

export function withMode(settings: AgentSettings, agent: string, mode: ChatMode): AgentSettings {
  return { ...settings, modes: { ...settings.modes, [agent]: mode } }
}

/** Turning the default off leaves Auto. */
export function withEnabled(settings: AgentSettings, agent: string, enabled: boolean): AgentSettings {
  const disabled = settings.disabled.filter((item) => item !== agent)
  if (enabled) return { ...settings, disabled }
  return { ...settings, default: settings.default === agent ? null : settings.default, disabled: [...disabled, agent] }
}

/** The default is always on; null is Auto. */
export function withDefault(settings: AgentSettings, agent: string | null): AgentSettings {
  return { ...settings, default: agent, disabled: agent === null ? settings.disabled : settings.disabled.filter((item) => item !== agent) }
}

export const agentNames: Record<string, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok', agy: 'agy' }

export interface AgentRow {
  agent: string
  label: string
  installed: boolean
  enabled: boolean
  isDefault: boolean
  /** Whether its new chats open as a chat or in its terminal. */
  mode: ChatMode
  /** The command line it starts with; undefined while it loads, null when the CLI cannot give one. */
  command: string | null | undefined
}

/** One row per agent in a fixed order; without the install report every agent is listed, none installed. */
export function agentRows(plan: readonly { agent: string; label: string; installed: boolean }[] | null, settings: AgentSettings, commands: Readonly<Record<string, string[] | null | undefined>>): AgentRow[] {
  return AGENT_IDS.map((agent) => {
    const entry = plan?.find((item) => item.agent === agent)
    const argv = commands[agent]
    return {
      agent,
      label: entry?.label ?? agentNames[agent] ?? agent,
      installed: entry?.installed ?? false,
      enabled: !settings.disabled.includes(agent),
      isDefault: settings.default === agent,
      mode: agentMode(settings, agent),
      command: argv === undefined ? undefined : argv === null ? null : commandLine(argv),
    }
  })
}

/** An argv as a shell would take it, quoting only the arguments that need it. */
export function commandLine(argv: readonly string[]): string {
  return argv.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`)).join(' ')
}
