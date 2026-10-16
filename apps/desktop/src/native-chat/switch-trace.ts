import { api } from '@/api'

// How long one chat/terminal switch takes in the app, step by step, so a slow switch can be read
// instead of guessed. Each switch writes one JSON line to <state>/logs/desktop-switch.log (by default
// ~/.megabrain/logs/desktop-switch.log): every step in ms since the click.
//
// To the terminal: click, modeSent, modeReturned, terminalOpenCalled, terminalOpened (PTY or tmux attach
// ready), firstOutput (first bytes from the TUI), firstPaint (xterm rendered them).
// Back to chat: click, terminalClosed, modeSent, modeReturned, firstState (first state line the follow
// applied after the click), settled (the first one that is not starting).

export type SwitchStep =
  | 'click'
  | 'modeSent'
  | 'modeReturned'
  | 'terminalOpenCalled'
  | 'terminalOpened'
  | 'firstOutput'
  | 'firstPaint'
  | 'terminalClosed'
  | 'firstState'
  | 'settled'

export interface SwitchTrace {
  chatId: string
  agent: string
  to: 'chat' | 'terminal'
  engine?: string
  at: string
  start: number
  steps: Partial<Record<SwitchStep, number>>
}

export type SwitchOutcome = 'ok' | 'error' | 'timeout'

export interface SwitchTraceRecord {
  kind: 'chat-switch'
  to: SwitchTrace['to']
  chatId: string
  agent: string
  engine?: string
  at: string
  outcome: SwitchOutcome
  error?: string
  totalMs: number
  steps: Partial<Record<SwitchStep, number>>
}

export function createSwitchTrace(target: { chatId: string; agent: string; to: SwitchTrace['to']; engine?: string }, now: number, at: string): SwitchTrace {
  return { ...target, at, start: now, steps: { click: 0 } }
}

/** Records a step the first time it happens; a later mark of the same step is ignored. */
export function markStep(trace: SwitchTrace, step: SwitchStep, now: number) {
  if (trace.steps[step] === undefined) trace.steps[step] = Math.round(now - trace.start)
}

export function traceRecord(trace: SwitchTrace, outcome: SwitchOutcome, error?: string): SwitchTraceRecord {
  const totalMs = Math.max(0, ...Object.values(trace.steps))
  return {
    kind: 'chat-switch',
    to: trace.to,
    chatId: trace.chatId,
    agent: trace.agent,
    ...(trace.engine === undefined ? {} : { engine: trace.engine }),
    at: trace.at,
    outcome,
    ...(error === undefined ? {} : { error }),
    totalMs,
    steps: trace.steps,
  }
}

// The switch each chat is in, and the timer that writes it if its last step never comes.
const active = new Map<string, { trace: SwitchTrace; timer: ReturnType<typeof setTimeout>; started: boolean }>()
const TIMEOUT_MS = 20_000

/** Starts the trace of a switch at the click; a switch still open for the chat is written as it stands. */
export function beginSwitch(chatId: string, agent: string, to: SwitchTrace['to']) {
  endSwitch(chatId, 'timeout')
  const trace = createSwitchTrace({ chatId, agent, to }, performance.now(), new Date().toISOString())
  active.set(chatId, { trace, timer: setTimeout(() => endSwitch(chatId, 'timeout'), TIMEOUT_MS), started: false })
}

/** Marks a step of the chat's open switch; outside a switch it does nothing, so callers need not know. */
export function switchStep(chatId: string, step: SwitchStep, to?: SwitchTrace['to']) {
  const open = active.get(chatId)
  if (open === undefined || (to !== undefined && open.trace.to !== to)) return
  markStep(open.trace, step, performance.now())
}

export function switchEngine(chatId: string, engine: string) {
  const open = active.get(chatId)
  if (open !== undefined) open.trace.engine = engine
}

/**
 * A state line the follow applied. Back to chat, the first one after the click is firstState, and the
 * first one past the agent's start (any state but starting, after a starting) settles the switch.
 */
export function switchState(chatId: string, state: string) {
  const open = active.get(chatId)
  if (open === undefined || open.trace.to !== 'chat') return
  markStep(open.trace, 'firstState', performance.now())
  if (state === 'starting') open.started = true
  else if (open.started) {
    markStep(open.trace, 'settled', performance.now())
    endSwitch(chatId, 'ok')
  }
}

/** Writes the chat's open switch (only one in that direction, given `to`); a failed write never reaches the person. */
export function endSwitch(chatId: string, outcome: SwitchOutcome, error?: unknown, to?: SwitchTrace['to']) {
  const open = active.get(chatId)
  if (open === undefined || (to !== undefined && open.trace.to !== to)) return
  active.delete(chatId)
  clearTimeout(open.timer)
  const message = error === undefined ? undefined : error instanceof Error ? error.message : String(error)
  void api.logSwitchTrace(traceRecord(open.trace, outcome, message)).catch(() => {})
}
