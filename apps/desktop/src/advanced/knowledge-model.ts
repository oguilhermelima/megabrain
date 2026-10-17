import type { KnowledgeChat, KnowledgeDecision, KnowledgeKind, KnowledgeRef, KnowledgeStatus, KnowledgeTopicSummary } from '@/api/schema'
import { itemKey, parseItem } from '@/panes/pane-model'

// The Knowledge page: each project's topics grouped by kind, a topic's decisions and chats, the map of
// how topics connect, and the page's place in the layout. The page is one item, keyed by what it shows.

export const kindGroups: { kind: KnowledgeKind; label: string; one: string }[] = [
  { kind: 'feat', label: 'Features', one: 'Feature' },
  { kind: 'fix', label: 'Fixes', one: 'Fix' },
  { kind: 'refactor', label: 'Refactors', one: 'Refactor' },
  { kind: 'decision', label: 'Decisions', one: 'Decision' },
  { kind: 'investigation', label: 'Investigations', one: 'Investigation' },
]

/** Each kind's colour, on chips and on the map: the app's accent and tones, and a sky blue for investigations. */
export const kindColors: Record<KnowledgeKind, string> = { feat: '#8e9cff', fix: '#fb7185', refactor: '#34d399', decision: '#fbbf24', investigation: '#5fc7ef' }

export const statusLabels: Record<KnowledgeStatus, string> = { active: 'Active', shipped: 'Shipped', dropped: 'Dropped' }

const newestFirst = (left: KnowledgeTopicSummary, right: KnowledgeTopicSummary) => right.updatedAt.localeCompare(left.updatedAt)

/** Topics by kind in the fixed order, each kind newest first; a kind with no topic is left out. */
export function groupTopics<T extends KnowledgeTopicSummary>(topics: readonly T[]): { kind: KnowledgeKind; label: string; topics: T[] }[] {
  const sorted = [...topics].sort(newestFirst)
  return kindGroups.map(({ kind, label }) => ({ kind, label, topics: sorted.filter((topic) => topic.kind === kind) })).filter((group) => group.topics.length > 0)
}

/** Topics whose title, aliases, overview or refs hold every word, best first. */
export function searchTopics<T extends KnowledgeTopicSummary>(topics: readonly T[], text: string): T[] {
  const words = text.toLowerCase().split(/\s+/).filter((word) => word !== '')
  if (words.length === 0) return []
  const scored = topics.map((topic) => {
    const fields = [topic.title, ...topic.aliases, topic.overview, ...topic.refs.flatMap((ref) => [ref.id, ref.title ?? ''])].map((field) => field.toLowerCase())
    const hits = words.map((word) => fields.reduce((count, field) => count + field.split(word).length - 1, 0))
    return { topic, all: hits.every((count) => count > 0), score: hits.reduce((sum, count) => sum + count, 0) }
  })
  return scored
    .filter((entry) => entry.all)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.topic)
}

/** The decisions in force, in the order taken, and the superseded ones each with the decision that replaced it. */
export function decisionsOf(decisions: readonly KnowledgeDecision[]): { live: KnowledgeDecision[]; superseded: { decision: KnowledgeDecision; by: KnowledgeDecision | null }[] } {
  const ordered = [...decisions].sort((left, right) => left.at.localeCompare(right.at))
  const byId = new Map(ordered.map((decision) => [decision.id, decision]))
  const replaced = (decision: KnowledgeDecision) => decision.supersededBy !== undefined && decision.supersededBy !== null
  return {
    live: ordered.filter((decision) => !replaced(decision)),
    superseded: ordered.filter(replaced).map((decision) => ({ decision, by: byId.get(decision.supersededBy ?? '') ?? null })),
  }
}

/** A topic's chats as cards, newest first; a dispatch worker's chat sits under its top-most parent on the topic, oldest first. */
export function chatCards(chats: readonly KnowledgeChat[]): { chat: KnowledgeChat; workers: KnowledgeChat[] }[] {
  const byId = new Map(chats.map((chat) => [chat.id, chat]))
  const topOf = (chat: KnowledgeChat): KnowledgeChat => {
    let current = chat
    const seen = new Set<string>()
    while (current.parent !== undefined && !seen.has(current.id)) {
      seen.add(current.id)
      const parent = byId.get(current.parent)
      if (parent === undefined) break
      current = parent
    }
    return current
  }
  const cards = new Map<string, { chat: KnowledgeChat; workers: KnowledgeChat[] }>()
  for (const chat of chats) {
    const top = topOf(chat)
    const card = cards.get(top.id) ?? { chat: top, workers: [] }
    if (top.id !== chat.id) card.workers.push(chat)
    cards.set(top.id, card)
  }
  return [...cards.values()]
    .map((card) => ({ ...card, workers: card.workers.sort((left, right) => left.startedAt.localeCompare(right.startedAt)) }))
    .sort((left, right) => right.chat.startedAt.localeCompare(left.chat.startedAt))
}

export interface MapNode {
  id: string
  title: string
  kind: KnowledgeKind
  status: KnowledgeStatus
  activity: number
}

/** Two topics that share chats, files or other refs, with how many of each. */
export interface MapEdge {
  source: string
  target: string
  chats: number
  files: number
  refs: number
}

const shared = (left: ReadonlySet<string>, right: ReadonlySet<string>) => [...left].filter((value) => right.has(value)).length

/** The project's topics as a graph: an edge wherever two topics share a chat, a file or another ref. */
export function topicGraph(topics: readonly KnowledgeTopicSummary[]): { nodes: MapNode[]; edges: MapEdge[] } {
  const sets = topics.map((topic) => ({
    id: topic.id,
    chats: new Set(topic.chats),
    files: new Set(topic.refs.filter((ref) => ref.kind === 'file').map((ref) => ref.id)),
    refs: new Set(topic.refs.filter((ref) => ref.kind !== 'file').map((ref) => `${ref.kind}\n${ref.id}`)),
  }))
  const edges: MapEdge[] = []
  sets.forEach((left, index) => {
    for (const right of sets.slice(index + 1)) {
      const edge = { source: left.id, target: right.id, chats: shared(left.chats, right.chats), files: shared(left.files, right.files), refs: shared(left.refs, right.refs) }
      if (edge.chats + edge.files + edge.refs > 0) edges.push(edge)
    }
  })
  return { nodes: topics.map(({ id, title, kind, status, activity }) => ({ id, title, kind, status, activity })), edges }
}

/** A node's radius on the map: grows with the square root of its activity, from 9 to 30 px. */
export const nodeRadius = (activity: number): number => Math.min(30, 9 + 4 * Math.sqrt(Math.max(0, activity)))

/** A ref as people write it: #87, PR #412, a short sha, a branch, a file's name. */
export function refLabel(ref: Pick<KnowledgeRef, 'kind' | 'id'>): string {
  const number = refNumber(ref)
  switch (ref.kind) {
    case 'issue':
      return number === null ? ref.id : `#${number}`
    case 'pr':
      return number === null ? ref.id : `PR #${number}`
    case 'commit':
      return ref.id.slice(0, 7)
    case 'branch':
      return ref.id
    case 'file':
      return ref.id.split('/').at(-1) ?? ref.id
  }
}

/** An issue's or pull request's number, from 87, #87 or owner/repo#87; null for any other ref. */
export function refNumber(ref: Pick<KnowledgeRef, 'kind' | 'id'>): number | null {
  if (ref.kind !== 'issue' && ref.kind !== 'pr') return null
  const match = /(?:^|#)(\d+)$/.exec(ref.id)
  return match === null ? null : Number(match[1])
}

/** What the page shows: a project, one of its topics, a chat's transcript on it, or the project's map. */
export interface KnowledgeView {
  repo: string | null
  topic: string | null
  chat: string | null
  map: boolean
}

export const homeView: KnowledgeView = { repo: null, topic: null, chat: null, map: false }

/** The page's id with nothing picked. */
const home = 'home'

/** The Knowledge page, one item in the layout, keyed by what it shows so a restored layout reopens it there. */
export function knowledgeItem(view: KnowledgeView): string {
  const params = new URLSearchParams()
  if (view.repo !== null) params.set('repo', view.repo)
  if (view.topic !== null) params.set('topic', view.topic)
  if (view.chat !== null) params.set('chat', view.chat)
  if (view.map) params.set('map', '1')
  const id = params.toString()
  return itemKey('knowledge', id === '' ? home : id)
}

/** What a Knowledge page item's id shows; an id it cannot read is the home page. */
export function knowledgeView(id: string): KnowledgeView {
  if (id === home || !id.includes('=')) return homeView
  const params = new URLSearchParams(id)
  return { repo: params.get('repo'), topic: params.get('topic'), chat: params.get('chat'), map: params.get('map') === '1' }
}

/** The Knowledge page among a layout's items, if one shows it; a Summaries page a past run left counts. */
export const knowledgeItemIn = (items: readonly string[]): string | null => items.find((item) => parseItem(item)?.kind === 'knowledge') ?? null
