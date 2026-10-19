import type { ChatQueueItem, OrchestrationGraph, OrchestrationNode, TranscriptEvent } from '@/api/schema'
import type { BackgroundTask } from '@/chat/background-tasks'
import { formatElapsed } from '@/native-chat/chat-model'

// The tray above a native chat's composer: the work running outside the transcript, one pill per
// kind with how many and how long the oldest has run. Background shells, monitors and agents come
// from the chat's background-task events, subagents from their calls with no end yet, lanes from the
// orchestration graph, and the queue from the chat's own queue.

export type TrayKind = 'shell' | 'monitor' | 'task' | 'subagent' | 'lane' | 'queue'

export interface TrayEntry {
  id: string
  kind: TrayKind
  label: string
  startedAt: string | null
  status: string
}

export interface TrayPill {
  kind: TrayKind
  count: number
  longestMs: number | null
  label: string
}

const order: TrayKind[] = ['shell', 'monitor', 'task', 'subagent', 'lane', 'queue']
const taskKind: Record<BackgroundTask['kind'], TrayKind> = { shell: 'shell', monitor: 'monitor', agent: 'subagent', other: 'task' }
const nouns: Record<TrayKind, [string, string]> = {
  shell: ['shell command', 'shell commands'],
  monitor: ['monitor', 'monitors'],
  task: ['background task', 'background tasks'],
  subagent: ['subagent', 'subagents'],
  lane: ['lane', 'lanes'],
  queue: ['queued message', 'queued messages'],
}
const settledLane = new Set<OrchestrationNode['state']>(['done', 'closed', 'failed'])

/** The subagents whose call has no result that ended them yet, oldest first. */
export function runningSubagents(events: readonly TranscriptEvent[]): TrayEntry[] {
  const ended = new Set(events.flatMap((event) => (event.kind === 'tool-result' && event.subagent !== undefined ? [event.subagent.id] : [])))
  return events.flatMap((event) => {
    const subagent = event.subagent
    if (event.kind !== 'tool-call' || subagent === undefined || ended.has(subagent.id)) return []
    const label = [subagent.type ?? 'Subagent', subagent.description].filter((part) => part !== undefined && part !== '').join(' · ')
    return [{ id: `subagent-${subagent.id}`, kind: 'subagent' as const, label, startedAt: event.at, status: 'working' }]
  })
}

/** The lanes this chat started that have not finished. */
export function chatLanes(graph: OrchestrationGraph | null): OrchestrationNode[] {
  if (graph === null) return []
  return graph.nodes.filter((node) => node.kind === 'lane' && node.parent === graph.focus && !settledLane.has(node.state))
}

const queueText = (item: ChatQueueItem) => item.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(' ').trim() || 'Image'

export function trayEntries({ tasks, events, lanes, queue }: { tasks: readonly BackgroundTask[]; events: readonly TranscriptEvent[]; lanes: readonly OrchestrationNode[]; queue: readonly ChatQueueItem[] }): TrayEntry[] {
  return [
    ...tasks.filter((task) => task.state === 'running').map((task) => ({ id: task.id, kind: taskKind[task.kind], label: task.label, startedAt: task.startedAt, status: 'running' })),
    ...runningSubagents(events),
    ...lanes.map((lane) => ({ id: lane.id, kind: 'lane' as const, label: lane.label, startedAt: lane.startedAt, status: lane.state })),
    ...queue.map((item) => ({ id: item.id, kind: 'queue' as const, label: queueText(item), startedAt: item.createdAt, status: 'queued' })),
  ]
}

export function pillLabel(kind: TrayKind, count: number): string {
  const [one, many] = nouns[kind]
  return `${count} ${count === 1 ? one : many}`
}

/** How long an entry has run, or null without a readable start. */
export function entryElapsed(entry: Pick<TrayEntry, 'startedAt'>, now: number): number | null {
  const start = entry.startedAt === null ? Number.NaN : Date.parse(entry.startedAt)
  return Number.isNaN(start) ? null : Math.max(0, now - start)
}

/** One pill per kind with entries, in a fixed order. */
export function trayPills(entries: readonly TrayEntry[], now: number): TrayPill[] {
  return order.flatMap((kind) => {
    const own = entries.filter((entry) => entry.kind === kind)
    if (own.length === 0) return []
    const times = own.map((entry) => entryElapsed(entry, now)).filter((value): value is number => value !== null)
    const longestMs = times.length === 0 ? null : Math.max(...times)
    const noun = pillLabel(kind, own.length)
    return [{ kind, count: own.length, longestMs, label: longestMs === null ? noun : `${noun} — ${formatElapsed(longestMs)}` }]
  })
}
