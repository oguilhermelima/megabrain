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
import { artifactKindLabel, artifactKinds, artifactOfItem, artifactRevisionEntries, artifactTabs, artifactView, filterArtifactProject, groupArtifacts, newestArtifact, readArtifactTab, revisionRows, shownArtifactProject, shownArtifactTab, writeArtifactTab, type ArtifactProject, type ArtifactTab, type ArtifactView } from '@/advanced/artifacts-model'
import { MarkdownText } from '@/chat/markdown'
import { Collapse } from '@/components/Collapse'
import { SegmentedTabs } from '@/components/SegmentedTabs'
import { TextSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { useNow } from '@/github/parts'
import { projectsPolicy } from '@/lib/poll-model'
import { sidePanelGroup, sidePanelNote, sidePanelRow, sidePanelSlot, sidePanelTrailing } from '@/lib/side-panel'
import { usePoll } from '@/lib/usePoll'
import { revisionRead, revisionView } from '@/native-chat/chat-artifacts'
import { OldRevisionNote, RevisionPicker } from '@/native-chat/RevisionPicker'

// The Artifacts page, the diagrams, plans and docs agents filed with `megabrain artifact`, in the
// Knowledge page's shell and pattern (WikiShell): one project at a time, its artifacts by kind in a
// panel on the right, and beside it a top bar with the project switcher and a search on titles over
// the picked artifact. The artifact carries its own title, so the page draws none: the bar holds its
// tabs (artifacts-model.ts) and its revision picker, the chat panel's (native-chat/RevisionPicker).
// Preview renders it, HTML in a sandboxed frame filling everything under the bar, Markdown in the
// app's renderer in the reading column; Details says what it is, where it came from and its versions;
// Source shows its raw text. An earlier revision reads in Preview and Source under a note; Details
// keeps telling of the latest.

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
function useArtifact(id: string | null, version: string) {
  return useRead(id === null ? null : `${id}\n${version}`, (key) => api.artifact(key.slice(0, key.indexOf('\n'))))
}

/** An earlier revision's content, read while one is picked. */
function useEarlierRevision(id: string | null, revision: number | undefined) {
  return useRead(id === null || revision === undefined ? null : `${id}\n${revision}`, (key) => api.artifact(key.slice(0, key.indexOf('\n')), Number(key.slice(key.indexOf('\n') + 1))))
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
      className={sidePanelRow(selected)}
    >
      <span aria-hidden="true" className={sidePanelSlot} />
      <span aria-hidden="true" className={sidePanelSlot} />
      <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
      <span className={sidePanelTrailing}>{relativeAge(artifact.updatedAt, now)}</span>
    </button>
  )
}

function NavKind({ kind, artifacts, open, onToggle, selectedId, now, onPick }: { kind: ArtifactKind; artifacts: Artifact[]; open: boolean; onToggle: (kind: ArtifactKind) => void; selectedId: string | null; now: number; onPick: (artifact: Artifact) => void }) {
  return (
    <section>
      {/* A section header as the Knowledge panel draws one: its kind's mark and name, its count and chevron at the right. */}
      <button type="button" onClick={() => onToggle(kind)} aria-expanded={open} className={sidePanelGroup}>
        <span className={sidePanelSlot}>
          <ArtifactKindIcon kind={kind} />
        </span>
        <span className="min-w-0 flex-1 truncate">{artifactKinds.find((entry) => entry.kind === kind)?.title ?? kind}</span>
        <span className="shrink-0 text-[11px] font-medium tabular-nums">{artifacts.length}</span>
        <span className={sidePanelSlot}>
          <Chevron open={open} />
        </span>
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

/** The picked tab's panel for a version: the rendered artifact, its facts, or its raw text. */
function ArtifactBody({ tab, artifact, details }: { tab: ArtifactTab; artifact: ArtifactContent; details: ReactNode }) {
  // A rendered HTML artifact takes all the room under the bar, and its frame scrolls on its own.
  if (tab === 'preview' && artifact.format === 'html') {
    return (
      <div role="tabpanel" aria-label="Preview" className="h-full">
        <ArtifactFrame title={artifact.title} html={artifact.content} className="h-full w-full" />
      </div>
    )
  }
  return (
    <div className="h-full overflow-y-auto">
      <div className={column}>
        {tab === 'preview' && (
          <div role="tabpanel" aria-label="Preview">
            <MarkdownText text={artifact.content} elements={documentElements} className="space-y-3 text-[14.5px] leading-relaxed text-ink-200" />
          </div>
        )}
        {tab === 'details' && details}
        {tab === 'source' && (
          <div role="tabpanel" aria-label="Source">
            <pre className="overflow-x-auto rounded-[20px] border border-white/[0.07] bg-ink-900/60 px-5 py-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-200 select-text [overflow-wrap:anywhere]">{artifact.content}</pre>
          </div>
        )}
      </div>
    </div>
  )
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
  // The tab and version the bar shows for the picked artifact; another artifact starts from its remembered tab, at its latest.
  const [kept, setKept] = useState<ArtifactView>({ id: null, tab: null, pick: null })
  const view = artifactView(kept, selectedId, (artifact) => readArtifactTab(browserStorage, artifact))
  const latest = useArtifact(selectedId, selected?.updatedAt ?? '')
  const ready = latest.state === 'ready' ? latest.value : null
  const entries = ready === null ? [] : artifactRevisionEntries(ready)
  const revisions = revisionView(entries, view.pick)
  const old = revisions?.old === true ? revisions : null
  const earlier = useEarlierRevision(selectedId, old === null ? undefined : revisionRead(old.shown).revision)
  // Tabs come from the listed artifact, so they show before its content has read.
  const tabs = selectedId === null ? null : artifactTabs(selected ?? ready ?? { revision: 1 })
  const tab = shownArtifactTab(tabs ?? [], view.tab)
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
    // Details always tells of the artifact as it is now; Preview and Source read the version picked.
    const load = old !== null && tab !== 'details' ? earlier : latest
    if (load.state !== 'ready' || ready === null) {
      const failed = load.state === 'failed' ? load : latest.state === 'failed' ? latest : null
      return <div className={column}>{failed === null ? <TextSkeleton lines={8} /> : <ErrorNote error={failed.error} />}</div>
    }
    const details = <Details artifact={ready} listed={project === null ? undefined : listed.get(project.project)} chats={chats} now={now} onOpenChat={onOpenChat} onOpenTopic={onOpenTopic} />
    return <ArtifactBody tab={tab} artifact={load.value} details={details} />
  }

  const switcher =
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
  const segments = tabs?.map(({ tab: entry, label, count }) => ({ view: entry, label, enabled: true, title: label, badge: count === null ? null : String(count) }))
  const crumb = (
    <>
      {switcher}
      {selectedId !== null && segments !== undefined && <SegmentedTabs label="Artifact" segments={segments} shown={tab} onSelect={(next) => setKept({ ...view, tab: writeArtifactTab(browserStorage, selectedId, next) })} />}
    </>
  )
  const shownCount = shown?.kinds.reduce((sum, group) => sum + group.artifacts.length, 0) ?? null

  return (
    <WikiShell
      keys={wikiPanels.artifacts}
      crumb={crumb}
      tools={
        project !== null && (
          <>
            {revisions !== null && entries.length > 1 && ready !== null && <RevisionPicker entries={entries} shown={revisions.shown} old={revisions.old} title={ready.title} now={now} onPick={(pick) => setKept({ ...view, pick })} />}
            <BarSearch value={query} onChange={setQuery} label="Search artifacts" />
          </>
        )
      }
      panelLabel={none ? null : 'Artifacts'}
      panelCount={shownCount}
      panel={
        <>
          {error !== null && list === null && (
            <div className="px-1">
              <ErrorNote error={error} />
            </div>
          )}
          {list === null && error === null && <p className={sidePanelNote}>Loading artifacts…</p>}
          {searching && shown?.kinds.length === 0 && <p className={sidePanelNote}>No artifact title matches “{query.trim()}”.</p>}
          {shown?.kinds.map((group) => (
            <NavKind key={group.kind} kind={group.kind} artifacts={group.artifacts} open={searching || !folded.has(group.kind)} onToggle={toggle} selectedId={selectedId} now={now} onPick={onPick} />
          ))}
        </>
      }
    >
      <article className="flex h-full min-w-0 flex-col">
        {old !== null && <OldRevisionNote shown={old.shown} latest={old.latest} onBack={() => setKept({ ...view, pick: null })} className="shrink-0 border-b pr-5 pl-6" />}
        <div className="min-h-0 flex-1">{reading()}</div>
      </article>
    </WikiShell>
  )
}
