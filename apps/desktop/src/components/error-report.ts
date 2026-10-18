import { api } from '@/api'

// A render error an error boundary caught: where it happened, the error and React's component stack.
// Each one goes to <state>/logs/desktop-errors.log (one JSON line) and to the console, and its details
// are what Copy details puts on the clipboard.

export interface CaughtError {
  at: string
  /** The app root, or a pane. */
  where: 'app' | 'pane'
  /** The item the pane shows; null at the root. */
  item: string | null
  name: string
  message: string
  stack: string | null
  componentStack: string | null
}

export function caughtError(where: CaughtError['where'], item: string | null, error: unknown, componentStack: string | null | undefined, at = new Date()): CaughtError {
  const known = error instanceof Error
  return {
    at: at.toISOString(),
    where,
    item,
    name: known ? error.name : typeof error,
    message: known ? error.message : String(error),
    stack: known ? (error.stack ?? null) : null,
    componentStack: componentStack === undefined || componentStack === null || componentStack.trim() === '' ? null : componentStack.trim(),
  }
}

/** The plain-text report Copy details puts on the clipboard. */
export function errorDetails(caught: CaughtError): string {
  return [
    `${caught.name}: ${caught.message}`,
    `At ${caught.at}, in ${caught.where === 'app' ? 'the app' : `the pane showing ${caught.item ?? 'nothing'}`}.`,
    ...(caught.stack === null ? [] : ['', 'Stack:', caught.stack]),
    ...(caught.componentStack === null ? [] : ['', 'Components:', caught.componentStack]),
  ].join('\n')
}

export function reportCaught(caught: CaughtError) {
  console.error(`[megabrain] ${caught.where} error caught`, caught)
  api.logError(caught).catch((failure: unknown) => console.error('[megabrain] could not log the error', failure))
}
