import type { InputStatus } from '@/api/schema'

// The Device tab's input session, one per simulator and shared by every view of it. Showing a
// device starts its session (the CLI's start is idempotent and returns at once) and asks for its
// status every second until it is ready or failed; frames and input wait for ready. A cold start
// builds WebDriverAgent for about a minute, so a session left while starting keeps starting and is
// never started twice. A ready session nobody shows stops after stopDelayMs, so a quick switch away
// and back keeps it.

export type InputView = { kind: 'idle' } | { kind: 'starting'; phase: string | null; elapsedMs: number } | { kind: 'ready' } | { kind: 'failed'; error: string }

export const preparingNote = 'The first time takes about a minute.'

/** What the screen shows for a status, with the time since the CLI started the session. */
export function inputView(status: InputStatus, now: number): InputView {
  if (status.state === 'none') return { kind: 'idle' }
  if (status.state === 'ready') return { kind: 'ready' }
  if (status.state === 'failed') return { kind: 'failed', error: status.error ?? 'The input session failed' }
  const started = status.startedAt === null ? Number.NaN : Date.parse(status.startedAt)
  const phase = status.phase === null ? null : status.phase.charAt(0).toUpperCase() + status.phase.slice(1)
  return { kind: 'starting', phase, elapsedMs: Number.isFinite(started) ? Math.max(0, now - started) : 0 }
}

/** 42 s as 0:42, 61 s as 1:01. */
export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const instruction = /;?\s*run native input \S+.*$/i
const pathPattern = /(\/[^\s()'"]+)/

/** The line of a CLI error worth showing, without its instruction to run a command, and a log path it names. */
export function failureDetail(error: string): { line: string; log: string | null } {
  const lines = error
    .split('\n')
    .map((line) => line.replace(instruction, '').trim())
    .filter((line) => line !== '')
  const logLine = lines.find((line) => /^log:/i.test(line))
  const meaningful = lines.filter((line) => line !== logLine)
  const line = meaningful.at(-1) ?? error.trim()
  const log = (logLine ?? line).match(pathPattern)?.[1] ?? null
  return { line, log }
}

export interface InputSessionDeps {
  start(udid: string): Promise<unknown>
  status(udid: string): Promise<InputStatus>
  stop(udid: string): Promise<unknown>
  now(): number
  /** Runs `run` after `ms`; the returned function cancels it. */
  later(run: () => void, ms: number): () => void
}

interface Session {
  status: InputStatus
  watchers: Set<(view: InputView) => void>
  /** Bumped by each start, so an answer to an older one is ignored. */
  generation: number
  cancelPoll: (() => void) | null
  cancelStop: (() => void) | null
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function createInputSessions(deps: InputSessionDeps, { pollMs = 1_000, stopDelayMs = 1_500 } = {}) {
  const sessions = new Map<string, Session>()

  const emit = (session: Session) => {
    const view = inputView(session.status, deps.now())
    for (const watcher of session.watchers) watcher(view)
  }
  const settle = (udid: string, session: Session, status: InputStatus) => {
    // A session the CLI no longer knows starts again while someone shows it.
    if (status.state === 'none' && session.watchers.size > 0) return start(udid, session)
    session.status = status
    emit(session)
    if (status.state === 'starting') session.cancelPoll = deps.later(() => poll(udid, session, session.generation), pollMs)
    else if (session.watchers.size === 0) {
      // Nobody shows it: a ready session stops after the delay, any other is forgotten.
      if (status.state === 'ready') scheduleStop(udid, session)
      else sessions.delete(udid)
    }
  }
  const poll = (udid: string, session: Session, generation: number) => {
    session.cancelPoll = null
    deps.status(udid).then(
      (status) => generation === session.generation && settle(udid, session, status),
      (error: unknown) => generation === session.generation && settle(udid, session, failure(udid, error)),
    )
  }
  const failure = (udid: string, error: unknown): InputStatus => ({ udid, state: 'failed', phase: null, startedAt: null, error: message(error) })
  const start = (udid: string, session: Session) => {
    session.cancelPoll?.()
    const generation = (session.generation += 1)
    session.status = { udid, state: 'starting', phase: null, startedAt: new Date(deps.now()).toISOString(), error: null }
    emit(session)
    deps.start(udid).then(
      () => generation === session.generation && (session.cancelPoll = deps.later(() => poll(udid, session, generation), pollMs)),
      (error: unknown) => generation === session.generation && settle(udid, session, failure(udid, error)),
    )
  }
  const scheduleStop = (udid: string, session: Session) => {
    session.cancelStop?.()
    session.cancelStop = deps.later(() => {
      sessions.delete(udid)
      void deps.stop(udid).catch(() => undefined)
    }, stopDelayMs)
  }

  return {
    /** Shows `udid`'s session to `onView` now and on every change; the returned function stops watching. */
    watch(udid: string, onView: (view: InputView) => void): () => void {
      let session = sessions.get(udid)
      const fresh = session === undefined
      if (session === undefined) {
        session = { status: { udid, state: 'none', phase: null, startedAt: null, error: null }, watchers: new Set(), generation: 0, cancelPoll: null, cancelStop: null }
        sessions.set(udid, session)
      }
      const held = session
      held.cancelStop?.()
      held.cancelStop = null
      held.watchers.add(onView)
      if (fresh) start(udid, held)
      else onView(inputView(held.status, deps.now()))
      return () => {
        held.watchers.delete(onView)
        if (held.watchers.size > 0 || sessions.get(udid) !== held) return
        if (held.status.state === 'ready') scheduleStop(udid, held)
        else if (held.status.state === 'failed') sessions.delete(udid)
      }
    },
    /** Starts `udid`'s session again, after a failure or when its frames stopped. */
    retry(udid: string) {
      const session = sessions.get(udid)
      if (session !== undefined) start(udid, session)
    },
  }
}
