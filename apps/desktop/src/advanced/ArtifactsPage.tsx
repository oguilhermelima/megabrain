import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Components } from 'react-markdown'
import { api } from '@/api'
import type { Artifact, ArtifactContent, ArtifactKind, NativeChat, Project } from '@/api/schema'
import { ArtifactKindIcon } from '@/advanced/ArtifactStrip'
import { ArtifactsIcon, Chevron } from '@/advanced/chrome'
import { BarSearch, WikiShell } from '@/advanced/WikiShell'
import { Blank, ProjectSwitcher, Section, SectionCount, WikiProjectPicture, listBox } from '@/advanced/WikiParts'
import { wikiPanels } from '@/advanced/wiki-shell-model'
import { column, useRead } from '@/advanced/knowledge-parts'
import { displayName } from '@/advanced/appearance-model'
import { relativeAge } from '@/advanced/projects-model'
import { ArtifactFrame } from '@/advanced/ArtifactFrame'
import { artifactKindLabel, artifactKinds, artifactOfItem, artifactTabs, filterArtifactProject, groupArtifacts, newestArtifact, readArtifactTab, revisionRows, shownArtifactProject, shownArtifactTab, writeArtifactTab, type ArtifactProject, type ArtifactTab } from '@/advanced/artifacts-model'
import { MarkdownText } from '@/chat/markdown'
import { Collapse } from '@/components/Collapse'
import { SegmentedTabs } from '@/components/SegmentedTabs'
import { TextSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { useNow } from '@/github/parts'
import { projectsPolicy } from '@/lib/poll-model'
import { usePoll } from '@/lib/usePoll'

// The Artifacts page, the diagrams, plans and docs agents filed with `megabrain artifact`, in the
// Knowledge page's shell and pattern (WikiShell): one project at a time, its artifacts by kind in a
// panel on the right, and beside it a top bar with the project switcher and a search on titles over
// the picked artifact. The artifact reads in tabs (artifacts-model.ts): Preview renders it, Markdown
// in the app's renderer and HTML in a sandboxed frame that fills the column; Details says what it is,
// where it came from and its versions; Source shows its raw text.

/**
 * What the page had when it last showed. Its item changes with every artifact picked, which mounts
 * the page afresh; this keeps the list, the search and the folds from flashing back to their start.
 */
const memory: { list: Artifact[] | null; query: string; folded: ReadonlySet<ArtifactKind> } = { list: null, query: '', folded: new Set() }

function useArtifacts() {
  const [list, setList] = useState<Artifact[] | null>(memory.list)
  const [error, setError] = useState<unknown>(null)
  usePoll(
    projectsPolicy,
    async (current) => {
      try {
        const next = await api.artifacts()
        if (!current()) return
        memory.list = next.artifacts
        setList(next.artifacts)
        setError(null)
      } catch (caught) {
        // The last good list stays; usePoll tries again sooner.
        if (current()) setError(caught)
        throw caught
      }
    },
    [],
  )
  return { list, error }
}

/** One artifact's content; `version` changes when the list sees a newer revision, which reads it again. */
function useArtifact(id: string, version: string) {
  return useRead(`${id}\n${version}`, (key) => api.artifact(key.slice(0, key.indexOf('\n'))))
}

function NavArtifact({ artifact, selected, now, onPick }: { artifact: Artifact; selected: boolean; now: number; onPick: (artifact: Artifact) => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  // The picked artifact stays in view, whether picked here or restored.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onPick(artifact)}
      aria-current={selected ? 'page' : undefined}
      title={`${artifact.title}\n${artifactKindLabel(artifact.kind)} · updated ${new Date(artifact.updatedAt).toLocaleString()}`}
      className={`flex h-8 w-full items-center gap-2.5 rounded-[12px] pr-1.5 pl-[29px] text-left text-[13px] transition-colors ${selected ? 'bg-row-selected text-ink-100' : 'text-ink-300 hover:bg-row-hover hover:text-ink-100'}`}
    >
      <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
      <span className="shrink-0 text-[11px] whitespace-nowrap text-ink-400 tabular-nums">{relativeAge(artifact.updatedAt, now)}</span>
    </button>
  )
}

function NavKind({ kind, artifacts, open, onToggle, selectedId, now, onPick }: { kind: ArtifactKind; artifacts: Artifact[]; open: boolean; onToggle: (kind: ArtifactKind) => void; selectedId: string | null; now: number; onPick: (artifact: Artifact) => void }) {
  return (
    <section>
      {/* A section header as the Knowledge panel draws one: its chevron, its kind's mark and name, its count at the right. */}
      <button type="button" onClick={() => onToggle(kind)} aria-expanded={open} className="flex h-8 w-full items-center gap-2 rounded-[12px] pr-1.5 pl-2.5 text-left text-[13px] font-semibold text-ink-400 transition-colors select-none hover:text-ink-200">
        <Chevron open={open} />
        <span className="grid size-3.5 shrink-0 place-items-center">
          <ArtifactKindIcon kind={kind} />
        </span>
        <span className="min-w-0 flex-1 truncate">{artifactKinds.find((entry) => entry.kind === kind)?.title ?? kind}</span>
        <span className="shrink-0 text-[11px] font-medium tabular-nums">{artifacts.length}</span>
      </button>
      <Collapse open={open}>
        <div className="space-y-0.5 pt-0.5 pb-2">
          {artifacts.map((artifact) => (
            <NavArtifact key={artifact.id} artifact={artifact} selected={artifact.id === selectedId} now={now} onPick={onPick} />
          ))}
        </div>
      </Collapse>
    </section>
  )
}

/** A document's headings at reading size; the chat's renderer keeps them small for messages. */
export const documentElements: Components = {
  h1: (props) => <h1 className="pt-2 text-[22px] leading-tight font-semibold tracking-[-0.015em] text-ink-100" {...props} />,
  h2: (props) => <h2 className="pt-4 text-[17px] font-semibold tracking-[-0.01em] text-ink-100" {...props} />,
  h3: (props) => <h3 className="pt-2 text-[15px] font-semibold text-ink-100" {...props} />,
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium tracking-[0.04em] text-ink-400 uppercase">{label}</dt>
      <dd className="mt-1 flex min-w-0 items-center gap-1.5 text-[13.5px] text-ink-200">{children}</dd>
    </div>
  )
}

const when = (at: string, now: number) => (
  <span title={new Date(at).toLocaleString()} className="tabular-nums">
    {new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} · {relativeAge(at, now)} ago
  </span>
)

/** The titles of the project's topics, read once per page and kept for the run. */
const topicTitles = new Map<string, Promise<ReadonlyMap<string, string>>>()

function useTopicTitles(repo: string, wanted: boolean): ReadonlyMap<string, string> {
  const [titles, setTitles] = useState<{ repo: string; titles: ReadonlyMap<string, string> } | null>(null)
  useEffect(() => {
    if (!wanted) return
    let current = true
    let read = topicTitles.get(repo)
    if (read === undefined) {
      read = api.knowledge().then(
        (list) => new Map(list.projects.filter((project) => project.repo === repo).flatMap((project) => project.topics.map((topic) => [topic.id, topic.title] as const))),
        () => new Map(),
      )
      topicTitles.set(repo, read)
    }
    read.then((found) => current && setTitles({ repo, titles: found }))
    return () => {
      current = false
    }
  }, [repo, wanted])
  return titles?.repo === repo ? titles.titles : new Map()
}

const row = 'flex w-full min-w-0 items-center gap-3 px-5 py-3 text-left'

function Details({ artifact, listed, chats, now, onOpenChat, onOpenTopic }: { artifact: ArtifactContent; listed: Project | undefined; chats: NativeChat[]; now: number; onOpenChat: (chat: NativeChat) => void; onOpenTopic: (repo: string, topic: string) => void }) {
  const chat = artifact.chatId === null ? null : (chats.find((entry) => entry.id === artifact.chatId) ?? null)
  const titles = useTopicTitles(artifact.project, artifact.topics.length > 0)
  const revisions = revisionRows(artifact)
  return (
    <div role="tabpanel" aria-label="Details" className="space-y-9">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-[18px] border border-white/[0.07] bg-white/[0.02] px-5 py-4 sm:grid-cols-3">
        <Fact label="Project">
          <WikiProjectPicture project={listed} name={artifact.projectName} />
          <span title={artifact.project} className="truncate">
            {listed === undefined ? artifact.projectName : displayName(listed)}
          </span>
        </Fact>
        <Fact label="Kind">
          {artifactKindLabel(artifact.kind)} · {artifact.format === 'html' ? 'HTML' : 'Markdown'}
        </Fact>
        <Fact label="Chat">
          {artifact.chatId === null ? (
            <span className="text-ink-400">Filed by hand</span>
          ) : chat === null ? (
            <span className="truncate text-ink-400" title="The chat is no longer listed">
              {artifact.chatId}
            </span>
          ) : (
            <button type="button" onClick={() => onOpenChat(chat)} className="truncate font-medium text-accent hover:underline">
              {chat.title ?? 'Open the chat'}
            </button>
          )}
        </Fact>
        <Fact label="Created">{when(artifact.createdAt, now)}</Fact>
        <Fact label="Updated">{when(artifact.updatedAt, now)}</Fact>
      </dl>
      {artifact.topics.length > 0 && (
        <Section title="Topics" aside={<SectionCount count={artifact.topics.length} />}>
          <ul className={listBox}>
            {artifact.topics.map((topic) => (
              <li key={topic}>
                <button type="button" onClick={() => onOpenTopic(artifact.project, topic)} title="Read this topic on the Knowledge page" className={`${row} transition-colors duration-[var(--motion-enter)] hover:bg-white/[0.03]`}>
                  <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink-100">{titles.get(topic) ?? topic}</span>
                  <span aria-hidden="true" className="shrink-0 text-ink-500">
                    <Chevron open={false} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Revisions" aside={<SectionCount count={artifact.revision} />}>
        <ol className={listBox}>
          {revisions.map((entry) => (
            <li key={entry.revision} className={row}>
              <span className={`grid h-6 min-w-6 shrink-0 place-items-center rounded-full px-1.5 text-[11.5px] font-semibold tabular-nums ${entry.current ? 'bg-white/[0.14] text-ink-100' : 'bg-white/[0.05] text-ink-400'}`}>{entry.revision}</span>
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className={`block truncate text-[14px] leading-snug ${entry.current ? 'font-semibold text-ink-100' : 'text-ink-200'}`}>{entry.title}</span>
                <span className="block truncate text-[12.5px] text-ink-400">
                  {entry.current ? 'Current' : `Replaced ${relativeAge(entry.replacedAt ?? entry.at, now)} ago`}
                </span>
              </span>
              <span title={new Date(entry.at).toLocaleString()} className="shrink-0 text-[12px] text-ink-400 tabular-nums">
                {new Date(entry.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
              </span>
            </li>
          ))}
        </ol>
        {artifact.revisions === undefined && artifact.revision > 1 && <p className="text-[12.5px] text-ink-400">This megabrain does not list the earlier versions; they are kept beside the artifact.</p>}
      </Section>
      <Section title="Source">
        <p title={artifact.path} className="truncate rounded-[14px] border border-white/[0.07] bg-ink-900/60 px-4 py-2.5 font-mono text-[12px] text-ink-300 select-text">
          {artifact.path}
        </p>
      </Section>
    </div>
  )
}

const browserStorage = () => localStorage

function ArtifactTabs({ artifact, listed, chats, now, onOpenChat, onOpenTopic }: { artifact: ArtifactContent; listed: Project | undefined; chats: NativeChat[]; now: number; onOpenChat: (chat: NativeChat) => void; onOpenTopic: (repo: string, topic: string) => void }) {
  const [chosen, setChosen] = useState<ArtifactTab | null>(() => readArtifactTab(browserStorage, artifact.id))
  const tabs = artifactTabs(artifact)
  const shown = shownArtifactTab(tabs, chosen)
  const segments = tabs.map(({ tab, label, count }) => ({ view: tab, label, enabled: true, title: label, badge: count === null ? null : String(count) }))
  const header = (
    <header className="space-y-5">
      <h2 className="text-[28px] leading-tight font-semibold tracking-[-0.02em] text-ink-100">{artifact.title}</h2>
      <SegmentedTabs label="Artifact" segments={segments} shown={shown} onSelect={(tab) => setChosen(writeArtifactTab(browserStorage, artifact.id, tab))} />
    </header>
  )
  // A rendered HTML artifact takes the height the header leaves, and its frame scrolls on its own.
  if (shown === 'preview' && artifact.format === 'html') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className={`${column} shrink-0 pb-6`}>{header}</div>
        <div role="tabpanel" aria-label="Preview" className="min-h-0 flex-1 px-6 pb-6">
          <ArtifactFrame title={artifact.title} html={artifact.content} className="h-full w-full rounded-[14px] border border-white/[0.07] bg-white" />
        </div>
      </div>
    )
  }
  return (
    <div className="h-full overflow-y-auto">
      <div className={`${column} space-y-8`}>
        {header}
        {shown === 'preview' && (
          <div role="tabpanel" aria-label="Preview">
            <MarkdownText text={artifact.content} elements={documentElements} className="space-y-3 text-[14.5px] leading-relaxed text-ink-200" />
          </div>
        )}
        {shown === 'details' && <Details artifact={artifact} listed={listed} chats={chats} now={now} onOpenChat={onOpenChat} onOpenTopic={onOpenTopic} />}
        {shown === 'source' && (
          <div role="tabpanel" aria-label="Source">
            <pre className="overflow-x-auto rounded-[20px] border border-white/[0.07] bg-ink-900/60 px-5 py-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-200 select-text [overflow-wrap:anywhere]">{artifact.content}</pre>
          </div>
        )}
      </div>
    </div>
  )
}

function ArtifactReading({ id, version, ...rest }: { id: string; version: string; listed: Project | undefined; chats: NativeChat[]; now: number; onOpenChat: (chat: NativeChat) => void; onOpenTopic: (repo: string, topic: string) => void }) {
  const load = useArtifact(id, version)
  if (load.state !== 'ready') {
    return <div className={column}>{load.state === 'loading' ? <TextSkeleton lines={8} /> : <ErrorNote error={load.error} />}</div>
  }
  return <ArtifactTabs artifact={load.value} {...rest} />
}

export function ArtifactsPage({
  id,
  projects,
  chats,
  onPick,
  onOpenChat,
  onOpenTopic,
}: {
  /** The item's id: the artifact shown, or the latest page (artifacts-model.ts). */
  id: string
  /** The listed projects, for their pictures and names. */
  projects: Project[]
  chats: NativeChat[]
  /** Shows an artifact on this page. */
  onPick: (artifact: Artifact) => void
  onOpenChat: (chat: NativeChat) => void
  /** Opens a topic on the Knowledge page. */
  onOpenTopic: (repo: string, topic: string) => void
}) {
  const now = useNow(30_000)
  const [query, setQuery] = useState(memory.query)
  const [folded, setFolded] = useState<ReadonlySet<ArtifactKind>>(memory.folded)
  useEffect(() => {
    memory.query = query
    memory.folded = folded
  }, [query, folded])
  const toggle = (kind: ArtifactKind) =>
    setFolded((current) => {
      const next = new Set(current)
      if (!next.delete(kind)) next.add(kind)
      return next
    })
  const { list, error } = useArtifacts()
  const listed = useMemo(() => new Map(projects.map((project) => [project.path, project])), [projects])
  const grouped = useMemo(() => (list === null ? null : groupArtifacts(list)), [list])
  const picked = artifactOfItem(id)
  const project = grouped === null ? null : shownArtifactProject(grouped, picked)
  const projectArtifacts = project?.kinds.flatMap((group) => group.artifacts) ?? []
  // The artifact picked, while the list has not answered or still has it; else the project's newest.
  const selectedId = (picked !== null && (list === null || projectArtifacts.some((artifact) => artifact.id === picked)) ? picked : null) ?? (project === null ? null : newestArtifact([project])?.id) ?? null
  const selected = projectArtifacts.find((artifact) => artifact.id === selectedId)
  const shown = project === null ? null : filterArtifactProject(project, query)
  const searching = query.trim() !== ''
  const none = list !== null && list.length === 0
  /** A project's name as the sidebar shows it. */
  const nameOf = (entry: ArtifactProject) => {
    const known = listed.get(entry.project)
    return known === undefined ? entry.name : displayName(known)
  }
  const pickProject = (entry: ArtifactProject) => {
    setQuery('')
    const newest = newestArtifact([entry])
    if (newest !== null) onPick(newest)
  }

  const reading = (): ReactNode => {
    if (none) {
      return (
        <Blank title="No artifacts yet">
          When an agent makes a diagram, a plan or a doc, it files it with <code className="rounded-md bg-white/[0.08] px-1 py-0.5 font-mono text-[12.5px] text-ink-200">megabrain artifact create</code>. They gather here by project and kind.
        </Blank>
      )
    }
    if (selectedId === null) return <div className={column}>{error === null ? <TextSkeleton lines={8} /> : <ErrorNote error={error} />}</div>
    return <ArtifactReading key={selectedId} id={selectedId} version={selected?.updatedAt ?? ''} listed={project === null ? undefined : listed.get(project.project)} chats={chats} now={now} onOpenChat={onOpenChat} onOpenTopic={onOpenTopic} />
  }

  const crumb =
    project !== null && grouped !== null ? (
      <ProjectSwitcher name={nameOf(project)} path={project.project} listed={listed.get(project.project)} options={grouped.map((entry) => ({ label: nameOf(entry), title: entry.project, onSelect: () => pickProject(entry) }))} />
    ) : (
      <span className="flex min-w-0 items-center gap-2 text-ink-300">
        <span className="grid size-6 shrink-0 place-items-center">
          <ArtifactsIcon />
        </span>
        <h1 className="truncate text-[14px] leading-5 font-semibold tracking-[-0.01em] text-ink-100">Artifacts</h1>
      </span>
    )
  const shownCount = shown?.kinds.reduce((sum, group) => sum + group.artifacts.length, 0) ?? null

  return (
    <WikiShell
      keys={wikiPanels.artifacts}
      crumb={crumb}
      tools={project !== null && <BarSearch value={query} onChange={setQuery} label="Search artifacts" />}
      panelLabel={none ? null : 'Artifacts'}
      panelCount={shownCount}
      panel={
        <>
          {error !== null && list === null && (
            <div className="px-1">
              <ErrorNote error={error} />
            </div>
          )}
          {list === null && error === null && <p className="px-2.5 py-1 text-[12.5px] text-ink-400">Loading artifacts…</p>}
          {searching && shown?.kinds.length === 0 && <p className="px-2.5 py-1 text-[12.5px] text-ink-400">No artifact title matches “{query.trim()}”.</p>}
          {shown?.kinds.map((group) => (
            <NavKind key={group.kind} kind={group.kind} artifacts={group.artifacts} open={searching || !folded.has(group.kind)} onToggle={toggle} selectedId={selectedId} now={now} onPick={onPick} />
          ))}
        </>
      }
    >
      <article className="h-full min-w-0">{reading()}</article>
    </WikiShell>
  )
}
