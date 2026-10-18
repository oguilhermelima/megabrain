import { useEffect, useState, type KeyboardEvent } from 'react'
import { api } from '@/api'
import type { HistorySession, MessagePart, NativeChat } from '@/api/schema'
import { ChatHeader } from '@/chat/ChatHeader'
import { Composer, type Notice } from '@/chat/Composer'
import { AgentIcon } from '@/components/agent-icons'
import { StartingCard } from '@/components/StartingCard'
import { ErrorNote } from '@/components/ui'
import { agentDetail, chatStart, initialTile, launchPlan, launchTiles, launchWorktree, terminalDetail, type LaunchTile, type LaunchTileId } from '@/launcher/launch-model'
import { moveInColumn } from '@/launcher/launcher-keys'
import { resumeLaunch } from '@/launcher/resume-model'
import { ResumeList } from '@/launcher/ResumeList'
import { beginStart, bindStart, endStart, startStep } from '@/native-chat/start-trace'
import { useAgentDefaults } from '@/lib/useAgentDefaults'
import { usePendingActions } from '@/lib/usePendingActions'
import { defaultAgentSettings, parseAgentSettings, type AgentSettings } from '@/settings/agents-model'
import { defaultModelSettings, parseModelSettings, startPick, type ModelSettings } from '@/settings/models-model'
import { TerminalIcon } from '@/terminal/TerminalIcon'
import type { TerminalLaunch } from '@/terminal/terminal-list'
import { pageMx } from '@/lib/page'

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

// The default agent and the ones turned off in Settings > Agents, read each time a launcher opens so
// a change there shows in the next New chat; until it arrives nothing is off and Auto applies.
function useAgentSettings() {
  const [settings, setSettings] = useState<AgentSettings>(defaultAgentSettings)
  useEffect(() => {
    let stopped = false
    api.agentSettings().then(
      (saved) => !stopped && setSettings(parseAgentSettings(saved)),
      () => {},
    )
    return () => {
      stopped = true
    }
  }, [])
  return settings
}

// The models turned on and each agent's default from Settings > Models, read each time a launcher
// opens like the agent settings; until they arrive a new chat starts on the agent's own default.
function useModelSettings() {
  const [settings, setSettings] = useState<ModelSettings>(defaultModelSettings)
  useEffect(() => {
    let stopped = false
    api.modelSettings().then(
      (saved) => !stopped && setSettings(parseModelSettings(saved)),
      () => {},
    )
    return () => {
      stopped = true
    }
  }, [])
  return settings
}

/** A new id for a terminal: unique across app runs, so a layout saved by an earlier run never names it. */
export function newTerminalId(): string {
  return `terminal-${crypto.randomUUID()}`
}

const folder = (path: string) => path.split('/').at(-1) ?? path

const startKey = 'start'

/**
 * The center screen's launcher, as lists: a New terminal row that opens a terminal in the worktree at
 * once, then two columns, the agents to start and the worktree's past chats to resume, over the
 * chats' composer. The selected agent drives the composer and the Resume filter. Enter in the
 * composer starts the selected agent with the message; the selected agent's row starts it empty;
 * a past chat resumes. Arrow keys move within a column and Tab between them.
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
  /** A terminal the launcher opened: the login shell with typed text waiting in it. */
  onLaunch: (launch: TerminalLaunch) => void
  /** Opens a new terminal in the worktree. */
  onTerminal: (cwd: string) => void
  /** A past chat to resume, with the terminal that resumes it when megabrain does not show it already. */
  onResume: (session: HistorySession, launch: TerminalLaunch) => void
  /** The worktree the launcher starts in, so the top bar's run button acts there. */
  onWorktree: (cwd: string | null) => void
}) {
  const agentSettings = useAgentSettings()
  const tiles = launchTiles(useInstalledAgents(), agentSettings.disabled)
  const defaults = useAgentDefaults()
  const [chosenTile, setChosenTile] = useState<LaunchTileId | null>(null)
  const tile = chosenTile ?? initialTile(remembered(tileKey), tiles, agentSettings.default)
  const cwd = launchWorktree(clicked, remembered(worktreeKey), worktrees.map((entry) => entry.path))
  const worktree = worktrees.find((entry) => entry.path === cwd) ?? null
  useEffect(() => onWorktree(cwd), [cwd, onWorktree])
  const [picked, setModel] = useState<{ model: string; effort: string | null } | null>(null)
  // Until the person picks, a new chat starts on the agent's default from Settings > Models.
  const modelSettings = useModelSettings()
  const model = picked ?? startPick(modelSettings, tile === 'terminal' ? null : tile)
  const [error, setError] = useState<unknown>(null)
  // A chat start shows in this pane at once, as one pending entry, until the chat replaces it.
  const actions = usePendingActions()
  const start = actions.pending[startKey]
  const starting = start?.status === 'running'
  const current = tiles.find((item) => item.id === tile)
  // With no agent installed the selection falls back to the terminal, which takes no message.
  const ready = cwd !== null && current?.enabled === true && tile !== 'terminal' && !starting

  const [allAgents, setAllAgents] = useState(false)
  const agents = tiles.filter((item) => item.id !== 'terminal')
  // The agent column keeps one tabbable row: the selected agent, else the first one enabled.
  const tabbableAgent = agents.some((item) => item.id === tile && item.enabled) ? null : (agents.find((item) => item.enabled)?.id ?? null)

  const pick = (next: LaunchTileId) => {
    setChosenTile(next)
    if (next !== tile) setModel(null)
  }

  // The arrow keys move the selection with the focus, as in any radio group.
  const agentKey = (event: KeyboardEvent<HTMLElement>) => {
    const next = moveInColumn(event)?.dataset.agent
    const found = agents.find((item) => item.id === next)
    if (found !== undefined) pick(found.id)
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
    const trace = beginStart(plan.agent, plan.parts.length > 0)
    const started = await actions.run(startKey, `Starting ${current?.label ?? tile} in ${worktree?.label ?? folder(cwd)}`, async () => {
      try {
        startStep(trace, 'startSent')
        const chat = await api.startChat(chatStart(plan))
        bindStart(trace, chat.id)
        onChat(chat)
      } catch (caught) {
        endStart(trace, 'error', caught)
        throw caught
      }
    })
    return started ? { tone: 'ok', text: 'Started.' } : { tone: 'bad', text: 'The chat did not start; your message is still here.' }
  }

  const resume = (session: HistorySession) => {
    if (cwd === null) return
    remember(worktreeKey, cwd)
    const plan = resumeLaunch(session, { cwd, tile, model: picked?.model ?? null, effort: picked?.effort ?? null })
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
      <ChatHeader agent={null} title={worktree?.label ?? 'No worktree yet'} />
      <div className={`@container ${pageMx} flex min-h-0 flex-1 flex-col overflow-y-auto`}>
        {start !== undefined ? (
          <div className="pt-6">
            <StartingCard entry={start} icon={tile === 'terminal' ? undefined : <AgentIcon agent={tile} size={20} activity="working" />} onRetry={() => void actions.retry(startKey)} onDismiss={() => actions.dismiss(startKey)} />
          </div>
        ) : (
          <>
            <button
              type="button"
              disabled={cwd === null || starting}
              title="Open a new terminal here (⌘T)"
              onClick={() => {
                if (cwd === null) return
                remember(worktreeKey, cwd)
                onTerminal(cwd)
              }}
              className="mt-6 grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-[14px] px-3 py-2.5 text-left transition-colors hover:bg-row-hover focus-visible:bg-row-hover focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <TerminalIcon size={20} />
              <span className="min-w-0">
                <span className="block text-[13.5px] font-medium text-ink-100">New terminal</span>
                <span className="block truncate text-[12px] text-ink-500" title={cwd ?? undefined}>
                  {terminalDetail(defaults?.shell ?? null, worktree?.label ?? (cwd === null ? 'no worktree' : folder(cwd)))}
                </span>
              </span>
              <kbd className="font-sans text-[12px] text-ink-500">⌘T</kbd>
            </button>
            {error !== null && (
              <div className="mt-2">
                <ErrorNote error={error} />
              </div>
            )}
            <div aria-hidden="true" className="my-4 h-px shrink-0 bg-white/[0.06]" />
            <div className="grid flex-1 grid-cols-1 content-start gap-x-8 gap-y-6 pb-4 @2xl:min-h-0 @2xl:content-stretch @2xl:grid-cols-2 @2xl:grid-rows-[minmax(0,1fr)]">
              <section aria-label="Start an agent" className="flex min-h-0 flex-col" onKeyDown={agentKey}>
                <h2 className="flex h-8 items-center text-[13px] font-semibold text-ink-400">Start an agent</h2>
                <div role="radiogroup" aria-label="Agent" className="mt-2 grid min-h-0 content-start gap-0.5 overflow-y-auto">
                  {agents.map((item) => (
                    <AgentRow
                      key={item.id}
                      tile={item}
                      selected={item.id === tile}
                      tabbable={item.id === (tabbableAgent ?? tile)}
                      busy={starting}
                      detail={agentDetail(item.id, item.id === tile ? model : null, defaults)}
                      onSelect={() => {
                        if (item.id === tile) launchEmpty()
                        else pick(item.id)
                      }}
                    />
                  ))}
                </div>
              </section>
              <ResumeList cwd={cwd} filter={allAgents ? 'all' : tile} agent={tile === 'terminal' ? null : tile} tiles={tiles} disabled={starting} onFilter={(next) => setAllAgents(next === 'all')} onResume={resume} />
            </div>
          </>
        )}
      </div>
      <Composer
        placeholder={placeholder(tile, current)}
        disabled={!ready && !starting}
        agent={tile === 'terminal' ? null : tile}
        cwd={cwd}
        model={model?.model ?? null}
        onModelChange={async (next, effort) => setModel({ model: next, effort: effort ?? null })}
        onSend={launch}
      />
    </div>
  )
}

function placeholder(tile: LaunchTileId, current: LaunchTile | undefined): string {
  if (current !== undefined && !current.enabled) return current.hint ?? `${current.label} is not available`
  if (tile === 'terminal') return 'Install an agent to start a chat here; New terminal opens a shell.'
  return `What should ${current?.label ?? tile} do? Enter starts it…`
}

function AgentRow({ tile, selected, tabbable, busy, detail, onSelect }: { tile: LaunchTile; selected: boolean; tabbable: boolean; busy: boolean; detail: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-column-item
      data-agent={tile.id}
      tabIndex={tabbable ? 0 : -1}
      disabled={!tile.enabled || busy}
      title={tile.hint ?? (selected ? `Open ${tile.label} now` : tile.label)}
      onClick={onSelect}
      className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-[12px] px-3 py-2 text-left transition-colors hover:bg-row-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent aria-checked:bg-accent/[0.08] aria-checked:hover:bg-accent/[0.12]"
    >
      <AgentIcon agent={tile.id} size={20} />
      <span className="min-w-0">
        <span className="block text-[13.5px] font-medium text-ink-200 group-aria-checked:text-ink-100">{tile.label}</span>
        <span className="block truncate text-[12px] text-ink-500">{tile.hint ?? detail}</span>
      </span>
      {selected && <span className="text-[12px] text-ink-500">↵</span>}
    </button>
  )
}
