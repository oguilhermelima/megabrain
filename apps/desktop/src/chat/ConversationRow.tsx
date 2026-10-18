import { createContext, memo, useContext, useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { TranscriptEvent } from '@/api/schema'
import { Chevron } from '@/advanced/chrome'
import { AgentIcon, ConversationAgent } from '@/components/agent-icons'
import { NoticeCard } from '@/chat/NoticeCard'
import { relayedPreview, relayedTarget, thoughtLabel, type ConversationItem, type ToolStatus } from '@/chat/conversation-model'
import { ToolIcon } from '@/chat/ToolIcon'
import { CallText, StateMark, ToolItem } from '@/chat/ToolItem'
import { markMenu } from '@/chat/chat-menu'
import { groupToolRuns, toolGroupSummary, toolName, type DisplayItem } from '@/chat/tool-groups'
import { toolRunLine } from '@/chat/tool-sentence'
import { subagentGroupSummary, subagentSummary, visibleSteps, type SubagentItem, type SubagentState } from '@/chat/subagent-model'
import { formatElapsed } from '@/native-chat/chat-model'
import { MarkdownText } from '@/chat/markdown'
import { CommandOutput } from '@/chat/CommandOutput'
import { UserMessageBody } from '@/chat/MessageImages'
import { MessageActions, SelectTarget } from '@/native-chat/MessageActions'
import { cutLine, taskDurationMs, taskStateLabel, taskTool, type BackgroundTask } from '@/chat/background-tasks'
import type { NoticeDisplayItem } from '@/chat/notice-model'

export type OpenChat = (target: { dispatchId: string } | { sessionId: string }) => void

/** A row's right click offers its message: the markdown as sent, and the element it renders as. */
const markMessage = (text: string) => (event: ReactMouseEvent<HTMLElement>) => markMenu(event, { message: { markdown: text, element: event.currentTarget } })

function UserMessage({ event, pending = false }: { event: TranscriptEvent; pending?: boolean }) {
  return (
    <li className="group/message relative flex justify-end">
      {!pending && <SelectTarget event={event} />}
      <div onContextMenu={markMessage(event.text)} title={pending ? 'Sending…' : undefined} className={`min-w-0 max-w-[75%] rounded-[20px] bg-accent/15 px-4 py-2.5 text-ink-100 transition-opacity ${pending ? 'opacity-70' : ''}`}>
        <UserMessageBody text={event.text} images={event.images} parts={event.parts} />
      </div>
      {!pending && <MessageActions event={event} side="right" />}
    </li>
  )
}

function AssistantMessage({ event, streaming = false }: { event: TranscriptEvent; streaming?: boolean }) {
  return (
    <li onContextMenu={markMessage(event.text)} className="group/message relative max-w-[80%] text-ink-200">
      {!streaming && <SelectTarget event={event} />}
      <MarkdownText text={event.text} />
      {!streaming && <MessageActions event={event} side="left" />}
    </li>
  )
}

/** The id of the conversation's latest command output, whose card opens; older ones open collapsed. */
export const LatestCommandContext = createContext<string | null>(null)

/** An info command's result: an agent's local command output, or one megabrain answered itself with data. */

/**
 * Messages as an image to share: as the transcript shows them, on the app's background, with the chat's
 * agent and title under them when `title` is set.
 */
export function ShareCard({ events, agent, title, width }: { events: readonly TranscriptEvent[]; agent: string | null; title: string | null; width: number }) {
  return (
    <div style={{ width }} className="bg-ink-950 px-8 pt-8 pb-6 font-sans text-[15px] text-ink-200 antialiased">
      <ol className="space-y-3">{events.map((event) => (event.kind === 'user' ? <UserMessage key={event.id} event={event} /> : <AssistantMessage key={event.id} event={event} />))}</ol>
      {title !== null && (
        <p className="mt-6 flex items-center gap-2 border-t border-white/[0.06] pt-4 text-[12.5px] text-ink-400">
          {agent !== null && <AgentIcon agent={agent} size={14} activity="idle" />}
          <span className="min-w-0 truncate">{title}</span>
        </p>
      )}
    </div>
  )
}

export const footerKey = 'megabrain.share.footer'
export function readShareFooter(): boolean {
  try {
    return localStorage.getItem(footerKey) !== '0'
  } catch {
    return true
  }
}


function CommandMessage({ event, command }: { event: TranscriptEvent; command: string }) {
  const latest = useContext(LatestCommandContext)
  return (
    <li onContextMenu={markMessage(event.text)} className="max-w-[85%]">
      <CommandOutput command={command} text={event.text} data={event.data} latest={latest === null || latest === event.id} />
    </li>
  )
}

/** Renders an approval event in place; a native chat provides it, other views show the event as text. */
export const ApprovalRendererContext = createContext<((event: TranscriptEvent) => ReactNode) | null>(null)

function ApprovalMessage({ event }: { event: TranscriptEvent }) {
  const render = useContext(ApprovalRendererContext)
  return render === null ? <SystemMessage event={event} /> : <li>{render(event)}</li>
}

function SystemMessage({ event }: { event: TranscriptEvent }) {
  return (
    <li onContextMenu={markMessage(event.text)} className="text-center text-[12px] text-ink-400">
      {event.text}
    </li>
  )
}

/** Under a turn that ended before the agent finished it: that it stopped, and why. The partial answer above stays as it is. */
function CutTurnLine({ event }: { event: TranscriptEvent }) {
  const detail = event.detail?.trim() ?? ''
  return (
    <li role="note" title={detail === '' ? undefined : detail} className="flex max-w-[80%] items-center gap-2 text-[12.5px] text-ink-400">
      <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-ink-500">
        <circle cx="8" cy="8" r="5.75" />
        <rect x="6" y="6" width="4" height="4" rx="0.75" />
      </svg>
      <span className="min-w-0 truncate">{cutLine(event)}</span>
    </li>
  )
}

function RelayedMessage({ event, onOpenChat }: { event: TranscriptEvent; onOpenChat: OpenChat | undefined }) {
  const origin = event.origin
  if (origin === undefined) return null
  const [open, setOpen] = useState(false)
  const target = relayedTarget(origin)
  const header = origin.kind === 'parent' ? `From parent · ${origin.label}` : `From ${origin.label}`
  return (
    <li onContextMenu={markMessage(event.text)} className="max-w-[85%] rounded-2xl border border-white/[0.06] bg-white/[0.03]">
      <div className="flex items-center gap-2 px-3.5 py-2">
        <span className="shrink-0 text-[13px] text-ink-400" aria-label={origin.kind === 'parent' ? 'relayed from parent' : 'relayed from child'}>
          {origin.kind === 'parent' ? '↑' : '↓'}
        </span>
        <button type="button" onClick={() => setOpen((value) => !value)} className="min-w-0 flex-1 text-left">
          <span className="block text-[12px] font-semibold text-ink-300">{header}</span>
          {!open && <span className="block truncate text-[13px] text-ink-400">{relayedPreview(event.text)}</span>}
        </button>
        {onOpenChat !== undefined && target !== null && (
          <button
            type="button"
            onClick={() => onOpenChat(target)}
            className="shrink-0 rounded-full border border-white/10 px-2.5 py-1 text-[12px] font-semibold text-ink-300 hover:bg-white/[0.08]"
          >
            →
          </button>
        )}
      </div>
      {open && (
        <div className="px-3.5 pb-3">
          <MarkdownText text={event.text} />
        </div>
      )}
    </li>
  )
}

/**
 * What marks the agent's own work: the conversation's agent mark when the view names one (see
 * ConversationAgent), megabrain's orb otherwise; settled, the same mark held still and grey. Tool
 * rows show their tool's icon instead (ToolIcon).
 */
function WorkMark({ size, working }: { size: number; working: boolean }) {
  const agent = useContext(ConversationAgent)
  if (agent === null) return <span aria-hidden="true" style={{ width: size, height: size }} className={`orb shrink-0 ${working ? '' : 'idle'}`} />
  return (
    <span aria-hidden="true" className="contents text-ink-400">
      <AgentIcon agent={agent} size={size} activity={working ? 'working' : 'idle'} />
    </span>
  )
}

/**
 * Collapsed to how long the agent thought, with the same chevron the live thinking opens by; opened, what it thought,
 * whole. Thinking still running has no row of its own: the working indicator shows its tail.
 */
function ThinkingMessage({ event, thoughtMs }: { event: TranscriptEvent; thoughtMs?: number }) {
  const [open, setOpen] = useState(false)
  return (
    <li>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex max-w-[80%] items-center gap-2 text-left text-[13px] text-ink-400 hover:text-ink-300">
        <WorkMark size={10} working={false} />
        {thoughtLabel(thoughtMs)}
        <Chevron open={open} />
      </button>
      {open && (
        <p onContextMenu={markMessage(event.text)} className="mt-1 max-w-[80%] whitespace-pre-wrap text-[13px] text-ink-400 italic">
          {event.text}
        </p>
      )}
    </li>
  )
}

/** A run of calls as one sentence; opened, one row per call. */
function ToolGroup({ group, onOpenChat }: { group: Extract<DisplayItem, { type: 'tool-group' }>; onOpenChat: OpenChat | undefined }) {
  const [open, setOpen] = useState(false)
  const line = toolRunLine(group)
  const summary = toolGroupSummary(group)
  const first = group.items.find((item) => item.type === 'tool')
  return (
    <li className="max-w-[85%]">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="group/run flex max-w-full items-center gap-2 rounded-lg py-1 pr-2 pl-0.5 text-left text-[13px] text-ink-300 hover:text-ink-100">
        <ToolIcon name={first?.type === 'tool' ? toolName(first) : summary.tool} status={line.state === 'running' ? 'running' : 'ok'} size={13} />
        <span className="min-w-0 truncate">{line.sentence}</span>
        {/* While it runs, what is running now. */}
        {line.state === 'running' && summary.detail !== '' && <span title={summary.detail} className="min-w-0 truncate font-mono text-[12px] text-ink-400">{summary.detail}</span>}
        {line.failed > 0 && line.state !== 'running' && <span className="shrink-0 text-warn">· {line.failed} failed</span>}
        <StateMark state={line.state} />
        <svg viewBox="0 0 16 16" width={11} height={11} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 text-ink-500 transition-transform group-hover/run:text-ink-300 ${open ? 'rotate-90' : ''}`}>
          <path d="m6 3.5 4.5 4.5L6 12.5" />
        </svg>
      </button>
      {open && (
        <ol className="mt-1 ml-[7px] space-y-0.5 border-l border-white/[0.08] pl-2.5">
          {group.items.map((item) => (
            <Item key={item.type === 'tool' ? item.id : item.event.id} item={item} onOpenChat={onOpenChat} />
          ))}
        </ol>
      )}
    </li>
  )
}

/** Time from `since` to `until`, counting each second while `until` is null. */
function Elapsed({ since, until }: { since: string | null; until: string | null }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (until !== null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [until])
  const start = since === null ? Number.NaN : Date.parse(since)
  if (Number.isNaN(start)) return null
  return <>{formatElapsed((until === null ? now : Date.parse(until)) - start)}</>
}

const subagentToolStatus: Record<SubagentState, ToolStatus> = { working: 'running', completed: 'ok', failed: 'error', stopped: 'ok' }

const subagentOutcome: Record<Exclude<SubagentState, 'working'>, { label: string; tone: string }> = {
  completed: { label: 'Done', tone: 'text-ok' },
  failed: { label: 'Failed', tone: 'text-bad' },
  stopped: { label: 'Stopped', tone: 'text-ink-400' },
}

/**
 * A subagent where the call that started it was: its type and task, whether it still works, its tool count
 * and time, and in one line its latest step (its result once it ended). Open, it lists its own steps with the
 * rows the main chat uses, then its result.
 */
function SubagentBlock({ item, onOpenChat }: { item: SubagentItem; onOpenChat: OpenChat | undefined }) {
  const [open, setOpen] = useState(false)
  const summary = subagentSummary(item)
  const working = summary.state === 'working'
  const outcome = summary.state === 'working' ? null : subagentOutcome[summary.state]
  // Collapsed, the result shows as one plain line: its first, without bold and code marks.
  const line = working || summary.result === null || summary.result === '' ? summary.latest : (summary.result.split('\n')[0] ?? '').replace(/\*\*|`/g, '')
  const steps = open ? groupToolRuns(visibleSteps(item)) : []
  return (
    <li className="max-w-[85%] rounded-2xl border border-white/[0.06] bg-white/[0.03]">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex w-full min-w-0 flex-col gap-0.5 px-3.5 py-2 text-left text-[13px]">
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="w-3 shrink-0 text-[10px] text-ink-400">{open ? '▾' : '▸'}</span>
          <ToolIcon name="Task" status={subagentToolStatus[summary.state]} size={13} />
          <span className="shrink-0 font-semibold text-ink-200">{summary.type}</span>
          <span title={summary.description} className="min-w-0 flex-1 truncate text-ink-300">{summary.description}</span>
          <span className="shrink-0 text-[12px] text-ink-400 tabular-nums">
            {summary.tools} {summary.tools === 1 ? 'tool' : 'tools'}
            {summary.errors > 0 && <span className="font-semibold text-bad"> · {summary.errors} failed</span>}
            {' · '}
            <Elapsed since={summary.startedAt} until={summary.endedAt} />
          </span>
          {outcome !== null && <span className={`shrink-0 text-[12px] font-semibold ${outcome.tone}`}>{outcome.label}</span>}
        </span>
        {!open && line !== null && line !== '' && (
          <span title={line} className={`truncate pl-[2.6rem] text-[12.5px] text-ink-400 ${working ? 'font-mono' : ''}`}>{line}</span>
        )}
      </button>
      {open && (
        <div className="space-y-2 px-3.5 pb-3 pl-[2.6rem]">
          {steps.length > 0 && (
            <ol className="space-y-1.5">
              {steps.map((step) => (
                <Item key={step.type === 'message' ? step.event.id : step.id} item={step} onOpenChat={onOpenChat} />
              ))}
            </ol>
          )}
          {summary.result !== null && summary.result !== '' && (
            <div onContextMenu={markMessage(summary.result)} className="rounded-xl bg-white/[0.05] px-3 py-2 text-ink-200">
              <span className="mb-1 block text-[11px] font-semibold tracking-wide text-ink-400 uppercase">Result</span>
              <MarkdownText text={summary.result} />
            </div>
          )}
          {working && steps.length === 0 && <p className="text-[12.5px] text-ink-400">No steps yet.</p>}
        </div>
      )}
    </li>
  )
}

/** Subagents started side by side: how many still work, then each one's block. */
function SubagentGroup({ group, onOpenChat }: { group: Extract<DisplayItem, { type: 'subagent-group' }>; onOpenChat: OpenChat | undefined }) {
  const summary = subagentGroupSummary(group)
  return (
    <li className="max-w-[85%] space-y-1.5">
      <p className="flex items-center gap-2 px-1 text-[13px] text-ink-400">
        <ToolIcon name="Task" status={summary.working > 0 ? 'running' : summary.failed > 0 ? 'error' : 'ok'} size={13} />
        <span className="font-semibold text-ink-300">{summary.total} subagents</span>
        <span>· {summary.working > 0 ? `${summary.working} working` : 'all finished'}</span>
        {summary.failed > 0 && <span className="font-semibold text-bad">· {summary.failed} failed</span>}
      </p>
      <ol className="space-y-1.5">
        {group.items.map((item) => (
          <SubagentBlock key={item.id} item={item} onOpenChat={onOpenChat} />
        ))}
      </ol>
    </li>
  )
}

/** Each background task's latest state by its id, and the task a jump just landed on; its row reads both here, so a settled row updates in place. */
export const BackgroundTasksContext = createContext<{ latest: ReadonlyMap<string, BackgroundTask>; flashed: string | null }>({ latest: new Map(), flashed: null })

const taskKindName: Record<BackgroundTask['kind'], string> = { shell: 'Background shell', monitor: 'Monitor', agent: 'Background agent', other: 'Background task' }
const taskToolStatus = (state: BackgroundTask['state']): ToolStatus => (state === 'running' ? 'running' : state === 'failed' ? 'error' : 'ok')

/** How long a task ran, counting each second while it runs. */
function TaskDuration({ task }: { task: BackgroundTask }) {
  const running = task.state === 'running'
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  const ms = taskDurationMs(task, now)
  return ms === null ? null : <span className="shrink-0 text-[12px] text-ink-400 tabular-nums">{formatElapsed(ms)}</span>
}

/**
 * Work the agent left running past its answer, where it started: its kind, its label, where it stands and for how
 * long, in its latest state; opened, the summary it ended with.
 */
function BackgroundTaskRow({ event }: { event: TranscriptEvent }) {
  const [open, setOpen] = useState(false)
  const { latest, flashed } = useContext(BackgroundTasksContext)
  const first = event.backgroundTask
  if (first === undefined) return <SystemMessage event={event} />
  const task = latest.get(first.id) ?? first
  const summary = task.summary ?? ''
  const lost = task.state === 'lost'
  return (
    <li className="max-w-[85%]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={summary === '' ? undefined : open}
        disabled={summary === ''}
        title={task.label}
        className={`flex max-w-full items-center gap-2 rounded-lg py-1 pr-2 pl-0.5 text-left text-[13px] text-ink-300 transition-colors duration-500 enabled:hover:text-ink-100 motion-reduce:transition-none ${flashed === task.id ? 'bg-white/[0.07]' : ''}`}
      >
        <ToolIcon name={taskTool[task.kind]} status={taskToolStatus(task.state)} size={13} />
        <span className="shrink-0">{taskKindName[task.kind]}</span>
        <span className="min-w-0 truncate font-mono text-[12px] text-ink-400">{task.label}</span>
        <span className={`shrink-0 text-[12px] ${task.state === 'failed' ? 'text-warn' : lost ? 'text-ink-500 italic' : 'text-ink-400'}`}>· {taskStateLabel(task)}</span>
        <TaskDuration task={task} />
        {(task.state === 'running' || task.state === 'completed' || task.state === 'failed') && <StateMark state={task.state === 'running' ? 'running' : task.state === 'failed' ? 'failed' : 'done'} />}
        {summary !== '' && (
          <svg viewBox="0 0 16 16" width={11} height={11} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 text-ink-500 transition-transform ${open ? 'rotate-90' : ''}`}>
            <path d="m6 3.5 4.5 4.5L6 12.5" />
          </svg>
        )}
      </button>
      {open && summary !== '' && (
        <div className="mt-1 mb-2 ml-6">
          <CallText label={task.state === 'failed' ? 'Error' : 'Result'} text={summary} failed={task.state === 'failed'} />
        </div>
      )}
    </li>
  )
}

// Memoised: a settled row keeps its item object across polls (see conversation-derive.ts).
export const Item = memo(function Item({ item, onOpenChat }: { item: ConversationItem | NoticeDisplayItem; onOpenChat: OpenChat | undefined }) {
  if (item.type === 'notice') return <NoticeCard card={item} onOpenChat={onOpenChat} />
  if (item.type === 'tool-group') return <ToolGroup group={item} onOpenChat={onOpenChat} />
  if (item.type === 'subagent-group') return <SubagentGroup group={item} onOpenChat={onOpenChat} />
  if (item.type === 'subagent') return <SubagentBlock item={item} onOpenChat={onOpenChat} />
  if (item.type === 'tool') return <ToolItem item={item} />
  const event = item.event
  if (event.origin !== undefined) return <RelayedMessage event={event} onOpenChat={onOpenChat} />
  if (event.kind === 'user') return <UserMessage event={event} pending={item.pending} />
  if (event.kind === 'command-output') return <CommandMessage event={event} command={event.command ?? ''} />
  if (event.kind === 'assistant' && event.command !== undefined) return <CommandMessage event={event} command={event.command} />
  if (event.kind === 'assistant') return <AssistantMessage event={event} streaming={item.streaming === true} />
  if (event.kind === 'thinking') return <ThinkingMessage event={event} thoughtMs={item.thoughtMs} />
  if (event.kind === 'approval') return <ApprovalMessage event={event} />
  if (event.kind === 'turn-cut') return <CutTurnLine event={event} />
  if (event.kind === 'background-task') return <BackgroundTaskRow event={event} />
  return <SystemMessage event={event} />
})

