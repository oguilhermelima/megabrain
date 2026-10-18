import { useSyncExternalStore } from 'react'

// Where the rest of the app asks the Tasks page to show a project's issues, on one issue when one was
// clicked (the project page, a project's menu, the GitHub page's kind switch). The page is one fixed
// item, so the request travels beside it: the page takes it once, when it mounts or while it shows,
// and a later visit opens on what the viewer last picked.

export interface TasksTarget {
  repo: string
  issue: number | null
}

let pending: TasksTarget | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())

export function targetTasks(repo: string, issue: number | null): void {
  pending = { repo, issue }
  notify()
}

/** The request not yet taken, if any. */
export const pendingTasksTarget = (): TasksTarget | null => pending

/** Takes the request, so it applies once. */
export function takeTasksTarget(): void {
  if (pending === null) return
  pending = null
  notify()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useTasksTarget = (): TasksTarget | null => useSyncExternalStore(subscribe, pendingTasksTarget)
