import type { TranscriptEvent } from '@/api/schema'

// Pure logic for what a turn leaves behind: the line under a turn that was cut before the agent
// finished it, and the work it left running in the background. A background task arrives as one
// event when it starts and one on every change of state, all under its id; the conversation shows
// it once, where it started, in its latest state.

export type BackgroundTask = NonNullable<TranscriptEvent['backgroundTask']>
type CutReason = NonNullable<TranscriptEvent['reason']>

const cutWhy: Record<CutReason, string | null> = {
  interrupted: 'you interrupted',
  'process-exited': 'the agent process exited',
  error: 'error',
  limit: 'usage limit',
  unknown: null,
}

/** The quiet line under a cut turn: that it stopped before finishing, and why when the event says. */
export function cutLine(event: Pick<TranscriptEvent, 'reason' | 'detail'>): string {
  const why = cutWhy[event.reason ?? 'unknown']
  const detail = event.detail?.trim() ?? ''
  if (why === null) return 'Stopped before finishing'
  return `Stopped before finishing · ${event.reason === 'error' && detail !== '' ? `${why}: ${detail}` : why}`
}

/** A later state keeps what it leaves out (an empty label or start) from the state before it. */
function merge(previous: BackgroundTask | undefined, next: BackgroundTask): BackgroundTask {
  if (previous === undefined) return next
  return {
    ...previous,
    ...next,
    label: next.label === '' ? previous.label : next.label,
    startedAt: next.startedAt === '' ? previous.startedAt : next.startedAt,
    endedAt: next.endedAt ?? previous.endedAt,
    summary: next.summary ?? previous.summary,
    exitCode: next.exitCode ?? previous.exitCode,
  }
}

export interface TaskRows {
  /** The events to show: a task's first event only; the same array when no task repeats. */
  events: TranscriptEvent[]
  /** Each task's latest state, by its id. */
  latest: ReadonlyMap<string, BackgroundTask>
}

export function taskRows(events: TranscriptEvent[]): TaskRows {
  const latest = new Map<string, BackgroundTask>()
  let repeated = false
  for (const event of events) {
    const task = event.backgroundTask
    if (event.kind !== 'background-task' || task === undefined) continue
    if (latest.has(task.id)) repeated = true
    latest.set(task.id, merge(latest.get(task.id), task))
  }
  if (!repeated) return { events, latest }
  const seen = new Set<string>()
  const shown = events.filter((event) => {
    const id = event.kind === 'background-task' ? event.backgroundTask?.id : undefined
    if (id === undefined) return true
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  return { events: shown, latest }
}

/** The tasks still running, the oldest first. */
export function runningTasks(latest: ReadonlyMap<string, BackgroundTask>): BackgroundTask[] {
  return [...latest.values()].filter((task) => task.state === 'running').sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
}

/** The tool whose icon a task's kind shows. */
export const taskTool: Record<BackgroundTask['kind'], string> = { shell: 'Bash', monitor: 'Monitor', agent: 'Task', other: '' }

export function runningLabel(count: number): string {
  return `${count} running in background`
}

/** Where a task stands, in the words its row shows. */
export function taskStateLabel(task: BackgroundTask): string {
  switch (task.state) {
    case 'running':
      return 'running'
    case 'completed':
      return 'done'
    case 'failed':
      return task.exitCode == null ? 'failed' : `failed · exit ${task.exitCode}`
    case 'killed':
      return 'stopped'
    case 'lost':
      return 'no longer tracked'
  }
}

/** How long a task ran: to now while it runs, to its end once it has one; a lost task without an end has none. */
export function taskDurationMs(task: BackgroundTask, now: number): number | null {
  const start = Date.parse(task.startedAt)
  const end = task.endedAt == null ? (task.state === 'running' ? now : Number.NaN) : Date.parse(task.endedAt)
  const ms = end - start
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}
