import { useRef, useState } from 'react'
import { createCodeSlots } from '@/code/code-slots'
import type { CodeGoto } from '@/code/CodeFrame'
import type { CodeTarget } from '@/code/code-pane-model'
import { itemKey, singlePane } from '@/panes/pane-model'
import { layoutOf, parseLayout, type Layout } from '@/panes/split-groups'
import type { GithubKind } from '@/github/useGithubCounts'
import type { PaneView } from '@/chat/action-bar-model'

export const panesKey = 'megabrain.panes'

export const newPaneId = () => `pane-${crypto.randomUUID()}`
export const newGroupId = () => `group-${crypto.randomUUID()}`
export const newLauncher = () => itemKey('launcher', crypto.randomUUID())

function storedLayout(): Layout {
  try {
    const stored = parseLayout(localStorage.getItem(panesKey), newGroupId())
    if (stored !== null) return stored
  } catch {
    // A remembered layout is a convenience; one pane is fine.
  }
  return layoutOf(singlePane(newLauncher(), newPaneId()), newGroupId())
}

export function usePaneState() {
  const [paneLayout, setLayout] = useState<Layout>(storedLayout)
  // Items gone from the restored lists are pruned once, after those lists have loaded.
  const [pruned, setPruned] = useState(false)
  // Per-item and per-split views from the action bars.
  const [paneViews, setPaneViews] = useState<Record<string, PaneView>>({})
  const [splitViews, setSplitViews] = useState<Record<string, PaneView>>({})
  // A project's pull request or issue page shown over the pane layout.
  const [githubPage, setGithubPage] = useState<{ path: string; kind: GithubKind; focus: number | null } | null>(null)
  // Code roots stay mounted until their server stops; idle roots retain their last-use time.
  const [codeTargets, setCodeTargets] = useState<CodeTarget[]>([])
  const [idleCode, setIdleCode] = useState<Readonly<Record<string, number>>>({})
  const codeHolders = useRef<Readonly<Record<string, string>>>({})
  const [codeSlots] = useState(createCodeSlots)
  // The file each open root was last asked to show from a chat.
  const [gotos, setGotos] = useState<Record<string, CodeGoto>>({})

  return {
    paneLayout, setLayout, pruned, setPruned, paneViews, setPaneViews, splitViews, setSplitViews,
    githubPage, setGithubPage, codeTargets, setCodeTargets, idleCode, setIdleCode, codeHolders, codeSlots, gotos, setGotos,
  }
}
