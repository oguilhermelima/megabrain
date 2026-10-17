import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '@/api'
import type { ChatArtifact, ChatArtifactContent, ChatArtifactSource } from '@/api/schema'
import { ArtifactsIcon } from '@/advanced/chrome'
import { ArtifactFrame } from '@/advanced/ArtifactFrame'
import { documentElements } from '@/advanced/ArtifactsPage'
import { ArtifactKindIcon } from '@/advanced/ArtifactStrip'
import { artifactKindLabel } from '@/advanced/artifacts-model'
import { relativeAge } from '@/advanced/projects-model'
import { MarkdownText } from '@/chat/markdown'
import { agentColor } from '@/components/agent-activity'
import { AgentIcon } from '@/components/agent-icons'
import { MenuIconGlyph } from '@/components/menu-icons'
import { ResizeHandle } from '@/components/ResizeHandle'
import { TextSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { httpsUrl } from '@/lib/external'
import { sidebarSurface } from '@/lib/panel-width'
import { sidePanelBar, sidePanelButton, sidePanelHeaderRow } from '@/lib/side-panel'
import { artifactStamps, chatPanelLimits, readChatPanel, readHiddenChips, writeChatPanel, writeHiddenChips, type ArtifactChip, type ChatPanel, type HiddenChips } from '@/native-chat/chat-artifacts'

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

/** The chips the person closed in this chat, as they were left. */
export function useHiddenChips(chatId: string): { hidden: HiddenChips; save: (next: HiddenChips) => void } {
  const [state, setState] = useState<{ chatId: string; hidden: HiddenChips }>(() => ({ chatId, hidden: readHiddenChips(browserStorage, chatId) }))
  const hidden = state.chatId === chatId ? state.hidden : readHiddenChips(browserStorage, chatId)
  return { hidden, save: (next) => setState({ chatId, hidden: writeHiddenChips(browserStorage, chatId, next) }) }
}

/** Which ends of the row have chips scrolled past them, so those ends fade. */
function useRowFade() {
  const ref = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState({ start: false, end: false })
  const measure = () => {
    const row = ref.current
    if (row === null) return
    const start = row.scrollLeft > 1
    const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1
    setFade((shown) => (shown.start === start && shown.end === end ? shown : { start, end }))
  }
  useEffect(() => {
    const row = ref.current
    if (row === null) return
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    for (const child of row.children) observer.observe(child)
    return () => observer.disconnect()
  })
  return { ref, fade, measure }
}

/**
 * The row above the composer: one chip per artifact, newest change first, the open one filled. A
 * chip shows what the artifact is (its kind, else who made it), its title and age; on hover or focus
 * the age gives way to the x that closes it. A row longer than the pane scrolls sideways, faded at
 * the ends it runs past.
 */
export function ArtifactsRow({ chips, now, onOpen, onClose }: { chips: ArtifactChip[]; now: number; onOpen: (chip: ArtifactChip) => void; onClose: (chip: ArtifactChip) => void }) {
  const { ref, fade, measure } = useRowFade()
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Artifacts"
      data-fade-start={fade.start || undefined}
      data-fade-end={fade.end || undefined}
      onScroll={measure}
      // A mouse wheel scrolls the row sideways; a trackpad already does.
      onWheel={(event) => {
        if (event.deltaX === 0 && event.deltaY !== 0) event.currentTarget.scrollLeft += event.deltaY
      }}
      className="artifact-row mb-1.5 flex gap-1 overflow-x-auto px-1 py-0.5"
    >
      {chips.map((chip) => {
        const { artifact } = chip
        const kind = artifact.kind === undefined ? null : artifactKindLabel(artifact.kind)
        return (
          <div
            key={artifact.id}
            className={`group relative flex h-7 max-w-[260px] shrink-0 items-center rounded-full text-[12.5px] transition-colors duration-100 motion-reduce:transition-none ${
              chip.active ? 'bg-white/[0.14] text-ink-100 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]' : 'bg-white/[0.05] text-ink-300 hover:bg-white/[0.08] hover:text-ink-100'
            }`}
          >
            {chip.pulse && <span key={`${artifact.updatedAt}#${artifact.revision ?? ''}`} aria-hidden="true" className="artifact-pulse pointer-events-none absolute inset-0 rounded-full" />}
            <button
              type="button"
              // The composer keeps the focus: the person goes on writing while the artifact opens.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => onOpen(chip)}
              aria-pressed={chip.active}
              title={`${artifact.title}\n${kind === null ? '' : `${kind} · `}${sourceLabel(artifact.source)} · ${new Date(artifact.updatedAt).toLocaleString()}`}
              className="flex h-full min-w-0 items-center gap-1.5 rounded-full pl-2.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25"
            >
              <span className={`inline-flex shrink-0 ${chip.active ? 'text-accent' : 'text-ink-400 group-hover:text-ink-200'}`}>{artifact.kind === undefined ? <SourceMark source={artifact.source} size={13} /> : <ArtifactKindIcon kind={artifact.kind} />}</span>
              <span className={`min-w-0 truncate ${chip.active ? 'font-semibold' : 'font-medium'}`}>{artifact.title}</span>
            </button>
            <span className="relative mr-1 ml-1 grid h-5 min-w-5 shrink-0 place-items-center">
              <span className={`px-0.5 text-[11px] tabular-nums transition-opacity duration-100 group-focus-within:opacity-0 group-hover:opacity-0 motion-reduce:transition-none ${chip.pulse ? 'text-accent' : 'text-ink-400'}`}>{relativeAge(artifact.updatedAt, now)}</span>
              <button
                type="button"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => onClose(chip)}
                aria-label={`Close ${artifact.title}`}
                title="Close"
                className="absolute inset-0 m-auto grid size-5 place-items-center rounded-full text-ink-300 opacity-0 transition-opacity duration-100 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-white/[0.12] hover:text-ink-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 motion-reduce:transition-none"
              >
                <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="m4 4 8 8M12 4l-8 8" />
                </svg>
              </button>
            </span>
          </div>
        )
      })}
    </div>
  )
}

type Loaded = { state: 'loading' } | { state: 'failed'; error: unknown } | { state: 'ready'; content: ChatArtifactContent }

/** The artifact's current content; a new `version` reloads it while the last one stays shown. */
function useArtifactContent(chatId: string, artifactId: string, version: string): Loaded {
  const [load, setLoad] = useState<{ id: string; value: Loaded }>({ id: '', value: { state: 'loading' } })
  const id = `${chatId}\n${artifactId}`
  useEffect(() => {
    let current = true
    api.chatArtifact(chatId, artifactId).then(
      (content) => current && setLoad({ id, value: { state: 'ready', content } }),
      // A failed reload keeps what is shown; only a first load shows the error.
      (error: unknown) => current && setLoad((shown) => (shown.id === id && shown.value.state === 'ready' ? shown : { id, value: { state: 'failed', error } })),
    )
    return () => {
      current = false
    }
  }, [chatId, artifactId, id, version])
  return load.id === id ? load.value : { state: 'loading' }
}

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
  if (artifact.format === 'html') return <ArtifactFrame title={artifact.title} html={content} className="min-h-0 w-full flex-1" />
  if (artifact.format === 'markdown') return <MarkdownText text={content} elements={documentElements} className="space-y-3 px-6 py-5 text-[14px] leading-relaxed text-ink-200" />
  return <pre className="px-5 py-5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-200 select-text">{content}</pre>
}

/**
 * The open artifact beside the chat, or over it on a narrow pane, under a slim bar that holds only
 * expand and close: the rest of the panel is the artifact's, edge to edge. Expand opens what
 * megabrain filed on the Artifacts page (where its revisions are) and anything else with a link in
 * the browser. Its body reloads in place when the listed version changes: Markdown and text keep
 * their scroll, HTML swaps frames without a flash.
 */
export function ArtifactPanel({
  chatId,
  artifact,
  width,
  overlay,
  onResize,
  onClose,
  onOpenPage,
}: {
  chatId: string
  artifact: ChatArtifact
  width: number
  overlay: boolean
  onResize: { preview: (width: number) => void; commit: (width: number) => void }
  onClose: () => void
  /** Opens an artifact megabrain filed on the Artifacts page; null where there is no page to open. */
  onOpenPage: ((artifactId: string) => void) | null
}) {
  const load = useArtifactContent(chatId, artifact.id, `${artifact.updatedAt}#${artifact.revision ?? ''}`)
  const url = artifact.url === undefined ? null : httpsUrl(artifact.url)
  const openUrl = url === null ? null : () => void api.openUrl(url).catch(() => {})
  const expand =
    onOpenPage !== null && artifact.source === 'megabrain'
      ? { label: 'Open in Artifacts', icon: <ArtifactsIcon />, open: () => onOpenPage(artifact.id) }
      : openUrl !== null && artifact.format !== 'url'
        ? { label: 'Open in browser', icon: <MenuIconGlyph icon="external" />, open: openUrl }
        : null
  const scrolls = artifact.format === 'markdown' || artifact.format === 'text'
  return (
    <aside
      aria-label={`Artifact: ${artifact.title}`}
      style={{ width }}
      // Beside the chat it is drawn as the other support panels (lib/panel-width's sidebarSurface); over
      // the transcript it stays opaque so the chat does not show through.
      data-sidebar-surface={overlay ? undefined : ''}
      className={`flex min-h-0 shrink-0 flex-col ${overlay ? 'artifact-overlay absolute top-0 right-0 bottom-0 z-30 border-l border-white/[0.1] bg-ink-900 shadow-[-24px_0_48px_-16px_rgba(0,0,0,0.7)]' : `relative ${sidebarSurface('right')}`}`}
    >
      <ResizeHandle
        edge="left"
        label="Resize the artifact"
        grip
        panel={{ width, preview: onResize.preview, commit: onResize.commit, reset: () => onResize.commit(chatPanelLimits.initial) }}
      />
      <header className={`${sidePanelBar} border-b border-white/[0.06]`}>
        <div className={`${sidePanelHeaderRow} justify-end`}>
          {expand !== null && (
            <button type="button" onClick={expand.open} title={expand.label} aria-label={expand.label} className={sidePanelButton}>
              {expand.icon}
            </button>
          )}
          <button type="button" onClick={onClose} title="Close" aria-label="Close the artifact" className={sidePanelButton}>
            <MenuIconGlyph icon="close" />
          </button>
        </div>
      </header>
      <div className={`min-h-0 flex-1 overflow-y-auto ${scrolls ? '' : 'flex flex-col'}`}>
        <Body artifact={artifact} load={load} onOpenUrl={openUrl} />
      </div>
    </aside>
  )
}
