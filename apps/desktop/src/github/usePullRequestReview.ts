import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import type { GithubReviewers, GithubReviewThread } from '@/api/schema'

// The review state around a pull request's diff, each read on its own so one failing (an older CLI,
// a gh hiccup) leaves the rest of the page working: the review threads and who reviews it.

function useRead<T>(read: () => Promise<T>, wanted: boolean) {
  const [value, setValue] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const asked = useRef(0)
  const reload = useCallback(async () => {
    const ask = ++asked.current
    try {
      const result = await read()
      if (ask !== asked.current) return
      setValue(result)
      setError(null)
    } catch (caught: unknown) {
      if (ask === asked.current) setError(caught)
    }
  }, [read])
  const started = useRef(false)
  useEffect(() => {
    started.current = false
    setValue(null)
    setError(null)
  }, [reload])
  useEffect(() => {
    if (!wanted || started.current) return
    started.current = true
    void reload()
  }, [wanted, reload])
  return { value, error, reload }
}

export interface ReviewThreads {
  threads: GithubReviewThread[] | null
  error: unknown
  reload: () => Promise<void>
  reply: (threadId: string, body: string) => Promise<void>
  resolve: (threadId: string, resolved: boolean) => Promise<void>
}

/** The review threads; a reply or a resolve rejects with gh's message and re-reads the threads once it lands. */
export function useReviewThreads(root: string, number: number, wanted: boolean): ReviewThreads {
  const read = useCallback(() => api.prThreads(root, number), [root, number])
  const { value, error, reload } = useRead(read, wanted)
  const reply = useCallback(
    async (threadId: string, body: string) => {
      await api.replyThread(root, number, threadId, body)
      await reload()
    },
    [root, number, reload],
  )
  const resolve = useCallback(
    async (threadId: string, resolved: boolean) => {
      await api.resolveThread(root, number, threadId, resolved)
      await reload()
    },
    [root, number, reload],
  )
  return { threads: value, error, reload, reply, resolve }
}

export interface Reviewers {
  reviewers: GithubReviewers | null
  error: unknown
  reload: () => Promise<void>
  request: (logins: string[], remove: boolean) => Promise<void>
}

export function useReviewers(root: string, number: number, wanted: boolean): Reviewers {
  const read = useCallback(() => api.prReviewers(root, number), [root, number])
  const { value, error, reload } = useRead(read, wanted)
  const request = useCallback(
    async (logins: string[], remove: boolean) => {
      await api.requestReview(root, number, logins, remove)
      await reload()
    },
    [root, number, reload],
  )
  return { reviewers: value, error, reload, request }
}
