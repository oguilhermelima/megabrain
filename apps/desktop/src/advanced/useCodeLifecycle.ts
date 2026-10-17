import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { api } from '@/api'
import type { Project } from '@/api/schema'
import { codeTargetForRoot, expiredServers, frameHolders, idleServers, serverGraceMs, type CodeShown, type CodeTarget } from '@/code/code-pane-model'
import type { CodeGoto } from '@/code/CodeFrame'

export function useCodeLifecycle({
  codeShown, codeHolders, codeTargets, setCodeTargets, idleCode, setIdleCode, setGotos, projects, usedRoots,
}: {
  codeShown: CodeShown[]
  codeHolders: MutableRefObject<Readonly<Record<string, string>>>
  codeTargets: CodeTarget[]
  setCodeTargets: Dispatch<SetStateAction<CodeTarget[]>>
  idleCode: Readonly<Record<string, number>>
  setIdleCode: Dispatch<SetStateAction<Readonly<Record<string, number>>>>
  setGotos: Dispatch<SetStateAction<Record<string, CodeGoto>>>
  projects: Project[]
  usedRoots: string
}) {
  codeHolders.current = frameHolders(codeHolders.current, codeShown)
  const holders = codeHolders.current
  const shownRoots = codeShown.map((entry) => entry.root).join('\n')

  useEffect(() => {
    const missing = codeShown.filter((entry, index) => codeShown.findIndex((other) => other.root === entry.root) === index && !codeTargets.some((target) => target.root === entry.root))
    if (missing.length > 0) setCodeTargets((current) => [...current, ...missing.map((entry) => codeTargetForRoot(projects, entry.root))])
  }, [shownRoots, codeTargets])
  useEffect(() => {
    setIdleCode((current) => idleServers(current, codeTargets.map((target) => target.root), new Set(usedRoots.split('\n')), Date.now()))
  }, [usedRoots, codeTargets])
  useEffect(() => {
    const since = Object.values(idleCode)
    if (since.length === 0) return
    const timer = setTimeout(() => {
      const expired = expiredServers(idleCode, Date.now())
      if (expired.length === 0) return
      setCodeTargets((current) => current.filter((target) => !expired.includes(target.root)))
      setGotos((current) => Object.fromEntries(Object.entries(current).filter(([root]) => !expired.includes(root))))
      for (const root of expired) void api.stopCodeServer(root).catch(() => {})
    }, Math.max(0, Math.min(...since) + serverGraceMs - Date.now()))
    return () => clearTimeout(timer)
  }, [idleCode])

  return { holders }
}
