import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '@/api'
import type { Artifact, KnowledgeChat, KnowledgeKind, KnowledgeList, KnowledgeRef, KnowledgeStatus, KnowledgeTopic, KnowledgeTopicSummary, Project } from '@/api/schema'
import { ArtifactStrip } from '@/advanced/ArtifactStrip'
import { column, useRead } from '@/advanced/knowledge-parts'
import { ChatTranscript } from '@/advanced/KnowledgeTranscript'
import { Chevron, KnowledgeIcon } from '@/advanced/chrome'
import { KnowledgeMap } from '@/advanced/KnowledgeMap'
import { BarSearch, WikiShell, barToggle } from '@/advanced/WikiShell'
import { wikiPanels } from '@/advanced/wiki-shell-model'
import { chatCards, decisionsOf, groupTopics, kindColors, kindGroups, pageTitle, refLabel, refNumber, statusLabels, type KnowledgeView } from '@/advanced/knowledge-model'
import { displayName } from '@/advanced/appearance-model'
import { ProjectPicture } from '@/advanced/ProjectPicture'
import { projectColor, projectInitials } from '@/advanced/picture-model'
import { relativeAge } from '@/advanced/projects-model'
import { MarkdownText } from '@/chat/markdown'
import { AgentIcon } from '@/components/agent-icons'
import { Collapse } from '@/components/Collapse'
import { ContextMenu, useContextMenu } from '@/components/ContextMenu'
import { TextSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { useNow } from '@/github/parts'
import { stateColors } from '@/github/github-model'
import { ClosedIssueIcon, ClosedPullRequestIcon, IssueIcon, MergedIcon, PullRequestIcon } from '@/github/icons'
import { projectsPolicy } from '@/lib/poll-model'
import { usePoll } from '@/lib/usePoll'
import { effectiveToggles, inEffect, parseKnowledgeSettings, type KnowledgeSettings } from '@/settings/knowledge-model'

// The Knowledge page, a wiki of one project's topics in one pane (WikiShell): a top bar with the
// project switcher, the page's title, a search and the map's toggle, the topics by kind in a panel on
// the right, and between them the picked topic in a reading column: its
// kind and status, refs, sections, decisions, key messages and the chats that built it. The item's id
// is what the page shows (knowledge-model.ts); with no topic picked it shows the project's newest.

type KnowledgeProject = KnowledgeList['projects'][number]

/** A project's picture when megabrain lists it, else its initials on its colour. */
function KnowledgePicture({ project, name }: { project: Project | undefined; name: string }) {
  if (project !== undefined) return <ProjectPicture project={project} />
  return (
    <span aria-hidden="true" style={{ backgroundColor: projectColor(name) }} className="grid size-6 shrink-0 place-items-center rounded-[8px] text-[10.5px] font-bold tracking-[0.02em] text-white">
      {projectInitials(name)}
    </span>
  )
}

/** The project the page shows: the one picked, else the enabled project with the newest topic. */
function pickProject(projects: readonly KnowledgeProject[], repo: string | null): KnowledgeProject | null {
  const picked = projects.find((project) => project.repo === repo)
  if (picked !== undefined) return picked
  const latest = (project: KnowledgeProject) => project.topics.reduce((newest, topic) => (topic.updatedAt > newest ? topic.updatedAt : newest), '')
  return [...projects].sort((left, right) => Number(right.enabled) - Number(left.enabled) || latest(right).localeCompare(latest(left)))[0] ?? null
}

/**
 * What the page had when it last showed. Its item changes with every topic picked, which mounts the
 * page afresh; this keeps the list, the search and the folds from flashing back to their start.
 */
const memory: { list: KnowledgeList | null; settings: KnowledgeSettings | null; query: string; folded: ReadonlySet<KnowledgeKind> } = { list: null, settings: null, query: '', folded: new Set() }

function useKnowledgeList() {
  const [list, setList] = useState<KnowledgeList | null>(memory.list)
  const [settings, setSettings] = useState<KnowledgeSettings | null>(memory.settings)
  const [error, setError] = useState<unknown>(null)
  usePoll(
    projectsPolicy,
    async (current) => {
      try {
        const [saved, chatSummaries, next] = await Promise.all([api.knowledgeSettings().catch(() => null), api.chatSummaries().catch(() => null), api.knowledge()])
        if (!current()) return
        memory.settings = saved === null ? null : parseKnowledgeSettings(saved, chatSummaries)
        memory.list = next
        setSettings(memory.settings)
        setList(next)
        setError(null)
      } catch (caught) {
        // The last good list stays; usePoll tries again sooner.
        if (current()) setError(caught)
        throw caught
      }
    },
    [],
  )
  return { list, settings, error }
}

/** The project's topics matching the text; a search waits for the typing to stop, and an answer to older text or another project is dropped. */
function useTopicSearch(repo: string | null, query: string) {
  const [error, setError] = useState<unknown>(null)
  const [found, setFound] = useState<{ key: string; results: KnowledgeTopicSummary[] } | null>(null)
  const text = query.trim()
  const key = `${repo ?? ''}\n${text}`
  useEffect(() => {
    if (text === '' || repo === null) return
    let current = true
    const timer = setTimeout(() => {
      api.searchKnowledge(text, repo).then(
        (next) => current && setFound({ key, results: next.results }),
        (caught: unknown) => current && setError(caught),
      )
    }, 250)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [text, repo, key])
  return { results: found?.key === key ? found.results : null, error }
}

const statusDot: Record<KnowledgeStatus, string> = { active: 'bg-accent', shipped: 'bg-ok', dropped: 'bg-ink-500' }

function StatusDot({ status }: { status: KnowledgeStatus }) {
  return <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${statusDot[status]}`} />
}

function NavTopic({ topic, selected, now, onPick }: { topic: KnowledgeTopicSummary; selected: boolean; now: number; onPick: (topic: KnowledgeTopicSummary) => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  // The picked topic stays in view, whether picked here, from the map or restored.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onPick(topic)}
      aria-current={selected ? 'page' : undefined}
      title={`${topic.title}\n${statusLabels[topic.status]} · updated ${new Date(topic.updatedAt).toLocaleString()}`}
      className={`flex h-8 w-full items-center gap-2.5 rounded-[12px] pr-1.5 pl-[29px] text-left text-[13px] transition-colors ${selected ? 'bg-row-selected text-ink-100' : 'text-ink-300 hover:bg-row-hover hover:text-ink-100'}`}
    >
      <StatusDot status={topic.status} />
      <span className={`min-w-0 flex-1 truncate ${topic.status === 'dropped' ? 'text-ink-400' : ''}`}>{topic.title}</span>
      <span className="shrink-0 text-[11px] whitespace-nowrap text-ink-400 tabular-nums">{relativeAge(topic.updatedAt, now)}</span>
    </button>
  )
}

function NavKind({ label, kind, topics, open, onToggle, selectedId, now, onPick }: { label: string; kind: KnowledgeKind; topics: KnowledgeTopicSummary[]; open: boolean; onToggle: (kind: KnowledgeKind) => void; selectedId: string | null; now: number; onPick: (topic: KnowledgeTopicSummary) => void }) {
  return (
    <section>
      {/* A section header as the left sidebar draws one: its chevron, its name, its count at the right. */}
      <button type="button" onClick={() => onToggle(kind)} aria-expanded={open} className="flex h-8 w-full items-center gap-2 rounded-[12px] pr-1.5 pl-2.5 text-left text-[13px] font-semibold text-ink-400 transition-colors select-none hover:text-ink-200">
        <Chevron open={open} />
        <span style={{ backgroundColor: kindColors[kind] }} aria-hidden="true" className="size-2 shrink-0 rounded-[3px]" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 text-[11px] font-medium tabular-nums">{topics.length}</span>
      </button>
      <Collapse open={open}>
        <div className="space-y-0.5 pt-0.5 pb-2">
          {topics.map((topic) => (
            <NavTopic key={topic.id} topic={topic} selected={topic.id === selectedId} now={now} onPick={onPick} />
          ))}
        </div>
      </Collapse>
    </section>
  )
}

/** A chip at the head of a topic: its kind in the kind's colour, or its status with its dot. */
function KindChip({ kind }: { kind: KnowledgeKind }) {
  const color = kindColors[kind]
  return (
    <span style={{ backgroundColor: `${color}1f`, color, borderColor: `${color}4d` }} className="inline-flex h-6 shrink-0 items-center rounded-full border px-2.5 text-[12px] font-semibold">
      {kindGroups.find((group) => group.kind === kind)?.one ?? kind}
    </span>
  )
}

function StatusChip({ status }: { status: KnowledgeStatus }) {
  return (
    <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 text-[12px] font-semibold text-ink-200">
      <StatusDot status={status} />
      {statusLabels[status]}
    </span>
  )
}

/** Live GitHub states of a topic's issues and pull requests, read once per page and kept for the run. */
const refStates = new Map<string, Promise<string | null>>()

function useRefState(repo: string, ref: KnowledgeRef, listed: boolean): string | null {
  const number = refNumber(ref)
  const key = `${repo}\n${ref.kind}\n${number ?? ''}`
  const [state, setState] = useState<{ key: string; value: string | null } | null>(null)
  useEffect(() => {
    if (number === null || !listed) return
    let current = true
    let read = refStates.get(key)
    if (read === undefined) {
      read = (ref.kind === 'pr' ? api.githubPullRequest(repo, number) : api.githubIssue(repo, number)).then(
        (detail) => (detail.isDraft === true && detail.state.toLowerCase() === 'open' ? 'draft' : detail.state.toLowerCase()),
        () => null,
      )
      refStates.set(key, read)
    }
    read.then((value) => current && setState({ key, value }))
    return () => {
      current = false
    }
  }, [key, number, listed, repo, ref.kind])
  return (state?.key === key ? state.value : null) ?? ref.state?.toLowerCase() ?? null
}

function GithubRefIcon({ kind, state }: { kind: 'issue' | 'pr'; state: string | null }) {
  if (kind === 'issue') {
    const closed = state === 'closed'
    const Icon = closed ? ClosedIssueIcon : IssueIcon
    return (
      <span style={{ color: state === null ? undefined : closed ? stateColors.merged : stateColors.open }} className="shrink-0">
        <Icon size={13} />
      </span>
    )
  }
  const visual = state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : state === 'draft' ? 'draft' : 'open'
  const Icon = visual === 'merged' ? MergedIcon : visual === 'closed' ? ClosedPullRequestIcon : PullRequestIcon
  return (
    <span style={{ color: state === null ? undefined : stateColors[visual] }} className="shrink-0">
      <Icon size={13} />
    </span>
  )
}

const chip = 'inline-flex h-7 max-w-[280px] shrink-0 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 text-[12.5px] text-ink-200'

function RefChip({ repo, ref: entry, listed, onOpenGithub }: { repo: string; ref: KnowledgeRef; listed: boolean; onOpenGithub: (repo: string, kind: 'pr' | 'issue', number: number) => void }) {
  const state = useRefState(repo, entry, listed)
  const number = refNumber(entry)
  const label = refLabel(entry)
  const title = [label, entry.title, state === null ? null : `${state[0]?.toUpperCase() ?? ''}${state.slice(1)}`, entry.kind === 'commit' ? entry.id : null].filter((part) => part !== null && part !== undefined).join(' · ')
  const body = (
    <>
      {(entry.kind === 'issue' || entry.kind === 'pr') && <GithubRefIcon kind={entry.kind} state={state} />}
      <span className={`shrink-0 font-medium ${entry.kind === 'commit' || entry.kind === 'branch' ? 'font-mono text-[11.5px]' : ''}`}>{label}</span>
      {entry.title !== undefined && <span className="min-w-0 truncate text-ink-400">{entry.title}</span>}
    </>
  )
  // An issue or pull request opens in the app's GitHub view when the project is listed, else on GitHub.
  const open = (entry.kind === 'issue' || entry.kind === 'pr') && number !== null && listed ? () => onOpenGithub(repo, entry.kind === 'pr' ? 'pr' : 'issue', number) : entry.url !== undefined ? () => void api.openUrl(entry.url ?? '') : null
  if (open === null) {
    return (
      <span className={chip} title={title}>
        {body}
      </span>
    )
  }
  return (
    <button type="button" onClick={open} title={title} className={`${chip} transition-colors hover:border-white/[0.16] hover:bg-white/[0.07]`}>
      {body}
    </button>
  )
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-3">
        <h2 className="text-[11px] font-medium tracking-[0.04em] text-ink-400 uppercase">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

const prose = 'text-[14.5px] leading-relaxed text-ink-200'

function Decisions({ topic, now }: { topic: KnowledgeTopic; now: number }) {
  const [showSuperseded, setShowSuperseded] = useState(false)
  const { live, superseded } = decisionsOf(topic.decisions)
  if (live.length === 0 && superseded.length === 0) return null
  return (
    <Section title="Decisions">
      <ol className="space-y-2">
        {live.map((decision) => (
          <li key={decision.id} className="rounded-[16px] border border-white/[0.07] bg-white/[0.02] px-4 py-3">
            <MarkdownText text={decision.text} className="text-[14px] leading-snug font-medium text-ink-100" />
            <p className="mt-1 text-[13px] leading-relaxed text-ink-400">
              {decision.why} <span className="text-ink-500">· {relativeAge(decision.at, now)}</span>
            </p>
          </li>
        ))}
      </ol>
      {superseded.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowSuperseded((shown) => !shown)} aria-expanded={showSuperseded} className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink-400 transition-colors hover:text-ink-200">
            <Chevron open={showSuperseded} />
            {superseded.length === 1 ? '1 superseded decision' : `${superseded.length} superseded decisions`}
          </button>
          <Collapse open={showSuperseded}>
            <ol className="space-y-2 pt-2">
              {superseded.map(({ decision, by }) => (
                <li key={decision.id} className="rounded-[16px] border border-dashed border-white/[0.07] px-4 py-3 opacity-80">
                  <MarkdownText text={decision.text} className="text-[13.5px] leading-snug text-ink-300 line-through decoration-ink-500" />
                  <p className="mt-1 text-[12.5px] leading-relaxed text-ink-400">{decision.why}</p>
                  {by !== null && <p className="mt-1.5 text-[12.5px] text-ink-400">Replaced by: <span className="text-ink-200">{by.text.replace(/`/g, '')}</span></p>}
                </li>
              ))}
            </ol>
          </Collapse>
        </div>
      )}
    </Section>
  )
}

function KeyMessages({ topic, now, onOpenChat }: { topic: KnowledgeTopic; now: number; onOpenChat: (chatId: string) => void }) {
  if (topic.keyMessages.length === 0) return null
  const messages = [...topic.keyMessages].sort((left, right) => left.at.localeCompare(right.at))
  return (
    <Section title="Key messages">
      <ol className="relative space-y-4 border-l border-white/[0.08] pl-5">
        {messages.map((message) => (
          <li key={`${message.chatId}\n${message.eventCursor}`} className="relative">
            <span aria-hidden="true" className={`absolute top-[7px] -left-[24.5px] size-2 rounded-full ring-4 ring-ink-950 ${message.role === 'person' ? 'bg-accent' : 'bg-ink-400'}`} />
            <p className="text-[11.5px] font-medium tracking-[0.04em] text-ink-400 uppercase">
              {message.role === 'person' ? 'You' : 'Agent'} <span className="text-ink-500 normal-case">· {relativeAge(message.at, now)}</span>
            </p>
            <button type="button" onClick={() => onOpenChat(message.chatId)} title="Read this chat" className="mt-1 block w-full rounded-[10px] text-left text-[14px] leading-relaxed text-ink-100 transition-colors hover:text-accent">
              {message.text}
            </button>
            <p className="mt-0.5 text-[12.5px] text-ink-400">{message.why}</p>
          </li>
        ))}
      </ol>
    </Section>
  )
}

function ChatLine({ chat, now }: { chat: KnowledgeChat; now: number }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-400">
      <AgentIcon agent={chat.agent} size={12} className="shrink-0 text-ink-300" />
      <span className="truncate">{chat.model ?? chat.agent}</span>
      <span className="text-ink-500">·</span>
      <span className="truncate font-mono text-[11px]">{chat.branch}</span>
      <span className="text-ink-500">·</span>
      <span className="shrink-0 tabular-nums">{relativeAge(chat.endedAt ?? chat.startedAt, now)}</span>
    </span>
  )
}

function ChatCard({ chat, workers, now, onOpen }: { chat: KnowledgeChat; workers: KnowledgeChat[]; now: number; onOpen: (chat: KnowledgeChat) => void }) {
  const title = chat.title ?? chat.agent
  const last = chat.lastMessages.slice(-2)
  return (
    <li className="overflow-hidden rounded-[18px] border border-white/[0.07] bg-white/[0.02] transition-colors hover:border-white/[0.12]">
      <button type="button" onClick={() => onOpen(chat)} className="block w-full space-y-2 px-4 pt-3.5 pb-3 text-left transition-colors hover:bg-white/[0.03]">
        <span className="block truncate text-[14px] font-semibold text-ink-100">{title}</span>
        <ChatLine chat={chat} now={now} />
        <span className="line-clamp-3 block text-[13px] leading-relaxed text-ink-300">{chat.summary}</span>
        {last.length > 0 && (
          <span className="block space-y-1 border-t border-white/[0.06] pt-2">
            {last.map((message) => (
              <span key={`${message.at}\n${message.text}`} className="flex min-w-0 gap-2 text-[12.5px]">
                <span className={`shrink-0 font-medium ${message.role === 'person' ? 'text-accent' : 'text-ink-400'}`}>{message.role === 'person' ? 'You' : 'Agent'}</span>
                <span className="min-w-0 truncate text-ink-300">{message.text}</span>
              </span>
            ))}
          </span>
        )}
      </button>
      {workers.length > 0 && (
        <ul className="space-y-0.5 border-t border-white/[0.06] bg-white/[0.015] px-2 py-1.5" aria-label={`Workers of ${title}`}>
          {workers.map((worker) => (
            <li key={worker.id}>
              <button type="button" onClick={() => onOpen(worker)} title={worker.summary} className="flex h-8 w-full min-w-0 items-center gap-2 rounded-[10px] pr-2 pl-2 text-left text-[12.5px] text-ink-300 transition-colors hover:bg-row-hover hover:text-ink-100">
                <span aria-hidden="true" className="shrink-0 text-ink-500">↳</span>
                <AgentIcon agent={worker.agent} size={12} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{worker.title}</span>
                <span className="shrink-0 text-[11px] text-ink-400 tabular-nums">{relativeAge(worker.endedAt ?? worker.startedAt, now)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function TopicReading({
  id,
  repo,
  listed,
  now,
  onOpenGithub,
  onOpenChat,
  onOpenArtifact,
}: {
  id: string
  repo: string
  listed: Project | undefined
  now: number
  onOpenGithub: (repo: string, kind: 'pr' | 'issue', number: number) => void
  onOpenChat: (chatId: string) => void
  onOpenArtifact: (artifact: Artifact) => void
}) {
  const load = useRead(id, api.knowledgeTopic)
  if (load.state === 'loading') {
    return (
      <div className={column}>
        <TextSkeleton lines={8} />
      </div>
    )
  }
  if (load.state === 'failed') {
    return (
      <div className={column}>
        <ErrorNote error={load.error} />
      </div>
    )
  }
  const topic = load.value
  const refs = topic.refs.filter((ref) => ref.kind !== 'file')
  const files = topic.refs.filter((ref) => ref.kind === 'file')
  const cards = chatCards(topic.chatRecords)
  return (
    <div className={`${column} space-y-9`}>
      <header className="space-y-4">
        <h2 className="text-[28px] leading-tight font-semibold tracking-[-0.02em] text-ink-100">{topic.title}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <KindChip kind={topic.kind} />
          <StatusChip status={topic.status} />
          <span className="pl-1 text-[12.5px] text-ink-400" title={new Date(topic.updatedAt).toLocaleString()}>
            Updated {relativeAge(topic.updatedAt, now)} ago
          </span>
          {topic.aliases.length > 0 && <span className="truncate text-[12.5px] text-ink-500">· Also {topic.aliases.join(', ')}</span>}
        </div>
        {refs.length > 0 && (
          <div className="flex flex-wrap gap-2" aria-label="Refs">
            {refs.map((ref) => (
              <RefChip key={`${ref.kind}\n${ref.id}`} repo={repo} ref={ref} listed={listed !== undefined} onOpenGithub={onOpenGithub} />
            ))}
          </div>
        )}
      </header>
      {topic.sections.overview.trim() !== '' && <MarkdownText text={topic.sections.overview} className={`${prose} text-[15px]`} />}
      <ArtifactStrip topic={topic.id} onOpen={onOpenArtifact} />
      {topic.sections.state.trim() !== '' && (
        <Section title="Where it stands">
          <MarkdownText text={topic.sections.state} className={prose} />
        </Section>
      )}
      <Decisions topic={topic} now={now} />
      {topic.sections.pitfalls.trim() !== '' && (
        <Section title="Pitfalls">
          <MarkdownText text={topic.sections.pitfalls} className={prose} />
        </Section>
      )}
      {topic.sections.open.trim() !== '' && (
        <Section title="Open">
          <MarkdownText text={topic.sections.open} className={prose} />
        </Section>
      )}
      <KeyMessages topic={topic} now={now} onOpenChat={onOpenChat} />
      {cards.length > 0 && (
        <Section title="Chats" aside={<span className="text-[12px] text-ink-500 tabular-nums">{topic.chatRecords.length}</span>}>
          <ul className="grid gap-3 sm:grid-cols-2">
            {cards.map((card) => (
              <ChatCard key={card.chat.id} chat={card.chat} workers={card.workers} now={now} onOpen={(chat) => onOpenChat(chat.id)} />
            ))}
          </ul>
        </Section>
      )}
      {files.length > 0 && (
        <Section title="Files">
          <div className="flex flex-wrap gap-1.5">
            {files.map((file) => (
              <span key={file.id} title={file.id} className="inline-flex h-6 max-w-full items-center truncate rounded-[8px] bg-white/[0.04] px-2 font-mono text-[11.5px] text-ink-300">
                {file.id}
              </span>
            ))}
          </div>
        </Section>
      )}
    </div>
  )
}

/** The reading column with nothing to read: why, and what to do about it. */
export function Blank({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={`${column} pt-24 text-center`}>
      <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink-100">{title}</h1>
      <p className="mx-auto mt-2 max-w-[420px] text-[13.5px] leading-relaxed text-ink-400">{children}</p>
    </div>
  )
}

function SettingsLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="font-medium text-accent hover:underline">
      {children}
    </button>
  )
}

function ProjectSwitcher({ current, listed, projects, isOn, onPick }: { current: KnowledgeProject; listed: Project | undefined; projects: KnowledgeProject[]; isOn: (project: KnowledgeProject) => boolean; onPick: (repo: string) => void }) {
  const { menu, open, close } = useContextMenu()
  return (
    <>
      <button
        type="button"
        onClick={(event) => open(event, [projects.map((project) => ({ label: isOn(project) ? project.project : `${project.project} (off)`, title: project.repo, onSelect: () => onPick(project.repo) }))])}
        aria-haspopup="menu"
        title={`${current.project}\n${current.repo}`}
        className="flex h-[30px] max-w-[240px] min-w-0 shrink-0 items-center gap-2 rounded-full pr-2 pl-[3px] text-left transition-colors select-none hover:bg-white/[0.08]"
      >
        <KnowledgePicture project={listed} name={current.project} />
        <span className="min-w-0 truncate text-[13px] font-semibold tracking-[-0.01em] text-ink-200 @max-[520px]/header:hidden">{listed === undefined ? current.project : displayName(listed)}</span>
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-ink-400">
          <path d="m5 6.5 3-3 3 3M5 9.5l3 3 3-3" />
        </svg>
      </button>
      <ContextMenu menu={menu} onClose={close} />
    </>
  )
}

export function KnowledgePage({
  view,
  projects,
  onView,
  onOpenGithub,
  onOpenArtifact,
  onOpenSettings,
}: {
  /** What the page shows, from its item's id (knowledge-model.ts). */
  view: KnowledgeView
  /** The listed projects, for their pictures and whether GitHub views can open. */
  projects: Project[]
  /** Shows something else on this page. */
  onView: (view: KnowledgeView) => void
  /** Opens an issue or pull request in the app's GitHub view. */
  onOpenGithub: (repo: string, kind: 'pr' | 'issue', number: number) => void
  /** Opens an artifact on the Artifacts page. */
  onOpenArtifact: (artifact: Artifact) => void
  /** Opens Settings on its Knowledge page, at a project's row when given. */
  onOpenSettings: (repo: string | null) => void
}) {
  const now = useNow(30_000)
  const [query, setQuery] = useState(memory.query)
  const [folded, setFolded] = useState<ReadonlySet<KnowledgeKind>>(memory.folded)
  useEffect(() => {
    memory.query = query
    memory.folded = folded
  }, [query, folded])
  const toggle = (kind: KnowledgeKind) =>
    setFolded((current) => {
      const next = new Set(current)
      if (!next.delete(kind)) next.add(kind)
      return next
    })
  const { list, settings, error: listError } = useKnowledgeList()
  const project = list === null ? null : pickProject(list.projects, view.repo)
  const { results, error: searchError } = useTopicSearch(project?.repo ?? null, query)
  const error = listError ?? searchError
  const listed = useMemo(() => new Map(projects.map((entry) => [entry.path, entry])), [projects])
  /** A project's name as the sidebar shows it. */
  const nameOf = (entry: KnowledgeProject) => {
    const known = listed.get(entry.repo)
    return known === undefined ? entry.project : displayName(known)
  }
  const searching = query.trim() !== ''
  const topics = project?.topics ?? []
  const shown = searching ? (results === null ? null : groupTopics(results)) : groupTopics(topics)
  const selectedId = view.topic ?? groupTopics(topics)[0]?.topics[0]?.id ?? null
  // A project is read when its summaries are on; the settings say so, else the list does.
  const projectOn = (entry: KnowledgeProject) => (settings === null ? entry.enabled : inEffect(effectiveToggles(settings, entry.repo), 'summaries'))
  const off = list !== null && list.projects.length > 0 && !list.projects.some(projectOn)
  const on = project !== null && projectOn(project)
  const pickTopic = (topic: KnowledgeTopicSummary) => onView({ repo: project?.repo ?? null, topic: topic.id, chat: null, map: false })
  const pickProjectRepo = (repo: string) => {
    setQuery('')
    onView({ repo, topic: null, chat: null, map: false })
  }

  const reading = (): ReactNode => {
    if (off) {
      return (
        <Blank title="Knowledge is off">
          No project’s chats are being read. <SettingsLink onClick={() => onOpenSettings(null)}>Turn summaries on in Settings</SettingsLink> and what each project’s chats build, decide and leave open gathers here as topics.
        </Blank>
      )
    }
    if (list !== null && list.projects.length === 0) return <Blank title="No projects yet">Add a project and its chats are written up here, topic by topic.</Blank>
    if (project === null) {
      return <div className={column}>{error === null ? <TextSkeleton lines={8} /> : <ErrorNote error={error} />}</div>
    }
    if (!on) {
      return (
        <Blank title={`Knowledge is off for ${nameOf(project)}`}>
          Its chats are never read or sent to a model. <SettingsLink onClick={() => onOpenSettings(project.repo)}>Turn its summaries on in Settings</SettingsLink> to gather its topics here.
        </Blank>
      )
    }
    if (view.map) return <KnowledgeMap project={nameOf(project)} topics={topics} selectedId={view.topic} onPick={pickTopic} />
    if (view.chat !== null) {
      const topic = topics.find((entry) => entry.id === view.topic)
      return <ChatTranscript key={view.chat} chatId={view.chat} backLabel={topic?.title ?? 'Back to the topic'} onBack={() => onView({ ...view, chat: null })} />
    }
    if (selectedId === null) return <Blank title="No topics yet">As chats in {nameOf(project)} work, megabrain files what they build and decide under topics. They gather here by kind.</Blank>
    return <TopicReading key={selectedId} id={selectedId} repo={project.repo} listed={listed.get(project.repo)} now={now} onOpenGithub={onOpenGithub} onOpenChat={(chat) => onView({ repo: project.repo, topic: selectedId, chat, map: false })} onOpenArtifact={onOpenArtifact} />
  }

  const topicTitle = selectedId === null ? null : (topics.find((topic) => topic.id === selectedId)?.title ?? null)
  const crumb =
    project !== null && list !== null ? (
      <ProjectSwitcher current={project} listed={listed.get(project.repo)} projects={list.projects} isOn={projectOn} onPick={pickProjectRepo} />
    ) : (
      <span className="flex min-w-0 items-center gap-2 text-ink-300">
        <span className="grid size-6 shrink-0 place-items-center">
          <KnowledgeIcon />
        </span>
        <h1 className="truncate text-[14px] leading-5 font-semibold tracking-[-0.01em] text-ink-100">Knowledge</h1>
      </span>
    )
  const shownCount = shown?.reduce((sum, group) => sum + group.topics.length, 0) ?? null

  return (
    <WikiShell
      keys={wikiPanels.knowledge}
      crumb={crumb}
      title={project === null ? null : pageTitle(view, nameOf(project), topicTitle)}
      tools={
        project !== null && (
          <>
            <BarSearch value={query} onChange={setQuery} label="Search topics" disabled={!on} />
            <button type="button" onClick={() => onView({ repo: project.repo, topic: view.topic, chat: null, map: !view.map })} disabled={!on} aria-pressed={view.map} title={view.map ? 'Close the map' : 'Map of the project’s topics'} className={`${barToggle(view.map)} px-2.5`}>
              <KnowledgeIcon />
              Map
            </button>
          </>
        )
      }
      panelLabel={on ? 'Topics' : null}
      panelCount={shownCount}
      panel={
        <>
          {searching && shown?.length === 0 && <p className="px-2.5 py-1 text-[12.5px] text-ink-400">No topic matches “{query.trim()}”.</p>}
          {shown?.map((group) => (
            <NavKind key={group.kind} label={group.label} kind={group.kind} topics={group.topics} open={searching || !folded.has(group.kind)} onToggle={toggle} selectedId={selectedId} now={now} onPick={pickTopic} />
          ))}
        </>
      }
    >
      <article className={`h-full min-w-0 ${view.map ? 'overflow-hidden' : 'overflow-y-auto'}`}>{reading()}</article>
    </WikiShell>
  )
}
