import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ChatQueueChange } from '@/api/adapter'
import { activityOf } from '@/components/agent-activity'
import { api } from '@/api'
import type { ChatArtifact, MessagePart, NativeChat, TerminalSession, TranscriptEvent } from '@/api/schema'
import { ChatHeader } from '@/chat/ChatHeader'
import { ViewSwitch } from '@/chat/ViewSwitch'
import { Composer, type Notice } from '@/chat/Composer'
import type { QueueControls } from '@/chat/QueueStrip'
import { useComposeChannel } from '@/chat/chat-menu'
import { ApprovalRendererContext, ConversationList, type OpenChat, type OpenPath } from '@/chat/Conversation'
import { ErrorNote } from '@/components/ui'
import { terminalEngine } from '@/terminal/terminal-engine'
import { TerminalSkeleton } from '@/terminal/TerminalSkeleton'
import { TranscriptSkeleton } from '@/components/Skeleton'
import { announceAction } from '@/lib/app-events'
import { ApprovalCard, type ApprovalDecision } from '@/native-chat/ApprovalCard'
import { composerContext, dropOutgoing, liveTail, markAnswered, modeToggle, pendingApproval, queueOutgoing, resumableChatState, shouldInterrupt, thinkingProgress, withModel, withSwitchResult, workingStatus } from '@/native-chat/chat-model'
import { WorkingIndicator } from '@/native-chat/WorkingIndicator'
import { ConversationAgent } from '@/components/agent-icons'
import { ChatSuggestions } from '@/native-chat/ChatSuggestions'
import { useFollowChat } from '@/native-chat/useFollowChat'
import { changeChatQueue } from '@/native-chat/chat-sync'
import { backToChat, chatChanged, requestTerminal, stopAndOpen, TERMINAL_WAIT_NOTICE, type DeferredStep } from '@/native-chat/deferred-switch'
import { beginSwitch, endSwitch, switchEngine, switchStep } from '@/native-chat/switch-trace'
import { ownerBar, ownerOf, refusalOf, sendFailure, sendRoute, sendsWhenFree, switchFailure, viewSwitch, type Hold, type View } from '@/native-chat/terminal-owner'
import { endKeptSession } from '@/terminal/kept-terminals'
import { useNow } from '@/github/parts'
import { ArtifactPanel, ArtifactsRow, useChatArtifacts, useChatPanel, useHiddenChips } from '@/native-chat/ChatArtifacts'
import { artifactRow, closeChip, openArtifact, panelLayout, type ArtifactChip } from '@/native-chat/chat-artifacts'
import { usePaneWidth } from '@/native-chat/usePaneWidth'
import { runningTasks, taskRows } from '@/chat/background-tasks'
import { BackgroundIndicator } from '@/native-chat/BackgroundTasks'
import { OwnerStrip } from '@/native-chat/OwnerStrip'
import { pageMx } from '@/lib/page'

// xterm's code is preloaded at app start (preloadTerminalView), so the first switch does not wait for it.
const TerminalView = lazy(() => import('@/terminal/TerminalView').then((module) => ({ default: module.TerminalView })))

// The terminal each chat handed over to, kept for the app run so reopening the chat reattaches to it.
const handedOver = new Map<string, TerminalSession>()
// The view each chat last showed, kept for the app run: the chat view does not move the session.
const shownViews = new Map<string, View>()

// A suspended (or legacy stopped) chat is not over: its next message resumes the agent session.
const resumable = resumableChatState

/** A conversation megabrain owns through the agent's protocol, followed live while it is open. */
export function NativeChatView({ chat: listed, onOpenChat, onOpenPath, onOpenArtifact }: { chat: NativeChat; onOpenChat?: OpenChat; onOpenPath?: OpenPath; onOpenArtifact?: (artifactId: string) => void }) {
  const { state, reconnecting, update, queue, setQueue, artifactsChanged } = useFollowChat(listed)
  // The followed record is live; the listed one only fills in until the first line arrives.
  const chat = state.chat ?? listed
  const [switching, setSwitching] = useState(false)
  const compose = useComposeChannel()
  // The view being switched to shows at once; the chat record catches up when the switch lands.
  const [target, setTarget] = useState<NativeChat['mode'] | null>(null)
  const opening = useRef<Promise<{ command: string[] | null }> | null>(null)
  const [startFresh, setStartFresh] = useState(false)
  const [retryingResume, setRetryingResume] = useState(false)
  const [exited, setExited] = useState<number | null | undefined>(undefined)
  // Which view shows: going to the chat only moves the view, since chatd follows the terminal's session.
  const [shown, setShown] = useState<View>(() => shownViews.get(listed.id) ?? listed.mode)
  const showView = (view: View) => {
    shownViews.set(chat.id, view)
    setShown(view)
  }
  const toggle = modeToggle({ ...chat, mode: shown })
  // Asked for the terminal mid-turn: the pane shows the terminal view and waits for the turn to end.
  const [waitingTerminal, setWaitingTerminal] = useState(false)
  const mode = waitingTerminal ? 'terminal' : (target ?? shown)
  const inTerminal = mode === 'terminal'
  const [actionError, setActionError] = useState<unknown>(null)
  const [switchError, setSwitchError] = useState<unknown>(null)
  // A switch the chat refused because its turn runs: a plain line, the view stays in chat.
  const [switchNotice, setSwitchNotice] = useState<string | null>(null)
  // A draft the busy terminal refused, kept in the composer; armed, it sends once the terminal is free.
  const [hold, setHold] = useState<Hold>('none')
  const sendDraft = useRef<(() => void) | null>(null)
  const [takingOver, setTakingOver] = useState(false)
  const owner = ownerOf(chat)
  const bar = ownerBar(chat, hold)
  // A step that needs a yes first: sending a queued message now, which stops a running turn.
  const [confirming, setConfirming] = useState<{ text: string; action: string; run: () => void } | null>(null)
  const title = chat.title ?? 'New chat'
  const pending = pendingApproval(state)
  const live = useMemo(() => liveTail(state), [state])
  const working = workingStatus(state)
  // Nothing said yet: the agent waits for the first message, so suggestions replace any spinner.
  const fresh = chat.title === null && state.outgoing.length === 0 && !state.events.some((event) => event.kind === 'user')
  const [fill, setFill] = useState<{ text: string } | null>(null)
  // The chat's artifacts: chips above the composer, the open one beside the chat (or over it on a narrow pane).
  const now = useNow(30_000)
  const artifacts = useChatArtifacts(chat.id, artifactsChanged)
  const panel = useChatPanel(chat.id)
  const closedChips = useHiddenChips(chat.id)
  const opened = artifacts.artifacts === null ? null : openArtifact(artifacts.artifacts, panel.artifactId)
  const chips = artifacts.artifacts === null ? null : artifactRow(artifacts.artifacts, artifacts.previous, panel.artifactId, closedChips.hidden)
  const closeArtifactChip = (chip: ArtifactChip) => {
    const next = closeChip(closedChips.hidden, chip.artifact, panel.artifactId)
    closedChips.save(next.hidden)
    if (next.open !== panel.artifactId) panel.open(next.open)
  }
  const paneWidth = usePaneWidth()
  const layout = panelLayout(paneWidth.width, panel.width)

  const answer = async (approvalId: string, decision: ApprovalDecision) => {
    await api.answerApproval(chat.id, approvalId, decision)
    update((current) => markAnswered(current, approvalId))
    announceAction()
  }

  // A new function whenever what is pending changes, so the cards re-render with it.
  const renderApproval = useCallback(
    (event: TranscriptEvent) => {
      const approval = state.approvals[event.id]
      if (approval === undefined) return <p className="text-center text-[12px] text-ink-400">{event.text}</p>
      return <ApprovalCard approval={approval} pending={pending?.id === approval.id} onAnswer={(decision) => answer(approval.id, decision)} />
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.approvals, pending?.id, chat.id],
  )

  const act = (run: () => Promise<void>) =>
    run().then(
      () => {
        setActionError(null)
        announceAction()
      },
      (caught: unknown) => setActionError(caught),
    )

  const busy = chat.state === 'working' || chat.state === 'waiting-approval'
  const heldElsewhere = refusalOf(chat.error) === 'foreign'

  const retryResume = async () => {
    setRetryingResume(true)
    setStartFresh(false)
    setActionError(null)
    try {
      await api.resumeChat(chat.id)
      announceAction()
    } catch (caught) {
      setActionError(caught)
    } finally {
      setRetryingResume(false)
    }
  }

  // The message shows at once and the chat's user event confirms it; a failed send takes it back.
  // While a turn runs it waits in the queue instead, which the strip above the composer shows.
  // While the terminal drives, a send takes the session over first; a busy terminal keeps the draft.
  const send = async (parts: MessagePart[]): Promise<Notice | null> => {
    if (sendRoute(chat) === 'take-over-first') {
      try {
        await takeOver()
      } catch (caught) {
        return keepDraft(caught)
      }
    }
    const id = crypto.randomUUID()
    const text = parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
    const images = parts.flatMap((part) => (part.type === 'image' ? [{ path: part.path }] : []))
    if (!busy) update((current) => queueOutgoing(current, { id, text, sentAt: new Date().toISOString(), ...(images.length === 0 ? {} : { images, parts }) }))
    try {
      const { queued } = await api.sendChat(chat.id, parts, { fresh: startFresh && resumable(chat.state) })
      setStartFresh(false)
      setHold('none')
      if (queued !== null) {
        update((current) => dropOutgoing(current, id))
        if (!queue.some((item) => item.id === queued.id)) setQueue([...queue, queued])
      }
    } catch (caught) {
      update((current) => dropOutgoing(current, id))
      return keepDraft(caught)
    }
    return null
  }
  const keepDraft = (caught: unknown): Notice => {
    const kept = sendFailure(caught)
    if (kept === null) throw caught
    setHold('held')
    return kept
  }

  // The daemon checks the terminal is idle, ends its TUI and resumes the session in the chat.
  const takeOver = async () => {
    setTakingOver(true)
    try {
      const takenOver = await api.takeOverChat(chat.id)
      update((current) => withSwitchResult(current, takenOver))
    } finally {
      setTakingOver(false)
    }
    handedOver.delete(chat.id)
    endKeptSession(chat.id)
    announceAction()
  }

  useEffect(() => {
    if (sendsWhenFree(hold, chat)) {
      setHold('held')
      sendDraft.current?.()
    } else if (hold === 'held' && owner !== 'terminal') setHold('none')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hold, chat.state, owner])

  // A message chatd already took (the turn ended and sent it) only refreshes the strip; the view says nothing.
  const changeQueue = async (change: ChatQueueChange): Promise<'saved' | 'taken'> => {
    const { items, taken } = await changeChatQueue(api, chat.id, change)
    setQueue(items)
    announceAction()
    return taken ? 'taken' : 'saved'
  }
  const queueControls: QueueControls = {
    items: queue,
    // A failed edit keeps the draft in the composer, which shows the error; so does one chatd already sent.
    edit: (itemId, parts) => changeQueue({ action: 'edit', itemId, parts }),
    move: (itemId, to) => changeQueue({ action: 'move', itemId, to }).then(() => {}, setActionError),
    remove: (itemId) => changeQueue({ action: 'remove', itemId }).then(() => {}, setActionError),
    // Sending now stops a running turn, so it asks first.
    sendNow: (itemId) => {
      const run = () => {
        setConfirming(null)
        changeQueue({ action: 'send-now', itemId }).then(() => {}, setActionError)
      }
      if (busy) setConfirming({ text: 'Stop the running turn and send this message now?', action: 'Send now', run })
      else run()
    },
    ...(chat.agent === 'codex' && chat.state === 'working' ? { steer: (itemId: string) => changeQueue({ action: 'steer', itemId }).then(() => {}, setActionError) } : {}),
  }

  const stop = () => void act(() => api.interruptChat(chat.id))

  // The CLI refuses while the agent works; the composer shows its error.
  const changeModel = async (model: string, effort: string | undefined) => {
    await api.setChatModel(chat.id, model, effort)
    update((current) => withModel(current, listed, model))
    announceAction()
  }

  // The view moves at once. To the terminal mid-turn, it waits for the turn and hands over by itself.
  const follow = (step: DeferredStep) => {
    setWaitingTerminal(step.waiting)
    if (step.run === 'switch') void switchMode()
    else if (step.run === 'stop-then-switch') void api.interruptChat(chat.id).catch(() => {}).then(() => switchMode())
  }
  // To the chat, and to a terminal that already owns the session, only the view moves.
  const requestSwitch = () => {
    setSwitchNotice(null)
    if (waitingTerminal) return follow(backToChat(true))
    if (viewSwitch(chat, toggle.target) === 'show') {
      setSwitchError(null)
      return showView(toggle.target)
    }
    follow(requestTerminal(chat))
  }
  useEffect(() => {
    if (waitingTerminal) follow(chatChanged(true, chat))
    if (switchNotice !== null && !busy) setSwitchNotice(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingTerminal, chat.state])

  const switchMode = async () => {
    if (!toggle.enabled || switching) return
    beginSwitch(chat.id, chat.agent, 'terminal')
    setConfirming(null)
    setSwitchError(null)
    setSwitchNotice(null)
    setSwitching(true)
    setTarget('terminal')
    setExited(undefined)
    // A TUI that ran before has let go of the session; the terminal attaches to the one this switch opens.
    handedOver.delete(chat.id)
    // The terminal opens as soon as the agent has let go of the session, not after the chat record has come back too.
    const moved = (async () => {
      switchStep(chat.id, 'modeSent')
      const result = await api.setChatMode(chat.id, 'terminal')
      switchStep(chat.id, 'modeReturned')
      return result
    })()
    opening.current = moved
    try {
      const result = await moved
      if (result.terminal !== null) handedOver.set(chat.id, result.terminal)
      update((current) => withSwitchResult(current, result.chat))
      showView('terminal')
      setActionError(null)
      announceAction()
    } catch (caught) {
      endSwitch(chat.id, 'error', caught)
      const failure = switchFailure(caught)
      if ('notice' in failure) setSwitchNotice(failure.notice)
      else setSwitchError(caught)
    } finally {
      opening.current = null
      setTarget(null)
      setSwitching(false)
    }
  }

  // The terminal megabrain handed over, else one running the agent's own TUI on this conversation
  // with the engine chosen in settings. The command comes with the switch's answer, in parallel with the engine lookup.
  const connectTerminal = async (cols: number, rows: number): Promise<TerminalSession> => {
    const known = handedOver.get(chat.id)
    if (known !== undefined) {
      await api.resizeTerminal(known.id, cols, rows).catch(() => {})
      return known
    }
    const switched = opening.current
    const [command, engine] = await Promise.all([
      (switched === null ? Promise.resolve(null) : switched.then((result) => result.command)).then((value) => value ?? api.chatTerminalCommand(chat.id)),
      terminalEngine(),
    ])
    switchEngine(chat.id, engine)
    switchStep(chat.id, 'terminalOpenCalled', 'terminal')
    const terminal = await api.openTerminal({ engine, cwd: chat.cwd, command, chatId: chat.id, cols, rows })
    switchStep(chat.id, 'terminalOpened', 'terminal')
    handedOver.set(chat.id, terminal)
    return terminal
  }

  // Esc in an empty composer stops the agent's turn; the composer keeps every other key.
  const onComposerKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const box = event.target
    if (event.defaultPrevented || !(box instanceof HTMLElement) || !box.isContentEditable) return
    if (!shouldInterrupt(event.key, box.textContent ?? '', chat.state)) return
    event.preventDefault()
    stop()
  }

  const artifactPanel = (artifact: ChatArtifact, overlay: boolean) => (
    <ArtifactPanel
      key={artifact.id}
      chatId={chat.id}
      artifact={artifact}
      width={layout.width}
      overlay={overlay}
      onResize={{ preview: panel.preview, commit: panel.resize }}
      onClose={() => panel.open(null)}
      onOpenPage={onOpenArtifact ?? null}
    />
  )

  // The background work still running, above the composer; a pick scrolls the transcript to its row.
  const running = useMemo(() => runningTasks(taskRows(state.events).latest), [state.events])
  const jumpToTask = useRef<((taskId: string) => void) | null>(null)

  const transcript = (
    <div className="flex min-h-0 flex-1 flex-col">
      <ConversationAgent.Provider value={chat.agent}>
      <ApprovalRendererContext.Provider value={renderApproval}>
        {/* Until the first line of the follow arrives the history is still being read. */}
        {fresh ? (
          <ChatSuggestions cwd={chat.cwd} agent={chat.agent} onPick={(text) => setFill({ text })} />
        ) : state.cursor === null && state.events.length === 0 ? (
          <TranscriptSkeleton />
        ) : (
          <ConversationList
            events={state.events}
            live={live}
            footer={working === null ? null : <WorkingIndicator agent={chat.agent} status={working} progress={(now) => thinkingProgress(state, now)} />}
            onOpenChat={onOpenChat}
            root={chat.cwd}
            onOpenPath={onOpenPath}
            channel={compose}
            navigator
            jumpRef={jumpToTask}
          />
        )}
      </ApprovalRendererContext.Provider>
      </ConversationAgent.Provider>
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader
        agent={chat.agent}
        activity={activityOf(chat.state)}
        title={title}
        actions={<ViewSwitch view={mode} enabled={toggle.enabled && !switching} reason={toggle.reason} switching={switching} onView={requestSwitch} />}
      />
      {/* A follow that dropped comes back by itself; until then the view says so quietly instead of freezing. */}
      {reconnecting !== null && (
        <p className={`${pageMx} mt-3 text-[12.5px] text-ink-400`} title={reconnecting === '' ? undefined : reconnecting}>
          Reconnecting…
        </p>
      )}
      {actionError !== null && (
        <div className={`${pageMx} mt-3`}>
          <ErrorNote error={actionError} />
        </div>
      )}
      {confirming !== null && (
        <div className={`${pageMx} mt-3 flex items-center gap-3 text-[13px] text-warn`}>
          <span className="min-w-0 flex-1">{confirming.text}</span>
          <button type="button" onClick={() => setConfirming(null)} className="shrink-0 rounded-full px-3 py-1 text-ink-300 hover:bg-white/[0.07]">Cancel</button>
          <button type="button" onClick={confirming.run} className="shrink-0 rounded-full px-3 py-1 text-ink-100 hover:bg-white/[0.07]">{confirming.action}</button>
        </div>
      )}
      {switchError !== null && (
        <div className={`${pageMx} mt-3 flex items-start gap-3`}>
          <div className="min-w-0 flex-1"><ErrorNote error={switchError} /></div>
          <button type="button" onClick={() => void switchMode()} className="shrink-0 rounded-full px-3 py-1 text-[13px] text-ink-100 hover:bg-white/[0.07]">Retry</button>
        </div>
      )}
      {switchNotice !== null && <p className={`${pageMx} mt-3 text-[13px] text-ink-300`}>{switchNotice}</p>}
      {resumable(chat.state) && chat.error != null && (
        <div className={`${pageMx} mt-3 flex items-center gap-3 text-[13px] text-warn`}>
          <span className={`min-w-0 flex-1 ${heldElsewhere ? 'break-words' : 'truncate'}`} title={chat.error}>Could not resume: {chat.error}</span>
          {heldElsewhere && (
            <button type="button" disabled={retryingResume} onClick={() => void retryResume()} className="shrink-0 rounded-full px-3 py-1 text-ink-100 hover:bg-white/[0.07] disabled:opacity-50">
              {retryingResume ? 'Retrying…' : 'Retry'}
            </button>
          )}
          <button type="button" onClick={() => setStartFresh((current) => !current)} className="shrink-0 rounded-full px-3 py-1 text-ink-100 hover:bg-white/[0.07]">
            {startFresh ? 'Starting fresh with your next message' : 'Start fresh'}
          </button>
        </div>
      )}
      {waitingTerminal ? (
        <>
          <div className={`${pageMx} mt-3 flex items-center gap-3 text-[13px] text-ink-300`}>
            <span className="min-w-0 flex-1">{TERMINAL_WAIT_NOTICE}</span>
            <button type="button" onClick={() => follow(stopAndOpen(true))} className="shrink-0 text-[12.5px] text-ink-400 underline-offset-2 hover:text-ink-100 hover:underline">
              Stop the turn and open now
            </button>
          </div>
          {transcript}
        </>
      ) : inTerminal ? (
        <>
          {exited !== undefined && (
            <p className={`${pageMx} mt-3 text-[13px] text-ink-400`}>
              The terminal exited{exited === null ? '' : ` with code ${exited}`}. Switch back to Chat to continue here.
            </p>
          )}
          <Suspense fallback={<TerminalSkeleton label={`Opening ${chat.agent} in the terminal`} />}>
            <TerminalView
              key={chat.id}
              keep={chat.id}
              connect={connectTerminal}
              onOutput={() => switchStep(chat.id, 'firstOutput', 'terminal')}
              onFirstPaint={() => {
                switchStep(chat.id, 'firstPaint', 'terminal')
                endSwitch(chat.id, 'ok', undefined, 'terminal')
              }}
              onFailed={(caught) => endSwitch(chat.id, 'error', caught, 'terminal')}
              onExit={(code) => {
                endSwitch(chat.id, 'error', `the terminal exited${code === null ? '' : ` with code ${code}`} before it painted`, 'terminal')
                setExited(code)
              }}
              startingLabel={`Opening ${chat.agent} in the terminal`}
              awaitOutput
            />
          </Suspense>
        </>
      ) : (
        <div ref={paneWidth.ref} className="relative flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="relative flex min-h-0 flex-1 flex-col">
              {transcript}
              {/* On a narrow pane the artifact lies over the transcript; the composer below stays in reach. */}
              {opened !== null && layout.mode === 'overlay' && artifactPanel(opened, true)}
            </div>
            {pending !== null && <p className={`${pageMx} -mb-1 px-3 text-[12.5px] text-warn`}>{pending.tool} waits for your approval above.</p>}
            <div onKeyDown={onComposerKey} className="contents">
              <Composer
                placeholder={owner === 'terminal' ? `Reply to ${title}… (takes over from the terminal)` : resumable(chat.state) ? `Reply to ${title}… (resumes the session)` : chat.state === 'working' ? `Queue a reply for when the turn ends… (Esc stops the turn)` : `Reply to ${title}…`}
                disabled={false}
                agent={chat.agent}
                cwd={chat.cwd}
                context={composerContext(chat)}
                model={chat.model}
                onModelChange={changeModel}
                onSend={send}
                running={chat.state === 'working'}
                onStop={stop}
                fill={fill}
                channel={compose}
                initCommands={chat.slashCommands}
                queue={queueControls}
                above={
                  running.length === 0 && chips === null ? undefined : (
                    <>
                      <BackgroundIndicator tasks={running} onJump={(taskId) => jumpToTask.current?.(taskId)} />
                      {chips !== null && <ArtifactsRow chips={chips} now={now} onOpen={(chip) => panel.open(chip.active ? null : chip.artifact.id)} onClose={closeArtifactChip} />}
                    </>
                  )
                }
                edge={
                  bar === null ? undefined : (
                    <OwnerStrip
                      bar={bar}
                      busy={busy}
                      takingOver={takingOver}
                      onAction={() => {
                        if (bar.action === 'take-over') void act(takeOver)
                        else setHold(bar.action === 'cancel' ? 'held' : 'armed')
                      }}
                    />
                  )
                }
                sendDraft={sendDraft}
              />
            </div>
          </div>
          {opened !== null && layout.mode === 'split' && artifactPanel(opened, false)}
        </div>
      )}
    </div>
  )
}

/** Chat or Terminal: who drives the conversation. Moving to the terminal waits for an idle agent. */
