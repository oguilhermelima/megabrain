import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import { createCommandSource, menuNotice, mergeInitCommands, type CommandList } from '@/chat/slash-commands'
import { slashQuery } from '@/chat/composer-model'
import { draftText, type Draft } from '@/chat/composer-parts'

// Slash commands per agent and folder for the whole app run, read as the composer mounts.
const commandSource = createCommandSource((agent, cwd) => api.slashCommands(agent, cwd))

/**
 * The agent's slash commands for this folder, loaded as soon as both are known rather than from a
 * chat event, so a chat that never sent a message lists them too. `refresh` asks again: on focus,
 * and when / is typed after a failed or empty answer.
 */
export function useSlashCommands(agent: string | null, cwd: string | null, initNames: readonly string[] | undefined): CommandList & { refresh: () => void } {
  const [list, setList] = useState<CommandList>(() => ({ status: 'idle', commands: agent !== null && cwd !== null ? (commandSource.peek(agent, cwd) ?? []) : [], error: null }))
  // Only the latest call writes the list, so a slow answer for another agent or folder never lands here.
  const latest = useRef(0)
  const asked = useRef(0)
  const run = useCallback(
    (refresh: boolean) => {
      latest.current += 1
      const call = latest.current
      if (agent === null || agent === '' || cwd === null || cwd === '') {
        setList({ status: 'idle', commands: [], error: null })
        return
      }
      setList({ status: 'loading', commands: commandSource.peek(agent, cwd) ?? [], error: null })
      commandSource.load(agent, cwd, { refresh }).then(
        (commands) => {
          if (latest.current === call) setList({ status: 'ready', commands, error: null })
        },
        (error: unknown) => {
          if (latest.current === call) setList({ status: 'error', commands: commandSource.peek(agent, cwd) ?? [], error: error instanceof Error ? error.message : String(error) })
        },
      )
    },
    [agent, cwd],
  )
  useEffect(() => {
    asked.current = Date.now()
    run(false)
    return () => {
      latest.current += 1
    }
  }, [run])
  // Focus comes often (every pick puts it back), so a good list is asked again at most every half minute.
  const refresh = useCallback(() => {
    const now = Date.now()
    if (list.status === 'loading' || (list.status === 'ready' && list.commands.length > 0 && now - asked.current < 30_000)) return
    asked.current = now
    run(true)
  }, [run, list.status, list.commands.length])
  const commands = mergeInitCommands(list.commands, initNames)
  return { ...list, commands, refresh }
}

/** A draft's slash-command query: only a message of plain text can start with a command. */
export function draftSlashQuery(draft: Draft): string | null {
  return draft.some((part) => part.type === 'token') ? null : slashQuery(draftText(draft))
}

export { menuNotice }
