import type { AgentDefaults, MessagePart, TerminalEngine } from '@/api/schema'
import { messagePartsToText } from '@/chat/composer-parts'

// The launcher on the center screen: a tile per way to start work in a worktree, and what each does.

export type ChatAgent = 'claude' | 'codex' | 'grok' | 'agy'
export type LaunchTileId = 'terminal' | ChatAgent

export interface LaunchTile {
  id: LaunchTileId
  label: string
  enabled: boolean
  /** Why the tile is disabled; null when it is not. */
  hint: string | null
}

const tiles: { id: LaunchTileId; label: string }[] = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'grok', label: 'Grok' },
  { id: 'agy', label: 'agy' },
]

const joined = (parts: (string | null)[]) => parts.filter((part) => part !== null).join(' · ')

/**
 * What an agent row says it will start with: the model picked in the composer for the selected
 * agent, else the default its own config sets, else just its default.
 */
export function agentDetail(agent: LaunchTileId, picked: { model: string; effort: string | null } | null, defaults: AgentDefaults | null): string {
  if (picked !== null) return joined([picked.model, picked.effort])
  const configured = defaults?.agents.find((entry) => entry.agent === agent)
  const text = configured === undefined ? '' : joined([configured.model, configured.effort])
  return text === '' ? 'Default model' : text
}

/** The New terminal row: the shell it opens, before the report "Login shell", then the worktree. */
export function terminalDetail(shell: string | null, worktree: string): string {
  return `${shell ?? 'Login shell'} · ${worktree}`
}

/**
 * Every tile in order; an agent the install report does not show as installed, or one turned off in
 * Settings > Agents, is disabled. A null report: none yet, so only the turned-off ones are.
 */
export function launchTiles(agents: readonly { agent: string; installed: boolean }[] | null, turnedOff: readonly string[] = []): LaunchTile[] {
  return tiles.map(({ id, label }) => {
    const installed = id === 'terminal' || agents === null || agents.some((entry) => entry.agent === id && entry.installed)
    if (!installed) return { id, label, enabled: false, hint: `${label} is not installed on this machine` }
    if (turnedOff.includes(id)) return { id, label, enabled: false, hint: `${label} is turned off in Settings > Agents` }
    return { id, label, enabled: true, hint: null }
  })
}

/**
 * The default agent from Settings > Agents while it is enabled, else the agent used last while it
 * is, else the first enabled agent, else the terminal. The terminal opens at once instead of being
 * selected, so it is never the one remembered.
 */
export function initialTile(remembered: string | null, list: LaunchTile[], preferred: string | null = null): LaunchTileId {
  const usable = (id: string | null) => list.find((item) => item.id === id && item.id !== 'terminal' && item.enabled)
  const found = usable(preferred) ?? usable(remembered)
  if (found !== undefined) return found.id
  return list.find((item) => item.id !== 'terminal' && item.enabled)?.id ?? 'terminal'
}

export type LaunchPlan =
  | { kind: 'chat'; agent: ChatAgent; cwd: string; model: string | null; effort: string | null; parts: MessagePart[] }
  /** engine null: the one the settings choose, read when the terminal opens. */
  | { kind: 'terminal'; engine: TerminalEngine | null; cwd: string; firstInput: string | null }
  /** An agent's own TUI, resuming a past session by its id. */
  | { kind: 'agent-terminal'; agent: ChatAgent; engine: 'tmux'; cwd: string; model: string | null; effort: string | null; firstInput: string | null; resume?: string }

export interface LaunchInput {
  cwd: string
  parts: MessagePart[]
  model: string | null
  effort: string | null
  /** The terminal engine chosen in settings. */
  engine: TerminalEngine
}

/**
 * Every agent starts a native chat. The terminal opens the login shell with the settings engine and
 * takes typed text as its first input, left unsent.
 */
export function launchPlan(tile: LaunchTileId, { cwd, parts, model, effort, engine }: LaunchInput): LaunchPlan {
  if (tile !== 'terminal') return { kind: 'chat', agent: tile, cwd, model, effort, parts }
  const text = messagePartsToText(parts)
  return { kind: 'terminal', engine, cwd, firstInput: text.trim() === '' ? null : text }
}

export interface ChatStart {
  agent: ChatAgent
  cwd: string
  model?: string
  effort?: string
  parts?: MessagePart[]
}

/**
 * The one `chat start` a chat plan makes, carrying the model, the effort and the first message, so
 * chatd spawns the agent once with all of them.
 */
export function chatStart(plan: Extract<LaunchPlan, { kind: 'chat' }>): ChatStart {
  return {
    agent: plan.agent,
    cwd: plan.cwd,
    ...(plan.model === null ? {} : { model: plan.model }),
    ...(plan.effort === null ? {} : { effort: plan.effort }),
    ...(plan.parts.length === 0 ? {} : { parts: plan.parts }),
  }
}

/** The worktree the launcher opens on: the one clicked, else the last used, else the first listed. */
export function launchWorktree(clicked: string | null, lastUsed: string | null, available: readonly string[]): string | null {
  if (clicked !== null && available.includes(clicked)) return clicked
  if (lastUsed !== null && available.includes(lastUsed)) return lastUsed
  return available[0] ?? null
}

const pasteStart = '\x1b[200~'
const pasteEnd = '\x1b[201~'

/** Text as one bracketed paste with no Enter; an end marker inside it is removed so it cannot submit early. */
export function bracketedPaste(text: string): string {
  return `${pasteStart}${text.split(pasteEnd).join('')}${pasteEnd}`
}
