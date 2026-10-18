import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import type { ProjectSession } from '@/api/schema'
import type { Layout, Preset } from '@/panes/split-groups'
import { itemKey, paneList } from '@/panes/pane-model'
import { arrangeGroup, arrangeMember, addToGroup, changeGroupPanes, changeGroupStrip, closeGroup, focusGroup, groupOfItem, joinItems, leaveGroup, presetsFor, renameGroup, shiftMember, shownPanes, splitBeside, splitItems, unsplitGroup } from '@/panes/split-groups'
import type { GroupRow, MemberInfo } from '@/advanced/split-rows'
import type { SplitDrop } from '@/advanced/SplitRows'
import type { JoinTarget } from '@/advanced/useRowDrag'
import type { SidebarDrag } from '@/advanced/SidebarRows'
import type { MenuItem } from '@/components/ContextMenu'
import { joinLabel } from '@/advanced/item-menus'
import { useStableCallback } from '@/lib/useStableCallback'
import type { Strip } from '@/panes/strip'
import type { GithubPageKind } from '@/github/useGithubCounts'

type GithubPage = { path: string; kind: GithubPageKind; focus: number | null } | null

export function useSplitInteractions({
  paneLayout, setLayout, setGithubPage, newPaneId, newGroupId, newLauncher,
  focusPaneInput, sessionItem, splitRowsValue, describeItem, presetNames, presetIcons,
}: {
  paneLayout: Layout
  setLayout: Dispatch<SetStateAction<Layout>>
  setGithubPage: Dispatch<SetStateAction<GithubPage>>
  newPaneId: () => string
  newGroupId: () => string
  newLauncher: () => string
  focusPaneInput: (paneId: string) => void
  sessionItem: (session: ProjectSession) => string
  splitRowsValue: GroupRow[]
  describeItem: (item: string) => MemberInfo
  presetNames: Record<Preset, string>
  presetIcons: Record<Preset, MenuItem['icon']>
}) {
  const arrange = (row: GroupRow, preset: Preset) => setLayout((current) => focusGroup(arrangeGroup(current, row.id, preset), row.id))
  const shownGroupId = paneLayout.active
  const changeStrip = useMemo(() => (shownGroupId === null ? null : (change: (strip: Strip) => Strip) => setLayout((current) => changeGroupStrip(current, shownGroupId, change))), [shownGroupId])
  const [stripScrolls, setStripScrolls] = useState(false)
  const focusSplit = useStableCallback((groupId: string) => {
    setGithubPage(null)
    setLayout((current) => focusGroup(current, groupId))
  })
  const focusSplitMember = useStableCallback((groupId: string, item: string) => {
    setGithubPage(null)
    setLayout((current) => focusGroup(current, groupId, item))
  })
  const renameSplit = useStableCallback((groupId: string, name: string) => setLayout((current) => renameGroup(current, groupId, name)))
  const splitGroupMenu = useStableCallback((row: GroupRow, startRename: () => void): MenuItem[] => [
    ...presetsFor(row.members.length).map((preset): MenuItem => ({ label: presetNames[preset], icon: presetIcons[preset], group: 'open', onSelect: () => arrange(row, preset) })),
    { label: 'Rename group', icon: 'rename', group: 'organise', onSelect: startRename },
    { label: 'Unsplit', icon: 'unsplit', group: 'organise', onSelect: () => setLayout((current) => unsplitGroup(current, row.id)) },
    { label: 'Close group', icon: 'close', group: 'danger', onSelect: () => setLayout((current) => closeGroup(current, row.id, { id: newPaneId(), item: newLauncher() })) },
  ])
  const splitItemOf = useStableCallback((row: SidebarDrag): string | null => {
    if (row.kind === 'native') return itemKey('native', row.chat.id)
    if (row.kind === 'terminal') return itemKey('terminal', row.terminal.id)
    return sessionItem(row.session)
  })
  const splitWith = (item: string | null, edge: 'right' | 'bottom') => {
    const launcher = newLauncher()
    const next = splitBeside(paneLayout, item ?? launcher, edge, launcher, { pane: newPaneId(), group: newGroupId() })
    if (next === null) return
    setGithubPage(null)
    setLayout(next)
    focusPaneInput(shownPanes(next).focused)
  }
  const [picks, setPicks] = useState<string[]>([])
  const openInSplit = (items: string[]) => {
    const unique = [...new Set(items)]
    const ids = unique.map(() => newPaneId())
    const preset: Preset = unique.length === 2 ? 'row' : 'grid'
    setGithubPage(null)
    setPicks([])
    setLayout((current) => splitItems(current, unique, newGroupId(), ids, preset))
  }
  const splitRowMenu = useStableCallback((item: string): MenuItem[] => {
    const together = [...new Set([...picks, item])]
    return [
      ...(picks.length > 0 && together.length >= 2 ? [{ label: `Open ${together.length} in split`, icon: 'splitGrid', group: 'open', onSelect: () => openInSplit(together) } satisfies MenuItem] : []),
      { label: 'Split right', icon: 'splitRight', group: 'open', onSelect: () => splitWith(item, 'right') },
      { label: 'Split down', icon: 'splitDown', group: 'open', onSelect: () => splitWith(item, 'bottom') },
      ...joinChoices(item),
    ]
  })
  const joinItem = (title: string) => {
    const { label, full } = joinLabel({ name: null, members: [{ title }] })
    return { label, title: full }
  }
  const joinChoices = (item: string): MenuItem[] => {
    const own = groupOfItem(paneLayout, item)?.id ?? null
    const alone = paneLayout.active === null ? (paneList(paneLayout.single.root)[0]?.item ?? null) : null
    const groups = splitRowsValue.filter((row) => row.id !== own)
    return [
      ...groups.map((row): MenuItem => {
        const { label, full } = joinLabel(row)
        return { label, title: full, icon: 'splitGrid', group: 'open', onSelect: () => dropSplit({ kind: 'join', source: { kind: 'item', item }, target: { kind: 'group', groupId: row.id } }) }
      }),
      ...(alone === null || alone === item || groupOfItem(paneLayout, alone) !== null
        ? []
        : [{ ...joinItem(describeItem(alone).title), icon: 'splitRight', group: 'open', onSelect: () => dropSplit({ kind: 'join', source: { kind: 'item', item }, target: { kind: 'item', item: alone } }) } satisfies MenuItem]),
    ]
  }
  const joined = (current: Layout, source: JoinTarget, target: JoinTarget): Layout => {
    if (source.kind === 'item' && target.kind === 'item') return joinItems(current, source.item, target.item, { pane: newPaneId(), group: newGroupId() })
    if (source.kind === 'item' && target.kind === 'group') return addToGroup(current, target.groupId, source.item, newPaneId())
    if (source.kind === 'group' && target.kind === 'item') return addToGroup(current, source.groupId, target.item, newPaneId())
    return current
  }
  const dropSplit = useStableCallback((drop: SplitDrop) => {
    if (drop.kind === 'arrange') setLayout((current) => arrangeMember(current, drop.groupId, drop.item, drop.target))
    else if (drop.kind === 'shift') setLayout((current) => shiftMember(current, drop.groupId, drop.item, drop.direction))
    else if (drop.kind === 'resize') setLayout((current) => changeGroupPanes(current, drop.groupId, () => drop.panes))
    else if (drop.kind === 'leave') setLayout((current) => leaveGroup(current, drop.item))
    else {
      const next = joined(paneLayout, drop.source, drop.target)
      if (next === paneLayout) return
      setGithubPage(null)
      setPicks([])
      setLayout(next)
    }
  })
  const pickSplitRow = useStableCallback((item: string, add: boolean) => setPicks((current) => (!add ? [] : current.includes(item) ? current.filter((entry) => entry !== item) : [...current, item])))

  return { arrange, shownGroupId, changeStrip, stripScrolls, setStripScrolls, focusSplit, focusSplitMember, renameSplit, splitGroupMenu, splitItemOf, splitWith, picks, openInSplit, splitRowMenu, joinChoices, dropSplit, pickSplitRow }
}
