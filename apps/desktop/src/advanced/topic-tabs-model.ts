import type { KnowledgeRef, KnowledgeTopic } from '@/api/schema'
import { refNumber } from '@/advanced/knowledge-model'
import type { WidthStorage } from '@/lib/panel-width'
import { rememberedTabs } from '@/lib/remembered-tabs'

// A topic's page in tabs: what is understood (Overview), the conversation that built it (Messages),
// its issues and pull requests, its branches with their commits, and its files. A tab with nothing to
// show is left out, and each topic remembers the tab last shown on it.

export type TopicTab = 'overview' | 'messages' | 'refs' | 'branches' | 'files'

const tabOrder: { tab: TopicTab; label: string }[] = [
  { tab: 'overview', label: 'Overview' },
  { tab: 'messages', label: 'Messages' },
  { tab: 'refs', label: 'Issues and PRs' },
  { tab: 'branches', label: 'Branches' },
  { tab: 'files', label: 'Files' },
]

/** A ref named twice is one ref. */
function unique(refs: readonly KnowledgeRef[]): KnowledgeRef[] {
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = `${ref.kind}\n${ref.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const ofKind = (refs: readonly KnowledgeRef[], ...kinds: KnowledgeRef['kind'][]) => unique(refs.filter((ref) => kinds.includes(ref.kind)))

/**
 * The tabs a topic shows, in their fixed order: the overview always, the others when they have
 * something. Issues and PRs, Branches and Files count what they list; Branches counts its branches,
 * or its commits when there is no branch.
 */
export function topicTabs(topic: Pick<KnowledgeTopic, 'refs' | 'keyMessages' | 'chatRecords'>): { tab: TopicTab; label: string; count: number | null }[] {
  const github = ofKind(topic.refs, 'issue', 'pr').length
  const branches = ofKind(topic.refs, 'branch').length
  const commits = ofKind(topic.refs, 'commit').length
  const files = ofKind(topic.refs, 'file').length
  const counts: Record<TopicTab, number | null> = {
    overview: null,
    messages: topic.keyMessages.length + topic.chatRecords.length > 0 ? null : 0,
    refs: github,
    branches: branches > 0 ? branches : commits,
    files,
  }
  return tabOrder.filter(({ tab }) => counts[tab] !== 0).map(({ tab, label }) => ({ tab, label, count: counts[tab] }))
}

/** The tab chosen, when the topic has it; else the overview. */
export function shownTopicTab(tabs: readonly { tab: TopicTab }[], chosen: TopicTab | null): TopicTab {
  return chosen !== null && tabs.some((entry) => entry.tab === chosen) ? chosen : 'overview'
}

export interface GithubRefRow {
  ref: KnowledgeRef
  kind: 'issue' | 'pr'
  number: number | null
  /** Lower case: open, draft, closed, merged; null when unknown. */
  state: string | null
}

const isClosed = (state: string | null) => state === 'closed' || state === 'merged'

const newestNumber = (left: GithubRefRow, right: GithubRefRow) => (right.number ?? -1) - (left.number ?? -1)

/** A topic's issues and pull requests, the open ones (a draft or an unknown state included) first, each group newest number first. */
export function githubRefGroups(refs: readonly KnowledgeRef[], stateOf: (ref: KnowledgeRef) => string | null): { open: GithubRefRow[]; closed: GithubRefRow[] } {
  const rows = ofKind(refs, 'issue', 'pr').map((ref): GithubRefRow => ({ ref, kind: ref.kind === 'pr' ? 'pr' : 'issue', number: refNumber(ref), state: stateOf(ref)?.toLowerCase() ?? null }))
  return { open: rows.filter((row) => !isClosed(row.state)).sort(newestNumber), closed: rows.filter((row) => isClosed(row.state)).sort(newestNumber) }
}

/** One sha names another when either starts with the other: chats often cite a short sha. */
const sameCommit = (left: string, right: string) => left.startsWith(right) || right.startsWith(left)

/**
 * A topic's branches, each with its state (lower case, when known) and the commits a chat on that
 * branch cited; the commits no branch of the topic claims are listed on their own.
 */
export function branchGroups(topic: Pick<KnowledgeTopic, 'refs' | 'chatRecords'>): { branches: { ref: KnowledgeRef; state: string | null; commits: KnowledgeRef[] }[]; commits: KnowledgeRef[] } {
  const commits = ofKind(topic.refs, 'commit')
  const claimed = new Set<KnowledgeRef>()
  const branches = ofKind(topic.refs, 'branch').map((ref) => {
    const cited = topic.chatRecords.filter((chat) => chat.branch === ref.id).flatMap((chat) => chat.refs.filter((entry) => entry.kind === 'commit'))
    const own = commits.filter((commit) => !claimed.has(commit) && cited.some((entry) => sameCommit(entry.id, commit.id)))
    for (const commit of own) claimed.add(commit)
    return { ref, state: ref.state?.toLowerCase() ?? null, commits: own }
  })
  return { branches, commits: commits.filter((commit) => !claimed.has(commit)) }
}

/** Where every topic's last tab is kept: [topic id, tab] pairs, the one picked last at the end. */
export const topicTabsKey = 'megabrain.knowledge.topic.tabs'

const remembered = rememberedTabs<TopicTab>(topicTabsKey, tabOrder.map((entry) => entry.tab))

export const readTopicTab: (storage: () => WidthStorage, topic: string) => TopicTab | null = remembered.read

export const writeTopicTab: (storage: () => WidthStorage, topic: string, tab: TopicTab) => TopicTab = remembered.write
