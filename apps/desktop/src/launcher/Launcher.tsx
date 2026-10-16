import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { HistorySession, MessagePart, NativeChat } from '@/api/schema'
import { ChatHeader } from '@/chat/ChatHeader'
import { Composer, type Notice } from '@/chat/Composer'
import { AgentIcon } from '@/components/agent-icons'
import { StartingCard } from '@/components/StartingCard'
import { ErrorNote } from '@/components/ui'
import { chatCalls, initialTile, launchPlan, launchTiles, launchWorktree, type LaunchTile, type LaunchTileId } from '@/launcher/launch-model'
import { resumeLaunch } from '@/launcher/resume-model'
import { ResumeList } from '@/launcher/ResumeList'
import { usePendingActions } from '@/lib/usePendingActions'
import { TerminalIcon } from '@/terminal/TerminalIcon'
import type { TerminalLaunch } from '@/terminal/terminal-list'

export interface WorktreeChoice {
  path: string
  label: string
}

const tileKey = 'megabrain.launch.tile'
const worktreeKey = 'megabrain.launch.worktree'

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Remembering is a convenience; the defaults are fine.
  }
}

// Which agent CLIs are installed, read once per app run; without the report every tile stays enabled.
let installedAgents: Promise<{ agent: string; installed: boolean }[] | null> | null = null

function useInstalledAgents() {
  const [agents, setAgents] = useState<{ agent: string; installed: boolean }[] | null>(null)
  useEffect(() => {
    let stopped = false
    installedAgents ??= api.installPlan().then(
      (plan) => plan.agents,
      () => null,
    )
    void installedAgents.then((list) => {
      if (!stopped) setAgents(list)
    })
    return () => {
      stopped = true
    }
  }, [])
  return agents
}

/** A new id for a terminal: unique across app runs, so a layout saved by an earlier run never names it. */
export function newTerminalId(): string {
  return `terminal-${crypto.randomUUID()}`
}

const folder = (path: string) => path.split('/').at(-1) ?? path

const startKey = 'start'

/**
 * The center screen's launcher: the worktree it starts in, a tile per agent plus the Terminal tile, the
 * chats' composer and the worktree's past chats. Enter starts the selected agent with the message;
 * clicking the selected agent again starts it empty; clicking a past chat resumes it. The Terminal
 * tile is not a mode: it opens a terminal in the worktree at once.
 */
export function Launcher({
  worktrees,
  clicked,
  onChat,
  onLaunch,
  onTerminal,
  onResume,
  onWorktree,
}: {
  worktrees: WorktreeChoice[]
  /** The worktree whose + opened the launcher; null for ⌘N or the home screen. */
  clicked: string | null
  onChat: (chat: NativeChat) => void
  /** An agent's own TUI started in a terminal (Grok and agy). */
  onLaunch: (launch: TerminalLaunch) => void
  /** Opens a new terminal in the worktree. */
  onTerminal: (cwd: string) => void
  /** A past chat to resume, with the terminal that resumes it when megabrain does not show it already. */
  onResume: (session: HistorySession, launch: TerminalLaunch) => void
  /** The worktree the launcher starts in, so the top bar's run button acts there. */
  onWorktree: (cwd: string | null) => void
}) {
  const tiles = launchTiles(useInstalledAgents())
  const [chosenTile, setChosenTile] = useState<LaunchTileId | null>(null)
  const tile = chosenTile ?? initialTile(remembered(tileKey), tiles)
  const [chosenPath, setChosenPath] = useState<string | null>(null)
  const cwd = chosenPath ?? launchWorktree(clicked, remembered(worktreeKey), worktrees.map((entry) => entry.path))
  const worktree = worktrees.find((entry) => entry.path === cwd) ?? null
  useEffect(() => onWorktree(cwd), [cwd, onWorktree])
  const [model, setModel] = useState<{ model: string; effort: string | null } | null>(null)
  const [error, setError] = useState<unknown>(null)
  // A chat start shows in this pane at once, as one pending entry, until the chat replaces it.
  const actions = usePendingActions()
  const start = actions.pending[startKey]
  const starting = start?.status === 'running'
  const current = tiles.find((item) => item.id === tile)
  // With no agent installed the selection falls back to the terminal, which takes no message.
  const ready = cwd !== null && current?.enabled === true && tile !== 'terminal' && !starting

  const pick = (next: LaunchTileId) => {
    setChosenTile(next)
    if (next !== tile) setModel(null)
  }

  const launch = async (parts: MessagePart[]): Promise<Notice> => {
    if (cwd === null || !ready) return { tone: 'bad', text: 'Pick a worktree and an installed agent first.' }
    setError(null)
    const plan = launchPlan(tile, { cwd, parts, model: model?.model ?? null, effort: model?.effort ?? null, engine: 'tmux' })
    remember(tileKey, tile)
    remember(worktreeKey, cwd)
    if (plan.kind !== 'chat') {
      // A terminal opens its pane at once and shows its own start there.
      onLaunch({ ...plan, id: newTerminalId(), title: `${current?.label ?? tile} · ${worktree?.label ?? cwd}` })
      return { tone: 'ok', text: 'Started.' }
    }
    const calls = chatCalls(plan)
    const started = await actions.run(startKey, `Starting ${current?.label ?? tile} in ${worktree?.label ?? folder(cwd)}`, async () => {
      const chat = await api.startChat(calls.start)
      if (calls.effort !== null) await api.setChatModel(chat.id, calls.effort.model, calls.effort.effort)
      if (calls.send !== null) await api.sendChat(chat.id, calls.send)
      onChat(chat)
    })
    return started ? { tone: 'ok', text: 'Started.' } : { tone: 'bad', text: 'The chat did not start; your message is still here.' }
  }

  const resume = (session: HistorySession) => {
    if (cwd === null) return
    remember(worktreeKey, cwd)
    const plan = resumeLaunch(session, { cwd, tile, model: model?.model ?? null, effort: model?.effort ?? null })
    const agent = tiles.find((item) => item.id === session.agent)?.label ?? session.agent
    onResume(session, { ...plan, id: newTerminalId(), title: `${agent} · ${session.title.trim() === '' ? session.id : session.title}` })
  }

  const launchEmpty = () => {
    launch([]).then(
      (notice) => {
        if (notice.tone === 'bad') setError(new Error(notice.text))
      },
      setError,
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader
        agent={null}
        title={worktree?.label ?? 'No worktree yet'}
        meta={cwd === null ? 'Add a project to start a chat' : `New chat · ${folder(cwd)}`}
        metaTitle={cwd ?? undefined}
        actions={
          worktrees.length > 1 && (
            <label className="relative flex h-8 shrink-0 items-center rounded-[12px] px-2.5 text-[12.5px] text-ink-400 hover:bg-row-hover hover:text-ink-200">
              <span>Switch</span>
              <select aria-label="Worktree" value={cwd ?? ''} onChange={(event) => setChosenPath(event.target.value)} className="absolute inset-0 cursor-pointer opacity-0">
                {worktrees.map((entry) => (
                  <option key={entry.path} value={entry.path} title={entry.path}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
          )
        }
      />
      <div className="mx-8 min-h-0 flex-1 overflow-y-auto">
        {start !== undefined ? (
          <div className="pt-6">
            <StartingCard entry={start} icon={tile === 'terminal' ? undefined : <AgentIcon agent={tile} size={20} activity="working" />} onRetry={() => void actions.retry(startKey)} onDismiss={() => actions.dismiss(startKey)} />
          </div>
        ) : (
          <>
            <section className="flex flex-col gap-6 pt-6">
              <div role="radiogroup" aria-label="Start" className="grid grid-cols-5 gap-3">
                {tiles.map((item) => (
                  <Tile
                    key={item.id}
                    tile={item}
                    selected={item.id === tile && item.id !== 'terminal'}
                    busy={starting}
                    onSelect={() => {
                      if (item.id === 'terminal') {
                        if (cwd === null) return
                        remember(worktreeKey, cwd)
                        onTerminal(cwd)
                      } else if (item.id === tile) launchEmpty()
                      else pick(item.id)
                    }}
                  />
                ))}
              </div>
              {error !== null && <ErrorNote error={error} />}
            </section>
            <ResumeList cwd={cwd} tile={tile} tiles={tiles} disabled={starting} onResume={resume} />
          </>
        )}
      </div>
      <Composer
        placeholder={placeholder(tile, current)}
        disabled={!ready && !starting}
        agent={tile === 'terminal' ? null : tile}
        cwd={cwd}
        model={model?.model ?? null}
        onModelChange={async (picked, effort) => setModel({ model: picked, effort: effort ?? null })}
        onSend={launch}
      />
    </div>
  )
}

function placeholder(tile: LaunchTileId, current: LaunchTile | undefined): string {
  if (current !== undefined && !current.enabled) return current.hint ?? `${current.label} is not available`
  if (tile === 'terminal') return 'Install an agent to start a chat here; the Terminal tile opens a shell.'
  if (tile === 'grok' || tile === 'agy') return `What should ${current?.label ?? tile} do? It is typed into its terminal for you to send…`
  return `What should ${current?.label ?? tile} do? Enter starts it…`
}

function Tile({ tile, selected, busy, onSelect }: { tile: LaunchTile; selected: boolean; busy: boolean; onSelect: () => void }) {
  const opensNow = tile.id === 'terminal'
  return (
    <button
      type="button"
      role={opensNow ? undefined : 'radio'}
      aria-checked={opensNow ? undefined : selected}
      disabled={!tile.enabled || busy}
      title={tile.hint ?? (opensNow ? 'Open a new terminal here (⌘T)' : selected ? `Open ${tile.label} now` : tile.label)}
      onClick={onSelect}
      className="flex h-24 flex-col items-center justify-center gap-2.5 rounded-[22px] border border-white/[0.08] bg-ink-900 text-[13.5px] font-medium text-ink-300 transition-colors hover:bg-ink-850 hover:text-ink-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-ink-900 aria-checked:border-accent/60 aria-checked:bg-accent/[0.08] aria-checked:text-ink-100"
    >
      {tile.id === 'terminal' ? <TerminalIcon size={22} /> : <AgentIcon agent={tile.id} size={22} />}
      <span>{tile.label}</span>
      {tile.hint !== null && <span className="sr-only">{tile.hint}</span>}
    </button>
  )
}
