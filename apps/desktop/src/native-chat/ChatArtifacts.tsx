import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '@/api'
import type { ArtifactRevision, ChatArtifact, ChatArtifactContent, ChatArtifactSource } from '@/api/schema'
import { ArtifactsIcon } from '@/advanced/chrome'
import { ArtifactFrame } from '@/advanced/ArtifactFrame'
import { documentElements } from '@/advanced/ArtifactsPage'
import { relativeAge } from '@/advanced/projects-model'
import { MarkdownText } from '@/chat/markdown'
import { agentColor } from '@/components/agent-activity'
import { AgentIcon } from '@/components/agent-icons'
import { MenuIconGlyph } from '@/components/menu-icons'
import { ResizeHandle } from '@/components/ResizeHandle'
import { TextSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { httpsUrl } from '@/lib/external'
import { OldRevisionNote, RevisionPicker, updated } from '@/native-chat/RevisionPicker'
import { artifactStamps, chatPanelLimits, readChatPanel, revisionEntries, revisionRead, revisionView, writeChatPanel, type ArtifactChip, type ChatPanel } from '@/native-chat/chat-artifacts'

// A native chat's artifacts: the row of chips above the composer and the panel that opens one beside
// the chat (chat-artifacts.ts holds the rules). The chat's follow says when they change; the row lists
// them again and the open one reloads in place, keeping its scroll.

/** How long a changed chip pulses; the keyframes in styles.css run within it. */
const pulseMs = 2400

const sources: Record<ChatArtifactSource, { label: string; color: string }> = {
  megabrain: { label: 'megabrain', color: 'var(--color-accent)' },
  'claude-artifact': { label: 'Claude artifact', color: agentColor('claude') },
  'claude-design': { label: 'Claude Design', color: agentColor('claude') },
  'codex-plan': { label: 'Codex plan', color: agentColor('codex') },
  agy: { label: 'agy', color: agentColor('agy') },
  grok: { label: 'Grok', color: agentColor('grok') },
}

const agentOf: Partial<Record<ChatArtifactSource, string>> = { 'claude-artifact': 'claude', 'codex-plan': 'codex', agy: 'agy', grok: 'grok' }

export const sourceLabel = (source: ChatArtifactSource): string => sources[source].label

/** Who made the artifact: the agents' own marks, megabrain's orb, and Claude's spark on a canvas for Claude Design. */
export function SourceMark({ source, size = 14 }: { source: ChatArtifactSource; size?: number }) {
  const { label, color } = sources[source]
  if (source === 'megabrain') return <span role="img" aria-label={label} title={label} style={{ width: size - 4, height: size - 4, margin: 2, boxShadow: '0 0 6px rgba(142, 156, 255, 0.45)' }} className="orb still block shrink-0" />
  if (source === 'claude-design') {
    return (
      <svg viewBox="0 0 16 16" width={size} height={size} role="img" aria-label={label} style={{ color }} className="shrink-0">
        <title>{label}</title>
        <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
          <path d="M8 4.75v6.5M4.75 8h6.5M5.7 5.7l4.6 4.6M10.3 5.7l-4.6 4.6" />
        </g>
      </svg>
    )
  }
  return (
    <span style={{ color }} className="inline-flex shrink-0">
      <AgentIcon agent={agentOf[source] ?? source} size={size} />
    </span>
  )
}

/**
 * The chat's artifacts as listed, with each one's pulse: listed when the chat opens, each time its
 * follow says they changed, and when the window comes back. `changed` counts those events.
 */
export function useChatArtifacts(chatId: string, changed: number): { artifacts: ChatArtifact[] | null; previous: ReadonlyMap<string, string> | null } {
  const [listed, setListed] = useState<{ chatId: string; artifacts: ChatArtifact[]; previous: ReadonlyMap<string, string> | null } | null>(null)
  const last = useRef<{ chatId: string; stamps: Map<string, string> } | null>(null)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let current = true
    const read = () =>
      api.chatArtifacts(chatId).then(
        ({ artifacts }) => {
          if (!current) return
          // The first listing of this chat pulses nothing; a later one pulses what changed, for a moment.
          const before = last.current?.chatId === chatId ? last.current.stamps : null
          const stamps = artifactStamps(artifacts)
          last.current = { chatId, stamps }
          setListed({ chatId, artifacts, previous: before })
          if (settle.current !== null) clearTimeout(settle.current)
          settle.current = setTimeout(() => setListed((shown) => (shown === null || shown.chatId !== chatId ? shown : { ...shown, previous: stamps })), pulseMs)
        },
        // The last good list stays; the next event or focus reads again.
        () => {},
      )
    void read()
    window.addEventListener('focus', read)
    return () => {
      current = false
      window.removeEventListener('focus', read)
    }
  }, [chatId, changed])

  useEffect(
    () => () => {
      if (settle.current !== null) clearTimeout(settle.current)
    },
    [],
  )

  return listed === null || listed.chatId !== chatId ? { artifacts: null, previous: null } : listed
}

const browserStorage = () => localStorage

/** The chat's panel, as it was left in this chat: the open artifact and its width. */
export function useChatPanel(chatId: string) {
  const [panel, setPanel] = useState<{ chatId: string; value: ChatPanel }>(() => ({ chatId, value: readChatPanel(browserStorage, chatId) }))
  const value = panel.chatId === chatId ? panel.value : readChatPanel(browserStorage, chatId)
  const save = (next: ChatPanel) => setPanel({ chatId, value: writeChatPanel(browserStorage, chatId, next) })
  return {
    ...value,
    open: (artifactId: string | null) => save({ ...value, artifactId }),
    /** While dragging: follows the pointer without writing storage. */
    preview: (width: number) => setPanel({ chatId, value: { ...value, width } }),
    resize: (width: number) => save({ ...value, width }),
  }
}

/** The row above the composer: one chip per artifact (those sharing a title are one), newest change first, the open one highlighted. */
export function ArtifactsRow({ chips, now, onOpen }: { chips: ArtifactChip[]; now: number; onOpen: (chip: ArtifactChip) => void }) {
  return (
    <div role="toolbar" aria-label="Artifacts" className="artifact-row mb-1.5 flex gap-1.5 overflow-x-auto px-1 py-0.5">
      {chips.map((chip) => (
        <button
          key={chip.artifact.id}
          type="button"
          // The composer keeps the focus: the person goes on writing while the artifact opens.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onOpen(chip)}
          aria-pressed={chip.active}
          title={`${chip.artifact.title}\n${sourceLabel(chip.artifact.source)} · ${new Date(chip.artifact.updatedAt).toLocaleString()}`}
          className={`relative flex h-7 max-w-[240px] shrink-0 items-center gap-1.5 rounded-full border pr-2.5 pl-2 text-[12.5px] transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 motion-reduce:transition-none ${
            chip.active ? 'border-accent/45 bg-accent/[0.12] text-ink-100' : 'border-white/[0.08] bg-white/[0.04] text-ink-300 hover:border-white/[0.14] hover:bg-white/[0.07] hover:text-ink-100'
          }`}
        >
          {chip.pulse && <span key={`${chip.artifact.updatedAt}#${chip.artifact.revision ?? ''}`} aria-hidden="true" className="artifact-pulse pointer-events-none absolute inset-0 rounded-full" />}
          <SourceMark source={chip.artifact.source} size={13} />
          <span className="min-w-0 truncate font-medium">{chip.artifact.title}</span>
          <span className={`shrink-0 text-[11px] tabular-nums ${chip.pulse ? 'text-accent' : 'text-ink-400'}`}>{relativeAge(chip.artifact.updatedAt, now)}</span>
        </button>
      ))}
    </div>
  )
}

type Loaded = { state: 'loading' } | { state: 'failed'; error: unknown } | { state: 'ready'; content: ChatArtifactContent }

/** A version's content, the artifact's current one when `revision` is undefined; a new `version` reloads it while the last one stays shown. */
function useArtifactContent(chatId: string, artifactId: string, revision: number | undefined, version: string): Loaded {
  const [load, setLoad] = useState<{ id: string; value: Loaded }>({ id: '', value: { state: 'loading' } })
  const id = `${chatId}\n${artifactId}\n${revision ?? ''}`
  useEffect(() => {
    let current = true
    api.chatArtifact(chatId, artifactId, revision).then(
      (content) => current && setLoad({ id, value: { state: 'ready', content } }),
      // A failed reload keeps what is shown; only a first load shows the error.
      (error: unknown) => current && setLoad((shown) => (shown.id === id && shown.value.state === 'ready' ? shown : { id, value: { state: 'failed', error } })),
    )
    return () => {
      current = false
    }
  }, [chatId, artifactId, revision, id, version])
  return load.id === id ? load.value : { state: 'loading' }
}

/**
 * What megabrain keeps about the artifacts it filed: the revisions their updates replaced and the
 * project, read again when the listing changes. Other sources keep neither; a failed read lists none.
 */
function useFiledDetails(members: readonly ChatArtifact[], version: string): { revisions: ReadonlyMap<string, readonly ArtifactRevision[]>; project: string | null } {
  const [details, setDetails] = useState<{ version: string; revisions: Map<string, readonly ArtifactRevision[]>; project: string | null } | null>(null)
  const filed = members.filter((member) => member.source === 'megabrain').map((member) => member.id)
  const ids = filed.join('\n')
  useEffect(() => {
    if (ids === '') return
    let current = true
    void Promise.all(ids.split('\n').map((id) => api.artifact(id).then((shown) => shown, () => null))).then((shown) => {
      if (!current) return
      const read = shown.filter((entry) => entry !== null)
      setDetails({ version, revisions: new Map(read.map((entry) => [entry.id, entry.revisions ?? []])), project: read[0]?.projectName ?? null })
    })
    return () => {
      current = false
    }
  }, [ids, version])
  // The last details stay while a new listing reads, so the picker does not shrink and grow back.
  return details === null || ids === '' ? { revisions: new Map(), project: null } : details
}

const headerButton =
  'grid size-7 shrink-0 place-items-center rounded-full text-ink-400 transition-colors duration-100 hover:bg-white/[0.08] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 motion-reduce:transition-none'

function Body({ artifact, load, onOpenUrl }: { artifact: ChatArtifact; load: Loaded; onOpenUrl: (() => void) | null }): ReactNode {
  if (load.state === 'loading') return <div className="px-5 py-5"><TextSkeleton lines={6} /></div>
  if (load.state === 'failed') return <div className="px-5 py-5"><ErrorNote error={load.error} /></div>
  const { content, reason } = load.content
  if (artifact.format === 'url' || content === null) {
    return (
      <div className="px-5 py-6">
        <div className="rounded-[16px] border border-white/[0.08] bg-white/[0.03] px-5 py-5">
          <div className="flex items-center gap-2.5">
            <SourceMark source={artifact.source} size={18} />
            <h3 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-ink-100">{artifact.title}</h3>
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-400">{reason ?? (artifact.url === undefined ? 'This artifact has nothing to show here.' : `${sourceLabel(artifact.source)} shows it in the browser.`)}</p>
          {artifact.url !== undefined && <p className="mt-3 truncate font-mono text-[12px] text-ink-400" title={artifact.url}>{artifact.url}</p>}
          {onOpenUrl !== null && (
            <button type="button" onClick={onOpenUrl} className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-full bg-ink-100 px-3.5 text-[13px] font-medium text-ink-950 transition-opacity hover:opacity-90">
              <MenuIconGlyph icon="external" />
              Open in browser
            </button>
          )}
        </div>
      </div>
    )
  }
  if (artifact.format === 'html') return <div className="min-h-0 flex-1 p-3"><ArtifactFrame title={artifact.title} html={content} className="h-full w-full rounded-[12px] border border-white/[0.07] bg-white" /></div>
  if (artifact.format === 'markdown') return <MarkdownText text={content} elements={documentElements} className="space-y-3 px-6 py-5 text-[14px] leading-relaxed text-ink-200" />
  return <pre className="px-5 py-5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-200 select-text">{content}</pre>
}

/**
 * The open artifact beside the chat, or over it on a narrow pane: every artifact sharing its title,
 * newest first, read as one. Its body reloads in place when the listed version changes: Markdown and
 * text keep their scroll, HTML swaps frames without a flash. An earlier revision reads until the
 * person goes back to the latest.
 */
export function ArtifactPanel({
  chatId,
  members,
  width,
  overlay,
  now,
  onResize,
  onClose,
  onOpenPage,
}: {
  chatId: string
  /** The artifacts sharing the open one's title, newest first. */
  members: [ChatArtifact, ...ChatArtifact[]]
  width: number
  overlay: boolean
  now: number
  onResize: { preview: (width: number) => void; commit: (width: number) => void }
  onClose: () => void
  /** Opens an artifact megabrain filed on the Artifacts page; null where there is no page to open. */
  onOpenPage: ((artifactId: string) => void) | null
}) {
  const newest = members[0]
  const version = members.map((member) => `${member.id}@${member.updatedAt}#${member.revision ?? ''}`).join('\n')
  const filed = useFiledDetails(members, version)
  const entries = revisionEntries(members, filed.revisions)
  const [pick, setPick] = useState<string | null>(null)
  const view = revisionView(entries, pick)
  const shown = view?.shown ?? null
  const artifact = members.find((member) => member.id === shown?.artifactId) ?? newest
  const read = shown === null ? { artifactId: newest.id, revision: undefined } : revisionRead(shown)
  const load = useArtifactContent(chatId, read.artifactId, read.revision, read.revision === undefined ? `${artifact.updatedAt}#${artifact.revision ?? ''}` : '')
  const url = artifact.url === undefined ? null : httpsUrl(artifact.url)
  const openUrl = url === null ? null : () => void api.openUrl(url).catch(() => {})
  const scrolls = artifact.format === 'markdown' || artifact.format === 'text'
  const title = view?.old === true && shown !== null ? shown.title : newest.title
  const at = shown?.at ?? newest.updatedAt
  return (
    <aside
      aria-label={`Artifact: ${newest.title}`}
      style={{ width }}
      className={`flex min-h-0 shrink-0 flex-col bg-ink-900 ${overlay ? 'artifact-overlay absolute top-0 right-0 bottom-0 z-30 border-l border-white/[0.1] shadow-[-24px_0_48px_-16px_rgba(0,0,0,0.7)]' : 'relative border-l border-white/[0.07]'}`}
    >
      <ResizeHandle
        edge="left"
        label="Resize the artifact"
        grip
        panel={{ width, preview: onResize.preview, commit: onResize.commit, reset: () => onResize.commit(chatPanelLimits.initial) }}
      />
      <header className="shrink-0 border-b border-white/[0.07]">
        <div className="flex items-center gap-1 pt-2.5 pr-2 pl-4">
          <h2 className="min-w-0 flex-1 truncate text-[14px] leading-7 font-semibold tracking-[-0.01em] text-ink-100" title={title}>{title}</h2>
          {openUrl !== null && artifact.format !== 'url' && (
            <button type="button" onClick={openUrl} title="Open in browser" aria-label="Open in browser" className={headerButton}>
              <MenuIconGlyph icon="external" />
            </button>
          )}
          {onOpenPage !== null && artifact.source === 'megabrain' && (
            <button type="button" onClick={() => onOpenPage(artifact.id)} title="Open in Artifacts" aria-label="Open in Artifacts" className={headerButton}>
              <ArtifactsIcon />
            </button>
          )}
          <button type="button" onClick={onClose} title="Close" aria-label="Close the artifact" className={headerButton}>
            <MenuIconGlyph icon="close" />
          </button>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 pt-0.5 pr-3 pb-2.5 pl-4 text-[12px] text-ink-400">
          <SourceMark source={artifact.source} size={13} />
          <span className="truncate" title={sourceLabel(artifact.source)}>{filed.project ?? sourceLabel(artifact.source)}</span>
          <span aria-hidden="true" className="text-ink-500">·</span>
          <span title={new Date(at).toLocaleString()} className="shrink-0 tabular-nums">Updated {updated(at, now)}</span>
          {view !== null && shown !== null && entries.length > 1 && <RevisionPicker entries={entries} shown={shown} old={view.old} title={newest.title} now={now} size="inline" className="-my-0.5 ml-auto" onPick={setPick} />}
          {view !== null && shown !== null && entries.length === 1 && shown.revision !== null && <span className="ml-auto shrink-0 tabular-nums">Revision {shown.revision}</span>}
        </div>
        {view?.old === true && shown !== null && <OldRevisionNote shown={shown} latest={view.latest} onBack={() => setPick(null)} className="border-t pr-2 pl-4" />}
      </header>
      <div className={`min-h-0 flex-1 overflow-y-auto ${scrolls ? '' : 'flex flex-col'}`}>
        <Body artifact={artifact} load={load} onOpenUrl={openUrl} />
      </div>
    </aside>
  )
}
