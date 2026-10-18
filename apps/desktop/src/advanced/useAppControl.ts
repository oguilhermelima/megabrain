import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Project } from '@/api/schema'
import { api } from '@/api'
import type { CodeGoto } from '@/code/CodeFrame'
import type { PaneView } from '@/chat/action-bar-model'
import type { GithubPageKind } from '@/github/useGithubCounts'
import { itemKey } from '@/panes/pane-model'
import { applyAppControl, listAppLayout, type AppControlRequest } from '@/panes/app-control'
import type { Layout } from '@/panes/split-groups'
import { newGroupId, newPaneId } from '@/advanced/usePaneState'

type GithubPage = { path: string; kind: GithubPageKind; focus: number | null } | null

export function useAppControl({
  paneLayout, projects, setGithubPage, setGotos, setLayout, setPaneViews, setSettingsOpen, setSettingsSection,
}: {
  paneLayout: Layout
  projects: Project[]
  setGithubPage: Dispatch<SetStateAction<GithubPage>>
  setGotos: Dispatch<SetStateAction<Record<string, CodeGoto>>>
  setLayout: Dispatch<SetStateAction<Layout>>
  setPaneViews: Dispatch<SetStateAction<Record<string, PaneView>>>
  setSettingsOpen: Dispatch<SetStateAction<boolean>>
  setSettingsSection: Dispatch<SetStateAction<'knowledge' | null>>
}) {
  useEffect(() => {
    let active = true
    const unlisten = listen<{ id: string; request: AppControlRequest }>('app-control', async ({ payload }) => {
      if (!active) return
      try {
        const request = payload.request
        if (request.action === 'status') {
          const window = getCurrentWindow()
          await api.appControlReply(payload.id, { running: true, window: window.label, version: await getVersion() })
          return
        }
        if (request.action === 'layout') {
          await api.appControlReply(payload.id, listAppLayout(paneLayout))
          return
        }
        if (request.action === 'open' && request.target.startsWith('page:settings')) {
          setSettingsSection('knowledge')
          setSettingsOpen(true)
          await api.appControlReply(payload.id, { opened: request.target })
          if (request.focus) await focusWindow()
          return
        }
        let normalized: Exclude<AppControlRequest, { action: 'layout' | 'status' }> = request
        if (request.action === 'open' && request.target.startsWith('worktree:')) {
          const path = request.target.slice('worktree:'.length)
          const project = projects.find((entry) => entry.path === path || entry.worktrees.some((worktree) => worktree.path === path))
          if (project === undefined) throw new Error(`unknown worktree target: ${path}`)
          normalized = { ...request, target: `project:${project.path}` }
        }
        if (request.action === 'open' && request.target.startsWith('file:')) {
          const value = request.target.slice('file:'.length)
          const match = /^(.*):(\d+)$/.exec(value)
          const path = match?.[1] ?? value
          const roots = projects.flatMap((entry) => [entry.path, ...entry.worktrees.map((worktree) => worktree.path)])
          const root = roots.filter((candidate) => path.startsWith(`${candidate}/`)).sort((a, b) => b.length - a.length)[0]
          if (root === undefined) throw new Error(`file is outside a known worktree: ${path}`)
          const line = match === null ? undefined : Number(match[2])
          setGotos((current) => ({ ...current, [root]: { path, line: line ?? null } }))
          setPaneViews((current) => ({ ...current, [itemKey('code', root)]: 'code' }))
          normalized = { ...request, target: `code:${root}` }
        }
        const next = applyAppControl(paneLayout, normalized, { pane: newPaneId, group: newGroupId, launcher: newPaneId })
        if ('status' in next) await api.appControlReply(payload.id, { status: next.status, layout: listAppLayout(next.layout) })
        else {
          setGithubPage(null)
          setLayout(next)
          await api.appControlReply(payload.id, listAppLayout(next))
        }
        if (request.action === 'open' && request.focus) await focusWindow()
      } catch (error) {
        await api.appControlError(payload.id, error instanceof Error ? error.message : String(error))
      }
    })
    return () => { active = false; void unlisten.then((stop) => stop()) }
  }, [paneLayout, projects, setGithubPage, setGotos, setLayout, setPaneViews, setSettingsOpen, setSettingsSection])
}

async function focusWindow() {
  const window = getCurrentWindow()
  await window.show()
  await window.setFocus()
}
