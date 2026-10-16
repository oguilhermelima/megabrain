import { api } from '@/api'

// How long one native chat start takes, step by step, so a slow start can be read instead of
// guessed. Each start writes one JSON line to <state>/logs/desktop-chat-start.log (by default
// ~/.megabrain/logs/desktop-chat-start.log): every step in ms since the click.
//
// App steps, timed in the app: click (Enter in the launcher or the agent row), startSent and
// startReturned (the one `chat start` CLI call, which carries model, effort and first message:
// process boot, chatd, the chat record), followCalled (the chat view subscribed),
// firstState (the first state line reached the view), agentReadyShown and firstOutputShown (the view
// received those daemon events).
// Daemon steps, from the time chatd stamped on each event (same machine clock): created (chatd saved
// the chat and published "Started"), agentReady (the first state past starting: for Claude the
// process is up, or its system/init arrived when a message was queued; for Codex initialize and
// thread/start answered), firstOutput (the first reply, thinking or tool call).
// A start settles at agentReady, or at firstOutput when it carried a message.
// Read the latest: tail -n 5 ~/.megabrain/logs/desktop-chat-start.log | jq -c '{agent, outcome, totalMs, steps}'

export type StartStep =
  | 'click'
  | 'startSent'
  | 'startReturned'
  | 'followCalled'
  | 'firstState'
  | 'created'
  | 'agentReady'
  | 'agentReadyShown'
  | 'firstOutput'
  | 'firstOutputShown'

export interface StartTrace {
  agent: string
  withMessage: boolean
  chatId: string | null
  at: string
  start: number
  wallStart: number
  steps: Partial<Record<StartStep, number>>
}

export type StartOutcome = 'ok' | 'error' | 'timeout'

export interface StartTraceRecord {
  kind: 'chat-start'
  chatId: string | null
  agent: string
  at: string
  withMessage: boolean
  outcome: StartOutcome
  error?: string
  totalMs: number
  steps: Partial<Record<StartStep, number>>
}

/** A start at the click: `now` on the performance clock, `wallNow` in epoch ms for the daemon's event times. */
export function createStartTrace(target: { agent: string; withMessage: boolean }, now: number, wallNow: number): StartTrace {
  return { ...target, chatId: null, at: new Date(wallNow).toISOString(), start: now, wallStart: wallNow, steps: { click: 0 } }
}

function mark(trace: StartTrace, step: StartStep, ms: number) {
  if (trace.steps[step] === undefined && Number.isFinite(ms)) trace.steps[step] = Math.round(ms)
}

/** Records an app step the first time it happens; a later mark of the same step is ignored. */
export function markStartStep(trace: StartTrace, step: StartStep, now: number) {
  mark(trace, step, now - trace.start)
}

/** A chat event as the follow delivers it; a delta's time is not in its schema, so it is read when present. */
export interface StartEvent {
  kind: string
  text: string
  at?: unknown
}

const outputKinds = new Set(['assistant', 'thinking', 'delta', 'tool-call'])

/**
 * Marks what one chat event shows: the daemon step from the time it carries, and when the view got
 * it. True once the start has settled.
 */
export function markStartEvent(trace: StartTrace, event: StartEvent, now: number): boolean {
  const daemon = (step: StartStep) => mark(trace, step, typeof event.at === 'string' ? Date.parse(event.at) - trace.wallStart : Number.NaN)
  if (event.kind === 'state') {
    markStartStep(trace, 'firstState', now)
    if (event.text !== 'starting') {
      daemon('agentReady')
      if (trace.steps.agentReady !== undefined) markStartStep(trace, 'agentReadyShown', now)
    }
  } else if (event.kind === 'system' && event.text.startsWith('Started ')) daemon('created')
  else if (outputKinds.has(event.kind)) {
    daemon('firstOutput')
    if (trace.steps.firstOutput !== undefined) markStartStep(trace, 'firstOutputShown', now)
  }
  return trace.withMessage ? trace.steps.firstOutputShown !== undefined : trace.steps.agentReadyShown !== undefined
}

export function startRecord(trace: StartTrace, outcome: StartOutcome, error?: string): StartTraceRecord {
  return {
    kind: 'chat-start',
    chatId: trace.chatId,
    agent: trace.agent,
    at: trace.at,
    withMessage: trace.withMessage,
    outcome,
    ...(error === undefined ? {} : { error }),
    totalMs: Math.max(0, ...Object.values(trace.steps)),
    steps: trace.steps,
  }
}

// The starts in flight: by a launch token until `chat start` returns, then by the chat's id.
const active = new Map<string, { trace: StartTrace; timer: ReturnType<typeof setTimeout> }>()
const TIMEOUT_MS = 60_000

/** Starts the trace at the click; the token names it until the chat has an id. */
export function beginStart(agent: string, withMessage: boolean): string {
  const token = `start-${crypto.randomUUID()}`
  const trace = createStartTrace({ agent, withMessage }, performance.now(), Date.now())
  active.set(token, { trace, timer: setTimeout(() => endStart(token, 'timeout'), TIMEOUT_MS) })
  return token
}

/** Marks a step of an open start, by token or chat id; outside a start it does nothing. */
export function startStep(key: string, step: StartStep) {
  const open = active.get(key)
  if (open !== undefined) markStartStep(open.trace, step, performance.now())
}

/** `chat start` returned: the trace follows the chat's id from now on. */
export function bindStart(token: string, chatId: string) {
  const open = active.get(token)
  if (open === undefined) return
  active.delete(token)
  open.trace.chatId = chatId
  markStartStep(open.trace, 'startReturned', performance.now())
  active.set(chatId, open)
}

/** An event the chat view applied; the start is written once it settles. */
export function startEvent(chatId: string, event: StartEvent) {
  const open = active.get(chatId)
  if (open !== undefined && markStartEvent(open.trace, event, performance.now())) endStart(chatId, 'ok')
}

/** Writes the open start; a failed write never reaches the person. */
export function endStart(key: string, outcome: StartOutcome, error?: unknown) {
  const open = active.get(key)
  if (open === undefined) return
  active.delete(key)
  clearTimeout(open.timer)
  const message = error === undefined ? undefined : error instanceof Error ? error.message : String(error)
  void api.logChatStartTrace(startRecord(open.trace, outcome, message)).catch(() => {})
}
