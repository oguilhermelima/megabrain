import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/api'
import type { NativeChat, OrchestrationEvent, OrchestrationGraph, OrchestrationNode, OrchestrationTarget } from '@/api/schema'
import type { OpenChat } from '@/chat/Conversation'
import { TextSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { useNow } from '@/github/parts'
import { pageMx } from '@/lib/page'
import { usePaneWidth } from '@/native-chat/usePaneWidth'
import { OrchestrationClosed } from '@/native-chat/orchestration/OrchestrationClosed'
import { OrchestrationDetail } from '@/native-chat/orchestration/OrchestrationDetail'
import { OrchestrationDiagram, type LivePulse } from '@/native-chat/orchestration/OrchestrationDiagram'
import { OrchestrationLog } from '@/native-chat/orchestration/OrchestrationLog'
import { dispatchOf, newPulses, type Pulse } from '@/native-chat/orchestration/orchestration-layout'
import { showOrchestration } from '@/native-chat/orchestration/orchestration-shown'
import { closedGroups, visibleGraph } from '@/native-chat/orchestration/orchestration-visible'

// How long a pulse stays on screen: its dot's run plus the glow fading after it (styles.css).
const PULSE_MS = 1_400
// Below this width the detail lies over the bottom of the diagram instead of beside it.
const SIDE_DETAIL_WIDTH = 760

/**
 * The orchestration tree a chat belongs to, with that chat highlighted, followed live over its
 * session log. A click on another app chat's card opens that chat here, in this same view; any other
 * card is selected and its detail shows. A double click on an app chat opens its conversation. A big
 * tree draws its live lanes and only the latest closed ones; the rest wait behind a toggle.
 */
export function OrchestrationView({ target, onOpenChat, onOpenNativeChat }: { target: OrchestrationTarget; onOpenChat?: OpenChat; onOpenNativeChat?: (chat: NativeChat) => void }) {
  const [graph, setGraph] = useState<OrchestrationGraph | null>(null)
  const [error, setError] = useState<unknown>(null)
  // Why the live follow stopped; null while it runs.
  const [ended, setEnded] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [pulses, setPulses] = useState<LivePulse[]>([])
  const [actionError, setActionError] = useState<unknown>(null)
  const now = useNow(1_000)
  const pane = usePaneWidth()
  const pulseIds = useRef(0)
  const pulseTimers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const visible = useMemo(() => (graph === null ? null : visibleGraph(graph)), [graph])
  const groups = useMemo(() => (graph === null || visible === null ? [] : closedGroups(graph, visible.hidden)), [graph, visible])
  const key = 'chatId' in target ? `chat:${target.chatId}` : `session:${target.sessionId}`

  const addPulses = (fresh: Pulse[]) => {
    const live = fresh.map((pulse) => ({ ...pulse, id: (pulseIds.current += 1) }))
    setPulses((current) => [...current, ...live])
    const timer = setTimeout(() => {
      pulseTimers.current.delete(timer)
      setPulses((current) => current.filter((pulse) => !live.includes(pulse)))
    }, PULSE_MS)
    pulseTimers.current.add(timer)
  }

  useEffect(() => {
    let stopped = false
    let stop: (() => void) | null = null
    let previous: OrchestrationEvent[] | null = null
    setGraph(null)
    setError(null)
    setEnded(null)
    setSelected(null)
    const onGraph = (next: OrchestrationGraph) => {
      if (stopped) return
      const fresh = newPulses(previous, next)
      previous = next.events
      setGraph(next)
      if (fresh.length > 0) addPulses(fresh)
    }
    api.followOrchestration(target, onGraph, (reason) => !stopped && setEnded(reason ?? 'The follow ended.')).then(
      (cancel) => {
        if (stopped) cancel()
        else stop = cancel
      },
      // No follow to be had: one snapshot still draws the tree.
      () => {
        if (stopped) return
        setEnded('Live updates are unavailable.')
        api.orchestrationGraph(target).then(onGraph, (caught: unknown) => !stopped && setError(caught))
      },
    )
    const timers = pulseTimers.current
    return () => {
      stopped = true
      stop?.()
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      setPulses([])
    }
    // The target is an object made fresh each render; its key says when it really changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => () => {
    if (clickTimer.current !== null) clearTimeout(clickTimer.current)
  }, [])

  const openApp = (chatId: string, view: 'chat' | 'orchestration') => {
    if (onOpenNativeChat === undefined) return
    setActionError(null)
    showOrchestration(chatId, view === 'orchestration')
    api.chats().then((chats) => {
      const chat = chats.find((entry) => entry.id === chatId)
      if (chat === undefined) setActionError(new Error('That chat is no longer in the app.'))
      else onOpenNativeChat(chat)
    }, setActionError)
  }

  const nodeOf = (id: string): OrchestrationNode | undefined => graph?.nodes.find((node) => node.id === id)
  // Another app chat opens in this view; the focused chat, or a node that is not an app chat, is selected.
  const opensHere = (node: OrchestrationNode | undefined): node is OrchestrationNode & { chatId: string } => node !== undefined && node.chatId !== null && node.id !== graph?.focus && onOpenNativeChat !== undefined

  // A double click must not first open the chat its single click would, so the single click waits a beat.
  const click = (id: string) => {
    const node = nodeOf(id)
    if (!opensHere(node)) return setSelected(id)
    if (clickTimer.current !== null) clearTimeout(clickTimer.current)
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null
      openApp(node.chatId, 'orchestration')
    }, 220)
  }
  const doubleClick = (id: string) => {
    if (clickTimer.current !== null) clearTimeout(clickTimer.current)
    clickTimer.current = null
    const node = nodeOf(id)
    const chatId = node?.chatId ?? null
    if (chatId !== null && onOpenNativeChat !== undefined) openApp(chatId, 'chat')
    else setSelected(id)
  }

  const openerOf = (node: OrchestrationNode): (() => void) | null => {
    if (node.id === graph?.focus) return null
    const { chatId } = node
    if (chatId !== null && onOpenNativeChat !== undefined) return () => openApp(chatId, 'chat')
    if (onOpenChat === undefined) return null
    const dispatch = dispatchOf(node)
    if (dispatch !== null) return () => onOpenChat({ dispatchId: dispatch })
    const { session } = node
    return session === null ? null : () => onOpenChat({ sessionId: session })
  }

  if (error !== null || (graph === null && ended !== null))
    return (
      <div className={`${pageMx} mt-4`}>
        <ErrorNote error={error ?? ended} />
      </div>
    )
  if (graph === null || visible === null)
    return (
      <div className={`${pageMx} mt-4`}>
        <TextSkeleton lines={4} />
      </div>
    )
  const detail = selected === null ? undefined : nodeOf(selected)
  const beside = pane.width >= SIDE_DETAIL_WIDTH
  return (
    <div ref={pane.ref} className="flex min-h-0 flex-1 flex-col">
      {graph.nodes.length === 1 && <p className={`${pageMx} mt-3 text-chat-small text-ink-400`}>This chat started no lanes and has no coordinator.</p>}
      {ended !== null && <p className={`${pageMx} mt-3 text-chat-small text-ink-400`}>Not live: {ended}</p>}
      {actionError !== null && (
        <div className={`${pageMx} mt-3`}>
          <ErrorNote error={actionError} />
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <OrchestrationDiagram graph={visible.graph} pulses={pulses} selected={selected} now={now} onClick={click} onDoubleClick={doubleClick} />
          <OrchestrationClosed groups={groups} count={visible.hidden.length} selected={selected} now={now} onSelect={setSelected} />
        </div>
        {detail !== undefined && (
          <div className={beside ? 'flex w-[320px] shrink-0 flex-col border-l border-white/[0.07]' : 'absolute inset-x-0 bottom-0 flex max-h-[60%] flex-col border-t border-white/[0.07] shadow-[0_-12px_32px_rgb(0_0_0/0.5)]'}>
            <OrchestrationDetail node={detail} onOpen={openerOf(detail)} onClose={() => setSelected(null)} />
          </div>
        )}
      </div>
      <OrchestrationLog events={graph.events} nodes={graph.nodes} onSelect={setSelected} />
    </div>
  )
}
