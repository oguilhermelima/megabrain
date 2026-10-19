import type { Artifact, ArtifactKind, KnowledgeKind, KnowledgeStatus, KnowledgeTopicSummary } from '@/api/schema'
import { artifactKinds, type ArtifactProject } from '@/advanced/artifacts-model'
import { kindGroups, statusLabels } from '@/advanced/knowledge-model'
import { updatedWithin, updatedWithinOptions, type SheetField } from '@/components/filter-sheet-model'

// The Knowledge and Artifacts pages' filter sheets (components/Filters), over what their lists
// already hold. Topics narrow by kind, status, when they last changed and the work they link to (an
// issue or pull request, commits); artifacts by kind, format, topic, the chat that filed them and when
// they last changed. Each `set` applies a patch to the latest filters, as the sheet's Clear needs.

const any = ''

export type TopicLink = '' | 'github' | 'commit' | 'none'

export interface TopicFilters {
  kind: KnowledgeKind | null
  status: KnowledgeStatus | null
  /** Days, or "" for any time. */
  updated: string
  link: TopicLink
}

export const emptyTopicFilters: TopicFilters = { kind: null, status: null, updated: any, link: any }

const linkOptions: { value: TopicLink; label: string }[] = [
  { value: any, label: 'Linked or not' },
  { value: 'github', label: 'Links an issue or pull request' },
  { value: 'commit', label: 'Links commits' },
  { value: 'none', label: 'Links nothing' },
]

function linksMatch(topic: Pick<KnowledgeTopicSummary, 'refs'>, link: TopicLink): boolean {
  if (link === any) return true
  if (link === 'none') return topic.refs.length === 0
  if (link === 'commit') return topic.refs.some((ref) => ref.kind === 'commit')
  return topic.refs.some((ref) => ref.kind === 'issue' || ref.kind === 'pr')
}

export function filterTopics<T extends KnowledgeTopicSummary>(topics: readonly T[], filters: TopicFilters, now: number): T[] {
  return topics.filter(
    (topic) => (filters.kind === null || topic.kind === filters.kind) && (filters.status === null || topic.status === filters.status) && updatedWithin(topic.updatedAt, filters.updated, now) && linksMatch(topic, filters.link),
  )
}

export function topicSheetFields(filters: TopicFilters, set: (patch: Partial<TopicFilters>) => void): SheetField[] {
  const statuses = Object.keys(statusLabels) as KnowledgeStatus[]
  return [
    { kind: 'select', label: 'Kind', value: filters.kind ?? any, options: [{ value: any, label: 'Any kind' }, ...kindGroups.map((group) => ({ value: group.kind, label: group.one }))], onChange: (value) => set({ kind: kindGroups.find((group) => group.kind === value)?.kind ?? null }) },
    { kind: 'select', label: 'Status', value: filters.status ?? any, options: [{ value: any, label: 'Any status' }, ...statuses.map((status) => ({ value: status, label: statusLabels[status] }))], onChange: (value) => set({ status: statuses.find((status) => status === value) ?? null }) },
    { kind: 'select', label: 'Updated', value: filters.updated, options: updatedWithinOptions, onChange: (updated) => set({ updated }) },
    { kind: 'select', label: 'Linked work', value: filters.link, options: linkOptions, onChange: (value) => set({ link: linkOptions.find((option) => option.value === value)?.value ?? any }) },
  ]
}

/** The chat filter's value for artifacts no chat filed. */
export const noChat = '\u0000none'

export interface ArtifactFilters {
  kind: ArtifactKind | null
  format: Artifact['format'] | null
  topic: string | null
  /** A chat id, or noChat. */
  chat: string | null
  updated: string
}

export const emptyArtifactFilters: ArtifactFilters = { kind: null, format: null, topic: null, chat: null, updated: any }

function artifactMatches(artifact: Artifact, filters: ArtifactFilters, now: number): boolean {
  if (filters.kind !== null && artifact.kind !== filters.kind) return false
  if (filters.format !== null && artifact.format !== filters.format) return false
  if (filters.topic !== null && !artifact.topics.includes(filters.topic)) return false
  if (filters.chat !== null && (filters.chat === noChat ? artifact.chatId !== null : artifact.chatId !== filters.chat)) return false
  return updatedWithin(artifact.updatedAt, filters.updated, now)
}

/** The project's artifacts the filters let through; kinds left empty drop out. */
export function filterArtifacts(project: ArtifactProject, filters: ArtifactFilters, now: number): ArtifactProject {
  const kinds = project.kinds.map((group) => ({ ...group, artifacts: group.artifacts.filter((artifact) => artifactMatches(artifact, filters, now)) })).filter((group) => group.artifacts.length > 0)
  return { ...project, kinds }
}

/** The topics and chats the project's artifacts name, for the sheet to offer. */
export function artifactFilterOptions(project: ArtifactProject): { topics: string[]; chats: string[] } {
  const artifacts = project.kinds.flatMap((group) => group.artifacts)
  return { topics: [...new Set(artifacts.flatMap((artifact) => artifact.topics))], chats: [...new Set(artifacts.flatMap((artifact) => (artifact.chatId === null ? [] : [artifact.chatId])))] }
}

export function artifactSheetFields(filters: ArtifactFilters, options: { topics: string[]; chats: string[] }, names: { topic: (id: string) => string; chat: (id: string) => string }, set: (patch: Partial<ArtifactFilters>) => void): SheetField[] {
  const byName = (ids: string[], name: (id: string) => string) => ids.map((id) => ({ value: id, label: name(id) })).sort((left, right) => left.label.localeCompare(right.label))
  const formats: Artifact['format'][] = ['html', 'markdown']
  return [
    { kind: 'select', label: 'Kind', value: filters.kind ?? any, options: [{ value: any, label: 'Any kind' }, ...artifactKinds.map((entry) => ({ value: entry.kind, label: entry.label }))], onChange: (value) => set({ kind: artifactKinds.find((entry) => entry.kind === value)?.kind ?? null }) },
    { kind: 'select', label: 'Format', value: filters.format ?? any, options: [{ value: any, label: 'Any format' }, { value: 'html', label: 'HTML' }, { value: 'markdown', label: 'Markdown' }], onChange: (value) => set({ format: formats.find((format) => format === value) ?? null }) },
    { kind: 'select', label: 'Topic', value: filters.topic ?? any, options: [{ value: any, label: 'Any topic' }, ...byName(options.topics, names.topic)], onChange: (value) => set({ topic: value === any ? null : value }) },
    { kind: 'select', label: 'Chat', value: filters.chat ?? any, options: [{ value: any, label: 'Any chat' }, { value: noChat, label: 'Filed outside a chat' }, ...byName(options.chats, names.chat)], onChange: (value) => set({ chat: value === any ? null : value }) },
    { kind: 'select', label: 'Updated', value: filters.updated, options: updatedWithinOptions, onChange: (updated) => set({ updated }) },
  ]
}
