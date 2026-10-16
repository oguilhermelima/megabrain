import type { SlashCommand } from '@/api/schema'

// Where the composer's slash menu gets its rows: `megabrain commands` for the agent and folder, read
// before any chat exists, and the names a running agent reported at init merged in.

export type Fetch = (agent: string, cwd: string) => Promise<SlashCommand[]>

/** What the composer knows about one agent and folder's commands. */
export interface CommandList {
  status: 'idle' | 'loading' | 'ready' | 'error'
  commands: SlashCommand[]
  error: string | null
}

export interface CommandSource {
  /** The list, read once and shared while it runs; `refresh` asks again even when a good list is held. */
  load(agent: string, cwd: string, options?: { refresh?: boolean }): Promise<SlashCommand[]>
  /** The last good list, if any. */
  peek(agent: string, cwd: string): SlashCommand[] | undefined
}

/**
 * A cache of command lists per agent and folder. Only a non-empty answer is kept: a failed, empty or
 * timed-out call is forgotten once it settles, so the next load asks again instead of showing nothing
 * for the rest of the app run.
 */
export function createCommandSource(fetch: Fetch, { timeoutMs = 15_000 }: { timeoutMs?: number } = {}): CommandSource {
  const lists = new Map<string, SlashCommand[]>()
  const running = new Map<string, Promise<SlashCommand[]>>()
  const keyOf = (agent: string, cwd: string) => `${agent}\n${cwd}`
  return {
    load(agent, cwd, { refresh = false } = {}) {
      const key = keyOf(agent, cwd)
      const inFlight = running.get(key)
      if (inFlight !== undefined) return inFlight
      const held = lists.get(key)
      if (held !== undefined && !refresh) return Promise.resolve(held)
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`megabrain commands did not answer in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)
      })
      const loading = Promise.race([fetch(agent, cwd), timeout])
        .then((list) => {
          if (list.length > 0) lists.set(key, list)
          else lists.delete(key)
          return list
        })
        .finally(() => {
          clearTimeout(timer)
          running.delete(key)
        })
      running.set(key, loading)
      return loading
    },
    peek: (agent, cwd) => lists.get(keyOf(agent, cwd)),
  }
}

/** The discovered commands plus the names only the running agent reported (Claude's init), each once. */
export function mergeInitCommands(commands: SlashCommand[], initNames: readonly string[] | null | undefined): SlashCommand[] {
  if (initNames === null || initNames === undefined || initNames.length === 0) return commands
  const known = new Set(commands.map((command) => command.name))
  const added: SlashCommand[] = []
  for (const name of initNames) {
    if (known.has(name)) continue
    known.add(name)
    added.push({ name, description: null, source: 'builtin' })
  }
  return added.length === 0 ? commands : [...commands, ...added]
}

export type MenuNotice = { tone: 'loading' | 'error' | 'empty'; text: string }

/** The row the menu shows in place of commands: while the first list loads, when it failed, or when the agent has none. */
export function menuNotice(list: CommandList, agent: string): MenuNotice | null {
  if (list.commands.length > 0) return null
  if (list.status === 'loading' || list.status === 'idle') return { tone: 'loading', text: 'Loading commands…' }
  if (list.status === 'error') return { tone: 'error', text: `Could not load commands: ${list.error ?? 'unknown error'}` }
  return { tone: 'empty', text: `No commands for ${agent}` }
}
