import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '@/api'
import type { Artifact, KnowledgeChat, KnowledgeKind, KnowledgeList, KnowledgeRef, KnowledgeStatus, KnowledgeTopic, KnowledgeTopicSummary, Project } from '@/api/schema'
import { ArtifactStrip } from '@/advanced/ArtifactStrip'
import { column, useRead } from '@/advanced/knowledge-parts'
import { ChatTranscript } from '@/advanced/KnowledgeTranscript'
import { BranchIcon, Chevron, KnowledgeIcon } from '@/advanced/chrome'
import { KnowledgeMap } from '@/advanced/KnowledgeMap'
import { BarSearch, WikiShell, barToggle } from '@/advanced/WikiShell'
import { Blank, ProjectSwitcher, Section, SectionCount, listBox } from '@/advanced/WikiParts'
import { wikiPanels } from '@/advanced/wiki-shell-model'
import { chatCards, decisionsOf, groupTopics, kindColors, kindGroups, refLabel, refNumber, settleTopicSearch, shownTopicSearch, statusLabels, type KnowledgeView, type TopicSearch } from '@/advanced/knowledge-model'
import { branchGroups, githubRefGroups, readTopicTab, shownTopicTab, topicTabs, writeTopicTab, type GithubRefRow as GithubRefRowData, type TopicTab } from '@/advanced/topic-tabs-model'
import { displayName } from '@/advanced/appearance-model'
import { emptyTopicFilters, filterTopics, topicSheetFields, type TopicFilters } from '@/advanced/page-filters'
import { activeCount } from '@/components/filter-sheet-model'
import { FilterButton, FilterChips, FilterPanel } from '@/components/Filters'
import { useSheet } from '@/components/Sheet'
import { relativeAge } from '@/advanced/projects-model'
import { MarkdownText } from '@/chat/markdown'
import { AgentIcon } from '@/components/agent-icons'
import { Collapse } from '@/components/Collapse'
import { SegmentedTabs } from '@/components/SegmentedTabs'
import { TextSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { useNow } from '@/github/parts'
import { stateColors } from '@/github/github-model'
import { ClosedIssueIcon, ClosedPullRequestIcon, IssueIcon, MergedIcon, PullRequestIcon } from '@/github/icons'
import { projectsPolicy } from '@/lib/poll-model'
import { sidePanelGroup, sidePanelNote, sidePanelRow, sidePanelSlot, sidePanelTrailing } from '@/lib/side-panel'
import { usePoll } from '@/lib/usePoll'
import { effectiveToggles, inEffect, parseKnowledgeSettings, type KnowledgeSettings } from '@/settings/knowledge-model'

// The Knowledge page, a wiki of one project's topics in one pane (WikiShell): the topics by kind in a
// panel on the right, and beside it a top bar with the project switcher, a search and the map's
// toggle over the picked topic in a reading column. The topic reads in tabs (topic-tabs-model.ts):
// its kind, status, sections and decisions; its key messages and chats; its issues and pull
// requests; its branches and commits; its files. The item's id is what the page shows
// (knowledge-model.ts); with no topic picked it shows the project's newest.

type KnowledgeProject = KnowledgeList['projects'][number]

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
const memory: { list: KnowledgeList | null; settings: KnowledgeSettings | null; query: string; folded: ReadonlySet<KnowledgeKind>; filters: TopicFilters } = { list: null, settings: null, query: '', folded: new Set(), filters: emptyTopicFilters }

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
  const [search, setSearch] = useState<TopicSearch<KnowledgeTopicSummary> | null>(null)
  const text = query.trim()
  const key = `${repo ?? ''}\n${text}`
  useEffect(() => {
    if (text === '' || repo === null) return
    let current = true
    const timer = setTimeout(() => {
      api.searchKnowledge(text, repo).then(
        (next) => current && setSearch((last) => settleTopicSearch(last, { key, ok: true, results: next.results })),
        (caught: unknown) => current && setSearch((last) => settleTopicSearch(last, { key, ok: false, error: caught })),
      )
    }, 250)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [text, repo, key])
  return shownTopicSearch(search, key)
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
      className={sidePanelRow(selected)}
    >
      <span aria-hidden="true" className={sidePanelSlot} />
      <span className={sidePanelSlot}>
        <StatusDot status={topic.status} />
      </span>
      <span className={`min-w-0 flex-1 truncate ${topic.status === 'dropped' ? 'text-ink-400' : ''}`}>{topic.title}</span>
      <span className={sidePanelTrailing}>{relativeAge(topic.updatedAt, now)}</span>
    </button>
  )
}

function NavKind({ label, kind, topics, open, onToggle, selectedId, now, onPick }: { label: string; kind: KnowledgeKind; topics: KnowledgeTopicSummary[]; open: boolean; onToggle: (kind: KnowledgeKind) => void; selectedId: string | null; now: number; onPick: (topic: KnowledgeTopicSummary) => void }) {
  return (
    <section>
      {/* A section header: its mark and name, its count and chevron at the right. */}
      <button type="button" onClick={() => onToggle(kind)} aria-expanded={open} className={sidePanelGroup}>
        <span className={sidePanelSlot}>
          <span style={{ backgroundColor: kindColors[kind] }} aria-hidden="true" className="size-2 rounded-[3px]" />
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 text-[11px] font-medium tabular-nums">{topics.length}</span>
        <span className={sidePanelSlot}>
          <Chevron open={open} />
        </span>
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

const refStateKey = (repo: string, ref: KnowledgeRef) => `${repo}\n${ref.kind}\n${refNumber(ref) ?? ''}`

/** Each issue's and pull request's live state (draft for an open draft), else the state the topic recorded. */
function useRefStates(repo: string, refs: readonly KnowledgeRef[], listed: boolean): (ref: KnowledgeRef) => string | null {
  const [states, setStates] = useState<ReadonlyMap<string, string | null>>(new Map())
  const wanted = refs.filter((ref) => (ref.kind === 'issue' || ref.kind === 'pr') && refNumber(ref) !== null)
  const keys = wanted.map((ref) => refStateKey(repo, ref)).join('\t')
  useEffect(() => {
    if (!listed) return
    let current = true
    for (const ref of wanted) {
      const number = refNumber(ref)
      if (number === null) continue
      const key = refStateKey(repo, ref)
      let read = refStates.get(key)
      if (read === undefined) {
        read = (ref.kind === 'pr' ? api.githubPullRequest(repo, number) : api.githubIssue(repo, number)).then(
          (detail) => (detail.isDraft === true && detail.state.toLowerCase() === 'open' ? 'draft' : detail.state.toLowerCase()),
          () => null,
        )
        refStates.set(key, read)
      }
      read.then((value) => current && setStates((known) => new Map(known).set(key, value)))
    }
    return () => {
      current = false
    }
    // The refs are named by their keys; a new array with the same refs reads nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, listed, repo])
  return (ref) => states.get(refStateKey(repo, ref)) ?? ref.state?.toLowerCase() ?? null
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

const stateLabel = (state: string) => `${state[0]?.toUpperCase() ?? ''}${state.slice(1)}`

/** An issue's or pull request's state in GitHub's colour for it. */
function stateTone(kind: 'issue' | 'pr', state: string | null): string | undefined {
  if (state === null) return undefined
  if (kind === 'issue') return state === 'closed' ? stateColors.merged : stateColors.open
  return state === 'merged' || state === 'closed' || state === 'draft' ? stateColors[state] : stateColors.open
}

const row = 'grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-3.5 px-5 py-3.5 text-left'

function GithubRefRow({ row: entry, repo, listed, onOpenGithub }: { row: GithubRefRowData; repo: string; listed: boolean; onOpenGithub: (repo: string, kind: 'pr' | 'issue', number: number) => void }) {
  const { ref, kind, number, state } = entry
  const label = refLabel(ref)
  const noun = `${kind === 'pr' ? 'Pull request' : 'Issue'} ${number === null ? ref.id : `#${number}`}`
  const body = (
    <>
      <span className="pt-0.5">
        <GithubRefIcon kind={kind} state={state} />
      </span>
      <span className="min-w-0 space-y-1">
        <span className="block truncate text-[14px] leading-snug font-semibold text-ink-100">{ref.title ?? noun}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-400">
          {/* Untitled, the row's title already says what and which; the line keeps only its state. */}
          {ref.title !== undefined && (
            <>
              <span className="shrink-0 tabular-nums">{number === null ? ref.id : `#${number}`}</span>
              <span className="text-ink-600">·</span>
              <span className="shrink-0">{kind === 'pr' ? 'Pull request' : 'Issue'}</span>
            </>
          )}
          {ref.title === undefined && state === null && <span className="shrink-0">State unknown</span>}
          {state !== null && (
            <>
              {ref.title !== undefined && <span className="text-ink-600">·</span>}
              <span style={{ color: stateTone(kind, state) }} className="shrink-0 font-medium">
                {stateLabel(state)}
              </span>
            </>
          )}
        </span>
      </span>
    </>
  )
  // An issue or pull request opens in the app's GitHub view when the project is listed, else on GitHub.
  const open = number !== null && listed ? () => onOpenGithub(repo, kind, number) : ref.url !== undefined ? () => void api.openUrl(ref.url ?? '') : null
  if (open === null) return <div className={row}>{body}</div>
  return (
    <button type="button" onClick={open} title={[label, ref.title].filter((part) => part !== undefined).join(' · ')} className={`${row} transition-colors duration-[var(--motion-enter)] hover:bg-white/[0.03]`}>
      {body}
    </button>
  )
}

function GithubRefs({ topic, repo, listed, onOpenGithub }: { topic: KnowledgeTopic; repo: string; listed: boolean; onOpenGithub: (repo: string, kind: 'pr' | 'issue', number: number) => void }) {
  const stateOf = useRefStates(repo, topic.refs, listed)
  const { open, closed } = githubRefGroups(topic.refs, stateOf)
  const group = (title: string, rows: GithubRefRowData[]) =>
    rows.length > 0 && (
      <Section title={title} aside={<SectionCount count={rows.length} />}>
        <ul className={listBox}>
          {rows.map((entry) => (
            <li key={`${entry.ref.kind}\n${entry.ref.id}`}>
              <GithubRefRow row={entry} repo={repo} listed={listed} onOpenGithub={onOpenGithub} />
            </li>
          ))}
        </ul>
      </Section>
    )
  return (
    <>
      {group('Open', open)}
      {group('Closed and merged', closed)}
    </>
  )
}

/** What a branch's recorded state says, in words. */
const branchStates: Record<string, string> = { merged: 'Merged', open: 'Open PR', pr: 'Open PR', gone: 'Gone', deleted: 'Gone' }

function CommitLine({ commit }: { commit: KnowledgeRef }) {
  return (
    <span title={commit.id} className="flex min-w-0 items-baseline gap-2.5 text-[13px]">
      <span className="shrink-0 font-mono text-[11.5px] text-ink-400">{refLabel(commit)}</span>
      <span className="min-w-0 truncate text-ink-300">{commit.title ?? ''}</span>
    </span>
  )
}

function Branches({ topic }: { topic: KnowledgeTopic }) {
  const { branches, commits } = branchGroups(topic)
  return (
    <>
      {branches.length > 0 && (
        <Section title="Branches" aside={<SectionCount count={branches.length} />}>
          <ul className={listBox}>
            {branches.map(({ ref, state, commits: own }) => (
              <li key={ref.id} className="space-y-2 px-5 py-3.5">
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="shrink-0 text-ink-400">
                    <BranchIcon />
                  </span>
                  <span title={ref.id} className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink-100">
                    {ref.id}
                  </span>
                  {state !== null && (
                    <span style={{ color: state === 'merged' ? stateColors.merged : state === 'open' || state === 'pr' ? stateColors.open : undefined }} className="shrink-0 text-[12px] font-medium text-ink-400">
                      {branchStates[state] ?? stateLabel(state)}
                    </span>
                  )}
                </span>
                {own.length > 0 && (
                  <ul className="ml-[6px] space-y-1 border-l border-white/[0.08] pl-4" aria-label={`Commits on ${ref.id}`}>
                    {own.map((commit) => (
                      <li key={commit.id}>
                        <CommitLine commit={commit} />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {commits.length > 0 && (
        <Section title="Commits" aside={<SectionCount count={commits.length} />}>
          <ul className={`${listBox} py-1.5`}>
            {commits.map((commit) => (
              <li key={commit.id} className="px-5 py-2">
                <CommitLine commit={commit} />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  )
}

function Files({ topic }: { topic: KnowledgeTopic }) {
  const files = [...new Set(topic.refs.filter((ref) => ref.kind === 'file').map((ref) => ref.id))].sort()
  return (
    <ul className={`${listBox} py-1.5`}>
      {files.map((file) => {
        const slash = file.lastIndexOf('/')
        return (
          <li key={file} title={file} className="flex min-w-0 items-baseline gap-2 px-5 py-2 font-mono text-[12.5px]">
            <span className="shrink-0 text-ink-100">{file.slice(slash + 1)}</span>
            {slash > 0 && <span className="min-w-0 truncate text-ink-500">{file.slice(0, slash)}</span>}
          </li>
        )
      })}
    </ul>
  )
}

const browserStorage = () => localStorage

function TopicTabs({
  topic,
  repo,
  listed,
  now,
  onOpenGithub,
  onOpenChat,
  onOpenArtifact,
}: {
  topic: KnowledgeTopic
  repo: string
  listed: Project | undefined
  now: number
  onOpenGithub: (repo: string, kind: 'pr' | 'issue', number: number) => void
  onOpenChat: (chatId: string) => void
  onOpenArtifact: (artifact: Artifact) => void
}) {
  const [chosen, setChosen] = useState<TopicTab | null>(() => readTopicTab(browserStorage, topic.id))
  const tabs = topicTabs(topic)
  const shown = shownTopicTab(tabs, chosen)
  const segments = tabs.map(({ tab, label, count }) => ({ view: tab, label, enabled: true, title: label, badge: count === null ? null : String(count) }))
  const cards = chatCards(topic.chatRecords)
  return (
    <div className={`${column} space-y-8`}>
      <header className="space-y-5">
        <h2 className="text-[28px] leading-tight font-semibold tracking-[-0.02em] text-ink-100">{topic.title}</h2>
        {tabs.length > 1 && <SegmentedTabs label="Topic" segments={segments} shown={shown} onSelect={(tab) => setChosen(writeTopicTab(browserStorage, topic.id, tab))} />}
      </header>
      {shown === 'overview' && (
        <div role="tabpanel" aria-label="Overview" className="space-y-9">
          <div className="flex flex-wrap items-center gap-2">
            <KindChip kind={topic.kind} />
            <StatusChip status={topic.status} />
            <span className="pl-1 text-[12.5px] text-ink-400" title={new Date(topic.updatedAt).toLocaleString()}>
              Updated {relativeAge(topic.updatedAt, now)} ago
            </span>
            {topic.aliases.length > 0 && <span className="truncate text-[12.5px] text-ink-500">· Also {topic.aliases.join(', ')}</span>}
          </div>
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
        </div>
      )}
      {shown === 'messages' && (
        <div role="tabpanel" aria-label="Messages" className="space-y-9">
          <KeyMessages topic={topic} now={now} onOpenChat={onOpenChat} />
          {cards.length > 0 && (
            <Section title="Chats" aside={<SectionCount count={topic.chatRecords.length} />}>
              <ul className="grid gap-3 sm:grid-cols-2">
                {cards.map((card) => (
                  <ChatCard key={card.chat.id} chat={card.chat} workers={card.workers} now={now} onOpen={(chat) => onOpenChat(chat.id)} />
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
      {shown === 'refs' && (
        <div role="tabpanel" aria-label="Issues and PRs" className="space-y-9">
          <GithubRefs topic={topic} repo={repo} listed={listed !== undefined} onOpenGithub={onOpenGithub} />
        </div>
      )}
      {shown === 'branches' && (
        <div role="tabpanel" aria-label="Branches" className="space-y-9">
          <Branches topic={topic} />
        </div>
      )}
      {shown === 'files' && (
        <div role="tabpanel" aria-label="Files">
          <Files topic={topic} />
        </div>
      )}
    </div>
  )
}

function TopicReading({
  id,
  ...rest
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
  return <TopicTabs topic={load.value} {...rest} />
}

function SettingsLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="font-medium text-accent hover:underline">
      {children}
    </button>
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
  const [filters, setFilters] = useState(memory.filters)
  const sheet = useSheet('knowledge.filters')
  const sheetFields = topicSheetFields(filters, (patch) => setFilters((current) => ({ ...current, ...patch })))
  useEffect(() => {
    memory.query = query
    memory.folded = folded
    memory.filters = filters
  }, [query, folded, filters])
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
  const topics = filterTopics(project?.topics ?? [], filters, now)
  const shown = searching ? (results === null ? null : groupTopics(filterTopics(results, filters, now))) : groupTopics(topics)
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

  const crumb =
    project !== null && list !== null ? (
      <ProjectSwitcher
        current={{ name: project.project, path: project.repo, listed: listed.get(project.repo) }}
        options={list.projects.map((entry) => ({ name: entry.project, path: entry.repo, listed: listed.get(entry.repo), ...(projectOn(entry) ? {} : { note: 'off' }), onSelect: () => pickProjectRepo(entry.repo) }))}
      />
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
      tools={
        project !== null && (
          <>
            <BarSearch value={query} onChange={setQuery} label="Search topics" disabled={!on} />
            <button type="button" onClick={() => onView({ repo: project.repo, topic: view.topic, chat: null, map: !view.map })} disabled={!on} aria-pressed={view.map} title={view.map ? 'Close the map' : 'Map of the project’s topics'} className={`${barToggle(view.map)} px-2.5 @max-[420px]/header:px-[6px]`}>
              <KnowledgeIcon />
              {/* A narrow bar keeps the icon alone; its title still names it. */}
              <span className="@max-[420px]/header:hidden">Map</span>
            </button>
            {on && <FilterButton fields={sheetFields} sheet={sheet} place="bar" />}
          </>
        )
      }
      panelLabel={on ? 'Topics' : null}
      panelCount={shownCount}
      sheet={<FilterPanel sheet={sheet} fields={sheetFields} />}
      panel={
        <>
          <FilterChips fields={sheetFields} className="px-1 pb-2" />
          {shown?.length === 0 && (searching || activeCount(sheetFields) > 0) && <p className={sidePanelNote}>{searching ? `No topic matches “${query.trim()}”.` : 'No topic matches the filters.'}</p>}
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
