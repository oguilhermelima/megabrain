import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Components } from 'react-markdown'
import { api } from '@/api'
import type { Artifact, ArtifactContent, NativeChat, Project } from '@/api/schema'
import { ArtifactKindIcon } from '@/advanced/ArtifactStrip'
import { ArtifactsIcon, Chevron } from '@/advanced/chrome'
import { BarSearch, WikiShell } from '@/advanced/WikiShell'
import { wikiPanels } from '@/advanced/wiki-shell-model'
import { relativeAge } from '@/advanced/projects-model'
import { ArtifactFrame } from '@/advanced/ArtifactFrame'
import { artifactKindLabel, artifactKinds, artifactOfItem, groupArtifacts, newestArtifact, type ArtifactProject } from '@/advanced/artifacts-model'
import { ProjectPicture } from '@/advanced/ProjectPicture'
import { projectColor, projectInitials } from '@/advanced/picture-model'
import { MarkdownText } from '@/chat/markdown'
import { Collapse } from '@/components/Collapse'
import { TextSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { useNow } from '@/github/parts'
import { projectsPolicy } from '@/lib/poll-model'
import { usePoll } from '@/lib/usePoll'

// The Artifacts page, the diagrams, plans and docs agents filed with `megabrain artifact`, in the
// Knowledge page's shell (WikiShell): the projects and their artifacts by kind in a panel on the right,
// and beside it a top bar with the page's name and a filter on titles over the picked artifact.
// Markdown reads in the app's renderer; HTML renders in a sandboxed
// frame (artifacts-model.ts) that fills the column below the artifact's header.

/** A project's picture when megabrain lists it, else its initials on its colour. */
function Picture({ project, name }: { project: Project | undefined; name: string }) {
  if (project !== undefined) return <ProjectPicture project={project} />
  return (
    <span aria-hidden="true" style={{ backgroundColor: projectColor(name) }} className="grid size-6 shrink-0 place-items-center rounded-[8px] text-[10.5px] font-bold tracking-[0.02em] text-white">
      {projectInitials(name)}
    </span>
  )
}

function useArtifacts() {
  const [list, setList] = useState<Artifact[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  usePoll(
    projectsPolicy,
    async (current) => {
      try {
        const next = await api.artifacts()
        if (!current()) return
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

type Loaded = { state: 'loading' } | { state: 'failed'; error: unknown } | { state: 'ready'; artifact: ArtifactContent }

/** One artifact's content; `version` changes when the list sees a newer revision, which reloads it. */
function useArtifact(id: string, version: string): Loaded {
  const [load, setLoad] = useState<{ key: string; value: Loaded }>({ key: '', value: { state: 'loading' } })
  const key = `${id}\n${version}`
  useEffect(() => {
    let current = true
    api.artifact(id).then(
      (artifact) => current && setLoad({ key, value: { state: 'ready', artifact } }),
      (error: unknown) => current && setLoad({ key, value: { state: 'failed', error } }),
    )
    return () => {
      current = false
    }
  }, [id, key])
  return load.key === key ? load.value : { state: 'loading' }
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
      title={`${artifact.title}\n${new Date(artifact.updatedAt).toLocaleString()}`}
      className={`flex h-8 w-full items-center gap-2 rounded-[12px] pr-1.5 pl-[29px] text-left text-[13px] transition-colors ${selected ? 'bg-row-selected text-ink-100' : 'text-ink-300 hover:bg-row-hover hover:text-ink-100'}`}
    >
      <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
      <span className="shrink-0 text-[11px] whitespace-nowrap text-ink-400 tabular-nums">{relativeAge(artifact.updatedAt, now)}</span>
    </button>
  )
}

function NavProject({ project, listed, open, onToggle, selectedId, now, onPick }: { project: ArtifactProject; listed: Project | undefined; open: boolean; onToggle: (project: string) => void; selectedId: string | null; now: number; onPick: (artifact: Artifact) => void }) {
  return (
    <section>
      <button
        type="button"
        onClick={() => onToggle(project.project)}
        aria-expanded={open}
        title={`${project.name}\n${project.project}`}
        className="group/fold flex h-9 w-full min-w-0 items-center gap-2.5 rounded-[12px] pr-1.5 pl-2.5 text-left transition-colors select-none hover:bg-row-hover"
      >
        <span className="relative flex shrink-0 items-center">
          <span className="transition-opacity duration-[120ms] group-hover/fold:opacity-0">
            <Picture project={listed} name={project.name} />
          </span>
          <span aria-hidden="true" className="absolute inset-0 grid place-items-center text-ink-300 opacity-0 transition-opacity duration-[120ms] group-hover/fold:opacity-100">
            <Chevron open={open} />
          </span>
        </span>
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-ink-100">{project.name}</h2>
      </button>
      <Collapse open={open}>
        <div className="space-y-2 pt-0.5 pb-2">
          {project.kinds.map((group) => (
            <div key={group.kind} className="space-y-0.5">
              <div className="flex h-7 items-center gap-2 pr-1.5 pl-[27px] text-ink-400">
                <span className="grid size-3.5 shrink-0 place-items-center">
                  <ArtifactKindIcon kind={group.kind} />
                </span>
                <h3 className="min-w-0 flex-1 truncate text-[12px] font-medium">{artifactKinds.find((entry) => entry.kind === group.kind)?.title}</h3>
                <span className="shrink-0 text-[11px] tabular-nums">{group.artifacts.length}</span>
              </div>
              {group.artifacts.map((artifact) => (
                <NavArtifact key={artifact.id} artifact={artifact} selected={artifact.id === selectedId} now={now} onPick={onPick} />
              ))}
            </div>
          ))}
        </div>
      </Collapse>
    </section>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium tracking-[0.04em] text-ink-400 uppercase">{label}</dt>
      <dd className="mt-1 flex min-w-0 items-center gap-1.5 text-[13.5px] text-ink-200">{children}</dd>
    </div>
  )
}

/** A document's headings at reading size; the chat's renderer keeps them small for messages. */
export const documentElements: Components = {
  h1: (props) => <h1 className="pt-2 text-[22px] leading-tight font-semibold tracking-[-0.015em] text-ink-100" {...props} />,
  h2: (props) => <h2 className="pt-4 text-[17px] font-semibold tracking-[-0.01em] text-ink-100" {...props} />,
  h3: (props) => <h3 className="pt-2 text-[15px] font-semibold text-ink-100" {...props} />,
}

/** The reading column's width: about 720px of text inside its padding. */
const column = 'mx-auto w-full max-w-[784px] px-8'

function Header({ artifact, project, chats, now, onOpenChat }: { artifact: ArtifactContent; project: Project | undefined; chats: NativeChat[]; now: number; onOpenChat: (chat: NativeChat) => void }) {
  const chat = artifact.chatId === null ? null : (chats.find((entry) => entry.id === artifact.chatId) ?? null)
  return (
    <header className="space-y-5">
      <div className="flex items-center gap-2.5 text-[13px] text-ink-300">
        <Picture project={project} name={artifact.projectName} />
        <span className="font-semibold text-ink-200">{artifact.projectName}</span>
        <span className="text-ink-500">/</span>
        <span className="flex items-center gap-1.5">
          <ArtifactKindIcon kind={artifact.kind} />
          {artifactKindLabel(artifact.kind)}
        </span>
      </div>
      <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.02em] text-ink-100">{artifact.title}</h1>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-[18px] border border-white/[0.07] bg-white/[0.02] px-5 py-4 sm:grid-cols-3">
        <Fact label="Updated">
          <span title={artifact.updatedAt}>
            {new Date(artifact.updatedAt).toLocaleString()} · {relativeAge(artifact.updatedAt, now)}
          </span>
        </Fact>
        <Fact label="Revision">
          <span className="tabular-nums" title={artifact.revision > 1 ? `${artifact.revision - 1} earlier ${artifact.revision === 2 ? 'version is' : 'versions are'} kept` : 'The first version'}>
            {artifact.revision}
          </span>
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
      </dl>
    </header>
  )
}

function Reading({ id, version, projects, chats, now, onOpenChat }: { id: string; version: string; projects: Project[]; chats: NativeChat[]; now: number; onOpenChat: (chat: NativeChat) => void }) {
  const load = useArtifact(id, version)
  if (load.state !== 'ready') {
    return <div className={`${column} py-10`}>{load.state === 'loading' ? <TextSkeleton lines={6} /> : <ErrorNote error={load.error} />}</div>
  }
  const { artifact } = load
  const project = projects.find((entry) => entry.path === artifact.project)
  const header = <Header artifact={artifact} project={project} chats={chats} now={now} onOpenChat={onOpenChat} />
  if (artifact.format === 'markdown') {
    return (
      <div className="h-full overflow-y-auto">
        <div className={`${column} space-y-8 py-10`}>
          {header}
          <MarkdownText text={artifact.content} elements={documentElements} className="space-y-3 text-[14.5px] leading-relaxed text-ink-200" />
        </div>
      </div>
    )
  }
  // The frame scrolls on its own and takes the height the header leaves.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`${column} shrink-0 pt-10 pb-6`}>{header}</div>
      <div className="min-h-0 flex-1 px-6 pb-6">
        <ArtifactFrame title={artifact.title} html={artifact.content} className="h-full w-full rounded-[14px] border border-white/[0.07] bg-white" />
      </div>
    </div>
  )
}

/** The reading column with nothing to read: why, and what to do about it. */
function Blank({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={`${column} pt-24 text-center`}>
      <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink-100">{title}</h1>
      <p className="mx-auto mt-2 max-w-[420px] text-[13.5px] leading-relaxed text-ink-400">{children}</p>
    </div>
  )
}

export function ArtifactsPage({
  id,
  projects,
  chats,
  onPick,
  onOpenChat,
}: {
  /** The item's id: the artifact shown, or the latest page (artifacts-model.ts). */
  id: string
  /** The listed projects, for their pictures. */
  projects: Project[]
  chats: NativeChat[]
  /** Shows an artifact on this page. */
  onPick: (artifact: Artifact) => void
  onOpenChat: (chat: NativeChat) => void
}) {
  const now = useNow(30_000)
  const [query, setQuery] = useState('')
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const toggle = (project: string) =>
    setFolded((current) => {
      const next = new Set(current)
      if (!next.delete(project)) next.add(project)
      return next
    })
  const { list, error } = useArtifacts()
  const listed = useMemo(() => new Map(projects.map((project) => [project.path, project])), [projects])
  const text = query.trim().toLowerCase()
  const grouped = useMemo(() => (list === null ? null : groupArtifacts(text === '' ? list : list.filter((artifact) => artifact.title.toLowerCase().includes(text)))), [list, text])
  const all = useMemo(() => (list === null ? null : groupArtifacts(list)), [list])
  const selectedId = artifactOfItem(id) ?? (all === null ? null : (newestArtifact(all)?.id ?? null))
  const selected = list?.find((artifact) => artifact.id === selectedId)
  const none = list !== null && list.length === 0

  const count = grouped?.reduce((sum, project) => sum + project.kinds.reduce((inner, group) => inner + group.artifacts.length, 0), 0) ?? null

  return (
    <WikiShell
      keys={wikiPanels.artifacts}
      crumb={
        <span className="flex shrink-0 items-center gap-2 text-ink-300">
          <span className="grid size-6 shrink-0 place-items-center">
            <ArtifactsIcon />
          </span>
          <h1 className="text-[14px] leading-5 font-semibold tracking-[-0.01em] text-ink-100">Artifacts</h1>
        </span>
      }
      tools={!none && <BarSearch value={query} onChange={setQuery} label="Filter artifacts" />}
      panelLabel={none ? null : 'Artifacts'}
      panelCount={count}
      panel={
        <>
          {error !== null && list === null && (
            <div className="px-1">
              <ErrorNote error={error} />
            </div>
          )}
          {list === null && error === null && <p className="px-2.5 py-1 text-[12.5px] text-ink-400">Loading artifacts…</p>}
          {text !== '' && grouped?.length === 0 && <p className="px-2.5 py-1 text-[12.5px] text-ink-400">No artifact title matches “{query.trim()}”.</p>}
          {grouped?.map((project) => (
            <NavProject key={project.project} project={project} listed={listed.get(project.project)} open={text !== '' || !folded.has(project.project)} onToggle={toggle} selectedId={selectedId} now={now} onPick={onPick} />
          ))}
        </>
      }
    >
      <article className="h-full min-w-0">
        {selectedId !== null ? (
          <Reading key={selectedId} id={selectedId} version={selected?.updatedAt ?? ''} projects={projects} chats={chats} now={now} onOpenChat={onOpenChat} />
        ) : none ? (
          <Blank title="No artifacts yet">
            When an agent makes a diagram, a plan or a doc, it files it with <code className="rounded-md bg-white/[0.08] px-1 py-0.5 font-mono text-[12.5px] text-ink-200">megabrain artifact create</code>. They gather here by project and kind.
          </Blank>
        ) : (
          error === null && (
            <div className={`${column} py-10`}>
              <TextSkeleton lines={6} />
            </div>
          )
        )}
      </article>
    </WikiShell>
  )
}
